// SPDX-License-Identifier: GPL-3.0-or-later
#include "EngineCore.h"
#include "PatchFileHeaderStructs.h"
#include "PatchFileValidation.h"
#include "dsp/effects/airwindows/AirWindowsEffect.h"
#include "sst/basic-blocks/mechanics/endian-ops.h"
#include <cstring>
#include <stdexcept>

namespace Surge::Web
{
EngineCore::EngineCore(double sr, const SurgeStorage::SurgeStorageConfig &config) : sampleRate(sr)
{
    synth = std::make_unique<SurgeSynthesizer>(this, config);
    synth->setSamplerate(sr);
    synth->time_data.tempo = 120;
    synth->time_data.ppqPos = 0;
    synth->processAudioThreadOpsWhenAudioEngineUnavailable(true);
}

EngineCore::~EngineCore() = default;

void EngineCore::surgeParameterUpdated(const SurgeSynthesizer::ID &id, float value)
{
    if (listener)
        listener->engineParameterUpdated(id.getSynthSideId(), value);
}

void EngineCore::surgeMacroUpdated(long macro, float value)
{
    if (listener)
        listener->engineMacroUpdated(int(macro), value);
}

std::vector<uint8_t> EngineCore::saveState()
{
    synth->populateDawExtraState();
    void *data = nullptr; // owned by the patch
    const auto size = synth->saveRaw(&data);
    const auto *bytes = static_cast<const uint8_t *>(data);
    return {bytes, bytes + size};
}

bool EngineCore::loadState(const void *data, size_t size)
{
    if (!data || !size || size > size_t(64) << 20)
        return false;
    std::vector<char> bytes(static_cast<const char *>(data),
                            static_cast<const char *>(data) + size);
    std::string error;
    if (!Surge::PatchStorage::validatePatchData(bytes, error))
        return false;
    synth->enqueuePatchForLoad(bytes.data(), int(bytes.size()));
    synth->processAudioThreadOpsWhenAudioEngineUnavailable(true);
    resolveAirwindowsSelection();
    return true;
}

bool EngineCore::loadPatchFile(const void *data, size_t size, const std::string &name,
                               const std::string &category)
{
    namespace mech = sst::basic_blocks::mechanics;
    sst::io::fxChunkSetCustom header{};
    if (!data || size < sizeof(header))
        return false;
    std::memcpy(&header, data, sizeof(header));
    if (mech::endian_read_int32BE(header.chunkMagic) != 'CcnK' ||
        mech::endian_read_int32BE(header.fxMagic) != 'FPCh' ||
        mech::endian_read_int32BE(header.fxID) != 'cjs3')
        return false;
    const auto chunk = mech::endian_read_int32BE(header.chunkSize);
    if (chunk <= 0 || size_t(chunk) > size - sizeof(header))
        return false;
    const auto *bytes = static_cast<const char *>(data) + sizeof(header);
    std::vector<char> patch(bytes, bytes + chunk);
    std::string error;
    if (!Surge::PatchStorage::validatePatchData(patch, error))
        return false;
    if (!synth->loadPatchChunk(patch, -1, category, name.c_str()))
        return false;
    synth->processAudioThreadOpsWhenAudioEngineUnavailable(true);
    resolveAirwindowsSelection();
    return true;
}

void EngineCore::resolveAirwindowsSelection()
{
#if SURGE_WEB
    const auto failures = synth->browserEffectPreparationFailures.load(std::memory_order_acquire);
    // At most three transitions: reclaim a superseded request, prepare the
    // current request, then adopt and reclaim it. Never spin on a worker.
    for (int pass = 0; pass < 3; ++pass)
    {
        synth->processBrowserAirwindowsSelections();
        synth->prepareBrowserEffects();
    }
    if (synth->browserEffectPreparationFailures.load(std::memory_order_acquire) != failures)
        throw std::runtime_error("Unable to prepare the Airwindows selection");
    for (const auto &wanted : synth->browserAirwindowsWanted)
        if (wanted.load(std::memory_order_acquire) >= 0)
            throw std::runtime_error("Airwindows selection is still pending");
#else
    for (int slot = 0; slot < n_fx_slots; ++slot)
        if (auto *aw = dynamic_cast<AirWindowsEffect *>(synth->fx[slot].get()))
        {
            auto &selector = synth->storage.getPatch().fx[slot].p[0];
            if (aw->lastSelected != selector.val.i)
                aw->setupSubFX(selector.val.i, selector.user_data == nullptr);
        }
#endif
}
} // namespace Surge::Web
