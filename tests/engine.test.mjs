// Browser-engine tests: node --test tests/
//
// The first group drives static/js/engine.js against a fake Worker, the way the
// analysis panel and the minimax button use it. The second loads the real
// WebAssembly engine (static/engine/) directly and checks what it computes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import createEngine from '../static/engine/connect4_engine.js';

// --- engine.js protocol, against a fake worker -------------------------------

// Replays scripted engine output for each request: `script(request)` returns
// { lines, exit, error }. Each worker records its requests and whether it was
// terminated, so a test can see cancellations.
const workers = [];
let script = () => ({ lines: [], exit: 0 });
globalThis.Worker = class {
    constructor() {
        this.terminated = false;
        this.requests = [];
        workers.push(this);
    }
    postMessage(request) {
        this.requests.push(request);
        const { lines, exit = 0, error = null } = script(request);
        setTimeout(() => {
            for (const line of lines) if (!this.terminated) this.onmessage({ data: { id: request.id, line } });
            if (!this.terminated) this.onmessage({ data: { id: request.id, exit, error } });
        });
    }
    terminate() { this.terminated = true; }
};
const { analyze, bestMove, applyAnalysisLine, newAnalysisSnapshot } = await import('../static/js/engine.js');

// Resolves with every snapshot the job published, once it stops running.
function analyzeAll(moves) {
    return new Promise(resolve => {
        const snapshots = [];
        analyze(moves, snapshot => {
            snapshots.push(snapshot);
            if (!snapshot.running) resolve(snapshots);
        });
    });
}

const iteration = (depth, extra = {}) => ({
    type: 'iteration', depth, complete: false, phase: 'search',
    moves: [{ move: 1, score: depth, pv: [1] }], ...extra,
});

test('display depth parity: Light keeps even depths, Dark odd', async () => {
    for (const [moves, expected] of [[[], 4], [[0], 3]]) {
        script = () => ({ lines: [1, 2, 3, 4].map(d => iteration(d)).concat({ type: 'done' }) });
        const snapshots = await analyzeAll(moves);
        const final = snapshots.at(-1);
        assert.equal(final.depth, expected);
        assert.equal(final.moves[0].score, expected);
        assert.equal(final.error, null);
        assert.equal(final.running, false);
        assert.ok(snapshots.every(s => s.depth % 2 === moves.length % 2 || s.depth === 0));
    }
});

test('proved results and mate refinement bypass parity', () => {
    const snapshot = newAnalysisSnapshot([]);
    assert.ok(applyAnalysisLine(snapshot, iteration(1, { complete: true })));
    assert.equal(snapshot.depth, 1);
    assert.ok(applyAnalysisLine(snapshot, iteration(37, {
        phase: 'mate', moves: [{ move: 1, score: 29993, solved: true, mate_plies: 7, mate_exact: true, pv: [1, 2] }],
    })));
    assert.equal(snapshot.moves[0].mate_plies, 7);
    assert.equal(applyAnalysisLine(snapshot, iteration(39)), false, 'odd heuristic depth on Light must be skipped');
    applyAnalysisLine(snapshot, { type: 'done', timed_out: true });
    assert.equal(snapshot.timed_out, true);
    assert.equal(snapshot.moves[0].mate_plies, 7, 'timeout keeps the refined result');
});

test('engine failures surface as errors', async () => {
    script = () => ({ lines: [], exit: 2, error: 'Illegal history' });
    assert.match((await analyzeAll([0])).at(-1).error, /Illegal history/);
    script = () => ({ lines: [{ type: 'menu' }], exit: 0 });
    assert.match((await analyzeAll([])).at(-1).error, /Unsupported engine protocol/);
    script = () => ({ lines: [{ type: 'done' }], exit: 0 });
    assert.match((await analyzeAll([])).at(-1).error, /no result/);
});

test('a new request cancels the running search', async () => {
    script = () => ({ lines: [iteration(2)] });
    const cancelled = [];
    const job = analyze([], snapshot => cancelled.push(snapshot));
    const worker = workers.at(-1);
    script = () => ({ lines: [{ type: 'bestmove', move: 5 }] });
    assert.equal((await bestMove([0, 1])).move, 5);
    assert.ok(worker.terminated, 'analysis worker should be terminated');
    assert.deepEqual(await job.promise, { cancelled: true });
    assert.deepEqual(cancelled, []);
    assert.deepEqual(workers.at(-1).requests.at(-1),
        { id: workers.at(-1).requests.at(-1).id, command: 'bestmove', moves: [0, 1], ms: 3000 });
});

test('bestMove rejects when the engine fails', async () => {
    script = () => ({ lines: [], exit: 2, error: 'Game is already over' });
    await assert.rejects(bestMove([0, 4, 1, 5, 2, 6, 3]), /Game is already over/);
});

// --- the real WebAssembly engine ---------------------------------------------

let output = [];
const wasm = await createEngine({ print: line => output.push(JSON.parse(line)), printErr: () => {} });
function run(fn, types, args) {
    output = [];
    const exit = wasm.ccall(fn, 'number', types, args);
    return { exit, lines: output };
}
const analyzeWasm = (history, top, depth, ms) =>
    run('engine_analyze', ['string', 'number', 'number', 'number'], [history, top, depth, ms]);
const bestMoveWasm = (history, ms) => run('engine_bestmove', ['string', 'number'], [history, ms]);

const WINNING_MASKS = (() => {
    const masks = new Set();
    for (let s = 0; s < 64; s++) {
        const start = [s >> 4, (s >> 2) & 3, s & 3];
        for (let d = 0; d < 27; d++) {
            const delta = [Math.floor(d / 9) - 1, Math.floor(d / 3) % 3 - 1, d % 3 - 1];
            if (delta.every(v => v === 0)) continue;
            let mask = 0n;
            let inside = true;
            for (let n = 0; n < 4; n++) {
                const [z, y, x] = start.map((v, a) => v + n * delta[a]);
                if ([z, y, x].some(v => v < 0 || v > 3)) inside = false;
                else mask |= 1n << BigInt(z * 16 + y * 4 + x);
            }
            if (inside) masks.add(mask);
        }
    }
    return [...masks];
})();
const wins = board => WINNING_MASKS.some(mask => (board & mask) === mask);

test('analysis ranks every root move at every depth, from both sides', () => {
    assert.equal(WINNING_MASKS.length, 76);
    for (const history of ['-', '0']) {
        const { exit, lines } = analyzeWasm(history, 16, 4, 10000);
        assert.equal(exit, 0);
        const iterations = lines.filter(l => l.type === 'iteration');
        assert.deepEqual(iterations.map(l => l.depth), [1, 2, 3, 4]);
        for (const update of iterations) {
            assert.equal(update.moves.length, 16);
            const scores = update.moves.map(r => r.score);
            assert.deepEqual(scores, [...scores].sort((a, b) => history === '-' ? b - a : a - b));
            for (const row of update.moves) {
                assert.equal(row.pv[0], row.move);
                assert.ok(row.pv.every(c => c >= 0 && c < 16));
            }
        }
        assert.equal(lines.at(-1).type, 'done');
    }
});

test('terminal positions, immediate mates and bad input', () => {
    const terminal = analyzeWasm('0,4,1,5,2,6,3', 3, 4, 10000).lines[0];
    assert.deepEqual([terminal.type, terminal.winner, terminal.moves], ['terminal', 1, []]);
    const row = analyzeWasm('0,4,1,5,2,6', 3, 4, 10000).lines[0].moves[0];
    assert.deepEqual([row.move, row.score, row.mate_plies, row.mate_exact], [3, 29999, 1, true]);
    assert.equal(bestMoveWasm('0,4,1,5,2,6', 1000).lines[0].move, 3, 'must take the win');
    assert.equal(bestMoveWasm('0,4,1,5,2', 1000).lines[0].move, 3, 'must block the win');
    assert.equal(analyzeWasm('0,0,0,0,0', 3, 4, 1000).exit, 2, 'full column');
    assert.equal(bestMoveWasm('0,4,1,5,2,6,3', 1000).exit, 2, 'game over');
    assert.equal(bestMoveWasm('16', 1000).exit, 2, 'bad column');
});

test('bestmove respects its time limit and plays a legal column', () => {
    const start = performance.now();
    const { exit, lines } = bestMoveWasm('-', 500);
    assert.equal(exit, 0);
    assert.ok(performance.now() - start < 2000);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].move >= 0 && lines[0].move < 16);
    assert.ok(lines[0].depth > 1);
});

test('exact mate refinement matches an exhaustive oracle, both colors', () => {
    // Late nonterminal histories built independently of the engine, and a tiny
    // exhaustive distance oracle with no threats or pruning.
    let seed = 9082641;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (const pieces of [54, 55]) {
        let boards, heights, history;
        for (let attempt = 0; attempt < 10000; attempt++) {
            boards = [0n, 0n]; heights = Array(16).fill(0); history = [];
            for (let ply = 0; ply < pieces; ply++) {
                const columns = [...Array(16).keys()].sort(() => random() - 0.5);
                const col = columns.find(c => heights[c] < 4
                    && !wins(boards[ply % 2] | (1n << BigInt(c + 16 * heights[c]))));
                if (col === undefined) break;
                boards[ply % 2] |= 1n << BigInt(col + 16 * heights[col]);
                heights[col]++;
                history.push(col);
            }
            if (history.length === pieces) break;
        }
        assert.equal(history.length, pieces);

        const memo = new Map();
        const oracle = (board, side) => {
            const key = `${board[0]},${board[1]},${side}`;
            if (memo.has(key)) return memo.get(key);
            const occupied = board[0] | board[1];
            const count = occupied.toString(2).split('1').length - 1;
            let best = -32000;
            for (let col = 0; col < 16; col++) {
                for (let z = 0; z < 4; z++) {
                    const bit = 1n << BigInt(col + 16 * z);
                    if (occupied & bit) continue;
                    const child = [...board];
                    child[side] |= bit;
                    const score = wins(child[side]) ? 30000 - count - 1 : -oracle(child, 1 - side);
                    best = Math.max(best, score);
                    break;
                }
            }
            memo.set(key, best === -32000 ? 0 : best);
            return memo.get(key);
        };

        const expected = {};
        const side = pieces % 2;
        heights.forEach((height, col) => {
            if (height === 4) return;
            const child = [...boards];
            child[side] |= 1n << BigInt(col + 16 * height);
            let value = wins(child[side]) ? 30000 - pieces - 1 : -oracle(child, 1 - side);
            if (value) value += value > 0 ? pieces : -pieces;
            expected[col] = side === 0 ? value : -value;
        });

        const { lines } = analyzeWasm(history.join(','), 16, 64, 10000);
        const final = lines.filter(l => l.type === 'iteration').at(-1);
        assert.ok(final.mate_complete);
        assert.equal(final.phase, 'complete');
        assert.deepEqual(Object.fromEntries(final.moves.map(r => [r.move, r.score])), expected);
        const scores = final.moves.map(r => r.score);
        assert.deepEqual(scores, [...scores].sort((a, b) => side === 0 ? b - a : a - b));
        for (const row of final.moves) {
            assert.ok(row.solved && row.mate_exact);
            assert.equal(row.mate_plies, row.score ? 30000 - Math.abs(row.score) : null);
        }
        assert.equal(lines.at(-1).timed_out, false);
    }
});
