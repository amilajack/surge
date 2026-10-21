/*
 * Surge XT - a free and open source hybrid synthesizer,
 * built by Surge Synth Team
 *
 * Learn more at https://surge-synthesizer.github.io/
 *
 * Copyright 2018-2024, various authors, as described in the GitHub
 * transaction log.
 *
 * Surge XT is released under the GNU General Public Licence v3
 * or later (GPL-3.0-or-later). The license is found in the "LICENSE"
 * file in the root of this repository, or at
 * https://www.gnu.org/licenses/gpl-3.0.en.html
 */

#ifndef SURGE_SRC_COMMON_FUSEDMULTIPLYADD_H
#define SURGE_SRC_COMMON_FUSEDMULTIPLYADD_H

#include <cmath>

#if defined(__wasm_relaxed_simd__)
#include <wasm_simd128.h>
#endif

namespace surge
{
/*
 * a * b + c with one rounding, as std::fma. Wasm has no scalar FMA, so std::fma is a
 * software routine of tens of operations there; relaxed SIMD's madd is a single fused
 * instruction wherever the machine has FMA (V8 on arm64 and on x86-64 with FMA3, and
 * wasmtime in its deterministic mode), which is every machine the WCLAP targets.
 */
inline float fusedMultiplyAdd(float a, float b, float c)
{
#if defined(__wasm_relaxed_simd__)
    return wasm_f32x4_extract_lane(wasm_f32x4_relaxed_madd(wasm_f32x4_splat(a),
                                                           wasm_f32x4_splat(b),
                                                           wasm_f32x4_splat(c)),
                                   0);
#else
    return std::fma(a, b, c);
#endif
}

inline double fusedMultiplyAdd(double a, double b, double c)
{
#if defined(__wasm_relaxed_simd__)
    return wasm_f64x2_extract_lane(wasm_f64x2_relaxed_madd(wasm_f64x2_splat(a),
                                                           wasm_f64x2_splat(b),
                                                           wasm_f64x2_splat(c)),
                                   0);
#else
    return std::fma(a, b, c);
#endif
}
} // namespace surge

#endif // SURGE_SRC_COMMON_FUSEDMULTIPLYADD_H
