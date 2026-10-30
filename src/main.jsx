import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LatexCompiler } from './compiler.js';
import { api, drafts, download, readTex } from './storage.js';
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
  const [stale, setStale] = useState(false);
  const [tab, setTab] = useState('source');
  const [sidebar, setSidebar] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const editor = useRef(null);
  const fileInput = useRef(null);
  const active = useRef(null);
  const timer = useRef(null);
  const pending = useRef(false);
  const saving = useRef(Promise.resolve());
  const generation = useRef(0);
  const compiler = useRef(new LatexCompiler());
  const pdfRef = useRef(null);

  function notice(reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  async function persist(document = active.current) {
    clearTimeout(timer.current);
    if (!document) return;
    pending.current = true;
    const work = saving.current.catch(() => {}).then(() => drafts.put(document));
    saving.current = work;
    try {
      await work;
      if (active.current === document) {
        pending.current = false;
        setSaveState(document.dirty ? 'Saved on this device' : 'Saved to your account');
      }
      setDocuments(list => [document, ...list.filter(item => item.id !== document.id)]);
    } catch (reason) { notice(reason); setSaveState('Local save failed - export your source'); throw reason; }
  }
  function update(patch) {
    const next = { ...active.current, ...patch, dirty: true, updated_at: Date.now() };
    active.current = next;
    pending.current = true;
    setSaveState('Saving on this device...');
    setStale(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { persist(next).catch(() => {}); }, 300);
  }
  async function select(document, force = false) {
    if (!force && document.id === active.current?.id) { setSidebar(false); return; }
    try {
      await persist();
      compiler.current.cancel();
      generation.current++;
      active.current = document;
      setCurrent(document);
      setDocuments(list => [document, ...list.filter(item => item.id !== document.id)]);
      setStale(false);
      setLog('');
      setCompileState('Ready when you are');
      if (pdfRef.current) URL.revokeObjectURL(pdfRef.current);
      pdfRef.current = null;
      setPdf(null);
      setSidebar(false);
      setSaveState(document.dirty ? 'Saved on this device' : 'Saved to your account');
    } catch { /* The visible save error keeps the current draft open. */ }
  }
  async function newDocument(source, title) {
    const document = makeDraft(source, title);
    try { await persist(); await drafts.put(document); await select(document); }
    catch (reason) { notice(reason); }
  }
  async function refreshCloud() {
    const data = await api('/documents');
    setCloud(data.documents);
  }
  useEffect(() => {
    let disposed = false;
    drafts.all().then(async list => {
      const document = list.sort((a, b) => b.updated_at - a.updated_at)[0] || makeDraft();
      if (!list.length) await drafts.put(document);
      if (disposed) return;
      active.current = document;
      setCurrent(document);
      setDocuments(list.length ? list : [document]);
      setSaveState('Saved on this device');
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
      compiler.current.cancel();
      if (pdfRef.current) URL.revokeObjectURL(pdfRef.current);
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  async function compile() {
    if (!active.current || compiler.current.active) return;
    const snapshot = active.current;
    const run = generation.current;
    setCompiling(true);
    setLog('');
    setError('');
    try {
      const result = await compiler.current.compile(snapshot.source, setCompileState);
      if (run !== generation.current) return;
      if (pdfRef.current) URL.revokeObjectURL(pdfRef.current);
      pdfRef.current = URL.createObjectURL(new Blob([result.pdf], { type: 'application/pdf' }));
      setPdf({ url: pdfRef.current, bytes: result.pdf, title: snapshot.title });
      setStale(active.current.source !== snapshot.source);
      setLog(result.log);
      setCompileState('Compiled in your browser');
      setTab('preview');
    } catch (reason) {
      if (run !== generation.current) return;
      setCompileState(reason.message);
      setLog(reason.log || '');
    } finally { setCompiling(false); }
  }
  async function sync() {
    if (!user) { setAuth('login'); return; }
    if (busy) return;
    setBusy(true); setError('');
    const snapshot = active.current;
    try {
      await persist(snapshot);
      let saved;
      if (snapshot.cloudId && snapshot.owner === user.id) {
        const data = await api(`/documents/${snapshot.cloudId}`, {
          title: snapshot.title, source: snapshot.source, revision: snapshot.revision,
        }, 'PUT');
        saved = { ...snapshot, revision: data.revision };
      } else {
        const { document } = await api('/documents', { title: snapshot.title, source: snapshot.source });
        saved = { ...snapshot, cloudId: document.id, revision: document.revision, owner: user.id };
      }
      const next = active.current.id === snapshot.id
        ? { ...active.current, cloudId: saved.cloudId, owner: user.id, revision: saved.revision, dirty: active.current !== snapshot }
        : { ...saved, dirty: false };
      if (active.current.id === next.id) active.current = next;
      await persist(next);
      await refreshCloud();
    } catch (reason) { notice(reason); }
    finally { setBusy(false); }
  }
  async function openCloud(item) {
    try {
      const local = documents.find(doc => doc.cloudId === item.id && doc.owner === user.id);
      if (local?.dirty && !window.confirm('Replace this device draft with the cloud version? Export the local draft first if you need it.')) return;
      const { document } = await api(`/documents/${item.id}`);
      const next = { ...document, id: local?.id || crypto.randomUUID(), cloudId: document.id, owner: user.id, dirty: false };
      await persist();
      await drafts.put(next);
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
  actions.current = { compile, sync };
  useEffect(() => {
    const keys = event => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key.toLowerCase() === 's')) {
        event.preventDefault();
        if (event.key === 'Enter') actions.current.compile(); else actions.current.sync();
      }
      if (event.key === 'Escape') { setAuth(null); setShowHelp(false); setSidebar(false); }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);

  return <div className="app">
    <header className="topbar">
      <button className="icon mobile-menu" aria-label="Toggle documents" onClick={() => setSidebar(!sidebar)}>☰</button>
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
      <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
        <div className="sidebar-heading"><span>YOUR WORKSPACE</span><span className="tiny">TEXT ONLY</span></div>
        <button className="new-document" onClick={() => newDocument()} disabled={busy}>＋ <span>New document</span><kbd>N</kbd></button>
        <div className="section-label">On this device <span>{documents.length}</span></div>
        <nav aria-label="Local documents">{documents.map(doc =>
          <button key={doc.id} className={`document-item ${current?.id === doc.id ? 'selected' : ''}`} onClick={() => select(doc)} disabled={busy}>
            <span className="file-icon">T<span>E</span>X</span><span className="document-name">{doc.title}<small>{doc.cloudId ? 'Linked to account' : 'Local draft'}</small></span>
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
            <input key={current?.id || 'empty'} defaultValue={current?.title || ''} aria-label="Document title" maxLength={100} disabled={!current || busy}
              onChange={event => update({ title: event.target.value })} onBlur={event => {
                if (!active.current?.title.trim()) { event.target.value = 'Untitled paper'; update({ title: 'Untitled paper' }); }
                persist().catch(() => {});
              }} />
            <span className="save-state" role="status"><i />{saveState}</span>
          </div>
          <div className="document-actions">
            <button className="quiet" disabled={!current} onClick={() => download(active.current.source, `${active.current.title || 'document'}.tex`, 'text/plain;charset=utf-8')}>Export .tex</button>
            <button className="save-button" disabled={!current || busy} onClick={sync}>{busy ? 'Saving...' : 'Save to account'}</button>
          </div>
        </div>
        <div className="mobile-tabs"><button className={tab === 'source' ? 'active' : ''} onClick={() => setTab('source')}>Source</button><button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>PDF preview</button></div>
        <div className="panels">
          <section className={`editor-panel ${tab === 'source' ? 'mobile-active' : ''}`} aria-label="LaTeX source editor">
            <div className="panel-toolbar"><span><span className="code-symbol">⌘</span> main.tex</span><span className="tiny">LATEX</span></div>
            <div className="editor-container">
              <textarea ref={editor} key={current?.id || 'loading'} defaultValue={current?.source || ''} disabled={!current}
                aria-label="LaTeX source" spellCheck={false} autoCapitalize="off" autoCorrect="off" maxLength={100000}
                onChange={event => update({ source: event.target.value })}
                onKeyDown={event => {
                  if (event.key === 'Tab') {
                    event.preventDefault();
                    const input = event.currentTarget;
                    input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
                    update({ source: input.value });
                  }
                }} />
            </div>
            <div className="editor-footer"><span>UTF-8 <span className="separator">/</span> Text only</span><span>Ctrl ↵ to compile</span></div>
          </section>
          <section className={`preview-panel ${tab === 'preview' ? 'mobile-active' : ''}`} aria-label="PDF preview">
            <div className="panel-toolbar preview-toolbar"><span>Preview <span className="preview-tag">PDF</span></span><div className="preview-actions">
              {pdf && <button className="quiet" onClick={() => download(pdf.bytes, `${pdf.title || 'document'}.pdf`, 'application/pdf')}>Export PDF ↓</button>}
              <button className="compile-button" aria-label={compiling ? 'Cancel' : 'Compile'} disabled={!current} onClick={compiling ? () => compiler.current.cancel() : compile}>
                <span className={compiling ? 'spinner' : ''}>{compiling ? '' : '▷'}</span>{compiling ? 'Cancel' : 'Compile'}
              </button></div>
            </div>
            <div className="preview-status" role="status"><span className={compiling ? 'working-dot' : 'status-dot'} />{compileState}{pdf && stale && <strong> / Preview is out of date</strong>}</div>
            <div className="pdf-area">{pdf ? <iframe title="Compiled PDF" src={`${pdf.url}#toolbar=0&navpanes=0`} /> :
              <div className="empty-preview"><div className="paper-illustration"><span /> <span /> <span /><b>∑</b><span /> <span /></div>
                <h1>From a thought<br />to a paper.</h1><p>Your words, beautifully typeset.<br />Compile to see your document here.</p><button className="empty-compile" disabled={!current || compiling} onClick={compile}>Compile your document <span>↗</span></button><small>Runs privately in a browser worker.</small></div>}
            </div>
            {log && <details className="compile-log" open={compileState.startsWith('LaTeX')}><summary>Compilation log</summary><pre>{log}</pre></details>}
            <div className="preview-footer"><span>No server compilation. No background polling.</span><button className="quiet" onClick={() => setShowHelp(true)}>Supported LaTeX ↗</button></div>
          </section>
        </div>
      </main>
    </div>
    {auth && <AuthDialog mode={auth} setMode={setAuth} onClose={() => setAuth(null)} onSuccess={async signedIn => {
      setUser(signedIn); setAuth(null);
      try { await refreshCloud(); } catch (reason) { notice(reason); }
    }} />}
    {showHelp && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowHelp(false); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><button className="modal-close" autoFocus aria-label="Close help" onClick={() => setShowHelp(false)}>×</button>
        <span className="eyebrow">A SMALLER, QUIETER WORKSPACE</span><h2 id="help-title">Just you and your ideas.</h2>
        <p>Each document is one UTF-8 .tex file, up to 100,000 characters. Images, binary files and external source assets are not supported.</p>
        <p>The bundled pdfTeX engine supports article, report, book, amsmath, amssymb, geometry and standard Computer Modern fonts. No shell escape, bibliography uploads, custom fonts, or automatic package downloads. Use pdfLaTeX-compatible text; full Unicode and every CTAN package are not supported.</p>
        <p>Compile manually with <kbd>Ctrl</kbd> + <kbd>Enter</kbd>. Two passes resolve cross-references. Cancel stops the worker immediately; jobs time out after 60 seconds.</p>
        <p>Drafts are saved on this browser/device after a short pause. Cloud saves are explicit (<kbd>Ctrl</kbd> + <kbd>S</kbd>), require sign-in, and never happen while typing. Export .tex for a portable backup. Device drafts are not encrypted; use your own device.</p>
        <p>The engine downloads only on first compile (~15 MB uncompressed), can use around 100 MB or more while active, and is released after each job. 120 fps is a design target, not a guarantee on every device.</p>
        <a href="/compiler/NOTICE.txt" target="_blank" rel="noreferrer">Compiler credits and source ↗</a>
      </section>
    </div>}
  </div>;
}

function AuthDialog({ mode, setMode, onClose, onSuccess }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const trap = event => {
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),a')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener('keydown', trap);
    return () => dialog.removeEventListener('keydown', trap);
  }, []);
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
      <label>Password<input name="password" type="password" required minLength={12} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} disabled={busy} /></label>
      <small>3-32 character username. Password: 12-128 characters.</small>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="compile-button" disabled={busy}>{busy ? 'Please wait...' : mode === 'register' ? 'Create account' : 'Sign in'}</button>
    </form>
    <button className="auth-switch" disabled={busy} onClick={() => { setError(''); setMode(mode === 'register' ? 'login' : 'register'); }}>{mode === 'register' ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
  </section></div>;
}

createRoot(document.getElementById('root')).render(<App />);
