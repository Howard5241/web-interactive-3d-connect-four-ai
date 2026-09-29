// Room rules shared by the Room Durable Object and its tests. Patch fields come straight
// from browsers, so each one is rebuilt rather than trusted.
import { ConnectFour3D } from '../public/static/js/gameLogic.js';

const game = new ConnectFour3D();

export const NUM_COLUMNS = 16;
export const NUM_CELLS = 64;
const GRID_SIZE = 4;
const MAX_PUZZLES = 400;
const MAX_LINES = 76;
export const LOG_LIMIT = 200;
export const LOG_TAIL_ON_JOIN = 12;
const MAX_LOG_TEXT = 200;
export const BUSY_TIMEOUT_MS = 180_000;
export const GUEST_COLORS = ['#ffa500', '#4fc3f7', '#a5d6a7', '#ce93d8', '#ef9a9a', '#fff59d'];

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
export const ROOM_CODE_RE = /^[a-z0-9]{4,16}$/;
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function initialState() {
    return {
        mode: 'game',
        moves: [],
        view_index: 0,
        ghosts: [],
        lines: [],
        puzzle: null,
        progress: null,
        busy: null,
    };
}

export function newRoomData() {
    return {
        state: initialState(),
        version: 0,
        origin: null,
        seats: { '1': null, '-1': null },
        log: [],
        log_seq: 0,
    };
}

export function randomCode(length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function cleanClientId(value) {
    if (typeof value !== 'string' || !CLIENT_ID_RE.test(value)) throw new Error('invalid client_id');
    return value;
}

export function cleanName(value, fallback) {
    if (typeof value !== 'string') return fallback;
    const name = value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
    return name || fallback;
}

function isInt(v) {
    return typeof v === 'number' && Number.isInteger(v);
}

function cleanInt(value, name, low, high) {
    if (!isInt(value)) throw new Error(`${name} must be an integer`);
    if (value < low || value > high) throw new Error(`${name} out of range`);
    return value;
}

function cleanMoves(value, name = 'moves') {
    if (!Array.isArray(value)) throw new Error(`${name} must be a list`);
    if (value.length > NUM_CELLS) throw new Error(`${name} is too long`);
    return value.map(m => cleanInt(m, name, 0, NUM_COLUMNS - 1));
}

function cleanMode(value) {
    if (value !== 'game' && value !== 'puzzle') throw new Error("mode must be 'game' or 'puzzle'");
    return value;
}

function cleanGhosts(value) {
    if (!Array.isArray(value)) throw new Error('ghosts must be a list');
    if (value.length > NUM_CELLS) throw new Error('too many ghosts');
    return value.map(g => {
        if (!g || typeof g !== 'object') throw new Error('each ghost must be an object');
        const cell = {};
        for (const axis of ['x', 'y', 'z']) {
            const v = g[axis];
            if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('ghost coordinates must be numbers');
            if (v < -8 || v > 8) throw new Error('ghost coordinate out of range');
            cell[axis] = v;
        }
        cell.player = g.player === 1 ? 1 : -1;
        return cell;
    });
}

function cleanCell(value, name) {
    if (!Array.isArray(value) || value.length !== 3) throw new Error(`${name} must be a [z, y, x] triple`);
    return value.map(c => cleanInt(c, name, 0, GRID_SIZE - 1));
}

function cleanLines(value) {
    if (!Array.isArray(value)) throw new Error('lines must be a list');
    if (value.length > MAX_LINES) throw new Error('too many lines');
    return value.map(line => {
        if (!line || typeof line !== 'object') throw new Error('each line must be an object');
        return { a: cleanCell(line.a, 'line end'), b: cleanCell(line.b, 'line end') };
    });
}

function cleanProgress(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') throw new Error('progress must be an object or null');
    return {
        index: cleanInt(value.index ?? 0, 'progress index', 0, MAX_PUZZLES),
        solution_index: cleanInt(value.solution_index ?? 0, 'progress solution_index', 0, NUM_CELLS),
        solved: !!value.solved,
    };
}

function cleanPuzzle(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') throw new Error('puzzle must be an object or null');
    if (!Array.isArray(value.puzzles)) throw new Error('puzzle.puzzles must be a list');
    if (value.puzzles.length > MAX_PUZZLES) throw new Error('too many puzzles');

    const puzzles = value.puzzles.map(p => {
        if (!p || typeof p !== 'object') throw new Error('each puzzle must be an object');
        const entry = {
            history: cleanMoves(p.history || [], 'puzzle history'),
            solution: cleanMoves(p.solution || [], 'puzzle solution'),
        };
        if (p.mate != null) entry.mate = cleanInt(p.mate, 'puzzle mate', 0, NUM_CELLS);
        if (p.steps != null) entry.steps = cleanInt(p.steps, 'puzzle steps', 1, NUM_CELLS / 2);
        if (p.goal != null) {
            if (p.goal !== 'win' && p.goal !== 'draw') throw new Error('puzzle goal must be win or draw');
            entry.goal = p.goal;
        }
        if (p.id != null) entry.id = String(p.id).slice(0, 64);
        return entry;
    });

    return {
        source: value.source === 'engine' || value.source === 'file' ? value.source : null,
        puzzles,
        category: typeof value.category === 'string' ? value.category.slice(0, 32) : null,
    };
}

function cleanBusy(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') throw new Error('busy must be an object or null');
    if (!['ai', 'minimax', 'puzzle'].includes(value.what)) throw new Error('busy.what is not a known engine');
    return { what: value.what };
}

const FIELD_CLEANERS = {
    mode: cleanMode,
    moves: cleanMoves,
    view_index: v => cleanInt(v, 'view_index', 0, NUM_CELLS),
    ghosts: cleanGhosts,
    lines: cleanLines,
    puzzle: cleanPuzzle,
    progress: cleanProgress,
    busy: cleanBusy,
};

export function cleanPatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch must be an object');
    const out = {};
    for (const [key, value] of Object.entries(patch)) {
        const cleaner = FIELD_CLEANERS[key];
        if (!cleaner) throw new Error(`unknown state field '${key}'`);
        out[key] = cleaner(value);
    }
    return out;
}

// Move i is played by player 1 when i is even.
const colorOf = i => (i % 2 === 0 ? '1' : '-1');

function isGameOver(moves) {
    const { state } = game.getStateFromMoves(moves);
    return game.getValueAndTerminated(state)[1];
}

// Once anyone sits down, only seated players change the room. A seated player plays their
// own colour and any colour whose seat is empty, and may rewrite moves of a colour they
// cannot play only after the game has ended.
export function checkPermission(data, clientId, patch) {
    const { seats, state } = data;
    const seated = Object.values(seats).filter(Boolean);
    if (!seated.length) return null;
    if (!seated.includes(clientId)) return 'Only the seated players can change the board.';

    const allowed = new Set(Object.keys(seats).filter(c => !seats[c] || seats[c] === clientId));
    if (allowed.size === 2 || state.mode !== 'game' || isGameOver(state.moves)) return null;

    const mode = patch.mode ?? state.mode;
    if (mode !== 'game' || patch.puzzle) return 'Finish the game before starting a puzzle.';
    if (!patch.moves) return null;

    const before = state.moves;
    const after = patch.moves;
    let common = 0;
    while (common < before.length && common < after.length && before[common] === after[common]) common++;
    for (let i = common; i < Math.max(before.length, after.length); i++) {
        if (!allowed.has(colorOf(i))) {
            return i < after.length && i === before.length && after.length === before.length + 1
                ? "It's your opponent's move."
                : "You can only change your own moves until the game ends.";
        }
    }
    return null;
}

// Returns { ok, error?, conflict?, changed }. Mutates `data` only when accepted.
export function applyPatch(data, clientId, rawPatch, { baseVersion = null, now = Date.now() } = {}) {
    let patch;
    try {
        patch = cleanPatch(rawPatch);
    } catch (e) {
        return { ok: false, error: e.message };
    }
    if (baseVersion !== null && baseVersion !== data.version) return { ok: false, conflict: true };

    const denied = checkPermission(data, clientId, patch);
    if (denied) return { ok: false, error: denied };

    if (patch.moves && game.getStateFromMoves(patch.moves).appliedMoves.length !== patch.moves.length) {
        return { ok: false, error: 'That move sequence is not legal.' };
    }

    const next = { ...data.state, ...patch };
    // Stamped here so a client cannot claim a lock for someone else.
    if ('busy' in patch && next.busy) next.busy = { ...next.busy, client: clientId, since: now };
    next.view_index = Math.min(next.view_index, next.moves.length);

    const changed = JSON.stringify(next) !== JSON.stringify(data.state);
    if (changed) {
        data.state = next;
        data.version += 1;
        data.origin = clientId;
    }
    return { ok: true, changed };
}

// Drops a lock whose holder left or that outlived BUSY_TIMEOUT_MS.
export function releaseStaleBusy(data, connectedIds, now = Date.now()) {
    const busy = data.state.busy;
    if (!busy) return false;
    if (connectedIds.has(busy.client) && now - busy.since <= BUSY_TIMEOUT_MS) return false;
    data.state = { ...data.state, busy: null };
    data.version += 1;
    data.origin = null;
    return true;
}

// A seat is free when empty or when its holder is not connected.
export function takeSeat(data, clientId, seat, connectedIds) {
    if (seat !== null && seat !== '1' && seat !== '-1') return { ok: false, error: 'unknown seat' };
    if (seat !== null) {
        const holder = data.seats[seat];
        if (holder && holder !== clientId && connectedIds.has(holder)) {
            return { ok: false, error: 'That seat is taken.' };
        }
    }
    for (const s of Object.keys(data.seats)) {
        if (data.seats[s] === clientId) data.seats[s] = null;
    }
    if (seat !== null) data.seats[seat] = clientId;
    return { ok: true };
}

export function appendLog(data, text, client) {
    if (typeof text !== 'string') return null;
    text = text.trim().slice(0, MAX_LOG_TEXT);
    if (!text) return null;
    data.log_seq += 1;
    const entry = {
        seq: data.log_seq,
        text,
        client: client.id,
        name: client.name,
        color: client.color,
        ts: Date.now(),
    };
    data.log.push(entry);
    if (data.log.length > LOG_LIMIT) data.log.splice(0, data.log.length - LOG_LIMIT);
    return entry;
}
