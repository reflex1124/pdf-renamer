import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

export function resolveEnvFileCandidates(executablePath: string, cwd: string): string[] {
  const candidates = [
    path.join(path.dirname(executablePath), '.env'),
    path.join(cwd, '.env'),
  ];

  return [...new Set(candidates)];
}

export function loadEnvironment(executablePath: string, cwd: string): string | null {
  for (const candidate of resolveEnvFileCandidates(executablePath, cwd)) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    dotenv.config({ path: candidate, override: false });
    return candidate;
  }
  return null;
}
