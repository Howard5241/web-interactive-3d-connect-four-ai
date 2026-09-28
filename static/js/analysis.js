import { formatColumn, onColumnNumberingChange } from './columnLabels.js';
import { analyze, newAnalysisSnapshot } from './engine.js';

// One analysis job per tab; revisions keep a cancelled job from painting a newer board.
export class AnalysisPanel {
    // onBest gets the engine's top column, or null when there is nothing to mark.
    // onPlayLine gets a whole continuation, root move first.
    constructor(onToggle, onPlay, onBest = () => {}, onPlayLine = () => {}) {
        this.enabled = false;
        this.paused = false;
        this.moves = [];
        this.revision = 0;
        this.job = null;
        this.failed = false;
        this.finished = false;
        this.last = null;
        this.data = null;
        this.bestMove = null;
        this.onToggle = onToggle;
        this.onPlay = onPlay;
        this.onBest = onBest;
        this.onPlayLine = onPlayLine;
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
        // Display only: the engine ranks every root move regardless.
        this.el('analysis-top').addEventListener('change', () => {
            if (this.data) this.render(this.data);
        });
        this.el('analysis-best-toggle').addEventListener('change', () => this.emitBest());
        this.el('analysis-settings-btn').addEventListener('click', event => {
            event.stopPropagation();
            this.showSettings(this.el('analysis-settings').classList.contains('hidden'));
        });
        document.addEventListener('click', event => {
            if (!this.el('analysis-settings').contains(event.target)) this.showSettings(false);
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.showSettings(false);
        });
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

    // Starts, stops or restarts the engine to match the panel's state.
    tick() {
        const revision = this.revision;
        const wanted = this.enabled && !this.paused && !document.hidden;
        if (this.job && (!wanted || this.job.revision !== revision)) {
            this.job.cancel();
            this.job = null;
        }
        if (!wanted || this.failed || this.job) return;
        const job = analyze(this.moves, data => {
            if (this.job !== job || revision !== this.revision) return;
            if (data.error) {
                this.job = null;
                this.failed = true;
                this.paused = true;
                this.el('analysis-pause').textContent = 'Resume';
                this.status(data.error);
                return;
            }
            this.render(data);
        });
        job.revision = revision;
        this.job = job;
        this.render(newAnalysisSnapshot(this.moves));
    }

    scoreText(row) {
        if (row.mate_plies != null) return `${row.mate_exact === false ? '≈' : ''}${row.score < 0 ? '−' : ''}M${Math.ceil(row.mate_plies / 2)}`;
        if (row.solved && row.score) return row.score > 0 ? 'L wins' : 'D wins';
        if (row.solved && row.score === 0) return 'Draw';
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

    // The PV as spans, each column tinted for the side that plays it.
    pvNodes(row) {
        const frag = document.createDocumentFragment();
        if (!row.pv.length) {
            frag.append(`Column ${formatColumn(row.move)}`);
            return frag;
        }
        for (const [i, move] of row.pv.entries()) {
            const ply = this.moves.length + i;
            const first = ply % 2 === 0;
            if (i > 0) frag.append(' ');
            const label = first ? `${Math.floor(ply / 2) + 1}. ` : i === 0 ? `${Math.floor(ply / 2) + 1}… ` : '';
            if (label) {
                const number = document.createElement('span');
                number.className = 'analysis-pv-num';
                number.textContent = label;
                frag.append(number);
            }
            const column = document.createElement('span');
            column.className = `analysis-pv-move${first ? '' : ' p2'}`;
            column.textContent = formatColumn(move);
            frag.append(column);
        }
        return frag;
    }

    render(data) {
        this.data = data;
        const terminal = data.type === 'terminal';
        const shown = data.moves.slice(0, Math.max(1, Number(this.el('analysis-top').value) || 3));
        const fingerprint = JSON.stringify([data.depth, shown, terminal, data.phase]);
        if (this.last !== fingerprint) {
            this.last = fingerprint;
            const expanded = new Set([...this.el('analysis-lines').querySelectorAll('details[open]')].map(el => el.dataset.move));
            this.el('analysis-lines').replaceChildren();
            this.el('analysis-depth').textContent = `Depth ${data.depth || '—'}`;
            this.setBar(data.moves[0], terminal ? data.winner : null);
            this.setBest(terminal ? null : data.moves[0]?.move);
            for (const [rank, row] of shown.entries()) {
                const detail = document.createElement('details');
                detail.className = 'analysis-line';
                detail.dataset.move = String(row.move);
                detail.open = expanded.has(String(row.move));
                const summary = document.createElement('summary');
                const score = document.createElement('span');
                score.className = `analysis-score${row.score < 0 ? ' dark' : ''}`;
                score.textContent = this.scoreText(row);
                score.title = row.mate_exact && row.mate_plies != null
                    ? `Exact mate in ${row.mate_plies} plies after this root move is chosen (including that move); winner mates fastest, defender delays longest`
                    : row.solved && row.score === 0 ? 'Proved draw; no mate distance'
                    : row.solved ? 'Proved outcome; exact mate distance not yet established'
                    : 'Heuristic evaluation in engine units';
                // A fresh fragment per use: appending one empties it.
                const line = () => this.pvNodes(row);
                const preview = document.createElement('span');
                preview.className = 'analysis-pv-summary';
                preview.append(line());
                summary.append(score, preview);
                const pv = document.createElement('div');
                pv.className = 'analysis-pv';
                pv.append(`#${rank + 1} · `, line());
                const play = document.createElement('button');
                play.className = 'analysis-play';
                play.textContent = `Play column ${formatColumn(row.move)}`;
                play.title = 'Play this move on the shared board (replaces future history if reviewing)';
                play.addEventListener('click', () => this.onPlay(row.move));
                detail.append(summary, pv, play);
                if (row.pv.length > 1) {
                    const playLine = document.createElement('button');
                    playLine.className = 'analysis-play analysis-play-line';
                    playLine.textContent = `Play line (${row.pv.length} moves)`;
                    playLine.title = 'Play this whole continuation on the shared board, both sides, in one step (replaces future history if reviewing)';
                    playLine.addEventListener('click', () => this.onPlayLine(row.pv));
                    detail.append(playLine);
                }
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
        this.status(terminal ? 'Game over' : data.mate_complete ? 'All root moves resolved · exact mate distances'
            : data.phase === 'mate' ? (data.running
                ? 'Outcomes proved · finding exact mate distances · ranking provisional'
                : 'Outcomes proved · mate refinement incomplete · Resume for a new search')
            : data.complete ? 'All root moves resolved'
            : !data.running ? (data.timed_out ? 'Time limit reached · Resume for a new search' : 'Search finished')
            : `Analyzing ${this.moves.length % 2 ? 'Dark' : 'Light'} orange · next eval depth ${data.depth ? data.depth + 2 : this.moves.length % 2 ? 1 : 2}`,
            data.running && !terminal && (!data.complete || data.phase === 'mate'));
        if (!data.running) {
            this.paused = true;
            this.finished = true;
            this.el('analysis-pause').textContent = 'Resume';
        }
    }
}