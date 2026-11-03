import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFonts, usesFontspec, fontSource, fontFace, GoogleFontLoader } from '../src/google-fonts.js';
import { trustedFontUrl, fontAlias, MAX_FONT_BYTES, readBounded } from '../src/font-policy.js';
import { googleFontMetadata } from '../server/fonts.js';
import { LatexCompiler } from '../src/compiler.js';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

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
    String.raw`\setmainfont[Path=../]{Roboto}`, String.raw`\setmainfont{Roboto}[Scale=200]`,
    String.raw`\newfontfamily\name{\computed}`, String.raw`\setmainfont{Roboto`,
  ]) assert.throws(() => detectFonts(declaration));
  assert.deepEqual(detectFonts(String.raw`\documentclass{article}\begin{document}No fonts.\end{document}`), []);
});

test('fontspec without declarations selects native defaults, never an implicit Google family', async () => {
  const input = String.raw`\RequirePackage [no-math] {fontspec}\defaultfontfeatures{Ligatures=TeX}\begin{document}Default.\end{document}`;
  assert.deepEqual(detectFonts(input), []);
  assert.equal(usesFontspec(input), true);
  assert.equal(usesFontspec(String.raw`% \usepackage{fontspec}`), false);
  const prepared = await new GoogleFontLoader({ fetcher: () => { throw new Error('Must stay local'); } })
    .prepare(input, [], new AbortController().signal, () => {});
  assert.deepEqual(prepared.files, []);
  assert.ok(prepared.source.endsWith(input));
  let engine;
  const compiler = new LatexCompiler({ workerFactory: name => {
    engine = name;
    return { terminate() {}, postMessage() {} };
  } });
  const result = compiler.compile(input).catch(error => error.message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine, 'xetex');
  compiler.cancel();
  assert.equal(await result, 'Compilation cancelled.');
});

test('standard before/after options and safe features survive compilation-only rewriting', async () => {
  const input = String.raw`\setmainfont[Scale=1.1]{Roboto}[BoldFont={Roboto Bold},Ligatures={TeX,Common},Numbers=Lining]
\newfontfamily{\serif}{Crimson Pro}[Scale=MatchLowercase,LetterSpace=2,Color=112233,Renderer=OpenType]
\fontspec{Lato}[BoldFont={}]`;
  const declarations = detectFonts(input);
  assert.equal(declarations[0].faces.BoldFont.family, 'Roboto Bold');
  assert.equal(declarations[2].faces.BoldFont, null);
  assert.deepEqual(declarations[0].features, ['Scale={1.1}', 'Ligatures={TeX,Common}', 'Numbers={Lining}']);
  const loader = new GoogleFontLoader({ cacheStorage: undefined, fetcher: async endpoint => {
    const query = new URL(endpoint, 'http://local').searchParams;
    return endpoint.startsWith('/api') ? Response.json({ url, family: query.get('family'), weight: Number(query.get('weight')), italic: query.get('italic') === '1' }) : new Response(ttf);
  } });
  const prepared = await loader.prepare(input, declarations, new AbortController().signal, () => {});
  assert.match(prepared.source, /Scale=\{1.1\},Ligatures=\{TeX,Common\},Numbers=\{Lining\}/);
  assert.match(prepared.source, /\\newfontfamily\{\\serif\}\[/);
  assert.equal(prepared.source.includes('{Roboto}['), false);
  assert.equal(input.includes('googlefont'), false);
  for (const options of ['Path=../', 'Extension=.ttf', 'Mapping=https://evil.test', 'Scale=0', 'LetterSpace=999', String.raw`Scale=\computed`, 'RawFeature=+xxxx']) {
    assert.throws(() => detectFonts(`\\setmainfont{Roboto}[${options}]`), /Unsupported fontspec option/);
    assert.throws(() => detectFonts(`\\defaultfontfeatures{${options}}`), /Unsupported fontspec option/);
  }
});

test('bounded unconditional literal macros resolve before use, including style names and aliases', () => {
  const input = String.raw`\newcommand{\mainfont}{Roboto}
\providecommand*{\mainfont}{Lato}
\def\boldfont{Roboto Bold}
\newcommand\alias[0]{\mainfont}
\setmainfont[BoldFont={\boldfont}]{\alias}
\renewcommand{\mainfont}{Crimson Pro}
\newfontfamily\serif{\mainfont}`;
  const declarations = detectFonts(input);
  assert.equal(declarations[0].faces.UprightFont.family, 'Roboto');
  assert.equal(declarations[0].faces.BoldFont.family, 'Roboto Bold');
  assert.equal(declarations[1].faces.UprightFont.family, 'Crimson Pro');
  for (const definition of [
    String.raw`\newcommand{\fontname}[1]{Roboto}`,
    String.raw`\def\fontname#1{Roboto}`,
    String.raw`{\def\fontname{Roboto}}`,
    String.raw`\iftrue\def\fontname{Roboto}\fi`,
    String.raw`\edef\fontname{Roboto}`,
    String.raw`\def\fontname{\fontname}`,
    String.raw`\def\fontname{Roboto}\let\fontname\unknown`,
    String.raw`\def*\fontname{Roboto}`,
  ]) assert.throws(() => detectFonts(definition + String.raw`\setmainfont{\fontname}`), /macro|literal aliases/);
  assert.throws(() => detectFonts(String.raw`\setmainfont{\later}\def\later{Roboto}`), /before the font declaration/);
  assert.throws(() => detectFonts(String.raw`\def\fontname{https://evil.test/a.ttf}\setmainfont{\fontname}`), /URLs, paths/);
  const aliases = Array.from({ length: 9 }, (_, index) => `\\def\\font${String.fromCharCode(65 + index)}{\\font${String.fromCharCode(66 + index)}}`).join('');
  assert.throws(() => detectFonts(`${aliases}\\def\\fontJ{Roboto}\\setmainfont{\\fontA}`), /eight literal aliases/);
});

test('raw kerning and ligature switches preserve their exact OpenType semantics', async () => {
  const input = String.raw`\newfontfamily\body[RawFeature={-kern,-liga,-clig}]{Roboto}`;
  const declarations = detectFonts(input);
  assert.deepEqual(declarations[0].features, ['RawFeature={-kern,-liga,-clig}']);
  const loader = new GoogleFontLoader({ cacheStorage: undefined, fetcher: async endpoint => {
    const query = new URL(endpoint, 'http://local').searchParams;
    return endpoint.startsWith('/api') ? Response.json({ url, family: query.get('family'), weight: Number(query.get('weight')), italic: query.get('italic') === '1' }) : new Response(ttf);
  } });
  const prepared = await loader.prepare(input, declarations, new AbortController().signal, () => {});
  assert.match(prepared.source, /RawFeature=\{-kern,-liga,-clig\}/);
  for (const value of ['+xxxx', '-kern;file=x', String.raw`\computed`, 'kern', '+liga=0', '../file']) {
    assert.throws(() => detectFonts(`\\fontspec[RawFeature={${value}}]{Roboto}`), /Unsupported fontspec option/);
  }
});

test('conventional virtual filenames resolve exact Google family/style without fetching paths', async () => {
  const input = String.raw`\newfontfamily\regular[Path=fonts/,RawFeature={-kern,-liga,-clig}]{Roboto-Regular.ttf}
\newfontfamily\bold{Roboto-Bold.ttf}[Path=fonts/]
\newfontfamily\italic[Path=fonts/]{Roboto-BoldItalic.ttf}
\newfontfamily\heading[Path=fonts/]{CrimsonPro-Regular.ttf}`;
  const declarations = detectFonts(input);
  assert.deepEqual(declarations.map(item => [item.faces.UprightFont.family, item.faces.UprightFont.weight, item.faces.UprightFont.italic]),
    [['Roboto', 400, false], ['Roboto', 700, false], ['Roboto', 700, true], ['Crimson Pro', 400, false]]);
  assert.equal(fontFace('OpenSans-Italic.ttf').family, 'Open Sans');
  const requests = [];
  const loader = new GoogleFontLoader({ cacheStorage: undefined, fetcher: async endpoint => {
    requests.push(endpoint);
    const query = new URL(endpoint, 'http://local').searchParams;
    return endpoint.startsWith('/api') ? Response.json({ url, family: query.get('family'), weight: Number(query.get('weight')), italic: query.get('italic') === '1' }) : new Response(ttf);
  } });
  const prepared = await loader.prepare(input, declarations, new AbortController().signal, () => {});
  assert.equal(requests.some(endpoint => endpoint.includes('fonts/') || endpoint.includes('Roboto-Bold.ttf')), false);
  assert.equal(prepared.source.includes('Path='), false);
  assert.match(prepared.source, /RawFeature=\{-kern,-liga,-clig\}/);
  assert.ok(input.includes('Path=fonts/'));
  for (const name of ['Roboto.ttf', 'Roboto-Bold-Unknown.ttf', 'IBM-PlexSans-Regular.ttf', '../Roboto-Regular.ttf', 'fonts/Roboto-Regular.ttf', 'https://example.com/Roboto-Regular.ttf']) {
    assert.throws(() => fontFace(name));
  }
  for (const path of ['../', 'C:/fonts/', 'https://example.com/', String.raw`\computed`]) {
    assert.throws(() => detectFonts(`\\setmainfont[Path=${path}]{Roboto-Regular.ttf}`));
  }
  assert.throws(() => detectFonts(String.raw`\defaultfontfeatures{Path=fonts/}`));
  const styledInput = String.raw`\newfontfamily\boldface{Roboto-Bold.ttf}\newfontfamily\italicface{Roboto-Italic.ttf}\textbf{Sample}\textit{Sample}`;
  const styledDeclarations = detectFonts(styledInput);
  await loader.prepare(styledInput, styledDeclarations, new AbortController().signal, () => {});
  assert.equal(styledDeclarations[0].faces.ItalicFont.weight, 700);
  assert.equal(styledDeclarations[1].faces.BoldFont.italic, true);
});

test('native converter resolves bundled absolute OTF paths only through its static manifest', async () => {
  const self = { location: { href: 'https://app.test/compiler/dvipdf-worker.js?v=fontspec-3', pathname: '/compiler/dvipdf-worker.js', search: '?v=fontspec-3', origin: 'https://app.test' }, postMessage() {} };
  const fetches = [];
  self.fetch = url => fetches.push(url);
  const imports = [];
  const scope = { self, URL, importScripts: url => imports.push(url) };
  runInNewContext(await readFile(new URL('../public/compiler/native-manifest.js', import.meta.url), 'utf8'), scope);
  const requests = [];
  self.XMLHttpRequest = class {
    open(method, url) { requests.push(url); }
    send() { this.status = 200; }
  };
  runInNewContext(await readFile(new URL('../public/compiler/native-package-loader.js', import.meta.url), 'utf8'), scope);
  assert.deepEqual(imports, ['/compiler/native-manifest.js?v=fontspec-3']);
  const xhr = new self.XMLHttpRequest();
  xhr.open('GET', 'https://texlive.texlyre.org/xetex/47//tex/lmroman10-regular.otf');
  xhr.send();
  assert.equal(xhr.status, 200);
  assert.equal(xhr.getResponseHeader(), 'lmroman10-regular.otf');
  assert.deepEqual(requests, ['/compiler/native-tex/lmroman10-regular.otf?v=fontspec-3']);
  self.fetch('https://app.test/compiler/swiftlatexdvipdfm.wasm');
  self.fetch('https://app.test/compiler/swiftlatexxetex.wasm');
  self.fetch('https://app.test/other.wasm');
  assert.deepEqual(fetches, ['https://app.test/compiler/swiftlatexdvipdfm.wasm?v=fontspec-3', 'https://app.test/compiler/swiftlatexxetex.wasm?v=fontspec-3', 'https://app.test/other.wasm']);
  xhr.open('GET', 'https://texlive.texlyre.org/xetex/47//tex/unlisted.otf');
  xhr.send();
  assert.equal(xhr.status, 301);
  assert.equal(xhr.response, undefined);
  assert.equal(requests.length, 1);
  for (const engine of ['xetex', 'dvipdf']) {
    imports.length = 0;
    runInNewContext(await readFile(new URL(`../public/compiler/${engine}-worker.js`, import.meta.url), 'utf8'), scope);
    assert.equal(imports[0], '/compiler/native-package-loader.js?v=fontspec-3');
  }
  const children = [];
  scope.Worker = class {
    constructor(url) { this.url = url; children.push(this); }
    terminate() {}
  };
  runInNewContext(await readFile(new URL('../public/compiler/native-worker.js', import.meta.url), 'utf8'), scope);
  for (let pass = 0; pass < 2; pass++) children[0].onmessage({ data: { cmd: 'compile', result: 'ok', pdf: new ArrayBuffer(1) } });
  assert.deepEqual(children.map(child => child.url), [
    '/compiler/xetex-worker.js?v=fontspec-3', '/compiler/dvipdf-worker.js?v=fontspec-3',
  ]);
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

test('cancelled font preparation cannot dispatch obsolete input or clear a newer job', async () => {
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
  assert.equal(workers.length, 2);
  assert.equal(await first, 'Compilation cancelled.');
  compiler.cancel();
  assert.equal(await second, 'Compilation cancelled.');
  compiler.dispose();
  assert.equal(await cancelledReadiness, 'Compilation cancelled.');
});

test('font preparation uses a loading timeout and rejects oversized face counts before fetching', async () => {
  const compiler = new LatexCompiler({ timeout: 10, loadTimeout: 20, fontLoader: { prepare: async () => new Promise(() => {}) }, workerFactory: () => ({ terminate() {}, postMessage() {} }) });
  await assert.rejects(compiler.compile(source), /engine loading timed out/);
  assert.equal(compiler.active, null);
  const input = Array.from({ length: 17 }, (_, i) => `\\fontspec{Family ${i}}`).join('\n');
  const loader = new GoogleFontLoader({ fetcher: () => { throw new Error('Should not fetch'); } });
  await assert.rejects(loader.prepare(input, detectFonts(input), new AbortController().signal, () => {}), /16 distinct/);
});
