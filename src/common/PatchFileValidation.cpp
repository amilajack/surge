// SPDX-License-Identifier: GPL-3.0-or-later
#include "PatchFileValidation.h"
#include "PatchFileHeaderStructs.h"
#include "SurgeStorage.h"
#include "sst/basic-blocks/mechanics/endian-ops.h"
#include "tinyxml/tinyxml.h"
#include "zstd.h"
#include "binn/binn.h"
#include <algorithm>
#include <cctype>
#include <cstring>
#include <fstream>
#include <iterator>
#include <limits>

namespace Surge::PatchStorage
{
namespace
{
namespace mech = sst::basic_blocks::mechanics;
bool validateRaw(const std::vector<char> &data, std::string &error)
{
    const auto reject = [&](const char *message) { error = message; return false; };
    if (data.size() < 4) return reject("Truncated patch data");
    std::size_t xmlOffset = 0, xmlSize = data.size(), tail = data.size();
    sst::io::patch_header header{};
    const bool binary = std::memcmp(data.data(), "sub3", 4) == 0;
    if (binary)
    {
        if (data.size() < sizeof(header)) return reject("Truncated Surge patch header");
        std::memcpy(&header, data.data(), sizeof(header));
        xmlOffset = sizeof(header);
        xmlSize = mech::endian_read_int32LE(header.xmlsize);
        if (xmlSize > data.size() - xmlOffset) return reject("Truncated patch XML");
        tail = xmlOffset + xmlSize;
        for (int scene = 0; scene < n_scenes; ++scene)
            for (int osc = 0; osc < n_oscs; ++osc)
            {
                const std::size_t blockSize = mech::endian_read_int32LE(header.wtsize[scene][osc]);
                if (!blockSize) continue;
                if (blockSize < sizeof(wt_header) || blockSize > data.size() - tail)
                    return reject("Truncated embedded wavetable");
                wt_header wt{};
                std::memcpy(&wt, data.data() + tail, sizeof(wt));
                const auto samples = mech::endian_read_int32LE(wt.n_samples);
                const auto frames = mech::endian_read_int16LE(wt.n_tables);
                const auto flags = mech::endian_read_int16LE(wt.flags);
                if (samples <= 0 || samples > max_wtable_size || frames > max_subtables)
                    return reject("Invalid embedded wavetable dimensions");
                const std::size_t width = flags & wtf_int16 ? sizeof(short) : sizeof(float);
                const std::size_t needed = std::size_t(samples) * frames * width;
                if (needed > blockSize - sizeof(wt))
                    return reject("Embedded wavetable samples exceed its block");
                tail += blockSize;
            }
    }
    if (!xmlSize || xmlSize >= (1u << 22)) return reject("Invalid patch XML length");
    const std::string xml(data.data() + xmlOffset, xmlSize);
    TiXmlDocument doc;
    doc.Parse(xml.c_str(), nullptr, TIXML_ENCODING_LEGACY);
    const auto *patch = doc.FirstChildElement("patch");
    if (doc.Error() || !patch || !patch->FirstChildElement("parameters"))
        return reject("Invalid patch XML or missing parameters");
    // Validate embedded tuning before loadRaw or a recall preference can alter
    // the current patch/scale/mapping. Use the same parser and combined tuning
    // construction as the loader, including its defaults for empty fields.
    if (const auto *tuning = patch->FirstChildElement("patchTuning"))
    {
        try
        {
            auto scale = Tunings::evenTemperament12NoteScale();
            auto mapping = Tunings::KeyboardMapping();
            if (const auto *encoded = tuning->Attribute("v"))
            {
                const auto contents = Surge::Storage::base64_decode(encoded);
                if (*encoded && contents.empty()) return reject("Invalid embedded tuning encoding");
                if (!contents.empty()) scale = Tunings::parseSCLData(contents);
            }
            if (const auto *encoded = tuning->Attribute("m"))
            {
                const auto contents = Surge::Storage::base64_decode(encoded);
                if (*encoded && contents.empty()) return reject("Invalid embedded tuning encoding");
                if (!contents.empty()) mapping = Tunings::parseKBMData(contents);
            }
            const Tunings::Tuning validated(scale, mapping);
        }
        catch (const Tunings::TuningError &exception)
        {
            error = std::string("Invalid embedded tuning: ") + exception.what();
            return false;
        }
    }
    if (!binary) return true; // Older patches store XML directly inside the FXP.
    int revision = 0, claimed = 0;
    patch->QueryIntAttribute("revision", &revision);
    if (const auto *serialization = patch->FirstChildElement("serialization"))
        serialization->QueryIntAttribute("absSize", &claimed);
    if (claimed < 0 || std::size_t(claimed) > data.size() - tail)
        return reject("Truncated patch extension data");
    const std::size_t extensionSize = revision > 28 ? std::size_t(claimed) : data.size() - tail;
    if (!extensionSize) return true;
    const auto *extension = data.data() + tail;
    const auto size = ZSTD_getFrameContentSize(extension, extensionSize);
    if (size == ZSTD_CONTENTSIZE_ERROR || size == ZSTD_CONTENTSIZE_UNKNOWN ||
        size > maxArbitraryBlockStorageSize || size > std::numeric_limits<int>::max())
        return reject("Invalid compressed patch extension");
    std::vector<unsigned char> unpacked(size);
    const auto actual = ZSTD_decompress(unpacked.data(), unpacked.size(), extension, extensionSize);
    if (ZSTD_isError(actual) || actual != size || size < sizeof(binn_struct))
        return reject("Corrupt compressed patch extension");
    int boundedSize = static_cast<int>(size);
    if (!binn_is_valid_ex(unpacked.data(), nullptr, nullptr, &boundedSize))
        return reject("Invalid patch extension container");
    return true;
}
}

bool readValidatedPatch(const fs::path &path, std::vector<char> &data, std::string &error)
{
    data.clear();
    error.clear();
    try
    {
        std::ifstream file(path, std::ios::binary | std::ios::ate);
        if (!file) { error = "Unable to open patch file"; return false; }
        const auto length = file.tellg();
        sst::io::fxChunkSetCustom header{};
        if (length < std::streamoff(sizeof(header))) { error = "Truncated FXP header"; return false; }
        file.seekg(0);
        if (!file.read(reinterpret_cast<char *>(&header), sizeof(header)))
        { error = "Unable to read FXP header"; return false; }
        if (mech::endian_read_int32BE(header.chunkMagic) != 'CcnK' ||
            mech::endian_read_int32BE(header.fxMagic) != 'FPCh' ||
            mech::endian_read_int32BE(header.fxID) != 'cjs3')
        { error = "This file is not a Surge FXP patch"; return false; }
        const auto size = mech::endian_read_int32BE(header.chunkSize);
        if (size <= 0 || size > std::numeric_limits<int>::max() || std::uint64_t(size) > std::uint64_t(length) - sizeof(header))
        { error = "Invalid FXP chunk length"; return false; }
        data.resize(size);
        if (!file.read(data.data(), data.size())) { error = "Truncated FXP data"; return false; }
        if (!validateRaw(data, error)) { data.clear(); return false; }
        return true;
    }
    catch (const std::exception &exception)
    {
        data.clear();
        error = exception.what();
        return false;
    }
}

bool readPatchFile(const fs::path &path, std::vector<char> &data, std::string &error)
{
    data.clear();
    error.clear();
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file) { error = "Unable to open patch file"; return false; }
    const auto length = file.tellg();
    sst::io::fxChunkSetCustom header{};
    file.seekg(0);
    if (length < std::streamoff(sizeof(header)) ||
        !file.read(reinterpret_cast<char *>(&header), sizeof(header)) ||
        mech::endian_read_int32BE(header.chunkMagic) != 'CcnK' ||
        mech::endian_read_int32BE(header.fxMagic) != 'FPCh' ||
        mech::endian_read_int32BE(header.fxID) != 'cjs3')
    {
        error = "Loaded file has unknown FXP file format. This error usually occurs when you "
                "attempt to load an .fxp that belongs to another plugin into Surge XT.";
        return false;
    }
    const auto size = mech::endian_read_int32BE(header.chunkSize);
    if (size <= 0) { error = "Invalid FXP chunk length"; return false; }
    // As before, a short read still loads what is there; the loader handles missing tails.
    const auto available = std::uint64_t(length) - sizeof(header);
    data.resize(std::size_t(std::min<std::uint64_t>(std::uint64_t(size), available)));
    file.read(data.data(), data.size());
    data.resize(std::size_t(file.gcount()));
    return true;
}

namespace
{
bool readAll(const fs::path &path, std::string &contents, std::string &error)
{
    std::ifstream file(path, std::ios::binary);
    if (!file) { error = "Unable to open file"; return false; }
    contents.assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
    return true;
}
std::uint32_t le32(const std::string &d, std::size_t at)
{
    return std::uint32_t((unsigned char)d[at]) | std::uint32_t((unsigned char)d[at + 1]) << 8 |
           std::uint32_t((unsigned char)d[at + 2]) << 16 | std::uint32_t((unsigned char)d[at + 3]) << 24;
}
std::uint16_t le16(const std::string &d, std::size_t at)
{
    return std::uint16_t((unsigned char)d[at] | (unsigned char)d[at + 1] << 8);
}
bool validateWt(const std::string &d, std::string &error)
{
    if (d.size() < sizeof(wt_header) || d.compare(0, 4, "vawt") != 0)
    { error = "This file is not a Surge .wt wavetable"; return false; }
    const auto samples = std::int32_t(le32(d, 4));
    const auto frames = le16(d, 8), flags = le16(d, 10);
    if (samples <= 0 || samples > max_wtable_size || frames == 0 || frames > max_subtables)
    { error = "Invalid wavetable dimensions"; return false; }
    const std::size_t width = flags & wtf_int16 ? sizeof(short) : sizeof(float);
    if (std::size_t(samples) * frames * width > d.size() - sizeof(wt_header))
    { error = "Truncated wavetable samples"; return false; }
    return true;
}
bool validateXml(const std::string &d, const char *root, const char *what, std::string &error)
{
    TiXmlDocument doc;
    doc.Parse(d.c_str(), nullptr, TIXML_ENCODING_LEGACY);
    if (doc.Error() || !doc.FirstChildElement(root))
    { error = std::string("Invalid ") + what; return false; }
    return true;
}
} // namespace

bool validateUserFile(const fs::path &path, std::string &error)
{
    error.clear();
    auto extension = path_to_string(path.extension());
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    try
    {
        if (extension == ".fxp")
        {
            std::vector<char> data;
            return readValidatedPatch(path, data, error);
        }
        // Only formats with a single consumer whose acceptance rules are reproduced
        // exactly. WAV files also serve as impulse responses (with other sample
        // formats), and .wtscript has a binary container; their native loaders
        // report failures and retain the current state themselves.
        static const char *known[] = {".wt", ".scl", ".kbm", ".srgfx", ".modpreset"};
        if (std::find(std::begin(known), std::end(known), extension) == std::end(known))
            return true;
        std::string d;
        if (!readAll(path, d, error)) return false;
        if (extension == ".wt") return validateWt(d, error);
        if (extension == ".scl") { Tunings::parseSCLData(d); return true; }
        if (extension == ".kbm") { Tunings::parseKBMData(d); return true; }
        if (extension == ".srgfx") return validateXml(d, "single-fx", "FX preset", error);
        return validateXml(d, "lfo", "modulator preset", error);
    }
    catch (const Tunings::TuningError &exception)
    {
        error = std::string("Invalid tuning file: ") + exception.what();
    }
    catch (const std::exception &exception)
    {
        error = exception.what();
    }
    return false;
}
}
