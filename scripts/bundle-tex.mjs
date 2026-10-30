import { chromium, request } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Maintainer-only, explicit asset acquisition; never runs in the deployed app.
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5173';
const manifestPath = new URL('../public/compiler/manifest.js', import.meta.url);
const original = await readFile(manifestPath, 'utf8');
const files = JSON.parse(original.slice(original.indexOf('=') + 1).trim().replace(/;$/, ''));
const client = await request.newContext();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(baseURL);
const sources = [
  String.raw`\documentclass{article}\usepackage{amsmath,amssymb}\usepackage[margin=1in]{geometry}\begin{document}\section{Hello}Hello, world! $x^2+\alpha=\sum_{i=1}^{n}i$ \[\int_0^1 x\,dx=\frac12\] \textbf{Bold} \textit{Italic} \texttt{Monospace} \begin{itemize}\item Test\end{itemize}\end{document}`,
  String.raw`\documentclass[11pt]{article}\usepackage{amsmath}\usepackage[margin=1in]{geometry}\title{A little room for big ideas}\author{Your name}\date{\today}\begin{document}\maketitle\begin{abstract}Abstract\end{abstract}\section{Start}\begin{equation}\int_{-\infty}^{\infty}e^{-x^2}\,dx=\sqrt{\pi}\end{equation}\begin{itemize}\item Test\end{itemize}\end{document}`,
  String.raw`\documentclass{report}\begin{document}\chapter{Report}Text.\end{document}`,
  String.raw`\documentclass{book}\begin{document}\chapter{Book}Text.\end{document}`,
];
let complete = false;
try {
  for (let pass = 0; pass < 40; pass++) {
    const missing = new Set();
    let successes = 0;
    for (const source of sources) {
      const result = await page.evaluate(async source => {
        const { LatexCompiler } = await import('/src/compiler.js');
        const compiler = new LatexCompiler();
        const missing = [];
        try {
          await compiler.compile(source, status => {
            if (status.startsWith('Loading ') && !status.includes('browser engine')) missing.push(status.slice(8, -3));
          });
          return { ok: true, missing };
        } catch (error) { return { ok: false, missing, log: error.log || error.message }; }
      }, source);
      for (const name of result.missing) missing.add(name);
      if (result.ok) successes++;
      else if (!result.missing.length) console.log(result.log.slice(-1200));
    }
    console.log(`Pass ${pass + 1}: ${successes}/${sources.length} fixtures, ${missing.size} missing file requests`);
    if (successes === sources.length) { complete = true; break; }
    let added = 0;
    for (const key of missing) {
      if (key in files || !/^[\w./-]+$/.test(key)) continue;
      const response = await client.get(`https://texlive.texlyre.org/pdftex/${key}`);
      if (response.status() !== 200 || !response.headers().fileid) continue;
      const name = response.headers().fileid;
      if (!/^[\w.-]+$/.test(name)) throw new Error('Unsafe upstream filename');
      const body = await response.body();
      if (body.length > 25 * 1024 * 1024) throw new Error('Cloudflare static asset limit exceeded');
      await mkdir(new URL('../public/compiler/tex/', import.meta.url), { recursive: true });
      await writeFile(new URL(`../public/compiler/tex/${name}`, import.meta.url), body);
      files[key] = name;
      added++;
      console.log(`Bundled ${key}: ${body.length} bytes, sha256=${createHash('sha256').update(body).digest('hex')}`);
    }
    await writeFile(manifestPath, `self.TEX_FILES = ${JSON.stringify(files, null, 2)};\n`);
    if (!added) throw new Error('No additional packages found; inspect fixture compilation log.');
  }
  if (!complete) throw new Error('Package fixture limit reached');
} finally {
  await browser.close();
  await client.dispose();
}
