// A port of ai_agent.py's MCTS for the ResNet opponent. Boards are Int8Array(64)
// indexed [depth * 16 + row * 4 + col], depth 0 at the top, 1 / -1 for the players.

export const MCTS_ARGS = { C: 2.0, simulations: 500 };

const SIZE = 4;
const CELLS = 64;
const ACTIONS = 16;

const WIN_LINES = (() => {
    const lines = [];
    const dirs = [
        [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, -1, 0], [1, 0, 1], [1, 0, -1],
        [0, 1, 1], [0, 1, -1], [1, 1, 1], [1, -1, 1], [1, 1, -1], [1, -1, -1],
    ];
    const inside = v => v >= 0 && v < SIZE;
    for (let z = 0; z < SIZE; z++) for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        for (const [dx, dy, dz] of dirs) {
            if (!inside(x + 3 * dx) || !inside(y + 3 * dy) || !inside(z + 3 * dz)) continue;
            lines.push([0, 1, 2, 3].map(i => (z + i * dz) * 16 + (y + i * dy) * 4 + (x + i * dx)));
        }
    }
    return lines;
})();

export function currentPlayer(state) {
    let p1 = 0, p2 = 0;
    for (const v of state) { if (v === 1) p1++; else if (v === -1) p2++; }
    return p1 === p2 ? 1 : -1;
}

export function validMoves(state) {
    const valid = new Uint8Array(ACTIONS);
    for (let a = 0; a < ACTIONS; a++) valid[a] = state[a] === 0 ? 1 : 0;
    return valid;
}

export function nextState(state, action) {
    const next = Int8Array.from(state);
    let d = SIZE - 1;
    while (state[d * 16 + action] !== 0) d--;
    next[d * 16 + action] = currentPlayer(state);
    return next;
}

export function stateFromMoves(moves) {
    let state = new Int8Array(CELLS);
    for (const move of moves) state = nextState(state, move);
    return state;
}

// [value, terminal] from the side to move, as game.get_value_and_terminated.
export function valueAndTerminated(state) {
    const last = -currentPlayer(state);
    for (const line of WIN_LINES) {
        if (line.every(i => state[i] === last)) return [-1, true];
    }
    for (let a = 0; a < ACTIONS; a++) if (state[a] === 0) return [0, false];
    return [0, true];
}

// The network input: planes for player 1, player 2, empty, and a side-to-move plane.
export function encodeState(state) {
    const input = new Float32Array(4 * CELLS);
    const turn = currentPlayer(state) === 1 ? 1 : 0;
    for (let i = 0; i < CELLS; i++) {
        input[i] = state[i] === 1 ? 1 : 0;
        input[CELLS + i] = state[i] === -1 ? 1 : 0;
        input[2 * CELLS + i] = state[i] === 0 ? 1 : 0;
        input[3 * CELLS + i] = turn;
    }
    return input;
}

// Softmax over the logits, masked to legal moves and renormalised, in float32 like torch.
export function maskedPolicy(logits, valid) {
    let max = -Infinity;
    for (const l of logits) max = Math.max(max, l);
    let total = 0;
    const exp = new Float64Array(ACTIONS);
    for (let a = 0; a < ACTIONS; a++) { exp[a] = Math.exp(logits[a] - max); total += exp[a]; }
    const policy = new Float32Array(ACTIONS);
    let sum = 0;
    for (let a = 0; a < ACTIONS; a++) {
        policy[a] = Math.fround(exp[a] / total) * valid[a];
        sum = Math.fround(sum + policy[a]);
    }
    if (sum > 0) {
        for (let a = 0; a < ACTIONS; a++) policy[a] = policy[a] / sum;
    } else {
        const count = valid.reduce((n, v) => n + v, 0);
        for (let a = 0; a < ACTIONS; a++) policy[a] = valid[a] / count;
    }
    return policy;
}

class Node {
    constructor(state, parent = null, action = null, prior = 0) {
        this.state = state;
        this.parent = parent;
        this.action = action;
        this.prior = prior;
        this.children = [];
        this.visits = 0;
        this.valueSum = 0;
    }

    // UCB in float32, as NumPy 2 computes it with the float32 priors.
    select(C) {
        const f = Math.fround;
        let best = null;
        let bestUcb = -Infinity;
        const root = f(Math.sqrt(this.visits));
        for (const child of this.children) {
            const q = child.visits === 0 ? 0 : -child.valueSum / child.visits;
            const u = f(f(C) * f(f(child.prior * root) / (child.visits + 1)));
            const ucb = f(f(q) + u);
            if (ucb > bestUcb) { bestUcb = ucb; best = child; }
        }
        return best;
    }

    expand(policy) {
        for (let a = 0; a < ACTIONS; a++) {
            if (policy[a] > 0) this.children.push(new Node(nextState(this.state, a), this, a, policy[a]));
        }
    }

    backpropagate(value) {
        for (let node = this; node; node = node.parent, value = -value) {
            node.valueSum += value;
            node.visits++;
        }
    }
}

// Runs the search from `state` and returns the root's visit counts per column.
// `evaluate(input)` resolves to { logits, value } for one encoded board. Results are
// cached per position, so transpositions cost one network call.
export async function search(state, evaluate, { C = MCTS_ARGS.C, simulations = MCTS_ARGS.simulations, onProgress } = {}) {
    const cache = new Map();
    const root = new Node(state);
    for (let i = 0; i < simulations; i++) {
        let node = root;
        while (node.children.length > 0) node = node.select(C);

        let [value, terminal] = valueAndTerminated(node.state);
        if (!terminal) {
            const key = node.state.join(',');
            let out = cache.get(key);
            if (!out) {
                out = await evaluate(encodeState(node.state));
                cache.set(key, out);
            }
            node.expand(maskedPolicy(out.logits, validMoves(node.state)));
            value = out.value;
        }
        node.backpropagate(value);
        onProgress?.(i + 1, simulations);
    }
    const visits = new Array(ACTIONS).fill(0);
    for (const child of root.children) visits[child.action] = child.visits;
    return visits;
}

// The column with the most visits; ties go to the lowest column, as np.argmax.
export function bestAction(visits) {
    let best = 0;
    for (let a = 1; a < visits.length; a++) if (visits[a] > visits[best]) best = a;
    return best;
}
