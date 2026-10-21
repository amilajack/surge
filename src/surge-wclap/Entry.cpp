// SPDX-License-Identifier: GPL-3.0-or-later
// clap_entry, the plug-in factory and the preset discovery factory of the Surge XT
// WCLAP. One module instance hosts any number of plug-in instances: code, tables and
// the parameter layout are shared; each instance owns only its engine.
#include "Plugin.h"
#include "Presets.h"
#include "version.h"
#include <cstring>

namespace Surge::Wclap
{
std::string bundlePath = "/";

namespace
{
const char *const features[] = {CLAP_PLUGIN_FEATURE_INSTRUMENT, CLAP_PLUGIN_FEATURE_SYNTHESIZER,
                                CLAP_PLUGIN_FEATURE_STEREO, "free and open source", nullptr};

uint32_t pluginCount(const clap_plugin_factory_t *) { return 1; }

const clap_plugin_descriptor_t *pluginDescriptor(const clap_plugin_factory_t *, uint32_t index)
{
    return index == 0 ? &descriptor : nullptr;
}

const clap_plugin_t *create(const clap_plugin_factory_t *, const clap_host_t *host, const char *id)
{
    if (!host || !id || std::strcmp(id, descriptor.id) != 0 ||
        !clap_version_is_compatible(host->clap_version))
        return nullptr;
    return createPlugin(host);
}

const clap_plugin_factory_t factory{pluginCount, pluginDescriptor, create};

bool init(const char *path)
{
    bundlePath = path && *path ? path : "/";
    while (bundlePath.size() > 1 && bundlePath.back() == '/')
        bundlePath.pop_back();
    return true;
}

void deinit() {}

const void *getFactory(const char *id)
{
    if (!id)
        return nullptr;
    if (std::strcmp(id, CLAP_PLUGIN_FACTORY_ID) == 0)
        return &factory;
    // Surge XT patches, as the desktop CLAP indexes them (Presets.h).
    if (std::strcmp(id, CLAP_PRESET_DISCOVERY_FACTORY_ID) == 0 ||
        std::strcmp(id, CLAP_PRESET_DISCOVERY_FACTORY_ID_COMPAT) == 0)
        return &Presets::factory;
    return nullptr;
}
} // namespace

const clap_plugin_descriptor_t descriptor{
    CLAP_VERSION_INIT,
    "org.surge-synth-team.surge-xt",
    "Surge XT",
    "Surge Synth Team",
    "https://surge-synthesizer.github.io/",
    "https://surge-synthesizer.github.io/manual-xt/",
    "https://github.com/amilajack/surge",
    Surge::Build::FullVersionStr,
    "Hybrid synthesizer (WebAssembly)",
    features,
};
} // namespace Surge::Wclap

extern "C" CLAP_EXPORT const clap_plugin_entry_t clap_entry{
    CLAP_VERSION_INIT,
    Surge::Wclap::init,
    Surge::Wclap::deinit,
    Surge::Wclap::getFactory,
};
