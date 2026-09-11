import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'tsup';

const directory = await mkdtemp(join(tmpdir(), 'quaivault-tui-'));
try {
  await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  await build({ config: false, entry: { fixture: 'test/fixtures/tui-pty.tsx' }, outDir: directory,
    format: ['esm'], target: 'node22', platform: 'node', dts: false, splitting: false, clean: false,
    outExtension: () => ({ js: '.mjs' }), external: ['ink', 'react', 'quais', '@quaivault/sdk', 'string-width'],
  });
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.QV_TUI_PYTHON ?? 'python3', [
      'scripts/tui-pty-check.py', join(directory, 'fixture.mjs'), process.execPath,
    ], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`PTY checks failed: ${code}`)));
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
