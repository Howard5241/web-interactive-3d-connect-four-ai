import { DurableObject } from 'cloudflare:workers';
import {
    GUEST_COLORS, LOG_TAIL_ON_JOIN, appendLog, applyPatch, cleanClientId, cleanName,
    newRoomData, releaseStaleBusy, takeSeat,
} from './roomCore.js';

const IDLE_DELETE_MS = 14 * 24 * 3600 * 1000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const LOBBY_REFRESH_MS = 2 * 60 * 1000;

// One instance per room code. Sockets use the hibernation API, so an idle room costs
// nothing; everything needed after waking is in storage or on the socket attachments.
export class Room extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
        this.ctx.blockConcurrencyWhile(async () => {
            this.meta = (await this.ctx.storage.get('meta')) || null;
            this.data = (await this.ctx.storage.get('data')) || null;
        });
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/init' && request.method === 'POST') {
            if (this.meta) return new Response('exists', { status: 409 });
            const meta = await request.json();
            this.meta = meta;
            this.data = newRoomData();
            await this.ctx.storage.put({ meta: this.meta, data: this.data });
            await this.ctx.storage.setAlarm(Date.now() + IDLE_DELETE_MS);
            return Response.json(meta);
        }
        if (!this.meta) return new Response('Room not found', { status: 404 });
        if (url.pathname === '/meta') return Response.json(this.meta);
        if (request.headers.get('Upgrade') === 'websocket') return this.connect(url);
        return new Response('Not found', { status: 404 });
    }

    connect(url) {
        let clientId;
        try {
            clientId = cleanClientId(url.searchParams.get('client_id'));
        } catch (e) {
            return new Response(e.message, { status: 400 });
        }
        const others = this.clients().filter(c => c.id !== clientId);
        const existing = this.clients().find(c => c.id === clientId);
        let number = existing?.number;
        if (!number) {
            const taken = new Set(others.map(c => c.number));
            number = 1;
            while (taken.has(number)) number++;
        }
        const client = {
            id: clientId,
            number,
            name: cleanName(url.searchParams.get('name'), `Guest ${number}`),
            color: GUEST_COLORS[(number - 1) % GUEST_COLORS.length],
        };

        const [browser, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment(client);

        const d = this.data;
        this.send(server, {
            t: 'hello',
            you: clientId,
            meta: this.meta,
            version: d.version,
            origin: d.origin,
            state: d.state,
            log: d.log.slice(-LOG_TAIL_ON_JOIN),
            log_seq: d.log_seq,
        });
        this.broadcastPresence();
        this.ctx.waitUntil(this.reportToLobby());
        return new Response(null, { status: 101, webSocket: browser });
    }

    async webSocketMessage(ws, raw) {
        if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return;
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        const client = ws.deserializeAttachment();
        if (!client) return;

        if (msg.t === 'push') await this.handlePush(ws, client, msg);
        else if (msg.t === 'seat') await this.handleSeat(ws, client, msg);
    }

    async handlePush(ws, client, msg) {
        const d = this.data;
        this.dropStaleLock();
        const base = Number.isInteger(msg.base) ? msg.base : null;
        const result = applyPatch(d, client.id, msg.patch, { baseVersion: base });

        if (!result.ok) {
            this.send(ws, {
                t: 'ack', id: msg.id, ok: false, conflict: !!result.conflict, error: result.error,
                version: d.version, origin: d.origin, state: d.state,
            });
            return;
        }

        if (Date.now() - (this.lastReport || 0) > LOBBY_REFRESH_MS) this.ctx.waitUntil(this.reportToLobby());
        const entry = appendLog(d, msg.log, client);
        if (result.changed || entry) await this.save();
        this.send(ws, { t: 'ack', id: msg.id, ok: true, version: d.version });
        if (result.changed) {
            this.broadcast({ t: 'state', version: d.version, origin: d.origin, state: d.state }, ws);
        }
        if (entry) this.broadcast({ t: 'log', entries: [entry] }, ws);
    }

    async handleSeat(ws, client, msg) {
        const seat = msg.seat === null ? null : String(msg.seat);
        const result = takeSeat(this.data, client.id, seat, this.connectedIds());
        this.send(ws, { t: 'ack', id: msg.id, ok: result.ok, error: result.error, version: this.data.version });
        if (!result.ok) return;
        await this.save();
        this.broadcastPresence();
        this.ctx.waitUntil(this.reportToLobby());
    }

    async webSocketClose(ws, code) {
        try {
            ws.close(code, 'closing');
        } catch { /* already closed */ }
        await this.onDisconnect();
    }

    async webSocketError() {
        await this.onDisconnect();
    }

    async onDisconnect() {
        if (this.dropStaleLock()) {
            await this.save();
            const d = this.data;
            this.broadcast({ t: 'state', version: d.version, origin: d.origin, state: d.state });
        }
        this.broadcastPresence();
        await this.reportToLobby();
        if (!this.sockets().length) await this.ctx.storage.setAlarm(Date.now() + IDLE_DELETE_MS);
    }

    async alarm() {
        if (this.sockets().length) return;
        await this.ctx.storage.deleteAll();
        this.meta = null;
        this.data = null;
    }

    dropStaleLock() {
        return releaseStaleBusy(this.data, this.connectedIds());
    }

    sockets() {
        return this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN);
    }

    clients() {
        const byId = new Map();
        for (const ws of this.sockets()) {
            const c = ws.deserializeAttachment();
            if (c && !byId.has(c.id)) byId.set(c.id, c);
        }
        return [...byId.values()].sort((a, b) => a.number - b.number);
    }

    connectedIds() {
        return new Set(this.clients().map(c => c.id));
    }

    save() {
        return this.ctx.storage.put('data', this.data);
    }

    send(ws, msg) {
        try {
            ws.send(JSON.stringify(msg));
        } catch { /* closing socket */ }
    }

    broadcast(msg, except = null) {
        const text = JSON.stringify(msg);
        for (const ws of this.sockets()) {
            if (ws === except) continue;
            try {
                ws.send(text);
            } catch { /* closing socket */ }
        }
    }

    broadcastPresence() {
        this.broadcast({
            t: 'presence',
            clients: this.clients().map(({ id, name, color }) => ({ id, name, color })),
            seats: this.data.seats,
        });
    }

    async reportToLobby() {
        if (this.meta?.visibility !== 'public') return;
        this.lastReport = Date.now();
        const clients = this.clients();
        const seated = Object.values(this.data.seats).filter(id => id && clients.some(c => c.id === id));
        const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
        await lobby.update(this.meta.code, {
            name: this.meta.name,
            viewers: clients.length,
            players: seated.length,
        });
    }
}
