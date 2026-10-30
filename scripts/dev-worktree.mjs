import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const requested = args.find(arg => /^\d+$/.test(arg));
const directory = resolve(root, '.wrangler', 'worktree-state');
await mkdir(directory, { recursive: true });
const port = requested ? Number(requested) : await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const selected = probe.address().port;
    probe.close(error => error ? reject(error) : resolvePort(selected));
  });
});
if (port < 1024 || port > 65535) throw new Error('Choose an available port from 1024-65535.');
const origin = `http://127.0.0.1:${port}`;
await writeFile(join(root, '.dev.vars'), `APP_ORIGIN=${origin}\n`);
const child = spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', directory], {
  cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
  env: process.env,
});
child.on('error', error => { console.error('Could not launch Wrangler:', error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code || 0;
});
console.log(`Isolated local D1: ${directory}`);
