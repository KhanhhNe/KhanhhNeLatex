import React, { useEffect, useRef, useState } from 'react';
import { textChange } from '../crdt.js';
import './LatexEditor.css';

const validSource = value => value.length <= 100000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(value);
const editorMetrics = host => {
  const style = getComputedStyle(host);
  return { fontSize: parseFloat(style.fontSize), lineHeight: Math.round(parseFloat(style.lineHeight)) };
};
let engine;
export const preloadLatexEditor = () => engine ||= import('./monaco.js').catch(error => {
  engine = null;
  throw error;
});

export default function LatexEditor({
  value, onChange, onSave, onCompile, ariaLabel = 'LaTeX source',
  documentKey, readOnly = false, loading = false, apiRef,
}) {
  const host = useRef(null);
  const metricsProbe = useRef(null);
  const editor = useRef(null);
  const fallback = useRef(null);
  const replacing = useRef(false);
  const handoff = useRef(null);
  const latest = useRef(null);
  latest.current = { value, onChange, onSave, onCompile, readOnly, loading, ariaLabel };
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  function shortcut(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key !== 's' && key !== 'enter') return;
    event.preventDefault();
    event.stopPropagation();
    if (latest.current.loading) return;
    if (key === 's') latest.current.onSave?.();
    else latest.current.onCompile?.();
  }

  useEffect(() => {
    let disposed = false;
    let instance, model, change, resize, guard, handle;
    setReady(false);
    setError('');
    preloadLatexEditor().then(({ monaco }) => {
      if (disposed) return;
      const current = latest.current;
      const focused = document.activeElement === fallback.current;
      const selection = fallback.current && [fallback.current.selectionStart, fallback.current.selectionEnd];
      model = monaco.editor.createModel(current.value, 'latex');
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
      instance = monaco.editor.create(host.current, {
        model, theme: 'folio', ariaLabel: current.ariaLabel,
        readOnly: current.readOnly || current.loading,
        domReadOnly: true,
        fontFamily: '"Cascadia Code", Consolas, "Liberation Mono", monospace',
        ...editorMetrics(host.current), tabSize: 2, insertSpaces: true,
        minimap: { enabled: false }, wordWrap: 'on',
        scrollBeyondLastLine: false, folding: false, glyphMargin: false,
        lineNumbersMinChars: 3, overviewRulerLanes: 0, hideCursorInOverviewRuler: true,
        renderLineHighlight: 'line', selectionHighlight: false, occurrencesHighlight: 'off',
        codeLens: false, links: false, colorDecorators: false,
        quickSuggestions: false, suggestOnTriggerCharacters: false,
        parameterHints: { enabled: false }, wordBasedSuggestions: 'off',
        hover: { enabled: false }, stickyScroll: { enabled: false },
        matchBrackets: 'near', renderValidationDecorations: 'off',
        unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
        accessibilitySupport: 'on', editContext: false,
        tabIndex: 0, padding: { top: 12, bottom: 16 },
        automaticLayout: false, contextmenu: true,
        stopRenderingLineAfter: 2000, largeFileOptimizations: true,
        scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      });
      editor.current = instance;
      guard = event => {
        const text = event.type === 'paste' ? event.clipboardData?.getData('text/plain') : event.data;
        if (typeof text !== 'string') return;
        const selection = instance.getSelection();
        const length = model.getValueLength() - model.getValueInRange(selection).length + text.length;
        if (length > 100000 || !validSource(text)) {
          event.preventDefault();
          event.stopPropagation();
          setError('Source must be valid text, at most 100,000 characters. The last edit was not accepted.');
        }
      };
      host.current.addEventListener('beforeinput', guard, true);
      host.current.addEventListener('paste', guard, true);
      let previousValue = model.getValue();
      change = model.onDidChangeContent(event => {
        if (replacing.current) { previousValue = model.getValue(); return; }
        const before = previousValue;
        const next = model.getValue();
        if (!validSource(next)) {
          setError('Source must be valid text, at most 100,000 characters. The last edit was not accepted.');
          queueMicrotask(() => {
            if (disposed) return;
            replacing.current = true;
            model.undo();
            replacing.current = false;
          });
          return;
        }
        setError('');
        previousValue = next;
        latest.current.onChange(next, event.changes, before);
      });
      resize = new ResizeObserver(() => {
        if (host.current?.clientWidth && host.current?.clientHeight) {
          const metrics = editorMetrics(host.current);
          if (instance.getOption(monaco.editor.EditorOption.fontSize) !== metrics.fontSize ||
            instance.getOption(monaco.editor.EditorOption.lineHeight) !== metrics.lineHeight)
            instance.updateOptions(metrics);
          instance.layout();
        }
      });
      resize.observe(host.current);
      resize.observe(metricsProbe.current);
      instance.layout();
      if (apiRef) apiRef.current = handle = {
        documentKey,
        replace(next) {
          const current = model.getValue();
          let start = 0, end = 0;
          while (start < current.length && start < next.length && current[start] === next[start]) start++;
          if (start && /[\ud800-\udbff]/.test(current[start - 1])) start--;
          while (end < current.length - start && end < next.length - start
            && current[current.length - 1 - end] === next[next.length - 1 - end]) end++;
          if (end && /[\udc00-\udfff]/.test(current[current.length - end])) end--;
          const from = model.getPositionAt(start), to = model.getPositionAt(current.length - end);
          instance.pushUndoStop();
          instance.executeEdits('agent-api', [{
            range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column },
            text: next.slice(start, next.length - end), forceMoveMarkers: true,
          }]);
          instance.pushUndoStop();
        },
        history(kind) { instance.trigger('agent-api', kind, null); },
      };
      handoff.current = focused ? selection : null;
      setReady(true);
    }).catch(reason => {
      if (!disposed) setError(`The enhanced editor could not load. Plain text editing is still available. ${reason.message}`);
    });
    return () => {
      disposed = true;
      resize?.disconnect();
      host.current?.removeEventListener('beforeinput', guard, true);
      host.current?.removeEventListener('paste', guard, true);
      change?.dispose();
      instance?.dispose();
      model?.dispose();
      editor.current = null;
      if (apiRef?.current === handle && handle) apiRef.current = null;
    };
  }, [documentKey, attempt]);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    instance.layout();
    if (ready && handoff.current) {
      const [start, end] = handoff.current.map(offset => instance.getModel().getPositionAt(offset));
      instance.focus();
      instance.setSelection({
        startLineNumber: start.lineNumber, startColumn: start.column,
        endLineNumber: end.lineNumber, endColumn: end.column,
      });
      handoff.current = null;
    }
    instance.updateOptions({ readOnly: readOnly || loading, ariaLabel });
    const model = instance.getModel();
    const normalizedValue = value.replace(/\r\n?/g, '\n');
    if (model.getValue() !== normalizedValue) {
      const selection = instance.getSelections();
      const before = model.getValue();
      const change = textChange(before, normalizedValue);
      const from = model.getPositionAt(change.rangeOffset), to = model.getPositionAt(change.rangeOffset + change.rangeLength);
      replacing.current = true;
      instance.executeEdits('external-source', [{ range: {
        startLineNumber: from.lineNumber, startColumn: from.column,
        endLineNumber: to.lineNumber, endColumn: to.column,
      }, text: change.text }]);
      replacing.current = false;
      if (selection) instance.setSelections(selection);
    }
  }, [value, readOnly, loading, ariaLabel, ready]);

  return <div className="latex-editor" onKeyDownCapture={shortcut} data-language="latex">
    <span ref={metricsProbe} className="latex-editor-metrics" aria-hidden="true" />
    <div ref={host} className="latex-editor-host" hidden={!ready} />
    {!ready && <textarea ref={fallback} className="latex-editor-fallback"
      aria-label={ariaLabel} aria-describedby="source-shortcuts"
      value={value} readOnly={readOnly} disabled={loading} maxLength={100000}
      spellCheck={false} autoCapitalize="off" autoCorrect="off"
      onChange={event => {
        if (validSource(event.target.value)) { setError(''); onChange(event.target.value); }
        else setError('Source must be valid text, at most 100,000 characters. The last edit was not accepted.');
      }} />}
    {error && <div className="latex-editor-error" role="alert">{error}
      {!ready && <button type="button" onClick={() => setAttempt(count => count + 1)}>Retry enhanced editor</button>}
    </div>}
  </div>;
}
