"""Shared room state: one board per room that every viewer reads and writes.

GET /api/room/state?since=<version> polls (and is the presence heartbeat); the state is
included only when the version moved. POST pushes a partial patch, rejected when its
`base_version` is stale. Versions reset on restart, which clients detect via `session`.
Client half: static/js/sync.js.
"""

from __future__ import annotations

import copy
import re
import threading
import time
import uuid
from collections import deque

SESSION_ID = uuid.uuid4().hex

DEFAULT_ROOM = 'main'
MAX_ROOMS = 64

CLIENT_TIMEOUT = 12.0    # seconds without a poll before a viewer is dropped
BUSY_TIMEOUT = 180.0     # an engine lock expires even if its holder never releases it

LOG_LIMIT = 200
LOG_TAIL_ON_JOIN = 12
MAX_LOG_TEXT = 200

GUEST_COLORS = ['#ffa500', '#4fc3f7', '#a5d6a7', '#ce93d8', '#ef9a9a', '#fff59d']

NUM_COLUMNS = 16
NUM_CELLS = 64
GRID_SIZE = 4
MAX_PUZZLES = 400
MAX_LINES = 76           # every four-in-a-row on a 4x4x4 board
CLIENT_ID_RE = re.compile(r'^[A-Za-z0-9_-]{4,64}$')


def initial_state():
    return {
        'mode': 'game',        # 'game' | 'puzzle'
        'moves': [],
        'view_index': 0,       # how many moves are shown
        'ghosts': [],          # planning pieces, in world coordinates
        'lines': [],
        'puzzle': None,
        'progress': None,
        'busy': None,          # {'client', 'what', 'since'} while an engine is running
    }


# Patch fields come straight from browsers, so each one is rebuilt rather than trusted.

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


def _clean_cell(value, name):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f'{name} must be a [z, y, x] triple')
    return [_clean_int(c, name, 0, GRID_SIZE - 1) for c in value]


def _clean_lines(value):
    """Ghost lines, each as the two end cells of the run."""
    if not isinstance(value, list):
        raise ValueError('lines must be a list')
    if len(value) > MAX_LINES:
        raise ValueError('too many lines')
    out = []
    for line in value:
        if not isinstance(line, dict):
            raise ValueError('each line must be an object')
        out.append({
            'a': _clean_cell(line.get('a'), 'line end'),
            'b': _clean_cell(line.get('b'), 'line end'),
        })
    return out


def _clean_progress(value):
    """Kept apart from `puzzle` so a solved move does not resend a whole puzzle file."""
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
    return {'what': what}


_FIELD_CLEANERS = {
    'mode': _clean_mode,
    'moves': _clean_moves,
    'view_index': lambda v: _clean_int(v, 'view_index', 0, NUM_CELLS),
    'ghosts': _clean_ghosts,
    'lines': _clean_lines,
    'puzzle': _clean_puzzle,
    'progress': _clean_progress,
    'busy': _clean_busy,
}


def clean_client_id(value):
    if not isinstance(value, str) or not CLIENT_ID_RE.match(value):
        raise ValueError('invalid client_id')
    return value


class Room:
    def __init__(self, room_id):
        self.id = room_id
        self.lock = threading.RLock()
        self.state = initial_state()
        self.version = 0
        self.origin = None          # client whose push made the current version
        self.updated = time.time()
        self.clients = {}
        self.log = deque(maxlen=LOG_LIMIT)
        self.log_seq = 0

    def touch(self, client_id):
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
        if self.state.get('busy') == busy:
            return
        self.state = dict(self.state, busy=busy)
        self.version += 1
        self.origin = None
        self.updated = time.time()

    def apply_patch(self, patch, client_id, base_version=None, log=None, log_since=None):
        """Returns (accepted, snapshot); a stale `base_version` applies nothing and the
        snapshot carries the state the caller missed."""
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

            # Stamped here so a client cannot claim a lock for someone else.
            if 'busy' in patch and new_state['busy'] is not None:
                new_state['busy'] = dict(new_state['busy'],
                                         client=client_id, since=time.time())

            new_state['view_index'] = min(new_state['view_index'],
                                          len(new_state['moves']))

            if new_state != self.state:
                self.state = new_state
                self.version += 1
                self.origin = client_id
                self.updated = time.time()

            if log:
                self._append_log(log, client_id)

            # The pusher already has this state.
            return True, self.snapshot(since=self.version, log_since=log_since)

    def snapshot(self, since=None, log_since=None):
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
    """Rooms by id; everyone shares 'main' unless the URL has ?room=<name>."""

    def __init__(self):
        self._lock = threading.Lock()
        self._rooms = {}

    def get(self, room_id=None):
        room_id = self.clean_id(room_id)
        with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                if len(self._rooms) >= MAX_ROOMS:
                    # Reclaim the longest-idle room.
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
