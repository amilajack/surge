// SPDX-License-Identifier: GPL-3.0-or-later
// Surge XT's editor as the clap.webview/3 page of the Surge XT WCLAP.
//
// The editor runs unchanged on a stand-in SurgeSynthProcessor that never renders
// audio. The real engine is the plug-in (module.wasm, src/surge-wclap); the two
// talk only through webview messages (src/surge-wclap/Protocol.h):
// - parameter and macro edits leave as Param/Gesture frames, through the JUCE
//   parameter listeners a host would use; values from the plug-in are set
//   without notifying, so nothing echoes;
// - structural edits (patch loads, oscillators, FX, MSEG, formulas, tuning...)
//   leave as complete states, detected from patch loads, the undo history and the
//   parameters' extended settings; modulation routings leave as frames;
// - the plug-in answers Hello with a Snapshot, and streams telemetry (meters,
//   voices, keys, oscilloscope audio) that the stand-in shows as its own.
#include "SurgeSynthProcessor.h"
#include "SurgeSynthEditor.h"
#include "SurgeGUIEditor.h"
#include "UndoManager.h"
#include "../../surge-wclap/Protocol.h"
#include "tinyxml/tinyxml.h"
#include <emscripten.h>
#include <algorithm>
#include <cstring>
#include <unordered_map>
#include <vector>

namespace Protocol = Surge::Wclap::Protocol;

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
        case Protocol::ScopeAudio:
        {
            const auto frames = frame.remaining() / 8;
            if (!frames || !synth().storage.audioOut.subscribed())
                return;
            std::vector<float> left(frames), right(frames);
            const auto *samples = reinterpret_cast<const float *>(frame.rest());
            for (size_t i = 0; i < frames; ++i)
            {
                std::memcpy(&left[i], frame.rest() + i * 8, 4);
                std::memcpy(&right[i], frame.rest() + i * 8 + 4, 4);
            }
            (void)samples;
            synth().storage.audioOut.push(left.data(), right.data(), frames);
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
            sendStateIfChanged();
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
            // Extended settings (tempo sync, extend, deactivate, deform...) change
            // without parameter notifications or undo records on some paths.
            if (const auto fingerprint = extendedSettings(); fingerprint != knownSettings)
            {
                knownSettings = fingerprint;
                sendStateIfChanged();
            }
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
            if (now - lastTelemetry > 1000)
                s.remoteAudioActive = false;
        }
        nowMs = now;
    }

    float meter(int channel) { return synth().vu_peak[channel]; }
    bool isConnected() const { return connected; }

  private:
    SurgeSynthProcessor &processor;
    SurgeSynthEditor &editor;
    std::unordered_map<int, uint32_t> ids;
    std::unordered_map<uint32_t, juce::AudioProcessorParameter *> byId;
    bool applyingRemote{false}, connected{false}, scopeSubscribed{false};
    unsigned knownGeneration{0};
    uint64_t knownSettings{0};
    double watchUntil{0}, nextWatch{0}, nextSlowCheck{0}, lastTelemetry{-1e9}, nowMs{0};
    std::vector<uint8_t> lastState;
    std::string lastEditorState;
    int lastWidth{0}, lastHeight{0};
    uint8_t keys[16]{};

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

    void sendStateIfChanged()
    {
        if (!connected)
            return;
        auto state = currentState();
        if (state == lastState)
            return;
        lastState = std::move(state);
        Protocol::Writer frame(Protocol::State, lastState.size());
        frame.append(lastState.data(), lastState.size());
        send(frame.bytes);
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

    void sendSizeIfChanged()
    {
        if (!connected)
            return;
        const int width = editor.getWidth(), height = editor.getHeight();
        if (width == lastWidth && height == lastHeight)
            return;
        lastWidth = width;
        lastHeight = height;
        Protocol::Writer frame(Protocol::Resize);
        frame.put(uint32_t(width)).put(uint32_t(height));
        send(frame.bytes);
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
        s.remoteAudioActive = true;
        s.processRunning = 0;
        lastTelemetry = nowMs;
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

// Diagnostics for the test host: the meter level the editor shows, and whether
// it has the plug-in's snapshot.
extern "C" EMSCRIPTEN_KEEPALIVE float surge_wclap_ui_meter()
{
    return Bridge::instance ? std::max(Bridge::instance->meter(0), Bridge::instance->meter(1))
                            : 0.f;
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
