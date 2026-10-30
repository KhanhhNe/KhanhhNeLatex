import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Local compilation}\label{intro}
See section \ref{intro}. \[E=mc^2\]
\end{document}`;

async function loadCompiler(page) {
  const body = await readFile(new URL('../../src/compiler.js', import.meta.url), 'utf8');
  await page.route('**/compiler-client.js', route => route.fulfill({ contentType: 'text/javascript', body }));
  await page.goto('/');
  await page.evaluate(async () => {
    const { LatexCompiler } = await import('/compiler-client.js');
    window.LatexCompiler = LatexCompiler;
  });
}

test('real workers compile PDF, recompile, cancel and recover from LaTeX failure', async ({ page }) => {
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
      pdfs.push({ magic: new TextDecoder().decode(bytes.slice(0, 5)), length: bytes.length, log: result.log });
    };
    await compile(source);
    await compile(source.replace('Local compilation', 'Second compilation'));
    const failure = await compiler.compile(String.raw`\documentclass{article}\begin{document}\notacommand\end{document}`)
      .then(() => null, error => ({ message: error.message, log: error.log }));
    let cancelAt;
    const cancelled = compiler.compile(String.raw`\documentclass{article}\begin{document}\loop\iftrue\repeat\end{document}`, status => {
      if (status === 'Typesetting locally...') setTimeout(() => { cancelAt = performance.now(); compiler.cancel(); }, 25);
    }).then(() => null, error => error.message);
    const cancellation = await cancelled;
    const cancelLatency = performance.now() - cancelAt;
    await compile(source);
    return { pdfs, failure, cancellation, cancelLatency, workers, statuses, active: compiler.active };
  }, source);
  expect(result.pdfs).toHaveLength(3);
  for (const pdf of result.pdfs) {
    expect(pdf.magic).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5000);
    expect(pdf.log).not.toContain('undefined references');
  }
  expect(result.failure.message).toContain('LaTeX could not compile');
  expect(result.failure.log).toContain('Undefined control sequence');
  expect(result.cancellation).toBe('Compilation cancelled.');
  expect(result.cancelLatency).toBeLessThan(2000);
  expect(result.workers).toEqual(Array.from({ length: 5 }, () => ({ terminated: 1 })));
  expect(result.statuses.filter(status => status === 'Resolving references...')).toHaveLength(3);
  expect(result.active).toBeNull();
  expect(externalRequests).toEqual([]);
});

test('settled worker callbacks cannot clear a retry and concurrent jobs are rejected', async ({ page }) => {
  await loadCompiler(page);
  const result = await page.evaluate(async () => {
    class WorkerStub {
      messages = [];
      terminated = 0;
      postMessage(message) { this.messages.push(message.cmd); }
      terminate() { this.terminated++; }
    }
    const workers = [];
    const compiler = new window.LatexCompiler({ workerFactory: () => {
      const worker = new WorkerStub();
      workers.push(worker);
      return worker;
    } });
    const first = compiler.compile('first').catch(error => error.message);
    const oldMessage = workers[0].onmessage;
    const oldError = workers[0].onerror;
    const oldCancel = compiler.active.cancel;
    compiler.cancel();
    const second = compiler.compile('second');
    const retry = compiler.active;
    oldMessage({ data: { cmd: 'missing', name: 'stale' } });
    oldMessage({ data: { cmd: 'compile', result: 'ok', pdf: new ArrayBuffer(8) } });
    oldError({ message: 'stale error' });
    oldCancel();
    const retryStillActive = compiler.active === retry;
    const concurrent = await compiler.compile('third').catch(error => error.message);
    const worker = workers[1];
    worker.onmessage({ data: { result: 'ok' } });
    worker.onmessage({ data: { result: 'ok' } });
    worker.onmessage({ data: { cmd: 'compile', result: 'ok', pdf: new ArrayBuffer(8) } });
    worker.onmessage({ data: { cmd: 'compile', result: 'ok', pdf: new ArrayBuffer(16) } });
    return {
      first: await first, concurrent, retryStillActive, bytes: (await second).pdf.byteLength,
      workers: workers.map(worker => ({ terminated: worker.terminated, messages: worker.messages, detached: !worker.onmessage && !worker.onerror && !worker.onmessageerror })),
      active: compiler.active,
    };
  });
  expect(result.first).toContain('cancelled');
  expect(result.concurrent).toContain('already running');
  expect(result.retryStillActive).toBe(true);
  expect(result.bytes).toBe(16);
  expect(result.workers).toEqual([
    { terminated: 1, messages: [], detached: true },
    { terminated: 1, messages: ['writefile', 'setmainfile', 'compilelatex', 'compilelatex'], detached: true },
  ]);
  expect(result.active).toBeNull();
});

test('a timed-out real worker is released and a fresh worker can compile', async ({ page }) => {
  await loadCompiler(page);
  const result = await page.evaluate(async source => {
    let terminated = 0;
    const compiler = new window.LatexCompiler({ timeout: 2000, workerFactory: () => {
      const worker = new Worker('/compiler/worker.js');
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { terminated++; terminate(); };
      return worker;
    } });
    const failure = await compiler.compile(String.raw`\documentclass{article}\begin{document}\loop\iftrue\repeat\end{document}`)
      .then(() => null, error => error.message);
    const idleAfterTimeout = compiler.active === null;
    compiler.timeout = 60000;
    const pdf = await compiler.compile(source);
    return { failure, idleAfterTimeout, terminated, magic: new TextDecoder().decode(new Uint8Array(pdf.pdf).slice(0, 5)), active: compiler.active };
  }, source);
  expect(result.failure).toContain('timed out after 2 seconds');
  expect(result.idleAfterTimeout).toBe(true);
  expect(result.terminated).toBe(2);
  expect(result.magic).toBe('%PDF-');
  expect(result.active).toBeNull();
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
      trigger?.(records.at(-1));
      failures.push(await promise);
      if (compiler.active) throw new Error('Compiler did not release its job.');
    };
    await fail();
    await fail(worker => {
      worker.postMessage = () => { throw new Error('dispatch failed'); };
      worker.onmessage({ data: { result: 'ok' } });
    });
    await fail(null, () => { throw new Error('status failed'); });
    await fail(worker => worker.onerror({ message: 'engine failed' }));
    await fail(worker => worker.onmessageerror());
    await fail(worker => worker.onmessage({ data: { cmd: 'writefile', result: 'failed' } }));
    let postsAfterCancellation = 0;
    await fail(worker => {
      worker.postMessage = () => { postsAfterCancellation++; };
      worker.onmessage({ data: { result: 'ok' } });
    }, status => {
      if (status === 'Typesetting locally...') compiler.cancel();
    });
    compiler.workerFactory = () => { throw new Error('worker unavailable'); };
    failures.push(await compiler.compile('source').catch(error => error.message));
    return { failures, terminated: records.map(worker => worker.terminated), postsAfterCancellation, active: compiler.active };
  });
  expect(result.failures).toEqual([
    'Compilation timed out after 0.01 seconds. Simplify the document and try again.',
    'dispatch failed', 'status failed', 'engine failed',
    'The browser compiler returned an unreadable message. Try compiling again.',
    'The browser compiler could not prepare the document. Try compiling again.',
    'Compilation cancelled.', 'worker unavailable',
  ]);
  expect(result.terminated).toEqual(Array(7).fill(1));
  expect(result.postsAfterCancellation).toBe(0);
  expect(result.active).toBeNull();
});
