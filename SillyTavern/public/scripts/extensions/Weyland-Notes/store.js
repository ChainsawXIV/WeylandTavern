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

export function formatNotesPrompt(notes, { guide = true } = {}) {
    const list = cloneNotes(notes);
    const lines = [];
    if (list.length) {
        lines.push('CANON STATE UPDATES — these override character cards, lorebooks, and earlier chat when they conflict:');
        for (const n of list) lines.push(`- ${n.text}`);
        if (guide) lines.push('Record new lasting changes with scenario_note. Do not repeat the updates above.');
    } else if (guide) {
        lines.push('Use scenario_note for lasting canon changes that should override lorebooks (appearance, relationships, destroyed places, deaths, moves). Skip fleeting events. Never duplicate a note; update or remove instead. A few words, one sentence max.');
    }
    return lines.join('\n');
}

export function summarizeNotes(notes) {
    const list = cloneNotes(notes);
    return list.length ? list.map(n => `${n.id}: ${n.text}`).join('\n') : '(none)';
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
