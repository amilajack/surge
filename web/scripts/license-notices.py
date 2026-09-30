#!/usr/bin/env python3
"""Collect reviewed original notices; refuse changed sources or extraction ranges."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[2]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def render(root=ROOT, inventory=None):
    root = root.resolve()
    inventory = inventory or json.loads((root / 'web/licenses/inventory.json').read_text())
    status = inventory.get('status')
    if inventory.get('schema') != 1 or status not in ('partial-audit', 'coverage-audited'):
        raise ValueError('Review notice inventory schema/status')
    if not inventory.get('notices'):
        raise ValueError('Missing notice documents')
    if status == 'partial-audit':
        if not inventory.get('remaining'):
            raise ValueError('A partial audit must state its outstanding scope')
        parts = ['SURGE XT — DEPENDENCY NOTICES (PARTIAL AUDIT)\n',
                 'This bundle is incomplete and must not be treated as release clearance.\n',
                 'Remaining audit work:\n' + '\n'.join('- ' + item for item in inventory['remaining'])]
    else:
        # Coverage audited: nothing outstanding, but its limits stay visible.
        if inventory.get('remaining') or not inventory.get('limitations'):
            raise ValueError('A coverage audit lists no remaining work and states its limitations')
        parts = ['SURGE XT — THIRD-PARTY NOTICES\n', inventory['scope'] + '\n',
                 'Limitations:\n' + '\n'.join('- ' + item for item in inventory['limitations'])]
    seen = set()
    for item in inventory['notices']:
        source = item['source']
        path = (root / source).resolve()
        if Path(source).is_absolute() or not path.is_relative_to(root) or source in seen:
            raise ValueError('Invalid or duplicate notice source: ' + source)
        seen.add(source)
        data = path.read_bytes()
        if not data or len(data) != item['bytes'] or digest(data) != item['sha256']:
            raise ValueError('Notice source changed: ' + source)
        if 'extract' in item and 'extracts' in item:
            raise ValueError('Ambiguous notice extraction: ' + source)
        selections = item.get('extracts', [item['extract']] if 'extract' in item else [])
        if 'extracts' in item and not selections:
            raise ValueError('Empty notice extraction: ' + source)
        texts = []
        for selection in selections:
            start, end = selection['startByte'], selection['endByte']
            if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(data):
                raise ValueError('Invalid notice range: ' + source)
            excerpt = data[start:end]
            if digest(excerpt) != selection['sha256']:
                raise ValueError('Notice extraction changed: ' + source)
            encoding = selection.get('encoding', 'utf-8')
            if encoding not in ('utf-8', 'utf-16-be'):
                raise ValueError('Unreviewed notice encoding: ' + source)
            texts.append(excerpt.decode(encoding))
        if not selections:
            texts.append(data.decode('utf-8'))
        parts.append('\n' + '=' * 72 + '\n' + item['component'] + '\nSource: ' + source + '\n\n' + '\n\n'.join(texts))
    return '\n'.join(parts) + '\n'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    content = render()  # Validate every source before touching the output.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=args.output.parent,
                                         prefix='.notices-', delete=False) as target:
            temporary = Path(target.name)
            target.write(content)
        os.replace(temporary, args.output)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    print('Collected notice bundle: ' + str(args.output))

if __name__ == '__main__':
    main()
