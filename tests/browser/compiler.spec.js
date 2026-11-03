import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Local compilation}\label{intro}
See section \ref{intro}. \[E=mc^2\]
\end{document}`;

const resumeSource = String.raw`\documentclass[11pt,letterpaper]{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\usepackage{amsmath}
\input{glyphtounicode}
\begin{document}
\section{Experience}\label{experience}
\begin{tabularx}{\textwidth}{lX}
2026 & Example role \\
\end{tabularx}
\begin{itemize}[leftmargin=*]
\item Local PDF compilation with \textcolor{NavyBlue}{T1 text} and \(x^2\).
\end{itemize}
See section \ref{experience}.
\begin{verbatim}
Local source remains local.
\end{verbatim}
\end{document}`;

async function loadCompiler(page) {
  const body = await readFile(new URL('../../src/compiler.js', import.meta.url), 'utf8');
  await page.route('**/compiler-client.js', route => route.fulfill({ contentType: 'text/javascript', body }));
  for (const file of ['google-fonts.js', 'font-policy.js', 'engine-start.js', 'compiler-version.js']) {
    const body = await readFile(new URL(`../../src/${file}`, import.meta.url), 'utf8');
    await page.route(`**/${file}`, route => route.fulfill({ contentType: 'text/javascript', body }));
  }
  await page.goto('/');
  await page.evaluate(async () => {
    const { LatexCompiler } = await import('/compiler-client.js');
    window.LatexCompiler = LatexCompiler;
  });
}

test('slow WASM and format loading do not consume the real worker compile deadline', async ({ page, context }) => {
  await loadCompiler(page);
  let formatRequests = 0;
  await context.route(/\/compiler\/(?:swiftlatexpdftex\.wasm|formats\/pdftex-[a-f0-9]+\.fmt\.gz)(?:\?v=[a-f0-9]+)?$/, async route => {
    if (route.request().url().includes('/formats/')) formatRequests++;
    await new Promise(resolve => setTimeout(resolve, 3000));
    await route.continue();
  });
  const result = await page.evaluate(async source => {
    const statuses = [];
    const compiler = new window.LatexCompiler({ timeout: 2000, loadTimeout: 30000 });
    const output = await compiler.compile(source, status => statuses.push(status));
    return {
      magic: new TextDecoder().decode(new Uint8Array(output.pdf).slice(0, 5)),
      timings: output.timings, statuses,
    };
  }, source);
  expect(result.magic).toBe('%PDF-');
  expect(result.timings.initializationMs).toBeGreaterThan(3000);
  expect(result.timings.compilationMs).toBeLessThan(2000);
  expect(result.statuses[0]).toBe('Loading browser engine...');
  expect(result.statuses).toContain('Typesetting locally...');
  expect(formatRequests).toBe(1);
});

test('real worker compiles the bundled T1 resume package subset', async ({ page }) => {
  await loadCompiler(page);
  const result = await page.evaluate(async source => {
    const compiler = new window.LatexCompiler();
    const output = await compiler.compile(source);
    const bytes = new Uint8Array(output.pdf);
    return {
      magic: new TextDecoder().decode(bytes.slice(0, 5)),
      length: bytes.length,
      log: output.log,
    };
  }, resumeSource);
  expect(result.magic).toBe('%PDF-');
  expect(result.length).toBeGreaterThan(5000);
  expect(result.log).not.toContain('undefined references');
  expect(result.log).not.toContain('Emergency stop');
});

test('one real worker compiles PDFs, recompiles, cancels and recovers from LaTeX failure', async ({ page }) => {
  const externalRequests = [];
  page.on('request', request => {
    if (request.url().startsWith('http') && new URL(request.url()).origin !== new URL(test.info().project.use.baseURL).origin)
      externalRequests.push(request.url());
  });
  await loadCompiler(page);
  const result = await page.evaluate(async source => {
    const workers = [];
    const compiler = new window.LatexCompiler({
      workerFactory: () => {
        const worker = new Worker('/compiler/worker.js');
        const record = { terminated: 0 };
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => { record.terminated++; terminate(); };
        workers.push(record);
        return worker;
      },
    });
    const pdfs = [];
    const statuses = [];
    const compile = async text => {
      const result = await compiler.compile(text, status => statuses.push(status));
      const bytes = new Uint8Array(result.pdf);
      pdfs.push({ magic: new TextDecoder().decode(bytes.slice(0, 5)), length: bytes.length, log: result.log, timings: result.timings });
    };
    const warmup = await compiler.warmup();
    await compile(source);
    await compile(source);
    const failure = await compiler.compile(String.raw`\documentclass{article}\begin{document}\notacommand\end{document}`)
      .then(() => null, error => ({ message: error.message, log: error.log }));
    await compile(String.raw`\documentclass{article}\begin{document}Other document without references.\end{document}`);
    const workersBeforeRunaway = workers.map(worker => ({ ...worker }));
    let cancelAt;
    const cancelled = compiler.compile(String.raw`\documentclass{article}\begin{document}\loop\iftrue\repeat\end{document}`, status => {
      if (status === 'Typesetting locally...') setTimeout(() => { cancelAt = performance.now(); compiler.cancel(); }, 25);
    }).then(() => null, error => error.message);
    const cancellation = await cancelled;
    const cancelLatency = performance.now() - cancelAt;
    await compile(source);
    const workersAfterRunaway = workers.map(worker => ({ ...worker }));
    compiler.dispose();
    return { pdfs, warmup, failure, cancellation, cancelLatency, workersBeforeRunaway, workersAfterRunaway, workers, statuses, active: compiler.active };
  }, source);
  expect(result.pdfs).toHaveLength(4);
  for (const pdf of result.pdfs) {
    expect(pdf.magic).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.log).not.toContain('undefined references');
    expect(pdf.timings.compilationMs).toBeGreaterThan(0);
    expect(pdf.timings.totalMs).toBeGreaterThanOrEqual(pdf.timings.compilationMs);
    expect(pdf.timings.initializationMs).toBeGreaterThanOrEqual(0);
  }
  expect(result.warmup.initializationMs).toBeGreaterThan(0);
  for (const pdf of result.pdfs.slice(0, 3)) expect(pdf.timings.initializationMs).toBe(0);
  expect(result.pdfs[3].timings.compilationMs).toBeGreaterThan(0);
  expect(result.failure.message).toContain('LaTeX could not compile');
  expect(result.failure.log).toContain('Undefined control sequence');
  expect(result.cancellation).toBe('Compilation cancelled.');
  expect(result.cancelLatency).toBeLessThan(2000);
  // Normal compiles, LaTeX errors and another document all reuse the first engine.
  expect(result.workersBeforeRunaway).toEqual([{ terminated: 0 }]);
  // Only a cancelled runaway loop that never returns is replaced, in the background.
  expect(result.workersAfterRunaway).toEqual([{ terminated: 1 }, { terminated: 0 }]);
  expect(result.workers).toEqual([{ terminated: 1 }, { terminated: 1 }]);
  expect(result.statuses.filter(status => status === 'Resolving references...')).toHaveLength(4);
  expect(result.active).toBeNull();
  expect(externalRequests).toEqual([]);
});

test('real engine isolates documents: aux, written files and the shared package cache never reach the next', async ({ page }) => {
  await loadCompiler(page);
  const result = await page.evaluate(async () => {
    const compiler = new window.LatexCompiler({ workerFactory: () => new Worker('/compiler/worker.js') });
    const first = await compiler.compile(String.raw`\documentclass{article}\begin{document}\section{Alpha}\label{shared}See \ref{shared}.\newwrite\f\immediate\openout\f=leak.tex\immediate\write\f{LEAKED}\immediate\closeout\f\end{document}`);
    const poison = await compiler.compile(String.raw`\documentclass{article}\begin{document}x\newwrite\g\immediate\openout\g=/tex/article.cls\immediate\write\g{\noexpand\errmessage{POISONED}}\immediate\closeout\g\newwrite\h\immediate\openout\h=/tmp/leak.tex\immediate\write\h{LEAKED}\immediate\closeout\h\end{document}`)
      .then(() => 'compiled', error => error.log);
    const second = await compiler.compile(String.raw`\documentclass{article}\begin{document}Ref: \ref{shared}. \IfFileExists{leak.tex}{\typeout{FOUND-LEAK}}{\typeout{NO-LEAK}}\IfFileExists{/tmp/leak.tex}{\typeout{FOUND-TMP}}{\typeout{NO-TMP}}\end{document}`);
    compiler.dispose();
    return { first: first.log, poison, second: second.log, magic: new TextDecoder().decode(new Uint8Array(second.pdf).slice(0, 5)) };
  });
  expect(result.first).not.toContain('undefined references');
  expect(result.poison).not.toContain('POISONED');
  expect(result.magic).toBe('%PDF-');
  expect(result.second).toContain('undefined references');
  expect(result.second).not.toContain('POISONED');
  expect(result.second).toContain('NO-LEAK');
  expect(result.second).toContain('NO-TMP');
});

test('superseded requests share one worker, never overlap, and stale results cannot reach the latest job', async ({ page }) => {
  await loadCompiler(page);
  const result = await page.evaluate(async () => {
    class WorkerStub {
      messages = [];
      terminated = 0;
      postMessage(message) { this.messages.push(message); }
      terminate() { this.terminated++; }
    }
    const workers = [];
    const compiler = new window.LatexCompiler({ drainTimeout: 60000, workerFactory: () => {
      const worker = new WorkerStub();
      workers.push(worker);
      return worker;
    } });
    const worker = () => workers[0];
    const reply = data => worker().onmessage({ data });
    const first = compiler.compile('first').catch(error => error.message);
    const second = compiler.compile('second').catch(error => error.message);
    const third = compiler.compile('third').catch(error => error.message);
    const postsBeforeReady = worker().messages.length;
    reply({ result: 'ok' });
    await compiler.warmup();
    const startedThird = worker().messages.slice();
    const fourth = compiler.compile('fourth');
    const fourth_ = compiler.active;
    const postsWhileDraining = worker().messages.length;
    reply({ cmd: 'compile', result: 'ok', status: 0, pdf: new ArrayBuffer(3) });
    const fourthStillActive = compiler.active === fourth_;
    const startedFourth = worker().messages.slice(postsWhileDraining);
    reply({ cmd: 'compile', result: 'ok', status: 0, pdf: new ArrayBuffer(8) });
    reply({ cmd: 'compile', result: 'ok', status: 0, pdf: new ArrayBuffer(16) });
    const done = await fourth;
    const statuses = [await first, await second, await third];
    compiler.dispose();
    return {
      statuses, postsBeforeReady, startedThird, postsWhileDraining, fourthStillActive, startedFourth, bytes: done.pdf.byteLength,
      workers: workers.length, terminated: workers[0].terminated, active: compiler.active,
    };
  });
  expect(result.statuses).toEqual(['Compilation cancelled.', 'Compilation cancelled.', 'Compilation cancelled.']);
  expect(result.postsBeforeReady).toBe(0);
  expect(result.startedThird).toEqual([
    { cmd: 'flushcache' }, { cmd: 'writefile', url: 'main.tex', src: 'third' }, { cmd: 'setmainfile', url: 'main.tex' }, { cmd: 'compilelatex' },
  ]);
  // The fourth document waits for the superseded run to return instead of overlapping with it.
  expect(result.postsWhileDraining).toBe(4);
  expect(result.fourthStillActive).toBe(true);
  expect(result.startedFourth).toEqual([
    { cmd: 'flushcache' }, { cmd: 'writefile', url: 'main.tex', src: 'fourth' }, { cmd: 'setmainfile', url: 'main.tex' }, { cmd: 'compilelatex' },
  ]);
  expect(result.bytes).toBe(16);
  expect(result.workers).toBe(1);
  expect(result.terminated).toBe(1);
  expect(result.active).toBeNull();
});

test('a timed-out real worker is replaced in the background and the next document compiles', async ({ page }) => {
  await loadCompiler(page);
  const result = await page.evaluate(async source => {
    let created = 0;
    let terminated = 0;
    const compiler = new window.LatexCompiler({ timeout: 2000, workerFactory: () => {
      created++;
      const worker = new Worker('/compiler/worker.js');
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { terminated++; terminate(); };
      return worker;
    } });
    const failure = await compiler.compile(String.raw`\documentclass{article}\begin{document}\loop\iftrue\repeat\end{document}`)
      .then(() => null, error => error.message);
    const idleAfterTimeout = compiler.active === null;
    const replacedImmediately = created === 2 && terminated === 1;
    compiler.timeout = 60000;
    const pdf = await compiler.compile(source);
    const counts = { created, terminated };
    compiler.dispose();
    return { failure, idleAfterTimeout, replacedImmediately, counts, magic: new TextDecoder().decode(new Uint8Array(pdf.pdf).slice(0, 5)), active: compiler.active };
  }, source);
  expect(result.failure).toContain('timed out after 2 seconds');
  expect(result.idleAfterTimeout).toBe(true);
  expect(result.replacedImmediately).toBe(true);
  expect(result.counts).toEqual({ created: 2, terminated: 1 });
  expect(result.magic).toBe('%PDF-');
  expect(result.active).toBeNull();
});

test('warmup is shared with compiles, cancellation keeps the warm worker, and dispose releases it', async ({ page }) => {
  await loadCompiler(page);
  const result = await page.evaluate(async () => {
    const workers = [];
    const compiler = new window.LatexCompiler({ workerFactory: () => {
      if (workers.some(worker => !worker.terminated)) throw new Error('Concurrent workers.');
      const worker = { terminated: 0, messages: [], postMessage(data) { this.messages.push(data); }, terminate() { this.terminated++; } };
      workers.push(worker);
      return worker;
    } });
    const reply = data => workers[0].onmessage({ data });
    const warmup = compiler.warmup();
    const shared = compiler.warmup() === warmup;
    const first = compiler.compile('old').catch(error => error.message);
    compiler.cancel();
    const second = compiler.compile('new');
    reply({ result: 'ok' });
    const ready = await warmup;
    reply({ cmd: 'compile', result: 'ok', pdf: new ArrayBuffer(8) });
    reply({ cmd: 'compile', result: 'ok', pdf: new ArrayBuffer(8) });
    const completed = await second;
    const warmed = await compiler.warmup();
    const third = compiler.compile('identical');
    reply({ cmd: 'compile', result: 'ok', pdf: new ArrayBuffer(8) });
    reply({ cmd: 'compile', result: 'ok', pdf: new ArrayBuffer(8) });
    const reused = await third;
    compiler.cancel();
    const aliveAfterCancel = workers[0].terminated === 0 && compiler.engine?.ready;
    compiler.dispose();
    return {
      shared, first: await first, ready, warmed, timings: completed.timings, reused: reused.timings, aliveAfterCancel,
      sources: workers[0].messages.filter(message => message.cmd === 'writefile').map(message => message.src),
      workers: workers.map(worker => worker.terminated),
      idle: compiler.active === null && compiler.engine === null,
    };
  });
  expect(result.shared).toBe(true);
  expect(result.first).toContain('cancelled');
  expect(result.ready.initializationMs).toBeGreaterThanOrEqual(0);
  expect(result.warmed.initializationMs).toBeGreaterThanOrEqual(0);
  expect(result.timings.initializationMs).toBeGreaterThanOrEqual(0);
  expect(result.reused.initializationMs).toBe(0);
  expect(result.aliveAfterCancel).toBe(true);
  expect(result.sources).toEqual(['new', 'identical']);
  expect(result.workers).toEqual([1]);
  expect(result.idle).toBe(true);
});

test('engine load timeouts and failures recover without retaining workers, and a loaded engine stays warm', async ({ page }) => {
  await loadCompiler(page);
  const result = await page.evaluate(async () => {
    const workers = [];
    const compiler = new window.LatexCompiler({ timeout: 10, loadTimeout: 10, idleTimeout: 10, workerFactory: () => {
      const worker = { terminated: 0, postMessage() {}, terminate() { this.terminated++; } };
      workers.push(worker);
      return worker;
    } });
    const expired = await compiler.warmup().catch(error => error.message);
    const loaded = compiler.warmup();
    workers[1].onmessage({ data: { result: 'ok' } });
    await loaded;
    await new Promise(resolve => setTimeout(resolve, 30));
    const stayedWarm = compiler.engine?.ready === true && workers[1].terminated === 0;
    compiler.dispose();
    const failed = compiler.warmup().catch(error => error.message);
    workers[2].onerror({ message: 'warmup load error' });
    const failure = await failed;
    const retry = compiler.warmup();
    workers[3].onmessage({ data: { result: 'ok' } });
    await retry;
    compiler.dispose();
    return { expired, stayedWarm, failure, terminated: workers.map(worker => worker.terminated) };
  });
  expect(result.expired).toContain('engine loading timed out');
  expect(result.stayedWarm).toBe(true);
  expect(result.failure).toBe('warmup load error');
  expect(result.terminated).toEqual([1, 1, 1, 1]);
});

test('timeout, dispatch, status, loading and decoding errors release workers and allow retry', async ({ page }) => {
  await loadCompiler(page);
  const result = await page.evaluate(async () => {
    const records = [];
    const compiler = new window.LatexCompiler({ timeout: 10, workerFactory: () => {
      const worker = { terminated: 0, postMessage() {}, terminate() { this.terminated++; } };
      records.push(worker);
      return worker;
    } });
    const failures = [];
    const fail = async (trigger, onStatus) => {
      const promise = compiler.compile('source', onStatus).catch(error => error.message);
      await trigger?.(records.at(-1));
      failures.push(await promise);
      if (compiler.active) throw new Error('Compiler did not release its job.');
    };
    await fail(worker => worker.onmessage({ data: { result: 'ok' } }));
    await fail(worker => {
      worker.postMessage = () => { throw new Error('dispatch failed'); };
      worker.onmessage({ data: { result: 'ok' } });
    });
    await fail(null, () => { throw new Error('status failed'); });
    await fail(worker => worker.onerror({ message: 'engine failed' }));
    await fail(worker => worker.onmessageerror());
    await fail(async worker => {
      worker.onmessage({ data: { result: 'ok' } });
      await compiler.warmup();
      worker.onmessage({ data: { cmd: 'writefile', result: 'failed' } });
    });
    let postsAfterCancellation = 0;
    await fail(worker => {
      worker.postMessage = () => { postsAfterCancellation++; };
      worker.onmessage({ data: { result: 'ok' } });
    }, status => {
      if (status === 'Typesetting locally...') compiler.cancel();
    });
    const keptAfterCancellation = compiler.engine?.ready === true;
    compiler.dispose();
    compiler.workerFactory = () => { throw new Error('worker unavailable'); };
    failures.push(await compiler.compile('source').catch(error => error.message));
    return { failures, terminated: records.map(worker => worker.terminated), postsAfterCancellation, keptAfterCancellation, active: compiler.active };
  });
  expect(result.failures).toEqual([
    'Compilation timed out after 0.01 seconds. Simplify the document and try again.',
    'dispatch failed', 'status failed', 'engine failed',
    'The browser compiler returned an unreadable message. Try compiling again.',
    'The browser compiler could not prepare the document. Try compiling again.',
    'Compilation cancelled.', 'worker unavailable',
  ]);
  expect(result.terminated.every(count => count === 1)).toBe(true);
  expect(result.postsAfterCancellation).toBe(0);
  expect(result.keptAfterCancellation).toBe(true);
  expect(result.active).toBeNull();
});

test('startup preparation rejects oversized packages, releases its worker and retries', async ({ page, context }) => {
  await loadCompiler(page);
  await context.route(/\/compiler\/tex\/article\.cls(?:\?v=[a-f0-9]+)?$/, route => route.fulfill({
    contentType: 'application/octet-stream', body: Buffer.alloc(193 * 1024),
  }));
  const failure = await page.evaluate(async () => {
    const compiler = new window.LatexCompiler();
    const message = await compiler.warmup().then(() => null, error => error.message);
    return { message, warming: compiler.engine };
  });
  expect(failure.message).toContain('startup packages exceeded their memory limit');
  expect(failure.warming).toBeNull();
  await context.unroute(/\/compiler\/tex\/article\.cls(?:\?v=[a-f0-9]+)?$/);
  const magic = await page.evaluate(async source => {
    const result = await new window.LatexCompiler().compile(source);
    return new TextDecoder().decode(new Uint8Array(result.pdf).slice(0, 5));
  }, source);
  expect(magic).toBe('%PDF-');
});
