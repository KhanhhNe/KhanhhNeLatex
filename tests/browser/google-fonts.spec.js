import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PDFDocument, PDFName, PDFDict, PDFRawStream } from 'pdf-lib';
import { fontAlias } from '../../src/font-policy.js';
import { fillSource, expectSource } from './source-editor.js';

const fixture = (await readFile(new URL('../fixtures/google-fonts.tex', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const fontRoot = new URL('../fixtures/fonts/', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('manifest.json', fontRoot), 'utf8'));

async function loadCompiler(page) {
  for (const file of ['compiler.js', 'google-fonts.js', 'font-policy.js']) {
    const body = await readFile(new URL(`../../src/${file}`, import.meta.url), 'utf8');
    await page.route(`**/${file === 'compiler.js' ? 'compiler-client.js' : file}`, route => route.fulfill({ contentType: 'text/javascript', body }));
  }
  await page.goto('/');
  await page.evaluate(async () => {
    const { LatexCompiler } = await import('/compiler-client.js');
    window.fontCompiler = new LatexCompiler();
  });
}

async function fontService(page) {
  if (process.env.LIVE_GOOGLE_FONTS) return;
  await page.route('**/api/fonts?*', route => {
    const query = new URL(route.request().url()).searchParams;
    const family = query.get('family');
    const weight = Number(query.get('weight'));
    const italic = query.get('italic') === '1';
    const alias = fontAlias(family);
    const face = metadata.find(face => face.family === family && face.weight === weight && face.italic === italic) ||
      (alias && metadata.find(face => face.family === alias.family && face.weight === alias.weight && face.italic === (italic || alias.italic)));
    return route.fulfill({ status: face ? 200 : 404, json: face ? { ...face, family, weight, italic } : { error: 'Google Fonts has no requested family/style.' } });
  });
  await page.route('https://fonts.gstatic.com/**', async route => {
    const face = metadata.find(face => face.url === route.request().url());
    if (!face) return route.abort();
    const body = await readFile(new URL(face.filename, fontRoot));
    expect(createHash('sha256').update(body).digest('hex')).toBe(face.sha256);
    await route.fulfill({ body, contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
}

async function inspectFonts(bytes) {
  const pdf = await PDFDocument.load(bytes);
  const fonts = pdf.getPage(0).node.Resources().lookup(PDFName.of('Font'), PDFDict);
  const result = [];
  for (const key of fonts.keys()) {
    const font = fonts.lookup(key, PDFDict);
    const descendant = font.lookup(PDFName.of('DescendantFonts')).lookup(0, PDFDict);
    const descriptor = descendant.lookup(PDFName.of('FontDescriptor'), PDFDict);
    const stream = descriptor.lookup(PDFName.of(descriptor.has(PDFName.of('FontFile2')) ? 'FontFile2' : 'FontFile3'), PDFRawStream);
    result.push({ name: font.get(PDFName.of('BaseFont')).decodeText(), embeddedBytes: stream.contents.length });
  }
  return result;
}

test('generic Google Fonts embed Roboto regular/bold, Crimson Pro and unrelated Lato; cache avoids repeat downloads', async ({ page }) => {
  await fontService(page);
  await loadCompiler(page);
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  const result = await page.evaluate(async source => {
    const statuses = [];
    const output = await window.fontCompiler.compile(source, status => statuses.push(status))
      .catch(error => { throw new Error(`${error.message}\n${error.log || ''}`); });
    const second = await window.fontCompiler.compile(source);
    const otherLoader = new window.fontCompiler.constructor();
    await otherLoader.compile(source);
    return { bytes: Array.from(new Uint8Array(output.pdf)), secondLength: second.pdf.byteLength, statuses, source };
  }, fixture);
  const bytes = new Uint8Array(result.bytes);
  const fonts = await inspectFonts(bytes);
  for (const expected of ['Roboto-Regular', 'Roboto-Bold', 'CrimsonPro-Regular', 'Lato-Regular']) {
    const font = fonts.find(font => font.name.endsWith(expected));
    expect(font, expected).toBeTruthy();
    expect(font.embeddedBytes).toBeGreaterThan(1000);
  }
  expect(requests.filter(url => url.startsWith('https://fonts.gstatic.com/'))).toHaveLength(6);
  expect(requests.filter(url => url.includes('/api/fonts?'))).toHaveLength(6);
  expect(requests.some(url => url.includes('fonts.googleapis.com') || url.includes('texlive.texlyre.org'))).toBe(false);
  expect(result.source).toBe(fixture);
  expect(result.secondLength).toBeGreaterThan(5000);
  await writeFile(test.info().outputPath('google-fonts.pdf'), bytes);
  await writeFile(test.info().outputPath('embedded-fonts.json'), JSON.stringify(fonts, null, 2));
});

test('font cancellation aborts downloads, latest normal compile stays active, and unsupported fonts fail explicitly', async ({ page }) => {
  await fontService(page);
  await loadCompiler(page);
  const result = await page.evaluate(async source => {
    const compiler = window.fontCompiler;
    const first = compiler.compile(source, status => {
      if (status.startsWith('Downloading')) compiler.cancel();
    }).catch(error => error.message);
    const normal = await compiler.compile(String.raw`\documentclass{article}\begin{document}Normal offline PDF.\end{document}`);
    const unavailable = await compiler.compile(String.raw`\documentclass{article}\usepackage{fontspec}\setmainfont{Family Does Not Exist 987654321}\begin{document}Missing.\end{document}`).catch(error => error.message);
    const invalid = await compiler.compile(String.raw`\usepackage{fontspec}\setmainfont{https://evil.test/font.ttf}`).catch(error => error.message);
    return { first: await first, normalLength: normal.pdf.byteLength, unavailable, invalid, idle: compiler.active === null };
  }, fixture);
  expect(result.first).toContain('cancelled');
  expect(result.normalLength).toBeGreaterThan(5000);
  expect(result.unavailable).toContain('no');
  expect(result.invalid).toContain('literal Google Fonts');
  expect(result.idle).toBe(true);
});

test('virtual Google filenames and raw feature switches compile native xcolor/TikZ drawings', async ({ page }) => {
  await fontService(page);
  await loadCompiler(page);
  const input = await readFile(new URL('../fixtures/native-drawing.tex', import.meta.url), 'utf8');
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  const result = await page.evaluate(async source => {
    const output = await window.fontCompiler.compile(source).catch(error => { throw new Error(`${error.message}\n${error.log || ''}`); });
    return { bytes: Array.from(new Uint8Array(output.pdf)), idle: window.fontCompiler.active === null };
  }, input);
  const bytes = new Uint8Array(result.bytes);
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  const fonts = await inspectFonts(bytes);
  for (const name of ['Roboto-Regular', 'Roboto-Bold', 'CrimsonPro-Regular']) {
    expect(fonts.some(font => font.name.endsWith(name) && font.embeddedBytes > 1000)).toBe(true);
  }
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  expect(result.idle).toBe(true);
  expect(requests.some(url => url.includes('texlive.texlyre.org') || url.includes('/fonts/Roboto'))).toBe(false);
  await writeFile(test.info().outputPath('native-drawing.pdf'), bytes);
});

test('imported fontspec documents support default native fonts, literal macros and standard feature positions', async ({ page }) => {
  await fontService(page);
  await page.goto('/#workspace');
  const compile = async source => {
    await fillSource(page, source);
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await expect(page.locator('.preview-status')).toContainText('Compiled in your browser', { timeout: 60000 });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PDF' }).click();
    return readFile(await (await download).path());
  };
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  const defaults = String.raw`\documentclass[11pt]{article}\usepackage[no-math]{fontspec}
\defaultfontfeatures{Ligatures=TeX,Mapping=tex-text}
\begin{document}Native default text. \textbf{Default bold.} \textit{Default italic.}
\textsf{Default sans. \textbf{Sans bold.} \textit{Sans italic.} \textbf{\textit{Sans bold italic.}}}
\texttt{Default mono. \textbf{Mono bold.} \textit{Mono italic.} \textbf{\textit{Mono bold italic.}}}
\textbf{\textit{Serif bold italic.}}\end{document}`;
  const native = await compile(defaults);
  const defaultFonts = await inspectFonts(native);
  expect(defaultFonts.some(font => font.name.includes('LMRoman'))).toBe(true);
  expect(defaultFonts.every(font => font.embeddedBytes > 1000)).toBe(true);
  expect(requests.some(url => url.includes('/api/fonts?') || url.startsWith('https://fonts.gstatic.com'))).toBe(false);
  await writeFile(test.info().outputPath('fontspec-defaults.pdf'), native);

  const imported = String.raw`\documentclass{article}\usepackage{fontspec}
\newcommand{\mainfont}{Roboto}
\def\boldfont{Roboto Bold}
\defaultfontfeatures{Ligatures=TeX}
\setmainfont[Scale=1.05]{\mainfont}[BoldFont={\boldfont},Numbers=Lining,Kerning=On,Script=Latin,Language=English]
\newfontfamily{\crimson}{Crimson Pro}[Scale=1.1,LetterSpace=1,Color=112233,Renderer=OpenType]
\newfontfamily\lato[Scale=MatchLowercase]{Lato}
\begin{document}Imported Roboto regular. \textbf{Imported Roboto Bold.}
{\crimson Imported Crimson Pro.} {\lato Imported Lato.}
{\fontspec{Lato}[Scale=0.9] Inline Lato.}
\end{document}`;
  const bytes = await compile(imported);
  const fonts = await inspectFonts(bytes);
  for (const name of ['Roboto-Regular', 'Roboto-Bold', 'CrimsonPro-Regular', 'Lato-Regular'])
    expect(fonts.some(font => font.name.endsWith(name) && font.embeddedBytes > 1000), name).toBe(true);
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .tex' }).click();
  expect(await readFile(await (await exported).path(), 'utf8')).toBe(imported);
  await expectSource(page, imported);
  await writeFile(test.info().outputPath('fontspec-imported.pdf'), bytes);
  await writeFile(test.info().outputPath('fontspec-imported.tex'), imported);
});

test('native engine cancellation releases descendant workers and a fresh native compile succeeds', async ({ page }) => {
  await fontService(page);
  await loadCompiler(page);
  const result = await page.evaluate(async fixture => {
    const compiler = window.fontCompiler;
    const loop = fixture.replace('\\end{document}', '\\loop\\iftrue\\repeat\\end{document}');
    const cancelled = compiler.compile(loop, status => {
      if (status === 'Typesetting locally...') setTimeout(() => compiler.cancel(), 50);
    }).catch(error => error.message);
    const message = await cancelled;
    const output = await compiler.compile(fixture).catch(error => { throw new Error(`${error.message}\n${error.log || ''}`); });
    return { message, length: output.pdf.byteLength, idle: compiler.active === null };
  }, fixture);
  expect(result.message).toBe('Compilation cancelled.');
  expect(result.length).toBeGreaterThan(5000);
  expect(result.idle).toBe(true);
});

test('bundled native Latin Modern faces remain local and missing glyphs do not produce a substitute PDF', async ({ page }) => {
  await fontService(page);
  await loadCompiler(page);
  const fontsRequests = [];
  page.on('request', request => {
    if (request.url().includes('/api/fonts?') || request.url().startsWith('https://fonts.gstatic.com')) fontsRequests.push(request.url());
  });

  const result = await page.evaluate(async () => {
    const output = await window.fontCompiler.compile(String.raw`\documentclass{article}\usepackage{fontspec}\setmainfont{Latin Modern Roman}\begin{document}Local native text. \textbf{Bold.} \textit{Italic.}\end{document}`)
      .catch(error => { throw new Error(`${error.message}\n${error.log || ''}`); });
    return Array.from(new Uint8Array(output.pdf));
  });
  const fonts = await inspectFonts(new Uint8Array(result));
  expect(fontsRequests).toEqual([]);
  expect(fonts.some(font => font.name.includes('LMRoman10'))).toBe(true);
  const failure = await page.evaluate(async () => {
    return window.fontCompiler.compile(String.raw`\documentclass{article}\usepackage{fontspec}\setmainfont{Latin Modern Roman}\begin{document}Text 😀.\end{document}`)
      .then(() => null, error => ({ message: error.message, log: error.log }));
  });
  expect(failure.message).toContain('No substitute PDF');
  expect(failure.log).toContain('Missing character');
});

test('workspace exports real embedded fonts and unchanged source, preserves last-good PDF on font errors', async ({ page }) => {
  await fontService(page);
  const writes = [];
  page.on('request', request => {
    if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.url());
  });
  await page.goto('/#workspace');
  await fillSource(page, fixture);
  await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser', { timeout: 60000 });
  await expect(page.locator('.pdf-viewer.pending')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.pdf-viewer canvas').first()).toBeVisible();
  const iframe = page.locator('.pdf-viewer[title="Compiled PDF"]');
  await expect(iframe).toBeVisible();
  const goodUrl = await iframe.getAttribute('data-src');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  const bytes = await readFile(await (await download).path());
  const fonts = await inspectFonts(bytes);
  expect(fonts.some(font => font.name.endsWith('Roboto-Bold'))).toBe(true);
  expect(fonts.some(font => font.name.endsWith('CrimsonPro-Regular'))).toBe(true);
  await writeFile(test.info().outputPath('workspace-google-fonts.pdf'), bytes);
  await page.screenshot({ path: test.info().outputPath('workspace-google-fonts.png') });
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .tex' }).click();
  expect(await readFile(await (await exported).path(), 'utf8')).toBe(fixture);
  await fillSource(page, fixture.replace('{Roboto}', '{Family Does Not Exist 987654321}'));
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.locator('.compile-log')).toContainText('no', { timeout: 30000 });
  expect(await iframe.getAttribute('data-src')).toBe(goodUrl);
  await expectSource(page, fixture.replace('{Roboto}', '{Family Does Not Exist 987654321}'));
  expect(writes).toEqual([]);
});

test('concurrent font loaders preserve the shared device cache entry limit', async ({ page }) => {
  await loadCompiler(page);
  const bytes = Array.from(await readFile(new URL('Roboto-400.ttf', fontRoot)));
  const result = await page.evaluate(async bytes => {
    const { GoogleFontLoader, fontFace } = await import('/google-fonts.js');
    await caches.delete('google-tex-fonts-v1');
    await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const family = `Test Family ${index}`;
      const url = `https://fonts.gstatic.com/s/example/v1/test${index}.ttf`;
      const loader = new GoogleFontLoader({ fetcher: async endpoint => endpoint.startsWith('/api')
        ? Response.json({ family, weight: 400, italic: false, url }) : new Response(new Uint8Array(bytes)) });
      await loader.face(fontFace(family), new AbortController().signal);
    }));
    const cache = await caches.open('google-tex-fonts-v1');
    const keys = await cache.keys();
    let total = 0;
    for (const key of keys) total += Number((await cache.match(key)).headers.get('Content-Length'));
    return { count: keys.length, total };
  }, bytes);
  expect(result.count).toBe(16);
  expect(result.total).toBeLessThanOrEqual(24 * 1024 * 1024);
});
