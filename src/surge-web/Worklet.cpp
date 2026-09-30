// SPDX-License-Identifier: GPL-3.0-or-later
#include "Engine.h"
#include <emscripten.h>
#include <emscripten/webaudio.h>
#include <atomic>
#include <algorithm>
#include <array>
namespace
{
alignas(16) std::array<unsigned char, 1024 * 1024> audioStack;
SurgeWebEngine *engine{};
EMSCRIPTEN_WEBAUDIO_T node{};
// 0 idle, 1 starting, 2 ready, 3 stopping, 4 stopped, -1 failed. The engine is
// attached to audio from 1 through 3; only the audio thread detaches after ready.
std::atomic<int> state{0};
void fail()
{
    // Start callbacks run on the owning thread before any render.
    surge_detach_audio(engine);
    engine = nullptr;
    state.store(-1);
}
bool process(int ni, const AudioSampleFrame *in, int no, AudioSampleFrame *out, int,
             const AudioParamFrame *, void *)
{
    if (state.load(std::memory_order_acquire) == 3)
    {
        // Release ownership after the final render. The owning thread observes
        // "stopped" only after every engine access from this callback.
        for (int i = 0; i < no; ++i)
            std::fill_n(out[i].data, out[i].numberOfChannels * out[i].samplesPerChannel, 0.f);
        auto *released = engine;
        engine = nullptr;
        surge_detach_audio(released);
        state.store(4, std::memory_order_release);
        return false;
    }
    if (!engine || no != 1 || out[0].numberOfChannels != 2)
        return true;
    const int n = out[0].samplesPerChannel;
    const float *l = ni > 0 && in[0].numberOfChannels > 0 ? in[0].data : nullptr;
    const float *r = ni > 0 && in[0].numberOfChannels > 1 ? in[0].data + n : l;
    surge_render(engine, l, r, out[0].data, out[0].data + n, n);
    return true;
}
void ready(EMSCRIPTEN_WEBAUDIO_T context, bool success, void *)
{
    if (!success)
    {
        fail();
        return;
    }
    int channels[] = {2};
    EmscriptenAudioWorkletNodeCreateOptions options{};
    options.numberOfInputs = 1;
    options.numberOfOutputs = 1;
    options.outputChannelCounts = channels;
    node = emscripten_create_wasm_audio_worklet_node(context, "surge", &options, process, nullptr);
    emscripten_audio_node_connect(node, context, 0, 0);
    state.store(2);
}
void started(EMSCRIPTEN_WEBAUDIO_T context, bool success, void *)
{
    if (!success)
    {
        fail();
        return;
    }
    WebAudioWorkletProcessorCreateOptions options{};
    options.name = "surge";
    emscripten_create_wasm_audio_worklet_processor_async(context, &options, ready, nullptr);
}
} // namespace
extern "C" EMSCRIPTEN_KEEPALIVE int surge_start_audio(int context, SurgeWebEngine *instance)
{
    int expected = 0;
    if (!instance || !surge_attach_audio(instance))
        return 0;
    if (!state.compare_exchange_strong(expected, 1))
    {
        surge_detach_audio(instance);
        return 0;
    }
    engine = instance;
    emscripten_start_wasm_audio_worklet_thread_async(context, audioStack.data(), audioStack.size(),
                                                     started, nullptr);
    return 1;
}
extern "C" EMSCRIPTEN_KEEPALIVE int surge_audio_state() { return state.load(); }
// Requests that the audio thread release the engine after its next render. The
// context must be running; poll surge_audio_state() for 4 before using the engine.
extern "C" EMSCRIPTEN_KEEPALIVE int surge_stop_audio()
{
    int expected = 2;
    return state.compare_exchange_strong(expected, 3);
}
// Development tests need a context handle to pass to surge_start_audio.
extern "C" EMSCRIPTEN_KEEPALIVE EMSCRIPTEN_WEBAUDIO_T surge_create_audio_context(double rate)
{
    EmscriptenWebAudioCreateAttributes attributes{};
    attributes.latencyHint = "interactive";
    attributes.sampleRate = static_cast<uint32_t>(rate);
    return emscripten_create_audio_context(&attributes);
}
