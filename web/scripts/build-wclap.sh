#!/usr/bin/env bash
# Builds the Surge XT WCLAP DSP module (build-wclap/wclap/module.wasm) with the
# pinned Emscripten SDK. web/scripts/package-wclap.py assembles the bundle.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
version=6.0.10
sdk="$root/.toolchains/emsdk-$version"
if [[ ! -d "$sdk/.git" ]]; then
  git clone --depth 1 --branch "$version" https://github.com/emscripten-core/emsdk.git "$sdk"
fi
if [[ $(git -C "$sdk" rev-parse HEAD) != a2b92777574c2feda07994cd4f1079a3dfc151f8 ]]; then
  echo 'Unexpected emsdk revision; refusing to build with a different toolchain.' >&2
  exit 1
fi
"$sdk/emsdk" install "$version" >/dev/null
"$sdk/emsdk" activate "$version" >/dev/null
source "$sdk/emsdk_env.sh" >/dev/null
if [[ -e "$root/.git" ]]; then
  git -C "$root" submodule update --init --recursive
fi
build="${SURGE_WCLAP_BUILD:-$root/build-wclap}"
emcmake cmake -S "$root" -B "$build" -DSURGE_WCLAP=ON -DENABLE_LTO=OFF \
  -DSURGE_BUILD_TESTRUNNER=OFF -DSURGE_SKIP_WERROR=ON -DCMAKE_BUILD_TYPE=Release
cmake --build "$build" --target surge-xt-wclap --parallel "${SURGE_BUILD_JOBS:-4}"
