# The Surge XT WCLAP: a CLAP plug-in compiled to standalone Wasm (module.wasm).
# Configure with emcmake and -DSURGE_WCLAP=ON (web/scripts/build-wclap.sh).
set(SURGE_CLAP_INCLUDE ${CMAKE_SOURCE_DIR}/libs/clap-juce-extensions/clap-libs/clap/include)
file(STRINGS ${SURGE_CLAP_INCLUDE}/clap/version.h surge_clap_version REGEX "#define CLAP_VERSION_(MAJOR|MINOR|REVISION) ")
if(NOT surge_clap_version MATCHES "MAJOR 1.*MINOR 2.*REVISION 7")
  message(FATAL_ERROR "The WCLAP is pinned to CLAP 1.2.7 (clap.webview/3); review the API before updating")
endif()

cmrc_add_resource_library(surge-wclap-resources
  NAMESPACE surge_wclap_resources
  WHENCE ${CMAKE_SOURCE_DIR}/resources/data/patches_factory/Templates
  "${CMAKE_SOURCE_DIR}/resources/data/patches_factory/Templates/Init Saw.fxp")

add_executable(surge-xt-wclap Entry.cpp Plugin.cpp Params.cpp Presets.cpp Random.cpp StateParts.cpp
  UserFiles.cpp Wasi.cpp)
target_include_directories(surge-xt-wclap PRIVATE ${SURGE_CLAP_INCLUDE} ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(surge-xt-wclap PRIVATE surge-web-engine surge-wclap-resources)
set_target_properties(surge-xt-wclap PROPERTIES
  OUTPUT_NAME module SUFFIX .wasm
  RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/wclap)
target_link_options(surge-xt-wclap PRIVATE
  -sSTANDALONE_WASM=1 -sPURE_WASI=1 --no-entry
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=4294967296
  -sSTACK_SIZE=1048576 -sALLOW_TABLE_GROWTH=1
  -sEXPORTED_FUNCTIONS=['_malloc','_free']
  -Wl,--export=clap_entry
  -Wl,--export-table
  # A name section, so profilers (V8's, wasmtime's, perf) attribute time to
  # functions. It costs no run time and about 0.5 MB.
  --profiling-funcs)
