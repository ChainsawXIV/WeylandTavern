import { formatNotesPrompt } from './store.js';

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

    const inject = document.getElementById('wn-debug-inject');
    if (inject) {
        inject.textContent = enabled
            ? (formatNotesPrompt(notes) || '(empty)')
            : '(notes disabled — nothing injected)';
    }

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
