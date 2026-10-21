// SPDX-License-Identifier: GPL-3.0-or-later
// Surge XT as a WCLAP plug-in: the headless engine (src/surge-web/EngineCore) behind
// the CLAP API, with the editor as a clap.webview/3 page.
//
// Threading: the module has its own, non-shared memory, so a host calls every
// function of every instance on the one agent that owns the module (a worker or an
// AudioWorklet). Main-thread and audio-thread calls never overlap, so state loads,
// effect construction and patch changes complete synchronously, between blocks.
//
// Audio ports are the desktop plug-in's: the main stereo output, the Scene A and
// Scene B outputs (each scene before the global effects, as SurgeSynthProcessor's
// extra buses), and the stereo sidechain input that the vocoder and the audio input
// oscillator read.
#include "Plugin.h"
#include "EngineCore.h"
#include "Params.h"
#include "Presets.h"
#include "Protocol.h"
#include "Random.h"
#include "StateParts.h"
#include "UserFiles.h"
#include "dsp/SurgeVoice.h"
#include "PatchFileHeaderStructs.h"
#include "tinyxml/tinyxml.h"
#include <clap/ext/draft/webview.h>
#include <cmrc/cmrc.hpp>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <memory>
#include <vector>

CMRC_DECLARE(surge_wclap_resources);

namespace Surge::Wclap
{
namespace
{
constexpr uint32_t block = BLOCK_SIZE;
static_assert(BLOCK_SIZE == 32, "The WCLAP block adapter expects 32-frame engine blocks");

const char *mimeFor(const std::string &path)
{
    const auto dot = path.find_last_of('.');
    const auto extension = dot == std::string::npos ? std::string() : path.substr(dot + 1);
    if (extension == "html")
        return "text/html; charset=utf-8";
    if (extension == "js" || extension == "mjs")
        return "text/javascript; charset=utf-8";
    if (extension == "wasm")
        return "application/wasm";
    if (extension == "json")
        return "application/json";
    if (extension == "css")
        return "text/css; charset=utf-8";
    if (extension == "svg")
        return "image/svg+xml";
    if (extension == "png")
        return "image/png";
    if (extension == "ttf")
        return "font/ttf";
    if (extension == "otf")
        return "font/otf";
    if (extension == "woff2")
        return "font/woff2";
    if (extension == "md" || extension == "txt")
        return "text/plain; charset=utf-8";
    if (extension == "xml")
        return "application/xml";
    return "application/octet-stream";
}

// A resource path below the bundle: absolute, with no "." or ".." segments.
bool safeResourcePath(const char *path)
{
    if (!path || path[0] != '/' || std::strlen(path) > 1024)
        return false;
    const std::string text(path);
    size_t start = 1;
    while (start <= text.size())
    {
        auto end = text.find('/', start);
        if (end == std::string::npos)
            end = text.size();
        const auto part = text.substr(start, end - start);
        if (part.empty() || part == "." || part == ".." || part.find('\\') != std::string::npos ||
            part.find('\0') != std::string::npos)
            return false;
        start = end + 1;
    }
    return true;
}

struct OutgoingParam
{
    uint16_t type; // CLAP_EVENT_PARAM_VALUE or a gesture
    clap_id id;
    double value;
};

class SurgeWclap final : public Surge::Web::EngineCore::Listener
{
  public:
    explicit SurgeWclap(const clap_host_t *h) : host(h)
    {
        plugin.desc = &descriptor;
        plugin.plugin_data = this;
        plugin.init = [](const clap_plugin_t *p) { return self(p)->init(); };
        plugin.destroy = [](const clap_plugin_t *p) { delete self(p); };
        plugin.activate = [](const clap_plugin_t *p, double rate, uint32_t, uint32_t maxFrames) {
            return self(p)->activate(rate, maxFrames);
        };
        plugin.deactivate = [](const clap_plugin_t *p) { self(p)->deactivate(); };
        plugin.start_processing = [](const clap_plugin_t *p) {
            self(p)->setProcessing(true);
            return true;
        };
        plugin.stop_processing = [](const clap_plugin_t *p) { self(p)->setProcessing(false); };
        plugin.reset = [](const clap_plugin_t *p) { self(p)->reset(); };
        plugin.process = [](const clap_plugin_t *p, const clap_process_t *process) {
            // The engine runs in process() (not inlined here), so this handler's try
            // region holds one call and does not constrain the engine's code.
            try
            {
                return self(p)->process(process);
            }
            catch (...)
            {
                return clap_process_status(CLAP_PROCESS_ERROR);
            }
        };
        plugin.get_extension = [](const clap_plugin_t *p, const char *id) {
            return self(p)->extension(id);
        };
        plugin.on_main_thread = [](const clap_plugin_t *p) { self(p)->onMainThread(); };
    }

    ~SurgeWclap()
    {
        RandomScope scope(random);
        engine.reset();
    }

    clap_plugin_t plugin{};

  private:
    const clap_host_t *host;
    const clap_host_params_t *hostParams{};
    const clap_host_state_t *hostState{};
    const clap_host_gui_t *hostGui{};
    const clap_host_webview_t *hostWebview{};
    const clap_host_log_t *hostLog{};
    const clap_host_preset_load_t *hostPresetLoad{};
    const clap_host_voice_info_t *hostVoiceInfo{};

    RandomStreams random;
    std::unique_ptr<Surge::Web::EngineCore> engine;
    const ParamTable *params{};

    bool activated{false}, processing{false};
    uint32_t maxFrames{0};
    // The editor shows the host's processing state; changes reach it from the main thread.
    bool outputStateChanged{false};
    uint32_t reportedVoices{0};
    bool voicesChanged{false};
    uint32_t blockPos{0};
    bool inputLatent{false}; // sticky, as the desktop plug-in: unaligned hosts delay input
    float latent[2][block]{};
    bool pumpNeeded{false};
    std::vector<OutgoingParam> outgoing;

    // Webview state. The page is open from its Hello until the GUI is destroyed
    // or a send fails.
    bool guiCreated{false}, guiVisible{true}, pageOpen{false};
    bool callbackRequested{false}, scopeSubscribed{false};
    uint32_t framesSinceTelemetry{0};
    // The window in CSS pixels, and the editor's size at 100 % zoom (Surge's 913 x 569,
    // taller with the virtual keyboard), which sizes are snapped to.
    uint32_t width{913}, height{569};
    uint32_t baseWidth{913}, baseHeight{569};
    double guiScale{0}; // clap.gui set_scale; 0 follows the device pixel ratio
    std::vector<float> pageValues; // what the page shows, by ParamTable index
    // Structural edits the page made as Delta frames and as complete states.
    uint32_t deltasApplied{0}, statesLoaded{0};

    static SurgeWclap *self(const clap_plugin_t *p)
    {
        return static_cast<SurgeWclap *>(p->plugin_data);
    }
    SurgeSynthesizer &synth() { return *engine->synth; }

    void log(clap_log_severity severity, const char *message)
    {
        if (hostLog)
            hostLog->log(host, severity, message);
    }

    template <typename F> bool guarded(const char *what, F &&fn)
    {
        try
        {
            fn();
            return true;
        }
        catch (const std::exception &error)
        {
            log(CLAP_LOG_ERROR, (std::string(what) + ": " + error.what()).c_str());
        }
        catch (...)
        {
            log(CLAP_LOG_ERROR, what);
        }
        return false;
    }

    // ---- lifecycle -------------------------------------------------------
    bool init()
    {
        hostParams =
            static_cast<const clap_host_params_t *>(host->get_extension(host, CLAP_EXT_PARAMS));
        hostState =
            static_cast<const clap_host_state_t *>(host->get_extension(host, CLAP_EXT_STATE));
        hostGui = static_cast<const clap_host_gui_t *>(host->get_extension(host, CLAP_EXT_GUI));
        hostWebview =
            static_cast<const clap_host_webview_t *>(host->get_extension(host, CLAP_EXT_WEBVIEW));
        hostLog = static_cast<const clap_host_log_t *>(host->get_extension(host, CLAP_EXT_LOG));
        hostPresetLoad = static_cast<const clap_host_preset_load_t *>(
            host->get_extension(host, CLAP_EXT_PRESET_LOAD));
        if (!hostPresetLoad)
            hostPresetLoad = static_cast<const clap_host_preset_load_t *>(
                host->get_extension(host, CLAP_EXT_PRESET_LOAD_COMPAT));
        hostVoiceInfo = static_cast<const clap_host_voice_info_t *>(
            host->get_extension(host, CLAP_EXT_VOICE_INFO));
        random.seedFromHost();
        RandomScope scope(random);
        return guarded("Surge XT failed to start", [&] {
            makeEngine(48000.);
            params = &ParamTable::get(synth());
            const auto patch = cmrc::surge_wclap_resources::get_filesystem().open("Init Saw.fxp");
            if (!engine->loadPatchFile(patch.begin(), patch.size(), "Init Saw", "Templates"))
                throw std::runtime_error("The default patch did not load");
            synth().storage.lastLoadedPatch = "/factory/patches_factory/Templates/Init Saw.fxp";
            synth().storage.getPatch().isDirty = false;
            reportedVoices = voiceCount();
        });
    }

    void makeEngine(double rate)
    {
        SurgeStorage::SurgeStorageConfig config;
        // No factory scan and no user folder: the engine needs neither, and
        // patches arrive as state. Configuration and tables are built in.
        config.suppliedDataPath = bundlePath == "/" ? "/factory" : bundlePath + "/factory";
        config.createUserDirectory = false;
        config.scanWavetableAndPatches = false;
        engine = std::make_unique<Surge::Web::EngineCore>(rate, config);
        engine->listener = this;
        synth().measureCpuLevel = pageOpen;
    }

    bool activate(double rate, uint32_t frames)
    {
        if (!engine || !std::isfinite(rate) || rate < 8000 || rate > 768000)
            return false;
        RandomScope scope(random);
        const bool ok = guarded("Surge XT could not activate", [&] {
            if (rate != engine->sampleRate)
            {
                // A new engine at the new rate, with the same patch: setSamplerate
                // leaves some rate-dependent state from construction (a native
                // engine built at the rate renders slightly differently).
                const auto state = engine->saveState();
                makeEngine(rate);
                if (!engine->loadState(state.data(), state.size()))
                    throw std::runtime_error("The patch did not survive the sample rate change");
                if (scopeSubscribed)
                    synth().storage.audioOut.subscribe();
            }
            blockPos = 0;
            inputLatent = false;
            std::memset(latent, 0, sizeof(latent));
        });
        if (ok)
        {
            activated = true;
            maxFrames = frames;
            if (pageOpen)
                sendOutputState();
        }
        return ok;
    }

    void deactivate()
    {
        activated = false;
        processing = false;
        if (pageOpen)
            sendOutputState();
    }

    // Audio thread: the editor hears about it from the main thread.
    void setProcessing(bool on)
    {
        processing = on;
        outputStateChanged = true;
        requestCallback();
    }

    // The voices the patch can play at once (clap.voice-info): the polyphony limit,
    // or one per playing scene when every playing scene is monophonic.
    uint32_t voiceCount()
    {
        auto &patch = synth().storage.getPatch();
        const bool both = patch.scenemode.val.i != sm_single;
        const int first = both ? 0 : std::clamp(patch.scene_active.val.i, 0, n_scenes - 1);
        bool mono = true;
        for (int scene = first; scene <= (both ? n_scenes - 1 : first); ++scene)
            mono = mono && patch.scene[scene].polymode.val.i != pm_poly;
        return mono ? (both ? 2u : 1u) : uint32_t(std::max(1, patch.polylimit.val.i));
    }

    void reset()
    {
        RandomScope scope(random);
        guarded("Surge XT could not reset", [&] {
            synth().stopSound();
            blockPos = 0;
            std::memset(latent, 0, sizeof(latent));
        });
    }

    // ---- processing ------------------------------------------------------
    void applyTransport(const clap_event_transport_t &transport)
    {
        auto &time = synth().time_data;
        if (transport.flags & CLAP_TRANSPORT_HAS_TEMPO)
            time.tempo = transport.tempo;
        const bool running =
            transport.flags & (CLAP_TRANSPORT_IS_PLAYING | CLAP_TRANSPORT_IS_RECORDING);
        time.isPlaying = running;
        synth().transportRunning = running;
        if (running && (transport.flags & CLAP_TRANSPORT_HAS_BEATS_TIMELINE))
            time.ppqPos = double(transport.song_pos_beats) / double(CLAP_BEATTIME_FACTOR);
        if (transport.flags & CLAP_TRANSPORT_HAS_TIME_SIGNATURE)
        {
            time.timeSigNumerator = transport.tsig_num;
            time.timeSigDenominator = transport.tsig_denom;
        }
    }

    void applyMidi(const uint8_t *data)
    {
        auto &s = synth();
        const int status = data[0] & 0xf0, channel = data[0] & 0x0f;
        const int a = data[1] & 0x7f, b = data[2] & 0x7f;
        switch (status)
        {
        case 0x80:
            s.releaseNote(channel, a, b);
            break;
        case 0x90:
            if (b)
                s.playNote(channel, a, b, 0, -1);
            else
                s.releaseNote(channel, a, 0, -1);
            break;
        case 0xa0:
            s.polyAftertouch(channel, a, b);
            break;
        case 0xb0:
            s.channelController(channel, a, b);
            break;
        case 0xc0:
            s.programChange(channel, a);
            break;
        case 0xd0:
            s.channelAftertouch(channel, a);
            break;
        case 0xe0:
            s.pitchBend(channel, (a | (b << 7)) - 8192);
            break;
        default:
            break;
        }
    }

    // Every key, or one, on every channel, or one: CLAP's wildcards for note off.
    template <typename F> void forNotes(int16_t channel, int16_t key, F &&fn)
    {
        for (int c = channel < 0 ? 0 : channel; c <= (channel < 0 ? 15 : channel); ++c)
            for (int k = key < 0 ? 0 : key; k <= (key < 0 ? 127 : key); ++k)
                fn(c, k);
    }

    void handleEvent(const clap_event_header_t *event)
    {
        if (event->space_id != CLAP_CORE_EVENT_SPACE_ID)
            return;
        auto &s = synth();
        switch (event->type)
        {
        case CLAP_EVENT_NOTE_ON:
        {
            const auto *note = reinterpret_cast<const clap_event_note_t *>(event);
            if (note->key < 0 || note->key > 127)
                break;
            const int channel = std::clamp<int>(note->channel, 0, 15);
            const auto velocity = char(127 * std::clamp(note->velocity, 0., 1.));
            if (velocity != 0)
                s.playNote(channel, note->key, velocity, 0, note->note_id);
            else
                s.releaseNote(channel, note->key, 0, note->note_id);
            break;
        }
        case CLAP_EVENT_NOTE_OFF:
        case CLAP_EVENT_NOTE_CHOKE:
        {
            const auto *note = reinterpret_cast<const clap_event_note_t *>(event);
            const auto velocity = char(127 * std::clamp(note->velocity, 0., 1.));
            const bool choke = event->type == CLAP_EVENT_NOTE_CHOKE;
            if ((note->key < 0 || note->channel < 0) && note->note_id >= 0 && !choke)
                s.releaseNoteByHostNoteID(note->note_id, velocity);
            else
                forNotes(note->channel, note->key, [&](int channel, int key) {
                    if (choke)
                        s.chokeNote(channel, key, velocity, note->note_id);
                    else
                        s.releaseNote(channel, key, velocity, note->note_id);
                });
            break;
        }
        case CLAP_EVENT_MIDI:
            applyMidi(reinterpret_cast<const clap_event_midi_t *>(event)->data);
            break;
        case CLAP_EVENT_PARAM_VALUE:
        {
            const auto *change = reinterpret_cast<const clap_event_param_value_t *>(event);
            const auto *entry = change->cookie ? static_cast<const ParamEntry *>(change->cookie)
                                               : params->find(change->param_id);
            if (!entry)
                break;
            ParamAccess::set(s, *entry, change->value);
            noteStructuralParameter(*entry);
            break;
        }
        case CLAP_EVENT_PARAM_MOD:
        {
            const auto *mod = reinterpret_cast<const clap_event_param_mod_t *>(event);
            const auto *entry = mod->cookie ? static_cast<const ParamEntry *>(mod->cookie)
                                            : params->find(mod->param_id);
            if (entry)
                ParamAccess::modulate(s, *entry, *mod);
            break;
        }
        case CLAP_EVENT_NOTE_EXPRESSION:
        {
            const auto *expression = reinterpret_cast<const clap_event_note_expression_t *>(event);
            auto type = SurgeVoice::UNKNOWN;
            switch (expression->expression_id)
            {
            case CLAP_NOTE_EXPRESSION_VOLUME:
                type = SurgeVoice::VOLUME;
                break;
            case CLAP_NOTE_EXPRESSION_PAN:
                type = SurgeVoice::PAN;
                break;
            case CLAP_NOTE_EXPRESSION_TUNING:
                type = SurgeVoice::PITCH;
                break;
            case CLAP_NOTE_EXPRESSION_BRIGHTNESS:
                type = SurgeVoice::TIMBRE;
                break;
            case CLAP_NOTE_EXPRESSION_PRESSURE:
                type = SurgeVoice::PRESSURE;
                break;
            default:
                break;
            }
            if (type != SurgeVoice::UNKNOWN)
                s.setNoteExpression(type, expression->note_id, expression->key, expression->channel,
                                    expression->value);
            break;
        }
        case CLAP_EVENT_TRANSPORT:
            applyTransport(reinterpret_cast<const clap_event_transport_t *>(event)[0]);
            synth().resetStateFromTimeData();
            break;
        default:
            break;
        }
    }

    // Effect type and Airwindows selections construct effects; the offline engine
    // has no control pump, so finish them at the next block boundary.
    void noteStructuralParameter(const ParamEntry &entry)
    {
        if (entry.synthId < 0)
            return;
        const auto type = synth().storage.getPatch().param_ptr[size_t(entry.synthId)]->ctrltype;
        if (type == ct_airwindows_fx || type == ct_fxtype)
        {
            pumpNeeded = true;
            infoChanged = true;
            requestCallback();
        }
    }
    bool infoChanged{false};

    void emitOutgoing(const clap_output_events_t *out)
    {
        if (!out)
        {
            outgoing.clear();
            return;
        }
        for (const auto &item : outgoing)
        {
            if (item.type == CLAP_EVENT_PARAM_VALUE)
            {
                clap_event_param_value_t event{};
                event.header = {sizeof(event), 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE,
                                0};
                event.param_id = item.id;
                event.cookie = const_cast<ParamEntry *>(params->find(item.id));
                event.note_id = event.port_index = event.channel = event.key = -1;
                event.value = item.value;
                out->try_push(out, &event.header);
            }
            else
            {
                clap_event_param_gesture_t event{};
                event.header = {sizeof(event), 0, CLAP_CORE_EVENT_SPACE_ID, item.type, 0};
                event.param_id = item.id;
                out->try_push(out, &event.header);
            }
        }
        outgoing.clear();
    }

    void emitNoteEnds(const clap_output_events_t *out, uint32_t time)
    {
        auto &s = synth();
        for (int v = 0; out && v < s.hostNoteEndedDuringBlockCount; ++v)
        {
            clap_event_note_t event{};
            event.header = {sizeof(event), time, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_NOTE_END, 0};
            event.port_index = 0;
            event.channel = s.endedHostNoteOriginalChannel[v];
            event.key = s.endedHostNoteOriginalKey[v];
            event.note_id = s.endedHostNoteIds[v];
            event.velocity = 0;
            out->try_push(out, &event.header);
        }
    }

    // An output bus of this call: the main output, Scene A or Scene B.
    struct Bus
    {
        float *left{nullptr}, *right{nullptr};
        const float *source[2]{};
        bool silent{true};
    };

    __attribute__((noinline)) clap_process_status process(const clap_process_t *process)
    {
        if (!engine || process->audio_outputs_count < 1 ||
            process->audio_outputs[0].channel_count < 1 || !process->audio_outputs[0].data32)
            return CLAP_PROCESS_ERROR;
        RandomScope scope(random);
        auto &s = synth();
        // The main output, then the scene outputs the host connected (stereo, as the
        // desktop plug-in's buses; SurgeSynthProcessor::isBusesLayoutSupported).
        Bus buses[3];
        uint32_t busCount = 1;
        {
            auto &main = process->audio_outputs[0];
            buses[0].left = main.data32[0];
            buses[0].right = main.channel_count > 1 ? main.data32[1] : nullptr;
            buses[0].source[0] = s.output[0];
            buses[0].source[1] = s.output[1];
        }
        for (uint32_t port = 1; port < 3 && port < process->audio_outputs_count; ++port)
        {
            const auto &bus = process->audio_outputs[port];
            if (bus.channel_count < 2 || !bus.data32 || !bus.data32[0] || !bus.data32[1])
                continue;
            buses[busCount].left = bus.data32[0];
            buses[busCount].right = bus.data32[1];
            buses[busCount].source[0] = s.sceneout[port - 1][0];
            buses[busCount].source[1] = s.sceneout[port - 1][1];
            ++busCount;
        }
        const float *inL = nullptr, *inR = nullptr;
        if (process->audio_inputs_count >= 1 && process->audio_inputs[0].channel_count >= 1 &&
            process->audio_inputs[0].data32)
        {
            inL = process->audio_inputs[0].data32[0];
            inR = process->audio_inputs[0].channel_count > 1 ? process->audio_inputs[0].data32[1]
                                                             : inL;
        }
        if (process->transport)
            applyTransport(*process->transport);
        s.resetStateFromTimeData();

        const auto frames = process->frames_count;
        // Hosts that deliver multiples of 32 frames get every block rendered from
        // the call's own input, with no latency. Others render ahead (outputs
        // still have no latency) and, like the desktop plug-in, delay input 32 frames.
        if (blockPos != 0 || frames % block)
            inputLatent = true;
        const auto *in = process->in_events;
        const uint32_t count = in ? in->size(in) : 0;
        uint32_t next = 0;
        const auto applyBefore = [&](uint64_t limit) {
            while (next < count)
            {
                const auto *event = in->get(in, next);
                if (event->time >= limit)
                    break;
                handleEvent(event);
                ++next;
            }
        };
        emitOutgoing(process->out_events);
        uint32_t at = 0;
        while (at < frames)
        {
            if (blockPos == 0)
            {
                applyBefore(uint64_t(at) + block);
                if (pumpNeeded)
                {
                    pumpNeeded = false;
                    guarded("Effect preparation failed",
                            [&] { engine->resolveAirwindowsSelection(); });
                }
                if (inL)
                {
                    s.process_input = true;
                    if (inputLatent)
                        std::memcpy(s.input, latent, sizeof(latent));
                    else
                    {
                        std::memcpy(s.input[0], inL + at, sizeof(float) * block);
                        std::memcpy(s.input[1], inR + at, sizeof(float) * block);
                    }
                }
                else
                    s.process_input = false;
                s.process();
                s.time_data.ppqPos +=
                    double(block) * s.time_data.tempo / (60. * s.storage.samplerate);
                emitNoteEnds(process->out_events, at);
                framesSinceTelemetry += block;
            }
            const uint32_t n = std::min(block - blockPos, frames - at);
            for (uint32_t b = 0; b < busCount; ++b)
            {
                auto &bus = buses[b];
                const float *l = bus.source[0] + blockPos, *r = bus.source[1] + blockPos;
                std::memcpy(bus.left + at, l, sizeof(float) * n);
                if (bus.right)
                    std::memcpy(bus.right + at, r, sizeof(float) * n);
                for (uint32_t i = 0; bus.silent && i < n; ++i)
                    bus.silent = l[i] == 0.f && r[i] == 0.f;
            }
            if (inputLatent && inL)
            {
                std::memcpy(latent[0] + blockPos, inL + at, sizeof(float) * n);
                std::memcpy(latent[1] + blockPos, inR + at, sizeof(float) * n);
            }
            at += n;
            blockPos = (blockPos + n) % block;
        }
        applyBefore(UINT64_MAX);
        emitOutgoing(process->out_events);
        // Connected buses report their silence; a scene bus the host left without
        // buffers is not touched.
        for (uint32_t port = 0, b = 0; port < 3 && port < process->audio_outputs_count; ++port)
        {
            auto &output = process->audio_outputs[port];
            if (b < busCount && output.data32 && output.data32[0] == buses[b].left)
            {
                output.constant_mask =
                    buses[b].silent ? (uint64_t(1) << output.channel_count) - 1 : 0;
                ++b;
            }
        }
        if (pageOpen && guiVisible && framesSinceTelemetry >= uint32_t(s.storage.samplerate / 30))
            requestCallback();
        if (const auto voices = voiceCount(); voices != reportedVoices)
        {
            reportedVoices = voices;
            voicesChanged = true;
            requestCallback();
        }
        // A silent instrument may sleep until its next event: hosts with many
        // tracks skip idle instances (effect tails and drones are not silent).
        // While its editor is visible it stays awake, so its meters keep running.
        return pageOpen && guiVisible ? CLAP_PROCESS_CONTINUE : CLAP_PROCESS_CONTINUE_IF_NOT_QUIET;
    }

    void paramsFlush(const clap_input_events_t *in, const clap_output_events_t *out)
    {
        RandomScope scope(random);
        guarded("Parameter flush failed", [&] {
            const uint32_t count = in ? in->size(in) : 0;
            for (uint32_t i = 0; i < count; ++i)
                handleEvent(in->get(in, i));
            if (!processing)
            {
                // As the offline engine API does: construct effects and apply
                // queued loads now, not in the first block after processing starts.
                synth().processAudioThreadOpsWhenAudioEngineUnavailable(true);
                if (pumpNeeded)
                {
                    pumpNeeded = false;
                    engine->resolveAirwindowsSelection();
                }
            }
            emitOutgoing(out);
        });
    }

    // ---- main thread -----------------------------------------------------
    void requestCallback()
    {
        if (!callbackRequested)
        {
            callbackRequested = true;
            host->request_callback(host);
        }
    }

    void onMainThread()
    {
        callbackRequested = false;
        RandomScope scope(random);
        guarded("Surge XT main-thread update failed", [&] {
            if (infoChanged)
            {
                infoChanged = false;
                if (hostParams)
                    hostParams->rescan(host, CLAP_PARAM_RESCAN_VALUES | CLAP_PARAM_RESCAN_TEXT |
                                                 CLAP_PARAM_RESCAN_INFO);
            }
            if (voicesChanged)
            {
                voicesChanged = false;
                if (hostVoiceInfo)
                    hostVoiceInfo->changed(host);
            }
            if (outputStateChanged)
            {
                outputStateChanged = false;
                if (pageOpen)
                    sendOutputState();
            }
            if (pageOpen && guiVisible && processing)
                sendTelemetry();
        });
    }

    // ---- state -----------------------------------------------------------
    bool stateSave(const clap_ostream_t *stream)
    {
        if (!engine || !stream)
            return false;
        RandomScope scope(random);
        std::vector<uint8_t> bytes;
        if (!guarded("Saving the state failed", [&] { bytes = engine->saveState(); }))
            return false;
        size_t written = 0;
        while (written < bytes.size())
        {
            const auto result =
                stream->write(stream, bytes.data() + written, bytes.size() - written);
            if (result <= 0)
                return false;
            written += size_t(result);
        }
        return true;
    }

    bool stateLoad(const clap_istream_t *stream)
    {
        if (!engine || !stream)
            return false;
        std::vector<uint8_t> bytes;
        uint8_t chunk[65536];
        for (;;)
        {
            const auto result = stream->read(stream, chunk, sizeof(chunk));
            if (result < 0)
                return false;
            if (result == 0)
                break;
            bytes.insert(bytes.end(), chunk, chunk + result);
            if (bytes.size() > (size_t(64) << 20))
                return false;
        }
        RandomScope scope(random);
        bool loaded = false;
        guarded("Loading the state failed",
                [&] { loaded = engine->loadState(bytes.data(), bytes.size()); });
        if (!loaded)
            return false;
        if (hostParams)
            hostParams->rescan(host, CLAP_PARAM_RESCAN_VALUES | CLAP_PARAM_RESCAN_TEXT |
                                         CLAP_PARAM_RESCAN_INFO);
        if (pageOpen)
            sendSnapshot();
        return true;
    }

    // ---- webview ---------------------------------------------------------
    bool send(const std::vector<uint8_t> &frame)
    {
        if (!pageOpen || !hostWebview)
            return false;
        if (!hostWebview->send(host, frame.data(), uint32_t(frame.size())))
        {
            closePage();
            return false;
        }
        return true;
    }

    void closePage()
    {
        pageOpen = false;
        pageValues.clear();
        if (engine)
        {
            synth().measureCpuLevel = false;
            if (scopeSubscribed)
                synth().storage.audioOut.unsubscribe();
        }
        scopeSubscribed = false;
    }

    void sendOutputState()
    {
        Protocol::OutputStateFrame state{};
        state.sampleRate = activated ? engine->sampleRate : 0.;
        state.active = activated;
        state.processing = activated && processing;
        state.maxFrames = maxFrames;
        const std::string name = host->name ? host->name : "";
        Protocol::Writer frame(Protocol::OutputState, sizeof(state) + name.size());
        frame.put(state).append(name.data(), name.size());
        send(frame.bytes);
    }

    void sendScale()
    {
        Protocol::Writer frame(Protocol::Scale, 8);
        frame.put(guiScale);
        send(frame.bytes);
    }

    void sendSize()
    {
        Protocol::Writer frame(Protocol::Resize, 8);
        frame.put(width).put(height);
        send(frame.bytes);
    }

    // The editor is on screen: ask the host to process even while the patch is
    // silent and the host would let it sleep, so meters, the oscilloscope and
    // the voice count run (CLAP host request_process; any thread).
    void keepAwake()
    {
        if (pageOpen && guiVisible)
            host->request_process(host);
    }

    void sendSnapshot()
    {
        const auto state = engine->saveState();
        Protocol::Writer frame(Protocol::Snapshot, 4 + state.size());
        frame.put(Protocol::version).append(state.data(), state.size());
        // The page now shows exactly these values.
        pageValues.resize(params->entries.size());
        for (size_t i = 0; i < params->entries.size(); ++i)
            pageValues[i] = float(ParamAccess::value(synth(), params->entries[i]));
        send(frame.bytes);
    }

    void sendTelemetry()
    {
        auto &s = synth();
        framesSinceTelemetry = 0;
        // Values the page does not show yet: host automation, modulation of macros
        // by MIDI, MIDI learn. Edits from the page are already recorded.
        for (size_t i = 0; i < params->entries.size() && i < pageValues.size(); ++i)
        {
            const auto value = float(ParamAccess::value(s, params->entries[i]));
            if (value != pageValues[i])
            {
                pageValues[i] = value;
                Protocol::Writer frame(Protocol::Param, 12);
                frame.put(params->entries[i].id).put(double(value));
                if (!send(frame.bytes))
                    return;
            }
        }
        Protocol::TelemetryFrame telemetry{};
        std::copy(std::begin(s.vu_peak), std::end(s.vu_peak), telemetry.vuPeak);
        telemetry.cpuLevel = s.cpu_level.load();
        telemetry.activeVoices = uint32_t(std::max(0, s.storage.activeVoiceCount.load()));
        for (int scene = 0; scene < n_scenes; ++scene)
        {
            for (const auto *voice : s.voices[scene])
                if (voice->state.gate && voice->state.key >= 0 && voice->state.key < 128)
                    telemetry.keys[voice->state.key >> 3] |= uint8_t(1u << (voice->state.key & 7));
            telemetry.heldLowest[scene] = s.storage.heldKeys[scene].lowest.load();
            telemetry.heldHighest[scene] = s.storage.heldKeys[scene].highest.load();
            telemetry.heldLatest[scene] = s.storage.heldKeys[scene].latest.load();
        }
        Protocol::Writer frame(Protocol::Telemetry, sizeof(telemetry));
        frame.put(telemetry);
        if (!send(frame.bytes))
            return;
        if (scopeSubscribed)
        {
            auto audio = s.storage.audioOut.popall();
            const size_t samples = std::min(audio.first.size(), audio.second.size());
            if (samples)
            {
                Protocol::Writer scopeFrame(Protocol::ScopeAudio, samples * 8);
                for (size_t i = 0; i < samples; ++i)
                    scopeFrame.put(audio.first[i]).put(audio.second[i]);
                send(scopeFrame.bytes);
            }
        }
    }

    void queueParam(uint16_t type, clap_id id, double value)
    {
        outgoing.push_back({type, id, value});
        if (!processing && hostParams)
            hostParams->request_flush(host);
    }

    void markDirty()
    {
        if (hostState)
            hostState->mark_dirty(host);
    }

    bool receive(const void *buffer, uint32_t size)
    {
        if (!engine || !buffer)
            return false;
        Protocol::Reader frame(buffer, size);
        if (!frame.valid())
            return false;
        RandomScope scope(random);
        bool handled = false;
        guarded("A message from the editor failed", [&] { handled = handleFrame(frame); });
        return handled;
    }

    bool handleFrame(Protocol::Reader &frame)
    {
        auto &s = synth();
        switch (frame.type())
        {
        case Protocol::Hello:
        {
            uint32_t version = 0;
            if (!frame.get(version) || version != Protocol::version)
                return false;
            pageOpen = true;
            s.measureCpuLevel = true;
            sendOutputState();
            if (guiScale > 0)
                sendScale();
            sendSnapshot();
            keepAwake();
            return true;
        }
        case Protocol::UserFiles:
        {
            // Before the editor starts: its user folder, or none.
            uint32_t version = 0;
            if (!frame.get(version) || version != Protocol::version)
                return false;
            pageOpen = true;
            std::vector<std::string> skipped;
            const auto list = UserFiles::list(&skipped);
            for (const auto &path : skipped)
                log(CLAP_LOG_WARNING,
                    ("User file left out of the editor (too large): " + path).c_str());
            send(list);
            return true;
        }
        case Protocol::UserFileOps:
        {
            const auto result = UserFiles::apply(frame);
            Protocol::Reader reply(result.data(), result.size());
            uint32_t sequence;
            uint8_t ok = 0;
            reply.get(sequence);
            reply.get(ok);
            if (!ok)
                log(CLAP_LOG_ERROR,
                    ("Saving user files failed: " +
                     std::string(reinterpret_cast<const char *>(result.data()) + 12,
                                 result.size() - 12))
                        .c_str());
            send(result);
            return true;
        }
        case Protocol::Delta:
            return applyDelta(frame);
        case Protocol::Param:
        {
            clap_id id;
            double value;
            if (!frame.get(id) || !frame.get(value) || !std::isfinite(value))
                return false;
            const auto *entry = params->find(id);
            if (!entry)
                return false;
            ParamAccess::set(s, *entry, value);
            const auto index = size_t(entry - params->entries.data());
            if (index < pageValues.size())
                pageValues[index] = float(ParamAccess::value(s, *entry));
            noteStructuralParameter(*entry);
            queueParam(CLAP_EVENT_PARAM_VALUE, id, std::clamp(value, 0., 1.));
            return true;
        }
        case Protocol::Gesture:
        {
            clap_id id;
            uint8_t begin;
            if (!frame.get(id) || !frame.get(begin) || !params->find(id))
                return false;
            queueParam(begin ? CLAP_EVENT_PARAM_GESTURE_BEGIN : CLAP_EVENT_PARAM_GESTURE_END, id,
                       0);
            return true;
        }
        case Protocol::State:
        {
            // Most edits already arrived as parameter and modulation frames: then
            // only the editor's view changed, and reloading would retrigger notes.
            if (engine->holdsState(frame.rest(), frame.remaining()))
            {
                applyEditorView(frame.rest(), frame.remaining());
                return true;
            }
            if (!engine->loadState(frame.rest(), frame.remaining()))
                return false;
            ++statesLoaded;
            reportPatchLoad();
            // The page made this patch: it already shows its values.
            pageValues.resize(params->entries.size());
            for (size_t i = 0; i < params->entries.size(); ++i)
                pageValues[i] = float(ParamAccess::value(s, params->entries[i]));
            if (hostParams)
                hostParams->rescan(host, CLAP_PARAM_RESCAN_VALUES | CLAP_PARAM_RESCAN_TEXT |
                                             CLAP_PARAM_RESCAN_INFO);
            markDirty();
            return true;
        }
        case Protocol::Modulation:
        {
            int32_t op, tag, source, scene, index;
            float value;
            if (!frame.get(op) || !frame.get(tag) || !frame.get(source) || !frame.get(scene) ||
                !frame.get(index) || !frame.get(value) || tag < 0 ||
                size_t(tag) >= s.storage.getPatch().param_ptr.size() || source <= 0 ||
                source >= n_modsources || scene < 0 || scene >= n_scenes || !std::isfinite(value))
                return false;
            const auto modsource = modsources(source);
            if (op == Protocol::ModulationDepth)
                s.setModDepth01(tag, modsource, scene, index, value);
            else if (op == Protocol::ModulationMute)
                s.muteModulation(tag, modsource, scene, index, value != 0.f);
            else if (op == Protocol::ModulationClear)
                s.clearModulation(tag, modsource, scene, index, false);
            else
                return false;
            markDirty();
            return true;
        }
        case Protocol::Note:
        {
            uint8_t on, channel, key, velocity;
            if (!frame.get(on) || !frame.get(channel) || !frame.get(key) || !frame.get(velocity) ||
                channel > 15 || key > 127)
                return false;
            if (on && velocity)
                s.playNote(char(channel), char(key), char(std::min<int>(velocity, 127)), 0, -1);
            else
                s.releaseNote(char(channel), char(key), char(std::min<int>(velocity, 127)), -1);
            // A sleeping plug-in has to wake to play it.
            host->request_process(host);
            return true;
        }
        case Protocol::EditorState:
        {
            const std::string xml(reinterpret_cast<const char *>(frame.rest()), frame.remaining());
            TiXmlDocument document;
            document.Parse(xml.c_str());
            auto *root = document.FirstChildElement("dawExtraState");
            if (document.Error() || !root)
                return false;
            auto &patch = s.storage.getPatch();
            patch.dawExtraState.isPopulated = true;
            if (auto *zoom = root->FirstChildElement("instanceZoomFactor"))
                zoom->QueryIntAttribute("v", &patch.dawExtraState.editor.instanceZoomFactor);
            patch.loadEditorStateXml(root, true);
            return true;
        }
        case Protocol::Resize:
        {
            // The editor's size changed (its zoom, the virtual keyboard), and its size
            // at 100 %, which host resizes snap to.
            uint32_t w, h, bw = baseWidth, bh = baseHeight;
            if (!frame.get(w) || !frame.get(h) || w < 64 || h < 64 || w > 16384 || h > 16384)
                return false;
            if (frame.remaining() >= 8 && (!frame.get(bw) || !frame.get(bh) || bw < 64 ||
                                           bh < 64 || bw > 4096 || bh > 4096))
                return false;
            if (bw != baseWidth || bh != baseHeight)
            {
                baseWidth = bw;
                baseHeight = bh;
                if (hostGui && guiCreated)
                    hostGui->resize_hints_changed(host);
            }
            if (w != width || h != height)
            {
                width = w;
                height = h;
                // A size the host chose (set_size) is the host's; anything else is
                // the editor's own zoom, which the host follows.
                if (!hostSized && hostGui && guiCreated)
                    hostGui->request_resize(host, width, height);
            }
            hostSized = false;
            return true;
        }
        case Protocol::Scope:
        {
            uint8_t subscribe;
            if (!frame.get(subscribe))
                return false;
            if (bool(subscribe) != scopeSubscribed)
            {
                scopeSubscribed = subscribe;
                if (scopeSubscribed)
                    s.storage.audioOut.subscribe();
                else
                    s.storage.audioOut.unsubscribe();
            }
            return true;
        }
        default:
            return false;
        }
    }

    // A structural edit as the parts it changed, applied in place (StateParts.h): the
    // engine's voices keep playing, as when the desktop editor edits the engine's
    // storage. When the result is not the page's patch, the page sends its state.
    bool applyDelta(Protocol::Reader &frame)
    {
        uint64_t digest;
        uint32_t count;
        if (!frame.get(digest) || !frame.get(count) || count > 4096)
            return false;
        std::vector<StateParts::Part> parts(count);
        for (auto &part : parts)
            if (!StateParts::read(frame, part))
                return false;
        bool applied = true, names = false;
        for (const auto &part : parts)
        {
            applied = StateParts::apply(synth(), part) && applied;
            names = names || part.kind == StateParts::Macro;
        }
        auto &s = synth();
        s.storage.getPatch().isDirty = true;
        if (digest)
        {
            const auto state = engine->saveState();
            if (!applied || StateParts::digest(state.data(), state.size()) != digest)
            {
                log(CLAP_LOG_WARNING, "An edit from the editor did not apply in place; the "
                                      "editor sends the whole patch instead");
                send(Protocol::Writer(Protocol::NeedState).bytes);
                return true;
            }
        }
        else if (!applied)
            return false;
        ++deltasApplied;
        if (names && hostParams)
            hostParams->rescan(host, CLAP_PARAM_RESCAN_INFO | CLAP_PARAM_RESCAN_TEXT);
        markDirty();
        return true;
    }

    // The editor loaded a patch file: hosts that follow presets (clap.preset-load)
    // hear which one, by the path a preset discovery location gives it.
    std::string reportedPreset;
    void reportPatchLoad()
    {
        if (!hostPresetLoad)
            return;
        auto path = synth().storage.lastLoadedPatch.u8string();
        const std::string factoryPrefix = "/factory/patches_factory/";
        if (path.compare(0, factoryPrefix.size(), factoryPrefix) == 0)
            path = Presets::factoryLocation() + "/" + path.substr(factoryPrefix.size());
        else if (path.compare(0, Presets::userLocation().size() + 1,
                              Presets::userLocation() + "/") != 0)
            return;
        if (path == reportedPreset)
            return;
        reportedPreset = path;
        hostPresetLoad->loaded(host, CLAP_PRESET_DISCOVERY_LOCATION_FILE, path.c_str(), nullptr);
    }

    // clap.preset-load: a Surge XT patch file from a preset discovery location.
    bool loadPreset(uint32_t kind, const char *location, const char *key)
    {
        const auto fail = [&](const std::string &message) {
            log(CLAP_LOG_ERROR, message.c_str());
            if (hostPresetLoad)
                hostPresetLoad->on_error(host, kind, location, key, 0, message.c_str());
            return false;
        };
        if (!engine || kind != CLAP_PRESET_DISCOVERY_LOCATION_FILE || !location)
            return fail("Surge XT presets are files");
        const std::string path(location);
        std::vector<uint8_t> bytes;
        Presets::PatchInfo info;
        std::string error;
        if (!Presets::readFile(path, bytes))
            return fail(path + ": unable to read the file");
        if (!Presets::readPatchInfo(bytes, info, error))
            return fail(path + ": " + error);
        const auto factory = Presets::factoryLocation();
        const bool isFactory = path.compare(0, factory.size() + 1, factory + "/") == 0;
        auto category = Presets::categoryOf(path, isFactory ? factory : Presets::userLocation());
        auto name = path.substr(path.find_last_of('/') + 1);
        if (name.size() > 4 && name.compare(name.size() - 4, 4, ".fxp") == 0)
            name.resize(name.size() - 4);
        RandomScope scope(random);
        bool loaded = false;
        guarded("Loading the preset failed",
                [&] { loaded = engine->loadPatchFile(bytes.data(), bytes.size(), name, category); });
        if (!loaded)
            return fail(path + ": the patch did not load");
        // The editor's patch browser knows factory patches by its own path.
        synth().storage.lastLoadedPatch =
            isFactory ? "/factory/patches_factory/" + path.substr(factory.size() + 1) : path;
        synth().storage.getPatch().isDirty = false;
        if (hostParams)
            hostParams->rescan(host, CLAP_PARAM_RESCAN_VALUES | CLAP_PARAM_RESCAN_TEXT |
                                         CLAP_PARAM_RESCAN_INFO);
        if (pageOpen)
            sendSnapshot();
        markDirty();
        reportedPreset = path;
        if (hostPresetLoad)
            hostPresetLoad->loaded(host, kind, location, key);
        return true;
    }

    // clap.remote-controls: the desktop plug-in's pages (SurgeSynthProcessor::
    // remoteControlsPageFill): the macros, then each scene's mixer and filters.
    static constexpr uint32_t remotePages = 5;
    bool remotePage(uint32_t index, clap_remote_controls_page_t *page)
    {
        if (!engine || !params || !page || index >= remotePages)
            return false;
        *page = {};
        page->page_id = clap_id(index + 2054);
        page->is_for_preset = false;
        for (auto &id : page->param_ids)
            id = CLAP_INVALID_ID;
        const auto name = [](char *to, const char *text) {
            std::strncpy(to, text, CLAP_NAME_SIZE - 1);
        };
        auto &s = synth();
        const auto idOf = [&](Parameter &parameter) {
            const auto *entry = params->forSynthId(s.idForParameter(&parameter).getSynthSideId());
            return entry ? entry->id : CLAP_INVALID_ID;
        };
        if (index == 0)
        {
            name(page->section_name, "Global");
            name(page->page_name, "Macros");
            for (int i = 0; i < CLAP_REMOTE_CONTROLS_COUNT && i < n_customcontrollers; ++i)
                page->param_ids[i] = params->forMacro(i)->id;
            return true;
        }
        const int scene = index >= 3 ? 1 : 0;
        auto &sc = s.storage.getPatch().scene[scene];
        name(page->section_name, scene ? "Scene B" : "Scene A");
        if (index == 1 || index == 3)
        {
            name(page->page_name, scene ? "Scene B Mixer" : "Scene A Mixer");
            page->param_ids[0] = idOf(sc.level_o1);
            page->param_ids[1] = idOf(sc.level_o2);
            page->param_ids[2] = idOf(sc.level_o3);
            page->param_ids[4] = idOf(sc.level_noise);
            page->param_ids[5] = idOf(sc.level_ring_12);
            page->param_ids[6] = idOf(sc.level_ring_23);
            page->param_ids[7] = idOf(sc.level_pfg);
        }
        else
        {
            name(page->page_name, scene ? "Scene B Filters" : "Scene A Filters");
            page->param_ids[0] = idOf(sc.filterunit[0].cutoff);
            page->param_ids[1] = idOf(sc.filterunit[0].resonance);
            page->param_ids[2] = idOf(sc.filterunit[1].cutoff);
            page->param_ids[3] = idOf(sc.filterunit[1].resonance);
            page->param_ids[4] = idOf(sc.wsunit.drive);
            page->param_ids[6] = idOf(sc.filter_balance);
            page->param_ids[7] = idOf(sc.feedback);
        }
        return true;
    }

    // ---- editor size ------------------------------------------------------
    // Surge zooms in whole percents from 25 % (SurgeGUIEditor::minimumZoom); the
    // largest it offers is 500 % ("Zoom to Largest").
    static constexpr int minimumZoom = 25, maximumZoom = 500;
    bool hostSized{false}; // the page's next size report answers a host set_size

    // The editor's size at a zoom, computed as SurgeGUIEditor::setZoomFactor does.
    void sizeForZoom(int zoom, uint32_t &w, uint32_t &h) const
    {
        const float factor = float(double(zoom) * 0.01);
        w = uint32_t(factor * float(baseWidth));
        h = uint32_t(factor * float(baseHeight));
    }

    // The largest zoom whose editor fits in the size (so the size of a zoom adjusts
    // to itself).
    int zoomFitting(uint32_t w, uint32_t h) const
    {
        int zoom = int(std::floor(std::min(double(w) * 100.0 / baseWidth,
                                           double(h) * 100.0 / baseHeight)));
        uint32_t fw, fh;
        sizeForZoom(zoom + 1, fw, fh);
        if (fw <= w && fh <= h)
            ++zoom;
        return std::clamp(zoom, minimumZoom, maximumZoom);
    }

    bool adjustSize(uint32_t &w, uint32_t &h) const
    {
        sizeForZoom(zoomFitting(w, h), w, h);
        return true;
    }

    // The editor view (zoom, tabs, overlays) of a raw state, without loading it.
    void applyEditorView(const uint8_t *data, size_t size)
    {
        sst::io::patch_header header{};
        if (size < sizeof(header))
            return;
        std::memcpy(&header, data, sizeof(header));
        const size_t length = header.xmlsize; // little-endian (wasm32)
        if (length > size - sizeof(header))
            return;
        const std::string text(reinterpret_cast<const char *>(data) + sizeof(header), length);
        TiXmlDocument document;
        document.Parse(text.c_str(), nullptr, TIXML_ENCODING_LEGACY);
        auto *patch = document.FirstChildElement("patch");
        auto *extra = patch ? patch->FirstChildElement("dawExtraState") : nullptr;
        if (!extra)
            return;
        auto &dawExtra = synth().storage.getPatch().dawExtraState;
        dawExtra.isPopulated = true;
        if (auto *zoom = extra->FirstChildElement("instanceZoomFactor"))
            zoom->QueryIntAttribute("v", &dawExtra.editor.instanceZoomFactor);
        synth().storage.getPatch().loadEditorStateXml(extra, true);
    }

    bool getResource(const char *path, char *mime, uint32_t capacity, const clap_ostream_t *stream)
    {
        if (!safeResourcePath(path) || !stream)
            return false;
        const std::string relative(path);
        // The DSP module itself is not a page resource.
        if (relative == "/module.wasm")
            return false;
        const auto file = (bundlePath == "/" ? std::string() : bundlePath) + relative;
        std::ifstream input(file, std::ios::binary);
        if (!input)
            return false;
        if (mime && capacity)
        {
            std::strncpy(mime, mimeFor(relative), capacity - 1);
            mime[capacity - 1] = 0;
        }
        std::vector<char> chunk(1 << 16);
        while (input)
        {
            input.read(chunk.data(), std::streamsize(chunk.size()));
            const auto length = size_t(input.gcount());
            size_t written = 0;
            while (written < length)
            {
                const auto result = stream->write(stream, chunk.data() + written, length - written);
                if (result <= 0)
                    return false;
                written += size_t(result);
            }
        }
        return input.eof();
    }

    // ---- extensions ------------------------------------------------------
    const void *extension(const char *id);

  public:
    // Engine changes the host and page do not know about yet (MIDI learn).
    void engineParameterUpdated(int synthId, float value) override
    {
        if (const auto *entry = params ? params->forSynthId(synthId) : nullptr)
            queueParam(CLAP_EVENT_PARAM_VALUE, entry->id, value);
    }
    void engineMacroUpdated(int macro, float value) override
    {
        if (params && macro >= 0 && macro < n_customcontrollers)
            queueParam(CLAP_EVENT_PARAM_VALUE, params->forMacro(macro)->id, value);
    }

    friend struct Extensions;
};

struct Extensions
{
    static SurgeWclap *self(const clap_plugin_t *p) { return SurgeWclap::self(p); }

    static constexpr clap_plugin_params_t params{
        [](const clap_plugin_t *p) -> uint32_t {
            return self(p)->params ? uint32_t(self(p)->params->entries.size()) : 0;
        },
        [](const clap_plugin_t *p, uint32_t index, clap_param_info_t *info) {
            auto *plugin = self(p);
            if (!plugin->params || index >= plugin->params->entries.size() || !info)
                return false;
            return ParamAccess::info(plugin->synth(), plugin->params->entries[index], *info);
        },
        [](const clap_plugin_t *p, clap_id id, double *value) {
            auto *plugin = self(p);
            const auto *entry = plugin->params ? plugin->params->find(id) : nullptr;
            if (!entry || !value)
                return false;
            *value = ParamAccess::value(plugin->synth(), *entry);
            return true;
        },
        [](const clap_plugin_t *p, clap_id id, double value, char *text, uint32_t capacity) {
            auto *plugin = self(p);
            const auto *entry = plugin->params ? plugin->params->find(id) : nullptr;
            return entry && ParamAccess::toText(plugin->synth(), *entry, value, text, capacity);
        },
        [](const clap_plugin_t *p, clap_id id, const char *text, double *value) {
            auto *plugin = self(p);
            const auto *entry = plugin->params ? plugin->params->find(id) : nullptr;
            return entry && value && ParamAccess::fromText(plugin->synth(), *entry, text, *value);
        },
        [](const clap_plugin_t *p, const clap_input_events_t *in, const clap_output_events_t *out) {
            self(p)->paramsFlush(in, out);
        },
    };

    static constexpr clap_plugin_state_t state{
        [](const clap_plugin_t *p, const clap_ostream_t *stream) {
            return self(p)->stateSave(stream);
        },
        [](const clap_plugin_t *p, const clap_istream_t *stream) {
            return self(p)->stateLoad(stream);
        },
    };

    // The desktop plug-in's buses and port ids (clap-juce-extensions): outputs
    // "Output" (1, main), "Scene A" (2) and "Scene B" (3); input "Sidechain" (32768),
    // not main, as SurgeSynthProcessor::isInputMain says. Not in place: the input of
    // a block is kept after its output is written.
    static constexpr clap_plugin_audio_ports_t audioPorts{
        [](const clap_plugin_t *, bool input) -> uint32_t { return input ? 1 : 3; },
        [](const clap_plugin_t *, uint32_t index, bool input, clap_audio_port_info_t *info) {
            if (!info || index >= (input ? 1u : 3u))
                return false;
            static const char *const outputs[] = {"Output", "Scene A", "Scene B"};
            *info = {};
            info->id = input ? clap_id(1 << 15) : clap_id(1 + index);
            std::strncpy(info->name, input ? "Sidechain" : outputs[index], sizeof(info->name) - 1);
            info->flags = !input && index == 0 ? CLAP_AUDIO_PORT_IS_MAIN : 0;
            info->channel_count = 2;
            info->port_type = CLAP_PORT_STEREO;
            info->in_place_pair = CLAP_INVALID_ID;
            return true;
        },
    };

    static constexpr clap_plugin_note_ports_t notePorts{
        [](const clap_plugin_t *, bool input) -> uint32_t { return input ? 1 : 0; },
        [](const clap_plugin_t *, uint32_t index, bool input, clap_note_port_info_t *info) {
            if (index != 0 || !input || !info)
                return false;
            *info = {};
            info->id = 0;
            info->supported_dialects =
                CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI | CLAP_NOTE_DIALECT_MIDI_MPE;
            info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
            std::strncpy(info->name, "Note Input", sizeof(info->name) - 1);
            return true;
        },
    };

    static constexpr clap_plugin_latency_t latency{
        [](const clap_plugin_t *) -> uint32_t { return 0; }};

    static constexpr clap_plugin_tail_t tail{[](const clap_plugin_t *p) -> uint32_t {
        // SurgeSynthProcessor::getTailLengthSeconds
        auto *plugin = self(p);
        return plugin->engine ? uint32_t(2.0 * plugin->engine->sampleRate) : 96000;
    }};

    static constexpr clap_plugin_render_t render{
        [](const clap_plugin_t *) { return false; },
        // Every path is already synchronous and deterministic: there are no
        // worker threads, so offline rendering needs no different mode.
        [](const clap_plugin_t *, clap_plugin_render_mode mode) {
            return mode == CLAP_RENDER_REALTIME || mode == CLAP_RENDER_OFFLINE;
        },
    };

    static constexpr clap_plugin_voice_info_t voiceInfo{
        [](const clap_plugin_t *p, clap_voice_info_t *info) {
            auto *plugin = self(p);
            if (!plugin->engine || !info)
                return false;
            info->voice_count = plugin->voiceCount();
            info->voice_capacity = MAX_VOICES;
            info->flags = CLAP_VOICE_INFO_SUPPORTS_OVERLAPPING_NOTES;
            return true;
        },
    };

    static constexpr clap_plugin_gui_t gui{
        [](const clap_plugin_t *, const char *api, bool) {
            return api && std::strcmp(api, CLAP_WINDOW_API_WEBVIEW) == 0;
        },
        [](const clap_plugin_t *, const char **api, bool *floating) {
            if (!api || !floating)
                return false;
            *api = CLAP_WINDOW_API_WEBVIEW;
            *floating = false;
            return true;
        },
        [](const clap_plugin_t *p, const char *api, bool) {
            if (!api || std::strcmp(api, CLAP_WINDOW_API_WEBVIEW) != 0)
                return false;
            auto *plugin = self(p);
            plugin->guiCreated = true;
            // Open at the zoom saved with the instance, as the desktop editor does.
            if (plugin->engine && !plugin->pageOpen)
                if (const int zoom = plugin->synth()
                                         .storage.getPatch()
                                         .dawExtraState.editor.instanceZoomFactor;
                    zoom >= SurgeWclap::minimumZoom && zoom <= SurgeWclap::maximumZoom)
                    plugin->sizeForZoom(zoom, plugin->width, plugin->height);
            return true;
        },
        [](const clap_plugin_t *p) {
            auto *plugin = self(p);
            plugin->guiCreated = false;
            plugin->closePage();
        },
        // The host's scale overrides the window's device pixel ratio, by which the
        // page sizes its canvas backing store, so the editor renders sharp.
        [](const clap_plugin_t *p, double scale) {
            if (!std::isfinite(scale) || scale <= 0 || scale > 8)
                return false;
            auto *plugin = self(p);
            plugin->guiScale = scale;
            if (plugin->pageOpen)
                plugin->sendScale();
            return true;
        },
        [](const clap_plugin_t *p, uint32_t *width, uint32_t *height) {
            if (!width || !height)
                return false;
            *width = self(p)->width;
            *height = self(p)->height;
            return true;
        },
        [](const clap_plugin_t *) { return true; },
        // Any size, keeping the editor's aspect ratio; sizes snap to Surge's zooms.
        [](const clap_plugin_t *p, clap_gui_resize_hints_t *hints) {
            if (!hints)
                return false;
            hints->can_resize_horizontally = true;
            hints->can_resize_vertically = true;
            hints->preserve_aspect_ratio = true;
            hints->aspect_ratio_width = self(p)->baseWidth;
            hints->aspect_ratio_height = self(p)->baseHeight;
            return true;
        },
        [](const clap_plugin_t *p, uint32_t *width, uint32_t *height) {
            return width && height && self(p)->adjustSize(*width, *height);
        },
        // The editor zooms to fit the host's window (it stays at the top left when a
        // size was not adjusted); its own zoom changes come back as request_resize.
        [](const clap_plugin_t *p, uint32_t width, uint32_t height) {
            if (width < 64 || height < 64 || width > 16384 || height > 16384)
                return false;
            auto *plugin = self(p);
            if (width == plugin->width && height == plugin->height)
                return true;
            plugin->width = width;
            plugin->height = height;
            if (plugin->pageOpen)
            {
                plugin->hostSized = true;
                plugin->sendSize();
            }
            return true;
        },
        [](const clap_plugin_t *, const clap_window_t *) { return true; },
        [](const clap_plugin_t *, const clap_window_t *) { return true; },
        [](const clap_plugin_t *, const char *) {},
        [](const clap_plugin_t *p) {
            self(p)->guiVisible = true;
            self(p)->keepAwake();
            return true;
        },
        [](const clap_plugin_t *p) {
            self(p)->guiVisible = false;
            return true;
        },
    };

    static constexpr clap_plugin_remote_controls_t remoteControls{
        [](const clap_plugin_t *) -> uint32_t { return SurgeWclap::remotePages; },
        [](const clap_plugin_t *p, uint32_t index, clap_remote_controls_page_t *page) {
            return self(p)->remotePage(index, page);
        },
    };

    static constexpr clap_plugin_preset_load_t presetLoad{
        [](const clap_plugin_t *p, uint32_t kind, const char *location, const char *key) {
            return self(p)->loadPreset(kind, location, key);
        },
    };

    static constexpr clap_plugin_webview_t webview{
        [](const clap_plugin_t *, char *uri, uint32_t capacity) -> int32_t {
            static const char page[] = "/ui/index.html";
            if (uri && capacity)
            {
                std::strncpy(uri, page, capacity - 1);
                uri[capacity - 1] = 0;
            }
            return int32_t(sizeof(page));
        },
        [](const clap_plugin_t *p, const char *path, char *mime, uint32_t capacity,
           const clap_ostream_t *stream) {
            return self(p)->getResource(path, mime, capacity, stream);
        },
        [](const clap_plugin_t *p, const void *buffer, uint32_t size) {
            return self(p)->receive(buffer, size);
        },
    };
};

const void *SurgeWclap::extension(const char *id)
{
    if (!id)
        return nullptr;
    if (!std::strcmp(id, CLAP_EXT_PARAMS))
        return &Extensions::params;
    if (!std::strcmp(id, CLAP_EXT_STATE))
        return &Extensions::state;
    if (!std::strcmp(id, CLAP_EXT_AUDIO_PORTS))
        return &Extensions::audioPorts;
    if (!std::strcmp(id, CLAP_EXT_NOTE_PORTS))
        return &Extensions::notePorts;
    if (!std::strcmp(id, CLAP_EXT_LATENCY))
        return &Extensions::latency;
    if (!std::strcmp(id, CLAP_EXT_TAIL))
        return &Extensions::tail;
    if (!std::strcmp(id, CLAP_EXT_RENDER))
        return &Extensions::render;
    if (!std::strcmp(id, CLAP_EXT_VOICE_INFO))
        return &Extensions::voiceInfo;
    if (!std::strcmp(id, CLAP_EXT_GUI))
        return &Extensions::gui;
    if (!std::strcmp(id, CLAP_EXT_WEBVIEW))
        return &Extensions::webview;
    if (!std::strcmp(id, CLAP_EXT_REMOTE_CONTROLS) ||
        !std::strcmp(id, CLAP_EXT_REMOTE_CONTROLS_COMPAT))
        return &Extensions::remoteControls;
    if (!std::strcmp(id, CLAP_EXT_PRESET_LOAD) || !std::strcmp(id, CLAP_EXT_PRESET_LOAD_COMPAT))
        return &Extensions::presetLoad;
    return nullptr;
}
} // namespace

const clap_plugin_t *createPlugin(const clap_host_t *host)
{
    auto *plugin = new (std::nothrow) SurgeWclap(host);
    return plugin ? &plugin->plugin : nullptr;
}
} // namespace Surge::Wclap
