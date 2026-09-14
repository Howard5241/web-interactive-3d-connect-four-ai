"""Apply the bank curation rules to a V3 puzzle bank, deleting what fails.

These are the same rules the generator enforces before it writes a record
(`V3PuzzleGenerator::MeetsBankRules` / `FreeSolverMoves`); this script exists to
clean a bank that predates them, or one grown by an older engine build. A puzzle
must ask for work in proportion to how long its mate is:

    mate in 2      exactly 2 steps       (the whole mate, or it is not the puzzle)
    mate in 3      exactly 3 steps
    mate in 4-5    at least 3 steps
    mate in 6-10   at least 5 steps, and >= 2 free solver moves
    mate in 11+    at least 7 steps, and >= 2 free solver moves

`mate` is the objective mate length in solver moves -- `(distance + 1) // 2` for
a proved win, falling back to the recorded line length where there is no mate to
measure (a draw, or a distance the engine never proved), exactly as
`puzzle_bank.mate_length` does when serving.

A *free* solver move is one that does NOT land on a cell where the opponent
could have won immediately. A move that blocks and wins at the same time counts
as a block: the solver still only had to answer a threat.

Usage:
    python puzzle_filter.py [BANK.jsonl] [--apply] [--backup PATH]

Prints the per-category damage report and changes nothing without --apply.
"""

import argparse
import collections
import json
import os
import shutil
import sys

from puzzle_stats import Replay, legal_wins

# (upper bound on mate length, minimum steps, minimum free solver moves)
RULES = [(2, 2, 0), (3, 3, 0), (5, 3, 0), (10, 5, 2), (None, 7, 2)]


def rule_for(mate):
    """The (label, min_steps, min_free) rule a mate length falls under, where
    min_steps is exact for the two shortest mates -- a mate in 2 shown in one
    step is a different puzzle, not a shorter one."""
    for index, (upper, min_steps, min_free) in enumerate(RULES):
        if upper is None or mate <= upper:
            label = ('mate in %d' % upper if min_steps == upper
                     else 'mate in %d-%d' % ((RULES[index - 1][0] + 1), upper) if upper
                     else 'mate in %d+' % (RULES[index - 1][0] + 1))
            return label, min_steps, min_free
    raise AssertionError('unreachable: RULES ends with an open bucket')


def measure(record):
    """(mate length, steps, free solver moves) for one record, or None if the
    line does not replay legally."""
    replay = Replay()
    try:
        for move in record['history']:
            replay.play(move)
        solver = replay.side
        free = 0
        for move in record['solution']:
            mover = replay.side
            threatened = legal_wins(replay.pieces[1 - mover], replay.occupied)
            cell = replay.play(move)
            if mover == solver and not (threatened >> cell) & 1:
                free += 1
    except ValueError:
        return None
    steps = (len(record['solution']) + 1) // 2
    distance = record.get('distance')
    mate = ((distance + 1) // 2 if record.get('goal') == 'win'
            and type(distance) is int and distance > 0 else steps)
    return mate, steps, free


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('bank', nargs='?',
                        default=os.path.join(here, 'puzzles', 'generated_v3.jsonl'))
    parser.add_argument('--apply', action='store_true',
                        help='rewrite the bank; without it nothing is written')
    parser.add_argument('--backup', help='copy the bank here before rewriting it')
    args = parser.parse_args(argv)

    kept, total, deleted = [], collections.Counter(), collections.Counter()
    reasons = collections.Counter()
    with open(args.bank, encoding='utf-8', newline='') as stream:
        for line in stream:
            if not line.strip():
                continue
            record = json.loads(line)
            measured = measure(record)
            if measured is None:          # unreplayable: leave it for the loader to reject
                kept.append(line.rstrip('\n'))
                continue
            mate, steps, free = measured
            label, min_steps, min_free = rule_for(mate)
            exact = min_steps if label.count('-') == 0 and '+' not in label else None
            total[label] += 1
            if (steps != exact if exact is not None else steps < min_steps):
                deleted[label] += 1
                reasons[(label, 'too few steps')] += 1
            elif free < min_free:
                deleted[label] += 1
                reasons[(label, 'fewer than %d free solver moves' % min_free)] += 1
            else:
                kept.append(line.rstrip('\n'))

    print('%-14s %7s %8s %7s' % ('category', 'total', 'deleted', 'kept'))
    for label in [rule_for(m)[0] for m in (2, 3, 5, 10, 11)]:
        print('%-14s %7d %8d %7d' % (label, total[label], deleted[label],
                                     total[label] - deleted[label]))
    print('%-14s %7d %8d %7d' % ('TOTAL', sum(total.values()), sum(deleted.values()),
                                 sum(total.values()) - sum(deleted.values())))
    for (label, reason), count in sorted(reasons.items()):
        print('   %-14s %-40s %5d' % (label, reason, count))

    if not args.apply:
        print('\nDry run: nothing written. Pass --apply to rewrite the bank.')
        return 0
    if args.backup:
        shutil.copy2(args.bank, args.backup)
        print('\nBacked up to %s' % args.backup)
    with open(args.bank, 'w', encoding='utf-8', newline='') as stream:
        stream.write('\n'.join(kept) + '\n')
    print('Rewrote %s with %d records.' % (args.bank, len(kept)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
