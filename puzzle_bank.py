"""
Puzzle bank + background generation for the web app's Puzzle Mode.

A *puzzle* is stored as {'history': [...columns...], 'solution': [w1, r1, w2, r2, ...]}
where the `wi` are the moves the solver must find and the `ri` are the opponent's
replies. The solution is a PLAYABLE line: it is truncated so the solver is never asked
a position with more than one winning move, and it always ends on a solver move (odd
length). Because of that truncation the solution length no longer encodes the puzzle's
difficulty: the "mate length" k is the OBJECTIVE distance to mate, taken from the file
name (`mate_in_<k>.txt` / `mate length <k>.txt`). A "mate in 8" whose only forced-unique
move is the first is stored as a single-move solution but still lives in mate_in_8.txt.
Only uploaded files with no number in the name fall back to k = (len+1)//2.

Two on-disk formats are understood transparently:

  * old (`mate length <k>.txt`): 2-line blocks, no separators
        <history>
        <solution>
  * new (`mate_in_<k>.txt`, emitted by the C++ engine): 3-line blocks
        <board code: hi lo hex>
        <history>
        <solution>
    separated by a blank line.

Generation is delegated to the C++ engine's non-interactive CLI:
    connect4_3D.exe genpuzzle <mateLen> <numSeeds> <outputDir> <maxSeconds>
which appends freshly found puzzles to <outputDir>/mate_in_<k>.txt.
"""

import os
import re
import glob
import time
import random
import hashlib
import threading
import subprocess

_HEX_TOKEN = re.compile(r'^[0-9a-fA-F]+$')

# Difficulty categories shown in the web UI. Each groups a contiguous range of mate
# lengths (a puzzle's "mate in k" = its OBJECTIVE distance to mate). `max=None`
# means "and longer". The on-disk bank still stores puzzles bucketed by exact mate
# length (mate_in_<k>.txt); these categories are purely a presentation grouping.
CATEGORIES = [
    {'key': 'quick',   'label': 'Quick win',  'range_label': 'mate in 1–3',  'min': 1,  'max': 3},
    {'key': 'medium',  'label': 'Medium win', 'range_label': 'mate in 4–5',  'min': 4,  'max': 5},
    {'key': 'long',    'label': 'Long win',   'range_label': 'mate in 6–11', 'min': 6,  'max': 11},
    {'key': 'endgame', 'label': 'Endgame',    'range_label': 'mate in 12+',  'min': 12, 'max': None},
]

CATEGORY_BY_KEY = {c['key']: c for c in CATEGORIES}


def category_for_mate(mate):
    """Return the category key a given mate length belongs to (or None)."""
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
    }


def puzzle_id(puzzle):
    """Stable short id for a puzzle (used to avoid re-serving the same one)."""
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


class PuzzleBank:
    """Thread-safe in-memory bank of puzzles, bucketed by mate length."""

    def __init__(self, directory):
        self.directory = directory
        self._lock = threading.Lock()
        self.by_mate = {}      # k -> list[puzzle dict]
        self.reload()

    def reload(self):
        by_mate = {}
        seen = set()
        for path in sorted(glob.glob(os.path.join(self.directory, '*.txt'))):
            for p in parse_puzzle_file(path):
                key = (tuple(p['history']), tuple(p['solution']))
                if key in seen:
                    continue
                seen.add(key)
                by_mate.setdefault(p['mate'], []).append(p)
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
            by_mate = {k: list(v) for k, v in self.by_mate.items()}
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
    """Runs the C++ engine's headless generator CONTINUOUSLY in the background as a
    series of small, quickly-interruptible batches, appending fresh puzzles to the
    bank. Each batch generates every mate length (mate=1 => minPuzzleLength=1), so a
    single running loop keeps all difficulty buckets growing at once.

    Batches are kept small (few seeds, short budget) so the engine is only ever busy
    for a few seconds at a time, and `stop()` also kills the current subprocess
    outright -- so exiting Puzzle Mode frees the engine immediately.
    """

    # Seed piece-count windows the batches rotate through. Per the user's requirement,
    # candidate positions have 26-32 pieces (32-38 empty cells), so every window sits within
    # [26, 32] and caps at 32 (the engine also hard-drops any candidate with >32 pieces).
    # Slightly fuller than the old 24-30 range -- still emptier boards that hold the deeper /
    # interesting positions, but a bit faster to solve exactly.
    PIECE_RANGES = [(30, 32), (28, 32), (30, 32), (26, 32), (32, 32), (28, 32)]

    def __init__(self, bank, exe_path, output_dir, seeds=40, batch_seconds=12):
        self.bank = bank
        self.exe_path = exe_path
        self.output_dir = output_dir
        self.seeds = seeds
        self.batch_seconds = batch_seconds
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
        with self._lock:
            if self._status['running']:
                return False, self.status()
        # Make sure any previous loop has fully exited before starting a new one
        # (guards against rapid stop/start toggling leaving two loops alive).
        prev = self._thread
        if prev is not None and prev.is_alive():
            self._stop.set()
            with self._lock:
                proc = self._proc
            if proc is not None:
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
            prev.join(timeout=5)
        with self._lock:
            self._stop.clear()
            self._status = {
                'running': True, 'session_added': 0, 'batches': 0,
                'message': 'Generating puzzles in the background...',
                'started_at': time.time(),
            }
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return True, self.status()

    def stop(self):
        """Stop the loop and kill any in-flight batch immediately."""
        self._stop.set()
        with self._lock:
            proc = self._proc
        if proc is not None:
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
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
                if self._stop.is_set():
                    break
                self.bank.reload()
                added = max(0, self.bank.total() - before)
                with self._lock:
                    self._status['session_added'] += added
                    self._status['batches'] += 1
                    self._status['message'] = (
                        'Generating in the background... +%d puzzles this session'
                        % self._status['session_added'])
                    batches = self._status['batches']
                # Periodically persist a deduplicated bank so files don't grow unbounded.
                if batches % 5 == 0:
                    self.bank.rewrite_files()
        finally:
            if not self._stop.is_set():
                # loop exited unexpectedly
                with self._lock:
                    self._status['running'] = False

    def _run_batch(self, min_pieces=40, max_pieces=46):
        if not os.path.exists(self.exe_path):
            self._stop.set()
            with self._lock:
                self._status['message'] = 'Engine executable not found: %s' % self.exe_path
            return
        try:
            os.makedirs(self.output_dir, exist_ok=True)
            proc = subprocess.Popen(
                [self.exe_path, 'genpuzzle', '1', str(self.seeds),
                 os.path.abspath(self.output_dir), str(self.batch_seconds),
                 str(min_pieces), str(max_pieces)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except Exception as exc:  # noqa: BLE001
            self._stop.set()
            with self._lock:
                self._status['message'] = 'Generation failed: %s' % exc
            return
        with self._lock:
            self._proc = proc
        try:
            # Backstop kill for a runaway subprocess. The engine self-stops at `batch_seconds`
            # BETWEEN candidates, but with the {4,8,cap} solve schedule a single candidate can
            # keep solving to the end well past that, so allow a generous ~1000s grace before
            # force-killing. (stop() still kills instantly when the user leaves Puzzle Mode.)
            proc.wait(timeout=max(1000.0, self.batch_seconds + 60))
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        finally:
            with self._lock:
                self._proc = None