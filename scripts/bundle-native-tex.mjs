import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Explicit maintainer acquisition only, never invoked by build or deployed compilation.
const compiler = new URL('../public/compiler/', import.meta.url);
const manifest = {
  '10/swiftlatexxetex.fmt': 'native-tex/swiftlatexxetex.fmt',
};
const original = await readFile(new URL('manifest.js', compiler), 'utf8');
const bundled = JSON.parse(original.slice(original.indexOf('=') + 1).trim().replace(/;$/, ''));
for (const [key, name] of Object.entries(bundled)) if (!key.startsWith('10/')) manifest[key] = `tex/${name}`;
// Preserve separately acquired, hash-pinned native drawing/driver packages.
const currentText = await readFile(new URL('native-manifest.js', compiler), 'utf8');
const current = JSON.parse(currentText.slice(currentText.indexOf('=') + 1).trim().replace(/;$/, ''));
for (const [key, name] of Object.entries(current))
  if (!key.startsWith('10/') && name.startsWith('native-tex/')) manifest[key] = name;
await mkdir(new URL('native-tex/', compiler), { recursive: true });
const formatUrl = 'https://raw.githubusercontent.com/SwiftLaTeX/Texlive-Ondemand/cc2146e220658f5ee0f8643355252ae0995fbc98/swiftlatexxetex.fmt';
async function acquire(url, name) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Asset acquisition failed: HTTP ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024) throw new Error('Cloudflare per-file limit exceeded.');
  await writeFile(new URL(name, compiler), bytes);
  console.log(`${name}: ${bytes.length} bytes, SHA-256 ${createHash('sha256').update(bytes).digest('hex')}`);
  return response;
}
await acquire(formatUrl, manifest['10/swiftlatexxetex.fmt']);
const keys = [
  '47/lmroman10-regular', '47/lmroman10-bold', '47/lmroman10-italic', '47/lmroman10-bolditalic',
  '47/lmsans10-regular', '47/lmsans10-bold', '47/lmsans10-oblique', '47/lmsans10-boldoblique',
  '47/lmmono10-regular', '47/lmmono10-italic', '47/lmmonolt10-bold', '47/lmmonolt10-boldoblique',
  '41/tex-text.tec', '26/fontspec.sty', '26/xparse.sty', '26/expl3.sty',
  '26/l3backend-xdvipdfmx.def', '26/fontspec-xetex.sty', '26/tuenc.def', '26/fontspec.cfg', '26/ts1cmr.fd',
  '11/kanjix.map', '11/ckx.map', '11/texglyphlist.txt', '11/pdfglyphlist.txt', '11/glyphlist.txt',
];
for (const key of keys) {
  const url = `https://texlive.texlyre.org/xetex/${key}`;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Missing required native package ${key}.`);
  const name = response.headers.get('fileid');
  if (!/^[\w.-]+$/.test(name || '')) throw new Error('Unsafe package filename.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024) throw new Error('Cloudflare per-file limit exceeded.');
  await writeFile(new URL(`native-tex/${name}`, compiler), bytes);
  manifest[key] = `native-tex/${name}`;
  if (key.startsWith('47/')) manifest[`47/${name}`] = `native-tex/${name}`;
}
await writeFile(new URL('native-manifest.js', compiler), `self.NATIVE_TEX_FILES = ${JSON.stringify(manifest, null, 2)};\n`);
