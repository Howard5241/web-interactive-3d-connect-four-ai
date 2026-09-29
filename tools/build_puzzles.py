"""Writes public/puzzles.json from puzzles/ for the site's puzzle mode.

Puzzles are grouped by objective mate length (puzzle_bank.mate_length). Each is
[id, history, solution, goal] with the moves as hex digits, one per move.

Usage: python tools/build_puzzles.py
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from puzzle_bank import CATEGORIES, PuzzleBank  # noqa: E402


def main():
    bank = PuzzleBank(os.path.join(ROOT, 'puzzles'))
    by_mate = {}
    for mate, puzzles in sorted(bank.by_mate.items()):
        by_mate[str(mate)] = [
            [p['id'],
             ''.join(f'{m:x}' for m in p['history']),
             ''.join(f'{m:x}' for m in p['solution']),
             'w' if p['goal'] == 'win' else 'd']
            for p in sorted(puzzles, key=lambda p: p['id'])
        ]
    out = os.path.join(ROOT, 'public', 'puzzles.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'categories': CATEGORIES, 'by_mate': by_mate}, f, separators=(',', ':'))
    print(f'{out}: {bank.total()} puzzles, {bank.category_counts()}')


if __name__ == '__main__':
    main()
