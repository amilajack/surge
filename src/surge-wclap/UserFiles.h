// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// The plug-in's user folder: a writable directory the host preopens at /user (WASI),
// private to the plug-in and kept by the host across sessions. Surge keeps its user
// patches, settings and favourites there, as the desktop plug-in does in its user
// data folder. The editor page has no file system of its own (an opaque-origin
// frame), so it mirrors the folder in memory and writes through the plug-in
// (Protocol.h: UserFiles, UserFileList, UserFileOps, UserFilesDone). Without the
// preopen the editor keeps user files in memory for as long as its window is open.
#include "Protocol.h"
#include <cstdint>
#include <string>
#include <vector>

namespace Surge::Wclap::UserFiles
{
constexpr const char *root = "/user";

// The host preopened a user folder.
bool available();

// A UserFileList frame with every file and folder below the user folder (paths
// relative to it), or available = 0 without one. Files past the frame's size limit
// are left out and named in skipped.
std::vector<uint8_t> list(std::vector<std::string> *skipped = nullptr);

// Applies the operations of a UserFileOps frame in order, stopping at the first that
// fails. Returns a UserFilesDone frame.
std::vector<uint8_t> apply(Protocol::Reader &frame);

// A path relative to the user folder that stays inside it: no empty, "." or ".."
// segments, no backslashes or NULs, and not absolute.
bool safeRelativePath(const std::string &path);
} // namespace Surge::Wclap::UserFiles
