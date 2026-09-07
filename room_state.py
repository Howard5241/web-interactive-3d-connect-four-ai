"""Shared room state, so every browser looking at the site sees the same board.

Without this the app is single-player-per-tab: the board lives in each browser's own
JavaScript and the only server-side memory is the per-browser Flask session. Here the
board, the move history, which move is being viewed, the planning ghosts and Puzzle
Mode all live in one place that every viewer reads from and writes to.

Protocol (see static/js/sync.js for the other half):

  GET  /api/room/state?since=<version>   poll; doubles as the presence heartbeat.
                                         The state is returned only when `since` does
                                         not match the room's current version.
  POST /api/room/state                   push a partial patch of the state, optionally
                                         with `base_version`. A patch whose
                                         `base_version` is stale is rejected with the
                                         current state, so two people clicking at the
                                         same moment cannot both land a move.

Versions are monotonic per room and reset when the process restarts; `session` in every
response lets clients notice a restart and resynchronise from scratch.
"""

from __future__ import annotations

import copy
import re
import threading
import time
import uuid
from collections import deque

# Identifies this process. A client that sees a new value knows the room it was
# following is gone and its cached version number means nothing any more.
SESSION_ID = uuid.uuid4().hex

DEFAULT_ROOM = 'main'
MAX_ROOMS = 64

# A viewer is dropped from the presence list this long after its last poll. Clients
# poll every ~0.4s while visible and ~2.5s in a background tab, so this has to sit
# comfortably above the slow interval.
CLIENT_TIMEOUT = 12.0

# How long an engine lock ("Guest 2 is asking the AI...") is honoured. A viewer that
# closed its tab mid-search must not wedge the AI buttons for everyone else.
BUSY_TIMEOUT = 180.0

LOG_LIMIT = 200          # shared log entries kept per room
LOG_TAIL_ON_JOIN = 12    # entries a fresh viewer is caught up with
MAX_LOG_TEXT = 200

# Chip colours handed out to viewers in order; they identify a person, and are
# deliberately unrelated to the two piece colours.
GUEST_COLORS = ['#ffa500', '#4fc3f7', '#a5d6a7', '#ce93d8', '#ef9a9a', '#fff59d']

NUM_COLUMNS = 16
NUM_CELLS = 64
MAX_PUZZLES = 400
CLIENT_ID_RE = re.compile(r'^[A-Za-z0-9_-]{4,64}$')


def initial_state():
    """The state of a room nobody has touched yet: an empty board, no puzzle."""
    return {
        'mode': 'game',        # 'game' | 'puzzle'
        'moves': [],           # every move played, as column indices 0-15
        'view_index': 0,       # how many of those moves are being shown
        'ghosts': [],          # right-click planning pieces, in world coordinates
        'puzzle': None,        # the puzzle set being solved (see _clean_puzzle)
        'progress': None,      # how far into it the room has got (see _clean_progress)
        'busy': None,          # {'client', 'what', 'since'} while an engine is running
    }


# --- patch validation -------------------------------------------------------------
#
# Everything below is reached straight from a browser, so each field is rebuilt from
# scratch rather than trusted: a bad patch is rejected instead of poisoning the room
# for every other viewer.

def _clean_int(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f'{name} must be an integer')
    if not (low <= value <= high):
        raise ValueError(f'{name} out of range')
    return value


def _clean_moves(value, name='moves'):
    if not isinstance(value, list):
        raise ValueError(f'{name} must be a list')
    if len(value) > NUM_CELLS:
        raise ValueError(f'{name} is too long')
    return [_clean_int(m, name, 0, NUM_COLUMNS - 1) for m in value]


def _clean_mode(value):
    if value not in ('game', 'puzzle'):
        raise ValueError("mode must be 'game' or 'puzzle'")
    return value


def _clean_ghosts(value):
    if not isinstance(value, list):
        raise ValueError('ghosts must be a list')
    if len(value) > NUM_CELLS:
        raise ValueError('too many ghosts')
    out = []
    for g in value:
        if not isinstance(g, dict):
            raise ValueError('each ghost must be an object')
        cell = {}
        for axis in ('x', 'y', 'z'):
            v = g.get(axis)
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ValueError('ghost coordinates must be numbers')
            if not (-8 <= v <= 8):
                raise ValueError('ghost coordinate out of range')
            cell[axis] = float(v)
        cell['player'] = 1 if g.get('player') == 1 else -1
        out.append(cell)
    return out


def _clean_progress(value):
    """How far the room has got into the current puzzle.

    Kept apart from `puzzle` so that solving a move re-sends three numbers rather than a
    whole uploaded puzzle file.
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError('progress must be an object or null')
    return {
        'index': _clean_int(value.get('index', 0), 'progress index', 0, MAX_PUZZLES),
        'solution_index': _clean_int(value.get('solution_index', 0),
                                     'progress solution_index', 0, NUM_CELLS),
        'solved': bool(value.get('solved')),
    }


def _clean_puzzle(value):
    """The puzzle set being solved: where it came from and the puzzles themselves."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError('puzzle must be an object or null')

    raw_puzzles = value.get('puzzles')
    if not isinstance(raw_puzzles, list):
        raise ValueError('puzzle.puzzles must be a list')
    if len(raw_puzzles) > MAX_PUZZLES:
        raise ValueError('too many puzzles')

    puzzles = []
    for p in raw_puzzles:
        if not isinstance(p, dict):
            raise ValueError('each puzzle must be an object')
        entry = {
            'history': _clean_moves(p.get('history') or [], 'puzzle history'),
            'solution': _clean_moves(p.get('solution') or [], 'puzzle solution'),
        }
        if p.get('mate') is not None:
            entry['mate'] = _clean_int(p['mate'], 'puzzle mate', 0, NUM_CELLS)
        if p.get('steps') is not None:
            entry['steps'] = _clean_int(p['steps'], 'puzzle steps', 1, NUM_CELLS // 2)
        if p.get('goal') is not None:
            if p['goal'] not in ('win', 'draw'):
                raise ValueError('puzzle goal must be win or draw')
            entry['goal'] = p['goal']
        if p.get('id') is not None:
            entry['id'] = str(p['id'])[:64]
        puzzles.append(entry)

    source = value.get('source')
    category = value.get('category')
    return {
        'source': source if source in ('engine', 'file') else None,
        'puzzles': puzzles,
        'category': str(category)[:32] if isinstance(category, str) else None,
    }


def _clean_busy(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError('busy must be an object or null')
    what = value.get('what')
    if what not in ('ai', 'minimax', 'puzzle'):
        raise ValueError('busy.what is not a known engine')
    # `client` and `since` are stamped by the room, not by the caller.
    return {'what': what}


_FIELD_CLEANERS = {
    'mode': _clean_mode,
    'moves': _clean_moves,
    'view_index': lambda v: _clean_int(v, 'view_index', 0, NUM_CELLS),
    'ghosts': _clean_ghosts,
    'puzzle': _clean_puzzle,
    'progress': _clean_progress,
    'busy': _clean_busy,
}


def clean_client_id(value):
    """Reject ids that aren't a short opaque token, so junk cannot bloat the room."""
    if not isinstance(value, str) or not CLIENT_ID_RE.match(value):
        raise ValueError('invalid client_id')
    return value


class Room:
    """One shared board plus the viewers watching it."""

    def __init__(self, room_id):
        self.id = room_id
        self.lock = threading.RLock()
        self.state = initial_state()
        self.version = 0
        self.origin = None          # client whose push produced the current version
        self.updated = time.time()
        self.clients = {}           # client_id -> presence record
        self.log = deque(maxlen=LOG_LIMIT)
        self.log_seq = 0

    # --- presence ---------------------------------------------------------------

    def touch(self, client_id):
        """Record that a viewer is alive; assign it a name and colour on first sight."""
        with self.lock:
            self._prune()
            client = self.clients.get(client_id)
            if client is None:
                taken = {c['number'] for c in self.clients.values()}
                number = 1
                while number in taken:
                    number += 1
                client = {
                    'id': client_id,
                    'number': number,
                    'name': f'Guest {number}',
                    'color': GUEST_COLORS[(number - 1) % len(GUEST_COLORS)],
                    'joined': time.time(),
                }
                self.clients[client_id] = client
            client['last_seen'] = time.time()
            return dict(client)

    def leave(self, client_id):
        with self.lock:
            self.clients.pop(client_id, None)
            self._release_busy(client_id)
            self._prune()

    def _prune(self):
        """Drop viewers that stopped polling and engine locks that outlived their use."""
        now = time.time()
        for client_id, client in list(self.clients.items()):
            if now - client.get('last_seen', 0) > CLIENT_TIMEOUT:
                del self.clients[client_id]
                self._release_busy(client_id)

        busy = self.state.get('busy')
        if busy and (now - busy.get('since', 0) > BUSY_TIMEOUT
                     or busy.get('client') not in self.clients):
            self._set_busy(None)

    def _release_busy(self, client_id):
        busy = self.state.get('busy')
        if busy and busy.get('client') == client_id:
            self._set_busy(None)

    def _set_busy(self, busy):
        """Change the engine lock. Bumps the version so viewers see it promptly."""
        if self.state.get('busy') == busy:
            return
        self.state = dict(self.state, busy=busy)
        self.version += 1
        self.origin = None
        self.updated = time.time()

    # --- state ------------------------------------------------------------------

    def apply_patch(self, patch, client_id, base_version=None, log=None, log_since=None):
        """Merge `patch` into the room state.

        Returns (accepted, snapshot). When `base_version` is given and no longer
        matches the room, nothing is applied and the snapshot carries the state the
        caller missed, so it can resynchronise and let the user try again.

        `log_since` is the caller's position in the shared log, exactly as in a poll:
        without it every push would answer with the log tail and the caller would show
        the same lines again.
        """
        if not isinstance(patch, dict):
            raise ValueError('patch must be an object')

        with self.lock:
            self._prune()
            if base_version is not None and base_version != self.version:
                return False, self.snapshot(log_since=log_since)

            new_state = dict(self.state)
            for key, value in patch.items():
                cleaner = _FIELD_CLEANERS.get(key)
                if cleaner is None:
                    raise ValueError(f"unknown state field '{key}'")
                new_state[key] = cleaner(value)

            # An engine lock always belongs to whoever asked for it, and is stamped
            # here so a client cannot claim one on someone else's behalf.
            if 'busy' in patch and new_state['busy'] is not None:
                new_state['busy'] = dict(new_state['busy'],
                                         client=client_id, since=time.time())

            # A view can only ever point at a move that exists.
            new_state['view_index'] = min(new_state['view_index'],
                                          len(new_state['moves']))

            if new_state != self.state:
                self.state = new_state
                self.version += 1
                self.origin = client_id
                self.updated = time.time()

            if log:
                self._append_log(log, client_id)

            # The pusher already has this state; sending it back would be waste.
            return True, self.snapshot(since=self.version, log_since=log_since)

    def snapshot(self, since=None, log_since=None):
        """A poll response: presence and log always, state only when it moved on."""
        with self.lock:
            self._prune()
            data = {
                'session': SESSION_ID,
                'room': self.id,
                'version': self.version,
                'origin': self.origin,
                'log_seq': self.log_seq,
                'clients': [
                    {'id': c['id'], 'name': c['name'], 'color': c['color']}
                    for c in sorted(self.clients.values(), key=lambda c: c['number'])
                ],
            }
            if since != self.version:
                data['state'] = copy.deepcopy(self.state)
            if log_since is None:
                data['log'] = list(self.log)[-LOG_TAIL_ON_JOIN:]
            else:
                data['log'] = [e for e in self.log if e['seq'] > log_since]
            return data

    # --- shared log -------------------------------------------------------------

    def _append_log(self, text, client_id):
        if not isinstance(text, str):
            return
        text = text.strip()[:MAX_LOG_TEXT]
        if not text:
            return
        client = self.clients.get(client_id) or {}
        self.log_seq += 1
        self.log.append({
            'seq': self.log_seq,
            'text': text,
            'client': client_id,
            'name': client.get('name', 'Someone'),
            'color': client.get('color', '#ffa500'),
            'ts': time.time(),
        })


class RoomRegistry:
    """Rooms by id. One default room means "everyone shares a board" by default;
    passing ?room=<name> in the URL gives a group its own independent board."""

    def __init__(self):
        self._lock = threading.Lock()
        self._rooms = {}

    def get(self, room_id=None):
        room_id = self.clean_id(room_id)
        with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                if len(self._rooms) >= MAX_ROOMS:
                    # Reclaim the room nobody has touched for longest rather than
                    # letting stray ?room= values grow without bound.
                    oldest = min(self._rooms.values(), key=lambda r: r.updated)
                    if not oldest.clients:
                        del self._rooms[oldest.id]
                    else:
                        raise ValueError('too many active rooms')
                room = Room(room_id)
                self._rooms[room_id] = room
            return room

    @staticmethod
    def clean_id(room_id):
        if not room_id:
            return DEFAULT_ROOM
        room_id = str(room_id)[:32]
        room_id = re.sub(r'[^A-Za-z0-9_-]', '', room_id)
        return room_id or DEFAULT_ROOM
