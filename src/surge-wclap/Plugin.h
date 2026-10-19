// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <clap/clap.h>
#include <string>

namespace Surge::Wclap
{
extern const clap_plugin_descriptor_t descriptor;
// The bundle directory clap_entry.init received ("/" when the host preopens the
// bundle as the WASI root). The webview resources live below it.
extern std::string bundlePath;
const clap_plugin_t *createPlugin(const clap_host_t *host);
} // namespace Surge::Wclap
