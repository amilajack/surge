// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "SurgeSynthesizer.h"
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace Surge::Web
{
// The headless engine shared by the development C ABI (Engine.cpp) and the WCLAP
// plug-in (src/surge-wclap): a bare SurgeSynthesizer without JUCE, threads or audio
// devices. Every call requires exclusive ownership of the engine.
class EngineCore : public SurgeSynthesizer::PluginLayer
{
  public:
    // Changes the engine makes itself (MIDI learn, macro smoothing targets).
    struct Listener
    {
        virtual ~Listener() = default;
        virtual void engineParameterUpdated(int synthId, float normalized) = 0;
        virtual void engineMacroUpdated(int macro, float normalized) = 0;
    };

    EngineCore(double sampleRate, const SurgeStorage::SurgeStorageConfig &config);
    virtual ~EngineCore();

    std::unique_ptr<SurgeSynthesizer> synth;
    double sampleRate;
    Listener *listener{nullptr};

    // The desktop plug-in's getStateInformation, without an editor: the DAW
    // extra state of the engine plus the editor state last received.
    std::vector<uint8_t> saveState();
    // The desktop plug-in's setStateInformation, applied immediately. Held notes
    // are retriggered on the new patch. Returns false for data that is not a patch.
    bool loadState(const void *data, size_t size);
    // True when a raw state holds the patch this engine has, apart from the
    // editor's view, the dirty flag and the path the patch was loaded from: a
    // mirror of this engine (a WCLAP editor) made no edit the engine lacks.
    bool holdsState(const void *data, size_t size);
    // A complete .fxp file, as a factory patch load (name and category as given).
    bool loadPatchFile(const void *data, size_t size, const std::string &name,
                       const std::string &category);
    // Finish a pending Airwindows selection and prepared effect requests. The
    // offline engine has no control pump; at most three transitions, never a spin.
    void resolveAirwindowsSelection();

    void surgeParameterUpdated(const SurgeSynthesizer::ID &id, float value) override;
    void surgeMacroUpdated(long macro, float value) override;
};
} // namespace Surge::Web
