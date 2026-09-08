import { formatColumn, onColumnNumberingChange } from './columnLabels.js';

// One serialized request loop per tab. Revisions prevent late responses from
// painting a different board; only complete engine iterations replace the lines.
export class AnalysisPanel {
    // onBest receives the column the engine currently likes, or null whenever there is
    // nothing to point at (no completed iteration yet, game over, analysis off, or the
    // board indicator switched off in the panel's settings).
    constructor(onToggle, onPlay, onBest = () => {}) {
        this.enabled = false;
        this.paused = false;
        this.moves = [];
        this.revision = 0;
        this.job = null;
        this.busy = false;
        this.failed = false;
        this.finished = false;
        this.last = null;
        this.data = null;
        this.bestMove = null;
        this.onToggle = onToggle;
        this.onPlay = onPlay;
        this.onBest = onBest;
        this.el = id => document.getElementById(id);
        this.el('analysis-pause').addEventListener('click', () => {
            this.paused = !this.paused;
            this.finished = false;
            this.revision++;
            this.failed = false;
            this.el('analysis-pause').textContent = this.paused ? 'Resume' : 'Pause';
            this.status(this.paused ? 'Paused · last completed evaluation retained' : 'Starting engine…');
            this.tick();
        });
        this.el('analysis-top').addEventListener('change', () => this.invalidate());
        this.el('analysis-best-toggle').addEventListener('change', () => this.emitBest());
        this.el('analysis-settings-btn').addEventListener('click', event => {
            event.stopPropagation();
            this.showSettings(this.el('analysis-settings').classList.contains('hidden'));
        });
        // The popover is a transient menu: anything outside it, or Escape, closes it.
        document.addEventListener('click', event => {
            if (!this.el('analysis-settings').contains(event.target)) this.showSettings(false);
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.showSettings(false);
        });
        // The lines are only rebuilt when the engine reports something new, so a change
        // of column numbering has to redraw the ones already on screen itself. A search
        // that has already finished never reports again, which is exactly when the
        // stale numbers would otherwise sit there.
        onColumnNumberingChange(() => {
            if (!this.data) return;
            this.last = null;
            this.render(this.data);
        });
        document.addEventListener('visibilitychange', () => {
            this.revision++;
            if (document.hidden) this.status('Suspended while tab is hidden');
            this.tick();
        });
        window.addEventListener('pagehide', () => {
            if (this.job) navigator.sendBeacon(`/api/analysis/${this.job.id}/stop`, '');
        });
        setInterval(() => this.tick(), 700);
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.paused = false;
        document.body.classList.toggle('analysis-mode', enabled);
        this.el('analysis-panel').classList.toggle('hidden', !enabled);
        this.el('eval-bar-container').classList.toggle('hidden', !enabled);
        this.el('analysis-toggle').setAttribute('aria-pressed', String(enabled));
        this.el('analysis-toggle').textContent = enabled ? 'Exit Analysis' : '⌕ Analysis';
        this.el('analysis-pause').textContent = 'Pause';
        this.showSettings(false);
        this.invalidate();
        this.onToggle();
    }

    showSettings(open) {
        this.el('analysis-settings').classList.toggle('hidden', !open);
        this.el('analysis-settings-btn').setAttribute('aria-expanded', String(open));
    }

    // The panel owns the best move; the board decides where to draw it. Reported again
    // whenever the indicator setting changes, so the toggle takes effect immediately
    // rather than at the next completed iteration.
    setBest(move) {
        const best = Number.isInteger(move) ? move : null;
        if (best === this.bestMove) return;
        this.bestMove = best;
        this.emitBest();
    }

    emitBest() {
        const show = this.enabled && this.el('analysis-best-toggle').checked;
        this.onBest(show ? this.bestMove : null);
    }

    setPosition(moves) {
        if (JSON.stringify(moves) === JSON.stringify(this.moves)) return;
        this.moves = [...moves];
        this.invalidate();
    }

    invalidate() {
        if (this.finished) {
            this.paused = false;
            this.finished = false;
            this.el('analysis-pause').textContent = 'Pause';
        }
        this.revision++;
        this.failed = false;
        this.last = null;
        this.data = null;
        this.el('analysis-lines').replaceChildren();
        this.el('analysis-depth').textContent = 'Depth —';
        this.el('analysis-stats').textContent = 'Waiting for a completed iteration';
        this.setBar(null);
        this.setBest(null);
        this.status(this.paused ? 'Paused · press Resume to analyze this position' : 'Starting engine…');
        this.tick();
    }

    status(text, thinking = false) {
        this.el('analysis-status').textContent = text;
        this.el('analysis-status').classList.toggle('thinking', thinking);
    }

    async request(url, options = {}) {
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000), ...options });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Analysis request failed.');
        return data;
    }

    async tick() {
        if (this.busy) return;
        this.busy = true;
        const revision = this.revision;
        try {
            const wanted = this.enabled && !this.paused && !document.hidden;
            if (this.job && (!wanted || this.job.revision !== revision)) {
                const old = this.job;
                this.job = null;
                await this.request(`/api/analysis/${old.id}/stop`, { method: 'POST' });
            }
            if (!wanted || this.failed || revision !== this.revision) return;
            if (!this.job) {
                const data = await this.request('/api/analysis/start', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ moves: this.moves, top: Number(this.el('analysis-top').value) }),
                });
                this.job = { id: data.job_id, revision };
            }
            if (revision !== this.revision) return;
            const data = await this.request(`/api/analysis/${this.job.id}`);
            if (revision !== this.revision) return;
            if (data.error) throw new Error(data.error);
            this.render(data);
        } catch (error) {
            if (revision === this.revision) {
                this.failed = true;
                this.paused = true;
                this.el('analysis-pause').textContent = 'Resume';
                this.status(error.message);
            }
        } finally {
            this.busy = false;
            if (revision !== this.revision) queueMicrotask(() => this.tick());
        }
    }

    scoreText(row) {
        if (row.mate_plies != null) return `${row.score < 0 ? '−' : ''}M${Math.ceil(row.mate_plies / 2)}`;
        if (row.solved && row.score) return row.score > 0 ? 'L wins' : 'D wins';
        return `${row.score > 0 ? '+' : ''}${row.score}`;
    }

    setBar(row, terminal = null) {
        const score = terminal !== null ? terminal * 30000 : row?.score || 0;
        const percent = (terminal !== null || row?.solved) && score !== 0
            ? (score > 0 ? 100 : 0) : 50 + 48 * Math.tanh(score / 400);
        const text = terminal !== null ? (terminal > 0 ? 'L wins' : terminal < 0 ? 'D wins' : 'Draw')
            : row ? this.scoreText(row) : '—';
        this.el('eval-light').style.height = `${percent}%`;
        this.el('eval-value').textContent = text;
        this.el('eval-bar').setAttribute('aria-valuenow', String(Math.round(percent)));
        this.el('eval-bar').setAttribute('aria-valuetext', text);
    }

    render(data) {
        this.data = data;
        const terminal = data.type === 'terminal';
        const fingerprint = JSON.stringify([data.depth, data.moves, terminal]);
        if (this.last !== fingerprint) {
            this.last = fingerprint;
            const expanded = new Set([...this.el('analysis-lines').querySelectorAll('details[open]')].map(el => el.dataset.move));
            this.el('analysis-lines').replaceChildren();
            this.el('analysis-depth').textContent = `Depth ${data.depth || '—'}`;
            this.setBar(data.moves[0], terminal ? data.winner : null);
            this.setBest(terminal ? null : data.moves[0]?.move);
            for (const [rank, row] of data.moves.entries()) {
                const detail = document.createElement('details');
                detail.className = 'analysis-line';
                detail.dataset.move = String(row.move);
                detail.open = expanded.has(String(row.move));
                const summary = document.createElement('summary');
                const score = document.createElement('span');
                score.className = `analysis-score${row.score < 0 ? ' dark' : ''}`;
                score.textContent = this.scoreText(row);
                score.title = row.solved ? 'Proved outcome; mate distance may not be shortest' : 'Heuristic evaluation in engine units';
                const line = row.pv.map((move, i) => {
                    const ply = this.moves.length + i;
                    return `${ply % 2 === 0 ? `${Math.floor(ply / 2) + 1}. ` : i === 0 ? `${Math.floor(ply / 2) + 1}… ` : ''}${formatColumn(move)}`;
                }).join(' ');
                const preview = document.createElement('span');
                preview.className = 'analysis-pv-summary';
                preview.textContent = line || `Column ${formatColumn(row.move)}`;
                summary.append(score, preview);
                const pv = document.createElement('div');
                pv.className = 'analysis-pv';
                pv.textContent = `#${rank + 1} · ${line || `Column ${formatColumn(row.move)}`}`;
                const play = document.createElement('button');
                play.className = 'analysis-play';
                play.textContent = `Play column ${formatColumn(row.move)}`;
                play.title = 'Play this move on the shared board (replaces future history if reviewing)';
                play.addEventListener('click', () => this.onPlay(row.move));
                detail.append(summary, pv, play);
                this.el('analysis-lines').append(detail);
            }
            if (!data.moves.length) {
                const empty = document.createElement('div');
                empty.className = 'analysis-empty';
                empty.textContent = terminal ? 'Game over · no legal continuation to analyze.' : 'Searching all legal columns. Ranked moves and best lines appear after the first completed depth.';
                this.el('analysis-lines').append(empty);
            }
        }
        const seconds = (data.elapsed_ms || 0) / 1000;
        this.el('analysis-stats').textContent = `${(data.nodes || 0).toLocaleString()} nodes · ${seconds.toFixed(1)}s · ${seconds > 0 ? Math.round(data.nodes / seconds / 1000) : 0}k nodes/s`;
        this.status(terminal ? 'Game over' : data.complete ? 'All root moves resolved'
            : !data.running ? (data.timed_out ? 'Time limit reached · Resume for a new search' : 'Search finished')
            : `Analyzing ${this.moves.length % 2 ? 'Dark' : 'Light'} orange · searching depth ${(data.depth || 0) + 2}`, data.running && !terminal && !data.complete);
        if (!data.running) {
            this.paused = true;
            this.finished = true;
            this.el('analysis-pause').textContent = 'Resume';
        }
    }
}