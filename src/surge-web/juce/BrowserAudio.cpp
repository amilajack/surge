// SPDX-License-Identifier: GPL-3.0-or-later
#include "SurgeSynthProcessor.h"
#include "../MidiQueue.h"
#include "../Transport.h"
#include "../WamEventQueue.h"
#include "dsp/modulators/FormulaModulationHelper.h"
#include <emscripten.h>
#include <emscripten/webaudio.h>
#include <array>
#include <atomic>
#include <sstream>
void surge_publish_wavetables();
void surge_set_convolution_realtime(bool);
extern "C" int surge_enable_audio();
extern "C" void surge_browser_audio_changed(int);
extern "C" void surge_browser_audio_failed(int);
extern "C" void surge_retire_audio_thread(void *);
extern "C" thread_local int surge_audio_callback_depth;
extern "C" int surge_browser_audio_pool_reserve(size_t);
// BrowserWam.cpp: the Web Audio Module parameter list (fixed before audio starts).
std::vector<juce::AudioProcessorParameter *> &surge_wam_parameter_list();
bool surge_wam_apply_parameter_now(int index, float value);
bool surge_wam_parameter_control_thread(int index);
bool surge_wam_apply_control_parameter(int index, float value);
namespace
{
SurgeSynthProcessor *processor{};
EMSCRIPTEN_WEBAUDIO_T context{}, node{};
alignas(16) std::array<unsigned char, 1024 * 1024> audioStack;
juce::MidiBuffer midi;
Surge::Web::MidiQueue performanceEvents;
Surge::Web::Transport transport;
std::atomic<unsigned> requestedTempo{0};
double audioSampleRate = 48000.;
bool offlineActive = false;
uint64_t offlineFrame = 0;
// Web Audio Module mode: the host owns the AudioContext and the node's output.
// wamMode is set on the main thread before the worklet starts.
bool wamMode = false;
std::atomic<bool> wamDestroyed{false};
Surge::Web::WamEventQueue wamEvents;
double hostTempo = 0;                 // audio thread
std::atomic<double> blockPosition{0}; // transport position at the last block start
// UTF-16 identifiers written by wam/index.js; the worklet has no TextDecoder.
std::array<char16_t, 256> wamGroupId{}, wamInstanceId{};
int wamGroupLength = 0, wamInstanceLength = 0;
std::array<char16_t, 512> wamParameterScratch{}; // audio thread only
class BrowserPlayhead : public juce::AudioPlayHead
{
  public:
    Surge::Web::Transport::State state{};
    juce::Optional<PositionInfo> getPosition() const override
    {
        PositionInfo result;
        result.setBpm(processor->standaloneTempo.load());
        result.setTimeSignature(TimeSignature{state.numerator, state.denominator});
        result.setIsPlaying(state.playing);
        result.setPpqPosition(state.ppq);
        const double barLength = state.numerator * 4. / state.denominator;
        result.setPpqPositionOfLastBarStart(std::floor(state.ppq / barLength) * barLength);
        return result;
    }
} playhead;
std::atomic<int> status{0};
std::atomic<unsigned> blocks{0}, callbacks{0};
// UI-readable progress markers; no logging or allocation on the callback.
// 0 idle/completed, 1 format check, 2 MIDI, 3 transport, 4 wavetable handoff, 5 DSP.
std::atomic<int> renderStage{0}, renderFrames{0}, renderOutputs{0};
double startupDeadline = 0;
bool initializationPending = false, closing = false, processorFailed = false;
bool audioThreadInitialized = false, preparationPending = false;
void report(int value, const char *message)
{
    status.store(value);
    if (value < 0)
        EM_ASM({ globalThis.SurgeAudioInput?.input?.audioFailed(UTF8ToString($0)); }, message);
    // clang-format off
    EM_ASM({
        const message = UTF8ToString($1);
        const element = SurgeHost.status('status', message, $0);
        if (element) element.textContent = message;
    }, value, message);
    // clang-format on
}
void applyWamEvents(uint64_t firstFrame, int frames)
{
    auto &parameters = surge_wam_parameter_list();
    wamEvents.drain(
        firstFrame, frames, [&](const Surge::Web::WamEventQueue::Event &event, int offset) {
            switch (event.kind)
            {
            case Surge::Web::WamEventQueue::Midi:
                midi.addEvent(event.bytes.data(), event.length, offset);
                break;
            case Surge::Web::WamEventQueue::Automation:
                // Applied at the block start, as CLAP parameter events are applied
                // before the processor renders (SurgeSynthProcessor.cpp).
                if (event.parameter < int(parameters.size()))
                    parameters[event.parameter]->setValue(event.value);
                break;
            case Surge::Web::WamEventQueue::Transport:
            {
                transport.configure(event.playing, event.numerator, event.denominator);
                // WAM transport data has no position in beats: derive it from the
                // bar and the AudioContext time at which that bar started.
                const double beatsPerBar = event.numerator * 4. / event.denominator;
                const double now = double(firstFrame) / audioSampleRate;
                transport.locate(event.bar * beatsPerBar +
                                 std::max(0., now - event.barStarted) * event.tempo / 60.);
                hostTempo = event.tempo;
                break;
            }
            default:
                break;
            }
        });
}
void process(juce::AudioBuffer<float> &buffer, uint64_t firstFrame)
{
    // The loader owns the engine between the audio fade and its release-store.
    // Preserve queued performance events until that state handoff is complete.
    if (processor->surge->halt_engine.load(std::memory_order_acquire))
    {
        buffer.clear();
        transport.advance(buffer.getNumSamples(), audioSampleRate, processor->standaloneTempo.load());
        renderStage.store(0, std::memory_order_relaxed);
        return;
    }
    renderStage.store(2, std::memory_order_relaxed);
    midi.clear();
    if (performanceEvents.drain(firstFrame, buffer.getNumSamples(), [](const auto &event, int offset) {
            midi.addEvent(event.bytes.data(), event.length, offset);
        }))
        for (int channel = 1; channel <= 16; ++channel)
        {
            midi.addEvent(juce::MidiMessage::controllerEvent(channel, 120, 0), 0);
            midi.addEvent(juce::MidiMessage::controllerEvent(channel, 123, 0), 0);
        }
    if (wamMode)
        applyWamEvents(firstFrame, buffer.getNumSamples());
    renderStage.store(3, std::memory_order_relaxed);
    playhead.state = transport.beginBlock();
    blockPosition.store(playhead.state.ppq, std::memory_order_relaxed);
    if (const auto tempo = requestedTempo.exchange(0, std::memory_order_acq_rel))
    {
        processor->standaloneTempo.store(tempo / 100.f);
        processor->surge->storage.unstreamedTempo = tempo / 100.f;
        processor->surge->refresh_vkb = true;
    }
    // Respect the original preference for recalling a patch's standalone tempo.
    if (processor->surge->storage.unstreamedTempo > 0)
        processor->standaloneTempo.store(processor->surge->storage.unstreamedTempo);
    // A Web Audio Module host's tempo wins over the patch's, even after a load.
    if (wamMode && hostTempo > 0)
        processor->standaloneTempo.store(float(hostTempo));
    renderStage.store(4, std::memory_order_relaxed);
    surge_publish_wavetables();
    renderStage.store(5, std::memory_order_relaxed);
    surge_set_convolution_realtime(!offlineActive);
    processor->processBlock(buffer, midi);
    surge_set_convolution_realtime(false);
    transport.advance(buffer.getNumSamples(), audioSampleRate, processor->surge->time_data.tempo);
    renderStage.store(0, std::memory_order_relaxed);
    // Publishing from Surge's 32-sample process() would let the loader race
    // the remainder of this 128-sample JUCE callback and its post-processing.
    // Transfer ownership only after all engine accesses above have finished.
    if (processor->surge->browserPatchLoadRequested.exchange(false, std::memory_order_acq_rel))
        processor->surge->browserPatchLoadPending.store(true, std::memory_order_release);
}
bool renderCallback(int ni, const AudioSampleFrame *in, int no, AudioSampleFrame *out);
bool render(int ni, const AudioSampleFrame *in, int no, AudioSampleFrame *out, int,
            const AudioParamFrame *, void *)
{
    ++surge_audio_callback_depth;
    const auto result = renderCallback(ni, in, no, out);
    --surge_audio_callback_depth;
    return result;
}
bool renderCallback(int ni, const AudioSampleFrame *in, int no, AudioSampleFrame *out)
{
    if (wamDestroyed.load(std::memory_order_acquire))
    {
        // A destroyed plugin outputs silence and lets the browser stop the processor.
        for (int i = 0; i < no; ++i)
            std::fill_n(out[i].data, out[i].samplesPerChannel * out[i].numberOfChannels, 0.f);
        return false;
    }
    callbacks.fetch_add(1, std::memory_order_relaxed);
    renderStage.store(1, std::memory_order_relaxed);
    renderOutputs.store(no > 0 ? out[0].numberOfChannels : 0, std::memory_order_relaxed);
    renderFrames.store(no > 0 ? out[0].samplesPerChannel : 0, std::memory_order_relaxed);
    if (no != 1 || out[0].numberOfChannels != 2)
        return true;
    const int n = out[0].samplesPerChannel;
    float *channels[] = {out[0].data, out[0].data + n};
    for (int ch = 0; ch < 2; ++ch)
    {
        if (ni > 0 && in[0].numberOfChannels > 0)
            std::copy_n(in[0].data + std::min(ch, in[0].numberOfChannels - 1) * n, n, channels[ch]);
        else
            std::fill_n(channels[ch], n, 0.f);
    }
    auto &synth = *processor->surge;
    if (!synth.tryAcquireBrowserEngine(1))
    {
        // Control work owns the engine while audio is suspending or failing.
        for (auto *channel : channels)
            std::fill_n(channel, n, 0.f);
        renderStage.store(0, std::memory_order_relaxed);
        return true;
    }
    juce::AudioBuffer<float> buffer(channels, 2, n);
    const auto firstFrame = static_cast<uint64_t>(EM_ASM_DOUBLE({ return currentFrame; }));
    process(buffer, firstFrame);
    // processBlock marks audio active on every callback. A pending release wins.
    if (synth.browserAudioReleasing.load(std::memory_order_acquire))
        synth.audio_processing_active = false;
    synth.releaseBrowserEngine();
    blocks.fetch_add(1, std::memory_order_relaxed);
    return true;
}
void wamRegistered(int ok)
{
    // clang-format off
    EM_ASM({ SurgeHost.wam.registered($0 !== 0); }, ok);
    // clang-format on
}
// Runs on the audio worklet thread. Emscripten keeps Module private to its own
// worklet module, so the WAM group gets a plain object whose scheduleEvents calls
// straight into Wasm. WamEnv and WamGroup only read groupId and instanceId and
// call scheduleEvents/clearEvents on it.
// clang-format off
void registerWam()
{
    const int ok = EM_ASM_INT({
        const env = globalThis.webAudioModules;
        if (!env) return 0;
        const text = (pointer, length) =>
            String.fromCharCode.apply(null, HEAPU16.subarray(pointer >> 1, (pointer >> 1) + length));
        // EM_ASM splits its code at top-level commas: keep them inside parentheses.
        const scratch = $4;
        const scratchLength = $5;
        const indices = new Map();
        const parameterIndex = id => {
            const key = String(id);
            let index = indices.get(key);
            if (index !== undefined) return index;
            if (key.length > scratchLength) return -1;
            for (let i = 0; i < key.length; ++i) HEAPU16[(scratch >> 1) + i] = key.charCodeAt(i);
            index = Module._surge_wam_parameter_index(scratch, key.length);
            indices.set(key, index);
            return index;
        };
        // WAM event times are AudioContext seconds; no time means as soon as possible.
        const frameOf = event =>
            typeof event.time === 'number' && Number.isFinite(event.time) ? event.time * sampleRate : 0;
        const wam = ({
            groupId: text($0, $1),
            instanceId: text($2, $3),
            moduleId: 'com.surge-synth-team.surge-xt',
            scheduleEvents(...events) {
                for (const event of events) {
                    const data = event && event.data;
                    if (!data) continue;
                    if (event.type === 'wam-midi' || event.type === 'wam-mpe') {
                        const bytes = data.bytes;
                        if (bytes) Module._surge_wam_midi(1, bytes[0] | 0, bytes[1] | 0, bytes[2] | 0, frameOf(event));
                    } else if (event.type === 'wam-automation') {
                        const index = parameterIndex(data.id);
                        if (index >= 0) Module._surge_wam_automation(1, index, Number(data.value), frameOf(event));
                    } else if (event.type === 'wam-transport') {
                        Module._surge_wam_transport(1, data.playing ? 1 : 0, data.timeSigNumerator | 0,
                            data.timeSigDenominator | 0, Number(data.currentBar),
                            Number(data.currentBarStarted), Number(data.tempo), frameOf(event));
                    }
                }
            },
            clearEvents() { Module._surge_wam_clear(1); },
            emitEvents() {},
            getCompensationDelay() { return 0; }
        });
        try { env.addWam(wam); } catch (error) { return 0; }
        Module.surgeWamProcessor = wam;
        return 1;
    }, wamGroupId.data(), wamGroupLength, wamInstanceId.data(), wamInstanceLength,
       wamParameterScratch.data(), int(wamParameterScratch.size()));
    emscripten_audio_worklet_post_function_vi(EMSCRIPTEN_AUDIO_MAIN_THREAD, wamRegistered, ok);
}
// clang-format on
void unregisterWam()
{
    // clang-format off
    EM_ASM({
        const wam = Module.surgeWamProcessor;
        Module.surgeWamProcessor = null;
        try { if (wam) globalThis.webAudioModules.removeWam(wam); } catch (error) {}
    });
    // clang-format on
}
void ready(EMSCRIPTEN_WEBAUDIO_T audioContext, bool success, void *)
{
    if (audioContext != context || closing || !initializationPending)
        return;
    if (!success)
    {
        initializationPending = false;
        processor->surge->audio_processing_active = false;
        report(-1, "Unable to create the audio processor. Check Chrome's console.");
        return;
    }
    initializationPending = false;
    int channelCounts[] = {2};
    EmscriptenAudioWorkletNodeCreateOptions options{};
    options.numberOfInputs = 1;
    options.numberOfOutputs = 1;
    options.outputChannelCounts = channelCounts;
    // Reserve processing before the first callback can start. The main event
    // loop must no longer take the synchronous, audio-inactive patch-load path.
    processor->surge->browserAudioReleasing = false;
    processor->surge->audio_processing_active = true;
    node = emscripten_create_wasm_audio_worklet_node(audioContext, "surge-xt", &options, render,
                                                     nullptr);
    if (!node) { processor->surge->audio_processing_active = false; report(-1, "Unable to create the audio node."); return; }
    // clang-format off
    EM_ASM({
        const handle = $0;
        SurgeAudioLifecycle.watchProcessor(emscriptenGetAudioObject(handle), emscriptenGetAudioObject($1),
            () => Module._surge_browser_audio_failed(handle));
    }, audioContext, node);
    // clang-format on
    if (wamMode)
    {
        // The host connects the node; register the plugin in its WAM group first.
        // clang-format off
        EM_ASM({ SurgeHost.wam.nodeReady(emscriptenGetAudioObject($0)); }, node);
        // clang-format on
        emscripten_audio_worklet_post_function_v(audioContext, registerWam);
    }
    else
    {
        emscripten_audio_node_connect(node, audioContext, 0, 0);
        // clang-format off
        EM_ASM({ globalThis.SurgeAudioInput?.input?.setGraph(emscriptenGetAudioObject($0), emscriptenGetAudioObject($1)); }, audioContext, node);
        // clang-format on
    }
    surge_browser_audio_changed(audioContext);
}
void started(EMSCRIPTEN_WEBAUDIO_T audioContext, bool success, void *)
{
    if (audioContext != context || closing || !initializationPending)
        return;
    if (!success)
    {
        initializationPending = false;
        processor->surge->audio_processing_active = false;
        report(-1, "Unable to start AudioWorklet. Verify cross-origin isolation.");
        return;
    }
    WebAudioWorkletProcessorCreateOptions options{};
    options.name = "surge-xt";
    emscripten_create_wasm_audio_worklet_processor_async(audioContext, &options, ready, nullptr);
}
void prepareAndStart()
{
    if (!preparationPending || !context || closing) return;
    // Context replacement may overlap a loader started by the old worklet.
    // Never change sample rate or warm up effects while that loader owns state.
    std::unique_lock<std::mutex> lock(processor->surge->patchLoadSpawnMutex, std::try_to_lock);
    if (!lock.owns_lock() || processor->surge->halt_engine.load(std::memory_order_acquire))
        return;
    const double rate = EM_ASM_DOUBLE({ return emscriptenGetAudioObject($0).sampleRate; }, context);
    audioSampleRate = rate;
    midi.ensureSize(65536);
    midi.clear();
    // Real-time pool for allocations made inside callbacks (for example voices
    // whose oscillators allocate). Reserved once, before any callback runs.
    surge_browser_audio_pool_reserve(size_t(64) << 20);
    processor->prepareToPlay(rate, 128);
    // No worklet is running yet and the loader mutex is held. This also covers
    // formula edits made while audio was disabled, without executing user code.
    Surge::Formula::preparePatchCompilation(&processor->surge->storage);
    // Prepare the initial patch and effects before the real-time callback starts.
    juce::AudioBuffer<float> warmup(2, 128);
    warmup.clear();
    processor->processBlock(warmup, midi);
    // JUCE's ListenerList grows its iterator storage on its first notification.
    // Notify once here, as incoming MIDI would, so no callback performs it.
    {
        juce::ScopedValueSetter<bool> fromMidi(processor->isAddingFromMidi, true);
        processor->midiKeyboardState.processNextMidiEvent(juce::MidiMessage::noteOn(1, 0, 1.f));
        processor->midiKeyboardState.processNextMidiEvent(juce::MidiMessage::noteOff(1, 0));
    }
    // Patches remain editable while the worklet module loads. The ready callback
    // reserves processing before creating/connecting the node on the main thread.
    processor->surge->audio_processing_active = false;
    if (processor->surge->browserPatchLoadRequested.exchange(false, std::memory_order_acq_rel))
        processor->surge->browserPatchLoadPending.store(true, std::memory_order_release);
    preparationPending = false;
    startupDeadline = emscripten_get_now() + 15000;
    report(1, "Starting audio…");
    if (!wamMode) // A Web Audio Module host decides when its context runs.
        emscripten_resume_audio_context_sync(context);
    initializationPending = true;
    audioThreadInitialized = true;
    emscripten_start_wasm_audio_worklet_thread_async(context, audioStack.data(), audioStack.size(),
                                                     started, nullptr);
}
} // namespace
void surge_attach_audio(SurgeSynthProcessor *p)
{
    processor = p;
    playhead.state = transport.beginBlock();
    processor->setPlayHead(&playhead);
}
extern "C" EMSCRIPTEN_KEEPALIVE int surge_enable_audio()
{
    if (!processor || wamMode)
        return 0;
    if (closing) return 0;
    if (context && status.load() < 0)
    {
        if (initializationPending)
        {
            // A timeout is not cancellation. Keep waiting on the same import;
            // never create a second worklet using the same stack.
            startupDeadline = emscripten_get_now() + 15000;
            report(1, "Still starting audio…");
            emscripten_resume_audio_context_sync(context);
            return 1;
        }
        closing = true;
        report(3, "Closing the previous audio context before retrying…");
        // clang-format off
        EM_ASM({
            const handle = $0;
            SurgeAudioLifecycle.close(emscriptenGetAudioObject(handle), $1 ? emscriptenGetAudioObject($1) : null)
                .then(() => Module._surge_browser_audio_closed(handle, 1),
                      () => Module._surge_browser_audio_closed(handle, 0));
        }, context, node);
        // clang-format on
        return 1;
    }
    if (context)
    {
        if (node)
        {
            processor->surge->browserAudioReleasing = false;
            processor->surge->audio_processing_active = true;
        }
        emscripten_resume_audio_context_sync(context);
        return 1;
    }
    offlineActive = false;
    processorFailed = false;
    performanceEvents.panic();
    EmscriptenWebAudioCreateAttributes attributes{};
    attributes.latencyHint = "interactive";
    context = emscripten_create_audio_context(&attributes);
    if (!context)
    {
        report(-1, "Unable to create an audio context.");
        return 0;
    }
    // clang-format off
    EM_ASM({
        const handle = $0;
        SurgeAudioLifecycle.guard(emscriptenGetAudioObject(handle));
        emscriptenGetAudioObject(handle).onstatechange = () => Module._surge_browser_audio_changed(handle);
    }, context);
    // clang-format on
    preparationPending = true;
    report(1, "Waiting for patch preparation before starting audio…");
    // Preserve the user activation even when engine preparation must wait.
    emscripten_resume_audio_context_sync(context);
    prepareAndStart();
    return 1;
}
extern "C" EMSCRIPTEN_KEEPALIVE void surge_browser_audio_failed(int handle)
{
    if (!context || handle != context || closing) return;
    processorFailed = true;
    auto &synth = *processor->surge;
    synth.browserAudioReleasing = true;
    synth.audio_processing_active = false;
    performanceEvents.panic();
    report(-1, wamMode
                   ? "The audio processor stopped unexpectedly. Reload the plugin to restart."
                   : "The audio processor stopped unexpectedly. Click Enable audio to restart.");
}
extern "C" EMSCRIPTEN_KEEPALIVE void surge_browser_audio_changed(int handle)
{
    if (!context || handle != context || closing) return;
    const auto state = emscripten_audio_context_state(context);
    if (state == AUDIO_CONTEXT_STATE_CLOSED)
    {
        initializationPending = false;
        preparationPending = false;
        processor->surge->browserAudioReleasing = true;
        processor->surge->audio_processing_active = false;
        performanceEvents.panic();
        report(-1, wamMode ? "The host closed the audio context."
                           : "The audio context closed. Click Enable audio to restart.");
    }
    else if (node && !processorFailed)
    {
        if (state == AUDIO_CONTEXT_STATE_RUNNING)
        {
            processor->surge->browserAudioReleasing = false;
            report(2, "Audio enabled");
        }
        else
        {
            processor->surge->browserAudioReleasing = true;
            processor->surge->audio_processing_active = false;
            performanceEvents.panic();
            report(4, wamMode ? "The host suspended the audio context."
                              : "Audio suspended or interrupted. Click Enable audio to resume.");
        }
    }
}
extern "C" EMSCRIPTEN_KEEPALIVE void surge_browser_audio_closed(int handle, int success)
{
    if (!closing || handle != context) return;
    closing = false;
    if (!success)
    {
        report(-1, "Unable to close the audio context. Click Enable audio to retry cleanup.");
        return;
    }
    if (audioThreadInitialized)
    {
        surge_retire_audio_thread(audioStack.data());
        audioThreadInitialized = false;
    }
    // The pinned SDK's destroy_audio_context only suspends. After close() has
    // resolved, remove its registry handles without calling suspend on a closed
    // context. emAudio is the registry used by Emscripten 6.0.10's WebAudio API.
    EM_ASM({ delete emAudio[$0]; if ($1) delete emAudio[$1]; }, context, node);
    context = node = 0;
    initializationPending = false;
    // close() has resolved, so no callback can still run. A processor that trapped
    // inside a callback never released the gate; return it to the control thread.
    int audioOwned = 1;
    processor->surge->browserEngineGate.compare_exchange_strong(audioOwned, 0, std::memory_order_acq_rel);
    processor->surge->audio_processing_active = false;
    report(0, "Restarting audio…");
    surge_enable_audio();
}
// ---- Web Audio Module entry points (wam/index.js) ----
// Identifier buffers: 0 group id, 1 instance id. Written as UTF-16 before attach.
extern "C" EMSCRIPTEN_KEEPALIVE char16_t *surge_wam_id_buffer(int which, int length)
{
    if (wamMode || length < 0 || length > int(wamGroupId.size()))
        return nullptr;
    (which ? wamInstanceLength : wamGroupLength) = length;
    return which ? wamInstanceId.data() : wamGroupId.data();
}
// Attach to the host's AudioContext (Module.surgeWam.context). The host owns the
// context: Surge never resumes, closes or connects it to the destination.
extern "C" EMSCRIPTEN_KEEPALIVE int surge_wam_attach()
{
    if (!processor || context || offlineActive || closing || wamMode || !wamGroupLength ||
        !wamInstanceLength)
        return 0;
    wamMode = true;
    surge_wam_parameter_list(); // fixed before any callback reads it
    // clang-format off
    context = EM_ASM_INT({ return emscriptenRegisterAudioObject(SurgeHost.wam.context); });
    EM_ASM({
        const handle = $0;
        emscriptenGetAudioObject(handle).addEventListener('statechange', () => Module._surge_browser_audio_changed(handle));
    }, context);
    // clang-format on
    processorFailed = false;
    performanceEvents.panic();
    preparationPending = true;
    report(1, "Waiting for patch preparation before starting audio…");
    prepareAndStart();
    return 1;
}
static void applyControlParameter(double index, double value)
{
    if (!wamMode || wamDestroyed.load(std::memory_order_acquire))
        return;
    if (status.load() == 2)
        surge_wam_apply_control_parameter(int(index), float(value));
    else
        surge_wam_apply_parameter_now(int(index), float(value));
}
// Event producers: rt 0 is the browser main thread, rt 1 the audio worklet thread.
// Frames are absolute AudioContext frames; 0 means as soon as possible.
static bool wamProducerReady(int rt)
{
    if (!wamMode || wamDestroyed.load(std::memory_order_acquire))
        return false;
    // A suspended context renders nothing; queued notes would play late on resume.
    return rt || status.load() == 2;
}
extern "C" EMSCRIPTEN_KEEPALIVE int surge_wam_midi(int rt, int statusByte, int first, int second,
                                                   double frame)
{
    Surge::Web::WamEventQueue::Event event;
    if (!wamProducerReady(rt) ||
        !Surge::Web::WamEventQueue::makeMidi(event, statusByte, first, second, frame))
        return 0;
    return wamEvents.push(rt ? wamEvents.realtime : wamEvents.control, event);
}
extern "C" EMSCRIPTEN_KEEPALIVE int surge_wam_automation(int rt, int index, double value,
                                                         double frame)
{
    if (!wamMode || wamDestroyed.load(std::memory_order_acquire) || index < 0 ||
        index >= int(surge_wam_parameter_list().size()) || !std::isfinite(value))
        return 0;
    const float normalized = float(std::clamp(value, 0., 1.));
    // Effect types change from the control thread only (see BrowserWam.cpp). From
    // the worklet, hand the change to the main thread rather than constructing
    // an effect on the audio thread.
    if (surge_wam_parameter_control_thread(index))
    {
        if (rt)
        {
            emscripten_audio_worklet_post_function_vdd(EMSCRIPTEN_AUDIO_MAIN_THREAD,
                                                       applyControlParameter, index, normalized);
            return 1;
        }
        return status.load() == 2 ? surge_wam_apply_control_parameter(index, normalized)
                                  : surge_wam_apply_parameter_now(index, normalized);
    }
    // Without rendering, nothing would drain the queue: apply on this thread.
    if (!rt && status.load() != 2)
        return surge_wam_apply_parameter_now(index, normalized);
    Surge::Web::WamEventQueue::Event event;
    Surge::Web::WamEventQueue::makeAutomation(event, index, value, frame);
    return wamEvents.push(rt ? wamEvents.realtime : wamEvents.control, event);
}
extern "C" EMSCRIPTEN_KEEPALIVE int surge_wam_transport(int rt, int playing, int numerator,
                                                        int denominator, double bar,
                                                        double barStarted, double tempo,
                                                        double frame)
{
    Surge::Web::WamEventQueue::Event event;
    if (!wamMode || wamDestroyed.load(std::memory_order_acquire) ||
        !Surge::Web::WamEventQueue::makeTransport(event, playing != 0, numerator, denominator, bar,
                                                  barStarted, tempo, frame))
        return 0;
    return wamEvents.push(rt ? wamEvents.realtime : wamEvents.control, event);
}
extern "C" EMSCRIPTEN_KEEPALIVE void surge_wam_clear(int rt)
{
    if (wamMode)
        wamEvents.push(rt ? wamEvents.realtime : wamEvents.control,
                       Surge::Web::WamEventQueue::makeClear());
}
extern "C" EMSCRIPTEN_KEEPALIVE unsigned surge_wam_dropped_events()
{
    return wamEvents.droppedCount();
}
// Stop rendering and leave the WAM group. A destroyed plugin is not restarted:
// the worklet thread and its stack belong to the host's context until it closes.
extern "C" EMSCRIPTEN_KEEPALIVE void surge_wam_destroy()
{
    if (!wamMode || wamDestroyed.exchange(true, std::memory_order_acq_rel))
        return;
    performanceEvents.panic();
    processor->surge->browserAudioReleasing = true;
    processor->surge->audio_processing_active = false;
    if (context && node)
        emscripten_audio_worklet_post_function_v(context, unregisterWam);
    report(0, "Destroyed");
}
extern "C" EMSCRIPTEN_KEEPALIVE int surge_browser_audio_status() { return status.load(); }
extern "C" EMSCRIPTEN_KEEPALIVE unsigned surge_browser_audio_blocks() { return blocks.load(); }
extern "C" EMSCRIPTEN_KEEPALIVE const char *surge_browser_audio_diagnostics()
{
    static std::string value;
    std::ostringstream json;
    json << "{\"callbacks\":" << callbacks.load() << ",\"blocks\":" << blocks.load()
         << ",\"stage\":" << renderStage.load() << ",\"frames\":" << renderFrames.load()
         << ",\"outputChannels\":" << renderOutputs.load() << "}";
    value = json.str();
    return value.c_str();
}

void surge_poll_audio_startup()
{
    if (preparationPending)
    {
        prepareAndStart();
        return;
    }
    if (status.load() == 1 && emscripten_get_now() > startupDeadline)
        report(-1, "AudioWorklet is still pending. Check the audio device and click Enable audio "
                   "to continue waiting.");
}

extern "C" EMSCRIPTEN_KEEPALIVE int surge_browser_midi(int statusByte, int first, int second, double frame)
{
    return (status.load() == 2 || offlineActive) && performanceEvents.push(statusByte, first, second, frame);
}
extern "C" EMSCRIPTEN_KEEPALIVE void surge_browser_panic() { performanceEvents.panic(); }
extern "C" EMSCRIPTEN_KEEPALIVE unsigned surge_browser_midi_overflows()
{
    return performanceEvents.overflowCount();
}
extern "C" EMSCRIPTEN_KEEPALIVE double surge_browser_audio_time()
{
    return context ? EM_ASM_DOUBLE({ return emscriptenGetAudioObject($0).currentTime; }, context) : 0.;
}
extern "C" EMSCRIPTEN_KEEPALIVE double surge_browser_audio_rate()
{
    return context ? EM_ASM_DOUBLE({ return emscriptenGetAudioObject($0).sampleRate; }, context) : 0.;
}

extern "C" EMSCRIPTEN_KEEPALIVE int surge_browser_transport(int playing, int numerator, int denominator)
{
    return transport.configure(playing != 0, numerator, denominator);
}
extern "C" EMSCRIPTEN_KEEPALIVE void surge_browser_rewind() { transport.rewind(); }
extern "C" EMSCRIPTEN_KEEPALIVE int surge_browser_transport_tempo(double bpm)
{
    if (!std::isfinite(bpm) || bpm < 1 || bpm > 999) return 0;
    requestedTempo.store(static_cast<unsigned>(std::round(bpm * 100)), std::memory_order_release);
    return 1;
}
extern "C" EMSCRIPTEN_KEEPALIVE double surge_browser_transport_bpm()
{
    const auto pending = requestedTempo.load(std::memory_order_acquire);
    return pending ? pending / 100. : processor ? processor->standaloneTempo.load() : 120.;
}
// Diagnostic: the transport position (quarter notes) when the last block started.
extern "C" EMSCRIPTEN_KEEPALIVE double surge_browser_transport_position()
{
    return blockPosition.load(std::memory_order_relaxed);
}
extern "C" EMSCRIPTEN_KEEPALIVE int surge_browser_transport_playing()
{
    return transport.requested().playing;
}

// Exclusive offline rendering exercises the same processor/event/transport path.
// It is unavailable once a browser AudioContext has been created, so it cannot
// run concurrently with an AudioWorklet callback. Render lengths must be
// multiples of the engine's 32-sample block (maximum 192000 samples per call).
extern "C" EMSCRIPTEN_KEEPALIVE int surge_browser_offline_begin(double rate)
{
    if (!processor || context || !std::isfinite(rate) || rate < 8000 || rate > 192000) return 0;
    // A patch loader may still own the engine; offline rendering must not overlap it.
    std::unique_lock<std::mutex> lock(processor->surge->patchLoadSpawnMutex, std::try_to_lock);
    if (!lock.owns_lock() || processor->surge->patchLoadThread ||
        processor->surge->halt_engine.load(std::memory_order_acquire))
        return 0;
    audioSampleRate = rate;
    offlineFrame = 0;
    performanceEvents.panic();
    performanceEvents.drain(0, 128, [](const auto &, int) {});
    midi.ensureSize(65536);
    midi.clear();
    processor->prepareToPlay(rate, 128);
    processor->surge->stopSound();
    offlineActive = true;
    return 1;
}
static double renderOffline(int frames, const float *left, const float *right)
{
    if (!offlineActive || context || frames < 1 || frames > 192000 || frames % BLOCK_SIZE != 0) return -1.;
    double energy = 0.;
    juce::AudioBuffer<float> buffer(2, 128);
    for (int remaining = frames; remaining > 0;)
    {
        const int count = std::min(128, remaining);
        buffer.setSize(2, count, false, false, true);
        buffer.clear();
        const int offset = frames - remaining;
        if (left) std::copy_n(left + offset, count, buffer.getWritePointer(0));
        if (right || left) std::copy_n((right ? right : left) + offset, count, buffer.getWritePointer(1));
        // Offline blocks run the callback path, so they count toward the audit too.
        ++surge_audio_callback_depth;
        process(buffer, offlineFrame);
        --surge_audio_callback_depth;
        offlineFrame += count;
        for (int channel = 0; channel < 2; ++channel)
            for (int sample = 0; sample < count; ++sample)
            {
                const auto value = buffer.getSample(channel, sample);
                energy += double(value) * value;
            }
        remaining -= count;
    }
    return energy;
}
extern "C" EMSCRIPTEN_KEEPALIVE double surge_browser_offline_render(int frames)
{
    return renderOffline(frames, nullptr, nullptr);
}
extern "C" EMSCRIPTEN_KEEPALIVE double surge_browser_offline_render_input(int frames, const float *left, const float *right)
{
    return renderOffline(frames, left, right);
}
extern "C" EMSCRIPTEN_KEEPALIVE const char *surge_browser_offline_state()
{
    if (!offlineActive || context) return "{}";
    const auto &time = processor->surge->time_data;
    std::ostringstream state;
    state.precision(15);
    state << "{\"ppq\":" << transport.position() << ",\"enginePpq\":" << time.ppqPos
          << ",\"tempo\":" << time.tempo << ",\"playing\":" << (time.isPlaying ? "true" : "false")
          << ",\"numerator\":" << time.timeSigNumerator << ",\"denominator\":" << time.timeSigDenominator << "}";
    static std::string result;
    result = state.str();
    return result.c_str();
}
extern "C" EMSCRIPTEN_KEEPALIVE void surge_browser_offline_end()
{
    if (!offlineActive || context) return;
    processor->surge->stopSound();
    processor->surge->audio_processing_active = false;
    processor->releaseResources();
    offlineActive = false;
    performanceEvents.panic();
}
