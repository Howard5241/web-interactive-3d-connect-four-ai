"""Compile statistics about a V3 puzzle bank (generated_v3.jsonl).

Reads the bank through the same validating loader the web app uses
(`puzzle_bank.parse_generated_file`), replays every recorded line on an
independent bitboard model, and writes a summary report plus an optional
per-puzzle table.

Definitions used here, chosen to match the engine (`V3PuzzleGenerator.cpp`):

* A *threat* is a legal empty cell that completes four in a row for the mover.
  Cells that are not yet reachable (buried under an empty cell) never count.
* A solver move is **forcing** when it is not itself a win, leaves the solver
  with at least one legal immediate win, and the opponent's recorded reply
  occupies one of those winning cells -- i.e. it demanded an immediate block
  and got one. Everything else the solver plays is **non-forcing**, split into
  `winning` (the move ends the game), `threat_ignored` (the recorded reply did
  not block -- legal, because replies only have to preserve the outcome),
  `threat_at_line_end` (the line stops there, so nothing had to answer) and
  `quiet` (the move creates no immediate threat at all).
* A solver move is a **block** under the generator's `IsBlockingMove` rule: it
  fills one of the opponent's legal immediate winning cells, whether or not it
  also wins on the spot -- the move was forced either way. `decisive_steps` is
  `steps - blocks`, the free-decision count the generator ranks lines on and
  requires two of for any mate in 6 or more.

`distance` is the objective number of plies the game still lasts under perfect
play, so a win maps to "mate in (distance + 1) // 2" solver moves. It is
unrelated to `steps`, is optional in the record format, and is reported as
`unknown` where the generator could not prove one in time.

Usage:
    python puzzle_stats.py [BANK.jsonl] [--csv OUT.csv] [--text OUT.txt]
                           [--per-puzzle ROWS.csv] [--quiet]
"""

import argparse
import collections
import csv
import json
import os
import sys

from puzzle_bank import parse_generated_file, puzzle_id

COLUMNS = 16
CELLS = 64


def _geometry():
    """The 76 winning lines, and for each cell the other three cells of each
    line through it. Cell index is x + 4*y + 16*z, matching the C++ engine, so
    a column is `x + 4*y` and stacking adds 16 per level."""
    lines = []
    for dz in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                step = dx + 4 * dy + 16 * dz
                if step <= 0:
                    continue  # one orientation per line
                for z in range(4):
                    for y in range(4):
                        for x in range(4):
                            if not (0 <= x + 3 * dx < 4 and 0 <= y + 3 * dy < 4
                                    and 0 <= z + 3 * dz < 4):
                                continue
                            base = x + 4 * y + 16 * z
                            mask = 0
                            for i in range(4):
                                mask |= 1 << (base + i * step)
                            lines.append(mask)
    assert len(lines) == 76, len(lines)
    remainders = [[] for _ in range(CELLS)]
    for mask in lines:
        cells = mask
        while cells:
            bit = cells & -cells
            remainders[bit.bit_length() - 1].append(mask ^ bit)
            cells ^= bit
    return tuple(lines), tuple(tuple(r) for r in remainders)


LINES, REMAINDERS = _geometry()


def legal_cells(occupied):
    """Bitmask of the cells that can be played right now (one per open column)."""
    return ((occupied << COLUMNS) | 0xFFFF) & ~occupied & ((1 << CELLS) - 1)


def legal_wins(player, occupied):
    """Bitmask of legal cells that complete four in a row for `player`."""
    result = 0
    cells = legal_cells(occupied)
    while cells:
        bit = cells & -cells
        cells ^= bit
        for rest in REMAINDERS[bit.bit_length() - 1]:
            if rest & ~player == 0:
                result |= bit
                break
    return result


class Replay:
    """Board built by dropping pieces into columns, in engine bit layout.

    `pieces[1]` is the player who moved first, matching `ThreeDConnectFour`'s
    board indexing and the record's `board` field ("<player 1> <player 0>").
    """

    def __init__(self):
        self.pieces = [0, 0]
        self.heights = [0] * COLUMNS
        self.occupied = 0

    @property
    def side(self):
        """Index of the player to move (1 moves first, as in the engine)."""
        return 1 if bin(self.occupied).count('1') % 2 == 0 else 0

    def cell_for(self, column):
        """Cell a drop into `column` would occupy, or None if the column is full."""
        if not 0 <= column < COLUMNS or self.heights[column] >= 4:
            return None
        return column + COLUMNS * self.heights[column]

    def play(self, column):
        cell = self.cell_for(column)
        if cell is None:
            raise ValueError('illegal move: column %r' % (column,))
        side = self.side
        self.pieces[side] |= 1 << cell
        self.heights[column] += 1
        self.occupied |= 1 << cell
        return cell

    def board_code(self):
        return '%x %x' % (self.pieces[1], self.pieces[0])


def classify(puzzle):
    """Replay one puzzle and describe its line. Returns None if it cannot be
    replayed legally (a record the loader accepted but the rules reject)."""
    replay = Replay()
    try:
        for move in puzzle['history']:
            replay.play(move)
    except ValueError:
        return None

    solver = replay.side
    root_pieces = bin(replay.occupied).count('1')
    board_ok = puzzle.get('board') is None or puzzle['board'] == replay.board_code()

    counts = collections.Counter()
    solution = puzzle['solution']
    try:
        for index, move in enumerate(solution):
            mover = replay.side
            before_occupied = replay.occupied
            own_wins = legal_wins(replay.pieces[mover], before_occupied)
            foe_wins = legal_wins(replay.pieces[1 - mover], before_occupied)
            cell = replay.play(move)
            if mover != solver:
                continue  # opponent replies are not classified

            # IsBlockingMove: covering a cell the opponent would have won at is a
            # block whether or not the same move wins on the spot.
            if (foe_wins >> cell) & 1:
                counts['blocks'] += 1

            if (own_wins >> cell) & 1:
                counts['winning'] += 1
                continue
            threats = legal_wins(replay.pieces[mover], replay.occupied)
            if not threats:
                counts['quiet'] += 1
                continue
            if index + 1 >= len(solution):
                # The line is allowed to stop on a solver move; nobody had to answer.
                counts['threat_at_line_end'] += 1
                continue
            reply_cell = replay.cell_for(solution[index + 1])
            if reply_cell is not None and (threats >> reply_cell) & 1:
                counts['forcing'] += 1
            else:
                # Replies only have to preserve the outcome, so a lost opponent
                # may ignore a threat and simply be mated sooner.
                counts['threat_ignored'] += 1
    except ValueError:
        return None

    steps = puzzle['steps']
    distance = puzzle.get('distance')
    if puzzle['goal'] == 'draw':
        mate = 'draw'
    elif distance is None:
        mate = 'unknown'
    else:
        mate = 'mate in %d' % ((distance + 1) // 2)
    return {
        'id': puzzle_id(puzzle),
        'position': puzzle['position'],
        'goal': puzzle['goal'],
        'steps': steps,
        'moves': len(solution),
        'root_pieces': root_pieces,
        'distance': distance,
        'mate': mate,
        'forcing': counts['forcing'],
        'nonforcing': steps - counts['forcing'],
        'winning': counts['winning'],
        'threat_ignored': counts['threat_ignored'],
        'threat_at_line_end': counts['threat_at_line_end'],
        'quiet': counts['quiet'],
        'blocks': counts['blocks'],
        'decisive_steps': steps - counts['blocks'],
        'board_ok': board_ok,
    }


def _mate_order(bucket):
    """Sort key putting 'mate in N' in numeric order, then draw, then unknown."""
    if isinstance(bucket, str) and bucket.startswith('mate in '):
        return (0, int(bucket.split()[-1]))
    return (1, 0) if bucket == 'draw' else (2, 0)


def _numeric_order(bucket):
    """Sort key for integer buckets, with 'unknown' last."""
    return (1, 0) if bucket == 'unknown' else (0, bucket)


def _text_order(bucket):
    return (1, '') if bucket == 'unknown' else (0, bucket)


SECTIONS = [
    ('goal', 'Puzzles by goal', 'goal', _text_order),
    ('mate_category', 'Puzzles by mate category (from objective distance)', 'mate', _mate_order),
    ('moves', 'Puzzles by line length (moves in the recorded line)', 'moves', _numeric_order),
    ('steps', 'Puzzles by solver decisions (steps)', 'steps', _numeric_order),
    ('forcing_moves', 'Puzzles by number of forcing solver moves', 'forcing', _numeric_order),
    ('nonforcing_moves', 'Puzzles by number of non-forcing solver moves', 'nonforcing', _numeric_order),
    ('solver_blocks', 'Puzzles by number of forced blocks played by the solver', 'blocks', _numeric_order),
    ('decisive_steps', 'Puzzles by decisive steps (steps minus blocks)', 'decisive_steps', _numeric_order),
    ('distance', 'Puzzles by objective distance in plies', 'distance', _numeric_order),
    ('root_pieces', 'Puzzles by pieces on the board at the root', 'root_pieces', _numeric_order),
]


def summarize(rows):
    """Build {section key: [(bucket, count)]} for every distribution."""
    total = len(rows)
    report = collections.OrderedDict()
    for key, _label, field, order in SECTIONS:
        counts = collections.Counter(
            'unknown' if row[field] is None else row[field] for row in rows)
        report[key] = sorted(counts.items(), key=lambda item: order(item[0]))
    moves = collections.OrderedDict()
    for field in ('forcing', 'winning', 'threat_ignored', 'threat_at_line_end',
                  'quiet', 'blocks'):
        moves[field] = sum(row[field] for row in rows)
    moves['solver moves total'] = sum(row['steps'] for row in rows)
    moves['non-forcing total'] = moves['solver moves total'] - moves['forcing']
    report['_solver_moves'] = list(moves.items())
    report['_total'] = total
    return report


def write_csv(path, report, overview):
    with open(path, 'w', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['section', 'bucket', 'count', 'percent_of_puzzles'])
        total = report['_total'] or 1
        for name, value in overview:
            writer.writerow(['overview', name, value, ''])
        for key, _label, _field, _order in SECTIONS:
            for bucket, count in report[key]:
                writer.writerow([key, bucket, count, '%.2f' % (100.0 * count / total)])
        for name, count in report['_solver_moves']:
            writer.writerow(['solver_move_totals', name, count, ''])


def render_text(report, overview, source):
    total = report['_total'] or 1
    out = ['Puzzle bank statistics', '=' * 22, 'Source: %s' % source, '']
    width = max(len(name) for name, _ in overview)
    for name, value in overview:
        out.append('%-*s  %s' % (width, name, value))
    for key, label, _field, _order in SECTIONS:
        out.extend(['', label, '-' * len(label)])
        buckets = report[key]
        width = max([len(str(b)) for b, _ in buckets] + [6])
        for bucket, count in buckets:
            out.append('%-*s  %6d  %5.1f%%' % (width, bucket, count, 100.0 * count / total))
    label = 'Solver move totals across the whole bank'
    out.extend(['', label, '-' * len(label)])
    width = max(len(name) for name, _ in report['_solver_moves'])
    for name, count in report['_solver_moves']:
        out.append('%-*s  %6d' % (width, name, count))
    return '\n'.join(out) + '\n'


PER_PUZZLE_FIELDS = ['id', 'position', 'goal', 'steps', 'moves', 'distance', 'mate',
                     'forcing', 'nonforcing', 'winning', 'threat_ignored',
                     'threat_at_line_end', 'quiet', 'blocks', 'decisive_steps',
                     'root_pieces']


def write_per_puzzle(path, rows):
    with open(path, 'w', encoding='utf-8', newline='') as stream:
        writer = csv.DictWriter(stream, PER_PUZZLE_FIELDS, extrasaction='ignore')
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def count_raw_lines(path):
    """Physical lines, and how many of them are JSON objects, so the report can
    show what the loader dropped (blank separators, truncated appends)."""
    lines = json_lines = 0
    with open(path, encoding='utf-8') as stream:
        for line in stream:
            if not line.strip():
                continue
            lines += 1
            try:
                if isinstance(json.loads(line), dict):
                    json_lines += 1
            except ValueError:
                pass
    return lines, json_lines


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('bank', nargs='?',
                        default=os.path.join(here, 'puzzles', 'generated_v3.jsonl'),
                        help='path to the V3 JSONL bank')
    parser.add_argument('--csv', help='summary CSV (default: ./puzzle_stats.csv)')
    parser.add_argument('--text', help='summary text report (default: ./puzzle_stats.txt)')
    parser.add_argument('--per-puzzle', dest='per_puzzle',
                        help='also write one CSV row per puzzle to this path')
    parser.add_argument('--quiet', action='store_true', help='do not print the report')
    args = parser.parse_args(argv)

    if not os.path.exists(args.bank):
        parser.error('no such bank: %s' % args.bank)
    # Default into the working directory, never beside the bank: PuzzleBank globs
    # that directory for *.txt and *.jsonl, so a report dropped there would be
    # offered to the loader as if it were puzzle data.
    csv_path = args.csv or 'puzzle_stats.csv'
    text_path = args.text or 'puzzle_stats.txt'

    raw_lines, json_lines = count_raw_lines(args.bank)
    puzzles = parse_generated_file(args.bank)
    rows, unreplayable = [], 0
    for puzzle in puzzles:
        row = classify(puzzle)
        if row is None:
            unreplayable += 1
            continue
        rows.append(row)

    report = summarize(rows)
    overview = [
        ('puzzles', len(rows)),
        ('records accepted by the loader', len(puzzles)),
        ('json lines in file', json_lines),
        ('non-empty lines in file', raw_lines),
        ('records the loader rejected', json_lines - len(puzzles)),
        ('records that could not be replayed', unreplayable),
        ('records whose board field disagrees with the replay',
         sum(1 for row in rows if not row['board_ok'])),
        ('distinct canonical positions', len({row['position'] for row in rows})),
        ('puzzles with a proved distance', sum(1 for row in rows if row['distance'] is not None)),
    ]

    write_csv(csv_path, report, overview)
    text = render_text(report, overview, os.path.abspath(args.bank))
    with open(text_path, 'w', encoding='utf-8') as stream:
        stream.write(text)
    if args.per_puzzle:
        write_per_puzzle(args.per_puzzle, rows)
    if not args.quiet:
        sys.stdout.write(text)
        sys.stdout.write('\nWrote %s\nWrote %s\n' % (csv_path, text_path))
        if args.per_puzzle:
            sys.stdout.write('Wrote %s\n' % args.per_puzzle)
    return 0


if __name__ == '__main__':
    sys.exit(main())
