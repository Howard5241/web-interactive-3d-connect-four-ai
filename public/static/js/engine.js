// The C++ engine as WebAssembly (static/engine/) in a Web Worker. A search is one
// synchronous call, so cancelling terminates the worker; a new request cancels the old one.

const ANALYSIS = { top: 16, depth: 64, ms: 1800000 };
export const MINIMAX_MS = 3000;

class EngineWorker {
    constructor(url) {
        this.url = url;
        this.worker = null;
        this.job = null;
        this.nextId = 0;
    }

    // Resolves with { exit, error } or { cancelled: true }; onLine gets each NDJSON line.
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

// Folds one engine line into the snapshot; returns true when it changed.
export function applyAnalysisLine(snapshot, update) {
    if (!update || !['iteration', 'terminal', 'done'].includes(update.type)) {
        throw new Error('Unsupported engine protocol');
    }
    if (update.type === 'done') {
        snapshot.timed_out = Boolean(update.timed_out);
        return true;
    }
    // Keep even depths for Light and odd for Dark; proofs and mate refinement always pass.
    if (update.type === 'iteration' && !update.complete && update.phase !== 'mate'
            && update.depth % 2 !== snapshot.position.length % 2) {
        return false;
    }
    Object.assign(snapshot, update);
    return true;
}

// onSnapshot gets a copy on every change; the last has running: false (and error on failure).
// engineName: 'v5' or 'balanced'.
export function analyze(moves, onSnapshot, engineName = 'v5') {
    const snapshot = newAnalysisSnapshot(moves);
    const publish = () => onSnapshot(structuredClone(snapshot));
    let received = false;
    let error = null;
    const job = engine.run({ command: 'analyze', moves, engine: engineName, ...ANALYSIS }, line => {
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
