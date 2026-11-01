import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const formats = {};
await mkdir('public/compiler/formats', { recursive: true });
for (const [engine, path] of [
  ['pdftex', 'public/compiler/tex/swiftlatexpdftex.fmt'],
  ['xetex', 'public/compiler/native-tex/swiftlatexxetex.fmt'],
]) {
  const bytes = await readFile(path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const name = `${engine}-${hash}.fmt.gz`;
  const compressed = gzipSync(bytes, { level: 9 });
  await writeFile(`public/compiler/formats/${name}`, compressed);
  formats[engine] = `/compiler/formats/${name}`;
  console.log(`${engine} format: ${bytes.length} -> ${compressed.length} bytes.`);
}
await writeFile('public/compiler/format-assets.js', `self.TEX_FORMAT_ASSETS = ${JSON.stringify(formats, null, 2)};\n`);
