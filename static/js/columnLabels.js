// Display-side column numbering. Everything internal is 0-based; the player may see 1..16.
// Shared log lines carry columns as 0-based `{col:N}` tags that each viewer renders.

const COLUMNS = 16;

let oneIndexed = true;
const listeners = new Set();

export function setOneIndexed(on) {
    const next = Boolean(on);
    if (next === oneIndexed) return;
    oneIndexed = next;
    refreshColumnTexts();
    listeners.forEach(listener => listener(oneIndexed));
}

export function onColumnNumberingChange(listener) {
    listeners.add(listener);
}

function displayColumn(column) {
    return column + (oneIndexed ? 1 : 0);
}

export function formatColumn(column) {
    return String(displayColumn(column));
}

export function formatColumns(columns, separator = ' ') {
    return columns.map(formatColumn).join(separator);
}

// A typed column back to 0-based, or null if it is not in the displayed range.
export function parseColumn(text) {
    if (!/^\d+$/.test(text)) return null;
    const column = Number(text) - (oneIndexed ? 1 : 0);
    return column >= 0 && column < COLUMNS ? column : null;
}

export function columnRange() {
    return oneIndexed ? '1–16' : '0–15';
}

const TAG = /\{col:(\d+)\}/g;

export function columnTag(column) {
    return `{col:${column}}`;
}

export function renderColumnTags(text) {
    return String(text).replace(TAG, (_, column) => formatColumn(Number(column)));
}

// Keeps the tagged text in the dataset so it can be re-rendered when the numbering changes.
export function setColumnText(element, text) {
    element.dataset.colText = text;
    element.textContent = renderColumnTags(text);
}

export function refreshColumnTexts(root = document) {
    root.querySelectorAll('[data-col-text]').forEach(element => {
        element.textContent = renderColumnTags(element.dataset.colText);
    });
}
