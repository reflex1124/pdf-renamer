import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SettingsStore } from '../src/main/services/settings.js';

describe('settings store', () => {
  it('returns defaults when the settings file is missing', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-renamer-settings-'));
    const store = new SettingsStore(path.join(tempDir, 'settings.json'));

    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('persists and reloads settings', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-renamer-settings-'));
    const store = new SettingsStore(path.join(tempDir, 'settings.json'));

    await store.save({
      namingTemplate: '{issuer_name}_{date}',
      openaiModel: 'gpt-5-mini',
    });

    await expect(store.load()).resolves.toEqual({
      namingTemplate: '{issuer_name}_{date}',
      openaiModel: 'gpt-5-mini',
    });
  });
});
