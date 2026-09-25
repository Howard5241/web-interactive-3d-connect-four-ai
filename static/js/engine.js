// The V4 engine, running in this browser: a WebAssembly build of the C++ engine
// (static/engine/, built by build_wasm.sh in the engine repo) inside a Web Worker.
//
// One worker serves the whole tab. A search is a single synchronous call inside
// it, so the only way to stop one is to terminate the worker; the next request
// starts a fresh one. Starting a request cancels whatever was running.

// Analysis limits: every root move ranked, full depth, the engine's 30-minute cap.
const ANALYSIS = { top: 16, depth: 64, ms: 1800000 };
// The minimax opponent: the Playground's "Strong V4" bot at its 3 s default.
export const MINIMAX_MS = 3000;

class EngineWorker {
    constructor(url) {
        this.url = url;
        this.worker = null;
        this.job = null;
        this.nextId = 0;
    }

    // Resolves with { exit, error } when the engine returns, or { cancelled: true }.
    // `onLine` receives each NDJSON line the engine prints while it runs.
    run(request, onLine = () => {}) {
        this.cancel();
        const id = ++this.nextId;
        const job = { id, onLine };
        job.promise = new Promise(resolve => { job.resolve = resolve; });
        this.job = job;
        this.spawn().postMessage({ id, ...request });
        return { promise: job.promise, cancel: () => { if (this.job === job) this.cancel(); } };
    }

    cancel() {
        const job = this.job;
        if (!job) return;
        this.job = null;
        this.worker?.terminate();
        this.worker = null;
        job.resolve({ cancelled: true });
    }

    spawn() {
        if (this.worker) return this.worker;
        const worker = new Worker(this.url, { type: 'module' });
        worker.onmessage = ({ data }) => {
            const job = this.job;
            if (!job || data.id !== job.id) return;
            if ('line' in data) {
                job.onLine(data.line);
            } else {
                this.job = null;
                job.resolve({ exit: data.exit, error: data.error });
            }
        };
        // Only reachable if the worker script or engine module fails to load.
        worker.onerror = event => {
            event.preventDefault();
            const job = this.job;
            this.job = null;
            worker.terminate();
            if (this.worker === worker) this.worker = null;
            job?.resolve({ exit: -1, error: 'Could not load the browser engine.' });
        };
        this.worker = worker;
        return worker;
    }
}

export const engine = new EngineWorker(new URL('./engineWorker.js', import.meta.url));

export function newAnalysisSnapshot(position) {
    return {
        running: true, depth: 0, moves: [], nodes: 0, elapsed_ms: 0,
        complete: false, error: null, position: [...position],
    };
}

// Folds one engine line into the snapshot the panel draws. Returns true when the
// snapshot changed. Throws on output that is not the analysis protocol.
export function applyAnalysisLine(snapshot, update) {
    if (!update || !['iteration', 'terminal', 'done'].includes(update.type)) {
        throw new Error('Unsupported engine protocol');
    }
    if (update.type === 'done') {
        snapshot.timed_out = Boolean(update.timed_out);
        return true;
    }
    // Retain the last iteration of the matching parity: Light uses even depths,
    // Dark odd. Fully proved results and per-move mate refinements bypass it, as
    // their depth is not a heuristic horizon.
    if (update.type === 'iteration' && !update.complete && update.phase !== 'mate'
            && update.depth % 2 !== snapshot.position.length % 2) {
        return false;
    }
    Object.assign(snapshot, update);
    return true;
}

// Analyzes `moves` until the search ends or the returned handle is cancelled.
// `onSnapshot` receives a fresh copy of the snapshot whenever it changes; the last
// one has running: false, and error set if the engine failed.
export function analyze(moves, onSnapshot) {
    const snapshot = newAnalysisSnapshot(moves);
    const publish = () => onSnapshot(structuredClone(snapshot));
    let received = false;
    let error = null;
    const job = engine.run({ command: 'analyze', moves, ...ANALYSIS }, line => {
        if (error) return;
        try {
            if (line?.type !== 'done') received = true;
            if (applyAnalysisLine(snapshot, line)) publish();
        } catch (e) {
            error = e.message;
        }
    });
    job.promise.then(result => {
        if (result.cancelled) return;
        if (error || result.exit !== 0 || !received) {
            snapshot.error = `Engine analysis failed: ${error || result.error || 'no result'}.`;
        }
        snapshot.running = false;
        publish();
    });
    return job;
}

// The column the minimax opponent plays after `moves`.
export async function bestMove(moves, ms = MINIMAX_MS) {
    let reply = null;
    const job = engine.run({ command: 'bestmove', moves, ms }, line => {
        if (line?.type === 'bestmove') reply = line;
    });
    const result = await job.promise;
    if (result.cancelled) throw new Error('Engine search was cancelled.');
    if (result.exit !== 0 || !reply) throw new Error(result.error || 'Engine returned no move.');
    return reply;
}
