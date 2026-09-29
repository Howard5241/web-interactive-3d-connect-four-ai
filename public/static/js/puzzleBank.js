// The static puzzle bank (public/puzzles.json, built by tools/build_puzzles.py).

const RECENT_LIMIT = 30;
let bankPromise = null;

function loadBank() {
    bankPromise ??= fetch('/puzzles.json').then(res => {
        if (!res.ok) throw new Error(`puzzle bank: ${res.status}`);
        return res.json();
    }).catch(err => {
        bankPromise = null;
        throw err;
    });
    return bankPromise;
}

const inCategory = (c, mate) => mate >= c.min && (c.max === null || mate <= c.max);

export async function bankSummary() {
    const bank = await loadBank();
    const counts = {};
    for (const c of bank.categories) {
        counts[c.key] = Object.entries(bank.by_mate)
            .filter(([mate]) => inCategory(c, Number(mate)))
            .reduce((n, [, list]) => n + list.length, 0);
    }
    return { categories: bank.categories, counts };
}

function recentIds(key) {
    try {
        return JSON.parse(sessionStorage.getItem(`c4-recent-${key}`)) || [];
    } catch (e) {
        return [];
    }
}

function rememberId(key, id) {
    try {
        const ids = [id, ...recentIds(key).filter(x => x !== id)].slice(0, RECENT_LIMIT);
        sessionStorage.setItem(`c4-recent-${key}`, JSON.stringify(ids));
    } catch (e) { /* non-critical */ }
}

const pick = list => list[Math.floor(Math.random() * list.length)];
const hexMoves = s => Array.from(s, ch => parseInt(ch, 16));

// A mate length first, then a puzzle, so abundant lengths do not crowd out rare ones.
// Recently served puzzles are avoided while others remain.
export async function randomPuzzle(categoryKey) {
    const bank = await loadBank();
    const category = bank.categories.find(c => c.key === categoryKey);
    if (!category) return null;
    const buckets = Object.entries(bank.by_mate)
        .filter(([mate, list]) => list.length && inCategory(category, Number(mate)));
    if (!buckets.length) return null;

    const recent = new Set(recentIds(categoryKey));
    const fresh = buckets.filter(([, list]) => list.some(p => !recent.has(p[0])));
    const [, list] = pick(fresh.length ? fresh : buckets);
    const unseen = list.filter(p => !recent.has(p[0]));
    const [id, history, solution, goal] = pick(unseen.length ? unseen : list);
    rememberId(categoryKey, id);

    const moves = hexMoves(solution);
    return {
        id,
        history: hexMoves(history),
        solution: moves,
        steps: (moves.length + 1) / 2,
        goal: goal === 'd' ? 'draw' : 'win',
    };
}
