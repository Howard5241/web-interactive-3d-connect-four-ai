"""Puzzle bank and bounded V3 background generation.

Every recorded solver decision must be the sole winning move, or the sole draw
when all alternatives lose. Lines end on a solver turn and may stop before mate.
Categories measure actual playable decisions: steps = (len(solution) + 1) // 2.

Legacy two-line history/solution files and three-line board/history/solution
files remain readable. Their old mate label is retained as metadata only.
V3 appends versioned records to generated_v3.jsonl with history, solution, goal,
steps and canonical position identity; mate=None because WDL proves no distance.
A separate engine step writes an objective `distance` (plies to the end of the
game under perfect play, unrelated to steps) on records it can prove in time.
That key is optional and currently unread here -- surface it by carrying it into
the dict built in parse_generated_file.
"""

import os
import re
import glob
import time
import random
import hashlib
import json
import math
import threading
import subprocess

_HEX_TOKEN = re.compile(r'^[0-9a-fA-F]+$')

# Difficulty groups count actual moves to find, for both legacy and V3 puzzles.
CATEGORIES = [
    {'key': 'quick',   'label': 'Quick puzzle',  'range_label': '1–3 moves to find',  'min': 1,  'max': 3},
    {'key': 'medium',  'label': 'Medium puzzle', 'range_label': '4–5 moves to find',  'min': 4,  'max': 5},
    {'key': 'long',    'label': 'Long puzzle',   'range_label': '6–11 moves to find', 'min': 6,  'max': 11},
    {'key': 'endgame', 'label': 'Endgame',       'range_label': '12+ moves to find',  'min': 12, 'max': None},
]

CATEGORY_BY_KEY = {c['key']: c for c in CATEGORIES}


def category_for_mate(mate):
    """Compatibility name: classify a playable step count (not mate distance)."""
    for c in CATEGORIES:
        if mate >= c['min'] and (c['max'] is None or mate <= c['max']):
            return c['key']
    return None


def _is_board_code_line(line):
    """A board-code header is exactly two hex tokens, at least one longer than a
    move value (moves are 0-15, i.e. <= 2 chars). Move lines never match this."""
    toks = line.split()
    if len(toks) != 2:
        return False
    if not all(_HEX_TOKEN.match(t) for t in toks):
        return False
    return any(len(t) > 2 for t in toks)


def _parse_moves(line):
    """Parse a whitespace-separated list of integers, or None if malformed."""
    out = []
    for t in line.split():
        try:
            out.append(int(t))
        except ValueError:
            return None
    return out


def _mate_from_filename(path):
    """The objective mate length k encoded in a bank file name (mate_in_<k>.txt /
    'mate length <k>.txt'), or None if the name carries no number."""
    m = re.search(r'(\d+)', os.path.basename(path))
    return int(m.group(1)) if m else None


def _make_puzzle(history, solution, mate=None):
    if history is None or solution is None:
        return None
    if not solution or len(solution) % 2 == 0:      # solution is w1 r1 ... wk => odd length
        return None
    if any(not (0 <= m < 16) for m in solution):
        return None
    if any(not (0 <= m < 16) for m in history):
        return None
    # The label is the OBJECTIVE mate distance from the file name; the (truncated) solution
    # length is only a fallback for files whose name carries no number (e.g. user uploads).
    if mate is None:
        mate = (len(solution) + 1) // 2
    return {
        'history': history,
        'solution': solution,
        'mate': mate,
        'steps': (len(solution) + 1) // 2,
        'goal': 'win',
    }


def puzzle_id(puzzle):
    """Stable short id for a puzzle (used to avoid re-serving the same one)."""
    if puzzle.get('position'):
        return hashlib.md5(puzzle['position'].encode('ascii')).hexdigest()[:12]
    key = ' '.join(map(str, puzzle['history'])) + '|' + ' '.join(map(str, puzzle['solution']))
    return hashlib.md5(key.encode('utf-8')).hexdigest()[:12]


def parse_puzzle_file(path):
    """Parse one .txt file into a list of puzzle dicts, handling both formats."""
    try:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            raw = [ln.strip() for ln in f]
    except OSError:
        return []

    file_mate = _mate_from_filename(path)   # objective label for every puzzle in this file
    puzzles = []
    i, n = 0, len(raw)
    while i < n:
        if raw[i] == '':
            i += 1
            continue
        if _is_board_code_line(raw[i]):
            # new 3-line block: code / history (possibly empty) / solution
            if i + 2 >= n:
                break
            history = [] if raw[i + 1] == '' else _parse_moves(raw[i + 1])
            solution = _parse_moves(raw[i + 2])
            i += 3
        else:
            # old 2-line block: history / solution
            if i + 1 >= n:
                break
            history = _parse_moves(raw[i])
            solution = _parse_moves(raw[i + 1])
            i += 2
        p = _make_puzzle(history, solution, file_mate)
        if p:
            puzzles.append(p)
    return puzzles


def parse_generated_file(path):
    """Read complete V3 records; interrupted/malformed append records are ignored.

    Unlike the legacy format, steps measure verified playable decisions, not mate
    distance. Replaying below checks shape/legality, NOT the engine's WDL proof.
    """
    puzzles = []
    try:
        with open(path, encoding='utf-8') as source:
            for line in source:
                try:
                    data = json.loads(line)
                    if not isinstance(data, dict) or data.get('version') != 3:
                        continue
                    history, solution = data.get('history'), data.get('solution')
                    if not isinstance(history, list) or not isinstance(solution, list):
                        continue
                    if any(type(m) is not int for m in history + solution):
                        continue
                    if len(history) + len(solution) > 64 or data.get('goal') not in ('win', 'draw'):
                        continue
                    puzzle = _make_puzzle(history, solution)
                    if not puzzle or data.get('steps') != puzzle['steps']:
                        continue
                    heights = [0] * 16
                    for move in history + solution:
                        heights[move] += 1
                    if max(heights) > 4:
                        continue
                    position = data.get('position')
                    if not isinstance(position, str) or not re.fullmatch(r'[0-9a-f]{1,16}:[0-9a-f]{1,16}', position):
                        continue
                    # `position` is the canonical dedup key (a reflected representative in
                    # [0]:[1] order) and must never be pasted as a board. `board` is the real
                    # root in solver order; older records predate it, so it stays optional.
                    board = data.get('board')
                    if not isinstance(board, str) or not re.fullmatch(
                            r'[0-9a-f]{1,16} [0-9a-f]{1,16}', board):
                        board = None
                    puzzle.update(version=3, position=position, board=board,
                                  goal=data['goal'], mate=None)
                    puzzles.append(puzzle)
                except (ValueError, TypeError):
                    continue
    except OSError:
        pass
    return puzzles


class PuzzleBank:
    """Thread-safe bank, bucketed by playable length; by_mate is a legacy name."""

    def __init__(self, directory):
        self.directory = directory
        self._lock = threading.Lock()
        self.by_mate = {}      # k -> list[puzzle dict]
        self.reload()

    def reload(self):
        by_mate = {}
        seen = set()
        paths = sorted(glob.glob(os.path.join(self.directory, '*.txt')))
        paths += sorted(glob.glob(os.path.join(self.directory, '*.jsonl')))
        for path in paths:
            parser = parse_generated_file if path.endswith('.jsonl') else parse_puzzle_file
            for p in parser(path):
                key = p.get('position') or (tuple(p['history']), tuple(p['solution']))
                if key in seen:
                    continue
                seen.add(key)
                by_mate.setdefault(p['steps'], []).append(p)
        with self._lock:
            self.by_mate = by_mate

    def counts(self):
        with self._lock:
            return {k: len(v) for k, v in sorted(self.by_mate.items())}

    def total(self):
        with self._lock:
            return sum(len(v) for v in self.by_mate.values())

    def count_for(self, mate):
        with self._lock:
            return len(self.by_mate.get(mate, []))

    def get_random(self, mate, exclude_ids=None):
        """Return a random puzzle of the given mate length, preferring ones whose
        id is not in `exclude_ids`. Returns None if the bucket is empty."""
        return self.get_random_range(mate, mate, exclude_ids)

    def get_random_range(self, min_mate, max_mate, exclude_ids=None):
        """Return a random puzzle whose mate length is in [min_mate, max_mate]
        (max_mate None means unbounded), preferring ids not in `exclude_ids`.

        Selection is TWO-STAGE: first pick a mate length uniformly at random from
        the ones present in the range, then pick a puzzle uniformly within that
        length. This gives every mate length the SAME chance of appearing, so a
        file with an abundance of puzzles (e.g. lots of mate-in-1s) cannot
        overwhelm the rarer lengths in the same category. To still avoid repeats,
        the mate length is drawn from those that have at least one puzzle not in
        `exclude_ids` (falling back to all present lengths only if every puzzle in
        the range has been served). Returns None if the range is empty."""
        exclude_ids = set(exclude_ids or [])
        with self._lock:
            in_range = {
                k: list(lst) for k, lst in self.by_mate.items()
                if lst and k >= min_mate and (max_mate is None or k <= max_mate)
            }
        if not in_range:
            return None
        # Prefer mate lengths that still have an unseen puzzle so equal-per-length
        # sampling doesn't get stuck re-serving one length's leftovers.
        fresh_lengths = [
            k for k, lst in in_range.items()
            if any(puzzle_id(p) not in exclude_ids for p in lst)
        ]
        mate = random.choice(fresh_lengths if fresh_lengths else list(in_range))
        bucket = in_range[mate]
        fresh = [p for p in bucket if puzzle_id(p) not in exclude_ids]
        chosen = random.choice(fresh if fresh else bucket)
        out = dict(chosen)
        out['id'] = puzzle_id(chosen)
        return out

    def category_counts(self):
        """Total available puzzles per category key (see CATEGORIES)."""
        per_mate = self.counts()
        out = {c['key']: 0 for c in CATEGORIES}
        for mate, n in per_mate.items():
            key = category_for_mate(mate)
            if key is not None:
                out[key] += n
        return out

    def rewrite_files(self):
        """Persist the (deduplicated) in-memory bank back to disk, one file per mate
        length, so continuous background generation doesn't grow the files unbounded
        with duplicates. Writes 2-line history/solution blocks (the parser reads both
        formats). Safe to call only when no generation subprocess is writing."""
        with self._lock:
            by_mate = {}
            for bucket in self.by_mate.values():
                for puzzle in bucket:
                    if puzzle.get('version') != 3:
                        by_mate.setdefault(puzzle['mate'], []).append(puzzle)
        for path in glob.glob(os.path.join(self.directory, 'mate_in_*.txt')):
            try:
                os.remove(path)
            except OSError:
                pass
        for k, puzzles in by_mate.items():
            path = os.path.join(self.directory, 'mate_in_%d.txt' % k)
            try:
                with open(path, 'w', encoding='utf-8') as f:
                    for p in puzzles:
                        f.write(' '.join(map(str, p['history'])) + '\n')
                        f.write(' '.join(map(str, p['solution'])) + '\n\n')
            except OSError:
                pass


class GenerationManager:
    """One low-priority worker, bounded batches, immediate stop, 26–28-piece starts.

    A candidate's root and all continuation probes share candidate_seconds.
    Unknown proofs never become puzzles. Default minimum length is two decisions.
    """

    PIECE_RANGES = [(26, 28)]

    def __init__(self, bank, exe_path, output_dir, seeds=400, batch_seconds: float = 120,
                 candidate_seconds: float = 20, min_steps=2, distance_seconds: float = 2):
        self.bank = bank
        self.exe_path = exe_path
        self.output_dir = output_dir
        self.seeds = seeds
        self.batch_seconds = batch_seconds
        if (not math.isfinite(candidate_seconds) or not math.isfinite(batch_seconds)
            or not 0 < candidate_seconds <= 120 or batch_seconds <= 0
            or not 1 <= seeds <= 100000 or not 1 <= min_steps <= 32
            or not math.isfinite(distance_seconds) or not 0 <= distance_seconds <= 120):
            raise ValueError('Invalid generation time budget')
        self.candidate_seconds = candidate_seconds
        self.min_steps = min_steps
        # Per-puzzle allowance for the engine's objective-distance step, which
        # runs after a puzzle is proved and writes the record's `distance`.
        # Zero skips it, and those records simply carry no distance.
        self.distance_seconds = distance_seconds
        self._control_lock = threading.Lock()  # serialize start/stop, not status reads
        self._lock = threading.Lock()
        self._proc = None                 # currently running engine subprocess (if any)
        self._stop = threading.Event()
        self._thread = None
        self._status = {
            'running': False, 'session_added': 0, 'batches': 0,
            'message': 'idle', 'started_at': None,
        }

    def status(self):
        with self._lock:
            s = dict(self._status)
        s['counts'] = self.bank.counts()
        s['category_counts'] = self.bank.category_counts()
        s['total'] = self.bank.total()
        return s

    def start(self):
        """Begin continuous background generation. Idempotent while already running."""
        with self._control_lock:
            with self._lock:
                running = self._status['running']
            # Do not recursively acquire _lock through status() (old deadlock).
            if running:
                return False, self.status()
            prev = self._thread
            if prev is not None and prev.is_alive():
                prev.join(timeout=5)
                if prev.is_alive():
                    return False, self.status()  # never clear the old worker's stop event
            self._stop.clear()
            with self._lock:
                self._status = {
                    'running': True, 'session_added': 0, 'batches': 0,
                    'message': 'Generating V3 puzzles (26–28 pieces)...',
                    'started_at': time.time(),
                }
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()
        return True, self.status()

    def stop(self):
        """Stop the loop and kill any in-flight batch immediately."""
        with self._control_lock:
            self._stop.set()
            with self._lock:
                proc = self._proc
            if proc is not None:
                try:
                    proc.kill()
                except OSError:
                    pass
            with self._lock:
                self._status['running'] = False
                self._status['message'] = 'Paused. +%d puzzles this session.' % self._status['session_added']
        return self.status()

    def _loop(self):
        try:
            while not self._stop.is_set():
                before = self.bank.total()
                with self._lock:
                    idx = self._status['batches']
                min_p, max_p = self.PIECE_RANGES[idx % len(self.PIECE_RANGES)]
                self._run_batch(min_p, max_p)
                self.bank.reload()  # keep complete records even after an explicit stop
                if self._stop.is_set():
                    break
                added = max(0, self.bank.total() - before)
                with self._lock:
                    self._status['session_added'] += added
                    self._status['batches'] += 1
                    self._status['message'] = (
                        'Generating in the background... +%d puzzles this session'
                        % self._status['session_added'])
                # V3 deduplicates canonical positions before writing. Do not rewrite
                # the whole bank (or delete legacy data) every five batches.
        except Exception as exc:  # report errors instead of a silent daemon crash
            with self._lock:
                self._status['message'] = 'Generation failed: %s' % exc
        finally:
            with self._lock:
                self._status['running'] = False

    def _run_batch(self, min_pieces=26, max_pieces=28):
        if self._stop.is_set():
            return
        if not os.path.exists(self.exe_path):
            self._stop.set()
            with self._lock:
                self._status['message'] = 'Engine executable not found: %s' % self.exe_path
            return
        try:
            os.makedirs(self.output_dir, exist_ok=True)
            proc = subprocess.Popen(
                # The engine's arguments are positional, so reaching the distance
                # allowance means restating the two defaults before it: seed 0
                # still means "choose one at random", and min playable length has
                # always defaulted to min_steps.
                [self.exe_path, 'genpuzzle', str(self.min_steps), str(self.seeds),
                 os.path.abspath(self.output_dir), str(self.batch_seconds),
                 str(min_pieces), str(max_pieces), str(self.candidate_seconds),
                 '0', str(self.min_steps), str(self.distance_seconds)],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                creationflags=getattr(subprocess, 'BELOW_NORMAL_PRIORITY_CLASS', 0),
            )
        except Exception as exc:  # noqa: BLE001
            self._stop.set()
            with self._lock:
                self._status['message'] = 'Generation failed: %s' % exc
            return
        with self._lock:
            self._proc = proc
        try:
            # Close the stop-before-_proc-publication race. communicate drains the
            # pipe so progress output can never deadlock the generator.
            if self._stop.is_set():
                proc.kill()
            output, _ = proc.communicate(timeout=self.batch_seconds + 5)
            if not self._stop.is_set():
                if proc.returncode:
                    raise RuntimeError('engine exit %s: %s' % (proc.returncode, output[-500:]))
                with self._lock:
                    self._status['last_batch'] = output[-2000:]
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise RuntimeError('engine exceeded its batch deadline') from None
        finally:
            with self._lock:
                self._proc = None