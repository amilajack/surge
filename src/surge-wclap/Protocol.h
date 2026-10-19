// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// Messages between the WCLAP plug-in (module.wasm, the DSP) and its webview page
// (ui/, the JUCE editor on a silent stand-in engine). Each clap.webview/3 message
// is one frame: u8 type, u8 flags (0), u16 reserved (0), then the payload, all
// little-endian. Parameter ids are the CLAP parameter ids (desktop-compatible).
//
//   Hello        UI -> DSP  u32 version. The DSP answers with a Snapshot.
//   Param        both       u32 clap id, f64 normalized value. UI edits go to the
//                           host as parameter changes; host automation and engine
//                           changes (MIDI learn) go to the page. Never echoed.
//   Gesture      UI -> DSP  u32 clap id, u8 begin (1) or end (0).
//   State        UI -> DSP  raw Surge state (desktop getStateInformation bytes):
//                           a structural edit (patch load, oscillator, FX, MSEG,
//                           formula...). The DSP loads it; held notes retrigger.
//   Modulation   UI -> DSP  i32 op (0 depth, 1 mute, 2 clear), i32 parameter tag,
//                           i32 source, i32 source scene, i32 index, f32 value.
//   Note         UI -> DSP  u8 on, u8 channel, u8 key, u8 velocity: the editor's
//                           virtual keyboard.
//   EditorState  UI -> DSP  UTF-8 <dawExtraState> XML with the editor view (zoom,
//                           tabs, overlays), saved with the state.
//   Resize       both       u32 width, u32 height in CSS pixels. UI -> DSP: the
//                           editor's size changed (the DSP asks the host); DSP ->
//                           UI: the host resized the window.
//   Scope        UI -> DSP  u8 subscribed: stream output audio for the oscilloscope.
//   Snapshot     DSP -> UI  u32 version, then raw Surge state (the current patch).
//   Telemetry    DSP -> UI  TelemetryFrame, about 30 times a second while open.
//   ScopeAudio   DSP -> UI  f32 interleaved stereo output samples.
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace Surge::Wclap::Protocol
{
constexpr uint32_t version = 1;
constexpr size_t headerSize = 4;

enum Type : uint8_t
{
    Hello = 1,
    Param = 2,
    Gesture = 3,
    State = 4,
    Modulation = 5,
    Note = 6,
    EditorState = 7,
    Resize = 8,
    Scope = 9,
    Snapshot = 64,
    Telemetry = 65,
    ScopeAudio = 66,
};

enum ModulationOp : int32_t
{
    ModulationDepth = 0,
    ModulationMute = 1,
    ModulationClear = 2,
};

struct TelemetryFrame
{
    float vuPeak[8];
    float cpuLevel;
    uint32_t activeVoices;
    uint8_t keys[16];      // bitset of sounding keys (any channel)
    int32_t heldLowest[2]; // per scene, -1 when none (oscilloscope keytrack)
    int32_t heldHighest[2];
    int32_t heldLatest[2];
};
static_assert(sizeof(TelemetryFrame) == 8 * 4 + 4 + 4 + 16 + 6 * 4);

class Writer
{
  public:
    explicit Writer(Type type, size_t reserve = 0)
    {
        bytes.reserve(headerSize + reserve);
        bytes.push_back(type);
        bytes.insert(bytes.end(), 3, 0);
    }
    template <typename T> Writer &put(const T &value)
    {
        const auto *raw = reinterpret_cast<const uint8_t *>(&value); // wasm32 is little-endian
        bytes.insert(bytes.end(), raw, raw + sizeof(T));
        return *this;
    }
    Writer &append(const void *data, size_t size)
    {
        const auto *raw = static_cast<const uint8_t *>(data);
        bytes.insert(bytes.end(), raw, raw + size);
        return *this;
    }
    std::vector<uint8_t> bytes;
};

class Reader
{
  public:
    Reader(const void *data, size_t size)
        : bytes(static_cast<const uint8_t *>(data)), size(size), at(headerSize)
    {
    }
    bool valid() const { return size >= headerSize; }
    Type type() const { return Type(bytes[0]); }
    template <typename T> bool get(T &value)
    {
        if (size - at < sizeof(T))
            return false;
        std::memcpy(&value, bytes + at, sizeof(T));
        at += sizeof(T);
        return true;
    }
    const uint8_t *rest() const { return bytes + at; }
    size_t remaining() const { return size - at; }

  private:
    const uint8_t *bytes;
    size_t size, at;
};
} // namespace Surge::Wclap::Protocol
