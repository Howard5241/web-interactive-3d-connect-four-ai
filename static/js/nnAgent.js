// The ResNet + MCTS opponent, running in this browser (see nnWorker.js). The worker
// stays alive between moves so the network is only downloaded and compiled once.
import { MCTS_ARGS } from './nnMcts.js';

let worker = null;
let nextId = 0;
const pending = new Map();

function spawn() {
    if (worker) return worker;
    worker = new Worker(new URL('./nnWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
        const job = pending.get(data.id);
        if (!job) return;
        if ('status' in data) {
            job.onStatus(data.status);
        } else if ('progress' in data) {
            job.onProgress(...data.progress);
        } else {
            pending.delete(data.id);
            if (data.error) job.reject(new Error(data.error));
            else job.resolve({ move: data.move, visits: data.visits });
        }
    };
    // Only reachable if the worker script or ONNX Runtime fails to load.
    worker.onerror = event => {
        event.preventDefault();
        worker.terminate();
        worker = null;
        for (const job of pending.values()) job.reject(new Error('Could not load the AI in this browser.'));
        pending.clear();
    };
    return worker;
}

// The column the AI plays after `moves`. `onStatus` hears 'loading' and then the
// backend ('webgpu' or 'wasm'); `onProgress(done, total)` follows the search.
export function aiMove(moves, { simulations = MCTS_ARGS.simulations, onStatus = () => {}, onProgress = () => {} } = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onStatus, onProgress });
        spawn().postMessage({ id, moves: [...moves], simulations });
    });
}
