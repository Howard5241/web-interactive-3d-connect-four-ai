// Client half of the shared-room protocol (server side: room_state.py). Polls rather than
// streams because the single-threaded dev server would be held by a long-lived connection.

const POLL_MS_VISIBLE = 400;
const POLL_MS_HIDDEN = 2500;    // enough to stay in the viewer list
const POLL_MS_ERROR = 2000;

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

export class RoomSync {
    // handlers: onState(state, meta), onPresence(clients), onLog(entries),
    // onConnection('online' | 'offline'). Our own pushes and log lines are never echoed.
    constructor(handlers = {}) {
        this.handlers = handlers;
        this.clientId = loadClientId();
        this.room = new URLSearchParams(location.search).get('room') || 'main';
        this.version = -1;          // nothing yet: the first poll fetches the full state
        this.logSeq = null;
        this.session = null;        // changes when the server restarts
        this.clients = [];
        this.online = false;
        this._timer = null;
        this._pushing = false;
        this._stopped = false;
    }

    start() {
        this._stopped = false;
        this._poll();
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.poke();
        });
        // sendBeacon survives page teardown; fetch may not.
        window.addEventListener('pagehide', () => {
            const body = JSON.stringify({ room: this.room, client_id: this.clientId });
            try {
                navigator.sendBeacon('/api/room/leave', body);
            } catch (e) { /* nothing useful to do while unloading */ }
        });
    }

    stop() {
        this._stopped = true;
        clearTimeout(this._timer);
    }

    poke() {
        if (this._stopped) return;
        clearTimeout(this._timer);
        this._poll();
    }

    // opts.expect sends our version as base_version, so a racing move is rejected (409)
    // instead of overwriting; opts.log adds a shared log line.
    async push(patch, opts = {}) {
        const body = {
            room: this.room,
            client_id: this.clientId,
            patch,
        };
        if (opts.expect && this.version >= 0) body.base_version = this.version;
        if (opts.log) body.log = opts.log;
        if (this.logSeq !== null) body.log_since = this.logSeq;

        this._pushing = true;
        try {
            const res = await fetch('/api/room/state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            this._setConnection(true);

            if (res.status === 409) {
                // Nothing of ours was applied; _absorb hands the state we missed to onState.
                this._absorb(data);
                return { ok: false, conflict: true };
            }
            if (!res.ok) {
                console.warn('Rejected room push:', data.error, patch);
                return { ok: false, error: data.error };
            }
            this._absorb(data);
            return { ok: true, version: data.version };
        } catch (err) {
            this._setConnection(false);
            return { ok: false, error: String(err) };
        } finally {
            this._pushing = false;
            this.poke();
        }
    }

    async _poll() {
        if (this._stopped) return;
        let delay = document.hidden ? POLL_MS_HIDDEN : POLL_MS_VISIBLE;
        try {
            // A push in flight returns a newer snapshot anyway.
            if (!this._pushing) {
                const params = new URLSearchParams({
                    room: this.room,
                    client_id: this.clientId,
                });
                if (this.version >= 0) params.set('since', String(this.version));
                if (this.logSeq !== null) params.set('log_since', String(this.logSeq));

                const res = await fetch(`/api/room/state?${params}`);
                if (!res.ok) throw new Error(`room poll failed (${res.status})`);
                const data = await res.json();
                this._setConnection(true);   // before _absorb, so presence renders as online
                this._absorb(data);
            }
        } catch (err) {
            this._setConnection(false);
            delay = POLL_MS_ERROR;
        }
        if (!this._stopped) this._timer = setTimeout(() => this._poll(), delay);
    }

    _absorb(data) {
        if (!data) return;

        if (this.session && data.session !== this.session) {
            this.version = -1;
            this.logSeq = null;
        }
        this.session = data.session;

        if (Array.isArray(data.clients) && this._clientsChanged(data.clients)) {
            this.clients = data.clients;
            this.handlers.onPresence?.(this.clients);
        }

        const previousVersion = this.version;
        if (typeof data.version === 'number') this.version = data.version;

        // Our own state is already on screen.
        if (data.state && data.origin !== this.clientId && data.version !== previousVersion) {
            this.handlers.onState?.(data.state, data);
        }

        if (Array.isArray(data.log) && data.log.length) {
            this.logSeq = data.log[data.log.length - 1].seq;
            const others = data.log.filter(e => e.client !== this.clientId);
            if (others.length) this.handlers.onLog?.(others);
        } else if (typeof data.log_seq === 'number' && this.logSeq === null) {
            this.logSeq = data.log_seq;
        }
    }

    _clientsChanged(next) {
        if (next.length !== this.clients.length) return true;
        return next.some((c, i) => c.id !== this.clients[i].id || c.name !== this.clients[i].name);
    }

    _setConnection(online) {
        if (online === this.online) return;
        this.online = online;
        this.handlers.onConnection?.(online ? 'online' : 'offline');
    }
}
