#!/usr/bin/env python3
"""Check that everything compiled into the browser application, and every shipped
asset, is covered by an indexed notice (web/licenses/coverage.json). This is a
mechanical coverage audit; it does not decide license compatibility."""
import argparse
import json
from pathlib import Path
import shlex
import sys

ROOT = Path(__file__).resolve().parents[2]


def dependency_files(build):
    """Compiler dependency files of every object linked into surge-xt-browser."""
    executable = build / 'src/surge-web/juce/CMakeFiles/surge-xt-browser.dir'
    directories = [executable]
    for archive in shlex.split((executable / 'linkLibs.rsp').read_text()):
        if not archive.endswith('.a'):
            continue
        path = (executable.parents[1] / archive).resolve()
        found = list(path.parent.glob(f'CMakeFiles/{path.name[3:-2]}.dir'))
        if not found:
            # zstd builds from its own nested CMake project.
            found = list(path.parents[1].glob(f'**/CMakeFiles/{path.name[3:-2]}*.dir'))
        if not found:
            raise SystemExit(f'No object directory for {archive}')
        directories.extend(found)
    return [f for d in directories for f in sorted(d.rglob('*.o.d'))]


def parse(text):
    """Make-style dependency list: backslash-newline continuations, escaped spaces."""
    body = text.replace('\\\n', ' ').split(':', 1)[1]
    items, current, i = [], '', 0
    while i < len(body):
        c = body[i]
        if c == '\\' and i + 1 < len(body) and body[i + 1] == ' ':
            current += ' '; i += 2; continue
        if c.isspace():
            if current: items.append(current); current = ''
        else:
            current += c
        i += 1
    if current: items.append(current)
    return items


def normalize(path, build, root):
    path = path.resolve()
    if path.is_relative_to(build):
        return 'build-web/' + path.relative_to(build).as_posix()
    if path.is_relative_to(root):
        return path.relative_to(root).as_posix()
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', type=Path, default=ROOT / 'build-web')
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    build, root = args.build.resolve(), args.root.resolve()
    coverage = json.loads((ROOT / 'web/licenses/coverage.json').read_text())
    notices = json.loads((ROOT / 'web/licenses/inventory.json').read_text())['notices']
    components = {n['component'] for n in notices}
    sources = {n['source'] for n in notices}
    errors = []
    for rule in coverage['rules'] + coverage['assets']:
        errors += [f'Rule {rule["prefix"]} needs unindexed component {c}' for c in rule['components'] if c not in components]
    errors += [f'Linked runtime component is not indexed: {c}' for c in coverage['linkedRuntime'] if c not in components]

    def check(name, rules):
        rule = next((r for r in rules if name.startswith(r['prefix'])), None)
        if not rule:
            errors.append(f'No notice rule covers {name}')
        elif rule.get('perFile') and name not in sources:
            errors.append(f'No per-file notice for {name}')

    dependencies = set()
    for file in dependency_files(build):
        for item in parse(file.read_text()):
            path = Path(item) if item.startswith('/') else build / item
            name = normalize(path, build, root)
            if name is None:
                errors.append(f'Dependency outside the source tree and toolchain: {path} ({file.name})')
            else:
                dependencies.add(name)
    for name in sorted(dependencies):
        check(name, coverage['rules'])
    assets = sorted(p.relative_to(root).as_posix() for base in ('resources/data', 'resources/fonts', 'resources/fonts-fallback')
                    for p in (root / base).rglob('*') if p.is_file() and p.name != '.DS_Store')
    for name in assets:
        check(name, coverage['assets'])
    print(f'{len(dependencies)} compiled dependencies and {len(assets)} shipped assets checked')
    for error in errors:
        print(error, file=sys.stderr)
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
