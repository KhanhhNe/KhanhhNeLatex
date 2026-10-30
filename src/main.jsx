import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LatexCompiler } from './compiler.js';
import { api, drafts, download, readTex } from './storage.js';
import LatexEditor from './components/LatexEditor.jsx';
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
  id: crypto.randomUUID(), title, source, updated_at: Date.now(), cloudId: null, revision: null, owner: null, dirty: true,
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
  const compileRequest = useRef(0);
  const liveTimer = useRef(null);
  const liveEnabled = useRef(false);
  const compiledSource = useRef(null);
  const requestedSource = useRef(null);
  const compileDuration = useRef(0);
  const cloudTimings = useRef(new Map());

  function notice(reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
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
    const work = saving.current.catch(() => {}).then(() => drafts.put(document));
    saving.current = work;
    try {
      await work;
      persisted.current.add(document);
      if (active.current === document) {
        pending.current = false;
        setSaveState(savedLabel(document));
      }
      setDocuments(list => [document, ...list.filter(item => item.id !== document.id)]);
    } catch (reason) { notice(reason); setSaveState('Local save failed - export your source'); throw reason; }
  }
  async function flush() {
    let snapshot;
    do {
      snapshot = active.current;
      await persist(snapshot);
    } while (active.current !== snapshot);
  }
  function update(patch) {
    const next = { ...active.current, ...patch, dirty: true, updated_at: Date.now() };
    active.current = next;
    setCurrent(next);
    pending.current = true;
    setSaveState('Saving on this device...');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { persist(next).catch(() => {}); }, 300);
    if ('source' in patch) {
      setStale(shownPdf.current?.source !== next.source);
      scheduleLive();
    }
  }
  async function select(document, force = false) {
    const selection = ++selectionRequest.current;
    if (!force && document.id === active.current?.id) { setSidebar(false); return; }
    try {
      await flush();
      if (selection !== selectionRequest.current) return;
      clearTimeout(liveTimer.current);
      discardPendingViewer();
      compileRequest.current++;
      compiler.current.cancel();
      setCompiling(false);
      generation.current++;
      active.current = document;
      setCurrent(document);
      setDocuments(list => [document, ...list.filter(item => item.id !== document.id)]);
      compiledSource.current = null;
      requestedSource.current = null;
      setStale(false);
      setLog('');
      setCompileState('Ready when you are');
      if (pdfRef.current) URL.revokeObjectURL(pdfRef.current);
      pdfRef.current = null;
      shownPdf.current = null;
      generatedPdf.current = null;
      setPdf(null);
      setSidebar(false);
      setSaveState(persisted.current.has(document) ? savedLabel(document) : 'Saving on this device...');
      compile({ reveal: false });
      await persist(document);
    } catch { /* The visible save error keeps the unsaved draft open. */ }
  }
  async function newDocument(source, title) {
    const document = makeDraft(source, title);
    try { await select(document); }
    catch (reason) { notice(reason); }
  }
  async function refreshCloud() {
    const data = await api('/documents');
    setCloud(data.documents);
  }
  useEffect(() => {
    let disposed = false;
    try {
      liveEnabled.current = localStorage.getItem('folio-live-preview') === 'true';
      setLive(liveEnabled.current);
    } catch { notice(new Error('Could not read the live preview preference. This session starts with live preview off.')); }
    compiler.current.warmup().then(timing => {
      if (!disposed) setEngineState(`Engine initialized · ${elapsed(timing.initializationMs)}`);
    }).catch(reason => {
      if (!disposed && reason.message !== 'Compilation cancelled.') notice(reason);
    });
    drafts.all().then(async list => {
      const document = list.sort((a, b) => b.updated_at - a.updated_at)[0] || makeDraft();
      if (!list.length) await drafts.put(document);
      if (disposed) return;
      for (const draft of list.length ? list : [document]) persisted.current.add(draft);
      active.current = document;
      setCurrent(document);
      setDocuments(list.length ? list : [document]);
      setSaveState('Saved on this device');
      compile({ reveal: false });
    }).catch(notice);
    api('/me').then(data => {
      if (!disposed) { setUser(data.user); refreshCloud().catch(notice); }
    }).catch(reason => {
      if (!reason.message.startsWith('Sign in') && !reason.message.startsWith('Session expired')) notice(reason);
    });
    const unload = event => {
      if (pending.current) { event.preventDefault(); event.returnValue = ''; }
    };
    const hidden = () => { if (document.visibilityState === 'hidden' && pending.current) persist().catch(() => {}); };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      disposed = true;
      clearTimeout(timer.current);
      clearTimeout(liveTimer.current);
      compileRequest.current++;
      compiler.current.cancel();
      discardPendingViewer();
      if (pdfRef.current) URL.revokeObjectURL(pdfRef.current);
      for (const url of retiredUrls.current) if (url) URL.revokeObjectURL(url);
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

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
  async function compile({ reveal = true } = {}) {
    clearTimeout(liveTimer.current);
    discardPendingViewer();
    if (!active.current) return;
    const snapshot = active.current;
    const run = ++compileRequest.current;
    requestedSource.current = snapshot.source;
    setCompiling(true);
    setLog('');
    setCompileState('Preparing compilation...');
    try {
      const result = await compiler.current.compile(snapshot.source, status => {
        if (run === compileRequest.current && /^(Loading browser engine|Typesetting|Resolving)/.test(status)) setCompileState(status);
      });
      if (run !== compileRequest.current) return;
      const next = { bytes: result.pdf, title: snapshot.title, source: snapshot.source, request: run };
      generatedPdf.current = next;
      if (shownPdf.current && samePdf(shownPdf.current.bytes, result.pdf)) {
        shownPdf.current = { ...shownPdf.current, ...next };
        setPdf(shownPdf.current);
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
      if (result.timings.initializationMs > 0) setEngineState(`Engine initialized · ${elapsed(result.timings.initializationMs)}`);
      if (reveal) setTab('preview');
    } catch (reason) {
      if (run !== compileRequest.current) return;
      setCompileState(reason.message === 'Compilation cancelled.' ? reason.message
        : reason.message.startsWith('LaTeX') ? 'LaTeX could not compile. See compilation log.'
          : reason.message.startsWith('Compilation timed out') ? 'Compilation timed out. See compilation log.'
            : 'Compilation failed. See compilation log.');
      setLog(reason.log || reason.message);
    } finally { if (run === compileRequest.current) setCompiling(false); }
  }
  async function sync() {
    if (!active.current) return;
    if (!user) { setAuth('login'); return; }
    if (busy) return;
    setBusy(true); setError('');
    const snapshot = active.current;
    let localSaved = false;
    try {
      await persist(snapshot);
      localSaved = true;
      setSaveState('Saving to your account...');
      let saved;
      const started = performance.now();
      if (snapshot.cloudId && snapshot.owner === user.id) {
        const data = await api(`/documents/${snapshot.cloudId}`, {
          title: snapshot.title, source: snapshot.source, revision: snapshot.revision,
        }, 'PUT');
        saved = { ...snapshot, revision: data.revision };
      } else {
        const { document } = await api('/documents', { title: snapshot.title, source: snapshot.source });
        saved = { ...snapshot, cloudId: document.id, revision: document.revision, owner: user.id };
      }
      cloudTimings.current.set(snapshot.id, performance.now() - started);
      const next = active.current.id === snapshot.id
        ? { ...active.current, cloudId: saved.cloudId, owner: user.id, revision: saved.revision, dirty: active.current !== snapshot }
        : { ...saved, dirty: false };
      if (active.current.id === next.id) active.current = next;
      await persist(next);
      await refreshCloud();
    } catch (reason) {
      notice(reason);
      if (localSaved && active.current?.id === snapshot.id) setSaveState('Cloud save failed - device draft kept');
    }
    finally { setBusy(false); }
  }
  async function openCloud(item) {
    const request = ++selectionRequest.current;
    try {
      const { document } = await api(`/documents/${item.id}`);
      if (request !== selectionRequest.current) return;
      const local = active.current?.cloudId === item.id && active.current.owner === user.id
        ? active.current : documents.find(doc => doc.cloudId === item.id && doc.owner === user.id);
      if (local?.dirty && !window.confirm('Replace this device draft with the cloud version? Export the local draft first if you need it.')) return;
      const next = { ...document, id: local?.id || crypto.randomUUID(), updated_at: Date.now(), cloudId: document.id, owner: user.id, dirty: false };
      await select(next, true);
    } catch (reason) { notice(reason); }
  }
  async function remove() {
    const snapshot = active.current;
    if (!snapshot || !window.confirm(`Delete "${snapshot.title}"${snapshot.cloudId ? ' from this device and your account' : ''}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await persist();
      if (snapshot.cloudId) {
        if (snapshot.owner !== user?.id) throw new Error('Sign in to the document owner account before deleting this synced draft.');
        await api(`/documents/${snapshot.cloudId}`, undefined, 'DELETE');
        await refreshCloud();
      }
      await drafts.delete(snapshot.id);
      const list = documents.filter(doc => doc.id !== snapshot.id);
      const next = list[0] || makeDraft();
      if (!list.length) await drafts.put(next);
      active.current = null;
      setDocuments(list.length ? list : [next]);
      await select(next);
    } catch (reason) { notice(reason); }
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
    <header className="topbar">
      <button className="icon mobile-menu" aria-label="Toggle documents" aria-expanded={sidebar} aria-controls="document-sidebar" onClick={() => setSidebar(!sidebar)}>☰</button>
      <a className="brand" href="/" aria-label="KhanhhNeLatex home"><span className="brand-mark">k</span><span className="brand-name">KhanhhNeLatex</span><span className="brand-label">A LATEX WORKSPACE</span></a>
      <div className="top-actions"><span className="local-badge"><i /> Local-first</span>
        <button className="quiet" onClick={() => setShowHelp(true)}>Help</button>
        {user ? <button className="account" disabled={busy} onClick={async () => {
          try { await persist(); await api('/logout', {}); setUser(null); setCloud([]); }
          catch (reason) { notice(reason); }
        }}>{user.username} <span> / Sign out</span></button> : <button className="account" onClick={() => setAuth('login')}>Sign in <span>↗</span></button>}
      </div>
    </header>
    {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    <div className="workspace">
      <aside id="document-sidebar" className={`sidebar ${sidebar ? 'open' : ''}`}>
        <div className="sidebar-heading"><span>YOUR WORKSPACE</span><span className="tiny">TEXT ONLY</span></div>
        <button className="new-document" onClick={() => newDocument()} disabled={busy}>＋ <span>New document</span><kbd>N</kbd></button>
        <div className="section-label">On this device <span>{documents.length}</span></div>
        <nav aria-label="Local documents">{documents.map(doc =>
          <button key={doc.id} className={`document-item ${current?.id === doc.id ? 'selected' : ''}`} onClick={() => select(doc)} disabled={busy}>
            <span className="file-icon" aria-hidden="true">T<span>E</span>X</span><span className="document-name">{doc.title}<small>{doc.cloudId ? 'Linked to account' : 'Local draft'}</small></span>
          </button>)}</nav>
        {user && <><div className="section-label">Your cloud documents <span>{cloud.length}</span></div><nav aria-label="Cloud documents">
          {cloud.map(item => <button key={item.id} className="document-item" disabled={busy} onClick={() => openCloud(item)}><span className="file-icon">☁</span><span className="document-name">{item.title}<small>Open saved version</small></span></button>)}
          {!cloud.length && <p className="sidebar-note">Save a document to keep it in your account.</p>}
        </nav></>}
        <div className="sidebar-bottom">
          <button className="import-button" onClick={() => fileInput.current.click()} disabled={busy}>↥ <span>Import .tex file</span></button>
          <input ref={fileInput} type="file" accept=".tex,text/plain,application/x-tex" hidden onChange={importFile} />
          <div className="privacy-card"><span>Made for a little focus.</span><p>Write locally. Compile privately.<br />No uploads required.</p></div>
          <button className="delete-button" onClick={remove} disabled={!current || busy}>Delete current document</button>
        </div>
      </aside>
      <main className="main">
        <div className="document-toolbar">
          <div className="document-title"><span className="breadcrumb">Workspace /</span>
            <input key={`${current?.id || 'empty'}:${generation.current}`} defaultValue={current?.title || ''} aria-label="Document title" maxLength={100} disabled={!current || busy}
              onChange={event => update({ title: event.target.value })} onBlur={event => {
                if (!active.current?.title.trim()) { event.target.value = 'Untitled paper'; update({ title: 'Untitled paper' }); }
                persist().catch(() => {});
              }} />
            <span className="save-state" role="status" aria-atomic="true"><i />{saveState}</span>
          </div>
          <div className="document-actions">
            <button className="quiet" disabled={!current} onClick={() => download(active.current.source, `${active.current.title || 'document'}.tex`, 'text/plain;charset=utf-8')}>Export .tex</button>
            <button className="save-button" disabled={!current || busy} onClick={sync}>{busy ? 'Saving...' : 'Save to account'}</button>
          </div>
        </div>
        <div className="mobile-tabs"><button className={tab === 'source' ? 'active' : ''} aria-pressed={tab === 'source'} aria-controls="source-panel" onClick={() => setTab('source')}>Source</button><button className={tab === 'preview' ? 'active' : ''} aria-pressed={tab === 'preview'} aria-controls="preview-panel" onClick={() => setTab('preview')}>PDF preview</button></div>
        <div className="panels">
          <section id="source-panel" className={`editor-panel ${tab === 'source' ? 'mobile-active' : ''}`} aria-label="LaTeX source editor">
            <div className="panel-toolbar"><span><span className="code-symbol">⌘</span> main.tex</span><span className="tiny">LATEX</span>
              <button className="compile-button source-compile" aria-label={compiling ? 'Cancel' : 'Compile'} disabled={!current} onClick={compiling ? cancelCompile : () => compile()}>{compiling ? 'Cancel' : 'Compile'}</button>
            </div>
            <div className="editor-container">
              <LatexEditor documentKey={`${current?.id || 'loading'}:${generation.current}`}
                value={current?.source || ''} loading={!current}
                onChange={source => update({ source })}
                onSave={() => compile()} onCompile={() => compile()} />
            </div>
            <div className="editor-footer"><span>UTF-8 / Text only</span><span id="source-shortcuts">Tab indents; Shift+Tab leaves. Ctrl+Enter compiles.</span></div>
          </section>
          <section id="preview-panel" className={`preview-panel ${tab === 'preview' ? 'mobile-active' : ''}`} aria-label="PDF preview">
            <div className="panel-toolbar preview-toolbar"><span>Preview <span className="preview-tag">PDF</span></span><div className="preview-actions">
              <button className="quiet" disabled={!pdf} onClick={() => {
                const latest = generatedPdf.current;
                download(latest.bytes, `${latest.title || 'document'}.pdf`, 'application/pdf');
              }}>Export PDF ↓</button>
              <button className="compile-button" aria-label={compiling ? 'Cancel' : 'Compile'} aria-keyshortcuts="Control+Enter Meta+Enter" disabled={!current} onClick={compiling ? cancelCompile : () => compile()}>
                <span className={compiling ? 'spinner' : ''}>{compiling ? '' : '▷'}</span>{compiling ? 'Cancel' : 'Compile'}
              </button></div>
            </div>
            <div className="preview-status">
              <span className="preview-status-reserve" aria-hidden="true" />
              <div className="preview-status-message" role="status" aria-atomic="true"><span className={compiling ? 'working-dot' : 'status-dot'} /><span>{compileState}</span>{pendingPdf && <span> / Loading new preview...</span>}{pdf && stale && <strong> / Preview is out of date</strong>}</div>
            </div>
            <div className="pdf-area">{pdf ? <div className="pdf-stack">{[pdf, pendingPdf].filter(Boolean).map(viewer =>
              <iframe key={viewer.url} title={viewer.url === pdf.url ? 'Compiled PDF' : 'Loading compiled PDF'}
                className={viewer.url === pdf.url ? 'pdf-viewer' : `pdf-viewer pending ${viewer.ready ? 'ready' : ''}`}
                aria-hidden={viewer.url !== pdf.url ? true : undefined} tabIndex={viewer.url === pdf.url ? 0 : -1}
                onError={() => {
                  if (pendingViewer.current?.url !== viewer.url) return;
                  discardPendingViewer();
                  notice(new Error('The new PDF preview could not load. The previous preview is still available; export the new PDF or compile again.'));
                }}
                onLoad={() => revealPreview(viewer.url)} src={`${viewer.url}#toolbar=0&navpanes=0`} />)}</div> :
              <div className="empty-preview"><div className="paper-illustration"><span /> <span /> <span /><b>∑</b><span /> <span /></div>
                <h1>From a thought<br />to a paper.</h1><p>Your words, beautifully typeset.<br />Your first preview is on its way.</p><button className="empty-compile" disabled={!current || compiling} onClick={() => compile()}>Compile your document <span>↗</span></button><small>Runs privately in a browser worker.</small></div>}
            </div>
            <div className="compile-log-slot"><details className="compile-log" open={compileState.includes('See compilation log.')}><summary>Compilation log</summary><pre>{log || 'No compilation log available.'}</pre></details></div>
            <div className="preview-footer"><span>{engineState}</span><label className="live-preview"><input type="checkbox" checked={live} onChange={event => toggleLive(event.target.checked)} /> Live preview</label><button className="quiet" onClick={() => setShowHelp(true)}>Supported LaTeX ↗</button></div>
          </section>
        </div>
      </main>
    </div>
    </div>
    {auth && <AuthDialog mode={auth} setMode={setAuth} onClose={() => setAuth(null)} onSuccess={async signedIn => {
      setUser(signedIn); setAuth(null);
      try { await refreshCloud(); } catch (reason) { notice(reason); }
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
      <section ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><button className="modal-close" aria-label="Close help" onClick={onClose}>×</button>
        <span className="eyebrow">A SMALLER, QUIETER WORKSPACE</span><h2 id="help-title">Just you and your ideas.</h2>
        <p>Each document is one UTF-8 .tex file, up to 100,000 characters. Images, binary files and external source assets are not supported.</p>
        <p>The bundled pdfTeX engine supports article, report, book, amsmath, amssymb, geometry and standard Computer Modern fonts. No shell escape, bibliography uploads, custom fonts, or automatic package downloads. Use pdfLaTeX-compatible text; full Unicode and every CTAN package are not supported.</p>
        <p>The engine starts loading when you open this page, and each opened document gets an initial preview. Enable Live preview for debounced updates after editing pauses; it starts off to avoid background CPU churn. Your choice is saved on this device. Compile manually with <kbd>Ctrl</kbd> + <kbd>Enter</kbd>. Two passes resolve cross-references. A new compile replaces the previous job; Cancel stops it immediately, and jobs time out after 60 seconds.</p>
        <p>Drafts are saved on this browser/device after a short pause. <kbd>Ctrl</kbd> + <kbd>S</kbd> always recompiles and also saves to your account if signed in; cloud saves are explicit, require sign-in, and never happen while typing. Compilation timings measure typesetting, engine startup is shown separately, and cloud-save timings measure the full request round trip, not just database work. Export .tex for a portable backup. Device drafts are not encrypted; use your own device.</p>
        <p>The engine downloads only on first compile (~15 MB uncompressed), can use around 100 MB or more while active, and is released after each job. 120 fps is a design target, not a guarantee on every device.</p>
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
    <button className="modal-close" disabled={busy} aria-label="Close sign in" onClick={onClose}>×</button>
    <span className="brand-mark">k</span><h2 id="auth-title">{mode === 'register' ? 'A home for your ideas.' : 'Welcome back.'}</h2><p>Save your documents across devices.<br />You can always keep writing without an account.</p>
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
