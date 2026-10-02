/**
 * Pure scenario-note store. Full snapshots live on each chat message so
 * swipes, rerolls, branches, and chat switches all restore the right canon.
 *
 * Other extensions can import this module; keep mutations here so later
 * features (typed notes, caps, etc.) have one place to land.
 */

export const EXTRA_KEY = 'scenarioNotes';
export const MAX_TEXT = 160;
export const MAX_ID = 48;

/** @typedef {{ id: string, text: string }} ScenarioNote */

export function cloneNotes(notes) {
    if (!Array.isArray(notes)) return [];
    return notes
        .filter(n => n && n.id && n.text)
        .map(n => ({ id: String(n.id), text: String(n.text) }));
}

export function slugify(text) {
    const s = String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_ID);
    return s || 'note';
}

export function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\w\s]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function asExtra(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Extra that actually holds a notes snapshot, preferring the current swipe. */
export function extraOf(mes) {
    if (!mes) return null;
    const sid = mes.swipe_id;
    const swipeExtra = Number.isInteger(sid) ? asExtra(mes.swipe_info?.[sid]?.extra) : null;
    const mesExtra = asExtra(mes.extra);
    if (Array.isArray(swipeExtra?.[EXTRA_KEY])) return swipeExtra;
    if (Array.isArray(mesExtra?.[EXTRA_KEY])) return mesExtra;
    return swipeExtra || mesExtra;
}

/** @returns {ScenarioNote[] | null} null when this message has no snapshot yet */
export function readNotes(mes) {
    const extra = extraOf(mes);
    return Array.isArray(extra?.[EXTRA_KEY]) ? cloneNotes(extra[EXTRA_KEY]) : null;
}

export function writeNotes(mes, notes) {
    if (!mes || typeof mes !== 'object') return;
    if (!asExtra(mes.extra)) mes.extra = {};
    const list = cloneNotes(notes);
    mes.extra[EXTRA_KEY] = list;

    const sid = mes.swipe_id;
    if (!Number.isInteger(sid)) return;
    if (!Array.isArray(mes.swipe_info)) mes.swipe_info = [];
    if (!mes.swipe_info[sid] || typeof mes.swipe_info[sid] !== 'object') mes.swipe_info[sid] = {};
    if (!asExtra(mes.swipe_info[sid].extra)) mes.swipe_info[sid].extra = {};
    mes.swipe_info[sid].extra[EXTRA_KEY] = cloneNotes(list);
}

export function latestNotes(chat, beforeIndex = chat?.length) {
    if (!Array.isArray(chat)) return [];
    const end = Math.min(beforeIndex ?? chat.length, chat.length);
    for (let i = end - 1; i >= 0; i--) {
        const notes = readNotes(chat[i]);
        if (notes) return notes;
    }
    return [];
}

/**
 * @param {ScenarioNote[]} notes
 * @param {{ action?: string, id?: string, text?: string }} op
 * @returns {{ notes: ScenarioNote[], ok: boolean, message: string }}
 */
export function applyNoteOp(notes, { action, id, text } = {}) {
    const list = cloneNotes(notes);
    const act = String(action || '').toLowerCase().trim();
    const rawId = String(id || '').trim();
    const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
    const noteId = slugify(rawId || trimmed);

    if (!['add', 'update', 'remove'].includes(act)) {
        return { notes: list, ok: false, message: 'action must be add, update, or remove.' };
    }
    if (!noteId) return { notes: list, ok: false, message: 'Missing id.' };

    const idx = list.findIndex(n => n.id === noteId);

    if (act === 'remove') {
        if (idx < 0) return { notes: list, ok: false, message: `No note "${noteId}".` };
        const removed = list.splice(idx, 1)[0];
        return { notes: list, ok: true, message: `Removed: ${removed.id} — ${removed.text}` };
    }

    if (!trimmed) return { notes: list, ok: false, message: 'Missing text.' };
    if (trimmed.length > MAX_TEXT) {
        return { notes: list, ok: false, message: `Text too long (max ${MAX_TEXT} chars).` };
    }

    const norm = normalizeText(trimmed);
    const dup = list.find((n, i) => i !== idx && (n.id === noteId || normalizeText(n.text) === norm));
    if (act === 'add' && dup) {
        return {
            notes: list,
            ok: false,
            message: `Already recorded as "${dup.id}": ${dup.text}. Update or remove that note instead.`,
        };
    }

    if (idx >= 0) {
        if (normalizeText(list[idx].text) === norm) {
            return { notes: list, ok: false, message: `Already recorded as "${noteId}": ${list[idx].text}` };
        }
        list[idx] = { id: noteId, text: trimmed };
        return { notes: list, ok: true, message: `Updated: ${noteId} — ${trimmed}` };
    }

    list.push({ id: noteId, text: trimmed });
    return { notes: list, ok: true, message: `Added: ${noteId} — ${trimmed}` };
}

const LINE_TAG = /^[ \t]*\[WN\s+(add|update|remove)\s+([^\]]+?)\][ \t]*(.*?)[ \t]*$/gim;
const INLINE_TAG = /\[WN\s+(add|update|remove)\s+([^\]]+?)\][ \t]*([^\n]*)/gi;

/**
 * Pull [WN] note ops out of model text and return the reply with those tags removed.
 * @returns {{ ops: {action: string, id: string, text: string}[], text: string }}
 */
export function parseNoteTags(text) {
    const src = String(text || '');
    const ops = [];
    LINE_TAG.lastIndex = 0;
    let next = src.replace(LINE_TAG, (_, action, id, body) => {
        ops.push({ action, id: String(id).trim(), text: String(body || '').trim() });
        return '';
    });
    INLINE_TAG.lastIndex = 0;
    next = next.replace(INLINE_TAG, (_, action, id, body) => {
        ops.push({ action, id: String(id).trim(), text: String(body || '').trim() });
        return '';
    });
    return { ops, text: next.replace(/\n{3,}/g, '\n\n').trim() };
}

const GUIDE = [
    'Before the expression/clothing footer, you may record notes about the state of the scenario. They will be included in context for future messages until you say otherwise, as a supplement to chat history and baseline lore.',
    'Only make note of information where all of the following are true:',
    '- The state will be relevant often and should always be in context.',
    '- The state deviates from the baseline in lorebooks and other context.',
    '- The state will stay relevant over the long term, even if it changes.',
    'Note only facts about characters or the world, without any additional context, reasoning, or events, and keep each description to a few words.',
    '`[WN update id] revised state` updates an existing note. Prefer to do this if a relevant note already exists.',
    '`[WN add id] state` adds a new note.',
    '`[WN remove id]` removes a note. Do this if a note is no longer relevant.',
    'If the state has not changed, make no further note of it.',
].join('\n');

export function formatNotesPrompt(notes, { guide = true } = {}) {
    const list = cloneNotes(notes);
    const lines = [];
    if (list.length) {
        lines.push('CANON STATE — overrides cards, lore, and earlier chat on conflict. Id before the colon:');
        for (const n of list) lines.push(`- ${n.id}: ${n.text}`);
    }
    if (guide) lines.push(GUIDE);
    return lines.join('\n');
}

/** Listeners: (notes, reason) => void. Future features can subscribe without editing the glue. */
export const hooks = {
    onChange: [],
};

export function emitChange(notes, reason) {
    for (const fn of hooks.onChange) {
        try { fn(cloneNotes(notes), reason); } catch (err) { console.warn('[Weyland-Notes]', err); }
    }
}
