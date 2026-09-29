// Request:  { id, moves, simulations }
// Replies:  { id, status }                  on first use: 'loading', then 'webgpu' or 'wasm'
//           { id, progress: [done, total] }
//           { id, move, visits }            or { id, error }
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.min.mjs';
import { search, bestAction, stateFromMoves } from './nnMcts.js';

const MODEL_URL = new URL('../nn/model.onnx', import.meta.url);

let loading = null;

async function load() {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`could not download the network (${res.status})`);
    const model = new Uint8Array(await res.arrayBuffer());
    let lastError = null;
    for (const backend of ['webgpu', 'wasm']) {
        if (backend === 'webgpu' && !globalThis.navigator?.gpu) continue;
        try {
            const session = await ort.InferenceSession.create(model, { executionProviders: [backend] });
            return { session, backend };
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

async function evaluator(id) {
    if (!loading) {
        postMessage({ id, status: 'loading' });
        loading = load();
        loading.then(({ backend }) => postMessage({ id, status: backend }), () => { loading = null; });
    }
    const { session } = await loading;
    return async input => {
        const out = await session.run({ board: new ort.Tensor('float32', input, [1, 4, 4, 4, 4]) });
        return { logits: Array.from(out.policy.data), value: out.value.data[0] };
    };
}

onmessage = async ({ data }) => {
    const { id } = data;
    try {
        const evaluate = await evaluator(id);
        const onProgress = (done, total) => {
            if (done % 10 === 0 || done === total) postMessage({ id, progress: [done, total] });
        };
        const visits = await search(stateFromMoves(data.moves), evaluate, { simulations: data.simulations, onProgress });
        postMessage({ id, move: bestAction(visits), visits });
    } catch (error) {
        postMessage({ id, error: `AI failed: ${error.message ?? error}` });
    }
};
