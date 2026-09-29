import { DurableObject } from 'cloudflare:workers';

const LIST_LIMIT = 50;
const STALE_MS = 10 * 60 * 1000;

// The single list of public rooms; each Room reports its head count here.
export class Lobby extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.ctx.blockConcurrencyWhile(async () => {
            this.rooms = (await this.ctx.storage.get('rooms')) || {};
        });
    }

    async update(code, info) {
        if (info.viewers > 0) this.rooms[code] = { ...info, code, updated: Date.now() };
        else delete this.rooms[code];
        await this.ctx.storage.put('rooms', this.rooms);
    }

    // A room whose last report is old is dropped in case its Room never reported leaving.
    async list() {
        const now = Date.now();
        let pruned = false;
        for (const [code, room] of Object.entries(this.rooms)) {
            if (now - room.updated > STALE_MS && room.viewers > 0) {
                delete this.rooms[code];
                pruned = true;
            }
        }
        if (pruned) await this.ctx.storage.put('rooms', this.rooms);
        return Object.values(this.rooms)
            .sort((a, b) => b.updated - a.updated)
            .slice(0, LIST_LIMIT)
            .map(({ code, name, viewers, players }) => ({ code, name, viewers, players }));
    }
}
