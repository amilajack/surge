// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "SurgeSynthesizer.h"
#include <clap/clap.h>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace Surge::Wclap
{
// The parameters of the desktop CLAP (clap-juce-extensions over SurgeSynthProcessor),
// in its order and with its ids: eight macros ("macro_N"), then every engine
// parameter grouped by clump, each identified by its storage name. A CLAP id is
// the JUCE String::hashCode of that identifier, so automation and modulation saved
// with the desktop plug-in address the same parameters here. The surgext-bypass
// parameter is left out: CLAP hosts bypass plug-ins themselves.
struct ParamEntry
{
    clap_id id;
    int synthId; // engine parameter index, or -1 for a macro
    int macro;   // 0..7, or -1
    std::string module;
};

class ParamTable
{
  public:
    // The layout is identical for every engine; built once from the first one.
    static const ParamTable &get(const SurgeSynthesizer &synth);
    static uint32_t juceHash(const std::string &identifier);

    std::vector<ParamEntry> entries;
    const ParamEntry *find(clap_id id) const;
    const ParamEntry *forSynthId(int synthId) const;
    const ParamEntry *forMacro(int macro) const { return &entries[size_t(macro)]; }

  private:
    explicit ParamTable(const SurgeSynthesizer &synth);
    std::unordered_map<clap_id, size_t> byId;
    std::vector<int32_t> bySynthId;
};

// Per-instance parameter behaviour (values, names and text depend on the patch).
namespace ParamAccess
{
double value(SurgeSynthesizer &synth, const ParamEntry &entry);
void set(SurgeSynthesizer &synth, const ParamEntry &entry, double value);
bool info(SurgeSynthesizer &synth, const ParamEntry &entry, clap_param_info_t &info);
bool toText(SurgeSynthesizer &synth, const ParamEntry &entry, double value, char *text,
            uint32_t capacity);
bool fromText(SurgeSynthesizer &synth, const ParamEntry &entry, const char *text, double &value);
void modulate(SurgeSynthesizer &synth, const ParamEntry &entry,
              const clap_event_param_mod_t &event);
} // namespace ParamAccess
} // namespace Surge::Wclap
