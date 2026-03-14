import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TEMPLATE, type AppSettings } from '../../shared/types.js';

export const DEFAULT_SETTINGS: AppSettings = {
  namingTemplate: DEFAULT_TEMPLATE,
  openaiModel: 'gpt-4.1-mini',
};

export class SettingsStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return {
        namingTemplate: parsed.namingTemplate || DEFAULT_SETTINGS.namingTemplate,
        openaiModel: parsed.openaiModel || DEFAULT_SETTINGS.openaiModel,
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return settings;
  }
}
