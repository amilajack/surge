// SPDX-License-Identifier: GPL-3.0-or-later
// Surge XT's editor as the clap.webview/3 page of the Surge XT WCLAP.
//
// The editor runs unchanged on a stand-in SurgeSynthProcessor that never renders
// audio. The real engine is the plug-in (module.wasm, src/surge-wclap); the two
// talk only through webview messages (src/surge-wclap/Protocol.h):
// - parameter and macro edits leave as Param/Gesture frames, through the JUCE
//   parameter listeners a host would use; values from the plug-in are set
//   without notifying, so nothing echoes;
// - structural edits (MSEG, step sequences, formulas, wavetables, names, tuning...)
//   leave as the parts of the patch they changed (Delta, StateParts.h), which the
//   plug-in applies in place, so held notes keep playing; patch loads, and edits no
//   part describes, leave as complete states. Edits are detected from patch loads,
//   the undo history and the parameters' extended settings; modulation routings
//   leave as frames;
// - the plug-in answers Hello with its output state (the host's sample rate and
//   whether it processes) and a Snapshot, and streams telemetry (meters, voices,
//   keys, oscilloscope audio) that the stand-in shows as its own;
// - the host sizes the window: the editor zooms to fit it, and tells the plug-in
//   its size and its size at 100 % (for the host's resize hints).
#include "SurgeSynthProcessor.h"
#include "SurgeSynthEditor.h"
#include "SurgeGUIEditor.h"
#include "UndoManager.h"
#include "../../surge-wclap/Protocol.h"
#include "../../surge-wclap/StateParts.h"
#include "tinyxml/tinyxml.h"
#include <emscripten.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <unordered_map>
#include <vector>

namespace Protocol = Surge::Wclap::Protocol;
namespace StateParts = Surge::Wclap::StateParts;

namespace
{
uint32_t juceHash(const juce::String &id) { return uint32_t(id.hashCode()); }

class Bridge final : public juce::AudioProcessorParameter::Listener,
                     public juce::MidiKeyboardState::Listener,
                     public SurgeSynthesizer::ModulationAPIListener
{
  public:
    Bridge(SurgeSynthProcessor &p, SurgeSynthEditor &e) : processor(p), editor(e)
    {
        for (auto *parameter : processor.getParameters())
        {
            auto *withId = dynamic_cast<juce::AudioProcessorParameterWithID *>(parameter);
            if (!withId || parameter == processor.getBypassParameter())
                continue;
            const auto id = juceHash(withId->paramID);
            ids[parameter->getParameterIndex()] = id;
            byId[id] = parameter;
            parameter->addListener(this);
        }
        processor.midiKeyboardState.addListener(this);
        synth().addModulationAPIListener(this);
        Surge::GUI::UndoManager::editObserver = [](bool parameterOnly) {
            if (instance && !parameterOnly)
                instance->structuralEdit();
        };
    }

    static inline Bridge *instance{nullptr};

    void start()
    {
        Protocol::Writer hello(Protocol::Hello);
        hello.put(Protocol::version);
        send(hello.bytes);
    }

    void receive(const uint8_t *data, size_t size)
    {
        Protocol::Reader frame(data, size);
        if (!frame.valid())
            return;
        switch (frame.type())
        {
        case Protocol::Snapshot:
        {
            uint32_t version;
            if (!frame.get(version) || version != Protocol::version)
                return;
            applySnapshot(frame.rest(), frame.remaining());
            break;
        }
        case Protocol::Param:
        {
            uint32_t id;
            double value;
            if (!frame.get(id) || !frame.get(value))
                return;
            if (auto found = byId.find(id); found != byId.end())
            {
                // setValue does not notify listeners: the host's value, no echo.
                const juce::ScopedValueSetter<bool> remote(applyingRemote, true);
                found->second->setValue(float(std::clamp(value, 0., 1.)));
            }
            break;
        }
        case Protocol::Telemetry:
        {
            Protocol::TelemetryFrame telemetry;
            if (!frame.get(telemetry))
                return;
            applyTelemetry(telemetry);
            break;
        }
        case Protocol::OutputState:
        {
            Protocol::OutputStateFrame state;
            if (!frame.get(state))
                return;
            applyOutputState(state, std::string(reinterpret_cast<const char *>(frame.rest()),
                                                frame.remaining()));
            break;
        }
        case Protocol::Resize:
        {
            uint32_t width, height;
            if (!frame.get(width) || !frame.get(height))
                return;
            fitToWindow(int(width), int(height));
            break;
        }
        case Protocol::NeedState:
            // A Delta did not reproduce this patch in the plug-in: send all of it.
            sendState(currentState());
            break;
        case Protocol::ScopeAudio:
        {
            const auto frames = frame.remaining() / 8;
            if (!frames || !synth().storage.audioOut.subscribed())
                return;
            std::vector<float> left(frames), right(frames);
            for (size_t i = 0; i < frames; ++i)
            {
                std::memcpy(&left[i], frame.rest() + i * 8, 4);
                std::memcpy(&right[i], frame.rest() + i * 8 + 4, 4);
            }
            synth().storage.audioOut.push(left.data(), right.data(), frames);
            scopeFrames += frames;
            break;
        }
        default:
            break;
        }
    }

    // Called every control tick (16 ms) on the main thread.
    void pump(double now)
    {
        auto &s = synth();
        // A patch the editor loaded (browser, file, undo of a patch change).
        const auto generation = s.browserPatchGeneration.load(std::memory_order_acquire);
        if (generation != knownGeneration && !s.halt_engine.load(std::memory_order_acquire) &&
            s.patchid_queue.load() < 0 && !s.has_patchid_file)
        {
            knownGeneration = generation;
            sendStateIfChanged(true);
        }
        // After a structural edit, follow the edit (a drag continues without new
        // undo records) until it has been quiet for a while.
        if (now < watchUntil && now >= nextWatch)
        {
            nextWatch = now + 150;
            sendStateIfChanged();
        }
        if (now >= nextSlowCheck)
        {
            nextSlowCheck = now + 500;
            // Extended settings (tempo sync, extend, deactivate, deform...) and the
            // tuning change without parameter notifications or undo records on
            // some paths.
            if (const auto fingerprint = extendedSettings(); fingerprint != knownSettings)
            {
                knownSettings = fingerprint;
                sendStateIfChanged();
            }
            keepSizeWithZoom();
            sendEditorStateIfChanged();
            sendSizeIfChanged();
            const bool scope = s.storage.audioOut.subscribed();
            if (scope != scopeSubscribed)
            {
                scopeSubscribed = scope;
                Protocol::Writer frame(Protocol::Scope);
                frame.put(uint8_t(scope ? 1 : 0));
                send(frame.bytes);
            }
        }
        nowMs = now;
    }

    float meter(int channel) { return synth().vu_peak[channel]; }
    bool audioActive() { return synth().remoteAudioActive; }
    double scopeFrames{0};
    // Structural edits sent as parts, and complete states sent.
    uint32_t deltasSent{0}, statesSent{0};
    bool isConnected() const { return connected; }

  private:
    SurgeSynthProcessor &processor;
    SurgeSynthEditor &editor;
    std::unordered_map<int, uint32_t> ids;
    std::unordered_map<uint32_t, juce::AudioProcessorParameter *> byId;
    bool applyingRemote{false}, connected{false}, scopeSubscribed{false};
    unsigned knownGeneration{0};
    uint64_t knownSettings{0};
    double watchUntil{0}, nextWatch{0}, nextSlowCheck{0}, nowMs{0};
    std::vector<uint8_t> lastState;
    std::string lastEditorState;
    int lastWidth{0}, lastHeight{0}, lastBaseWidth{0}, lastBaseHeight{0};
    uint8_t keys[16]{};
    // The parts of the patch the plug-in holds (what this page last sent or got).
    std::unordered_map<uint32_t, std::string> sentParts;
    double sampleRate{0};

    SurgeSynthesizer &synth() { return *processor.surge; }

    void send(const std::vector<uint8_t> &bytes)
    {
        // clang-format off
        EM_ASM({ SurgeWclapPage.send(HEAPU8.slice($0, $0 + $1).buffer); }, bytes.data(), bytes.size());
        // clang-format on
    }

    // The desktop plug-in's getStateInformation, including the editor's view.
    std::vector<uint8_t> currentState()
    {
        juce::MemoryBlock block;
        processor.getStateInformation(block);
        const auto *data = static_cast<const uint8_t *>(block.getData());
        return {data, data + block.getSize()};
    }

    void rememberParts()
    {
        sentParts.clear();
        for (auto &part : StateParts::collect(synth()))
            sentParts[part.key()] = std::move(part.data);
    }

    void sendState(std::vector<uint8_t> state)
    {
        lastState = std::move(state);
        Protocol::Writer frame(Protocol::State, lastState.size());
        frame.append(lastState.data(), lastState.size());
        send(frame.bytes);
        ++statesSent;
        rememberParts();
    }

    // A patch load goes as a complete state (the plug-in reloads, retriggering held
    // notes, as the desktop does). An edit goes as the parts it changed, with the
    // digest of the state they make; an edit no part shows (already sent as
    // parameter or modulation frames) as the state, which the plug-in finds it holds.
    void sendStateIfChanged(bool patchLoad = false)
    {
        if (!connected)
            return;
        auto state = currentState();
        if (state == lastState)
            return;
        if (!patchLoad)
        {
            std::vector<StateParts::Part> changed;
            for (auto &part : StateParts::collect(synth()))
                if (auto known = sentParts.find(part.key());
                    known == sentParts.end() || known->second != part.data)
                    changed.push_back(std::move(part));
            if (!changed.empty())
            {
                size_t size = 12;
                for (const auto &part : changed)
                    size += 8 + part.data.size();
                Protocol::Writer frame(Protocol::Delta, size);
                frame.put(StateParts::digest(state.data(), state.size()))
                    .put(uint32_t(changed.size()));
                for (const auto &part : changed)
                    StateParts::write(frame, part);
                send(frame.bytes);
                ++deltasSent;
                for (auto &part : changed)
                    sentParts[part.key()] = std::move(part.data);
                lastState = std::move(state);
                return;
            }
        }
        sendState(std::move(state));
    }

    void structuralEdit()
    {
        if (applyingRemote)
            return;
        watchUntil = nowMs + 2000;
        nextWatch = nowMs + 50;
    }

    uint64_t extendedSettings()
    {
        uint64_t hash = 1469598103934665603ull;
        const auto mix = [&](uint64_t v) { hash = (hash ^ v) * 1099511628211ull; };
        for (const auto *p : synth().storage.getPatch().param_ptr)
        {
            mix(p->temposync);
            mix(p->extend_range);
            mix(p->deactivated);
            mix(p->absolute);
            mix(uint64_t(p->deform_type));
            mix(p->porta_constrate);
            mix(p->porta_gliss);
            mix(p->porta_retrigger);
            mix(uint64_t(p->porta_curve));
            mix(uint64_t(p->midictrl + 1));
        }
        mix(uint64_t(synth().storage.getPatch().fx_disable.val.i));
        // Tunings load without an undo record (SurgeGUIEditor::loadSCLFile).
        auto &storage = synth().storage;
        const auto text = [&](const std::string &value) {
            for (const unsigned char c : value)
                mix(c);
            mix(value.size());
        };
        mix(storage.isStandardScale);
        mix(storage.isStandardMapping);
        text(storage.currentScale.rawText);
        text(storage.currentMapping.rawText);
        text(storage.currentMapping.name);
        mix(storage.getPatch().patchTuning.tuningStoredInPatch);
        return hash;
    }

    void sendEditorStateIfChanged()
    {
        auto *gui = editor.browserGUIEditor();
        if (!connected || !gui)
            return;
        auto &patch = synth().storage.getPatch();
        gui->populateDawExtraState(&synth());
        TiXmlElement root("dawExtraState");
        root.SetAttribute("populated", 1);
        patch.saveEditorStateXml(root);
        TiXmlPrinter printer;
        printer.SetStreamPrinting();
        root.Accept(&printer);
        std::string text = printer.CStr();
        if (text == lastEditorState)
            return;
        lastEditorState = text;
        Protocol::Writer frame(Protocol::EditorState, text.size());
        frame.append(text.data(), text.size());
        send(frame.bytes);
    }

    // The editor's size at 100 %: Surge's base size, taller with the virtual keyboard.
    void baseSize(int &width, int &height)
    {
        width = BASE_WINDOW_SIZE_X;
        height = BASE_WINDOW_SIZE_Y;
        if (auto *gui = editor.browserGUIEditor(); gui && gui->getShowVirtualKeyboard())
            height += SurgeSynthEditor::extraYSpaceForVirtualKeyboard;
    }

    void sendSizeIfChanged()
    {
        if (!connected)
            return;
        const int width = editor.getWidth(), height = editor.getHeight();
        int baseWidth, baseHeight;
        baseSize(baseWidth, baseHeight);
        if (width == lastWidth && height == lastHeight && baseWidth == lastBaseWidth &&
            baseHeight == lastBaseHeight)
            return;
        lastWidth = width;
        lastHeight = height;
        lastBaseWidth = baseWidth;
        lastBaseHeight = baseHeight;
        Protocol::Writer frame(Protocol::Resize, 16);
        frame.put(uint32_t(width)).put(uint32_t(height));
        frame.put(uint32_t(baseWidth)).put(uint32_t(baseHeight));
        send(frame.bytes);
    }

    // The host resized the window: zoom to the largest whole percent that fits, as
    // the desktop editor does when its host resizes it (SurgeSynthEditor::resized).
    void fitToWindow(int width, int height)
    {
        auto *gui = editor.browserGUIEditor();
        if (!gui || width <= 0 || height <= 0)
            return;
        int baseWidth, baseHeight;
        baseSize(baseWidth, baseHeight);
        // The largest zoom whose editor fits (sizes as SurgeGUIEditor::setZoomFactor
        // computes them), in Surge's range: 25 % (SurgeGUIEditor::minimumZoom) to
        // 500 % (Zoom to Largest).
        const auto fits = [&](int z) {
            const float factor = float(double(z) * 0.01);
            return int(factor * float(baseWidth)) <= width && int(factor * float(baseHeight)) <= height;
        };
        int zoom = int(std::floor(std::min(double(width) * 100.0 / baseWidth,
                                           double(height) * 100.0 / baseHeight)));
        if (fits(zoom + 1))
            ++zoom;
        zoom = std::clamp(zoom, 25, 500);
        if (zoom != int(gui->getZoomFactor()))
            gui->resizeWindow(float(zoom));
        sendEditorStateIfChanged();
        sendSizeIfChanged();
    }

    // The editor's size follows its zoom: a restored instance zoom (from a snapshot)
    // changes the zoom without resizing the editor (SurgeGUIEditor's
    // loadFromDawExtraState), and here nothing else sizes it.
    void keepSizeWithZoom()
    {
        auto *gui = editor.browserGUIEditor();
        if (!gui)
            return;
        int baseWidth, baseHeight;
        baseSize(baseWidth, baseHeight);
        const float zoom = gui->getZoomFactor() * 0.01f;
        if (editor.getWidth() != int(zoom * baseWidth) || editor.getHeight() != int(zoom * baseHeight))
            gui->resizeWindow(gui->getZoomFactor());
    }

    void applyOutputState(const Protocol::OutputStateFrame &state, const std::string &host)
    {
        auto &s = synth();
        // The About screen shows the host and the rate the plug-in runs at.
        if (state.sampleRate > 0 && state.sampleRate != sampleRate)
        {
            sampleRate = state.sampleRate;
            s.setSamplerate(float(sampleRate));
        }
        if (!host.empty())
            s.hostProgram = host;
        // The output meter says whether the host is running the plug-in, not just
        // whether telemetry arrived lately.
        s.remoteAudioActive = state.processing != 0;
        s.processRunning = 0;
    }

    void applySnapshot(const uint8_t *data, size_t size)
    {
        {
            const juce::ScopedValueSetter<bool> remote(applyingRemote, true);
            processor.setStateInformation(data, int(size));
        }
        auto &s = synth();
        knownGeneration = s.browserPatchGeneration.load(std::memory_order_acquire);
        knownSettings = extendedSettings();
        lastState = currentState();
        rememberParts();
        connected = true;
        watchUntil = 0;
        s.refresh_editor = true;
        // clang-format off
        EM_ASM({ SurgeBrowser.reportFile(''); });
        // clang-format on
    }

    void applyTelemetry(const Protocol::TelemetryFrame &telemetry)
    {
        auto &s = synth();
        std::copy(std::begin(telemetry.vuPeak), std::end(telemetry.vuPeak), s.vu_peak);
        s.cpu_level.store(telemetry.cpuLevel);
        s.storage.activeVoiceCount.store(int(telemetry.activeVoices));
        s.processRunning = 0;
        for (int scene = 0; scene < n_scenes; ++scene)
        {
            s.storage.heldKeys[scene].lowest.store(telemetry.heldLowest[scene]);
            s.storage.heldKeys[scene].highest.store(telemetry.heldHighest[scene]);
            s.storage.heldKeys[scene].latest.store(telemetry.heldLatest[scene]);
        }
        // Key lights on the virtual keyboard, as notes from MIDI.
        const juce::ScopedValueSetter<bool> midi(processor.isAddingFromMidi, true);
        for (int key = 0; key < 128; ++key)
        {
            const bool now = telemetry.keys[key >> 3] & (1u << (key & 7));
            const bool was = keys[key >> 3] & (1u << (key & 7));
            if (now != was)
            {
                if (now)
                    processor.midiKeyboardState.noteOn(1, key, 1.f);
                else
                    processor.midiKeyboardState.noteOff(1, key, 0.f);
            }
        }
        std::copy(std::begin(telemetry.keys), std::end(telemetry.keys), keys);
    }

    // juce::AudioProcessorParameter::Listener: what a host would see.
    void parameterValueChanged(int index, float value) override
    {
        if (applyingRemote || !connected)
            return;
        if (const auto id = ids.find(index); id != ids.end())
        {
            Protocol::Writer frame(Protocol::Param);
            frame.put(id->second).put(double(value));
            send(frame.bytes);
        }
    }
    void parameterGestureChanged(int index, bool starting) override
    {
        if (applyingRemote || !connected)
            return;
        if (const auto id = ids.find(index); id != ids.end())
        {
            Protocol::Writer frame(Protocol::Gesture);
            frame.put(id->second).put(uint8_t(starting ? 1 : 0));
            send(frame.bytes);
        }
    }

    // The editor's virtual keyboard plays the plug-in.
    void note(int channel, int key, float velocity, bool on)
    {
        if (processor.isAddingFromMidi || !connected)
            return;
        Protocol::Writer frame(Protocol::Note);
        frame.put(uint8_t(on ? 1 : 0))
            .put(uint8_t(std::clamp(channel - 1, 0, 15)))
            .put(uint8_t(std::clamp(key, 0, 127)))
            .put(uint8_t(std::clamp(int(velocity * 127.f), on ? 1 : 0, 127)));
        send(frame.bytes);
    }
    void handleNoteOn(juce::MidiKeyboardState *, int channel, int key, float velocity) override
    {
        note(channel, key, velocity, true);
    }
    void handleNoteOff(juce::MidiKeyboardState *, int channel, int key, float velocity) override
    {
        note(channel, key, velocity, false);
    }

    // Modulation routings are edited on the stand-in through this API.
    void modulation(Protocol::ModulationOp op, long tag, modsources source, int scene, int index,
                    float value)
    {
        if (applyingRemote || !connected)
            return;
        Protocol::Writer frame(Protocol::Modulation);
        frame.put(int32_t(op))
            .put(int32_t(tag))
            .put(int32_t(source))
            .put(int32_t(scene))
            .put(int32_t(index))
            .put(value);
        send(frame.bytes);
    }
    void modSet(long tag, modsources source, int scene, int index, float value, bool) override
    {
        modulation(Protocol::ModulationDepth, tag, source, scene, index, value);
    }
    void modMuted(long tag, modsources source, int scene, int index, bool mute) override
    {
        modulation(Protocol::ModulationMute, tag, source, scene, index, mute ? 1.f : 0.f);
    }
    void modCleared(long tag, modsources source, int scene, int index) override
    {
        modulation(Protocol::ModulationClear, tag, source, scene, index, 0.f);
    }
};
} // namespace

void surge_wclap_ui_attach(SurgeSynthProcessor *processor, SurgeSynthEditor *editor)
{
    // The plug-in's snapshot sets the patch: do not download the default one.
    processor->surge->patchid_queue = -1;
    Bridge::instance = new Bridge(*processor, *editor);
    // clang-format off
    EM_ASM({ SurgeWclapPage.ready(); });
    // clang-format on
    Bridge::instance->start();
}

void surge_wclap_ui_pump()
{
    if (Bridge::instance)
        Bridge::instance->pump(emscripten_get_now());
}

// Diagnostics for the test host: the meter level the editor shows, oscilloscope
// frames received, and whether it has the plug-in's snapshot.
extern "C" EMSCRIPTEN_KEEPALIVE float surge_wclap_ui_meter()
{
    return Bridge::instance ? std::max(Bridge::instance->meter(0), Bridge::instance->meter(1))
                            : 0.f;
}
extern "C" EMSCRIPTEN_KEEPALIVE double surge_wclap_ui_scope_frames()
{
    return Bridge::instance ? Bridge::instance->scopeFrames : 0;
}
// Whether the editor's output meter shows the host running the plug-in, and the
// structural edits it sent as parts (deltas) and as complete states.
extern "C" EMSCRIPTEN_KEEPALIVE int surge_wclap_ui_audio_active()
{
    return Bridge::instance && Bridge::instance->audioActive();
}
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t surge_wclap_ui_deltas_sent()
{
    return Bridge::instance ? Bridge::instance->deltasSent : 0;
}
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t surge_wclap_ui_states_sent()
{
    return Bridge::instance ? Bridge::instance->statesSent : 0;
}
extern "C" EMSCRIPTEN_KEEPALIVE int surge_wclap_ui_connected()
{
    return Bridge::instance && Bridge::instance->isConnected();
}

// Room for the next message from the plug-in (main thread only).
extern "C" EMSCRIPTEN_KEEPALIVE uint8_t *surge_wclap_ui_buffer(int size)
{
    static std::vector<uint8_t> buffer;
    if (size <= 0 || size > (256 << 20))
        return nullptr;
    buffer.resize(size_t(size));
    return buffer.data();
}

// A message from the plug-in (window message event, main thread).
extern "C" EMSCRIPTEN_KEEPALIVE void surge_wclap_ui_receive(const uint8_t *data, int size)
{
    if (Bridge::instance && data && size > 0)
        Bridge::instance->receive(data, size_t(size));
}
