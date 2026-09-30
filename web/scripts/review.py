#!/usr/bin/env python3
"""Bookkeeping for web/parity/reviews.json. It never decides that a review holds.

  review.py list SOURCE             unreviewed entries in a source file, with labels
  review.py refresh SOURCE...       record current digests on existing reviews after
                                    their cited evidence has been re-run and still holds
  review.py add BATCH.json          add or replace reviews; each item names an entry by
                                    "id", or by "source" plus "labelHint" (and "line"
                                    when a hint repeats). Digests come from the inventory.

Run web/scripts/feature-inventory.py afterwards; it enforces the review rules.
"""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
INVENTORY = ROOT / 'web/parity/source-inventory.json'
REVIEWS = ROOT / 'web/parity/reviews.json'
FIELDS = ('status', 'capability', 'reason', 'portableAlternative', 'browserEquivalent',
          'runtimeExpansion', 'evidence')


def load():
    return json.loads(INVENTORY.read_text()), json.loads(REVIEWS.read_text())


def save(reviews):
    REVIEWS.write_text(json.dumps(reviews, indent=2, ensure_ascii=False) + '\n')


def resolve(inventory, item):
    if 'id' in item:
        return item['id']
    matches = [e for e in inventory['entries'] if e['source'] == item['source'] and
               e.get('labelHint') == item['labelHint'] and ('line' not in item or e['line'] == item['line'])]
    if len(matches) != 1:
        sys.exit(f'{len(matches)} entries match {item}')
    return matches[0]['id']


def main():
    inventory, reviews = load()
    command, *args = sys.argv[1:] or ['help']
    if command == 'list':
        for e in inventory['entries']:
            if e['source'] == args[0] and e['id'] not in reviews:
                print(f"{e['line']:>5} {e['kind']:<22} {e.get('labelHint', e['id'].split(':')[-1])}"
                      f"{'  [runtime expansion]' if e.get('requiresRuntimeExpansion') else ''}")
    elif command == 'refresh':
        for source in args:
            digest = inventory['sources'][source]
            for identifier, review in reviews.items():
                if identifier.startswith(source + ':'):
                    review['sourceDigest'] = digest
        save(reviews)
    elif command == 'add':
        for item in json.loads(Path(args[0]).read_text()):
            identifier = resolve(inventory, item)
            entry = next(e for e in inventory['entries'] if e['id'] == identifier)
            reviews[identifier] = {'status': item['status'], 'sourceDigest': inventory['sources'][entry['source']],
                                   **{k: item[k] for k in FIELDS[1:] if k in item}}
        save(reviews)
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
