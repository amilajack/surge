// SPDX-License-Identifier: GPL-3.0-or-later
// Web Audio Module parameters and state (wam/index.js). Main thread unless noted.
#include "SurgeSynthProcessor.h"
#include "PatchFileHeaderStructs.h"
#include "PatchFileValidation.h"
#include <emscripten.h>
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <string_view>
#include <vector>

namespace
{
SurgeSynthProcessor *processor{};
// Every Surge parameter and macro the desktop plugin exposes to hosts, except
// bypass. Built once before audio starts, then only read (also by the callback).
std::vector<juce::AudioProcessorParameter *> parameters;
std::vector<std::pair<std::u16string, int>> parameterIds; // sorted by id
// Parameters the browser changes only from the control thread, as the editor does:
// an effect type change constructs the new effect off the audio callback.
std::vector<char> controlThreadOnly;
std::string parameterInfo;
std::vector<uint8_t> stateOut, stateIn;
std::vector<std::pair<uint32_t, std::string>> stateFiles; // queued state .fxp files

std::u16string utf16(const juce::String &text)
{
    std::u16string result;
    for (auto character : text)
    {
        const auto code = uint32_t(character);
        if (code >= 0x10000)
        {
            result.push_back(char16_t(0xd800 + ((code - 0x10000) >> 10)));
            result.push_back(char16_t(0xdc00 + ((code - 0x10000) & 0x3ff)));
        }
        else
            result.push_back(char16_t(code));
    }
    return result;
}
void buildParameters()
{
    juce::Array<juce::var> info;
    for (auto *parameter : processor->getParameters())
    {
        auto *withId = dynamic_cast<juce::AudioProcessorParameterWithID *>(parameter);
        if (!withId || parameter == processor->bypassParameter)
            continue;
        const int index = int(parameters.size());
        parameters.push_back(parameter);
        parameterIds.emplace_back(utf16(withId->paramID), index);
        // JUCE's getDefaultValue is a placeholder for Surge parameters; use the
        // parameter's own default. Macros start at zero.
        float defaultValue = 0.f;
        bool control = false;
        if (auto *surgeParameter = dynamic_cast<SurgeParamToJuceParamAdapter *>(parameter))
        {
            defaultValue = surgeParameter->p->get_default_value_f01();
            control = surgeParameter->p->ctrltype == ct_fxtype;
        }
        controlThreadOnly.push_back(control);
        auto *entry = new juce::DynamicObject();
        entry->setProperty("id", withId->paramID);
        entry->setProperty("label", parameter->getName(128));
        entry->setProperty("defaultValue", defaultValue);
        if (control)
            entry->setProperty("controlThread", true);
        info.add(juce::var(entry));
    }
    std::sort(parameterIds.begin(), parameterIds.end());
    parameterInfo = juce::JSON::toString(juce::var(info), true).toStdString();
}
// A raw Surge patch (getStateInformation) or plain patch XML. The loader itself
// tolerates damaged contents; this only rejects data that is not a patch at all.
bool plausiblePatch(const uint8_t *data, size_t size)
{
    if (!size || size > (size_t(64) << 20))
        return false;
    if (size >= sizeof(sst::io::patch_header) && !std::memcmp(data, "sub3", 4))
    {
        uint32_t xmlSize;
        std::memcpy(&xmlSize, data + 4, sizeof(xmlSize)); // little-endian on wasm32
        return xmlSize > 0 && xmlSize <= size - sizeof(sst::io::patch_header);
    }
    size_t start = 0;
    while (start < size && std::isspace(data[start]))
        ++start;
    return start < size && data[start] == '<';
}
} // namespace

void surge_attach_wam(SurgeSynthProcessor *p) { processor = p; }

std::vector<juce::AudioProcessorParameter *> &surge_wam_parameter_list()
{
    if (parameters.empty() && processor)
        buildParameters();
    return parameters;
}

bool surge_wam_parameter_control_thread(int index) { return controlThreadOnly[size_t(index)] != 0; }

// Main thread: a control-thread parameter, applied as the editor applies it.
bool surge_wam_apply_control_parameter(int index, float value)
{
    if (processor->surge->halt_engine.load(std::memory_order_acquire))
        return false;
    parameters[index]->setValue(value);
    return true;
}

// Applies a value now, when no callback is rendering (a suspended host context).
bool surge_wam_apply_parameter_now(int index, float value)
{
    auto &synth = *processor->surge;
    if (synth.halt_engine.load(std::memory_order_acquire) || !synth.tryAcquireBrowserEngine(2))
        return false;
    parameters[index]->setValue(value);
    synth.releaseBrowserEngine();
    return true;
}

// JSON array of {id, label, defaultValue}; values are normalized 0..1.
extern "C" EMSCRIPTEN_KEEPALIVE const char *surge_wam_parameter_info()
{
    surge_wam_parameter_list();
    return parameterInfo.c_str();
}
extern "C" EMSCRIPTEN_KEEPALIVE int surge_wam_parameter_count()
{
    return int(surge_wam_parameter_list().size());
}
// Every current normalized value (surge_wam_parameter_count floats), valid until
// the next call.
extern "C" EMSCRIPTEN_KEEPALIVE const float *surge_wam_parameter_values()
{
    static std::vector<float> values;
    auto &list = surge_wam_parameter_list();
    values.resize(list.size());
    for (size_t i = 0; i < list.size(); ++i)
        values[i] = list[i]->getValue();
    return values.data();
}
extern "C" EMSCRIPTEN_KEEPALIVE const char *surge_wam_parameter_text(int index, double value)
{
    static std::string text;
    auto &list = surge_wam_parameter_list();
    text = index >= 0 && index < int(list.size())
               ? list[index]->getText(float(std::clamp(value, 0., 1.)), 128).toStdString()
               : std::string();
    return text.c_str();
}
// Audio worklet thread too: a binary search over the fixed table, no allocation.
extern "C" EMSCRIPTEN_KEEPALIVE int surge_wam_parameter_index(const char16_t *id, int length)
{
    if (!id || length < 0)
        return -1;
    const std::u16string_view key(id, size_t(length));
    auto found = std::lower_bound(parameterIds.begin(), parameterIds.end(), key,
                                  [](const auto &entry, std::u16string_view value) {
                                      return std::u16string_view(entry.first) < value;
                                  });
    return found != parameterIds.end() && std::u16string_view(found->first) == key ? found->second
                                                                                   : -1;
}

// The current patch as raw Surge state (the desktop plugin's getStateInformation).
// Returns its size, or -1 while a loader owns or is about to replace the patch;
// the caller retries on a later turn. Data stays valid until the next call.
extern "C" EMSCRIPTEN_KEEPALIVE int surge_wam_get_state()
{
    auto &synth = *processor->surge;
    std::unique_lock<std::mutex> lock(synth.patchLoadSpawnMutex, std::try_to_lock);
    if (!lock.owns_lock() || synth.halt_engine.load(std::memory_order_acquire) ||
        synth.patchLoadThread || synth.browserPatchLoadRequested.load() ||
        synth.browserPatchLoadPending.load() || synth.rawLoadEnqueued.load() ||
        synth.browserRawLoadCompleted.load(std::memory_order_acquire) !=
            synth.browserRawLoadSerial.load(std::memory_order_acquire))
        return -1;
    juce::MemoryBlock block;
    processor->getStateInformation(block);
    stateOut.assign(static_cast<const uint8_t *>(block.getData()),
                    static_cast<const uint8_t *>(block.getData()) + block.getSize());
    return int(stateOut.size());
}
extern "C" EMSCRIPTEN_KEEPALIVE const uint8_t *surge_wam_state_data() { return stateOut.data(); }
// A buffer for the caller to fill before surge_wam_set_state.
extern "C" EMSCRIPTEN_KEEPALIVE uint8_t *surge_wam_state_buffer(int size)
{
    if (size <= 0 || size > (64 << 20))
        return nullptr;
    stateIn.resize(size_t(size));
    return stateIn.data();
}
// Queues the buffer as the next patch. It is written as a Surge .fxp and loaded like
// a dropped patch file, so the browser's patch loader thread parses it while the
// audio callback fades, never the callback itself. Non-preset loading keeps the
// streamed name, category and settings, and the loader then applies the streamed
// DAW extra state as the desktop plugin's setStateInformation does.
// Returns a ticket that surge_wam_state_loaded reaches once this load (or a later
// one that replaced it) has completed, 0 if the data is not a Surge patch, or -1
// while a patch load holds the loader (retry on a later turn).
extern "C" EMSCRIPTEN_KEEPALIVE int surge_wam_set_state()
{
    if (!plausiblePatch(stateIn.data(), stateIn.size()))
        return 0;
    auto &synth = *processor->surge;
    std::unique_lock<std::mutex> lock(synth.patchLoadSpawnMutex, std::try_to_lock);
    if (!lock.owns_lock())
        return -1;
    const auto serial = synth.browserRawLoadSerial.fetch_add(1, std::memory_order_acq_rel) + 1;
    const auto path = "/tmp/surge-wam-state-" + std::to_string(serial) + ".fxp";
    {
        auto be32 = [](uint32_t value) {
            return uint32_t((value >> 24) | ((value >> 8) & 0xff00) | ((value << 8) & 0xff0000) |
                            (value << 24));
        };
        sst::io::fxChunkSetCustom header{};
        header.chunkMagic = int(be32('CcnK'));
        header.fxMagic = int(be32('FPCh'));
        header.fxID = int(be32('cjs3'));
        header.numPrograms = int(be32(1));
        header.version = int(be32(1));
        header.fxVersion = int(be32(1));
        header.chunkSize = int(be32(uint32_t(stateIn.size())));
        std::ofstream file(path, std::ios::binary);
        file.write(reinterpret_cast<const char *>(&header), sizeof(header));
        file.write(reinterpret_cast<const char *>(stateIn.data()), std::streamsize(stateIn.size()));
        if (!file)
        {
            synth.completeBrowserStateLoad(serial);
            return 0;
        }
    }
    // The loader validates the same way; reject here so a bad state never halts audio.
    std::vector<char> data;
    std::string error;
    if (!Surge::PatchStorage::readValidatedPatch(fs::path(path), data, error))
    {
        std::remove(path.c_str());
        synth.completeBrowserStateLoad(serial);
        return 0;
    }
    stateFiles.emplace_back(serial, path);
    // A newer state or file supersedes a pending catalog selection.
    synth.patchid_queue = -1;
    std::strncpy(synth.patchid_file, path.c_str(), FILENAME_MAX - 1);
    synth.patchid_file[FILENAME_MAX - 1] = 0;
    synth.patchid_file_isPreset = false;
    synth.browserStateFileSerial = serial;
    synth.has_patchid_file = true;
    lock.unlock();
    synth.processAudioThreadOpsWhenAudioEngineUnavailable();
    return int(serial);
}
extern "C" EMSCRIPTEN_KEEPALIVE unsigned surge_wam_state_loaded()
{
    const auto completed =
        processor->surge->browserRawLoadCompleted.load(std::memory_order_acquire);
    // The loader has finished reading every state file up to `completed`.
    for (auto file = stateFiles.begin(); file != stateFiles.end();)
        if (file->first <= completed)
        {
            std::remove(file->second.c_str());
            file = stateFiles.erase(file);
        }
        else
            ++file;
    return completed;
}
