// Console/automation API exposed as window.latex. Pure helpers are exported for unit tests;
// createAgentApi only reads app state through a bridge, so it costs nothing until called.
import { documentPath, validDocumentCode } from './document-url.js';

export const MAX_SOURCE = 100000;
const invalidCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u;

export function validateSource(source) {
  if (typeof source !== 'string') throw new TypeError('Source must be a string.');
  if (source.length > MAX_SOURCE) throw new RangeError(`Source must be at most ${MAX_SOURCE.toLocaleString('en-US')} characters.`);
  if (invalidCharacters.test(source)) throw new Error('Source must be plain UTF-8 text without control characters.');
  return source;
}

const lineList = source => source.split('\n');
function lineNumber(value, name, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be an integer from 1 to ${max}.`);
  return value;
}

export function readLines(source, { from = 1, to, numbered = false } = {}) {
  const lines = lineList(source);
  const first = lineNumber(from, 'from', lines.length);
  const last = lineNumber(to ?? lines.length, 'to', lines.length);
  if (last < first) throw new RangeError('to must be greater than or equal to from.');
  const selected = lines.slice(first - 1, last);
  if (!numbered) return selected.join('\n');
  const width = String(last).length;
  return selected.map((line, index) => `${String(first + index).padStart(width)}| ${line}`).join('\n');
}

export function replaceLines(source, from, to, text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string.');
  const lines = lineList(source);
  lineNumber(from, 'from', lines.length);
  lineNumber(to, 'to', lines.length);
  if (to < from) throw new RangeError('to must be greater than or equal to from.');
  return [...lines.slice(0, from - 1), ...lineList(text), ...lines.slice(to)].join('\n');
}

export function insertLines(source, at, text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string.');
  const lines = lineList(source);
  lineNumber(at, 'at', lines.length + 1);
  return [...lines.slice(0, at - 1), ...lineList(text), ...lines.slice(at - 1)].join('\n');
}

function pattern(query, { regex = false, caseSensitive = true, all = true } = {}) {
  if (query instanceof RegExp) {
    const flags = new Set(query.flags.replace('y', ''));
    if (all) flags.add('g'); else flags.delete('g');
    return new RegExp(query.source, [...flags].join(''));
  }
  if (typeof query !== 'string' || !query) throw new TypeError('find must be a non-empty string or RegExp.');
  const flags = `${all ? 'g' : ''}${caseSensitive ? '' : 'i'}u`;
  return new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
}

export function replaceText(source, find, replacement, { all = false, regex = false, caseSensitive = true } = {}) {
  if (typeof replacement !== 'string') throw new TypeError('replacement must be a string.');
  const expression = pattern(find, { regex, caseSensitive, all });
  const literal = !regex && !(find instanceof RegExp);
  let count = 0;
  const next = source.replace(expression, (...match) => {
    count++;
    if (literal) return replacement;
    const groups = typeof match.at(-1) === 'object' ? match.at(-1) : undefined;
    return replacement.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (token, key) => {
      if (key === '$') return '$';
      if (key === '&') return match[0];
      if (key[0] === '<') return groups?.[key.slice(1, -1)] ?? '';
      return match[Number(key)] ?? '';
    });
  });
  return { source: next, count };
}

export function findText(source, query, { regex = false, caseSensitive = true, limit = 200 } = {}) {
  const expression = pattern(query, { regex, caseSensitive, all: true });
  const starts = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) starts.push(index + 1);
  const matches = [];
  for (const match of source.matchAll(expression)) {
    if (matches.length >= limit) break;
    if (!match[0]) { expression.lastIndex++; continue; }
    let low = 0, high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= match.index) low = middle; else high = middle - 1;
    }
    const lineEnd = source.indexOf('\n', starts[low]);
    matches.push({
      line: low + 1, column: match.index - starts[low] + 1, offset: match.index, match: match[0],
      text: source.slice(starts[low], lineEnd === -1 ? undefined : lineEnd),
    });
  }
  return matches;
}

export function parseLog(log = '') {
  const lines = String(log).split(/\r?\n/);
  const errors = [], warnings = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('! ')) {
      const error = { message: line.slice(2).trim(), line: null, context: '' };
      for (let next = index + 1; next < Math.min(lines.length, index + 16); next++) {
        const location = /^l\.(\d+)\s?(.*)$/.exec(lines[next]);
        if (location) { error.line = Number(location[1]); error.context = location[2].trim(); break; }
        if (lines[next].startsWith('! ')) break;
      }
      errors.push(error);
      continue;
    }
    const warning = /^(?:(LaTeX)|(?:Package|Class) (\S+)) Warning: (.*)$/.exec(line);
    if (warning) {
      let message = warning[3];
      for (let next = index + 1; next < lines.length && /^\(\S+\)\s|^ {2,}\S/.test(lines[next]); next++) {
        message += ` ${lines[next].replace(/^\(\S+\)\s+/, '').trim()}`;
        index = next;
      }
      const input = /on input line (\d+)/.exec(message);
      warnings.push({ type: 'warning', source: warning[2] || 'LaTeX', message: message.trim(), line: input ? Number(input[1]) : null });
      continue;
    }
    if (/^(Overfull|Underfull) \\[hv]box /.test(line)) {
      const at = /at lines? (\d+)/.exec(line);
      warnings.push({ type: 'box', source: 'TeX', message: line.trim(), line: at ? Number(at[1]) : null });
      continue;
    }
    if (line.startsWith('Missing character:')) warnings.push({ type: 'font', source: 'TeX', message: line.trim(), line: null });
  }
  return { errors, warnings };
}

export function toBase64(bytes) {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  return btoa(binary);
}

export const API_METHODS = [
  ['help(name?)', 'List methods, or show one method in detail. Returns text.', 'latex.help("replace")'],
  ['ready()', 'Resolves with status() once device drafts and the sign-in/account list check have loaded.', 'await latex.ready()'],
  ['status()', 'View, current document, save/compile state, sign-in user, preview freshness.', 'latex.status()'],
  ['list()', 'All documents: id, cloudId, 8-character code, permalink url, title, local/cloud availability, updatedAt, dirty, current.', 'latex.list()'],
  ['current()', 'Current document metadata (no source).', 'latex.current()'],
  ['open(ref, { account?, replaceDraft? })', 'Open/switch by id, cloudId, 8-character permalink code or /documents/... URL, list key or exact title. account: open the account copy; replaceDraft: allow replacing an unsynced device draft.', 'await latex.open("Alpha paper")'],
  ['create({ title?, source? })', 'Create a new device document and open it.', 'await latex.create({ title: "Notes" })'],
  ['rename(title)', 'Rename the current document.', 'await latex.rename("Final draft")'],
  ['remove(ref?, { confirm: true })', 'Delete a document from this device and, if linked, your account. confirm: true is required.', 'await latex.remove(undefined, { confirm: true })'],
  ['read({ from?, to?, numbered? })', 'Read the full source or a 1-based inclusive line range.', 'latex.read({ from: 1, to: 20, numbered: true })'],
  ['find(query, { regex?, caseSensitive? })', 'Find matches with line/column/offset and the line text.', 'latex.find("\\\\section")'],
  ['setSource(text)', 'Replace the whole source through the editor (undoable, autosaved).', 'latex.setSource("\\\\documentclass{article}...")'],
  ['replace(find, replacement, { all?, regex?, caseSensitive? })', 'Find/replace text or RegExp; returns { count }. Regex replacements support $1, $<name>, $&.', 'latex.replace("Old", "New", { all: true })'],
  ['replaceLines(from, to, text)', 'Replace lines from..to (inclusive) with text.', 'latex.replaceLines(3, 4, "\\\\usepackage{amsmath}")'],
  ['insertLines(at, text)', 'Insert text before line at (lineCount + 1 appends).', 'latex.insertLines(10, "% note")'],
  ['append(text)', 'Append text at the end of the source.', 'latex.append("\\n% end")'],
  ['undo() / redo()', 'Undo or redo the last editor change.', 'latex.undo()'],
  ['save()', 'Save on this device, then to your account when signed in. Resolves after the cloud request finishes.', 'await latex.save()'],
  ['compile({ force? })', 'Compile current source; reuses an in-flight compile of the same source unless force. Resolves with { ok, status, errors, warnings, timings }.', 'await latex.compile()'],
  ['cancel()', 'Cancel the running compilation.', 'latex.cancel()'],
  ['preview()', 'Compile, show the preview panel and resolve once the new PDF is displayed, with page count.', 'await latex.preview()'],
  ['log()', 'Last compilation log text with parsed errors and warnings.', 'latex.log().errors'],
  ['timings()', 'Engine startup, last compile, local save and account save round-trip timings in ms.', 'latex.timings()'],
  ['pdf()', 'Displayed PDF info: bytes, pages, title, upToDate.', 'latex.pdf()'],
  ['exportTex({ download? })', 'Return the source, or download main .tex like the UI.', 'latex.exportTex({ download: true })'],
  ['exportPdf({ as?: "base64"|"blob"|"download" })', 'Latest compiled PDF as base64 (default), a Blob, or a download.', 'await latex.exportPdf()'],
  ['show(panel)', 'Show "projects", "workspace", "source" or "preview".', 'latex.show("preview")'],
  ['livePreview(enabled?)', 'Read or set the live preview preference.', 'latex.livePreview(true)'],
  ['on(event, handler)', 'Subscribe to change, document, compile, preview, save or error. Returns an unsubscribe function.', 'const off = latex.on("compile", e => console.log(e))'],
].map(([signature, description, example]) => ({ name: signature.split('(')[0], signature, description, example }));

function helpText(name) {
  if (name) {
    const method = API_METHODS.find(item => item.name === name || item.signature.startsWith(`${name}(`) || item.signature.includes(` ${name}(`));
    if (!method) throw new Error(`Unknown method "${name}". Call latex.help() for the list.`);
    return `latex.${method.signature}\n  ${method.description}\n  Example: ${method.example}`;
  }
  return ['KhanhhNeLatex page API (window.latex). Methods return JSON-serializable data or Promises that settle when the action completes.',
    ...API_METHODS.map(method => `  latex.${method.signature}\n      ${method.description}`)].join('\n');
}

const EVENTS = new Set(['change', 'document', 'compile', 'preview', 'save', 'error']);

function waitForEvent(target, type, accept, timeout) {
  return new Promise((resolve, reject) => {
    const listener = event => {
      if (!accept(event.detail)) return;
      clearTimeout(timer);
      target.removeEventListener(type, listener);
      resolve(event.detail);
    };
    const timer = setTimeout(() => {
      target.removeEventListener(type, listener);
      reject(new Error(`Timed out waiting for ${type}.`));
    }, timeout);
    target.addEventListener(type, listener);
  });
}

export function createAgentApi(getBridge) {
  const events = new EventTarget();
  const bridge = () => getBridge();
  const doc = () => {
    const document = bridge().active();
    if (!document) throw new Error('No document is open yet. Await latex.ready() first.');
    return document;
  };
  const source = () => doc().source;
  const edit = text => {
    const next = validateSource(text).replace(/\r\n?/g, '\n');
    bridge().applySource(next);
    return { length: next.length, lines: lineList(next).length };
  };
  const compileView = result => {
    if (!result) return null;
    const { errors, warnings } = parseLog(result.log);
    return {
      ok: result.ok, cancelled: Boolean(result.cancelled), status: result.status,
      error: result.error || null, errors, warnings, timings: result.timings || null,
      bytes: result.bytes ?? null, documentId: result.documentId, request: result.request ?? null, upToDate: result.source === bridge().active()?.source,
    };
  };
  const permalink = item => validDocumentCode(item.code) ? documentPath(item) : null;
  const resolveDocument = ref => {
    const list = bridge().documents();
    if (ref === undefined || ref === null) return list.find(item => item.current) || null;
    const key = typeof ref === 'object' ? ref.id ?? ref.key : ref;
    const value = String(key);
    const code = /\/documents\/[^/]+\/([A-Za-z0-9_-]{8})\/?(?:[?#].*)?$/.exec(value)?.[1] ?? value;
    const found = list.find(item => item.id === value || item.key === value || item.cloudId === value || item.code === code)
      || list.find(item => item.title === value)
      || (value.length >= 8 ? list.filter(item => item.cloudId?.startsWith(value)) : []).find((_, index, all) => all.length === 1);
    if (!found) throw new Error(`No document matches "${value}". Call latex.list() for ids and titles.`);
    return found;
  };
  async function compile({ force = false } = {}) {
    doc();
    const b = bridge();
    const task = b.compileTask();
    let promise = !force && task?.pending && task.source === source() ? task.promise : b.compile();
    let result = await promise;
    while (result?.superseded) {
      const next = bridge().compileTask();
      if (!next || next.promise === promise) break;
      promise = next.promise;
      result = await promise;
    }
    if (!result || result.superseded) return { ok: false, cancelled: true, status: 'Compilation was superseded or cancelled.', errors: [], warnings: [] };
    return compileView(result);
  }
  const api = {
    version: 1,
    help(name) { return helpText(name); },
    async ready() { await bridge().loaded(); return api.status(); },
    status() {
      const b = bridge(), state = b.state(), active = b.active();
      return {
        view: state.view, panel: state.tab, signedIn: Boolean(state.user), username: state.user?.username || null,
        document: active ? api.current() : null,
        saveState: state.saveState, compileState: state.compileState, compiling: b.compiling(),
        previewUpToDate: Boolean(b.shownPdf()) && b.shownPdf().source === active?.source,
        engine: state.engineState, livePreview: state.live, busy: state.busy, error: state.error || null,
      };
    },
    list() {
      return bridge().documents().map(item => ({
        id: item.id, key: item.key, cloudId: item.cloudId || (item.localAvailable ? null : item.id), code: item.code || null,
        url: permalink(item), title: item.title,
        local: item.localAvailable, cloud: item.cloudAvailable, dirty: Boolean(item.dirty),
        updatedAt: Number(item.updated_at) || Date.parse(item.updated_at) || null, current: Boolean(item.current),
      }));
    },
    current() {
      const active = bridge().active();
      if (!active) return null;
      return {
        id: active.id, cloudId: active.cloudId || null, code: active.code || null, url: permalink(active),
        title: active.title, dirty: Boolean(active.dirty),
        updatedAt: active.updated_at, length: active.source.length, lines: lineList(active.source).length,
        revision: active.revision ?? null,
      };
    },
    async open(ref, { account = false, replaceDraft = false } = {}) {
      await bridge().loaded();
      const item = resolveDocument(ref);
      if (!item) throw new Error('Pass a document id, cloudId or title.');
      if (account && !item.cloudItem) throw new Error('This document is not in your account.');
      await bridge().open(item, { account, replaceDraft });
      await bridge().rendered();
      const active = bridge().active();
      const opened = item.localAvailable && !account ? active?.id === item.id : active?.cloudId === (item.cloudItem?.id ?? item.cloudId);
      if (!opened) throw new Error(bridge().lastError() || 'The document could not be opened.');
      return api.current();
    },
    async create({ title = 'Untitled paper', source: text } = {}) {
      await bridge().loaded();
      if (typeof title !== 'string' || !title.trim() || title.length > 100) throw new Error('title must be 1-100 characters.');
      if (text !== undefined) validateSource(text);
      const before = bridge().active();
      await bridge().create(text, title.trim());
      await bridge().rendered();
      if (bridge().active() === before) throw new Error(bridge().lastError() || 'The document could not be created.');
      return api.current();
    },
    async rename(title) {
      doc();
      if (typeof title !== 'string' || !title.trim() || title.length > 100) throw new Error('title must be 1-100 characters.');
      await bridge().rename(title.trim());
      return api.current();
    },
    async remove(ref, { confirm = false } = {}) {
      if (confirm !== true) throw new Error('Deleting cannot be undone. Pass { confirm: true }.');
      await bridge().loaded();
      const item = resolveDocument(ref);
      if (!item) throw new Error('No document is open.');
      if (!item.localAvailable) throw new Error('Open this account document first, then remove it.');
      if (!item.current) await api.open(item.id);
      const ok = await bridge().remove();
      await bridge().rendered();
      if (!ok) throw new Error(bridge().lastError() || 'The document could not be deleted.');
      return { removed: item.id, current: api.current() };
    },
    read(options) { return readLines(source(), options); },
    find(query, options) { return findText(source(), query, options); },
    setSource(text) { return edit(text); },
    replace(find, replacement, options) {
      const result = replaceText(source(), find, replacement, options);
      if (result.count) edit(result.source);
      return { count: result.count };
    },
    replaceLines(from, to, text) { return edit(replaceLines(source(), from, to, text)); },
    insertLines(at, text) { return edit(insertLines(source(), at, text)); },
    append(text) {
      if (typeof text !== 'string') throw new TypeError('text must be a string.');
      return edit(source() + text);
    },
    undo() { doc(); return bridge().history('undo'); },
    redo() { doc(); return bridge().history('redo'); },
    async save() {
      doc();
      const result = await bridge().save();
      if (result.cloud && !result.ok) throw new Error(result.error);
      return result;
    },
    compile,
    cancel() { bridge().cancel(); return api.status(); },
    async preview() {
      bridge().show('preview');
      const result = await compile();
      if (!result.ok) return result;
      const shown = bridge().shownPdf();
      if (shown?.request >= result.request && shown.pages) return { ...result, pages: shown.pages };
      const detail = await waitForEvent(events, 'preview', preview => preview.request >= result.request, 20000);
      return { ...result, pages: detail.pages ?? null };
    },
    log() {
      const text = bridge().state().log || '';
      return { text, ...parseLog(text), status: bridge().state().compileState };
    },
    timings() { return bridge().timings(); },
    pdf() {
      const shown = bridge().shownPdf(), latest = bridge().latestPdf();
      if (!shown && !latest) return null;
      return {
        bytes: latest?.bytes.byteLength ?? null, pages: shown?.pages ?? null, title: latest?.title ?? shown?.title,
        upToDate: shown?.source === bridge().active()?.source, displayedBytes: shown?.bytes.byteLength ?? null,
      };
    },
    exportTex({ download = false } = {}) {
      const active = doc();
      if (download) { bridge().download(active.source, `${active.title || 'document'}.tex`, 'text/plain;charset=utf-8'); return { downloaded: true }; }
      return active.source;
    },
    async exportPdf({ as = 'base64' } = {}) {
      const latest = bridge().latestPdf();
      if (!latest) throw new Error('No PDF yet. Await latex.compile() first.');
      if (as === 'download') { bridge().download(latest.bytes, `${latest.title || 'document'}.pdf`, 'application/pdf'); return { downloaded: true, bytes: latest.bytes.byteLength }; }
      if (as === 'blob') return new Blob([latest.bytes], { type: 'application/pdf' });
      if (as === 'base64') return { bytes: latest.bytes.byteLength, base64: toBase64(latest.bytes) };
      throw new Error('as must be "base64", "blob" or "download".');
    },
    show(panel) {
      if (!['projects', 'workspace', 'source', 'preview'].includes(panel)) throw new Error('panel must be "projects", "workspace", "source" or "preview".');
      bridge().show(panel);
      return panel;
    },
    livePreview(enabled) {
      if (enabled !== undefined) bridge().setLive(Boolean(enabled));
      return Boolean(enabled ?? bridge().state().live);
    },
    on(type, handler) {
      if (!EVENTS.has(type)) throw new Error(`Unknown event "${type}". Use one of: ${[...EVENTS].join(', ')}.`);
      if (typeof handler !== 'function') throw new TypeError('handler must be a function.');
      const listener = event => handler(event.detail);
      events.addEventListener(type, listener);
      return () => events.removeEventListener(type, listener);
    },
  };
  Object.freeze(api);
  return {
    api,
    compileView,
    emit(type, detail) { events.dispatchEvent(new CustomEvent(type, { detail })); },
  };
}
