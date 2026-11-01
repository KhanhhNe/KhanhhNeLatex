import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { googleFontMetadata } from '../server/fonts.js';
import { readBounded, MAX_FONT_BYTES } from '../src/font-policy.js';

// Explicit, licensed test-data acquisition. Production resolves arbitrary families, not this fixture list.
const root = new URL('../tests/fixtures/fonts/', import.meta.url);
await mkdir(root, { recursive: true });
const metadata = [];
for (const family of ['Roboto', 'Crimson Pro', 'Lato']) {
  for (const weight of ['400', '700']) {
    const result = await googleFontMetadata({ family, weight, italic: '0' });
    if (result.status !== 200) throw new Error(result.error);
    const bytes = await readBounded(await fetch(result.url), MAX_FONT_BYTES);
    const filename = `${family.replaceAll(' ', '-')}-${weight}.ttf`;
    await writeFile(new URL(filename, root), bytes);
    metadata.push({ ...result, filename, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const response = await fetch(`https://fonts.google.com/download/list?family=${encodeURIComponent(family)}`);
  const text = new TextDecoder().decode(await readBounded(response, 1024 * 1024));
  const download = JSON.parse(text.slice(text.indexOf('{')));
  const license = download.manifest.files.find(file => /(?:OFL|LICENSE)\.txt$/.test(file.filename));
  if (!license?.contents) throw new Error(`Missing license for ${family}`);
  await writeFile(new URL(`${family.replaceAll(' ', '-')}-LICENSE.txt`, root), license.contents);
}
await writeFile(new URL('manifest.json', root), `${JSON.stringify(metadata, null, 2)}\n`);
