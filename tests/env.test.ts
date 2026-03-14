import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadEnvironment, resolveEnvFileCandidates } from '../electron/services/env.js';

const originalApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
    return;
  }
  process.env.OPENAI_API_KEY = originalApiKey;
});

describe('env loading', () => {
  it('prefers executable-adjacent env files before cwd env files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-renamer-env-'));
    const executableDir = path.join(tempDir, 'app');
    const cwdDir = path.join(tempDir, 'cwd');

    await fs.mkdir(executableDir, { recursive: true });
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(path.join(executableDir, '.env'), 'OPENAI_API_KEY=exe-key\n', 'utf8');
    await fs.writeFile(path.join(cwdDir, '.env'), 'OPENAI_API_KEY=cwd-key\n', 'utf8');

    delete process.env.OPENAI_API_KEY;

    const loadedPath = loadEnvironment(path.join(executableDir, 'PDF Renamer'), cwdDir);

    expect(loadedPath).toBe(path.join(executableDir, '.env'));
    expect(process.env.OPENAI_API_KEY).toBe('exe-key');
  });

  it('deduplicates candidate paths', () => {
    const candidates = resolveEnvFileCandidates('/tmp/app/PDF Renamer', '/tmp/app');
    expect(candidates).toEqual(['/tmp/app/.env']);
  });
});
