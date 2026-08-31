// Keeps every browser on the site looking at the same board.
//
// The shared state (board, move history, viewed move, planning ghosts, Puzzle Mode)
// lives on the server in a "room"; this module is the client half of that protocol:
// it polls for other people's changes, pushes our own, and tracks who else is here.
// See room_state.py for the server side.
//
// Polling rather than a socket is deliberate: the Flask dev server runs single
// threaded (so the PyTorch model is only ever touched by one request at a time), and a
// long-lived stream would monopolise that one thread. Each poll is a few bytes when
// nothing changed.

const POLL_MS_VISIBLE = 400;    // the tab is on screen: near-live
const POLL_MS_HIDDEN = 2500;    // backgrounded: just enough to stay in the viewer list
const POLL_MS_ERROR = 2000;     // server unreachable: back off, keep retrying

// Per-tab identity. sessionStorage (not localStorage) is the right scope: two tabs of
// the same browser are two viewers, and a reload keeps the same seat.
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
    /**
     * @param {object} handlers
     *   onState(state, meta)   a new shared state arrived (never our own pushes)
     *   onPresence(clients)    the viewer list changed
     *   onLog(entries)         other viewers' log lines (ours are never echoed back)
     *   onConnection(status)   'online' | 'offline'
     */
    constructor(handlers = {}) {
        this.handlers = handlers;
        this.clientId = loadClientId();
        this.room = new URLSearchParams(location.search).get('room') || 'main';
        this.version = -1;          // -1 = "we have nothing", so the first poll fetches state
        this.logSeq = null;
        this.session = null;        // server process id; a change means it restarted
        this.clients = [];
        this.online = false;
        this._timer = null;
        this._pushing = false;
        this._stopped = false;
    }

    get me() {
        return this.clients.find(c => c.id === this.clientId) || null;
    }

    start() {
        this._stopped = false;
        this._poll();
        // A backgrounded tab polls slowly; coming back should catch up immediately.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.poke();
        });
        // Free our seat in the viewer list straight away instead of waiting for the
        // heartbeat to time out. sendBeacon survives the page teardown; fetch may not.
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

    /** Poll again right now (after a local change, or on becoming visible). */
    poke() {
        if (this._stopped) return;
        clearTimeout(this._timer);
        this._poll();
    }

    /**
     * Send a partial change to the shared state.
     * @param {object} patch    the state fields that changed
     * @param {object} opts
     *   expect  send our version as base_version, so a move that raced with someone
     *           else's is rejected rather than silently overwriting theirs
     *   log     a line for the shared log, attributed to us
     * @returns {Promise<{ok:boolean, conflict?:boolean, state?:object}>}
     */
    async push(patch, opts = {}) {
        const body = {
            room: this.room,
            client_id: this.clientId,
            patch,
        };
        if (opts.expect && this.version >= 0) body.base_version = this.version;
        if (opts.log) body.log = opts.log;
        // Our place in the shared log, so the reply carries only what we haven't seen.
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
                // Someone got there first: nothing of ours was applied. The response
                // carries the state we missed, and _absorb hands it to onState, so the
                // caller only has to tell the user their move was undone.
                this._absorb(data);
                return { ok: false, conflict: true };
            }
            if (!res.ok) {
                console.warn('Rejected room push:', data.error, patch);
                return { ok: false, error: data.error };
            }
            // Success: take the new version. _absorb skips re-applying our own state.
            this._absorb(data);
            return { ok: true, version: data.version };
        } catch (err) {
            this._setConnection(false);
            return { ok: false, error: String(err) };
        } finally {
            this._pushing = false;
            this.poke();   // let everyone else's changes in promptly too
        }
    }

    async _poll() {
        if (this._stopped) return;
        let delay = document.hidden ? POLL_MS_HIDDEN : POLL_MS_VISIBLE;
        try {
            // A push in flight is about to give us a newer snapshot anyway.
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

    /** Fold a server response into our view of the room. */
    _absorb(data) {
        if (!data) return;

        // The server restarted: its version numbers start again, so ours mean nothing.
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

        // A state we produced ourselves is already on screen; re-applying it would
        // restart drop animations and wipe the ghosts we just placed.
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
