// Room rules: node --test tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    applyPatch, newRoomData, randomCode, releaseStaleBusy, takeSeat, appendLog, cleanName,
    BUSY_TIMEOUT_MS,
} from '../worker/roomCore.js';

const seated = (red = 'red1', dark = 'dark1') => {
    const d = newRoomData();
    d.seats = { '1': red, '-1': dark };
    return d;
};

test('anyone may change an unseated room', () => {
    const d = newRoomData();
    assert.equal(applyPatch(d, 'x', { moves: [0, 1] }).ok, true);
    assert.deepEqual(d.state.moves, [0, 1]);
    assert.equal(d.version, 1);
    assert.equal(d.origin, 'x');
});

test('bad fields and illegal sequences are rejected', () => {
    const d = newRoomData();
    assert.match(applyPatch(d, 'x', { nope: 1 }).error, /unknown/);
    assert.match(applyPatch(d, 'x', { moves: [16] }).error, /range/);
    assert.match(applyPatch(d, 'x', { moves: [0, 0, 0, 0, 0] }).error, /not legal/);
    assert.equal(d.version, 0);
});

test('a stale base version is a conflict', () => {
    const d = newRoomData();
    applyPatch(d, 'x', { moves: [0] });
    assert.deepEqual(applyPatch(d, 'x', { moves: [0, 1] }, { baseVersion: 0 }), { ok: false, conflict: true });
});

test('seated players play their own colour in turn; spectators cannot change the room', () => {
    const d = seated();
    assert.match(applyPatch(d, 'watcher', { ghosts: [] }).error, /seated players/);
    assert.match(applyPatch(d, 'dark1', { moves: [3] }).error, /opponent's move/);
    assert.equal(applyPatch(d, 'red1', { moves: [3] }).ok, true);
    assert.match(applyPatch(d, 'red1', { moves: [3, 4] }).error, /opponent's move/);
    assert.equal(applyPatch(d, 'dark1', { moves: [3, 4] }).ok, true);
    assert.match(applyPatch(d, 'red1', { moves: [] }).error, /own moves/);
    assert.match(applyPatch(d, 'red1', { mode: 'puzzle' }).error, /Finish the game/);
    assert.equal(applyPatch(d, 'red1', { view_index: 1 }).ok, true);
});

test('a player may undo their own last move', () => {
    const d = seated();
    applyPatch(d, 'red1', { moves: [3] });
    applyPatch(d, 'dark1', { moves: [3, 4] });
    assert.equal(applyPatch(d, 'dark1', { moves: [3] }).ok, true);
});

test('an empty seat lets the seated player move for both sides', () => {
    const d = seated('red1', null);
    assert.equal(applyPatch(d, 'red1', { moves: [0, 1, 2] }).ok, true);
    assert.equal(applyPatch(d, 'red1', { moves: [] }).ok, true);
});

test('after the game ends either player may start over', () => {
    const d = newRoomData();
    // Player 1 fills columns 0-3 of the bottom layer.
    applyPatch(d, 'x', { moves: [0, 4, 1, 5, 2, 6, 3] });
    d.seats = { '1': 'red1', '-1': 'dark1' };
    assert.equal(applyPatch(d, 'dark1', { moves: [] }).ok, true);
});

test('seats: taken, freed when the holder leaves, one per client', () => {
    const d = newRoomData();
    const here = new Set(['a', 'b']);
    assert.equal(takeSeat(d, 'a', '1', here).ok, true);
    assert.equal(takeSeat(d, 'b', '1', here).ok, false);
    assert.equal(takeSeat(d, 'b', '1', new Set(['b'])).ok, true);
    assert.equal(takeSeat(d, 'b', '-1', here).ok, true);
    assert.deepEqual(d.seats, { '1': null, '-1': 'b' });
    assert.equal(takeSeat(d, 'b', null, here).ok, true);
    assert.deepEqual(d.seats, { '1': null, '-1': null });
});

test('engine lock is stamped by the server and released when stale', () => {
    const d = newRoomData();
    applyPatch(d, 'a', { busy: { what: 'ai', client: 'someone-else' } }, { now: 1000 });
    assert.deepEqual(d.state.busy, { what: 'ai', client: 'a', since: 1000 });
    assert.equal(releaseStaleBusy(d, new Set(['a']), 1000 + BUSY_TIMEOUT_MS), false);
    assert.equal(releaseStaleBusy(d, new Set(['a']), 2000 + BUSY_TIMEOUT_MS), true);
    assert.equal(d.state.busy, null);
});

test('log, names and codes', () => {
    const d = newRoomData();
    const entry = appendLog(d, '  hi  ', { id: 'a', name: 'A', color: '#fff' });
    assert.equal(entry.text, 'hi');
    assert.equal(appendLog(d, '   ', { id: 'a' }), null);
    assert.equal(cleanName('  <b>Bob</b>\n', 'Guest'), 'bBob/b');
    assert.equal(cleanName('', 'Guest 2'), 'Guest 2');
    assert.match(randomCode(6), /^[a-z0-9]{6}$/);
});
