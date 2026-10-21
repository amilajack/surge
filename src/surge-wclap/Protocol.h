// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// Messages between the WCLAP plug-in (module.wasm, the DSP) and its webview page
// (ui/, the JUCE editor on a silent stand-in engine). Each clap.webview/3 message
// is one frame: u8 type, u8 flags (0), u16 reserved (0), then the payload, all
// little-endian. Parameter ids are the CLAP parameter ids (desktop-compatible).
//
//   Hello        UI -> DSP  u32 version. The DSP answers with OutputState, Scale
//                           (when the host set one) and a Snapshot, and asks the
//                           host to keep processing while the window is visible.
//   Param        both       u32 clap id, f64 normalized value. UI edits go to the
//                           host as parameter changes; host automation and engine
//                           changes (MIDI learn) go to the page. Never echoed.
//   Gesture      UI -> DSP  u32 clap id, u8 begin (1) or end (0).
//   State        UI -> DSP  raw Surge state (desktop getStateInformation bytes): a
//                           patch load, or a structural edit no Delta describes. The
//                           DSP loads it; held notes retrigger, as on the desktop.
//   Modulation   UI -> DSP  i32 op (0 depth, 1 mute, 2 clear), i32 parameter tag,
//                           i32 source, i32 source scene, i32 index, f32 value.
//   Note         UI -> DSP  u8 on, u8 channel, u8 key, u8 velocity: the editor's
//                           virtual keyboard.
//   EditorState  UI -> DSP  UTF-8 <dawExtraState> XML with the editor view (zoom,
//                           tabs, overlays), saved with the state.
//   Resize       both       u32 width, u32 height in CSS pixels. UI -> DSP: the
//                           editor's size changed (the DSP asks the host); DSP ->
//                           UI: the host resized the window (the editor zooms to fit).
//   Scope        UI -> DSP  u8 subscribed: stream output audio for the oscilloscope.
//   Delta        UI -> DSP  u64 digest, u32 count, then count parts (StateParts.h):
//                           a structural edit (MSEG, step sequence, formula,
//                           wavetable, names...) as the parts it changed. The DSP
//                           applies them in place, so held notes keep playing, and
//                           checks that its state now has the digest; if not, it
//                           answers NeedState.
//   UserFiles    UI -> DSP  u32 version: the page asks for the user folder before
//                           the editor starts. The DSP answers UserFileList.
//   UserFileOps  UI -> DSP  u32 sequence, u32 count, then count operations: u8 op
//                           (UserFileOp), u8[3] 0, u32 path size, path (relative to
//                           the user folder), u32 data size, data. The DSP applies
//                           them in order and answers UserFilesDone.
//   Snapshot     DSP -> UI  u32 version, then raw Surge state (the current patch).
//   Telemetry    DSP -> UI  TelemetryFrame, about 30 times a second while open and
//                           the host processes.
//   ScopeAudio   DSP -> UI  f32 interleaved stereo output samples.
//   OutputState  DSP -> UI  OutputStateFrame, then the host's name (UTF-8): what the
//                           editor's output meter and About screen show.
//   Scale        DSP -> UI  f64 GUI scale from the host (clap.gui set_scale); 0
//                           follows the window's device pixel ratio.
//   NeedState    DSP -> UI  (no payload) a Delta did not reproduce the page's
//                           state: the page sends its complete State.
//   UserFileList DSP -> UI  u8 available (the host gave the plug-in a writable
//                           /user folder), u8[3] 0, u32 count, then count entries:
//                           u8 kind (1 file, 2 folder), u8[3] 0, f64 modification
//                           time in ms, u32 path size, path, u32 data size, data.
//   UserFilesDone DSP -> UI u32 sequence, u8 ok, u8[3] 0, then an error (UTF-8).
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace Surge::Wclap::Protocol
{
constexpr uint32_t version = 2;
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
    Delta = 10,
    UserFiles = 11,
    UserFileOps = 12,
    Snapshot = 64,
    Telemetry = 65,
    ScopeAudio = 66,
    OutputState = 67,
    Scale = 68,
    NeedState = 69,
    UserFileList = 70,
    UserFilesDone = 71,
};

enum UserFileOp : uint8_t
{
    UserFileWrite = 1,  // create or replace a file with the data
    UserFileRemove = 2, // remove a file
    UserFolderMake = 3, // create a folder (its parent exists)
    UserFolderRemove = 4,
};

enum UserFileKind : uint8_t
{
    UserFileEntry = 1,
    UserFolderEntry = 2,
};

struct OutputStateFrame
{
    double sampleRate; // the rate the host activated the plug-in at (0 before)
    uint8_t active;    // activated by the host
    uint8_t processing; // the host calls process (it may sleep a silent plug-in)
    uint16_t reserved;
    uint32_t maxFrames; // the largest block the host announced
};
static_assert(sizeof(OutputStateFrame) == 16);

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
    bool getBytes(size_t count, const uint8_t *&data)
    {
        if (size - at < count)
            return false;
        data = bytes + at;
        at += count;
        return true;
    }
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
