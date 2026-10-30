import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

// Only the text editor worker is needed; pdfTeX owns its separate compile worker.
globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.languages.register({ id: 'latex', extensions: ['.tex'], aliases: ['LaTeX', 'TeX'] });
monaco.languages.setLanguageConfiguration('latex', {
  comments: { lineComment: '%' },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }],
});
monaco.languages.setMonarchTokensProvider('latex', {
  tokenizer: {
    root: [
      [/%.*$/, 'comment'],
      [/\\(?:begin|end)\b/, 'keyword'],
      [/\\[a-zA-Z@]+|\\./, 'type'],
      [/[{}[\]()]/, 'delimiter'],
      [/\$\$?/, 'keyword'],
      [/[&#_^]/, 'operator'],
    ],
  },
});
monaco.editor.defineTheme('folio', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '626A73', fontStyle: 'italic' },
    { token: 'type', foreground: '51408A' },
    { token: 'keyword', foreground: '7C325C' },
    { token: 'delimiter', foreground: '405A76' },
    { token: 'operator', foreground: '80511C' },
  ],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.foreground': '#303747',
    'editorLineNumber.foreground': '#68717D',
    'editorLineNumber.activeForeground': '#51408A',
    'editor.selectionBackground': '#DDD7EF',
    'editor.inactiveSelectionBackground': '#ECE9F4',
    'editorCursor.foreground': '#5542A0',
    'editor.lineHighlightBackground': '#F7F6FA',
    'editorWidget.background': '#FFFFFF',
    'focusBorder': '#5542A0',
  },
});

export { monaco };
