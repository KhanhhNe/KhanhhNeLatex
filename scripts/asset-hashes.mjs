import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = 'public/compiler';
const assets = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.name !== 'assets.sha256.json') {
      const bytes = await readFile(path);
      assets.push({
        path: path.replaceAll('\\', '/').replace('public/', '/'),
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
}
await visit(root);
assets.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(join(root, 'assets.sha256.json'), `${JSON.stringify({ assets }, null, 2)}\n`);
console.log(`Recorded SHA-256 for ${assets.length} distributed compiler assets.`);
