import React, { useEffect, useRef, useState } from 'react';
import { LatexCompiler } from '../compiler.js';
import { download } from '../storage.js';
import LatexEditor from './LatexEditor.jsx';
import PdfPreview from './PdfPreview.jsx';
import CompilationLog from './CompilationLog.jsx';
import './sharing.css';

export default function SharedDocument() {
  const [document, setDocument] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Opening shared document...');
  const [sourceShown, setSourceShown] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [pdf, setPdf] = useState(null);
  const [pageStatus, setPageStatus] = useState(null);
  const [log, setLog] = useState('');
  const compiler = useRef(null);
  const url = useRef(null);
  const mounted = useRef(false);
  const viewState = useRef(null);
  const previewStatus = <div className="preview-status">
    <span className="preview-status-message" role="status" title={status}>{status}</span>
    {pdf && pageStatus?.url === pdf.url && <span className="preview-page-status">Page {pageStatus.page}/{pageStatus.total}</span>}
  </div>;

  async function compile(snapshot = document) {
    if (!snapshot || compiler.current.active) return;
    setCompiling(true);
    setError('');
    try {
      const result = await compiler.current.compile(snapshot.source, message => {
        if (mounted.current) setStatus(message);
      });
      if (!mounted.current) return;
      const next = URL.createObjectURL(new Blob([result.pdf], { type: 'application/pdf' }));
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = next;
      setPdf({ url: next, bytes: result.pdf, title: snapshot.title, source: snapshot.source });
      setLog(result.log);
      setStatus('Compiled in your browser. Shared document is read-only.');
    } catch (reason) {
      if (mounted.current) {
        setError(reason.message);
        setLog(reason.log || reason.message);
        setStatus('Preview not updated.');
      }
    } finally { if (mounted.current) setCompiling(false); }
  }
  useEffect(() => {
    mounted.current = true;
    compiler.current = new LatexCompiler();
    const controller = new AbortController();
    const id = location.pathname.slice('/share/'.length);
    (async () => {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Shared document not found or link revoked.');
      const response = await fetch(`/api/shares/${id}`, { credentials: 'omit', signal: controller.signal, referrerPolicy: 'no-referrer' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not open shared document.');
      if (!mounted.current) return;
      setDocument(data.document);
      await compile(data.document);
    })().catch(reason => {
      if (!controller.signal.aborted) { setError(reason.message); setStatus('Shared document unavailable.'); }
    });
    return () => {
      mounted.current = false;
      controller.abort();
      compiler.current.dispose();
      if (url.current) URL.revokeObjectURL(url.current);
    };
  }, []);

  return <main className="shared-document">
    <header className="shared-toolbar">
      <a href="/" className="brand" aria-label="KhanhhNeLatex home"><span className="brand-mark">k</span></a>
      <div className="shared-heading"><h1>{document?.title || 'Shared document'}</h1><span>Read-only · No account required</span></div>
      <div className="shared-actions">
        <button className="quiet" aria-pressed={sourceShown} onClick={() => setSourceShown(value => !value)}>{sourceShown ? 'View PDF' : 'View source'}</button>
        <button className="compile-button" disabled={!document} onClick={() => compiling ? compiler.current.cancel() : compile()}>{compiling ? 'Cancel' : 'Compile'}</button>
        <button className="quiet" disabled={!document} onClick={() => download(document.source, `${document.title}.tex`, 'text/plain;charset=utf-8')}>Export .tex</button>
        <button className="quiet" disabled={!pdf} onClick={() => download(pdf.bytes, `${document.title}.pdf`, 'application/pdf')}>Export PDF</button>
      </div>
    </header>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className={`shared-panels ${sourceShown ? 'show-source' : ''}`}>
      {document && sourceShown && <section className="editor-panel" aria-label="Read-only LaTeX source">
        <LatexEditor documentKey="shared" value={document.source} readOnly onChange={() => {}} onCompile={() => compile()} onSave={() => compile()} />
      </section>}
      <section className="preview-panel" aria-label="PDF preview">
        {!pdf && previewStatus}
        <div className="pdf-area">{pdf ? <div className="pdf-stack"><PdfPreview viewer={pdf} viewState={viewState} status={previewStatus}
          onPageChange={info => { if (url.current === pdf.url) setPageStatus(info ? { url: pdf.url, ...info } : null); }}
          onReady={() => setStatus('Compiled in your browser. Shared document is read-only.')}
          onError={() => setError('PDF preview could not load. You can still export the PDF.')} /></div>
          : <p>{compiling ? 'Typesetting shared document in your browser...' : 'No PDF preview available.'}</p>}</div>
      </section>
    </div>
    <footer className="shared-footer">
      <details className="compile-log"><summary>Compilation log</summary><CompilationLog text={log} /></details>
    </footer>
  </main>;
}
