// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "filesystem/import.h"
#include <string>
#include <vector>

namespace Surge::PatchStorage
{
// Read and validate without touching synthesis, editor, or tuning state.
// The returned bytes retain the existing raw Surge patch format.
bool readValidatedPatch(const fs::path &path, std::vector<char> &data, std::string &error);
// Read an FXP's patch chunk with only the checks the loader has always made (a Surge FXP
// header and a positive chunk size). The loader itself tolerates partially damaged patches,
// so this does not reject them, and it parses nothing.
bool readPatchFile(const fs::path &path, std::vector<char> &data, std::string &error);
// Validate an imported user file by its extension before it is published to the
// application: patches, .wt wavetables, .scl/.kbm tuning, and FX and modulator
// presets. Other extensions are accepted unchanged.
bool validateUserFile(const fs::path &path, std::string &error);
}
