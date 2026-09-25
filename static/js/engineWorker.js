// Runs the V4 C++ engine (compiled to WebAssembly) off the main thread.
//
// Request:  { id, command: 'analyze', moves, top, depth, ms }
//           { id, command: 'bestmove', moves, ms }
// Replies:  { id, line }            one parsed NDJSON line from the engine
//           { id, exit, error }     the command returned; error is the engine's stderr, if any
//
// A search is one synchronous call into the engine, so this worker cannot take a
// second message mid-search. Cancelling means terminating the worker; see engine.js.
import createEngine from '../engine/connect4_engine.js';

let current = null;       // id of the command whose output the engine is printing
let stderr = [];
const engine = createEngine({
    print: text => {
        let line;
        try {
            line = JSON.parse(text);
        } catch {
            return; // not protocol output
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
        ? module.ccall('engine_analyze', 'number', ['string', 'number', 'number', 'number'],
            [history, data.top, data.depth, data.ms])
        : module.ccall('engine_bestmove', 'number', ['string', 'number'], [history, data.ms]);
    postMessage({ id: data.id, exit, error: stderr.join('\n') || null });
};
