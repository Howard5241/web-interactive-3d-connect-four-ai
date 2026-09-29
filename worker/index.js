import { ROOM_CODE_RE, cleanName, randomCode } from './roomCore.js';

export { Room } from './room.js';
export { Lobby } from './lobby.js';

const PAGE_HEADERS = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "frame-ancestors 'none'",
};
const MODEL_PATH = '/static/nn/model.onnx';
const MODEL_KEY = 'model.onnx';

function withHeaders(response, headers) {
    const out = new Response(response.body, response);
    for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
    return out;
}

const error = (message, status) => Response.json({ error: message }, { status });

// Browsers always send Origin on POST and WebSocket requests, so this stops other sites
// from creating rooms or joining them from their visitors' browsers.
function fromOtherSite(request, url) {
    const origin = request.headers.get('Origin');
    return origin !== null && origin !== url.origin;
}

function roomStub(env, code) {
    return env.ROOMS.get(env.ROOMS.idFromName(code));
}

// Public codes are short enough to read out; private ones are long enough not to guess.
async function createRoom(request, env) {
    let body = {};
    try {
        body = await request.json();
    } catch { /* defaults */ }
    const visibility = body.visibility === 'private' ? 'private' : 'public';
    const name = cleanName(body.name, visibility === 'public' ? 'Open room' : 'Private room');

    for (let attempt = 0; attempt < 5; attempt++) {
        const code = randomCode(visibility === 'public' ? 6 : 12);
        const meta = { code, name, visibility, created: Date.now() };
        const res = await roomStub(env, code).fetch('https://room/init', {
            method: 'POST',
            body: JSON.stringify(meta),
        });
        if (res.status === 409) continue;
        if (!res.ok) return error('Could not create the room.', 500);
        return Response.json(meta, { status: 201 });
    }
    return error('Could not create the room.', 500);
}

async function handleApi(request, env, url) {
    const parts = url.pathname.split('/').filter(Boolean);   // ['api', 'rooms', code?, 'ws'?]
    if (parts[1] !== 'rooms') return error('Not found', 404);
    if (request.method !== 'GET' && fromOtherSite(request, url)) return error('Forbidden', 403);

    if (parts.length === 2) {
        if (request.method === 'POST') return createRoom(request, env);
        if (request.method === 'GET') {
            const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
            return Response.json({ rooms: await lobby.list() });
        }
        return error('Method not allowed', 405);
    }

    const code = parts[2].toLowerCase();
    if (!ROOM_CODE_RE.test(code)) return error('Room not found', 404);
    const stub = roomStub(env, code);

    if (parts.length === 3) {
        const res = await stub.fetch('https://room/meta');
        return res.ok ? res : error('Room not found', 404);
    }
    if (parts.length === 4 && parts[3] === 'ws') {
        if (request.headers.get('Upgrade') !== 'websocket') return error('Expected a WebSocket', 426);
        if (fromOtherSite(request, url)) return error('Forbidden', 403);
        return stub.fetch(request);
    }
    return error('Not found', 404);
}

// The network is over the 25 MiB static-asset limit, so it lives in R2.
async function serveModel(request, env) {
    const object = await env.MODELS.get(MODEL_KEY, {
        onlyIf: request.headers,
    });
    if (!object) return new Response('Model not uploaded', { status: 404 });
    const headers = new Headers(PAGE_HEADERS);
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=86400');
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
    if (!('body' in object) || !object.body) return new Response(null, { status: 304, headers });
    return new Response(object.body, { headers });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
        if (url.pathname === MODEL_PATH) return serveModel(request, env);
        if (/^\/r\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
            const page = await env.ASSETS.fetch(new URL('/room', url));
            return withHeaders(page, PAGE_HEADERS);
        }
        return env.ASSETS.fetch(request);
    },
};
