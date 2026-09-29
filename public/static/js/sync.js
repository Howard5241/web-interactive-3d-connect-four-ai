// Client half of the room protocol (server: worker/room.js), over one WebSocket.

const PING_MS = 25_000;
const ACK_TIMEOUT_MS = 10_000;
const RETRY_MS = [500, 1000, 2000, 4000, 8000];

// sessionStorage: two tabs are two viewers, and a reload keeps its seat.
function loadClientId() {
    const KEY = 'c4-client-id';
    let id = null;
    try {
        id = sessionStorage.getItem(KEY);
    } catch (e) { /* private mode: fall through to a per-load id */ }
    if (!id) {
        id = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        try { sessionStorage.setItem(KEY, id); } catch (e) { /* non-critical */ }
    }
    return id;
}

export function loadPlayerName() {
    try {
        return localStorage.getItem('c4-name') || '';
    } catch (e) {
        return '';
    }
}

export function roomCodeFromPath() {
    const m = location.pathname.match(/^\/r\/([A-Za-z0-9]+)/);
    return m ? m[1].toLowerCase() : null;
}

export class RoomSync {
    // handlers: onState(state, meta), onPresence(clients, seats), onLog(entries),
    // onConnection('online' | 'offline'), onMeta(meta), onRejected(error), onMissing().
    // Our own pushes and log lines are never echoed back.
    constructor(handlers = {}) {
        this.handlers = handlers;
        this.clientId = loadClientId();
        this.room = roomCodeFromPath();
        this.meta = null;
        this.version = -1;
        this.logSeq = null;
        this.clients = [];
        this.seats = { '1': null, '-1': null };
        this.online = false;
        this.ws = null;
        this._nextId = 1;
        this._pending = new Map();
        this._retry = 0;
        this._stopped = false;
        this._pingTimer = null;
    }

    start() {
        this._stopped = false;
        this._connect();
    }

    stop() {
        this._stopped = true;
        clearInterval(this._pingTimer);
        this.ws?.close();
    }

    // Seat holder for a player (1 or -1), or null.
    seatOf(player) {
        return this.seats[String(player)] || null;
    }

    mySeat() {
        if (this.seats['1'] === this.clientId) return 1;
        if (this.seats['-1'] === this.clientId) return -1;
        return null;
    }

    // Mirrors checkPermission in worker/roomCore.js for the common single move.
    canPlay(player) {
        const anySeated = this.seats['1'] || this.seats['-1'];
        if (!anySeated) return true;
        if (this.mySeat() === null) return false;
        const holder = this.seatOf(player);
        return !holder || holder === this.clientId;
    }

    async _connect() {
        if (this._stopped || !this.room) return;
        const exists = await fetch(`/api/rooms/${this.room}`).then(r => r.status !== 404).catch(() => true);
        if (!exists) {
            this._stopped = true;
            this.handlers.onMissing?.();
            return;
        }

        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const params = new URLSearchParams({ client_id: this.clientId });
        const name = loadPlayerName();
        if (name) params.set('name', name);
        const ws = new WebSocket(`${proto}//${location.host}/api/rooms/${this.room}/ws?${params}`);
        this.ws = ws;

        ws.onopen = () => {
            this._retry = 0;
            clearInterval(this._pingTimer);
            this._pingTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send('ping');
            }, PING_MS);
        };
        ws.onmessage = (event) => {
            if (event.data === 'pong') return;
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (e) {
                return;
            }
            this._handle(msg);
        };
        ws.onclose = () => {
            if (this.ws !== ws) return;
            clearInterval(this._pingTimer);
            this._setConnection(false);
            for (const { resolve, timer } of this._pending.values()) {
                clearTimeout(timer);
                resolve({ ok: false, error: 'disconnected' });
            }
            this._pending.clear();
            if (this._stopped) return;
            const delay = RETRY_MS[Math.min(this._retry++, RETRY_MS.length - 1)];
            setTimeout(() => this._connect(), delay);
        };
    }

    _handle(msg) {
        switch (msg.t) {
            case 'hello':
                this.meta = msg.meta;
                this.handlers.onMeta?.(msg.meta);
                this._setConnection(true);
                this.version = msg.version;
                this.handlers.onState?.(msg.state, msg);
                this._absorbLog(msg.log);
                if (this.logSeq === null || msg.log_seq < this.logSeq) this.logSeq = msg.log_seq;
                break;
            case 'state':
                this.version = msg.version;
                if (msg.origin !== this.clientId) this.handlers.onState?.(msg.state, msg);
                break;
            case 'presence':
                this.clients = msg.clients || [];
                this.seats = msg.seats || this.seats;
                this.handlers.onPresence?.(this.clients, this.seats);
                break;
            case 'log':
                this._absorbLog(msg.entries);
                break;
            case 'ack': {
                const pending = this._pending.get(msg.id);
                if (!pending) break;
                this._pending.delete(msg.id);
                clearTimeout(pending.timer);
                if (typeof msg.version === 'number') this.version = msg.version;
                // A rejected push was already drawn locally, so redraw the room's board.
                if (!msg.ok && msg.state) this.handlers.onState?.(msg.state, msg);
                if (!msg.ok && msg.error && !msg.conflict) this.handlers.onRejected?.(msg.error);
                pending.resolve({ ok: msg.ok, conflict: !!msg.conflict, error: msg.error, version: msg.version });
                break;
            }
        }
    }

    _absorbLog(entries) {
        if (!Array.isArray(entries) || !entries.length) return;
        const fresh = entries.filter(e => this.logSeq === null || e.seq > this.logSeq);
        this.logSeq = Math.max(this.logSeq ?? 0, ...entries.map(e => e.seq));
        const others = fresh.filter(e => e.client !== this.clientId);
        if (others.length) this.handlers.onLog?.(others);
    }

    _send(msg) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.resolve({ ok: false, error: 'offline' });
        }
        const id = this._nextId++;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this._pending.delete(id);
                resolve({ ok: false, error: 'timeout' });
            }, ACK_TIMEOUT_MS);
            this._pending.set(id, { resolve, timer });
            this.ws.send(JSON.stringify({ ...msg, id }));
        });
    }

    // opts.expect sends our version as `base`, so a racing move is rejected instead of
    // overwriting; opts.log adds a shared log line.
    push(patch, opts = {}) {
        const msg = { t: 'push', patch };
        if (opts.expect && this.version >= 0) msg.base = this.version;
        if (opts.log) msg.log = opts.log;
        return this._send(msg);
    }

    // 1, -1, or null to stand up.
    takeSeat(player) {
        return this._send({ t: 'seat', seat: player });
    }

    _setConnection(online) {
        if (online === this.online) return;
        this.online = online;
        this.handlers.onConnection?.(online ? 'online' : 'offline');
    }
}
