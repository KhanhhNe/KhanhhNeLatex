import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LatexCompiler } from './compiler.js';
import { api, drafts, download, readTex } from './storage.js';
import LatexEditor from './components/LatexEditor.jsx';
import ProjectsView from './components/ProjectsView.jsx';
import DocumentAvailability from './components/DocumentAvailability.jsx';
import Icon from './components/Icon.jsx';
import PdfPreview from './components/PdfPreview.jsx';
import ShareDialog from './components/ShareDialog.jsx';
import SharedDocument from './components/SharedDocument.jsx';
import useWorkspaceResize from './components/workspace-resize.js';
import { mergeDocuments } from './document-list.js';
import { documentPath, documentRoute, newDocumentCode, validDocumentCode } from './document-url.js';
import { API_METHODS, createAgentApi } from './agent-api.js';
import { createText, editText, encodeState, mergeText } from './crdt.js';
import { starter, starterTitle, skipDefault } from './starter.js';
import { DocumentQueue } from './document-queue.js';
import './style.css';

const makeDraft = (source = starter, title = starterTitle, defaultDocument = false) => ({
  id: crypto.randomUUID(), code: newDocumentCode(), title, source, updated_at: Date.now(), cloudId: null, revision: null, owner: null, dirty: true,
  defaultDocument,
});
const elapsed = milliseconds => milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
function samePdf(first, second) {
  const a = new Uint8Array(first), b = new Uint8Array(second);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function App() {
  const [documents, renderDocuments] = useState([]);
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
  function setDocuments(value) {
    localDocuments.current = typeof value === 'function' ? value(localDocuments.current) : value;
    renderDocuments(localDocuments.current);
  }
  const visibleView = useRef(view);
  visibleView.current = view;
  const [desktopSidebarHidden, setDesktopSidebarHidden] = useState(() => {
    try { return localStorage.getItem('workspace-sidebar-hidden-v1') === 'true'; }
    catch (reason) { console.warn('Sidebar preference could not be read.', reason.name); return false; }
  });
  const sizing = useWorkspaceResize(view === 'workspace', desktopSidebarHidden);
  const [auth, setAuth] = useState(null);
  const [compiling, setCompiling] = useState(false);
  const [compileState, setCompileState] = useState('Ready when you are');
  const [log, setLog] = useState('');
  const [pdf, setPdf] = useState(null);
  const [pendingPdf, setPendingPdf] = useState(null);
  const [stale, setStale] = useState(false);
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 1050px)').matches);
  const [tab, setTab] = useState('preview');
  const [editorOpened, setEditorOpened] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [live, setLive] = useState(false);
  const [engineState, setEngineState] = useState('Preparing browser engine...');
  const [menu, setMenu] = useState(false);
  const [chromeHidden, setChromeHidden] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [logShown, setLogShown] = useState(false);
  const menuDialog = useRef(null);
  const moreButton = useRef(null);
  const previewPanel = useRef(null);
  const compileLog = useRef(null);
  const sidebarElement = useRef(null);
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
  const cloudQueue = useRef(new DocumentQueue());
  const deletions = useRef(new Map());
  const [documentWork, setDocumentWork] = useState(new Map());
  const [syncError, setSyncError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const account = useRef(null);
  const cloudRequest = useRef(0);
  const cloudMetadata = useRef(new Map());
  const cloudAttempts = useRef(new Map());
  const cloudCompleted = useRef(new Map());
  const textReplica = useRef(null);
  const localLoaded = useRef(Promise.resolve());
  const reconciliation = useRef(Promise.resolve());
  const discardedDefaults = useRef(new Set());
  const draftChannel = useRef(null);
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
  useEffect(() => {
    const query = matchMedia('(max-width: 1050px)');
    const changed = () => {
      setMobile(query.matches);
      setEditorOpened(true);
      if (query.matches) setTab('preview');
    };
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
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
    if (discardedDefaults.current.has(document.id)) return;
    if (deletions.current.get(document.id)?.status === 'deleted') return null;
    if (document === active.current) clearTimeout(timer.current);
    if (persisted.current.has(document)) return;
    if (document === active.current) pending.current = true;
    const started = performance.now();
    try {
      const snapshot = materialize(document);
      const work = saving.current.catch(() => {}).then(() => discardedDefaults.current.has(snapshot.id) ? undefined : drafts.put(snapshot));
      saving.current = work;
      let saved = await work;
      if (!saved || discardedDefaults.current.has(document.id)) return;
      if (deletions.current.get(document.id)?.status === 'deleted') return null;
      localSaveMs.current = performance.now() - started;
      emit('save', { documentId: document.id, local: true, cloud: false });
      let raced = false;
      if (active.current?.id === document.id) {
        const latest = active.current;
        const merged = mergeText(saved, materialize(latest));
        raced = merged.crdt_state !== saved.crdt_state || latest.title !== saved.title;
        saved = { ...saved, ...latest, ...merged, owner: saved.owner || latest.owner,
          cloudId: saved.cloudId || latest.cloudId,
          revision: saved.revision ?? latest.revision, dirty: raced || saved.dirty || latest.dirty };
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
    } while (active.current && deletions.current.get(active.current.id)?.status !== 'deleted' && !persisted.current.has(active.current));
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
    if (!document || deletions.current.get(document.id)?.status === 'deleted') return;
    const selection = ++selectionRequest.current;
    if (!force && document.id === active.current?.id) {
      scheduleCloud(active.current);
      showWorkspace(active.current, navigation);
      setTab('preview');
      setSidebar(false);
      if (!shownPdf.current && !compiler.current.active) compile({ reveal: false });
      return;
    }
    try {
      await flush();
      if (selection !== selectionRequest.current || deletions.current.get(document.id)?.status === 'deleted') return;
      showWorkspace(document, navigation);
      setTab('preview');
      clearTimeout(liveTimer.current);
      discardPendingViewer();
      compileRequest.current++;
      compiler.current.cancel();
      setCompiling(false);
      generation.current++;
      setEditorOpened(false);
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
    try { await flush(); }
    catch (reason) { notice(reason); return; }
    const document = makeDraft(source, title);
    document.code = newDocumentCode(new Set(localDocuments.current.map(item => item.code)));
    // Persist each creation even if another click supersedes its selection.
    setDocuments(list => [document, ...list]);
    cloudSnapshots.current.set(document.id, document);
    const stored = persist(document);
    try { await select(document); }
    catch (reason) { notice(reason); }
    await stored;
    scheduleCloud(cloudSnapshots.current.get(document.id) || document);
    return cloudSnapshots.current.get(document.id) || document;
  }
  function refreshCloud(owner = account.current, reconcile = true) {
    const work = loadCloud(owner, reconcile);
    if (reconcile) reconciliation.current = work;
    return work;
  }
  async function loadCloud(owner, reconcile) {
    if (!owner) { cloudRequest.current++; setCloud([]); return; }
    const request = ++cloudRequest.current;
    const data = await api('/documents');
    if (request !== cloudRequest.current || account.current?.id !== owner.id) return;
    cloudMetadata.current = new Map(data.documents.map(document => [document.id, document]));
    setCloud(data.documents.filter(document => ![...deletions.current.values()]
      .some(item => item.status === 'deleted' && item.code === document.code)));
    if (reconcile) {
      await localLoaded.current;
      await flush();
      const list = await drafts.all();
      if (account.current?.id !== owner.id) return;
      for (let document of list) {
        document = active.current?.id === document.id ? materialize(active.current) : document;
        if (deletions.current.has(document.id)) continue;
        if (document.owner && document.owner !== owner.id) continue;
        if (skipDefault(document, data.documents)) {
          const route = documentRoute(location.pathname);
          const replaceActive = active.current?.id === document.id && (!route || route.code === document.code);
          const replacement = replaceActive
            ? (await api(`/documents/${data.documents[0].id}`)).document : null;
          if (account.current?.id !== owner.id) return;
          const removed = await drafts.discardDefault(document.id, data.documents, () =>
            active.current?.id === document.id ? materialize(active.current) : document);
          const latest = active.current?.id === document.id ? materialize(active.current) : document;
          if (removed && !skipDefault(latest, data.documents)) await persist(latest);
          else if (removed) {
            discardedDefaults.current.add(document.id);
            clearTimeout(cloudTimers.current.get(document.id));
            cloudTimers.current.delete(document.id);
            cloudSnapshots.current.delete(document.id);
            setDocuments(items => items.filter(item => item.id !== document.id));
            if (active.current?.id === document.id) {
              clearTimeout(timer.current);
              active.current = null;
              setCurrent(null);
              pending.current = false;
              if (replaceActive) await openCloud(data.documents[0], replacement);
            }
            continue;
          }
          document = latest;
        }
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
      const document = list.sort((a, b) => b.updated_at - a.updated_at)[0] || makeDraft(undefined, undefined, true);
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
        setDocuments(list.filter(item => deletions.current.get(item.id)?.status !== 'deleted'));
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
      compiler.current.dispose();
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
      await reconciliation.current;
      if (!stillCurrent()) return;
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
    if (!document || deletions.current.has(document.id)) return;
    cloudSnapshots.current.set(document.id, document);
    clearTimeout(cloudTimers.current.get(document.id));
    if (!navigator.onLine || !account.current || (document.owner && document.owner !== account.current.id)) return;
    cloudTimers.current.set(document.id, setTimeout(() => {
      cloudTimers.current.delete(document.id);
      sync({ snapshot: cloudSnapshots.current.get(document.id), automatic: true });
    }, 800));
  }
  async function sync({ snapshot = active.current, automatic = false } = {}) {
    try {
      let work;
      do { work = reconciliation.current; await work; } while (work !== reconciliation.current);
    }
    catch (reason) { notice(reason); return { ok: false, error: reason.message }; }
    if (snapshot && discardedDefaults.current.has(snapshot.id))
      return { ok: true, skipped: true, documentId: snapshot.id };
    if (!snapshot) return { ok: false, error: 'No document is open.' };
    if (deletions.current.has(snapshot.id)) return { ok: false, error: 'This document has a pending deletion.' };
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
    cloudSnapshots.current.set(snapshot.id, snapshot);
    setDocumentWork(work => new Map(work).set(snapshot.id, 'Saving...'));
    const version = cloudCompleted.current.get(snapshot.id)?.version || 0;
    return cloudQueue.current.run(snapshot.id, () => syncDocument(snapshot.id, owner, version));
  }
  async function syncDocument(id, owner, version) {
    let snapshot = cloudSnapshots.current.get(id);
    if (!snapshot || deletions.current.has(id)) return { ok: true, deleted: true };
    let outcome;
    let localSaved = false;
    setDocumentWork(work => new Map(work).set(id, 'Saving...'));
    try {
      if (account.current?.id !== owner.id) throw new Error('The signed-in account changed. Retry synchronization.');
      const completed = cloudCompleted.current.get(id);
      if (completed && completed.version !== version && !snapshot.dirty) return completed.outcome;
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
      if (account.current?.id !== owner.id) return { ok: false, error: 'The signed-in account changed. Retry synchronization.' };
      localSaved = true;
      if (active.current?.id === snapshot.id) setSaveState('Saving to your account...');
      const started = performance.now();
      cloudAttempts.current.set(id, owner.id);
      const { document: saved } = await api('/documents/sync', {
        code: snapshot.code, title: snapshot.title || 'Untitled paper',
        source: snapshot.source, crdt_state: snapshot.crdt_state,
      });
      if (!validDocumentCode(saved.code) || saved.code !== snapshot.code)
        throw new Error('The account response has a different document identity. Your device draft is kept.');
      cloudAttempts.current.delete(id);
      const roundTripMs = performance.now() - started;
      cloudTimings.current.set(snapshot.id, roundTripMs);
      const latest = active.current?.id === snapshot.id ? active.current : cloudSnapshots.current.get(snapshot.id);
      const merged = mergeText(materialize(latest || snapshot), saved);
      const next = { ...(latest || snapshot), ...merged, cloudId: saved.id, owner: owner.id, revision: saved.revision,
        dirty: merged.crdt_state !== saved.crdt_state };
      cloudSnapshots.current.set(next.id, next);
      if (active.current?.id === next.id && account.current?.id === owner.id) {
        activate(next);
        if (visibleView.current === 'workspace') showWorkspace(next, 'replace');
      }
      await persist(next);
      const pendingNext = cloudSnapshots.current.get(id) || next;
      const metadata = { id: saved.id, code: saved.code, title: saved.title, revision: saved.revision, updated_at: saved.updated_at };
      cloudMetadata.current.set(saved.id, metadata);
      if (account.current?.id === owner.id)
        setCloud(list => [metadata, ...list.filter(item => item.id !== saved.id)]);
      if (pendingNext.dirty && account.current?.id === owner.id) scheduleCloud(pendingNext);
      else {
        clearTimeout(cloudTimers.current.get(next.id));
        cloudTimers.current.delete(next.id);
      }
      outcome = { ok: true, documentId: next.id, cloudId: next.cloudId, revision: next.revision, roundTripMs, dirty: pendingNext.dirty };
      cloudCompleted.current.set(id, { version: (completed?.version || 0) + 1, outcome });
      emit('save', { ...outcome, local: true, cloud: true });
    } catch (reason) {
      setSyncError(`Account sync paused: ${reason.message}`);
      lastError.current = reason.message;
      emit('error', { message: reason.message });
      if (localSaved && active.current?.id === snapshot.id) setSaveState('Cloud save failed - device draft kept');
      outcome = { ok: false, documentId: snapshot.id, error: reason instanceof Error ? reason.message : String(reason) };
    } finally {
      setDocumentWork(work => {
        const next = new Map(work);
        if (!deletions.current.has(id)) next.delete(id);
        return next;
      });
    }
    return outcome;
  }
  async function openCloud(item, fetched = null) {
    const request = ++selectionRequest.current;
    const owner = account.current?.id;
    try {
      const document = fetched || (await api(`/documents/${item.id}`)).document;
      if (request !== selectionRequest.current || account.current?.id !== owner) return;
      if ([...deletions.current.values()].some(item => item.status === 'deleted' && item.code === document.code)) return;
      const eligible = doc => (!doc.owner || doc.owner === account.current?.id)
        && (doc.code === document.code || doc.cloudId === item.id);
      const local = active.current && eligible(active.current) ? active.current : localDocuments.current.find(eligible);
      const merged = local ? mergeText(adoptCode(materialize(local), document.code), document) : materialize(document);
      const next = { ...document, ...merged, id: local?.id || crypto.randomUUID(), updated_at: document.updated_at ?? Date.now(),
        cloudId: document.id, owner, dirty: Boolean(local?.dirty) };
      await select(next, true);
    } catch (reason) { notice(reason); }
  }
  async function remove({ confirmed = false, snapshot = active.current } = {}) {
    if (!snapshot) return false;
    const previous = deletions.current.get(snapshot.id);
    if (previous?.status === 'pending') return previous.promise;
    if (previous?.status === 'deleted') return true;
    if (!(confirmed === true || window.confirm(`Delete "${snapshot.title}"${snapshot.cloudId ? ' from this device and your account' : ''}? This cannot be undone.`))) return false;
    const deletion = { code: snapshot.code, status: 'pending' };
    deletions.current.set(snapshot.id, deletion);
    setDocumentWork(work => new Map(work).set(snapshot.id, 'Deleting...'));
    clearTimeout(cloudTimers.current.get(snapshot.id));
    cloudTimers.current.delete(snapshot.id);
    deletion.promise = cloudQueue.current.run(snapshot.id, async () => {
      try {
        await saving.current.catch(() => {});
        let latest = cloudSnapshots.current.get(snapshot.id) || snapshot;
        await persist(active.current?.id === snapshot.id ? active.current : latest);
        const attemptedOwner = cloudAttempts.current.get(snapshot.id);
        if (!latest.cloudId && attemptedOwner) {
          if (account.current?.id !== attemptedOwner)
            throw new Error('Sign in to the document owner account, then retry deletion.');
          // A failed response may still have created the account document.
          try {
            const { document } = await api(`/documents/by-code/${latest.code}`);
            latest = { ...latest, cloudId: document.id, owner: attemptedOwner };
          } catch (reason) { if (reason.status !== 404) throw reason; }
        }
        if (latest.cloudId) {
          if (latest.owner !== account.current?.id)
            throw new Error('Sign in to the document owner account, then retry deletion.');
          try { await api(`/documents/${latest.cloudId}`, undefined, 'DELETE'); }
          catch (reason) { if (reason.status !== 404) throw reason; }
        }
        // Only remove the draft after the account confirms; late local writes cannot restore it.
        deletion.status = 'deleted';
        if (active.current?.id === snapshot.id) clearTimeout(timer.current);
        await saving.current.catch(() => {});
        await drafts.delete(snapshot.id);
        cloudSnapshots.current.delete(snapshot.id);
        cloudTimings.current.delete(snapshot.id);
        cloudAttempts.current.delete(snapshot.id);
        cloudCompleted.current.delete(snapshot.id);
        const list = localDocuments.current.filter(doc => doc.id !== snapshot.id);
        setDocuments(list);
        setCloud(items => items.filter(item => item.id !== latest.cloudId));
        if (active.current?.id === snapshot.id) {
          pending.current = false;
          active.current = null;
          const next = list[0] || makeDraft();
          if (!list.length) setDocuments([next]);
          await select(next, true, 'replace');
        }
        setDocumentWork(work => { const next = new Map(work); next.delete(snapshot.id); return next; });
        draftChannel.current?.postMessage({ id: snapshot.id });
        return { ok: true, deleted: true };
      } catch (reason) {
        deletion.status = 'failed';
        lastError.current = reason.message;
        emit('error', { message: reason.message });
        setSyncError(`Account deletion paused: ${reason.message}`);
        setDocumentWork(work => new Map(work).set(snapshot.id, `Delete failed: ${reason.message}`));
        return { ok: false, error: reason.message };
      }
    }).then(result => result.ok);
    return deletion.promise;
  }
  async function retrySync() {
    setRetrying(true);
    setSyncError('');
    try {
      const failed = [...deletions.current.entries()].filter(([, item]) => item.status === 'failed');
      await Promise.all(failed.map(([id]) => remove({ confirmed: true, snapshot: localDocuments.current.find(item => item.id === id) })));
      await refreshCloud();
    }
    catch (reason) { setSyncError(`Account sync paused: ${reason.message}`); }
    finally { setRetrying(false); }
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
  const unifiedDocuments = mergeDocuments(documents, cloud, user?.id).map(document => ({
    ...document, operation: documentWork.get(document.id), deleteFailed: deletions.current.get(document.id)?.status === 'failed',
  }));
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
    state: () => ({ view, tab, user, saveState, compileState, engineState, live, busy: false, error: error || syncError, log }),
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
    remove: item => {
      lastError.current = '';
      return remove({ confirmed: true, snapshot: localDocuments.current.find(document => document.id === item.id) });
    },
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
      if (panel === 'source') setEditorOpened(true);
      if (panel === 'workspace') setTab('preview');
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
      if (actions.current.modal || event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
        (event.key === 'Enter' || event.key.toLowerCase() === 's')) {
        event.preventDefault();
        actions.current.compile();
      }
      if (event.key === 'Escape') { setAuth(null); setShowHelp(false); setSidebar(false); }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
  const previewSettled = Boolean(pdf) && !stale && !compiling && !pendingPdf && compileState.startsWith('Compiled in your browser');
  const showPreviewBar = !mobile || !previewSettled || logShown;
  const immersive = mobile && view === 'workspace' && tab === 'preview' && Boolean(pdf) && !menu && !sidebar;
  useEffect(() => { if (!immersive) setChromeHidden(false); }, [immersive]);
  useEffect(() => { setChromeHidden(false); }, [compileState, stale]);
  useEffect(() => { if (compiling) setLogShown(false); }, [compiling]);
  useEffect(() => {
    // Passive observers only: the PDF viewer owns scrolling, panning and momentum.
    const panel = previewPanel.current;
    if (!panel || !immersive) return;
    let anchor = null, tap = null;
    const scroller = target => target instanceof Element ? target.closest('.pdf-viewer:not(.pending) .pdf-viewport') : null;
    const scroll = event => {
      if (scroller(event.target) !== event.target) return;
      const top = event.target.scrollTop;
      if (top <= 24) { anchor = top; setChromeHidden(false); return; }
      if (anchor === null) { anchor = top; return; }
      if (Math.abs(top - anchor) < 12) return;
      setChromeHidden(top > anchor);
      anchor = top;
    };
    const down = event => {
      tap = event.isPrimary && scroller(event.target) ? { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp } : null;
    };
    const up = event => {
      if (tap?.id === event.pointerId && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 10 && event.timeStamp - tap.time < 350)
        setChromeHidden(hidden => !hidden);
      tap = null;
    };
    const cancel = () => { tap = null; };
    const options = { capture: true, passive: true };
    panel.addEventListener('scroll', scroll, options);
    panel.addEventListener('pointerdown', down, options);
    panel.addEventListener('pointerup', up, options);
    panel.addEventListener('pointercancel', cancel, options);
    return () => {
      panel.removeEventListener('scroll', scroll, options);
      panel.removeEventListener('pointerdown', down, options);
      panel.removeEventListener('pointerup', up, options);
      panel.removeEventListener('pointercancel', cancel, options);
    };
  }, [immersive]);
  useEffect(() => {
    const dialog = menuDialog.current;
    if (!dialog) return;
    if (menu && !dialog.open) dialog.showModal();
    if (!menu && dialog.open) dialog.close();
  }, [menu]);
  useEffect(() => { if (!mobile) { setMenu(false); setSidebar(false); } }, [mobile]);
  const sidebarWasOpen = useRef(false);
  useEffect(() => {
    if (mobile && sidebar) sidebarElement.current?.querySelector('button:not(:disabled)')?.focus();
    else if (mobile && sidebarWasOpen.current) moreButton.current?.focus();
    sidebarWasOpen.current = sidebar;
  }, [sidebar, mobile]);
  useEffect(() => {
    if (!logShown || !compileLog.current) return;
    compileLog.current.open = true;
    compileLog.current.querySelector('summary')?.focus();
  }, [logShown]);
  function fromMenu(action) {
    return () => {
      if (menuDialog.current?.open) menuDialog.current.close();
      setMenu(false);
      moreButton.current?.focus();
      action();
    };
  }
  async function copyPrivateLink() {
    try {
      await navigator.clipboard.writeText(new URL(documentPath(active.current), location.origin).href);
      setLinkCopied(true);
    } catch {
      notice(new Error('Could not copy the private link. Check browser clipboard permissions and copy the address manually.'));
    }
  }
  async function signOut() {
    try {
      await persist();
      await api('/logout', {});
      account.current = null;
      cloudRequest.current++;
      setUser(null);
      setCloud([]);
    }
    catch (reason) { notice(reason); }
  }
  const exportTex = () => download(active.current.source, `${active.current.title || 'document'}.tex`, 'text/plain;charset=utf-8');
  const exportPdf = () => {
    const latest = generatedPdf.current;
    download(latest.bytes, `${latest.title || 'document'}.pdf`, 'application/pdf');
  };
  const previewStatus = <div className="preview-status">
    <span className="preview-status-reserve" aria-hidden="true" />
    <div className="preview-status-message" role="status" aria-atomic="true"><span className={compiling ? 'working-dot' : 'status-dot'} /><span>{compileState}</span>{pendingPdf && <span> / Loading new preview...</span>}{pdf && stale && <strong> / Preview is out of date</strong>}</div>
  </div>;

  return <div className="app">
    <div className="app-content" inert={auth || showHelp ? true : undefined}>
    {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {syncError && <div className="error-banner" role="status">{syncError}<button onClick={retrySync} disabled={retrying}>{retrying ? 'Retrying...' : 'Retry sync'}</button><button onClick={() => setSyncError('')} aria-label="Dismiss sync message">×</button></div>}
    <input ref={fileInput} type="file" accept=".tex,text/plain,application/x-tex" hidden onChange={importFile} />
    {view === 'permalink' ? <main className="projects-main">
      <h1>{routeError ? 'Document unavailable' : 'Opening document...'}</h1>
      <p role="status">{routeError || 'Loading your private document.'}</p>
      {!user && routeError && <button className="account" onClick={() => setAuth('login')}>Sign in</button>}
      <button className="quiet" onClick={() => showProjects()}>Your projects</button>
    </main> : view === 'projects' ? <ProjectsView documents={unifiedDocuments} onOpen={openDocument}
      onNew={() => newDocument()}
      onRetryDelete={document => remove({ confirmed: true, snapshot: document })}
      onImport={() => fileInput.current.click()} username={user?.username}
      onSignIn={() => user ? select(active.current) : setAuth('login')} onHelp={() => setShowHelp(true)} /> : <div className={`workspace-view ${tab === 'source' ? 'editing' : 'reading'}${chromeHidden ? ' chrome-hidden' : ''}`}>
    {!mobile && <header className="topbar">
      <button className="icon projects-back" aria-label="Your projects" title="Your projects" onClick={() => showProjects()}><Icon name="back" /></button>
      <button className="icon desktop-sidebar-toggle" aria-label="Toggle documents" title={desktopSidebarHidden ? 'Show documents' : 'Hide documents'} aria-expanded={!desktopSidebarHidden} aria-controls="document-sidebar" onClick={() => {
        const hidden = !desktopSidebarHidden;
        setDesktopSidebarHidden(hidden);
        try { localStorage.setItem('workspace-sidebar-hidden-v1', String(hidden)); }
        catch (reason) { console.warn('Sidebar preference could not be saved.', reason.name); }
      }}><Icon name="panel" /></button>
      <a className="brand" href="/" aria-label="KhanhhNeLatex home"><span className="brand-mark">k</span><span className="brand-name">KhanhhNeLatex</span></a>
      <div className="top-actions">
        <button className="quiet header-help" aria-label="Help" title="Help" onClick={() => setShowHelp(true)}><Icon name="help" /></button>
        {user ? <button className="account" aria-label={`Sign out ${user.username}`} title={`Sign out ${user.username}`} onClick={signOut}><Icon name="user" /><span className="account-name">{user.username}</span><span>Sign out</span></button> : <button className="account" onClick={() => setAuth('login')}><Icon name="user" />Sign in</button>}
      </div>
    </header>}
    <div className={`workspace ${desktopSidebarHidden ? 'sidebar-hidden' : ''}`} ref={sizing.workspace}>
      <aside id="document-sidebar" ref={sidebarElement} className={`sidebar ${sidebar ? 'open' : ''}`} aria-label={mobile ? 'Documents' : undefined}>
        <div className="sidebar-heading"><span>Documents</span>{mobile ? <button className="sidebar-close" aria-label="Close documents" title="Close documents" onClick={() => setSidebar(false)}><Icon name="close" /></button> : <Icon name="panel" />}</div>
        <button className="new-document" onClick={() => newDocument()}><Icon name="plus" /><span>New document</span></button>
        <nav className="document-list" aria-label="Documents">{unifiedDocuments.map(document => {
          const edited = new Date(document.updated_at);
          const hasEditedDate = Number.isFinite(edited.getTime());
          return <div className={`document-row ${document.localAvailable && current?.id === document.id ? 'selected' : ''}`} key={document.key}>
            <button className={`document-item ${document.localAvailable && current?.id === document.id ? 'selected' : ''}`}
              aria-label={document.title} title={document.title}
              aria-pressed={Boolean(document.localAvailable && current?.id === document.id)}
              onClick={() => openDocument(document)}>
              <span className="document-name">{document.title}</span>
            </button>
            <div className="document-details">
              <DocumentAvailability localAvailable={document.localAvailable} cloudAvailable={document.cloudAvailable} />
              <time dateTime={hasEditedDate ? edited.toISOString() : undefined}
                title={hasEditedDate ? `Last edited ${edited.toLocaleString()}` : 'Last edited time unavailable'}>
                {hasEditedDate ? edited.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Date unavailable'}
              </time>
            </div>
            {document.operation && <div className="document-operation"><span role="status">{document.operation}</span>
              {document.deleteFailed && <button onClick={() => remove({ confirmed: true, snapshot: document })}>Retry delete</button>}
            </div>}
          </div>;
        })}</nav>
        <div className="sidebar-bottom">
          <button className="import-button" onClick={() => fileInput.current.click()}><Icon name="upload" /><span>Import .tex file</span></button>
          <button className="delete-button" onClick={remove} disabled={!current || deletions.current.get(current.id)?.status === 'pending'}>Delete current document</button>
        </div>
      </aside>
      {mobile && sidebar && <div className="drawer-backdrop" aria-hidden="true" onClick={() => setSidebar(false)} />}
      <div ref={sizing.sidebarHandle} className="pane-separator sidebar-handle" role="separator" tabIndex={0}
        aria-label="Document sidebar width" aria-orientation="vertical" aria-controls="document-sidebar"
        title="Drag or use arrow keys to resize. Enter or double-click to reset." />
      <main className="main" inert={mobile && sidebar ? true : undefined}>
        <div className="document-toolbar" onFocus={() => setChromeHidden(false)}>
          {mobile && <button className="icon projects-back" aria-label="Your projects" title="Your projects" onClick={() => showProjects()}><Icon name="back" /></button>}
          <div className="document-title">
            <span className="document-title-field">
              <span className="document-title-measure" aria-hidden="true">{`${current?.title || ''} `}</span>
              <input ref={titleInput} key={`${current?.id || 'empty'}:${generation.current}`} defaultValue={current?.title || ''} aria-label="Document title" maxLength={100} disabled={!current} readOnly={mobile && tab === 'preview'}
                onChange={event => update({ title: event.target.value })} onBlur={event => {
                  if (!active.current?.title.trim()) { event.target.value = 'Untitled paper'; update({ title: 'Untitled paper' }); }
                  persist().catch(() => {});
                }} />
            </span>
            <span className="save-state" role="status" aria-atomic="true" title={saveState}><i /><span className="save-text">{saveState}</span></span>
          </div>
          <div className="mobile-tabs" role="group" aria-label="Document mode">
            <button className={tab === 'preview' ? 'active' : ''} aria-pressed={tab === 'preview'} aria-controls="preview-panel" onClick={() => setTab('preview')}>Read</button>
            <button className={tab === 'source' ? 'active' : ''} aria-pressed={tab === 'source'} aria-controls="source-panel" onClick={() => { setEditorOpened(true); setTab('source'); }}>Edit</button>
          </div>
          <div className="document-actions">
            <button className="compile-button" aria-label={compiling ? 'Cancel' : 'Compile'} title={compiling ? 'Cancel compilation' : 'Compile (Ctrl/Cmd+Enter)'} aria-keyshortcuts="Control+Enter Meta+Enter" disabled={!current} onClick={compiling ? cancelCompile : () => compile()}>
              {compiling ? <span className="spinner" /> : <Icon name="refresh" />}<span className="action-label">{compiling ? 'Cancel' : mobile && tab === 'source' ? 'Compile & read' : 'Compile'}</span>
            </button>
            {!mobile && <>
              <button className="quiet" aria-label="Export .tex" title="Export .tex" disabled={!current} onClick={exportTex}><Icon name="download" /><span>.tex</span></button>
              <button className="quiet" aria-label="Export PDF" title="Export PDF" disabled={!pdf} onClick={exportPdf}><Icon name="download" /><span>PDF</span></button>
              <button className="save-button" aria-label="Save to account" title="Save to account" disabled={!current} onClick={sync}><Icon name="cloud" /><span className="action-label">Save</span></button>
              <button className="quiet" disabled={!current} onClick={() => setSharing(true)}>Share</button>
              {desktopSidebarHidden && <>
                <button className="quiet" aria-label="More document actions" title="More document actions" popoverTarget="document-overflow"><Icon name="more" /></button>
                <div id="document-overflow" className="document-overflow" popover="auto" role="group" aria-label="Document actions" onToggle={event => {
                  if (event.nativeEvent.newState !== 'open') return;
                  const menu = event.currentTarget;
                  const trigger = menu.previousElementSibling.getBoundingClientRect();
                  menu.style.top = `${Math.max(8, Math.min(trigger.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
                }} onClick={event => {
                  if (event.target.closest('button')) event.currentTarget.hidePopover();
                }}>
                  <button onClick={() => newDocument()}><Icon name="plus" />New document</button>
                  <button onClick={() => fileInput.current.click()}><Icon name="upload" />Import .tex file</button>
                  <button className="delete-button" disabled={!current || deletions.current.get(current.id)?.status === 'pending'} onClick={remove}>Delete current document</button>
                </div>
              </>}
            </>}
            {mobile && <button ref={moreButton} className="more-button" aria-label="More actions" title="More actions" aria-haspopup="dialog" aria-expanded={menu} aria-controls="workspace-menu" onClick={() => { setLinkCopied(false); setMenu(true); }}><Icon name="more" /></button>}
          </div>
        </div>
        {mobile && chromeHidden && <button className="show-controls" aria-label="Show reading controls" title="Show controls" onClick={() => setChromeHidden(false)}><Icon name="eye" /></button>}
        <div className="panels" ref={sizing.panels}>
          <section id="source-panel" className={`editor-panel ${tab === 'source' ? 'mobile-active' : ''}`} aria-label="LaTeX source editor">
            <div className="editor-container">
              {(!mobile || editorOpened) && <LatexEditor documentKey={`${current?.id || 'loading'}:${generation.current}`}
                value={current?.source || ''} loading={!current} apiRef={editorApi}
                onChange={(source, changes, before) => update({ source }, changes, before)}
                onSave={() => compile()} onCompile={() => compile()} />}
            </div>
            {!mobile && <div className="editor-footer"><span>main.tex <span className="footer-separator">·</span> LaTeX <span className="footer-separator">·</span> UTF-8</span><span id="source-shortcuts">F1 commands; Tab/Shift+Tab indent/outdent. Ctrl/Cmd+S compiles.</span></div>}
          </section>
          <div ref={sizing.splitHandle} className="pane-separator" role="separator" tabIndex={0}
            aria-label="Source editor width" aria-orientation="vertical" aria-controls="source-panel"
            title="Drag or use arrow keys to resize. Enter or double-click to reset." />
          <section id="preview-panel" ref={previewPanel} className={`preview-panel ${tab === 'preview' ? 'mobile-active' : ''}`} aria-label="PDF preview"
            onFocus={event => { if (event.target.closest('.pdf-zoom-toolbar')) setChromeHidden(false); }}>
            {!mobile && previewStatus}
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
            <div className="preview-bottom" hidden={!showPreviewBar}>
              <div className="compile-log-slot"><details ref={compileLog} className="compile-log" open={compileState.includes('See compilation log.')}><summary aria-label={mobile ? 'Compilation log' : undefined}>{mobile ? 'Log' : 'Compilation log'}</summary><pre>{log || 'No compilation log available.'}</pre></details></div>
              {mobile ? previewStatus : <div className="preview-footer"><span title={engineState}>{engineState}</span><label className="live-preview"><input type="checkbox" checked={live} onChange={event => toggleLive(event.target.checked)} /> Live preview</label><button className="quiet" onClick={() => setShowHelp(true)} aria-label="Supported LaTeX" title="Supported LaTeX"><Icon name="help" /></button></div>}
            </div>
          </section>
        </div>
      </main>
    </div>
    </div>}
    </div>
    {mobile && view === 'workspace' && <dialog id="workspace-menu" ref={menuDialog} className="action-sheet" aria-labelledby="workspace-menu-title"
      onClose={() => {
        setMenu(false);
        if (!document.activeElement || document.activeElement === document.body || menuDialog.current?.contains(document.activeElement)) moreButton.current?.focus();
      }}
      onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
      <div className="action-sheet-body">
        <div className="action-sheet-header">
          <div className="action-sheet-heading">
            <h2 id="workspace-menu-title">{current?.title || 'Document'}</h2>
            <p><i className="status-dot" />{saveState}</p>
          </div>
          <button className="action-sheet-close" aria-label="Close menu" title="Close menu" onClick={() => menuDialog.current?.close()}><Icon name="close" /></button>
        </div>
        <div className="action-sheet-items">
          <button onClick={fromMenu(() => setSidebar(true))} aria-controls="document-sidebar"><Icon name="panel" />Documents</button>
          <button onClick={fromMenu(() => newDocument())}><Icon name="plus" />New document</button>
          <button onClick={fromMenu(() => fileInput.current.click())}><Icon name="upload" />Import .tex file</button>
          <button onClick={fromMenu(exportTex)} disabled={!current}><Icon name="download" />Export .tex</button>
          <button onClick={fromMenu(exportPdf)} disabled={!pdf}><Icon name="download" />Export PDF</button>
          {pdf ? <a href={pdf.url} target="_blank" rel="noopener" onClick={() => menuDialog.current?.close()}><Icon name="external" />Open PDF</a>
            : <button disabled><Icon name="external" />Open PDF</button>}
          <button onClick={fromMenu(sync)} disabled={!current}><Icon name="cloud" />Save to account</button>
          <button onClick={fromMenu(() => setSharing(true))} disabled={!current}><Icon name="external" />Share read-only link</button>
          <button onClick={copyPrivateLink} disabled={!current}><Icon name={linkCopied ? 'check' : 'link'} />{linkCopied ? 'Link copied' : 'Copy private link'}</button>
          <label className="action-sheet-toggle"><input type="checkbox" checked={live} onChange={event => toggleLive(event.target.checked)} />Live preview</label>
          <button onClick={fromMenu(() => { setTab('preview'); setLogShown(true); })}><Icon name="terminal" />Compilation log</button>
          <button onClick={fromMenu(() => setShowHelp(true))}><Icon name="help" />Help</button>
          {user ? <button onClick={fromMenu(signOut)}><Icon name="user" />Sign out {user.username}</button>
            : <button onClick={fromMenu(() => setAuth('login'))}><Icon name="user" />Sign in</button>}
        </div>
        <p className="action-sheet-status"><span>{compileState}</span><span>{engineState}</span><span role="status" aria-live="polite">{linkCopied ? 'Private link copied to clipboard.' : ''}</span></p>
      </div>
    </dialog>}
    {auth && <AuthDialog mode={auth} setMode={setAuth} onClose={() => setAuth(null)} onSuccess={async signedIn => {
      account.current = signedIn;
      setUser(signedIn); setAuth(null);
      try { await refreshCloud(signedIn); } catch (reason) { notice(reason); }
    }} />}
    {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
    {sharing && <ShareDialog signedIn={Boolean(user)} onClose={() => setSharing(false)} onSignIn={() => setAuth('login')}
      createShare={async () => {
        const snapshot = active.current;
        const result = await sync({ snapshot });
        if (!result.ok) throw new Error(result.error || 'Save to your account before sharing.');
        return (await api(`/documents/${result.cloudId}/share`, {})).share.id;
      }} />}
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
        <p>The source editor uses Monaco's native editing commands: F1 opens its command palette, Ctrl/Cmd+F finds, Ctrl+H (Cmd+Option+F on macOS) replaces, Ctrl/Cmd+/ toggles LaTeX line comments, and Tab/Shift+Tab indents/outdents. Line movement/copying, multiple cursors, undo/redo and word/line navigation use Monaco's platform keybindings. Ctrl+M (Ctrl+Shift+M on macOS) toggles Tab Moves Focus so Tab/Shift+Tab can leave the editor. Ctrl/Cmd+S and Ctrl/Cmd+Enter are reserved by this app for compilation; Ctrl/Cmd+Shift+Enter retains native Insert Line Above. Browser or OS shortcuts may take priority; F1 and the editor context menu expose available commands. This is a browser editor, not the VS Code workbench or extension host. Native word wrapping is on by default, including shared source views. Installed Monaco does not provide VS Code's Alt+Z Toggle Word Wrap command; no custom shortcut emulation is installed.</p>
        <p>On mobile, documents open in Read mode. Export PDF or Export .tex while reading; Open PDF uses your browser's native viewer for text selection, search and accessibility. Copy private link is in More actions; account links require the owner's sign-in and do not enable public sharing. Switch to Edit for small source or title changes and account saving. Compile &amp; read returns to the PDF after a successful compile; failed or cancelled compilations keep the last good preview. Live preview is available in Edit. The enhanced editor loads only when needed.</p>
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

createRoot(document.getElementById('root')).render(location.pathname.startsWith('/share/') ? <SharedDocument /> : <App />);
