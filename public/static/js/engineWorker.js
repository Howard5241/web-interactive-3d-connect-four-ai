// Request:  { id, command: 'analyze', moves, top, depth, ms, engine } | { id, command: 'bestmove', moves, ms }
// Replies:  { id, line } per NDJSON line, then { id, exit, error }
import createEngine from '../engine/connect4_engine.js';

let current = null;
let stderr = [];
const engine = createEngine({
    print: text => {
        let line;
        try {
            line = JSON.parse(text);
        } catch {
            return;
        }
        postMessage({ id: current, line });
    },
    printErr: text => stderr.push(text),
});

onmessage = async ({ data }) => {
    let module;
    try {
        module = await engine;
    } catch (error) {
        postMessage({ id: data.id, exit: -1, error: `Could not load the browser engine: ${error.message}` });
        return;
    }
    current = data.id;
    stderr = [];
    const history = data.moves.length ? data.moves.join(',') : '-';
    const exit = data.command === 'analyze'
        ? module.ccall('engine_analyze', 'number', ['string', 'number', 'number', 'number', 'string'],
            [history, data.top, data.depth, data.ms, data.engine])
        : module.ccall('engine_bestmove', 'number', ['string', 'number'], [history, data.ms]);
    postMessage({ id: data.id, exit, error: stderr.join('\n') || null });
};
