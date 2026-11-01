import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LatexCompiler } from './compiler.js';
import { api, drafts, download, readTex } from './storage.js';
import LatexEditor from './components/LatexEditor.jsx';
import ProjectsView from './components/ProjectsView.jsx';
import DocumentAvailability from './components/DocumentAvailability.jsx';
import Icon from './components/Icon.jsx';
import PdfPreview from './components/PdfPreview.jsx';
import useWorkspaceResize from './components/workspace-resize.js';
import { mergeDocuments } from './document-list.js';
import { documentPath, documentRoute, newDocumentCode, validDocumentCode } from './document-url.js';
import { API_METHODS, createAgentApi } from './agent-api.js';
import { createText, editText, encodeState, mergeText } from './crdt.js';
import './style.css';

const starter = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath}
\usepackage[margin=1in]{geometry}

\title{A little room for big ideas}
\author{Your name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Every good paper starts with a thought.
This is a quiet place to give yours a little structure.
\end{abstract}

\section{The beginning}
Write freely. Compile when you are ready.
Your source stays in this browser until you choose
to save it to your account.

\section{A beautiful idea}
The Gaussian integral is
\begin{equation}
  \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}.
\end{equation}

\section{Next steps}
\begin{itemize}
  \item Give this document a title.
  \item Make something worth sharing.
  \item Export your source or a finished PDF.
\end{itemize}

\end{document}
`;
const makeDraft = (source = starter, title = 'Untitled paper') => ({
  id: crypto.randomUUID(), code: newDocumentCode(), title, source, updated_at: Date.now(), cloudId: null, revision: null, owner: null, dirty: true,
});
const elapsed = milliseconds => milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
function samePdf(first, second) {
  const a = new Uint8Array(first), b = new Uint8Array(second);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function App() {
  const [documents, setDocuments] = useState([]);
  const [current, setCurrent] = useState(null);
  const [user, setUser] = useState(null);
  const [cloud, setCloud] = useState([]);
  const [saveState, setSaveState] = useState('Loading local drafts...');
  const [error, setError] = useState('');
  const [view, setView] = useState(() => documentRoute(location.pathname) ? 'permalink' : location.hash === '#workspace' ? 'workspace' : 'projects');
  const [localReady, setLocalReady] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [routeVersion, setRouteVersion] = useState(0);
  const [routeError, setRouteError] = useState('');
  const localDocuments = useRef(documents);
  localDocuments.current = documents;
  const visibleView = useRef(view);
  visibleView.current = view;
  const sizing = useWorkspaceResize(view === 'workspace');
  const [auth, setAuth] = useState(null);
  const [busy, setBusy] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [compileState, setCompileState] = useState('Ready when you are');
  const [log, setLog] = useState('');
  const [pdf, setPdf] = useState(null);
  const [pendingPdf, setPendingPdf] = useState(null);
  const [stale, setStale] = useState(false);
  const [tab, setTab] = useState('source');
  const [sidebar, setSidebar] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [live, setLive] = useState(false);
  const [engineState, setEngineState] = useState('Preparing browser engine...');
  const fileInput = useRef(null);
  const active = useRef(null);
  const timer = useRef(null);
  const pending = useRef(false);
  const saving = useRef(Promise.resolve());
  const persisted = useRef(new WeakSet());
  const selectionRequest = useRef(0);
  const generation = useRef(0);
  const compiler = useRef(null);
  if (!compiler.current) compiler.current = new LatexCompiler();
  const pdfRef = useRef(null);
  const shownPdf = useRef(null);
  const generatedPdf = useRef(null);
  const pendingViewer = useRef(null);
  const retiredUrls = useRef([]);
  const previewView = useRef(null);
  const compileRequest = useRef(0);
  const liveTimer = useRef(null);
  const liveEnabled = useRef(false);
  const compiledSource = useRef(null);
  const requestedSource = useRef(null);
  const compileDuration = useRef(0);
  const cloudTimings = useRef(new Map());
  const cloudTimers = useRef(new Map());
  const cloudSnapshots = useRef(new Map());
  const cloudQueue = useRef(new Map());
  const cloudSaving = useRef(false);
  const account = useRef(null);
  const cloudRequest = useRef(0);
  const cloudMetadata = useRef(new Map());
  const textReplica = useRef(null);
  const localLoaded = useRef(Promise.resolve());
  const draftChannel = useRef(null);
  account.current = user;
  const editorApi = useRef(null);
  const titleInput = useRef(null);
  const lastError = useRef('');
  const lastCompile = useRef(null);
  const compileTask = useRef(null);
  const engineMs = useRef(null);
  const localSaveMs = useRef(null);
  const renderWaiters = useRef([]);
  const loaded = useRef(null);
  if (!loaded.current) {
    let resolve;
    let remaining = 2; // device drafts and the account/cloud list check
    loaded.current = { promise: new Promise(done => { resolve = done; }) };
    loaded.current.resolve = () => { if (--remaining === 0) resolve(); };
  }
  const bridge = useRef(null);
  const agent = useRef(null);
  if (!agent.current) agent.current = createAgentApi(() => bridge.current);
  const emit = (type, detail) => agent.current.emit(type, detail);
  const emitPreview = viewer => emit('preview', {
    request: viewer.request, pages: viewer.pages ?? null, bytes: viewer.bytes.byteLength, documentId: active.current?.id ?? null,
  });

  function notice(reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    lastError.current = message;
    setError(message);
    emit('error', { message });
  }
  function materialize(document) {
    const live = textReplica.current;
    if (live?.id === document.id && live.doc.getMap('identity').get('code') === document.code
      && live.doc.getText('source').toString() === document.source)
      return { ...document, crdt_state: encodeState(live.doc) };
    const doc = createText(document);
    try {
      editText(doc, document.source);
      return { ...document, crdt_state: encodeState(doc) };
    } finally { doc.destroy(); }
  }
  function activate(document) {
    const doc = createText(document);
    const changed = active.current?.id === document.id && active.current.source !== document.source;
    textReplica.current?.doc.destroy();
    textReplica.current = { id: document.id, doc };
    active.current = document;
    setCurrent(document);
    if (changed) {
      setStale(shownPdf.current?.source !== document.source);
      emit('change', { documentId: document.id, title: document.title, length: document.source.length, fields: ['source'] });
      scheduleLive();
    }
  }
  function adoptCode(document, code) {
    return document.code === code ? document : materialize({ ...document, code, crdt_state: null });
  }
  function showWorkspace(document = active.current, navigation = 'push') {
    if (!document) return;
    const path = documentPath(document);
    if (navigation !== 'none' && location.pathname + location.search + location.hash !== path)
      history[navigation === 'replace' ? 'replaceState' : 'pushState'](null, '', path);
    setRouteError('');
    setView('workspace');
  }
  function showProjects(navigation = 'push') {
    selectionRequest.current++;
    if (navigation !== 'none' && location.pathname + location.search + location.hash !== '/')
      history.pushState(null, '', '/');
    setView('projects');
    if (compiler.current.active) cancelCompile();
    else compiler.current.cancel();
  }
  function discardPendingViewer() {
    const viewer = pendingViewer.current;
    if (!viewer) return;
    clearTimeout(viewer.timeout);
    clearTimeout(viewer.swap);
    cancelAnimationFrame(viewer.frame);
    URL.revokeObjectURL(viewer.url);
    pendingViewer.current = null;
    setPendingPdf(null);
  }
  function revealPreview(url) {
    const viewer = pendingViewer.current;
    if (!viewer || viewer.url !== url || viewer.loaded) return;
    viewer.loaded = true;
    clearTimeout(viewer.timeout);
    viewer.frame = requestAnimationFrame(() => {
      viewer.frame = requestAnimationFrame(() => {
        if (pendingViewer.current !== viewer || viewer.request !== compileRequest.current) return;
        setPendingPdf({ ...viewer, ready: true });
        viewer.swap = setTimeout(() => {
          if (pendingViewer.current !== viewer || viewer.request !== compileRequest.current) return;
          retiredUrls.current.push(pdfRef.current);
          pdfRef.current = viewer.url;
          shownPdf.current = viewer;
          pendingViewer.current = null;
          setPdf(viewer);
          setPendingPdf(null);
          setStale(active.current.source !== viewer.source);
          emitPreview(viewer);
        }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200);
      });
    });
  }
  useEffect(() => {
    for (const url of retiredUrls.current) if (url) URL.revokeObjectURL(url);
    retiredUrls.current = [];
  }, [pdf]);
  function savedLabel(document) {
    const timing = cloudTimings.current.get(document.id);
    return document.dirty ? 'Saved on this device'
      : `Saved to your account${timing === undefined ? '' : ` · ${elapsed(timing)} round trip`}`;
  }
  async function persist(document = active.current) {
    if (!document) return;
    if (document === active.current) clearTimeout(timer.current);
    if (persisted.current.has(document)) return;
    if (document === active.current) pending.current = true;
    const started = performance.now();
    try {
      const snapshot = materialize(document);
      const work = saving.current.catch(() => {}).then(() => drafts.put(snapshot));
      saving.current = work;
      let saved = await work;
      localSaveMs.current = performance.now() - started;
      emit('save', { documentId: document.id, local: true, cloud: false });
      let raced = false;
      if (active.current?.id === document.id) {
        const latest = active.current;
        const merged = mergeText(saved, materialize(latest));
        raced = merged.crdt_state !== saved.crdt_state || latest.title !== saved.title
          || latest.owner !== saved.owner || latest.cloudId !== saved.cloudId || latest.revision !== saved.revision;
        saved = { ...saved, ...latest, ...merged, dirty: raced || saved.dirty || latest.dirty };
      }
      if (active.current?.id === document.id) {
        activate(saved);
        if (!raced) persisted.current.add(saved);
        else {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => persist().catch(() => {}), 300);
          scheduleCloud(saved);
        }
        if (saved.source !== document.source) {
          setStale(shownPdf.current?.source !== saved.source);
          scheduleCloud(saved);
        }
      }
      persisted.current.add(document);
      if (active.current?.id === document.id) {
        pending.current = raced;
        setSaveState(raced ? 'Saving on this device...' : savedLabel(saved));
      }
      cloudSnapshots.current.set(saved.id, saved);
      setDocuments(list => [saved, ...list.filter(item => item.id !== saved.id && item.code !== saved.code)]);
      draftChannel.current?.postMessage({ id: saved.id });
      return saved;
    } catch (reason) { notice(reason); setSaveState('Local save failed - export your source'); throw reason; }
  }
  async function flush() {
    let snapshot;
    do {
      snapshot = active.current;
      await persist(snapshot);
    } while (active.current && !persisted.current.has(active.current));
  }
  function update(patch, changes, before) {
    if ('source' in patch) {
      try {
        if (textReplica.current?.id !== active.current.id) activate(materialize(active.current));
        if (changes && before !== undefined && active.current.source !== before)
          editText(textReplica.current.doc, before);
        editText(textReplica.current.doc, patch.source, changes);
      } catch (reason) { notice(reason); return; }
    }
    const next = { ...active.current, ...patch, dirty: true, updated_at: Date.now() };
    active.current = next;
    setCurrent(next);
    if ('title' in patch && view === 'workspace') showWorkspace(next, 'replace');
    scheduleCloud(next);
    pending.current = true;
    setSaveState('Saving on this device...');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { persist(next).catch(() => {}); }, 300);
    emit('change', { documentId: next.id, title: next.title, length: next.source.length, fields: Object.keys(patch) });
    if ('source' in patch) {
      setStale(shownPdf.current?.source !== next.source);
      scheduleLive();
    }
  }
  async function select(document, force = false, navigation = 'push') {
    const selection = ++selectionRequest.current;
    if (!force && document.id === active.current?.id) {
      scheduleCloud(active.current);
      showWorkspace(active.current, navigation);
      setSidebar(false);
      if (!shownPdf.current && !compiler.current.active) compile({ reveal: false });
      return;
    }
    try {
      await flush();
      if (selection !== selectionRequest.current) return;
      showWorkspace(document, navigation);
      clearTimeout(liveTimer.current);
      discardPendingViewer();
      compileRequest.current++;
      compiler.current.cancel();
      setCompiling(false);
      generation.current++;
      document = materialize(document);
      activate(document);
      scheduleCloud(document);
      setDocuments(list => [document, ...list.filter(item => item.id !== document.id)]);
      compiledSource.current = null;
      requestedSource.current = null;
      setStale(false);
      setLog('');
      setCompileState('Ready when you are');
      if (pdfRef.current) URL.revokeObjectURL(pdfRef.current);
      pdfRef.current = null;
      shownPdf.current = null;
      previewView.current = null;
      generatedPdf.current = null;
      setPdf(null);
      setSidebar(false);
      setSaveState(persisted.current.has(document) ? savedLabel(document) : 'Saving on this device...');
      emit('document', { id: document.id, cloudId: document.cloudId || null, title: document.title });
      compile({ reveal: false });
      await persist(document);
    } catch (reason) {
      notice(reason);
      if (active.current) showWorkspace(active.current, 'replace');
      else setRouteError(reason.message);
    }
  }
  async function newDocument(source, title) {
    const document = makeDraft(source, title);
    document.code = newDocumentCode(new Set(documents.map(item => item.code)));
    try { await select(document); }
    catch (reason) { notice(reason); }
  }
  async function refreshCloud(owner = account.current, reconcile = true) {
    if (!owner) { cloudRequest.current++; setCloud([]); return; }
    const request = ++cloudRequest.current;
    const data = await api('/documents');
    if (request !== cloudRequest.current || account.current?.id !== owner.id) return;
    cloudMetadata.current = new Map(data.documents.map(document => [document.id, document]));
    setCloud(data.documents);
    if (reconcile) {
      await localLoaded.current;
      const list = await drafts.all();
      if (account.current?.id !== owner.id) return;
      for (let document of list) {
        if (document.owner && document.owner !== owner.id) continue;
        const linked = document.owner === owner.id && data.documents.find(item => item.id === document.cloudId);
        if (linked?.code && linked.code !== document.code) {
          document = adoptCode(active.current?.id === document.id ? active.current : document, linked.code);
          if (active.current?.id === document.id) {
            activate(document);
            if (visibleView.current === 'workspace') showWorkspace(document, 'replace');
          }
          await persist(document);
        }
        sync({ snapshot: active.current?.id === document.id ? active.current : document, automatic: true });
      }
    }
  }
  useEffect(() => {
    let disposed = false;
    try {
      liveEnabled.current = localStorage.getItem('folio-live-preview') === 'true';
      setLive(liveEnabled.current);
    } catch { notice(new Error('Could not read the live preview preference. This session starts with live preview off.')); }
    localLoaded.current = drafts.all().then(async list => {
      const document = list.sort((a, b) => b.updated_at - a.updated_at)[0] || makeDraft();
      if (!list.length) await drafts.put(document);
      if (disposed) return;
      for (const draft of list.length ? list : [document]) persisted.current.add(draft);
      activate(materialize(document));
      if (document.dirty) scheduleCloud(document);
      setDocuments(list.length ? list : [document]);
      setLocalReady(true);
      setSaveState('Saved on this device');
      loaded.current.resolve();
    }).catch(reason => { loaded.current.resolve(); notice(reason); setRouteError(reason.message); });
    api('/me').then(data => {
      if (!disposed) {
        account.current = data.user;
        setUser(data.user);
        return refreshCloud(data.user).catch(notice);
      }
    }).catch(reason => {
      if (!reason.message.startsWith('Sign in') && !reason.message.startsWith('Session expired')) notice(reason);
    }).finally(() => { if (!disposed) setAuthReady(true); loaded.current.resolve(); });
    const popstate = () => {
      selectionRequest.current++;
      setRouteVersion(version => version + 1);
    };
    window.addEventListener('popstate', popstate);
    const unload = event => {
      if (pending.current) { event.preventDefault(); event.returnValue = ''; }
    };
    const hidden = () => { if (document.visibilityState === 'hidden' && pending.current) persist().catch(() => {}); };
    const online = () => {
      api('/me').then(data => {
        account.current = data.user;
        setUser(data.user);
        return refreshCloud(data.user);
      }).catch(reason => {
        if (reason.status !== 401) notice(reason);
      });
    };
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('folio-drafts') : null;
    draftChannel.current = channel;
    if (channel) channel.onmessage = async () => {
      try {
        const list = await drafts.all();
        const incoming = list.find(item => item.id === active.current?.id);
        if (incoming) {
          const local = materialize(active.current);
          if (incoming.crdt_state !== local.crdt_state) {
            const next = { ...active.current, ...mergeText(local, incoming), dirty: true };
            activate(next);
            pending.current = true;
            clearTimeout(timer.current);
            timer.current = setTimeout(() => persist().catch(() => {}), 300);
            scheduleCloud(next);
          }
        }
        setDocuments(list);
      } catch (reason) { notice(reason); }
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      disposed = true;
      for (const timeout of cloudTimers.current.values()) clearTimeout(timeout);
      cloudTimers.current.clear();
      clearTimeout(timer.current);
      clearTimeout(liveTimer.current);
      compileRequest.current++;
      compiler.current.cancel();
      discardPendingViewer();
      if (pdfRef.current) URL.revokeObjectURL(pdfRef.current);
      for (const url of retiredUrls.current) if (url) URL.revokeObjectURL(url);
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('popstate', popstate);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', hidden);
      channel?.close();
      draftChannel.current = null;
      textReplica.current?.doc.destroy();
    };
  }, []);
  useEffect(() => {
    if (!localReady || !authReady) return;
    const pathname = location.pathname;
    const route = documentRoute(pathname);
    const request = ++selectionRequest.current;
    let disposed = false;
    const stillCurrent = () => !disposed && request === selectionRequest.current && location.pathname === pathname;
    async function resolve() {
      if (!route) {
        if (location.hash === '#workspace') await select(active.current, false, 'replace');
        else {
          await flush();
          if (stillCurrent()) showProjects('none');
        }
        return;
      }
      setView('permalink');
      setRouteError('');
      compiler.current.cancel();
      if (!route.code) { setRouteError('Document not found.'); return; }
      const local = localDocuments.current.find(document => document.code === route.code);
      if (local) { await select(local, false, 'replace'); return; }
      if (!account.current) { setRouteError('Sign in to open this private document, or return to your projects.'); return; }
      const owner = account.current.id;
      const { document } = await api(`/documents/by-code/${route.code}`);
      if (!stillCurrent() || account.current?.id !== owner) return;
      const cached = localDocuments.current.find(item => item.cloudId === document.id && item.owner === owner);
      const next = { ...document, ...(cached ? mergeText(adoptCode(materialize(cached), document.code), document) : {}),
        id: cached?.id || crypto.randomUUID(), cloudId: document.id, owner, dirty: Boolean(cached?.dirty) };
      await select(next, true, 'replace');
    }
    resolve().catch(reason => {
      if (stillCurrent()) { setRouteError(reason.message); notice(reason); }
    });
    return () => { disposed = true; };
  }, [localReady, authReady, routeVersion, user?.id]);
  useEffect(() => {
    if (view !== 'workspace') return;
    let disposed = false;
    compiler.current.warmup().then(timing => {
      engineMs.current = timing.initializationMs;
      if (!disposed) setEngineState(`Engine initialized · ${elapsed(timing.initializationMs)}`);
    }).catch(reason => {
      if (!disposed && reason.message !== 'Compilation cancelled.') notice(reason);
    });
    return () => { disposed = true; };
  }, [view]);

  function scheduleLive() {
    clearTimeout(liveTimer.current);
    if (!liveEnabled.current || !active.current) return;
    if (compiler.current.active && requestedSource.current === active.current.source) return;
    if (!compiler.current.active && compiledSource.current === active.current.source) return;
    const delay = Math.max(700, Math.min(2000, compileDuration.current * 1.5));
    liveTimer.current = setTimeout(() => compile({ reveal: false }), delay);
  }
  function toggleLive(enabled) {
    liveEnabled.current = enabled;
    setLive(enabled);
    try { localStorage.setItem('folio-live-preview', String(enabled)); }
    catch { notice(new Error('Could not save the live preview preference. It will only apply to this session.')); }
    if (enabled) scheduleLive();
    else clearTimeout(liveTimer.current);
  }
  function cancelCompile() {
    clearTimeout(liveTimer.current);
    discardPendingViewer();
    compileRequest.current++;
    compiler.current.cancel();
    setCompiling(false);
    setCompileState('Compilation cancelled.');
    setLog('');
  }
  function compile(options) {
    if (!active.current) return Promise.resolve(null);
    const task = { source: active.current.source, pending: true };
    task.promise = runCompile(options, task);
    compileTask.current = task;
    return task.promise;
  }
  function finishCompile(outcome) {
    lastCompile.current = outcome;
    emit('compile', agent.current.compileView(outcome));
    return outcome;
  }
  async function runCompile({ reveal = true } = {}, task) {
    clearTimeout(liveTimer.current);
    discardPendingViewer();
    const snapshot = active.current;
    const run = ++compileRequest.current;
    task.run = run;
    requestedSource.current = snapshot.source;
    setCompiling(true);
    setLog('');
    setCompileState('Preparing compilation...');
    try {
      const result = await compiler.current.compile(snapshot.source, status => {
        if (run === compileRequest.current && /^(Loading browser engine|Downloading|Typesetting|Resolving)/.test(status)) setCompileState(status);
      });
      if (run !== compileRequest.current) return { superseded: true };
      const next = { bytes: result.pdf, title: snapshot.title, source: snapshot.source, request: run };
      generatedPdf.current = next;
      if (shownPdf.current && samePdf(shownPdf.current.bytes, result.pdf)) {
        shownPdf.current = { ...shownPdf.current, ...next };
        setPdf(shownPdf.current);
        emitPreview(shownPdf.current);
      } else {
        next.url = URL.createObjectURL(new Blob([result.pdf], { type: 'application/pdf' }));
        if (!shownPdf.current) {
          pdfRef.current = next.url;
          shownPdf.current = next;
          setPdf(next);
        } else {
          pendingViewer.current = next;
          next.timeout = setTimeout(() => {
            if (pendingViewer.current !== next) return;
            discardPendingViewer();
            notice(new Error('The PDF viewer did not finish loading. Your previous preview is still available; export the new PDF or compile again.'));
          }, 15000);
          setPendingPdf(next);
        }
      }
      compiledSource.current = snapshot.source;
      compileDuration.current = result.timings.compilationMs;
      setStale(active.current.source !== shownPdf.current.source);
      setLog(result.log);
      setCompileState(`Compiled in your browser · ${elapsed(result.timings.compilationMs)}`);
      if (result.timings.initializationMs > 0) {
        engineMs.current = result.timings.initializationMs;
        setEngineState(`Engine initialized · ${elapsed(result.timings.initializationMs)}`);
      }
      if (reveal) setTab('preview');
      return finishCompile({
        ok: true, status: `Compiled in your browser · ${elapsed(result.timings.compilationMs)}`, log: result.log,
        timings: result.timings, bytes: result.pdf.byteLength, source: snapshot.source, documentId: snapshot.id, request: run,
      });
    } catch (reason) {
      if (run !== compileRequest.current) return { superseded: true };
      const status = reason.message === 'Compilation cancelled.' ? reason.message
        : reason.message.startsWith('LaTeX') ? 'LaTeX could not compile. See compilation log.'
          : reason.message.startsWith('Compilation timed out') ? 'Compilation timed out. See compilation log.'
            : 'Compilation failed. See compilation log.';
      setCompileState(status);
      setLog(reason.log || reason.message);
      return finishCompile({
        ok: false, cancelled: reason.message === 'Compilation cancelled.', status, error: reason.message,
        log: reason.log || reason.message, source: snapshot.source, documentId: snapshot.id, request: run,
      });
    } finally {
      task.pending = false;
      if (run === compileRequest.current) setCompiling(false);
    }
  }
  function scheduleCloud(document) {
    cloudSnapshots.current.set(document.id, document);
    clearTimeout(cloudTimers.current.get(document.id));
    if (!navigator.onLine || !account.current || (document.owner && document.owner !== account.current.id)) return;
    cloudTimers.current.set(document.id, setTimeout(() => {
      cloudTimers.current.delete(document.id);
      sync({ snapshot: cloudSnapshots.current.get(document.id), automatic: true });
    }, 800));
  }
  async function sync({ snapshot = active.current, automatic = false } = {}) {
    if (!snapshot) return { ok: false, error: 'No document is open.' };
    const owner = account.current;
    if (!owner) { if (!automatic) setAuth('login'); return { ok: false, error: 'Sign in to save to your account.' }; }
    if (snapshot.owner && snapshot.owner !== owner.id) {
      if (!automatic) notice(new Error('Sign in to the document owner account to synchronize this document.'));
      return { ok: false, error: 'Sign in to the document owner account to synchronize this document.' };
    }
    if (!navigator.onLine) {
      if (!automatic) setSaveState('Offline - your device draft will sync when online');
      return { ok: false, offline: true, error: 'Offline - your device draft will sync when online.' };
    }
    clearTimeout(cloudTimers.current.get(snapshot.id));
    cloudTimers.current.delete(snapshot.id);
    if (cloudSaving.current) {
      return new Promise(resolve => {
        const queued = cloudQueue.current.get(snapshot.id);
        cloudQueue.current.set(snapshot.id, { snapshot, automatic, waiters: [...(queued?.waiters || []), resolve] });
      });
    }
    let outcome;
    cloudSaving.current = true;
    cloudSnapshots.current.set(snapshot.id, snapshot);
    if (!automatic) setBusy(true);
    setError('');
    let localSaved = false;
    try {
      if (snapshot.cloudId && snapshot.owner === owner.id) {
        let remote = cloudMetadata.current.get(snapshot.cloudId);
        if (!remote) remote = (await api(`/documents/${snapshot.cloudId}`)).document;
        if (remote.code !== snapshot.code) {
          snapshot = adoptCode(active.current?.id === snapshot.id ? active.current : snapshot, remote.code);
          if (active.current?.id === snapshot.id) {
            activate(snapshot);
            if (visibleView.current === 'workspace') showWorkspace(snapshot, 'replace');
          }
        }
      }
      snapshot = await persist(snapshot) || materialize(snapshot);
      localSaved = true;
      if (active.current?.id === snapshot.id) setSaveState('Saving to your account...');
      const started = performance.now();
      const { document: saved } = await api('/documents/sync', {
        code: snapshot.code, title: snapshot.title || 'Untitled paper',
        source: snapshot.source, crdt_state: snapshot.crdt_state,
      });
      if (!validDocumentCode(saved.code) || saved.code !== snapshot.code)
        throw new Error('The account response has a different document identity. Your device draft is kept.');
      const roundTripMs = performance.now() - started;
      cloudTimings.current.set(snapshot.id, roundTripMs);
      const latest = active.current?.id === snapshot.id ? active.current : cloudSnapshots.current.get(snapshot.id);
      const merged = mergeText(materialize(latest || snapshot), saved);
      const next = { ...latest, ...merged, cloudId: saved.id, owner: owner.id, revision: saved.revision,
        dirty: merged.crdt_state !== saved.crdt_state };
      cloudSnapshots.current.set(next.id, next);
      if (active.current?.id === next.id) {
        activate(next);
        if (visibleView.current === 'workspace') showWorkspace(next, 'replace');
      }
      await persist(next);
      if (account.current?.id === owner.id) await refreshCloud(owner, false);
      if (next.dirty && account.current?.id === owner.id) scheduleCloud(next);
      outcome = { ok: true, documentId: next.id, cloudId: next.cloudId, revision: next.revision, roundTripMs, dirty: next.dirty };
      emit('save', { ...outcome, local: true, cloud: true });
    } catch (reason) {
      notice(reason);
      if (localSaved && active.current?.id === snapshot.id) setSaveState('Cloud save failed - device draft kept');
      outcome = { ok: false, documentId: snapshot.id, error: reason instanceof Error ? reason.message : String(reason) };
    }
    finally {
      cloudSaving.current = false;
      if (!automatic) setBusy(false);
      const queued = cloudQueue.current.entries().next().value;
      if (queued) {
        const [id, request] = queued;
        cloudQueue.current.delete(id);
        const latest = cloudSnapshots.current.get(id) || request.snapshot;
        const settle = result => { for (const waiter of request.waiters) waiter(result); };
        sync({ automatic: request.automatic, snapshot: latest }).then(settle);
      }
    }
    return outcome;
  }
  async function openCloud(item) {
    const request = ++selectionRequest.current;
    const owner = account.current?.id;
    try {
      const { document } = await api(`/documents/${item.id}`);
      if (request !== selectionRequest.current || account.current?.id !== owner) return;
      const eligible = doc => (!doc.owner || doc.owner === account.current?.id)
        && (doc.code === document.code || doc.cloudId === item.id);
      const local = active.current && eligible(active.current) ? active.current : localDocuments.current.find(eligible);
      const merged = local ? mergeText(adoptCode(materialize(local), document.code), document) : materialize(document);
      const next = { ...document, ...merged, id: local?.id || crypto.randomUUID(), updated_at: document.updated_at ?? Date.now(),
        cloudId: document.id, owner, dirty: Boolean(local?.dirty) };
      await select(next, true);
    } catch (reason) { notice(reason); }
  }
  async function remove({ confirmed = false } = {}) {
    if (cloudSaving.current) { notice(new Error('Wait for the account save to finish before deleting this document.')); return false; }
    const snapshot = active.current;
    if (!snapshot || !(confirmed === true || window.confirm(`Delete "${snapshot.title}"${snapshot.cloudId ? ' from this device and your account' : ''}? This cannot be undone.`))) return false;
    clearTimeout(cloudTimers.current.get(snapshot.id));
    cloudTimers.current.delete(snapshot.id);
    cloudQueue.current.delete(snapshot.id);
    cloudSnapshots.current.delete(snapshot.id);
    setBusy(true);
    try {
      await persist();
      if (snapshot.cloudId) {
        if (snapshot.owner !== user?.id) throw new Error('Sign in to the document owner account before deleting this synced draft.');
        await api(`/documents/${snapshot.cloudId}`, undefined, 'DELETE');
        await refreshCloud(user, false);
      }
      await drafts.delete(snapshot.id);
      const list = documents.filter(doc => doc.id !== snapshot.id);
      const next = list[0] || makeDraft();
      if (!list.length) await drafts.put(next);
      active.current = null;
      setDocuments(list.length ? list : [next]);
      await select(next);
      return true;
    } catch (reason) { notice(reason); return false; }
    finally { setBusy(false); }
  }
  async function importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try { await newDocument(await readTex(file), file.name.slice(0, -4).slice(0, 100)); }
    catch (reason) { notice(reason); }
  }
  const actions = useRef({});
  actions.current = { compile, sync, modal: Boolean(auth || showHelp) };
  const unifiedDocuments = mergeDocuments(documents, cloud, user?.id);
  function openDocument(document) {
    if (!document.localAvailable) return openCloud(document.cloudItem);
    if (document.cloudItem && navigator.onLine) {
      return openCloud(document.cloudItem);
    }
    const { key, localAvailable, cloudAvailable, cloudItem, localUpdatedAt, current: _current, ...draft } = document;
    return select(draft);
  }
  function applySource(next) {
    const document = active.current;
    if (!document) throw new Error('No document is open.');
    if (next === document.source) return;
    const handle = editorApi.current;
    if (handle?.documentKey === `${document.id}:${generation.current}`) handle.replace(next);
    if (active.current.source !== next) update({ source: next });
  }
  bridge.current = {
    loaded: () => loaded.current.promise,
    rendered: () => new Promise(resolve => { renderWaiters.current.push(resolve); setTimeout(resolve, 100); }),
    active: () => active.current,
    state: () => ({ view, tab, user, saveState, compileState, engineState, live, busy, error, log }),
    documents: () => unifiedDocuments.map(item => ({ ...item, current: item.localAvailable && item.id === active.current?.id })),
    open: async (item, { account: fromAccount }) => {
      lastError.current = '';
      const { current: _current, ...document } = item;
      if (fromAccount) await openCloud(document.cloudItem);
      else await openDocument(document);
    },
    create: (source, title) => { lastError.current = ''; return newDocument(source, title); },
    rename: async title => {
      update({ title });
      if (titleInput.current) titleInput.current.value = title;
      await persist();
    },
    remove: () => { lastError.current = ''; return remove({ confirmed: true }); },
    applySource,
    history: kind => {
      const handle = editorApi.current;
      if (!handle || handle.documentKey !== `${active.current.id}:${generation.current}`) throw new Error('The editor is still loading. Try again shortly.');
      handle.history(kind);
      return { length: active.current.source.length };
    },
    save: async () => {
      await flush();
      if (!account.current) return { ok: true, local: true, cloud: false, note: 'Not signed in: saved on this device only.' };
      return { ...(await sync({ snapshot: active.current })), local: true, cloud: true };
    },
    compiling: () => Boolean(compileTask.current?.pending),
    compile: () => compile({ reveal: false }),
    compileTask: () => compileTask.current,
    cancel: () => { if (compileTask.current?.pending) cancelCompile(); },
    shownPdf: () => shownPdf.current,
    latestPdf: () => generatedPdf.current,
    timings: () => {
      const round = value => typeof value === 'number' ? Math.round(value * 10) / 10 : null;
      const timings = lastCompile.current?.timings;
      return {
        engineStartupMs: round(engineMs.current),
        compile: timings ? { initializationMs: round(timings.initializationMs), compilationMs: round(timings.compilationMs), totalMs: round(timings.totalMs) } : null,
        lastCompileOk: lastCompile.current ? lastCompile.current.ok : null,
        localSaveMs: round(localSaveMs.current),
        accountSaveRoundTripMs: round(cloudTimings.current.get(active.current?.id)),
      };
    },
    download,
    show: panel => {
      if (panel === 'projects') { showProjects(); return; }
      if (view !== 'workspace') showWorkspace();
      if (panel === 'source' || panel === 'preview') setTab(panel);
    },
    setLive: toggleLive,
    lastError: () => lastError.current,
  };
  useEffect(() => {
    if (!renderWaiters.current.length) return;
    const waiters = renderWaiters.current;
    renderWaiters.current = [];
    for (const resolve of waiters) resolve();
  });
  useEffect(() => {
    const { api: latex } = agent.current;
    window.latex = latex;
    console.info('KhanhhNeLatex page API ready: call latex.help()');
    return () => { if (window.latex === latex) delete window.latex; };
  }, []);
  useEffect(() => {
    const keys = event => {
      if (actions.current.modal) return;
      if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key.toLowerCase() === 's')) {
        event.preventDefault();
        actions.current.compile();
      }
      if (event.key === 'Escape') { setAuth(null); setShowHelp(false); setSidebar(false); }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);

  return <div className="app">
    <div className="app-content" inert={auth || showHelp ? true : undefined}>
    {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    <input ref={fileInput} type="file" accept=".tex,text/plain,application/x-tex" hidden onChange={importFile} />
    {view === 'permalink' ? <main className="projects-main">
      <h1>{routeError ? 'Document unavailable' : 'Opening document...'}</h1>
      <p role="status">{routeError || 'Loading your private document.'}</p>
      {!user && routeError && <button className="account" onClick={() => setAuth('login')}>Sign in</button>}
      <button className="quiet" onClick={() => showProjects()}>Your projects</button>
    </main> : view === 'projects' ? <ProjectsView documents={unifiedDocuments} onOpen={openDocument}
      onNew={() => newDocument()}
      onImport={() => fileInput.current.click()} username={user?.username}
      onSignIn={() => user ? select(active.current) : setAuth('login')} onHelp={() => setShowHelp(true)} /> : <div className="workspace-view">
    <header className="topbar">
      <button className="icon projects-back" aria-label="Your projects" title="Your projects" onClick={() => showProjects()}><Icon name="back" /></button>
      <button className="icon mobile-menu" aria-label="Toggle documents" title="Toggle documents" aria-expanded={sidebar} aria-controls="document-sidebar" onClick={() => setSidebar(!sidebar)}><Icon name="panel" /></button>
      <a className="brand" href="/" aria-label="KhanhhNeLatex home"><span className="brand-mark">k</span><span className="brand-name">KhanhhNeLatex</span></a>
      <div className="top-actions">
        <button className="quiet" onClick={() => setShowHelp(true)}><Icon name="help" /><span>Help</span></button>
        {user ? <button className="account" aria-label={`Sign out ${user.username}`} title={`Sign out ${user.username}`} disabled={busy} onClick={async () => {
          try {
            await persist();
            await api('/logout', {});
            account.current = null;
            cloudRequest.current++;
            setUser(null);
            setCloud([]);
          }
          catch (reason) { notice(reason); }
        }}><Icon name="user" /><span className="account-name">{user.username}</span><span>Sign out</span></button> : <button className="account" onClick={() => setAuth('login')}><Icon name="user" />Sign in</button>}
      </div>
    </header>
    <div className="workspace" ref={sizing.workspace}>
      <aside id="document-sidebar" className={`sidebar ${sidebar ? 'open' : ''}`}>
        <div className="sidebar-heading"><span>Documents</span><Icon name="panel" /></div>
        <button className="new-document" onClick={() => newDocument()} disabled={busy}><Icon name="plus" /><span>New document</span></button>
        <nav className="document-list" aria-label="Documents">{unifiedDocuments.map(document => {
          const edited = new Date(document.updated_at);
          const hasEditedDate = Number.isFinite(edited.getTime());
          return <div className={`document-row ${document.localAvailable && current?.id === document.id ? 'selected' : ''}`} key={document.key}>
            <button className={`document-item ${document.localAvailable && current?.id === document.id ? 'selected' : ''}`}
              aria-label={document.title} title={document.title}
              aria-pressed={Boolean(document.localAvailable && current?.id === document.id)}
              onClick={() => openDocument(document)} disabled={busy}>
              <span className="document-name">{document.title}</span>
            </button>
            <div className="document-details">
              <DocumentAvailability localAvailable={document.localAvailable} cloudAvailable={document.cloudAvailable} />
              <time dateTime={hasEditedDate ? edited.toISOString() : undefined}
                title={hasEditedDate ? `Last edited ${edited.toLocaleString()}` : 'Last edited time unavailable'}>
                {hasEditedDate ? edited.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Date unavailable'}
              </time>
            </div>
          </div>;
        })}</nav>
        <div className="sidebar-bottom">
          <button className="import-button" onClick={() => fileInput.current.click()} disabled={busy}><Icon name="upload" /><span>Import .tex file</span></button>
          <button className="delete-button" onClick={remove} disabled={!current || busy}>Delete current document</button>
        </div>
      </aside>
      <div ref={sizing.sidebarHandle} className="pane-separator" role="separator" tabIndex={0}
        aria-label="Document sidebar width" aria-orientation="vertical" aria-controls="document-sidebar"
        title="Drag or use arrow keys to resize. Enter or double-click to reset." />
      <main className="main">
        <div className="document-toolbar">
          <div className="document-title"><span className="breadcrumb">Projects <span aria-hidden="true">/</span></span>
            <span className="document-title-field">
              <span className="document-title-measure" aria-hidden="true">{`${current?.title || ''} `}</span>
              <input ref={titleInput} key={`${current?.id || 'empty'}:${generation.current}`} defaultValue={current?.title || ''} aria-label="Document title" maxLength={100} disabled={!current || busy}
                onChange={event => update({ title: event.target.value })} onBlur={event => {
                  if (!active.current?.title.trim()) { event.target.value = 'Untitled paper'; update({ title: 'Untitled paper' }); }
                  persist().catch(() => {});
                }} />
            </span>
            <span className="save-state" role="status" aria-atomic="true"><i />{saveState}</span>
          </div>
          <div className="document-actions">
            <button className="quiet" disabled={!current} onClick={() => download(active.current.source, `${active.current.title || 'document'}.tex`, 'text/plain;charset=utf-8')}><Icon name="download" />Export .tex</button>
            <button className="save-button" disabled={!current || busy} onClick={sync}>{busy ? 'Saving...' : 'Save to account'}</button>
          </div>
        </div>
        <div className="mobile-tabs"><button className={tab === 'source' ? 'active' : ''} aria-pressed={tab === 'source'} aria-controls="source-panel" onClick={() => setTab('source')}>Source</button><button className={tab === 'preview' ? 'active' : ''} aria-pressed={tab === 'preview'} aria-controls="preview-panel" onClick={() => setTab('preview')}>PDF preview</button></div>
        <div className="panels" ref={sizing.panels}>
          <section id="source-panel" className={`editor-panel ${tab === 'source' ? 'mobile-active' : ''}`} aria-label="LaTeX source editor">
            <div className="panel-toolbar source-toolbar"><span className="source-file-tab"><Icon name="file" />main.tex</span><span className="tiny">LaTeX</span>
              <button className="compile-button source-compile" aria-label={compiling ? 'Cancel' : 'Compile'} disabled={!current} onClick={compiling ? cancelCompile : () => compile()}>{compiling ? 'Cancel' : 'Compile'}</button>
            </div>
            <div className="editor-container">
              <LatexEditor documentKey={`${current?.id || 'loading'}:${generation.current}`}
                value={current?.source || ''} loading={!current} apiRef={editorApi}
                onChange={(source, changes, before) => update({ source }, changes, before)}
                onSave={() => compile()} onCompile={() => compile()} />
            </div>
            <div className="editor-footer"><span>LaTeX <span className="footer-separator">·</span> UTF-8</span><span id="source-shortcuts">Tab indents; Shift+Tab leaves. Ctrl+Enter compiles.</span></div>
          </section>
          <div ref={sizing.splitHandle} className="pane-separator" role="separator" tabIndex={0}
            aria-label="Source editor width" aria-orientation="vertical" aria-controls="source-panel"
            title="Drag or use arrow keys to resize. Enter or double-click to reset." />
          <section id="preview-panel" className={`preview-panel ${tab === 'preview' ? 'mobile-active' : ''}`} aria-label="PDF preview">
            <div className="panel-toolbar preview-toolbar"><div className="preview-actions">
              <button className="compile-button" aria-label={compiling ? 'Cancel' : 'Compile'} aria-keyshortcuts="Control+Enter Meta+Enter" disabled={!current} onClick={compiling ? cancelCompile : () => compile()}>
                {compiling ? <span className="spinner" /> : <Icon name="refresh" />}{compiling ? 'Cancel' : 'Compile'}
              </button><span className="preview-title">PDF preview</span>
              <button className="quiet" disabled={!pdf} onClick={() => {
                const latest = generatedPdf.current;
                download(latest.bytes, `${latest.title || 'document'}.pdf`, 'application/pdf');
              }}><Icon name="download" /><span>Export PDF</span></button></div>
            </div>
            <div className="preview-status">
              <span className="preview-status-reserve" aria-hidden="true" />
              <div className="preview-status-message" role="status" aria-atomic="true"><span className={compiling ? 'working-dot' : 'status-dot'} /><span>{compileState}</span>{pendingPdf && <span> / Loading new preview...</span>}{pdf && stale && <strong> / Preview is out of date</strong>}</div>
            </div>
            <div className="pdf-area">{pdf ? <div className="pdf-stack">{[pdf, pendingPdf].filter(Boolean).map(viewer =>
              <PdfPreview key={viewer.url} viewer={viewer} pending={viewer.url !== pdf.url}
                viewState={previewView}
                onError={() => {
                  if (pendingViewer.current?.url !== viewer.url) return;
                  discardPendingViewer();
                  notice(new Error('The new PDF preview could not load. The previous preview is still available; export the new PDF or compile again.'));
                }}
                onReady={info => {
                  for (const item of [viewer, shownPdf.current, pendingViewer.current]) if (item?.url === viewer.url && info?.pages) item.pages = info.pages;
                  if (shownPdf.current?.url === viewer.url) emitPreview(shownPdf.current);
                  revealPreview(viewer.url);
                }} />)}</div> :
              <div className="empty-preview"><Icon name="file" />
                <h1>{compiling ? 'Preparing preview' : 'PDF preview'}</h1><p>{compiling ? 'Typesetting your document…' : 'Compile to see your document here.'}</p><button className="empty-compile" disabled={!current || compiling} onClick={() => compile()}><Icon name="refresh" />Compile your document</button></div>}
            </div>
            <div className="compile-log-slot"><details className="compile-log" open={compileState.includes('See compilation log.')}><summary>Compilation log</summary><pre>{log || 'No compilation log available.'}</pre></details></div>
            <div className="preview-footer"><span title={engineState}>{engineState}</span><label className="live-preview"><input type="checkbox" checked={live} onChange={event => toggleLive(event.target.checked)} /> Live preview</label><button className="quiet" onClick={() => setShowHelp(true)} aria-label="Supported LaTeX" title="Supported LaTeX"><Icon name="help" /></button></div>
          </section>
        </div>
      </main>
    </div>
    </div>}
    </div>
    {auth && <AuthDialog mode={auth} setMode={setAuth} onClose={() => setAuth(null)} onSuccess={async signedIn => {
      account.current = signedIn;
      setUser(signedIn); setAuth(null);
      try { await refreshCloud(signedIn); } catch (reason) { notice(reason); }
    }} />}
    {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
  </div>;
}

function useDialogFocus(ref, onClose, initial = 'button') {
  const previous = useRef(document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    dialog.querySelector(initial)?.focus();
    const trap = event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href]')].filter(control => control.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener('keydown', trap);
    return () => {
      dialog.removeEventListener('keydown', trap);
      if (previous.current?.isConnected) previous.current.focus();
    };
  }, []);
}

function HelpDialog({ onClose }) {
  const ref = useRef(null);
  useDialogFocus(ref, onClose);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><button className="modal-close" aria-label="Close help" onClick={onClose}><Icon name="close" /></button>
        <h2 id="help-title">Workspace help</h2>
        <p>Each document is one UTF-8 .tex file, up to 100,000 characters. Images, binary files and external source assets are not supported.</p>
        <p>The default bundled pdfTeX engine supports article, report, book, amsmath, amssymb, geometry and standard Computer Modern fonts. No shell escape, bibliography uploads, font uploads, or automatic package downloads. Full Unicode and every CTAN package are not supported.</p>
        <p>For Google Fonts, use <code>{String.raw`\usepackage{fontspec}\setmainfont[BoldFont={Roboto Bold}]{Roboto}`}</code> and <code>{String.raw`\newfontfamily\crimson{Crimson Pro}`}</code> (then <code>{String.raw`{\crimson Your text}`}</code>). Generic Google names and simple top-level literal font-name macros work. Options may precede or follow the family: UprightFont, BoldFont, ItalicFont, BoldItalicFont, and documented safe features such as Scale, Ligatures, Numbers and LetterSpace. Weight suffixes Thin through Black and Italic are supported. Conventional virtual filenames such as Roboto-Regular.ttf or CrimsonPro-Regular.ttf may use literal Path=fonts/; these resolve Google family/style names, not local files or guaranteed historical font versions. RawFeature supports signed kern, liga and clig switches. Other paths, URLs, computed/local/conditional macros and unlisted options are rejected. Native compilation includes basic xcolor/TikZ drawing and Hyperref support, not arbitrary optional libraries. See README for exact feature values and parser limits.</p>
        <p>Font declarations or loading fontspec lazily select local XeTeX and a local PDF converter. Fontspec without a declaration uses bundled native defaults and needs no Google requests. Only requested family/style names go to the metadata service; the browser downloads trusted Google TrueType fonts and embeds them locally. Source never leaves the browser for compilation. Each request is bounded to 10 seconds; at most 16 faces, 8 MiB per face and 24 MiB total. Device caches are bounded and optional. Missing families, styles or glyphs fail explicitly; no silent substitute PDF. Non-font documents keep the default compiler. See the <a href="https://fonts.google.com" target="_blank" rel="noreferrer">Google Fonts catalog and licenses</a>.</p>
        <p>The engine starts loading when you enter the workspace, and each opened document gets an initial preview. Enable Live preview for debounced updates after editing pauses; it starts off to avoid background CPU churn. Your choice is saved on this device. Compile manually with <kbd>Ctrl</kbd> + <kbd>Enter</kbd>. Two passes resolve cross-references. A new compile replaces the previous job; Cancel stops it immediately, and jobs time out after 60 seconds.</p>
        <p>Drafts save automatically on this device after a short pause. Use Save to account once to link a draft; subsequent edits save automatically after an 800 ms pause while signed in as its owner. <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>S</kbd> only forces a fresh compilation, even when source is unchanged. Cloud failures keep your device draft. Compilation timings measure typesetting, engine startup is shown separately, and cloud-save timings measure the full request round trip, not just database work. Export .tex for a portable backup. Device drafts are not encrypted; use your own device.</p>
        <p>First compilation fetches the pinned local engine and required bundled packages. Native-font compilation adds a 22.79 MB format, 3.07 MB XeTeX engine and 0.70 MB PDF converter on demand, plus fonts/packages. Browser caching can avoid repeat transfers. Active compilation can use more than 100 MB; XeTeX and the converter run sequentially and their workers are released after each job. Manual compilation keeps background CPU use low.</p>
        <h3 id="api-help-title">JavaScript API for agents</h3>
        <p>Scripts and AI agents can drive this page without screen scraping. In the browser console, call <code>latex.help()</code>. Methods use the same actions as the buttons, return plain data and Promises that settle when the action finishes, and never expose credentials. Account saves still require you to be signed in as the owner.</p>
        <pre className="api-example" aria-labelledby="api-help-title"><code>{`await latex.ready();
latex.list();                      // documents
await latex.open('Alpha paper');   // id, cloudId or title
latex.read({ from: 1, to: 10 });
latex.replace('Old', 'New', { all: true });
await latex.save();
const result = await latex.compile();
result.errors; latex.log(); latex.timings();`}</code></pre>
        <details className="api-help"><summary>All {API_METHODS.length} methods</summary><dl>{API_METHODS.map(method =>
          <div key={method.signature}><dt><code>latex.{method.signature}</code></dt><dd>{method.description} <code>{method.example}</code></dd></div>)}</dl></details>
        <a href="/compiler/NOTICE.txt" target="_blank" rel="noreferrer">Compiler credits and source ↗</a>
      </section>
    </div>;
}

function AuthDialog({ mode, setMode, onClose, onSuccess }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useDialogFocus(ref, () => { if (!busy) onClose(); }, 'input');
  return <div className="modal-backdrop"><section ref={ref} className="modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
    <button className="modal-close" disabled={busy} aria-label="Close sign in" onClick={onClose}><Icon name="close" /></button>
    <span className="brand-mark">k</span><h2 id="auth-title">{mode === 'register' ? 'Create an account' : 'Sign in'}</h2><p>Sync your documents across devices. Local editing does not require an account.</p>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      const data = new FormData(event.currentTarget);
      try { const result = await api(`/${mode}`, Object.fromEntries(data)); await onSuccess(result.user); }
      catch (reason) { setError(reason.message); }
      finally { setBusy(false); }
    }}>
      <label>Username<input name="username" autoFocus required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_-]+" autoComplete="username" disabled={busy} /></label>
      <label>Password<input name="password" type="password" required minLength={8} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} disabled={busy} /></label>
      <small>3-32 character username. Password: 8-128 characters.</small>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="compile-button" disabled={busy}>{busy ? 'Please wait...' : mode === 'register' ? 'Create account' : 'Sign in'}</button>
    </form>
    <button className="auth-switch" disabled={busy} onClick={() => { setError(''); setMode(mode === 'register' ? 'login' : 'register'); }}>{mode === 'register' ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
  </section></div>;
}

createRoot(document.getElementById('root')).render(<App />);
