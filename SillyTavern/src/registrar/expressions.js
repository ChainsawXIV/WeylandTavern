// Registrar characters imported through the WeyPhone app get their expression sprites saved
// locally, the same way a Weyland Character Downloader character has them on disk. Before this,
// registrar-expressions streamed every sprite live from the Registrar by FIRST NAME, which is
// ambiguous (several public characters share a first name) and depends on the site being up.
//
// Layout: characters/Registrar-<id>/<clothed|underwear|nude>/<label>.<ext>
// - Keyed by Registrar id, never by name: names collide with each other and with official cast
//   folders, and a creator can rename a character.
// - Two levels deep on purpose: /api/sprites/get only resolves "<folder>/<subfolder>".
// - Each character folder holds registrar-expressions.json (image URL per file). A sync re-downloads
//   only images whose URL changed; the Registrar gives a replaced image a new URL, so "Update this
//   import" picks up fresh expressions without re-fetching unchanged ones.
import fs from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';
import writeFileAtomic from 'write-file-atomic';
import { parseList } from './catalog.js';
import { readLibrary } from './library.js';

export const OUTFITS = { clothed: 'expressionsClothed', underwear: 'expressionsUnderwear', nude: 'expressionsNude' };
export const STATE_FILE = 'registrar-expressions.json';
const FOLDER_PATTERN = /^Registrar-(\d+)$/;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const CONCURRENCY = 4;
// Cloudflare Images negotiates the format: AVIF is ~10x smaller than the PNG it serves by default
// (measured 2026-09-26: 1,067,407 -> 100,923 bytes for one sprite), which is what makes downloading
// whole collections reasonable on phones.
const ACCEPT = 'image/avif,image/webp;q=0.9,image/png;q=0.8,image/*;q=0.5';
const EXTENSIONS = { 'image/avif': 'avif', 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };
const ALLOWED_HOSTS = new Set(['imagedelivery.net', 'registrar.weybooru.com']);

export const folderName = id => `Registrar-${id}`;

function safeUrl(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname) ? url.href : '';
    } catch { return ''; }
}

/**
 * The files a character should have, as { "clothed/anger": url, "clothed/anger-2": url, ... }.
 * Labels come from a remote site, so anything that isn't a plain word is dropped (it becomes part
 * of a file path). Repeated labels become ST-style alternates (anger, anger-2), not overwrites.
 */
export function desiredFiles(record) {
    const files = {};
    for (const [outfit, field] of Object.entries(OUTFITS)) {
        const counts = new Map();
        for (const entry of parseList(record?.[field])) {
            const label = String(entry?.label ?? '').trim().toLowerCase();
            const url = safeUrl(entry?.path);
            if (!/^[a-z][a-z0-9_]{0,31}$/.test(label) || !url) continue;
            const n = (counts.get(label) ?? 0) + 1;
            counts.set(label, n);
            files[`${outfit}/${n === 1 ? label : `${label}-${n}`}`] = url;
        }
    }
    return files;
}

async function readState(dir) {
    try {
        const state = JSON.parse(await fs.readFile(path.join(dir, STATE_FILE), 'utf8'));
        return state && typeof state.files === 'object' ? state : null;
    } catch { return null; }
}

async function findFile(dir, base) {
    const folder = path.join(dir, path.dirname(base));
    const stem = path.basename(base);
    try {
        return (await fs.readdir(folder)).filter(file => path.parse(file).name === stem).map(file => path.join(folder, file));
    } catch { return []; }
}

async function downloadImage(url, fetchImpl) {
    const response = await fetchImpl(url, { headers: { Accept: ACCEPT }, redirect: 'error', signal: AbortSignal.timeout(60_000), size: MAX_IMAGE_BYTES });
    if (!response.ok) throw new Error(`the Registrar image host answered ${response.status}`);
    const type = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = EXTENSIONS[type];
    if (!ext) throw new Error(`unexpected file type "${type || 'unknown'}"`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('empty file');
    return { buffer, ext };
}

async function runPool(tasks, limit) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (next < tasks.length) await tasks[next++]();
    }));
}

/**
 * Makes characters/Registrar-* match the library: downloads new/changed images, deletes images a
 * creator removed, and deletes folders of characters no longer imported. Unloaded (inactive)
 * characters keep their files. Only folders carrying our state file are ever deleted.
 * @param {{characters: string, worlds: string}} directories
 * @param {{fetchImpl?: typeof fetch, onProgress?: (p: {total: number, done: number, failed: number}) => void}} [options]
 */
export async function syncRegistrarExpressions(directories, { fetchImpl = fetch, onProgress = () => {} } = {}) {
    const book = await readLibrary(directories);
    const characters = book.registrar.records.filter(record => record.kind === 'character' && Number.isSafeInteger(Number(record.id)));
    const wanted = new Set(characters.map(record => folderName(record.id)));
    const progress = { total: 0, done: 0, failed: 0, errors: [] };
    const tasks = [];
    const finishers = [];

    for (const record of characters) {
        const dir = path.join(directories.characters, folderName(record.id));
        const desired = desiredFiles(record);
        const previous = (await readState(dir))?.files ?? {};
        const state = { id: record.id, name: record.name, files: {} };
        for (const [base, url] of Object.entries(desired)) {
            if (previous[base] === url && (await findFile(dir, base)).length) { state.files[base] = url; continue; }
            progress.total++;
            tasks.push(async () => {
                try {
                    const { buffer, ext } = await downloadImage(url, fetchImpl);
                    await fs.mkdir(path.join(dir, path.dirname(base)), { recursive: true });
                    // A format change (png -> avif) must not leave two files for one label.
                    for (const old of await findFile(dir, base)) if (path.extname(old) !== `.${ext}`) await fs.rm(old, { force: true });
                    await writeFileAtomic(path.join(dir, `${base}.${ext}`), buffer);
                    state.files[base] = url;
                } catch (error) {
                    progress.failed++;
                    if (progress.errors.length < 5) progress.errors.push(`${record.name} ${base}: ${error.message}`);
                    // Keep whatever copy already exists; the next sync retries this one.
                    if (previous[base] && (await findFile(dir, base)).length) state.files[base] = previous[base];
                } finally { progress.done++; onProgress({ ...progress }); }
            });
        }
        finishers.push(async () => {
            for (const base of Object.keys(previous)) {
                if (!(base in desired)) for (const file of await findFile(dir, base)) await fs.rm(file, { force: true });
            }
            if (!Object.keys(desired).length && !Object.keys(previous).length) return;
            await fs.mkdir(dir, { recursive: true });
            await writeFileAtomic(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2));
        });
    }

    onProgress({ ...progress });
    await runPool(tasks, CONCURRENCY);
    for (const finish of finishers) await finish();

    let entries = [];
    try { entries = await fs.readdir(directories.characters, { withFileTypes: true }); } catch { /* no characters folder yet */ }
    for (const entry of entries) {
        if (!entry.isDirectory() || !FOLDER_PATTERN.test(entry.name) || wanted.has(entry.name)) continue;
        const dir = path.join(directories.characters, entry.name);
        if (await readState(dir)) await fs.rm(dir, { recursive: true, force: true });
    }
    return progress;
}

// One background job per user. Imports return as soon as the lore is saved (a collection's sprites
// can take minutes, far past the app's request timeout); the app polls status() for progress.
const jobs = new Map();

export function expressionSyncStatus(directories) {
    const job = jobs.get(directories.characters);
    if (!job) return { running: false, total: 0, done: 0, failed: 0, errors: [] };
    return { running: job.running, total: job.progress.total, done: job.progress.done, failed: job.progress.failed, errors: job.progress.errors, finishedAt: job.finishedAt ?? null };
}

export function startExpressionSync(directories, sync = syncRegistrarExpressions) {
    if (!directories?.characters || !directories?.worlds) return;
    const key = directories.characters;
    const job = jobs.get(key);
    // A change during a running sync (Update all, a second import) is picked up by one more pass
    // once the current one ends, instead of two passes writing the same folders at once.
    if (job?.running) { job.again = true; return; }
    const next = { running: true, again: false, progress: { total: 0, done: 0, failed: 0, errors: [] } };
    jobs.set(key, next);
    void (async () => {
        do {
            next.again = false;
            try { next.progress = await sync(directories, { onProgress: progress => { next.progress = progress; } }); }
            catch (error) {
                console.warn('[Registrar] Expression download failed:', error?.message);
                next.progress = { ...next.progress, failed: next.progress.failed + 1, errors: [...next.progress.errors, error?.message ?? String(error)].slice(-5) };
            }
        } while (next.again);
        next.running = false;
        next.finishedAt = new Date().toISOString();
    })();
}
