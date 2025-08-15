"""Cleanup script to remove legacy JSON persistence files safely.

Run manually AFTER verifying DB has required data.
It will list files and prompt for confirmation unless --yes provided.
"""
from __future__ import annotations
import argparse
from pathlib import Path

LEGACY_FILES = [
    Path('data/users.json'),
    Path('data/achievements.json'),
    Path('data/items.json'),
    Path('data/loot_boxes.json'),
]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--yes', action='store_true', help='Delete without interactive prompt')
    args = parser.parse_args()

    existing = [p for p in LEGACY_FILES if p.exists()]
    if not existing:
        print('No legacy files present.')
        return
    print('Legacy files detected:')
    for p in existing:
        print(' -', p)
    if not args.yes:
        resp = input('Delete these files? type YES to confirm: ')
        if resp.strip().upper() != 'YES':
            print('Aborted.')
            return
    for p in existing:
        try:
            p.unlink()
            print(f'Deleted {p}')
        except Exception as e:
            print(f'Failed deleting {p}: {e}')
    print('Cleanup complete.')

if __name__ == '__main__':
    main()
