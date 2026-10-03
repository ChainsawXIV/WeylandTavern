import { getTokenCountAsync } from '../../tokenizers.js';
import { notesPromptParts } from './store.js';

const MAX_LOG = 80;

/** @type {{ at: string, kind: string, text: string }[]} */
const log = [];
let lastKey = '';

/** @type {{ getNotes: () => {id: string, text: string}[], notesEnabled: () => boolean, panelEnabled: () => boolean, inSession: () => boolean }} */
let api = {
    getNotes: () => [],
    notesEnabled: () => true,
    panelEnabled: () => false,
    inSession: () => false,
};

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stampTime() {
    return new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function notesKey(notes) {
    return JSON.stringify(notes);
}

function pushLog(kind, text) {
    log.unshift({ at: stampTime(), kind, text });
    if (log.length > MAX_LOG) log.length = MAX_LOG;
}

function panel() {
    return document.getElementById('weyland-notes-debug');
}

/** Injected prompt split into instructions and the notes block. Empty when notes are disabled. */
function promptParts(notes, enabled) {
    if (!enabled) return { full: '', instructions: '', notes: '' };
    return notesPromptParts(notes);
}

function formatTokenCount(n) {
    return n === 1 ? '1 token' : `${n} tokens`;
}

function formatTokenBreakdown(total, instructions, notes, approx) {
    const head = `${approx ? '~' : ''}${formatTokenCount(total)}`;
    const instrLabel = instructions === 1 ? 'instruction' : 'instructions';
    const notesLabel = notes === 1 ? 'note' : 'notes';
    return `${head} (${instructions} ${instrLabel}, ${notes} ${notesLabel})`;
}

/** Scale independent piece counts so the parenthetical adds up to the injected total. */
function reconcileCounts(total, instructionCount, noteCount) {
    if (total <= 0) return { instructions: 0, notes: 0 };
    if (noteCount <= 0) return { instructions: total, notes: 0 };
    if (instructionCount <= 0) return { instructions: 0, notes: total };
    const sum = instructionCount + noteCount;
    const instructions = Math.round((total * instructionCount) / sum);
    return { instructions, notes: total - instructions };
}

function estimateTokens(text) {
    return text ? Math.ceil(text.length / 4) : 0;
}

let tokenSeq = 0;
/** Last prompt string whose count is currently shown, so refreshes don't flicker. */
let shownPrompt = null;

async function updateTokenCount(parts) {
    const el = document.getElementById('wn-debug-tokens');
    if (!el) return;
    const seq = ++tokenSeq;
    const text = parts.full;
    if (!text) {
        shownPrompt = '';
        el.textContent = '0 tokens';
        return;
    }
    if (shownPrompt !== text) el.textContent = '…';
    try {
        const [total, instructionCount, noteCount] = await Promise.all([
            getTokenCountAsync(text),
            parts.instructions ? getTokenCountAsync(parts.instructions) : 0,
            parts.notes ? getTokenCountAsync(parts.notes) : 0,
        ]);
        if (seq !== tokenSeq) return;
        shownPrompt = text;
        const split = reconcileCounts(total, instructionCount, noteCount);
        el.textContent = formatTokenBreakdown(total, split.instructions, split.notes, false);
    } catch {
        if (seq !== tokenSeq) return;
        shownPrompt = text;
        const total = estimateTokens(text);
        const split = reconcileCounts(total, estimateTokens(parts.instructions), estimateTokens(parts.notes));
        el.textContent = formatTokenBreakdown(total, split.instructions, split.notes, true);
    }
}

function bindFolds() {
    const el = panel();
    if (!el || el.dataset.foldsBound) return;
    el.dataset.foldsBound = '1';
    el.addEventListener('click', (event) => {
        const btn = event.target.closest('.wn-debug-fold');
        if (!btn || !el.contains(btn)) return;
        const section = btn.closest('.wn-debug-fold-section');
        if (!section) return;
        const collapsed = section.classList.toggle('is-collapsed');
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
}

function setOpen(open) {
    document.body.classList.toggle('wn-debug-open', !!open);
}

function render() {
    const el = panel();
    if (!el || !document.body.classList.contains('wn-debug-open')) return;
    bindFolds();

    const notes = api.getNotes();
    const enabled = api.notesEnabled();
    const n = notes.length;

    const status = document.getElementById('wn-debug-status');
    if (status) {
        status.textContent = !enabled
            ? 'disabled'
            : api.inSession()
                ? 'generation'
                : 'committed';
    }

    const count = document.getElementById('wn-debug-count');
    if (count) count.textContent = n === 1 ? '1 note' : `${n} notes`;

    const list = document.getElementById('wn-debug-notes');
    if (list) {
        list.innerHTML = n
            ? notes.map(note => `
                <div class="wn-debug-note">
                    <span class="wn-debug-note-id">${esc(note.id)}</span>
                    <span class="wn-debug-note-text">${esc(note.text)}</span>
                </div>`).join('')
            : '<div class="weyland-notes-empty">No notes on this branch.</div>';
    }

    const parts = promptParts(notes, enabled);
    const inject = document.getElementById('wn-debug-inject');
    if (inject) {
        inject.textContent = !enabled
            ? '(notes disabled — nothing injected)'
            : (parts.full || '(empty)');
    }
    void updateTokenCount(parts);

    const logEl = document.getElementById('wn-debug-log');
    if (logEl) {
        logEl.innerHTML = log.length
            ? log.map(e => `
                <div class="wn-debug-log-row" data-kind="${esc(e.kind)}">
                    <span class="wn-debug-log-at">${esc(e.at)}</span>
                    <span class="wn-debug-log-kind">${esc(e.kind)}</span>
                    <span class="wn-debug-log-text">${esc(e.text)}</span>
                </div>`).join('')
            : '<div class="weyland-notes-empty">No updates yet.</div>';
    }
}

export function initDebugPanel(nextApi) {
    Object.assign(api, nextApi);
}

export function setDebugPanelOpen(open) {
    setOpen(open);
    if (open) render();
}

export function logDebug(kind, text) {
    pushLog(kind, text);
    lastKey = notesKey(api.getNotes());
    render();
}

/** Refresh the panel. Logs a restore when the snapshot changed without an explicit op. */
export function refreshDebug(reason = '') {
    const notes = api.getNotes();
    const key = notesKey(notes);
    if (reason && key !== lastKey) {
        const n = notes.length;
        pushLog(reason, n ? `Restored ${n} note${n === 1 ? '' : 's'}` : 'No notes on this branch');
    }
    lastKey = key;
    setOpen(api.panelEnabled());
    render();
}
