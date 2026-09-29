// In-browser AI tests: node --test tests/nnAgent.test.mjs
//
// nnMcts.js is checked against the Python game rules (via gameLogic.js) and against
// searches recorded from ai_agent.MCTS with the real network: replaying the recorded
// network outputs must reproduce the backend's visit counts exactly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ConnectFour3D } from '../public/static/js/gameLogic.js';
import {
    bestAction, currentPlayer, encodeState, maskedPolicy, nextState, search,
    stateFromMoves, validMoves, valueAndTerminated,
} from '../public/static/js/nnMcts.js';

const game = new ConnectFour3D();
const flat = board => Int8Array.from(board.flat(2));

function randomGame(seed) {
    let s = seed;
    const rand = n => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
    const moves = [];
    let board = game.getInitialState();
    while (!game.getValueAndTerminated(board)[1]) {
        const legal = game.getValidMoves(board).flatMap((v, a) => (v ? [a] : []));
        const move = legal[rand(legal.length)];
        board = game.getNextState(board, move);
        moves.push(move);
    }
    return moves;
}

test('rules match gameLogic.js over random games', () => {
    for (let seed = 1; seed <= 200; seed++) {
        const moves = randomGame(seed);
        let board = game.getInitialState();
        let state = stateFromMoves([]);
        for (const move of moves) {
            assert.deepEqual(Array.from(validMoves(state)), game.getValidMoves(board));
            board = game.getNextState(board, move);
            state = nextState(state, move);
            assert.deepEqual(state, flat(board));
            assert.equal(currentPlayer(state), game.getCurrentPlayer(board));
            assert.deepEqual(valueAndTerminated(state), game.getValueAndTerminated(board));
        }
        assert.deepEqual(stateFromMoves(moves), flat(board));
    }
});

test('encoding: player 1, player 2, empty, side to move', () => {
    const input = encodeState(stateFromMoves([5]));
    const bottom = 3 * 16 + 5;
    assert.equal(input[bottom], 1);
    assert.equal(input[64 + bottom], 0);
    assert.equal(input[128 + bottom], 0);
    assert.equal(input[128], 1);
    assert.ok(input.slice(192).every(v => v === 0), 'player 2 to move');
    assert.ok(encodeState(stateFromMoves([])).slice(192).every(v => v === 1), 'player 1 to move');
});

test('policy is masked to legal moves and renormalised', () => {
    const valid = new Uint8Array(16).fill(1);
    valid[3] = 0;
    const policy = maskedPolicy(new Array(16).fill(0), valid);
    assert.equal(policy[3], 0);
    assert.ok(Math.abs(policy.reduce((a, b) => a + b, 0) - 1) < 1e-6);
    const fallback = maskedPolicy([0, ...new Array(15).fill(-1e4)], Uint8Array.from({ length: 16 }, (_, a) => (a === 0 ? 0 : 1)));
    assert.ok(fallback.slice(1).every(p => Math.abs(p - 1 / 15) < 1e-6), 'uniform when the net gives legal moves no mass');
});

test('search reproduces the backend MCTS', async () => {
    const cases = JSON.parse(readFileSync(new URL('./fixtures/nn_mcts_reference.json', import.meta.url)));
    for (const c of cases) {
        const evaluate = async input => {
            let key = '';
            for (let i = 0; i < 64; i++) key += input[i] ? 'x' : input[64 + i] ? 'o' : '.';
            const [value, ...logits] = c.evals[key];
            return { value, logits };
        };
        const visits = await search(stateFromMoves(c.moves), evaluate, { simulations: c.simulations });
        assert.deepEqual(visits, c.visits);
        assert.equal(bestAction(visits), c.move);
    }
});

test('each position is evaluated once', async () => {
    let calls = 0;
    const seen = new Set();
    const evaluate = async input => {
        calls++;
        seen.add(input.join(''));
        return { logits: new Array(16).fill(0), value: 0 };
    };
    await search(stateFromMoves([]), evaluate, { simulations: 300 });
    assert.equal(calls, seen.size);
});

test('takes an immediate win', async () => {
    const moves = [0, 4, 1, 5, 2, 6];
    const visits = await search(stateFromMoves(moves), async () => ({ logits: new Array(16).fill(0), value: 0 }), { simulations: 200 });
    assert.equal(bestAction(visits), 3);
});

test('aiMove talks to the worker', async () => {
    globalThis.Worker = class {
        postMessage({ id, moves, simulations }) {
            setTimeout(() => {
                this.onmessage({ data: { id, status: 'loading' } });
                this.onmessage({ data: { id, status: 'wasm' } });
                this.onmessage({ data: { id, progress: [simulations, simulations] } });
                this.onmessage({ data: moves.length ? { id, error: 'AI failed: boom' } : { id, move: 7, visits: [] } });
            });
        }
    };
    const { aiMove } = await import('../public/static/js/nnAgent.js');
    const statuses = [];
    const progress = [];
    const reply = await aiMove([], { simulations: 10, onStatus: s => statuses.push(s), onProgress: (d, t) => progress.push([d, t]) });
    assert.equal(reply.move, 7);
    assert.deepEqual(statuses, ['loading', 'wasm']);
    assert.deepEqual(progress, [[10, 10]]);
    await assert.rejects(aiMove([1]), /boom/);
});
