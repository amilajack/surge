// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// The WASI preopens the host gave the module (Wasi.cpp answers the module's file
// system calls with them).

namespace Surge::Wclap::Wasi
{
// True when the host preopened a directory at exactly this absolute path, such as
// "/user", the plug-in's private writable folder.
bool hasPreopen(const char *path);
} // namespace Surge::Wclap::Wasi
