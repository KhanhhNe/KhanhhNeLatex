import test from 'node:test';
import assert from 'node:assert/strict';
import { compilationLogRuns, logLineKind } from '../src/compilation-log.js';
import { parseLog } from '../src/agent-api.js';

test('recognizes TeX errors and standard LaTeX, package, class, font and box warnings', () => {
  for (const line of ['! Undefined control sequence.', '! LaTeX Error: Missing \\begin{document}.',
    "! Package fontspec Error: The font cannot be found.", '! Emergency stop.',
    '!  ==> Fatal error occurred, no output PDF file produced!']) {
    assert.equal(logLineKind(line), 'error');
  }
  for (const line of ['LaTeX Warning: There were undefined references.',
    'LaTeX Font Warning: Some font shapes were not available, defaults substituted.',
    'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
    'Class article Warning: Unused global option(s):']) assert.equal(logLineKind(line), 'warning');
  assert.equal(logLineKind('Overfull \\hbox (10.0pt too wide) in paragraph at lines 4--5'), 'box');
  assert.equal(logLineKind('Underfull \\vbox (badness 10000) has occurred while \\output is active []'), 'box');
  assert.equal(logLineKind('Missing character: There is no X in font nullfont!'), 'font');
  for (const line of ['Output written on main.pdf (1 page).', 'warning and error in normal text',
    '(/tex/warning.sty', 'This is not a Package foo Warning: actual diagnostic', '!important']) {
    assert.equal(logLineKind(line), null);
  }
});

test('retains every character, line ending and multiline diagnostic context', () => {
  const lines = [
    'This is pdfTeX', 'Package hyperref Warning: Token not allowed in a PDF string:',
    '(hyperref)                removing a token on input line 3.',
    '                  continued message.', '', '(./main.aux)',
    '! Undefined control sequence.', 'l.8 \\missing', '          continued source', '',
    '[1]', 'Output written on main.pdf (1 page).', '',
  ];
  for (const ending of ['\n', '\r\n']) {
    const text = lines.join(ending);
    const runs = compilationLogRuns(text);
    assert.equal(runs.map(run => run.text).join(''), text);
    assert.deepEqual(runs.map(run => run.severity), [null, 'warning', null, 'error', null]);
    assert.equal(runs[1].text, lines.slice(1, 4).join(ending) + ending);
    assert.equal(runs[3].text, lines.slice(6, 9).join(ending) + ending);
  }
  assert.deepEqual(compilationLogRuns(''), []);
  assert.deepEqual(compilationLogRuns('normal\n\nlast'), [{ text: 'normal\n\nlast', severity: null }]);
});

test('shares diagnostic recognition with the agent API, including font warnings', () => {
  const text = 'LaTeX Font Warning: Font shape undefined\n  on input line 12.\n\n! Undefined control sequence.\nl.14 \\missing';
  const parsed = parseLog(text);
  assert.equal(parsed.warnings[0].line, 12);
  assert.equal(parsed.errors[0].line, 14);
  assert.deepEqual(compilationLogRuns(text).map(run => run.severity), ['warning', null, 'error']);
});

test('does not interpret markup-looking log content or emit one run per normal line', () => {
  const text = '<script>alert(1)</script>\n! LaTeX Error: <img src=x onerror=alert(1)>\n\n';
  assert.equal(compilationLogRuns(text).map(run => run.text).join(''), text);
  const long = 'ordinary output\n'.repeat(24000);
  assert.deepEqual(compilationLogRuns(long), [{ text: long, severity: null }]);
});
