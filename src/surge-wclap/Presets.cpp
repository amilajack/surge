// SPDX-License-Identifier: GPL-3.0-or-later
#include "Presets.h"
#include "Plugin.h"
#include "UserFiles.h"
#include "PatchFileHeaderStructs.h"
#include "sst/basic-blocks/mechanics/endian-ops.h"
#include "tinyxml/tinyxml.h"
#include <algorithm>
#include <cctype>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace Surge::Wclap::Presets
{
namespace mech = sst::basic_blocks::mechanics;

namespace
{
bool isDirectory(const std::string &path)
{
    struct stat info;
    return stat(path.c_str(), &info) == 0 && S_ISDIR(info.st_mode);
}

bool below(const std::string &path, const std::string &folder)
{
    return path.size() > folder.size() + 1 && path.compare(0, folder.size(), folder) == 0 &&
           path[folder.size()] == '/';
}

std::string lower(std::string text)
{
    std::transform(text.begin(), text.end(), text.begin(),
                   [](unsigned char c) { return char(std::tolower(c)); });
    return text;
}

const clap_preset_discovery_provider_descriptor_t descriptor{
    CLAP_VERSION_INIT, "org.surge-synth-team.surge-xt.preset-indexer", "Surge XT Presets",
    "Surge Synth Team"};

struct Provider
{
    const clap_preset_discovery_indexer_t *indexer;
    clap_preset_discovery_provider_t provider{};

    explicit Provider(const clap_preset_discovery_indexer_t *i) : indexer(i)
    {
        provider.desc = &descriptor;
        provider.provider_data = this;
        provider.init = [](const clap_preset_discovery_provider_t *p) { return self(p)->init(); };
        provider.destroy = [](const clap_preset_discovery_provider_t *p) { delete self(p); };
        provider.get_metadata = [](const clap_preset_discovery_provider_t *p, uint32_t kind,
                                   const char *location,
                                   const clap_preset_discovery_metadata_receiver_t *receiver) {
            return self(p)->metadata(kind, location, receiver);
        };
        provider.get_extension = [](const clap_preset_discovery_provider_t *,
                                    const char *) -> const void * { return nullptr; };
    }

    static Provider *self(const clap_preset_discovery_provider_t *p)
    {
        return static_cast<Provider *>(p->provider_data);
    }

    bool init()
    {
        const clap_preset_discovery_filetype_t fxp{"Surge XT Patch", "A Surge XT patch", "fxp"};
        if (!indexer->declare_filetype(indexer, &fxp))
            return false;
        bool ok = true;
        const auto factory = factoryLocation();
        if (isDirectory(factory))
        {
            const clap_preset_discovery_location_t location{
                CLAP_PRESET_DISCOVERY_IS_FACTORY_CONTENT, "Surge XT Factory Presets",
                CLAP_PRESET_DISCOVERY_LOCATION_FILE, factory.c_str()};
            ok = indexer->declare_location(indexer, &location) && ok;
        }
        const auto user = userLocation();
        if (UserFiles::available() && isDirectory(user))
        {
            const clap_preset_discovery_location_t location{
                CLAP_PRESET_DISCOVERY_IS_USER_CONTENT, "Surge XT User Presets",
                CLAP_PRESET_DISCOVERY_LOCATION_FILE, user.c_str()};
            ok = indexer->declare_location(indexer, &location) && ok;
        }
        return ok;
    }

    bool metadata(uint32_t kind, const char *location,
                  const clap_preset_discovery_metadata_receiver_t *receiver)
    {
        if (!receiver)
            return false;
        const auto fail = [&](const std::string &message) {
            receiver->on_error(receiver, 0, message.c_str());
            return false;
        };
        if (kind != CLAP_PRESET_DISCOVERY_LOCATION_FILE || !location)
            return fail("Surge XT presets are files");
        const std::string path(location);
        std::vector<uint8_t> bytes;
        if (!readFile(path, bytes))
            return fail(path + ": unable to read the file");
        PatchInfo info;
        std::string error;
        if (!readPatchInfo(bytes, info, error))
            return fail(path + ": " + error);
        if (!receiver->begin_preset(receiver, info.name.c_str(), nullptr))
            return fail(path + ": the indexer refused the preset");
        const clap_universal_plugin_id_t id{"clap", descriptor_id()};
        receiver->add_plugin_id(receiver, &id);
        const auto factory = factoryLocation(), user = userLocation();
        const bool isFactory = below(path, factory);
        receiver->set_flags(receiver, isFactory ? CLAP_PRESET_DISCOVERY_IS_FACTORY_CONTENT
                                                : CLAP_PRESET_DISCOVERY_IS_USER_CONTENT);
        if (!info.author.empty())
            receiver->add_creator(receiver, info.author.c_str());
        if (!info.comment.empty())
            receiver->set_description(receiver, info.comment.c_str());
        struct stat stats;
        if (!isFactory && stat(path.c_str(), &stats) == 0)
            receiver->set_timestamps(receiver, CLAP_TIMESTAMP_UNKNOWN,
                                     clap_timestamp(stats.st_mtim.tv_sec));
        auto category = categoryOf(path, isFactory ? factory : user);
        if (category.empty())
            category = info.category;
        if (!category.empty())
        {
            receiver->add_extra_info(receiver, "category", category.c_str());
            // The category's folders as features ("Leads/Mono": "leads", "mono").
            size_t start = 0;
            while (start < category.size())
            {
                auto end = category.find('/', start);
                if (end == std::string::npos)
                    end = category.size();
                const auto feature = lower(category.substr(start, end - start));
                if (!feature.empty())
                    receiver->add_feature(receiver, feature.c_str());
                start = end + 1;
            }
        }
        for (const auto &tag : info.tags)
            receiver->add_feature(receiver, lower(tag).c_str());
        if (!info.license.empty())
            receiver->add_extra_info(receiver, "license", info.license.c_str());
        return true;
    }

    static const char *descriptor_id() { return Surge::Wclap::descriptor.id; }
};

uint32_t count(const clap_preset_discovery_factory_t *) { return 1; }

const clap_preset_discovery_provider_descriptor_t *get(const clap_preset_discovery_factory_t *,
                                                       uint32_t index)
{
    return index == 0 ? &descriptor : nullptr;
}

const clap_preset_discovery_provider_t *create(const clap_preset_discovery_factory_t *,
                                               const clap_preset_discovery_indexer_t *indexer,
                                               const char *id)
{
    if (!indexer || !id || std::strcmp(id, descriptor.id) != 0)
        return nullptr;
    auto *provider = new (std::nothrow) Provider(indexer);
    return provider ? &provider->provider : nullptr;
}
} // namespace

const clap_preset_discovery_factory_t factory{count, get, create};

std::string factoryLocation()
{
    return (bundlePath == "/" ? std::string() : bundlePath) + "/factory/patches_factory";
}

std::string userLocation() { return std::string(UserFiles::root) + "/Patches"; }

bool readFile(const std::string &path, std::vector<uint8_t> &bytes)
{
    const int fd = open(path.c_str(), O_RDONLY);
    if (fd < 0)
        return false;
    struct stat info;
    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size > (off_t(64) << 20))
    {
        close(fd);
        return false;
    }
    bytes.resize(size_t(info.st_size));
    size_t at = 0;
    while (at < bytes.size())
    {
        const auto n = read(fd, bytes.data() + at, bytes.size() - at);
        if (n <= 0)
            break;
        at += size_t(n);
    }
    close(fd);
    return at == bytes.size();
}

bool readPatchInfo(const std::vector<uint8_t> &fxp, PatchInfo &info, std::string &error)
{
    sst::io::fxChunkSetCustom chunk{};
    sst::io::patch_header header{};
    if (fxp.size() < sizeof(chunk) + sizeof(header))
        return error = "too short for a Surge XT patch", false;
    std::memcpy(&chunk, fxp.data(), sizeof(chunk));
    if (mech::endian_read_int32BE(chunk.chunkMagic) != 'CcnK' ||
        mech::endian_read_int32BE(chunk.fxMagic) != 'FPCh' ||
        mech::endian_read_int32BE(chunk.fxID) != 'cjs3')
        return error = "not a Surge XT patch", false;
    std::memcpy(&header, fxp.data() + sizeof(chunk), sizeof(header));
    const size_t xmlSize = mech::endian_read_int32LE(header.xmlsize);
    if (std::memcmp(header.tag, "sub3", 4) != 0 ||
        xmlSize > fxp.size() - sizeof(chunk) - sizeof(header))
        return error = "a Surge XT patch without its XML", false;
    const std::string xml(reinterpret_cast<const char *>(fxp.data()) + sizeof(chunk) +
                              sizeof(header),
                          xmlSize);
    TiXmlDocument document;
    document.Parse(xml.c_str(), nullptr, TIXML_ENCODING_LEGACY);
    auto *patch = document.FirstChildElement("patch");
    auto *meta = patch ? patch->FirstChildElement("meta") : nullptr;
    if (document.Error() || !meta || !meta->Attribute("name"))
        return error = "a patch without a name", false;
    const auto text = [&](const char *name) {
        const char *value = meta->Attribute(name);
        return std::string(value ? value : "");
    };
    info.name = text("name");
    info.category = text("category");
    info.author = text("author");
    info.comment = text("comment");
    info.license = text("license");
    info.tags.clear();
    if (auto *tags = meta->FirstChildElement("tags"))
        for (auto *tag = tags->FirstChildElement("tag"); tag; tag = tag->NextSiblingElement("tag"))
            if (const char *value = tag->Attribute("tag"))
                info.tags.emplace_back(value);
    return true;
}

std::string categoryOf(const std::string &file, const std::string &location)
{
    if (!below(file, location))
        return {};
    const auto relative = file.substr(location.size() + 1);
    const auto slash = relative.find_last_of('/');
    return slash == std::string::npos ? std::string() : relative.substr(0, slash);
}
} // namespace Surge::Wclap::Presets
