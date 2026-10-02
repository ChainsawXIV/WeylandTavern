/**
 * Weyland Notes — lasting canon updates recorded from the reply.
 *
 * Snapshots live on chat messages and survive swipes, rerolls, branches,
 * and chat switches. store.js is the extension point for later note types.
 */

import {
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    saveSettingsDebounced,
} from '../../../script.js';
import { getContext } from '../../st-context.js';
import {
    applyNoteOp,
    cloneNotes,
    emitChange,
    formatNotesPrompt,
    latestNotes,
    parseNoteTags,
    writeNotes,
} from './store.js';
import { initDebugPanel, logDebug, refreshDebug, setDebugPanelOpen } from './debugPanel.js';

export {
    applyNoteOp,
    cloneNotes,
    EXTRA_KEY,
    formatNotesPrompt,
    hooks,
    latestNotes,
    parseNoteTags,
    readNotes,
    writeNotes,
} from './store.js';

const MODULE = 'Weyland-Notes';
const PROMPT_KEY = 'Weyland-Notes';
const SKIP_GEN = new Set(['quiet', 'impersonate']);

const {
    extensionSettings,
    renderExtensionTemplateAsync,
} = getContext();

const defaults = { enabled: true, debugPanel: false };

/** @type {{ enabled: boolean, debugPanel: boolean }} */
let settings = defaults;

/** In-flight generation snapshot. Cleared when generation ends. */
/** @type {{ notes: import('./store.js').ScenarioNote[] } | null} */
let session = null;

function getSettings() {
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(defaults);
    const s = extensionSettings[MODULE];
    for (const k of Object.keys(defaults)) if (s[k] === undefined) s[k] = defaults[k];
    settings = s;
    return s;
}

function ctx() {
    return getContext();
}

export function getActiveNotes() {
    return session ? cloneNotes(session.notes) : latestNotes(ctx().chat);
}

function injectPrompt(reason = '') {
    const { setExtensionPrompt } = ctx();
    const enabled = getSettings().enabled;
    const value = enabled ? formatNotesPrompt(getActiveNotes()) : '';
    // User role, not system: this preset ends on Claude via a custom proxy, which drops
    // a trailing system turn. Depth 0 keeps the guide as the last message before the reply.
    setExtensionPrompt(PROMPT_KEY, value, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.USER);
    renderNotesList();
    refreshDebug(reason);
}

function stamp(mes, notes = getActiveNotes()) {
    if (!mes) return;
    writeNotes(mes, notes);
}

function commitTo(index, notes = getActiveNotes()) {
    const chat = ctx().chat;
    if (!Array.isArray(chat) || index == null || index < 0 || index >= chat.length) return;
    stamp(chat[index], notes);
}

function beginSession(type) {
    if (session) return;
    const chat = ctx().chat;
    const excludeCurrent = type === 'swipe' || type === 'regenerate';
    session = { notes: latestNotes(chat, excludeCurrent ? chat.length - 1 : chat.length) };
}

function endSession() {
    if (session) {
        const chat = ctx().chat;
        if (chat?.length) stamp(chat[chat.length - 1], session.notes);
    }
    session = null;
    injectPrompt();
}

function applyToMessage(mes, text) {
    if (!mes || text == null) return;
    mes.mes = text;
    const sid = mes.swipe_id;
    if (Array.isArray(mes.swipes) && Number.isInteger(sid) && mes.swipes[sid] != null) {
        mes.swipes[sid] = text;
    }
}

/** Harvest in-message [WN] tags before other extensions read the reply. */
function harvestMessage(id) {
    if (!getSettings().enabled) return;
    const chat = ctx().chat;
    const mes = chat?.[id];
    if (!mes || mes.is_user || mes.is_system) return;

    const { ops, text } = parseNoteTags(mes.mes || '');
    if (!ops.length) return;

    applyToMessage(mes, text);
    let notes = session ? cloneNotes(session.notes) : latestNotes(chat, id);
    for (const op of ops) {
        const result = applyNoteOp(notes, op);
        logDebug(result.ok ? (op.action || 'update') : 'skip', result.message);
        if (result.ok) notes = result.notes;
    }
    if (session) session.notes = notes;
    stamp(mes, notes);
    injectPrompt();
    emitChange(notes, 'tag');
    if (!session) ctx().saveChat?.();
}

function runOp(op, { persist = true } = {}) {
    const current = getActiveNotes();
    const result = applyNoteOp(current, op);
    if (result.ok) {
        if (session) session.notes = result.notes;
        else {
            const chat = ctx().chat;
            if (persist && chat?.length) stamp(chat[chat.length - 1], result.notes);
        }
        injectPrompt();
        if (persist && !session) ctx().saveChat?.();
        emitChange(result.notes, op.action);
    }
    logDebug(result.ok ? (op.action || 'update') : 'skip', result.message);
    if (!result.ok) refreshDebug();
    return result;
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderNotesList() {
    const root = document.getElementById('weyland-notes-list');
    if (!root) return;
    const notes = getActiveNotes();
    if (!notes.length) {
        root.innerHTML = '<div class="weyland-notes-empty">No notes yet.</div>';
        return;
    }
    root.innerHTML = notes.map(n => `
        <div class="weyland-notes-row" data-id="${esc(n.id)}">
            <div class="weyland-notes-row-text">
                <span class="weyland-notes-row-id">${esc(n.id)}</span>
                ${esc(n.text)}
            </div>
            <button type="button" class="menu_button weyland-notes-remove" title="Remove Note" data-id="${esc(n.id)}">×</button>
        </div>
    `).join('');
    root.querySelectorAll('.weyland-notes-remove').forEach(btn => {
        btn.addEventListener('click', () => runOp({ action: 'remove', id: btn.getAttribute('data-id') }));
    });
}

async function addSettings() {
    const html = await renderExtensionTemplateAsync(MODULE, 'settings');
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (target) $(target).append(html);

    const s = getSettings();
    $('#weyland-notes-enabled').prop('checked', s.enabled).on('input', function () {
        s.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        injectPrompt();
    });
    $('#weyland-notes-debug-toggle').prop('checked', s.debugPanel).on('input', function () {
        s.debugPanel = !!$(this).prop('checked');
        saveSettingsDebounced();
        setDebugPanelOpen(s.debugPanel);
        refreshDebug();
    });
    renderNotesList();
}

function bindEvents() {
    eventSource.on(event_types.GENERATION_STARTED, (type, _opts, dryRun) => {
        if (dryRun || SKIP_GEN.has(type) || !getSettings().enabled) return;
        beginSession(type);
        injectPrompt(type === 'swipe' || type === 'regenerate' ? 'reroll' : '');
    });

    eventSource.on(event_types.GENERATION_ENDED, endSession);
    eventSource.on(event_types.GENERATION_STOPPED, endSession);

    eventSource.on(event_types.MESSAGE_SENT, (id) => {
        commitTo(id, getActiveNotes());
        injectPrompt();
    });

    // Strip tags before Formatter / expressions read the message.
    eventSource.makeFirst(event_types.MESSAGE_RECEIVED, harvestMessage);
    eventSource.on(event_types.MESSAGE_RECEIVED, (id) => {
        commitTo(id, getActiveNotes());
        injectPrompt();
    });
    eventSource.makeFirst(event_types.MESSAGE_UPDATED, harvestMessage);
    eventSource.on(event_types.MESSAGE_EDITED, harvestMessage);

    // Don't drop an in-flight snapshot: regenerate deletes the last message, and
    // a new swipe emits MESSAGE_SWIPED, before Generate() actually starts.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        session = null;
        injectPrompt('chat');
    });
    eventSource.on(event_types.MESSAGE_SWIPED, () => { if (!session) injectPrompt('swipe'); });
    eventSource.on(event_types.MESSAGE_DELETED, () => { if (!session) injectPrompt('delete'); });
}

jQuery(async () => {
    getSettings();
    initDebugPanel({
        getNotes: getActiveNotes,
        notesEnabled: () => getSettings().enabled,
        panelEnabled: () => getSettings().debugPanel,
        inSession: () => !!session,
    });
    const debugHtml = await renderExtensionTemplateAsync(MODULE, 'debug');
    document.body.insertAdjacentHTML('beforeend', debugHtml);
    ctx().registerMacro?.('scenarioNotes', () => formatNotesPrompt(getActiveNotes(), { guide: false }));
    await addSettings();
    bindEvents();
    setDebugPanelOpen(getSettings().debugPanel);
    injectPrompt();
    console.log(`[${MODULE}] ready`);
});
