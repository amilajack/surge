// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// A Surge patch as the parts a structural edit changes, so the WCLAP editor can send
// an edit as the parts it touched (a Delta frame, Protocol.h) and the plug-in can
// apply them in place, the way the desktop editor edits the engine's storage: held
// notes keep playing. Shared by the plug-in (module.wasm) and its editor page.
//
// A part holds what the engine keeps in memory, not only what a saved patch holds
// (an LFO's step sequence survives a shape change), so applying every part of one
// engine to another makes their saved states identical. digest() is what both sides
// compare afterwards; a mismatch makes the page send its complete state instead.
#include "Protocol.h"
#include <cstdint>
#include <string>
#include <vector>

class SurgeSynthesizer;

namespace Surge::Wclap::StateParts
{
enum Kind : uint8_t
{
    Meta = 1,          // patch name, category, author, comment, license, tags (<meta>)
    ExtraOsc = 2,      // a: scene, b: oscillator; wavetable name and script, extra config
    StepSequence = 3,  // a: scene, b: LFO (<sequence>)
    Mseg = 4,          // a: scene, b: LFO (<mseg>)
    Formula = 5,       // a: scene, b: LFO (<formula>)
    ExtraLfo = 6,      // a: scene, b: LFO; extra output amplitude
    Macro = 7,         // a: macro; name and bipolarity (its value is a parameter)
    ModulatorNames = 8, // a: scene, b: LFO; the names of its indexed outputs
    Wavetable = 9,     // a: scene, b: oscillator; the table as a patch stores it, and its snapshots
    Tuning = 10,       // scale and keyboard mapping, and the tuning stored in the patch
    FxData = 11,       // a: FX slot; data an effect keeps beside its parameters (impulse responses)
};

struct Part
{
    Kind kind{};
    uint8_t a{0}, b{0};
    std::string data;

    uint32_t key() const { return uint32_t(kind) << 16 | uint32_t(a) << 8 | b; }
};

// Every part of the engine's current patch.
std::vector<Part> collect(SurgeSynthesizer &synth);

// Wire format: u8 kind, u8 a, u8 b, u8 0, u32 size, then the data.
void write(Protocol::Writer &frame, const Part &part);
bool read(Protocol::Reader &frame, Part &part);

// Applies a part to the engine's storage in place: voices keep playing. Returns
// false for a part that is malformed or names a scene, slot or LFO out of range.
bool apply(SurgeSynthesizer &synth, const Part &part);

// FNV-1a (64-bit) of the sound of a raw state (desktop getStateInformation bytes):
// its XML without the DAW extra state's editor view, dirty flag and load path, and
// the binary data after it. 0 for data that is not a state.
uint64_t digest(const uint8_t *state, size_t size);

// The XML of a raw state without the view-only parts of its DAW extra state, and the
// binary data after it (wavetables, extension blocks).
bool soundOf(const uint8_t *state, size_t size, std::string &xml, std::string &rest);
} // namespace Surge::Wclap::StateParts
