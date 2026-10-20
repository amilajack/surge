#!/usr/bin/env python3
"""Assemble the Surge XT WCLAP bundle (surge-xt.wclap/ and surge-xt.wclap.tar.gz).

Run after web/scripts/build-wclap.sh (the DSP module) and the surge-xt-wclap-ui
target of build-web (the editor page). The archive is reproducible: sorted
entries, fixed ownership and permissions, and timestamps from the source commit.
"""
import argparse
import gzip
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAME = 'surge-xt.wclap'
# Factory content shipped with the editor. The third-party patch, wavetable and
# impulse collections (about 420 MB) are left out to keep the bundle reasonable.
FACTORY = ['patches_factory', 'wavetables', 'fx_presets', 'modulator_presets', 'tuning_library',
           'skins', 'impulses_factory']
# Classic scripts the editor's native code calls into (EM_ASM), in load order.
SUPPORT = ['runtime.js', 'reports.js', 'clipboard.js', 'text-input.js', 'accessibility.js',
           'tuning-library.js', 'archive-recovery.js', 'audio-lifecycle.js']
EMSDK_REVISION = 'a2b92777574c2feda07994cd4f1079a3dfc151f8'
UI_FILES = ['surge-xt-wclap-ui.js', 'surge-xt-wclap-ui.wasm', 'surge-xt-wclap-ui.data']


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args, cwd=ROOT):
    return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def toolchain():
    sdk = ROOT / '.toolchains/emsdk-6.0.10'
    clang = sdk / 'upstream/bin/clang'
    version = subprocess.run([str(clang), '--version'], capture_output=True, text=True).stdout.splitlines()[0] \
        if clang.exists() else 'unknown'
    revision = git('rev-parse', 'HEAD', cwd=sdk) if (sdk / '.git').exists() else 'unknown'
    return {'emsdk': '6.0.10', 'emsdkRevision': revision, 'clang': version}


def source_identity():
    commit = git('rev-parse', 'HEAD')
    dirty = bool(git('status', '--porcelain', '--untracked-files=no'))
    submodules = []
    status = subprocess.run(['git', 'submodule', 'status', '--recursive'], cwd=ROOT, check=True,
                            capture_output=True, text=True).stdout
    for line in status.splitlines():
        match = re.match(r'^[ +U-]?([0-9a-f]{40}) (\S+)', line)
        if match:
            submodules.append((match[2], match[1]))
    return commit, dirty, submodules, int(git('log', '-1', '--format=%ct'))


def notices(commit, dirty, submodules, tools):
    rendered = load_module('license_notices', ROOT / 'web/scripts/license-notices.py').render()
    lines = [
        '# Surge XT WCLAP — notices',
        '',
        f'Built from https://github.com/amilajack/surge commit `{commit}`' + (' with uncommitted changes' if dirty else '') + '.',
        f'Toolchain: Emscripten SDK {tools["emsdk"]} (emsdk revision `{tools["emsdkRevision"]}`), {tools["clang"]}.',
        'CLAP headers: free-audio/clap 1.2.7 (libs/clap-juce-extensions/clap-libs/clap), including the clap.webview/3 draft.',
        '',
        '## Licenses of the parts',
        '',
        '- `module.wasm`, the DSP plug-in: Surge XT and the libraries it links, distributed under the',
        '  GNU General Public License version 3 or later (`LICENSE`). It contains no JUCE code.',
        '- `ui/`, the editor page: Surge XT\'s JUCE editor. JUCE 8 is used under the GNU Affero General',
        '  Public License version 3, so `ui/surge-xt-wclap-ui.wasm` and the editor scripts are distributed',
        '  under the AGPL-3.0 (`licenses/AGPL-3.0.txt`); Surge XT\'s own code in it remains GPL-3.0-or-later.',
        '- `ui/library/`: Surge XT factory patches, wavetables, presets, skins, tunings and impulse responses.',
        '  Patches carry their own author and license metadata; the Voxengo impulses keep their own terms.',
        '',
        '## Source',
        '',
        'See `SOURCES.md` for the complete corresponding source.',
        '',
        '## Submodules',
        '',
        *[f'- `{path}` at `{sha}`' for path, sha in submodules],
        '',
        '## Third-party notices',
        '',
        '```text',
        rendered.rstrip('\n'),
        '```',
        '',
    ]
    return '\n'.join(lines)


def sources(commit, dirty, submodules):
    return '\n'.join([
        '# Surge XT WCLAP — source',
        '',
        'This bundle is free software. Its complete corresponding source is the Surge XT repository at',
        f'https://github.com/amilajack/surge, commit `{commit}`' + (' plus uncommitted changes in the build tree' if dirty else '') + ',',
        'with its Git submodules at the commits listed in `NOTICES.md`.',
        '',
        'To rebuild:',
        '',
        '```sh',
        'git clone https://github.com/amilajack/surge && cd surge',
        f'git checkout {commit} && git submodule update --init --recursive',
        'bash web/scripts/build.sh                     # the editor (surge-xt-wclap-ui, build-web)',
        'cmake --build build-web --target surge-xt-wclap-ui',
        'bash web/scripts/build-wclap.sh               # the DSP module (build-wclap)',
        'python3 web/scripts/package-wclap.py          # this bundle',
        '```',
        '',
        '`python3 web/scripts/source-archive.py` exports the same tree, submodules included, as a verified',
        'archive. For three years from the date you received this bundle, the distributor will also give',
        'anyone a copy of that source on request, for no more than the cost of providing it.',
        '',
    ])


def publish_library(destination):
    library = load_module('factory_library', ROOT / 'web/scripts/factory-library.py')
    stage = Path(tempfile.mkdtemp(prefix='surge-wclap-factory-'))
    try:
        for name in FACTORY:
            shutil.copytree(ROOT / 'resources/data' / name, stage / name)
        # The factory patches are files in factory/ (the plug-in's preset discovery
        # location); the editor's library reads them there instead of as objects.
        library.publish(stage, destination, beside={'patches_factory/': '../../factory/'})
    finally:
        shutil.rmtree(stage)


def copy_patches(target):
    """factory/patches_factory: the patches as files, which hosts crawl for presets."""
    source = ROOT / 'resources/data/patches_factory'
    for file in sorted(source.rglob('*')):
        if file.is_file() and file.suffix.lower() == '.fxp':
            destination = target / 'factory/patches_factory' / file.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, destination)


def assemble(target, dsp, ui):
    if target.exists():
        shutil.rmtree(target)
    (target / 'ui').mkdir(parents=True)
    (target / 'licenses').mkdir()
    shutil.copyfile(dsp, target / 'module.wasm')
    for name in UI_FILES:
        shutil.copyfile(ui / name, target / 'ui' / name)
    shutil.copyfile(ROOT / 'web/wclap/ui/index.html', target / 'ui/index.html')
    support = ''.join(f'// --- {name}\n' + (ROOT / 'web/browser' / name).read_text() + '\n' for name in SUPPORT)
    (target / 'ui/support.js').write_text(support)
    shutil.copyfile(ROOT / 'web/browser/library.js', target / 'ui/library.js')
    copy_patches(target)
    publish_library(target / 'ui/library')
    shutil.copyfile(ROOT / 'LICENSE', target / 'LICENSE')
    shutil.copyfile(ROOT / 'web/wclap/licenses/AGPL-3.0.txt', target / 'licenses/AGPL-3.0.txt')
    shutil.copyfile(ROOT / 'LICENSE', target / 'licenses/GPL-3.0.txt')
    commit, dirty, submodules, epoch = source_identity()
    tools = toolchain()
    (target / 'NOTICES.md').write_text(notices(commit, dirty, submodules, tools))
    (target / 'SOURCES.md').write_text(sources(commit, dirty, submodules))
    for path in target.rglob('*'):
        os.chmod(path, 0o755 if path.is_dir() else 0o644)
    return epoch


def archive(target, output, epoch):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.PAX_FORMAT) as tar:
        entries = [target] + sorted(target.rglob('*'), key=lambda p: p.relative_to(target).as_posix())
        for path in entries:
            name = (Path(NAME) / path.relative_to(target)).as_posix() if path != target else NAME
            info = tar.gettarinfo(str(path), arcname=name)
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mtime = epoch
            info.mode = 0o755 if path.is_dir() else 0o644
            info.pax_headers = {}
            if path.is_dir():
                tar.addfile(info)
            else:
                with open(path, 'rb') as handle:
                    tar.addfile(info, handle)
    with open(output, 'wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=9) as zipped:
        zipped.write(buffer.getvalue())


def check_paths(target):
    """No build-machine paths may leak into the shipped files."""
    needles = [str(ROOT).encode(), str(Path.home()).encode()]
    for path in target.rglob('*'):
        if path.is_file() and path.suffix in ('.wasm', '.js', '.data', '.html', '.md'):
            data = path.read_bytes()
            for needle in needles:
                if needle in data:
                    raise SystemExit(f'{path.relative_to(target)} contains a build path ({needle.decode()})')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dsp', type=Path, default=ROOT / 'build-wclap/wclap/module.wasm')
    parser.add_argument('--ui', type=Path, default=ROOT / 'build-web/wclap-ui')
    parser.add_argument('--output', type=Path, default=ROOT / 'build-wclap')
    args = parser.parse_args()
    target = args.output / NAME
    epoch = assemble(target, args.dsp, args.ui)
    check_paths(target)
    tarball = args.output / (NAME + '.tar.gz')
    archive(target, tarball, epoch)
    digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
    files = [p for p in target.rglob('*') if p.is_file()]
    summary = {'bundle': str(target), 'archive': str(tarball), 'sha256': digest,
               'archiveBytes': tarball.stat().st_size, 'files': len(files),
               'bytes': sum(p.stat().st_size for p in files),
               'moduleSha256': hashlib.sha256((target / 'module.wasm').read_bytes()).hexdigest()}
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
