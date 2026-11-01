import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFonts, fontSource, fontFace, GoogleFontLoader } from '../src/google-fonts.js';
import { trustedFontUrl, fontAlias, MAX_FONT_BYTES, readBounded } from '../src/font-policy.js';
import { googleFontMetadata } from '../server/fonts.js';
import { LatexCompiler } from '../src/compiler.js';

const url = 'https://fonts.gstatic.com/s/example/v1/example.ttf';
const ttf = new Uint8Array(40); ttf[1] = 1; ttf[5] = 1;
new DataView(ttf.buffer).setUint32(12, 0x68656164);
new DataView(ttf.buffer).setUint32(20, 28);
new DataView(ttf.buffer).setUint32(24, 12);
const source = String.raw`\usepackage{fontspec}\setmainfont[BoldFont={Roboto Bold}]{Roboto}\newfontfamily\serif{Crimson Pro}\textbf{Bold}`;

test('font parser ignores comments, verbatim, escaped commands and preserves offsets', () => {
  const input = String.raw`% \setmainfont{Fake}
\verb|\setmainfont{Ignored}|
\begin{verbatim}\setmainfont{Ignored}\end{verbatim}
\\setmainfont{Plain text}
\setmainfont[BoldFont={Roboto Bold}]{Roboto}
\newfontfamily{\crimson}{Crimson Pro}`;
  const declarations = detectFonts(input);
  assert.equal(declarations.length, 2);
  assert.equal(declarations[0].faces.BoldFont.family, 'Roboto Bold');
  assert.equal(declarations[1].faces.UprightFont.family, 'Crimson Pro');
  assert.equal(fontSource(input).length, input.length);
  assert.equal(input.slice(declarations[0].start, declarations[0].end), String.raw`\setmainfont[BoldFont={Roboto Bold}]{Roboto}`);
});

test('ignored-region scanning stays bounded for many unclosed verbatim starts', () => {
  const input = String.raw`\begin{verbatim}`.repeat(6000);
  const started = performance.now();
  assert.equal(detectFonts(input).length, 0);
  assert.ok(performance.now() - started < 500);
  assert.throws(() => detectFonts(`\\setmainfont[${'BoldFont=X,'.repeat(100)}]{Roboto}`), /512-character/);
});

test('generic families and style suffixes work, unsafe/computed declarations fail before network', () => {
  assert.deepEqual(fontAlias('Libre Baskerville SemiBold Italic'), { family: 'Libre Baskerville', weight: 600, italic: true });
  assert.equal(fontFace('Archivo Black').family, 'Archivo Black');
  for (const name of ['https://evil.test/font', '../font.ttf', String.raw`\fontname`, 'x'.repeat(81)]) assert.throws(() => fontFace(name));
  for (const declaration of [
    String.raw`\setmainfont[Path=../]{Roboto}`, String.raw`\setmainfont{Roboto}[Scale=2]`,
    String.raw`\newfontfamily\name{\computed}`, String.raw`\setmainfont{Roboto`,
  ]) assert.throws(() => detectFonts(declaration));
  assert.deepEqual(detectFonts(String.raw`\documentclass{article}\begin{document}No fonts.\end{document}`), []);
});

test('font URL constraints reject credentials, redirects, paths, queries and non-TTF formats', () => {
  assert.equal(trustedFontUrl(url), true);
  for (const candidate of [
    'http://fonts.gstatic.com/s/a/v1/a.ttf', 'https://evil.test/s/a/v1/a.ttf',
    'https://fonts.gstatic.com.evil.test/s/a/v1/a.ttf', 'https://u@fonts.gstatic.com/s/a/v1/a.ttf',
    'https://fonts.gstatic.com/s/a/v1/a.woff2', `${url}?text=private`, `${url}#fragment`,
  ]) assert.equal(trustedFontUrl(candidate), false);
});

test('metadata resolver sends only validated family/styles to a fixed trusted Google URL', async () => {
  const requests = [];
  const fetcher = async (endpoint, options) => {
    requests.push({ endpoint, options });
    return new Response(`@font-face {font-family: 'Lato';font-weight: 700;font-style: normal;src: url(${url}) format('truetype');}`);
  };
  const result = await googleFontMetadata({ family: 'Lato', weight: '700', italic: '0' }, fetcher);
  assert.equal(result.status, 200);
  assert.equal(result.url, url);
  assert.equal(new URL(requests[0].endpoint).origin, 'https://fonts.googleapis.com');
  assert.equal(new URL(requests[0].endpoint).searchParams.get('family'), 'Lato:700');
  assert.equal(requests[0].options.redirect, 'manual');
  for (const query of [
    { family: 'https://evil.test', weight: '400', italic: '0' },
    { family: 'Lato', weight: ['400'], italic: '0' },
    { family: 'Lato', weight: '1000', italic: '0' },
  ]) assert.equal((await googleFontMetadata(query, fetcher)).status, 400);
  assert.equal(requests.length, 1);
  assert.equal((await googleFontMetadata({ family: 'Missing', weight: '400', italic: '0' }, async () => new Response('', { status: 400 }))).status, 404);
  assert.equal((await googleFontMetadata({ family: 'Lato', weight: '400', italic: '0' }, async () => new Response('woff2 only'))).status, 422);
});

test('exact family names ending in style words win over aliases, while explicit Roboto Bold resolves correctly', async () => {
  const query = { weight: '400', italic: '0' };
  const requested = [];
  const fetcher = async endpoint => {
    const name = new URL(endpoint).searchParams.get('family');
    requested.push(name);
    if (name === 'Roboto Bold:400') return new Response('', { status: 400 });
    const weight = name.endsWith(':700') ? 700 : 400;
    return new Response(`@font-face {font-weight: ${weight};font-style: normal;src: url(${url}) format('truetype');}`);
  };
  assert.equal((await googleFontMetadata({ ...query, family: 'Archivo Black' }, fetcher)).status, 200);
  assert.deepEqual(requested, ['Archivo Black:400']);
  assert.equal((await googleFontMetadata({ ...query, family: 'Roboto Bold' }, fetcher)).status, 200);
  assert.deepEqual(requested.slice(1), ['Roboto Bold:400', 'Roboto:700']);
});

test('font preparation deduplicates faces, caches bytes, and changes only compile input', async () => {
  const requests = [];
  const loader = new GoogleFontLoader({ cacheStorage: undefined, fetcher: async (endpoint, options) => {
    requests.push(endpoint);
    assert.equal(options.credentials, 'omit');
    if (endpoint.startsWith('/api/fonts')) {
      const query = new URL(endpoint, 'http://local').searchParams;
      return Response.json({ url, family: query.get('family'), weight: Number(query.get('weight')), italic: query.get('italic') === '1' });
    }
    return new Response(ttf);
  } });
  const controller = new AbortController();
  const input = source + String.raw`\newfontfamily\second{Roboto}`;
  const prepared = await loader.prepare(input, detectFonts(input), controller.signal, () => {});
  assert.equal(prepared.files.length, 5);
  assert.equal(requests.length, 6);
  assert.match(prepared.source, /BoldFont=googlefont1.ttf/);
  assert.match(prepared.source, /\\newfontfamily\\second\[BoldFont=googlefont4.ttf/);
  assert.equal(input.includes('googlefont'), false);
  await loader.prepare(input, detectFonts(input), controller.signal, () => {});
  assert.equal(requests.length, 6);
});

test('downloads reject unsafe URLs, malformed font bytes, oversized streams and service errors', async () => {
  const face = fontFace('Roboto');
  const signal = new AbortController().signal;
  for (const metadata of [
    { url: 'https://evil.test/a.ttf', family: 'Roboto', weight: 400, italic: false },
    { url, family: 'Another Family', weight: 400, italic: false },
  ]) {
    const loader = new GoogleFontLoader({ cacheStorage: undefined, fetcher: async () => Response.json(metadata) });
    await assert.rejects(loader.face(face, signal), /unsafe or mismatched/);
  }
  const loader = new GoogleFontLoader({ cacheStorage: undefined, fetcher: async endpoint => endpoint.startsWith('/api')
    ? Response.json({ url, family: 'Roboto', weight: 400, italic: false }) : new Response('not a font') });
  await assert.rejects(loader.face(face, signal), /TrueType/);
  const variable = ttf.slice(); new DataView(variable.buffer).setUint32(12, 0x66766172);
  const variableLoader = new GoogleFontLoader({ cacheStorage: undefined, fetcher: async endpoint => endpoint.startsWith('/api')
    ? Response.json({ url, family: 'Roboto', weight: 400, italic: false }) : new Response(variable) });
  await assert.rejects(variableLoader.face(face, signal), /variable font/);
  await assert.rejects(readBounded(new Response(new Uint8Array(20)), 10), /download limit/);
  await assert.rejects(readBounded(new Response('', { headers: { 'Content-Length': String(MAX_FONT_BYTES + 1) } }), MAX_FONT_BYTES), /download limit/);
  const missing = new GoogleFontLoader({ cacheStorage: undefined, fetcher: async () => Response.json({ error: 'Missing style.' }, { status: 404 }) });
  await assert.rejects(missing.face(face, signal), /Missing style/);
});

test('cancelled font preparation cannot create a worker or clear a newer job', async () => {
  let release;
  const fontLoader = { prepare: async () => new Promise(resolve => { release = resolve; }) };
  const workers = [];
  const compiler = new LatexCompiler({ fontLoader, workerFactory: () => {
    const worker = { terminate() {}, postMessage() {} }; workers.push(worker); return worker;
  } });
  const first = compiler.compile(source).catch(error => error.message);
  const cancelledReadiness = compiler.warmup().catch(error => error.message);
  const second = compiler.compile('normal').catch(error => error.message);
  const active = compiler.active;
  release({ source: 'obsolete', files: [] });
  await Promise.resolve();
  assert.equal(compiler.active, active);
  assert.equal(workers.length, 1);
  assert.equal(await first, 'Compilation cancelled.');
  assert.equal(await cancelledReadiness, 'Compilation cancelled.');
  compiler.cancel();
  assert.equal(await second, 'Compilation cancelled.');
});

test('font preparation timeout and oversized face counts fail before worker startup', async () => {
  const compiler = new LatexCompiler({ timeout: 10, fontLoader: { prepare: async () => new Promise(() => {}) }, workerFactory: () => { throw new Error('Should not start'); } });
  await assert.rejects(compiler.compile(source), /timed out/);
  assert.equal(compiler.active, null);
  const input = Array.from({ length: 17 }, (_, i) => `\\fontspec{Family ${i}}`).join('\n');
  const loader = new GoogleFontLoader({ fetcher: () => { throw new Error('Should not fetch'); } });
  await assert.rejects(loader.prepare(input, detectFonts(input), new AbortController().signal, () => {}), /16 distinct/);
});
