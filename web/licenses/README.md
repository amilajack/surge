# Distribution notice audit

`inventory.json` records original notice documents and their hashes. Its status
is `coverage-audited`: `web/scripts/license-coverage.py` maps every file compiled
into `surge-xt-browser` to indexed notices, using the compiler dependency files
of each linked object and the rules in `coverage.json`. It also maps the linked
Emscripten runtime (musl, libc++, libc++abi, compiler-rt, FreeType, zlib) and
every shipped font and factory asset. The check fails on any file without a
rule, any rule naming an unindexed component, and any eurorack source without its
own per-file notice. In the current build it covers 4,234 compiled dependencies
and 5,766 assets.

This is a mechanical coverage audit, not a legal determination of license
compatibility; that review belongs to the distributor. The inventory's
`limitations` list (printed at the top of the bundle) records the remaining
judgement calls: FreeType's GPLv2-or-later option, the CMakeRC script vendored
without its upstream notice, and the asset-tree licensing assumptions. Rerun the
coverage check after any dependency or toolchain change.

`package-static.py` renders the bundle into every package as
`THIRD-PARTY-NOTICES.txt`, and a `--release` package requires the coverage
check to pass.

The first pass follows `surge-common` link dependencies, the browser application's
link response file, and known header dependencies. All 182 indexed sources exist
and are nonempty. Preserve their text and authorship notices when packaging; do
not replace them with a list of license identifiers. Changes to their hashes
require review of the upstream document.

PFFFT, SQLite, tinyxml and strnatcmp notices are indexed as exact byte ranges in
their original source headers. Both the complete source and selected notice have
hashes.

All six bundled fonts also have reviewed byte ranges for their English Unicode
copyright, license-description and license-URL name records (IDs 0, 13 and 14).
The collector verifies the full font and each range before decoding UTF-16BE;
it preserves the original notice text, including Indie Flower's full OFL. The
standalone OFL document is included alongside the Lato and Fira Mono metadata.

The 128 eurorack sources/headers referenced by the current Wasm build's compiler
dependency files are also indexed individually. Their complete leading MIT
notices retain per-file years, authors and comments. A scan found no additional
copyright/permission blocks outside those leading notices. This covers the
observed dependency set, not every future eurorack revision or uncompiled file;
dependency additions must be audited before release.

The compiler dependencies in the generated JUCE browser overlay confirm use of
HarfBuzz, SheenBidi, PNG, JPEG, zlib, Ogg/Vorbis and FLAC. Their primary license
documents and the FLAC/SheenBidi copyright headers are indexed. All nine added
source documents match their copies in the compiled overlay byte for byte.
JUCE per-file exceptions and toolchain runtime/port notices still need audit.

Generate the current partial bundle with:

```sh
python3 web/scripts/license-notices.py /tmp/surge-third-party-notices.txt
python3 web/tests/license-notices.test.py
```

The collector validates every document before atomically replacing its output.
Three checks pass for verbatim retention, changed/range-invalid notice rejection,
and preservation of an existing bundle when validation fails. The static
packager and the Vercel stage both include its output.


The additional PFFFT convolution MIT notices, ChowDSP omega MIT notice,
Vintage Ladder BSD notice and pink-noise attribution are retained as exact source
ranges. Font distribution readmes and the Voxengo impulse terms are included in
full. Voxengo assets have their own distribution conditions; inclusion in this
partial bundle does not turn those assets into GPL-licensed material. The final
asset packaging audit must verify that their complete original notices accompany
the downloaded files.
