// SPDX-License-Identifier: GPL-3.0-or-later
#include "StateParts.h"
#include "SurgeSynthesizer.h"
#include "PatchFileHeaderStructs.h"
#include "dsp/modulators/FormulaModulationHelper.h"
#include "dsp/modulators/MSEGModulationHelper.h"
#include "binn/binn.h"
#include "sst/basic-blocks/mechanics/endian-ops.h"
#include "tinyxml/tinyxml.h"
#include <cstring>
#include <iomanip>
#include <mutex>
#include <sstream>

namespace Surge::Wclap::StateParts
{
namespace mech = sst::basic_blocks::mechanics;

namespace
{
std::string print(const TiXmlElement &element)
{
    TiXmlPrinter printer;
    printer.SetStreamPrinting();
    element.Accept(&printer);
    return printer.CStr();
}

// The one element of a part's XML, parsed into document.
TiXmlElement *parse(TiXmlDocument &document, const std::string &xml, const char *name)
{
    document.Parse(xml.c_str(), nullptr, TIXML_ENCODING_LEGACY);
    auto *element = document.FirstChildElement(name);
    return document.Error() ? nullptr : element;
}

template <typename T> void append(std::string &out, const T &value)
{
    out.append(reinterpret_cast<const char *>(&value), sizeof(T)); // wasm32: little-endian
}

template <typename T> bool take(const std::string &in, size_t &at, T &value)
{
    if (in.size() - at < sizeof(T))
        return false;
    std::memcpy(&value, in.data() + at, sizeof(T));
    at += sizeof(T);
    return true;
}

// ---- collection: what the engine holds --------------------------------------
Part meta(SurgePatch &patch)
{
    TiXmlElement element("meta");
    element.SetAttribute("name", patch.name);
    element.SetAttribute("category", patch.category);
    element.SetAttribute("comment", patch.comment);
    element.SetAttribute("author", patch.author);
    element.SetAttribute("license", patch.license);
    TiXmlElement tags("tags");
    for (const auto &tag : patch.tags)
    {
        TiXmlElement item("tag");
        item.SetAttribute("tag", tag.tag);
        tags.InsertEndChild(item);
    }
    element.InsertEndChild(tags);
    return {Meta, 0, 0, print(element)};
}

Part extraOsc(SurgePatch &patch, int scene, int osc)
{
    const auto &o = patch.scene[scene].osc[osc];
    TiXmlElement element("osc");
    element.SetAttribute("wavetable_display_name", o.wavetable_display_name);
    element.SetAttribute("wavetable_script",
                         Surge::Storage::base64_encode(
                             reinterpret_cast<const unsigned char *>(o.wavetable_script.c_str()),
                             o.wavetable_script.length()));
    element.SetAttribute("wavetable_script_nframes", o.wavetable_script_nframes);
    element.SetAttribute("wavetable_script_res_base", o.wavetable_script_res_base);
    const auto extra = o.extraConfig.read();
    element.SetAttribute("extra_n", extra.nData);
    for (int q = 0; q < extra.nData; ++q)
        element.SetDoubleAttribute("extra_data_" + std::to_string(q), extra.data[q]);
    return {ExtraOsc, uint8_t(scene), uint8_t(osc), print(element)};
}

Part macro(SurgePatch &patch, int index)
{
    TiXmlElement element("entry");
    element.SetAttribute("bipolar", patch.scene[0].modsources[ms_ctrl1 + index]->is_bipolar());
    element.SetAttribute("label", patch.CustomControllerLabel[index]);
    return {Macro, uint8_t(index), 0, print(element)};
}

Part modulatorNames(SurgePatch &patch, int scene, int lfo)
{
    TiXmlElement element("labels");
    for (int index = 0; index < max_lfo_indices; ++index)
        if (patch.LFOBankLabel[scene][lfo][index][0])
        {
            TiXmlElement label("label");
            label.SetAttribute("idx", index);
            label.SetAttribute("v", patch.LFOBankLabel[scene][lfo][index]);
            element.InsertEndChild(label);
        }
    return {ModulatorNames, uint8_t(scene), uint8_t(lfo), print(element)};
}

// The table as SurgePatch::save_patch stores it (16-bit frames), then its name in
// the wavetable list and file, then the snapshots as a binn object.
Part wavetable(SurgeStorage &storage, int scene, int osc)
{
    Part part{Wavetable, uint8_t(scene), uint8_t(osc), {}};
    ::Wavetable table;
    storage.copyOscillatorWavetable(scene, osc, table);
    uint32_t tableBytes = 0;
    if (table.everBuilt && table.size > 0 && table.n_tables > 0)
        tableBytes = uint32_t(sizeof(wt_header) + size_t(table.size) * table.n_tables * 2);
    append(part.data, tableBytes);
    if (tableBytes)
    {
        wt_header header{};
        header.n_samples = mech::endian_write_int32LE(uint32_t(table.size));
        header.n_tables = mech::endian_write_int16LE(uint16_t(table.n_tables));
        header.flags = mech::endian_write_int16LE(uint16_t(table.flags | wtf_int16));
        part.data.append(reinterpret_cast<const char *>(&header), sizeof(header));
        const auto at = part.data.size();
        part.data.resize(at + size_t(table.size) * table.n_tables * 2);
        auto *frames = reinterpret_cast<short *>(part.data.data() + at);
        for (unsigned j = 0; j < table.n_tables; ++j)
            mech::endian_copyblock16LE(&frames[size_t(j) * table.size],
                                       &table.TableI16WeakPointers[0][j][FIRoffsetI16], table.size);
    }
    append(part.data, int32_t(table.current_id));
    append(part.data, int32_t(table.frame_size_if_absent));
    append(part.data, uint32_t(table.current_filename.size()));
    part.data += table.current_filename;
    binn *map = binn_object();
    {
        std::lock_guard<std::mutex> guard(storage.wtSnapshotMutex);
        SurgePatch::writeOscSnapshotsToBinn(map, storage.getPatch().scene[scene].osc[osc]);
    }
    part.data.append(static_cast<const char *>(binn_ptr(map)), size_t(binn_size(map)));
    binn_free(map);
    return part;
}

Part tuning(SurgeStorage &storage)
{
    TiXmlElement element("tuning");
    element.SetAttribute("scale", storage.isStandardScale ? "" : storage.currentScale.rawText);
    element.SetAttribute("mapping",
                         storage.isStandardMapping ? "" : storage.currentMapping.rawText);
    element.SetAttribute("mappingName",
                         storage.isStandardMapping ? "" : storage.currentMapping.name);
    const auto &pt = storage.getPatch().patchTuning;
    element.SetAttribute("inPatch", pt.tuningStoredInPatch ? 1 : 0);
    element.SetAttribute("patchScale", pt.scaleContents);
    element.SetAttribute("patchMapping", pt.mappingContents);
    element.SetAttribute("patchMappingName", pt.mappingName);
    return {Tuning, 0, 0, print(element)};
}

Part fxData(SurgePatch &patch, int slot)
{
    binn *map = binn_object();
    for (const auto &[key, blob] : patch.fx[slot].user_data)
        if (blob)
            binn_object_set_blob(map, key.c_str(), const_cast<uint8_t *>(blob->data()),
                                 int(blob->size()));
    Part part{FxData, uint8_t(slot), 0,
              std::string(static_cast<const char *>(binn_ptr(map)), size_t(binn_size(map)))};
    binn_free(map);
    return part;
}

// ---- application: the matching parts of SurgePatch::load_xml -------------------
bool applyMeta(SurgePatch &patch, const std::string &xml)
{
    TiXmlDocument document;
    auto *element = parse(document, xml, "meta");
    if (!element)
        return false;
    const auto text = [&](const char *name) {
        const char *value = element->Attribute(name);
        return std::string(value ? value : "");
    };
    patch.name = text("name");
    patch.category = text("category");
    patch.comment = text("comment");
    patch.author = text("author");
    patch.license = text("license");
    patch.tags.clear();
    if (auto *tags = element->FirstChildElement("tags"))
        for (auto *tag = tags->FirstChildElement("tag"); tag; tag = tag->NextSiblingElement("tag"))
            if (const char *value = tag->Attribute("tag"))
                patch.tags.emplace_back(value);
    return true;
}

bool applyExtraOsc(SurgePatch &patch, int scene, int osc, const std::string &xml)
{
    TiXmlDocument document;
    auto *element = parse(document, xml, "osc");
    if (!element)
        return false;
    auto &o = patch.scene[scene].osc[osc];
    const char *name = element->Attribute("wavetable_display_name");
    o.wavetable_display_name = name ? name : "";
    const char *script = element->Attribute("wavetable_script");
    o.wavetable_script = script ? Surge::Storage::base64_decode(script) : "";
    int value;
    o.wavetable_script_nframes =
        element->QueryIntAttribute("wavetable_script_nframes", &value) == TIXML_SUCCESS ? value
                                                                                        : 10;
    o.wavetable_script_res_base =
        element->QueryIntAttribute("wavetable_script_res_base", &value) == TIXML_SUCCESS ? value
                                                                                         : 5;
    auto extra = o.extraConfig.edit();
    if (element->QueryIntAttribute("extra_n", &value) == TIXML_SUCCESS)
    {
        extra->nData =
            limit_range(value, 0, int(OscillatorStorage::ExtraConfigurationData::max_config));
        for (int q = 0; q < extra->nData; ++q)
        {
            double data;
            extra->data[q] = element->QueryDoubleAttribute("extra_data_" + std::to_string(q),
                                                           &data) == TIXML_SUCCESS
                                 ? float(data)
                                 : 0.f;
        }
    }
    o.wt.refresh_display = true;
    return true;
}

bool applyStepSequence(SurgePatch &patch, int scene, int lfo, const std::string &xml)
{
    TiXmlDocument document;
    auto *element = parse(document, xml, "sequence");
    if (!element)
        return false;
    auto &sequence = patch.stepsequences[scene][lfo];
    for (auto &step : sequence.steps)
        step = 0.f;
    sequence.loop_start = 0;
    sequence.loop_end = 15;
    sequence.shuffle = 0.f;
    patch.stepSeqFromXmlElement(&sequence, element);
    return true;
}

bool applyMseg(SurgePatch &patch, int scene, int lfo, const std::string &xml)
{
    TiXmlDocument document;
    auto *element = parse(document, xml, "mseg");
    if (!element)
        return false;
    // Snaps are part of what the editor shows and saves: mirror them exactly.
    patch.msegFromXMLElement(&patch.msegs[scene][lfo], element, true);
    return true;
}

bool applyFormula(SurgeStorage &storage, int scene, int lfo, const std::string &xml)
{
    TiXmlDocument document;
    auto *element = parse(document, xml, "formula");
    if (!element)
        return false;
    auto &patch = storage.getPatch();
    patch.formulaFromXMLElement(&patch.formulamods[scene][lfo], element);
#if SURGE_WEB
    // Compiled here; the engine adopts it at its next block, as the browser
    // editor's live formula edits.
    Surge::Formula::publishLiveEdits(&storage);
#endif
    return true;
}

bool applyExtraLfo(SurgePatch &patch, int scene, int lfo, const std::string &xml)
{
    TiXmlDocument document;
    auto *element = parse(document, xml, "lfo");
    int value;
    if (!element || element->QueryIntAttribute("extraAmplitude", &value) != TIXML_SUCCESS)
        return false;
    patch.scene[scene].lfo[lfo].lfoExtraAmplitude = LFOStorage::LFOExtraOutputAmplitude(value);
    return true;
}

bool applyMacro(SurgePatch &patch, int index, const std::string &xml)
{
    TiXmlDocument document;
    auto *element = parse(document, xml, "entry");
    if (!element)
        return false;
    int bipolar;
    if (element->QueryIntAttribute("bipolar", &bipolar) == TIXML_SUCCESS)
        patch.scene[0].modsources[ms_ctrl1 + index]->set_bipolar(bipolar);
    const char *label = element->Attribute("label");
    strxcpy(patch.CustomControllerLabel[index], label ? label : "", CUSTOM_CONTROLLER_LABEL_SIZE);
    return true;
}

bool applyModulatorNames(SurgePatch &patch, int scene, int lfo, const std::string &xml)
{
    TiXmlDocument document;
    auto *element = parse(document, xml, "labels");
    if (!element)
        return false;
    for (auto &label : patch.LFOBankLabel[scene][lfo])
        label[0] = 0;
    for (auto *label = element->FirstChildElement("label"); label;
         label = label->NextSiblingElement("label"))
    {
        int index;
        const char *value = label->Attribute("v");
        if (value && label->QueryIntAttribute("idx", &index) == TIXML_SUCCESS &&
            within_range(0, index, max_lfo_indices - 1))
            strxcpy(patch.LFOBankLabel[scene][lfo][index], value, CUSTOM_CONTROLLER_LABEL_SIZE);
    }
    return true;
}

bool applyWavetable(SurgeStorage &storage, int scene, int osc, const std::string &data)
{
    size_t at = 0;
    uint32_t tableBytes;
    if (!take(data, at, tableBytes) || data.size() - at < tableBytes)
        return false;
    ::Wavetable table;
    if (tableBytes)
    {
        wt_header header;
        if (tableBytes < sizeof(header))
            return false;
        std::memcpy(&header, data.data() + at, sizeof(header));
        const size_t samples = mech::endian_read_int32LE(header.n_samples);
        const size_t tables = mech::endian_read_int16LE(header.n_tables);
        if (samples * tables * 2 != tableBytes - sizeof(header))
            return false;
        std::vector<char> frames(data.begin() + at + sizeof(header),
                                 data.begin() + at + tableBytes);
        if (!table.BuildWT(frames.data(), header, false))
            return false;
        at += tableBytes;
    }
    int32_t currentId, frameSize;
    uint32_t nameSize;
    if (!take(data, at, currentId) || !take(data, at, frameSize) || !take(data, at, nameSize) ||
        data.size() - at < nameSize)
        return false;
    table.current_id = currentId;
    table.frame_size_if_absent = frameSize;
    table.current_filename = data.substr(at, nameSize);
    at += nameSize;
    if (tableBytes)
        storage.replaceOscillatorWavetable(scene, osc, table);
    // Snapshots: exactly the page's slots.
    auto &o = storage.getPatch().scene[scene].osc[osc];
    {
        std::lock_guard<std::mutex> guard(storage.wtSnapshotMutex);
        for (auto &snapshot : o.wtSnapshots)
            snapshot.reset();
        o.wtSnapshotsVersion++;
    }
    if (data.size() > at)
    {
        std::vector<char> raw(data.begin() + at, data.end());
        int size = int(raw.size());
        if (!binn_is_valid_ex(raw.data(), nullptr, nullptr, &size))
            return false;
        binn *map = binn_open_ex(raw.data(), size);
        if (!map)
            return false;
        SurgePatch::readOscSnapshotsFromBinn(map, o, &storage);
        binn_free(map);
    }
    return true;
}

bool applyTuning(SurgeStorage &storage, const std::string &xml)
{
    TiXmlDocument document;
    auto *element = parse(document, xml, "tuning");
    if (!element)
        return false;
    const auto text = [&](const char *name) {
        const char *value = element->Attribute(name);
        return std::string(value ? value : "");
    };
    try
    {
        if (const auto scale = text("scale"); !scale.empty())
            storage.retuneToScale(Tunings::parseSCLData(scale));
        else
            storage.retuneTo12TETScale();
        if (const auto mapping = text("mapping"); !mapping.empty())
        {
            auto keyboard = Tunings::parseKBMData(mapping);
            if (const auto name = text("mappingName"); name.size() > 1)
                keyboard.name = name;
            storage.remapToKeyboard(keyboard);
        }
        else
            storage.remapToConcertCKeyboard();
    }
    catch (const Tunings::TuningError &)
    {
        return false;
    }
    int inPatch = 0;
    element->QueryIntAttribute("inPatch", &inPatch);
    auto &pt = storage.getPatch().patchTuning;
    pt.tuningStoredInPatch = inPatch != 0;
    pt.scaleContents = text("patchScale");
    pt.mappingContents = text("patchMapping");
    pt.mappingName = text("patchMappingName");
    return true;
}

bool applyFxData(SurgeSynthesizer &synth, int slot, const std::string &data)
{
    std::vector<char> raw(data.begin(), data.end());
    int size = int(raw.size());
    if (raw.empty() || !binn_is_valid_ex(raw.data(), nullptr, nullptr, &size))
        return false;
    binn *map = binn_open_ex(raw.data(), size);
    if (!map)
        return false;
    decltype(FxStorage::user_data) blobs;
    binn_iter iterator;
    binn value;
    char key[256];
    binn_iter_init(&iterator, map, BINN_OBJECT);
    while (binn_object_next(&iterator, key, &value))
        if (value.type == BINN_BLOB)
        {
            const auto *bytes = static_cast<const uint8_t *>(value.ptr);
            blobs[key] = std::make_shared<std::vector<uint8_t>>(bytes, bytes + value.size);
        }
    binn_free(map);
    auto &fx = synth.storage.getPatch().fx[slot];
    if (fx.user_data == blobs)
        return true;
    fx.user_data = blobs;
    // As a desktop FX preset load: the slot's effect is rebuilt with its data at the
    // next block; voices are untouched.
    synth.fxsync[slot].user_data = std::move(blobs);
    synth.fx_reload[slot] = true;
    synth.load_fx_needed = true;
    return true;
}
} // namespace

std::vector<Part> collect(SurgeSynthesizer &synth)
{
    auto &storage = synth.storage;
    auto &patch = storage.getPatch();
    std::vector<Part> parts;
    parts.reserve(1 + n_scenes * (2 * n_oscs + 5 * n_lfos) + n_customcontrollers + 1 + n_fx_slots);
    parts.push_back(meta(patch));
    for (int scene = 0; scene < n_scenes; ++scene)
    {
        for (int osc = 0; osc < n_oscs; ++osc)
        {
            parts.push_back(extraOsc(patch, scene, osc));
            parts.push_back(wavetable(storage, scene, osc));
        }
        for (int lfo = 0; lfo < n_lfos; ++lfo)
        {
            TiXmlElement sequence("sequence");
            patch.stepSeqToXmlElement(&patch.stepsequences[scene][lfo], sequence,
                                      lfo < n_lfos_voice);
            parts.push_back({StepSequence, uint8_t(scene), uint8_t(lfo), print(sequence)});
            TiXmlElement mseg("mseg");
            patch.msegToXMLElement(&patch.msegs[scene][lfo], mseg);
            parts.push_back({Mseg, uint8_t(scene), uint8_t(lfo), print(mseg)});
            TiXmlElement formula("formula");
            patch.formulaToXMLElement(&patch.formulamods[scene][lfo], formula);
            parts.push_back({Formula, uint8_t(scene), uint8_t(lfo), print(formula)});
            TiXmlElement extra("lfo");
            extra.SetAttribute("extraAmplitude", int(patch.scene[scene].lfo[lfo].lfoExtraAmplitude));
            parts.push_back({ExtraLfo, uint8_t(scene), uint8_t(lfo), print(extra)});
            parts.push_back(modulatorNames(patch, scene, lfo));
        }
    }
    for (int index = 0; index < n_customcontrollers; ++index)
        parts.push_back(macro(patch, index));
    parts.push_back(tuning(storage));
    for (int slot = 0; slot < n_fx_slots; ++slot)
        parts.push_back(fxData(patch, slot));
    return parts;
}

void write(Protocol::Writer &frame, const Part &part)
{
    frame.put(uint8_t(part.kind)).put(part.a).put(part.b).put(uint8_t(0));
    frame.put(uint32_t(part.data.size())).append(part.data.data(), part.data.size());
}

bool read(Protocol::Reader &frame, Part &part)
{
    uint8_t kind, a, b, zero;
    uint32_t size;
    const uint8_t *data;
    if (!frame.get(kind) || !frame.get(a) || !frame.get(b) || !frame.get(zero) ||
        !frame.get(size) || !frame.getBytes(size, data))
        return false;
    part.kind = Kind(kind);
    part.a = a;
    part.b = b;
    part.data.assign(reinterpret_cast<const char *>(data), size);
    return true;
}

bool apply(SurgeSynthesizer &synth, const Part &part)
{
    auto &storage = synth.storage;
    auto &patch = storage.getPatch();
    const int a = part.a, b = part.b;
    const bool sceneOsc = a < n_scenes && b < n_oscs, sceneLfo = a < n_scenes && b < n_lfos;
    switch (part.kind)
    {
    case Meta:
        return applyMeta(patch, part.data);
    case ExtraOsc:
        return sceneOsc && applyExtraOsc(patch, a, b, part.data);
    case StepSequence:
        return sceneLfo && applyStepSequence(patch, a, b, part.data);
    case Mseg:
        return sceneLfo && applyMseg(patch, a, b, part.data);
    case Formula:
        return sceneLfo && applyFormula(storage, a, b, part.data);
    case ExtraLfo:
        return sceneLfo && applyExtraLfo(patch, a, b, part.data);
    case Macro:
        return a < n_customcontrollers && applyMacro(patch, a, part.data);
    case ModulatorNames:
        return sceneLfo && applyModulatorNames(patch, a, b, part.data);
    case Wavetable:
        return sceneOsc && applyWavetable(storage, a, b, part.data);
    case Tuning:
        return applyTuning(storage, part.data);
    case FxData:
        return a < n_fx_slots && applyFxData(synth, a, part.data);
    }
    return false;
}

bool soundOf(const uint8_t *data, size_t size, std::string &xml, std::string &rest)
{
    sst::io::patch_header header{};
    if (!data || size < sizeof(header) || std::memcmp(data, "sub3", 4) != 0)
        return false;
    std::memcpy(&header, data, sizeof(header));
    const size_t length = mech::endian_read_int32LE(header.xmlsize);
    if (length > size - sizeof(header))
        return false;
    const std::string text(reinterpret_cast<const char *>(data) + sizeof(header), length);
    rest.assign(reinterpret_cast<const char *>(data) + sizeof(header) + length,
                size - sizeof(header) - length);
    TiXmlDocument document;
    document.Parse(text.c_str(), nullptr, TIXML_ENCODING_LEGACY);
    auto *patch = document.FirstChildElement("patch");
    if (document.Error() || !patch)
        return false;
    if (auto *extra = patch->FirstChildElement("dawExtraState"))
        for (const char *name : {"editor", "instanceZoomFactor", "isDirty", "lastLoadedPath"})
            while (auto *child = extra->FirstChildElement(name))
                extra->RemoveChild(child);
    TiXmlPrinter printer;
    printer.SetStreamPrinting();
    document.Accept(&printer);
    xml = printer.CStr();
    return true;
}

uint64_t digest(const uint8_t *state, size_t size)
{
    std::string xml, rest;
    if (!soundOf(state, size, xml, rest))
        return 0;
    uint64_t hash = 14695981039346656037ull;
    for (const auto *text : {&xml, &rest})
        for (const unsigned char c : *text)
            hash = (hash ^ c) * 1099511628211ull;
    return hash ? hash : 1;
}
} // namespace Surge::Wclap::StateParts
