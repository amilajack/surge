// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// CLAP preset discovery and loading for the Surge XT WCLAP, as the desktop CLAP does
// (src/surge-xt/SurgeCLAPPresetDiscovery.cpp): one provider, Surge XT patches (.fxp)
// as file locations. The factory patches ship in the bundle (factory/patches_factory,
// below the directory clap_entry.init received, which hosts preopen); user patches
// live in the user folder the host may preopen (/user/Patches, UserFiles.h).
#include <clap/clap.h>
#include <cstdint>
#include <string>
#include <vector>

namespace Surge::Wclap::Presets
{
extern const clap_preset_discovery_factory_t factory;

// The factory patch folder inside the bundle, and the user patch folder.
std::string factoryLocation();
std::string userLocation();

// The bytes of a file, or false.
bool readFile(const std::string &path, std::vector<uint8_t> &bytes);

// What a patch file says about itself: <meta> of its XML.
struct PatchInfo
{
    std::string name, category, author, comment, license;
    std::vector<std::string> tags;
};
bool readPatchInfo(const std::vector<uint8_t> &fxp, PatchInfo &info, std::string &error);

// The category of a patch file in a location: the folders between them, as Surge's
// patch browser shows it ("Basses", "Leads/Mono").
std::string categoryOf(const std::string &file, const std::string &location);
} // namespace Surge::Wclap::Presets
