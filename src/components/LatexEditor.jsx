import React, { useEffect, useRef, useState } from 'react';
import './LatexEditor.css';

const validSource = value => value.length <= 100000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(value);
let engine;
export const preloadLatexEditor = () => engine ||= import('./monaco.js').catch(error => {
  engine = null;
  throw error;
});

export default function LatexEditor({
  value, onChange, onSave, onCompile, ariaLabel = 'LaTeX source',
  documentKey, readOnly = false, loading = false,
}) {
  const host = useRef(null);
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
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const instance = editor.current;
      if (instance) {
        const lines = instance.getSelections().reduce((count, range) => count + range.endLineNumber - range.startLineNumber + 1, 0);
        if (instance.getModel().getValueLength() + lines * 2 > 100000) {
          event.preventDefault();
          event.stopPropagation();
          setError('Source must be valid text, at most 100,000 characters. The last edit was not accepted.');
        }
      } else if (fallback.current && !loading && !readOnly) {
        event.preventDefault();
        const input = fallback.current;
        if (input.value.length - (input.selectionEnd - input.selectionStart) + 2 <= 100000) {
          const position = input.selectionStart + 2;
          const next = input.value.slice(0, input.selectionStart) + '  ' + input.value.slice(input.selectionEnd);
          onChange(next);
          requestAnimationFrame(() => input.setSelectionRange(position, position));
        }
      }
      return;
    }
    if (event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const controls = [...document.querySelectorAll('button,a[href],input,textarea,[tabindex="0"]')]
        .filter(control => !control.disabled && control.getClientRects().length && !control.closest('[inert]'));
      const before = controls.filter(control => !event.currentTarget.contains(control) &&
        Boolean(control.compareDocumentPosition(event.currentTarget) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
      if (before) { event.preventDefault(); event.stopPropagation(); before.focus(); }
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
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
    let instance, model, change, resize, guard;
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
        fontFamily: '"Cascadia Code", Consolas, "Liberation Mono", monospace',
        fontSize: 14, lineHeight: 24, tabSize: 2, insertSpaces: true,
        minimap: { enabled: false }, wordWrap: 'off',
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
        automaticLayout: false, contextmenu: false,
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
      change = model.onDidChangeContent(() => {
        if (replacing.current) return;
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
        latest.current.onChange(next);
      });
      resize = new ResizeObserver(() => {
        if (host.current?.clientWidth && host.current?.clientHeight) {
          const fontSize = (innerWidth <= 1050 ? 16 : 14) * parseFloat(getComputedStyle(document.documentElement).fontSize) / 16;
          if (instance.getOption(monaco.editor.EditorOption.fontSize) !== fontSize)
            instance.updateOptions({ fontSize, lineHeight: Math.round(fontSize * 1.7) });
          instance.layout();
        }
      });
      resize.observe(host.current);
      instance.layout();
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
    if (model.getValue() !== value) {
      const selection = instance.getSelections();
      replacing.current = true;
      instance.executeEdits('external-source', [{ range: model.getFullModelRange(), text: value }]);
      replacing.current = false;
      if (selection) instance.setSelections(selection);
    }
  }, [value, readOnly, loading, ariaLabel, ready]);

  return <div className="latex-editor" onKeyDownCapture={shortcut} data-language="latex">
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
