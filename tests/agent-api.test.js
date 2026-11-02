import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_METHODS, createAgentApi, findText, insertLines, parseLog, readLines, replaceLines, replaceText, toBase64, validateSource,
} from '../src/agent-api.js';

const source = 'one\ntwo\nthree\nfour';

test('reads, replaces and inserts 1-based inclusive line ranges', () => {
  assert.equal(readLines(source), source);
  assert.equal(readLines(source, { from: 2, to: 3 }), 'two\nthree');
  assert.equal(readLines(source, { from: 3, numbered: true }), '3| three\n4| four');
  assert.equal(replaceLines(source, 2, 3, 'TWO'), 'one\nTWO\nfour');
  assert.equal(insertLines(source, 1, 'zero'), 'zero\none\ntwo\nthree\nfour');
  assert.equal(insertLines(source, 5, 'five'), `${source}\nfive`);
  assert.throws(() => readLines(source, { from: 0 }), RangeError);
  assert.throws(() => readLines(source, { from: 3, to: 2 }), RangeError);
  assert.throws(() => insertLines(source, 6, 'x'), RangeError);
});

test('find and replace treat strings literally and support regex groups', () => {
  assert.deepEqual(replaceText('a.b a.b', 'a.b', '$&x'), { source: '$&x a.b', count: 1 });
  assert.deepEqual(replaceText('a.b a.b', 'a.b', 'c', { all: true }), { source: 'c c', count: 2 });
  assert.deepEqual(replaceText('Ab ab', 'ab', 'x', { all: true, caseSensitive: false }), { source: 'x x', count: 2 });
  assert.deepEqual(replaceText('x1 x2', 'x(\\d)', 'y$1', { all: true, regex: true }), { source: 'y1 y2', count: 2 });
  assert.deepEqual(replaceText('x1', /x(?<n>\d)/, '$<n>$$'), { source: '1$', count: 1 });
  assert.equal(replaceText('abc', 'z', 'y').count, 0);
  const matches = findText('\\section{A}\ntext \\section{B}', '\\section');
  assert.deepEqual(matches.map(({ line, column, offset }) => ({ line, column, offset })),
    [{ line: 1, column: 1, offset: 0 }, { line: 2, column: 6, offset: 17 }]);
  assert.equal(matches[1].text, 'text \\section{B}');
  assert.throws(() => findText(source, ''), TypeError);
});

test('validates text-only bounded source', () => {
  assert.equal(validateSource('ok\n'), 'ok\n');
  assert.throws(() => validateSource('x'.repeat(100001)), RangeError);
  assert.throws(() => validateSource('bad\u0000'), /control characters/);
  assert.throws(() => validateSource(4), TypeError);
});

test('parses TeX errors with source lines and LaTeX, package and box warnings', () => {
  const log = [
    '! Undefined control sequence.',
    'l.12 \\badmacro',
    '                {x}',
    'LaTeX Warning: Reference `x\' on page 1 undefined on input line 7.',
    'Package hyperref Warning: Token not allowed in a PDF string',
    '(hyperref)                removing `math shift\' on input line 9.',
    'Overfull \\hbox (12.0pt too wide) in paragraph at lines 20--21',
    '! Emergency stop.',
  ].join('\n');
  const { errors, warnings } = parseLog(log);
  assert.deepEqual(errors, [
    { message: 'Undefined control sequence.', line: 12, context: '\\badmacro' },
    { message: 'Emergency stop.', line: null, context: '' },
  ]);
  assert.equal(warnings.length, 3);
  assert.deepEqual(warnings[0], { type: 'warning', source: 'LaTeX', message: 'Reference `x\' on page 1 undefined on input line 7.', line: 7 });
  assert.equal(warnings[1].source, 'hyperref');
  assert.equal(warnings[1].line, 9);
  assert.equal(warnings[2].type, 'box');
  assert.equal(warnings[2].line, 20);
});

test('documents every public method in help', () => {
  const { api } = createAgentApi(() => ({}));
  const methods = Object.keys(api).filter(key => typeof api[key] === 'function');
  const documented = new Set(API_METHODS.flatMap(method => method.signature.match(/\w+(?=\()/g)));
  assert.deepEqual(methods.filter(name => !documented.has(name)), []);
  assert.match(api.help(), /latex\.compile/);
  assert.match(api.help('redo'), /undo\(\) \/ redo\(\)/);
  assert.throws(() => api.help('nope'), /Unknown method/);
  assert.equal(toBase64(new Uint8Array([37, 80, 68, 70])), 'JVBERg==');
  assert.ok(Object.isFrozen(api));
});

test('edits go through the bridge, normalize line endings and emit subscribed events only', async () => {
  let document = { id: 'a', title: 'A', source: 'hello\nworld', updated_at: 1 };
  const applied = [];
  const agent = createAgentApi(() => ({
    active: () => document,
    applySource: next => { applied.push(next); document = { ...document, source: next }; },
  }));
  const { api } = agent;
  assert.deepEqual(api.replace('world', 'there'), { count: 1 });
  api.append('\r\nend');
  assert.deepEqual(applied, ['hello\nthere', 'hello\nthere\nend']);
  assert.equal(api.read({ from: 3 }), 'end');
  assert.deepEqual(api.current().lines, 3);
  const seen = [];
  const off = api.on('compile', detail => seen.push(detail));
  agent.emit('compile', { ok: true });
  off();
  agent.emit('compile', { ok: false });
  assert.deepEqual(seen, [{ ok: true }]);
  assert.throws(() => api.on('unknown', () => {}), /Unknown event/);
  assert.throws(() => api.setSource('x'.repeat(100001)), RangeError);
  await assert.rejects(api.remove(undefined), /confirm: true/);
});

test('concurrent creates return their own identities and removing another document does not switch', async () => {
  const active = { id: 'active', title: 'Active', source: 'current' };
  const removed = [];
  const { api } = createAgentApi(() => ({
    loaded: async () => {}, rendered: async () => {},
    active: () => active,
    create: async (source, title) => ({ id: title, title, source }),
    documents: () => [active, { id: 'other', title: 'Other', source: 'other' }].map(item => ({ ...item, localAvailable: true })),
    remove: async item => { removed.push(item.id); return true; },
  }));
  const created = await Promise.all(['One', 'Two', 'Three'].map(title => api.create({ title, source: title })));
  assert.deepEqual(created.map(item => item.id), ['One', 'Two', 'Three']);
  const result = await api.remove('other', { confirm: true });
  assert.deepEqual(removed, ['other']);
  assert.equal(result.current.id, active.id);
});
