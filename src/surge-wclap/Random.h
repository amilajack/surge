// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <cstdint>

namespace Surge::Wclap
{
// Every random stream one plug-in instance consumes. Instances in one module do
// not share streams, so an instance renders the same way whatever the others do,
// and a host that seeds WASI random_get gets bit-identical renders.
struct RandomStreams
{
    uint64_t entropy{};    // AudioRandomDevice: seeds of oscillators, modulators, effects
    uint64_t libc{};       // rand()/srand() of the DSP libraries and Lua
    uint32_t airwindows{}; // AirWinBaseClass instance seeds
    // From host entropy (WASI random_get) when the instance is created.
    void seedFromHost();
    void seed(uint64_t value);
};

// Installs an instance's streams for the duration of one host call into it.
class RandomScope
{
  public:
    explicit RandomScope(RandomStreams &streams);
    ~RandomScope();
    RandomScope(const RandomScope &) = delete;
    RandomScope &operator=(const RandomScope &) = delete;

  private:
    RandomStreams *previous;
    RandomStreams &streams;
    uint32_t previousAirwindows;
};
} // namespace Surge::Wclap
