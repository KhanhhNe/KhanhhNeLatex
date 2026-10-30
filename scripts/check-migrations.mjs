import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function snapshot(directory, root = directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await snapshot(path, root, result);
    else {
      const contents = await readFile(path);
      result.push(`${path.slice(root.length)}:${createHash('sha256').update(contents).digest('hex')}`);
    }
  }
  return result.sort();
}

execFileSync(process.execPath, ['node_modules/drizzle-kit/bin.cjs', 'check'], { stdio: 'inherit' });
const before = await snapshot('migrations');
const generate = spawnSync(process.execPath, ['node_modules/drizzle-kit/bin.cjs', 'generate'], {
  encoding: 'utf8',
});
if (generate.status !== 0) throw new Error(generate.stderr || generate.stdout || 'Could not validate Drizzle schema.');
const after = await snapshot('migrations');
if (JSON.stringify(before) !== JSON.stringify(after))
  throw new Error('The Drizzle schema and checked-in migrations are out of date. Run npm run db:generate and review/commit the generated migration.');
console.log('Drizzle schema and checked-in migrations are consistent.');
