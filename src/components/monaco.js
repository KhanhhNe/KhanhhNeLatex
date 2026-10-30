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
      [/\\\[/, { token: 'keyword', next: '@displayMath' }],
      [/\$\$/, { token: 'keyword', next: '@displayMath' }],
      [/\$/, { token: 'keyword', next: '@inlineMath' }],
      [/\\[a-zA-Z@]+|\\./, 'type'],
      [/\{/, { token: 'delimiter', next: '@argument' }],
      [/[}[\]()]/, 'delimiter'],
      [/[&#_^]/, 'operator'],
    ],
    argument: [
      [/%.*$/, 'comment'],
      [/\\[a-zA-Z@]+|\\./, 'type'],
      [/\{/, { token: 'delimiter', next: '@push' }],
      [/\}/, { token: 'delimiter', next: '@pop' }],
      [/[^\\{}%]+/, 'string'],
    ],
    inlineMath: [
      [/\$/, { token: 'keyword', next: '@pop' }],
      [/[^$]+/, 'keyword'],
    ],
    displayMath: [
      [/\\\]|\$\$/, { token: 'keyword', next: '@pop' }],
      [/[^\\$]+|\\.|./, 'keyword'],
    ],
  },
});
monaco.editor.defineTheme('folio', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '95A2AB' },
    { token: 'type', foreground: 'A0D4CE' },
    { token: 'keyword', foreground: 'C7A9E8' },
    { token: 'string', foreground: 'E4D18B' },
    { token: 'delimiter', foreground: 'E4D18B' },
    { token: 'operator', foreground: 'C7A9E8' },
  ],
  colors: {
    'editor.background': '#182027',
    'editor.foreground': '#E2E8ED',
    'editorLineNumber.foreground': '#91A0AC',
    'editorLineNumber.activeForeground': '#D7E4ED',
    'editor.selectionBackground': '#3C5368',
    'editor.inactiveSelectionBackground': '#30414E',
    'editorCursor.foreground': '#D5E4EE',
    'editor.lineHighlightBackground': '#1D2932',
    'editor.lineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': '#35424C',
    'editorIndentGuide.activeBackground1': '#617582',
    'editorWidget.background': '#232D35',
    'editorWidget.border': '#52626F',
    'input.background': '#182027',
    'input.foreground': '#E2E8ED',
    'input.border': '#637583',
    'editorGutter.background': '#182027',
    'scrollbarSlider.background': '#879EAD40',
    'scrollbarSlider.hoverBackground': '#879EAD65',
    'focusBorder': '#ABC6D8',
  },
});

export { monaco };
