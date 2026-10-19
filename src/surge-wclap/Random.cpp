// SPDX-License-Identifier: GPL-3.0-or-later
#include "Random.h"
#include "SurgeRandom.h"
#include "airwindows/AirWinBaseClass.h"
#include <wasi/api.h>

namespace
{
uint64_t splitmix(uint64_t &state)
{
    uint64_t z = (state += 0x9e3779b97f4a7c15ull);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
    return z ^ (z >> 31);
}

// Calls outside any instance (module construction) use fixed streams.
Surge::Wclap::RandomStreams moduleStreams{0x5eed5eed5eed5eedull, 0, 0x2545f491u};
Surge::Wclap::RandomStreams *current = &moduleStreams;
} // namespace

namespace Surge::Wclap
{
void RandomStreams::seed(uint64_t value)
{
    uint64_t state = value;
    entropy = splitmix(state);
    libc = splitmix(state);
    airwindows = uint32_t(splitmix(state) >> 32) | 1u;
}

void RandomStreams::seedFromHost()
{
    // Twelve bytes of host entropy: a 64-bit seed for the generators, and the
    // 32-bit Airwindows source as given (so a host can reproduce a native capture
    // made with a known source).
    struct
    {
        uint64_t seed;
        uint32_t airwindows;
    } value{0x5eed5eed5eed5eedull, 0x5eed5eedu};
    if (__wasi_random_get(reinterpret_cast<uint8_t *>(&value), 12) != __WASI_ERRNO_SUCCESS)
        value = {0x5eed5eed5eed5eedull, 0x5eed5eedu};
    seed(value.seed);
    airwindows = value.airwindows ? value.airwindows : 1u;
}

RandomScope::RandomScope(RandomStreams &s) : previous(current), streams(s)
{
    previousAirwindows = AirWinBaseClass::randomSourceState();
    AirWinBaseClass::seedRandomSource(streams.airwindows);
    current = &streams;
}

RandomScope::~RandomScope()
{
    streams.airwindows = AirWinBaseClass::randomSourceState();
    AirWinBaseClass::seedRandomSource(previousAirwindows);
    current = previous;
}
} // namespace Surge::Wclap

namespace Surge
{
uint32_t wclapEntropy() { return uint32_t(splitmix(current->entropy) >> 32); }
} // namespace Surge

// libc's generator, per instance (musl's recurrence, so rand() behaves as before).
extern "C" void srand(unsigned seed) { current->libc = seed - 1; }
extern "C" int rand(void)
{
    current->libc = 6364136223846793005ull * current->libc + 1;
    return int(current->libc >> 33);
}
