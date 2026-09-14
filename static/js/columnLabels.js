// Column numbering is a display choice, not a board fact.
//
// Everything under the hood -- the board, the move history, the engine protocols, the
// puzzle files, the room state -- speaks 0-based columns 0..15. Some players would
// rather read them as 1..16, so every column on its way to the screen goes through
// here, and every column the player types comes back through here.
//
// Shared log lines are the awkward case: they are plain strings written by one viewer
// and read by all of them, and two viewers can be on different numbering. A column in
// such a line is therefore written as a `{col:N}` tag -- always 0-based on the wire --
// and each viewer renders the tags with their own setting.

const COLUMNS = 16;

let oneIndexed = true;
const listeners = new Set();

export function isOneIndexed() {
    return oneIndexed;
}

/** Switch the numbering the player sees. Listeners fire only on a real change. */
export function setOneIndexed(on) {
    const next = Boolean(on);
    if (next === oneIndexed) return;
    oneIndexed = next;
    refreshColumnTexts();
    listeners.forEach(listener => listener(oneIndexed));
}

/** Called after the numbering changed, for UI that has to be redrawn rather than re-read. */
export function onColumnNumberingChange(listener) {
    listeners.add(listener);
}

/** A 0-based column as the player sees it. */
export function displayColumn(column) {
    return column + (oneIndexed ? 1 : 0);
}

export function formatColumn(column) {
    return String(displayColumn(column));
}

export function formatColumns(columns, separator = ' ') {
    return columns.map(formatColumn).join(separator);
}

/**
 * A column the player typed, back to the 0-based column the game plays.
 * @returns {number|null} null when the text is not a column in the displayed range
 */
export function parseColumn(text) {
    if (!/^\d+$/.test(text)) return null;
    const column = Number(text) - (oneIndexed ? 1 : 0);
    return column >= 0 && column < COLUMNS ? column : null;
}

/** The range as the player sees it ("0–15" or "1–16"), for hints and error messages. */
export function columnRange() {
    return oneIndexed ? '1–16' : '0–15';
}

// --- SHARED LOG TAGS ---

const TAG = /\{col:(\d+)\}/g;

/** A 0-based column, written for a log line other viewers will render themselves. */
export function columnTag(column) {
    return `{col:${column}}`;
}

export function renderColumnTags(text) {
    return String(text).replace(TAG, (_, column) => formatColumn(Number(column)));
}

// Text holding column tags keeps its unrendered form in the element's dataset, so the
// very same line can be redrawn when the setting changes instead of being frozen at
// the moment it was written.
export function setColumnText(element, text) {
    element.dataset.colText = text;
    element.textContent = renderColumnTags(text);
}

export function refreshColumnTexts(root = document) {
    root.querySelectorAll('[data-col-text]').forEach(element => {
        element.textContent = renderColumnTags(element.dataset.colText);
    });
}
