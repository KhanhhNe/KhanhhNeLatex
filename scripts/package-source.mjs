import { execFileSync } from 'node:child_process';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.npm_execpath) throw new Error('Run using npm run source:bundle.');
const directory = await mkdtemp(join(tmpdir(), 'khanhhne-source-'));
try {
  const result = JSON.parse(execFileSync(process.execPath, [
    process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory,
  ], { encoding: 'utf8' }))[0];
  if (result.files.some(({ path }) => /(^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/.test(path) && path !== '.env.example'))
    throw new Error('Refusing to publish an archive containing a secret environment file.');
  if (result.size > 25 * 1024 * 1024)
    throw new Error('The application source archive exceeds the Cloudflare 25 MiB static asset limit.');
  await copyFile(join(directory, result.filename), 'public/source.tar.gz');
  console.log(`Public source archive: ${result.files.length} allowlisted files; ${result.size} bytes.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
