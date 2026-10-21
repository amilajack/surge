// SPDX-License-Identifier: GPL-3.0-or-later
#include "Params.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>

namespace Surge::Wclap
{
namespace
{
// SurgeSynthProcessor::paramClumpName, the desktop parameter groups.
const char *clumpName(unsigned clump)
{
    static const char *names[] = {
        "",          "Macros",      "Global & FX", "A Common", "A Oscillators", "A Mixer",
        "A Filters", "A Envelopes", "A LFOs",      "B Common", "B Oscillators", "B Mixer",
        "B Filters", "B Envelopes", "B LFOs"};
    return clump < sizeof(names) / sizeof(names[0]) ? names[clump] : "";
}

void copy(char *target, uint32_t capacity, const std::string &text)
{
    if (!capacity)
        return;
    std::strncpy(target, text.c_str(), capacity - 1);
    target[capacity - 1] = 0;
}
} // namespace

uint32_t ParamTable::juceHash(const std::string &identifier)
{
    // juce::String::hashCode: 31 * h + code point, over UTF-32 code points.
    uint32_t result = 0;
    for (size_t i = 0; i < identifier.size();)
    {
        const auto c = static_cast<unsigned char>(identifier[i]);
        uint32_t code = c;
        size_t length = 1;
        if (c >= 0xf0)
            code = c & 0x07, length = 4;
        else if (c >= 0xe0)
            code = c & 0x0f, length = 3;
        else if (c >= 0xc0)
            code = c & 0x1f, length = 2;
        for (size_t k = 1; k < length && i + k < identifier.size(); ++k)
            code = (code << 6) | (static_cast<unsigned char>(identifier[i + k]) & 0x3f);
        result = 31u * result + code;
        i += length;
    }
    return result;
}

ParamTable::ParamTable(const SurgeSynthesizer &synth)
{
    for (int m = 0; m < n_customcontrollers; ++m)
        entries.push_back({juceHash("macro_" + std::to_string(m)), -1, m, "Macros"});
    std::map<unsigned, std::vector<int>> byClump;
    const auto &params = synth.storage.getPatch().param_ptr;
    for (const auto *p : params)
    {
        if (!p)
            continue;
        parametermeta meta;
        synth.getParameterMeta(synth.idForParameter(p), meta);
        byClump[meta.clump].push_back(p->id);
    }
    for (const auto &[clump, ids] : byClump)
        for (const int id : ids)
            entries.push_back(
                {juceHash(params[size_t(id)]->get_storage_name()), id, -1, clumpName(clump)});
    bySynthId.assign(params.size(), -1);
    for (size_t i = 0; i < entries.size(); ++i)
    {
        byId.emplace(entries[i].id, i);
        if (entries[i].synthId >= 0)
            bySynthId[size_t(entries[i].synthId)] = int32_t(i);
    }
}

const ParamTable &ParamTable::get(const SurgeSynthesizer &synth)
{
    static const std::unique_ptr<ParamTable> table(new ParamTable(synth));
    return *table;
}

const ParamEntry *ParamTable::find(clap_id id) const
{
    const auto found = byId.find(id);
    return found == byId.end() ? nullptr : &entries[found->second];
}

const ParamEntry *ParamTable::forSynthId(int synthId) const
{
    if (synthId < 0 || size_t(synthId) >= bySynthId.size() || bySynthId[size_t(synthId)] < 0)
        return nullptr;
    return &entries[size_t(bySynthId[size_t(synthId)])];
}

namespace ParamAccess
{
namespace
{
SurgeSynthesizer::ID idOf(const SurgeSynthesizer &synth, const ParamEntry &entry)
{
    SurgeSynthesizer::ID id;
    synth.fromSynthSideId(entry.synthId, id);
    return id;
}
} // namespace

double value(SurgeSynthesizer &synth, const ParamEntry &entry)
{
    // A macro reports its target, so a value set is read back immediately
    // (SurgeMacroToJuceParamAdapter::getValue).
    return entry.macro >= 0 ? synth.getMacroParameterTarget01(entry.macro)
                            : synth.getParameter01(idOf(synth, entry));
}

void set(SurgeSynthesizer &synth, const ParamEntry &entry, double value)
{
    const auto normalized = float(std::clamp(value, 0., 1.));
    if (entry.macro >= 0)
    {
        if (normalized != synth.getMacroParameterTarget01(entry.macro))
            synth.setMacroParameter01(entry.macro, normalized);
        return;
    }
    if (normalized != synth.getParameter01(idOf(synth, entry)))
        synth.setParameter01(idOf(synth, entry), normalized, true);
}

bool info(SurgeSynthesizer &synth, const ParamEntry &entry, clap_param_info_t &result)
{
    std::memset(&result, 0, sizeof(result));
    result.id = entry.id;
    result.cookie = const_cast<ParamEntry *>(&entry);
    result.min_value = 0;
    result.max_value = 1;
    result.flags = CLAP_PARAM_IS_AUTOMATABLE | CLAP_PARAM_IS_MODULATABLE;
    copy(result.module, sizeof(result.module), entry.module);
    if (entry.macro >= 0)
    {
        copy(result.name, sizeof(result.name),
             "M" + std::to_string(entry.macro + 1) + ": " +
                 synth.storage.getPatch().CustomControllerLabel[entry.macro]);
        result.default_value = 0;
        return true;
    }
    auto *p = synth.storage.getPatch().param_ptr[size_t(entry.synthId)];
    char name[256]{};
    if (p->ctrlgroup == cg_FX)
        synth.getParameterNameExtendedByFXGroup(idOf(synth, entry), name);
    else
        synth.getParameterName(idOf(synth, entry), name);
    copy(result.name, sizeof(result.name), name);
    result.default_value = p->get_default_value_f01();
    if (!p->can_be_nondestructively_modulated())
        result.flags &= ~CLAP_PARAM_IS_MODULATABLE;
    else if (p->per_voice_processing)
        result.flags |= CLAP_PARAM_IS_MODULATABLE_PER_CHANNEL | CLAP_PARAM_IS_MODULATABLE_PER_KEY |
                        CLAP_PARAM_IS_MODULATABLE_PER_NOTE_ID | CLAP_PARAM_IS_MODULATABLE_PER_PORT;
    return true;
}

bool toText(SurgeSynthesizer &synth, const ParamEntry &entry, double value, char *text,
            uint32_t capacity)
{
    if (!text || !capacity)
        return false;
    if (entry.macro >= 0)
    {
        char buffer[64];
        std::snprintf(buffer, sizeof(buffer), "%.2f %%", std::clamp(value, 0., 1.) * 100.);
        copy(text, capacity, buffer);
        return true;
    }
    auto *p = synth.storage.getPatch().param_ptr[size_t(entry.synthId)];
    copy(text, capacity, p->get_display(true, float(std::clamp(value, 0., 1.))));
    return true;
}

bool fromText(SurgeSynthesizer &synth, const ParamEntry &entry, const char *text, double &value)
{
    if (!text)
        return false;
    if (entry.macro >= 0)
    {
        char *end = nullptr;
        const double parsed = std::strtod(text, &end);
        if (end == text)
            return false;
        // "50 %" is half; a bare number in 0..1 is the normalized value itself.
        const bool percent = std::strchr(end, '%') != nullptr || parsed > 1.;
        value = std::clamp(percent ? parsed / 100. : parsed, 0., 1.);
        return true;
    }
    auto *p = synth.storage.getPatch().param_ptr[size_t(entry.synthId)];
    pdata onto;
    std::string error;
    if (!p->set_value_from_string_onto(text, onto, error))
        return false;
    if (p->valtype == vt_float)
        value = p->value_to_normalized(onto.f);
    else if (p->valtype == vt_int)
        value = p->value_to_normalized(float(onto.i));
    else
        value = p->value_to_normalized(float(onto.b));
    value = std::clamp(value, 0., 1.);
    return true;
}

void modulate(SurgeSynthesizer &synth, const ParamEntry &entry, const clap_event_param_mod_t &event)
{
    if (entry.macro >= 0)
    {
        synth.applyMacroMonophonicModulation(entry.macro, float(event.amount));
        return;
    }
    auto *p = synth.storage.getPatch().param_ptr[size_t(entry.synthId)];
    if (!p->can_be_nondestructively_modulated())
        return;
    const bool monophonic =
        (event.note_id == -1 && event.channel == -1 && event.key == -1) || !p->per_voice_processing;
    if (monophonic)
        synth.applyParameterMonophonicModulation(p, float(event.amount));
    else
        synth.applyParameterPolyphonicModulation(p, event.note_id, event.key, event.channel,
                                                 float(event.amount));
}
} // namespace ParamAccess
} // namespace Surge::Wclap
