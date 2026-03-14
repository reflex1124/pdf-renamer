import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildProposedFilename,
  ensureExtension,
  normalizeTemplate,
  sanitizeFilenameComponent,
  validateTemplate,
} from '../../../shared/naming.js';
import {
  SUPPORTED_DOCUMENT_EXTENSIONS,
  type AppSettings,
  type DocumentItem,
  type UpdateProposedNameRequest,
} from '../../../shared/types.js';
import type { Logger } from './logger.js';
import type { SettingsStore } from './settings.js';
import type { AnalyzerPort } from './openai-analyzer.js';
import { DocumentStore } from './document-store.js';

export class DocumentController {
  readonly store: DocumentStore;

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly analyzer: AnalyzerPort,
    private readonly logger: Logger,
    store?: DocumentStore,
  ) {
    this.store = store ?? new DocumentStore();
  }

  listDocuments(): DocumentItem[] {
    return this.store.list();
  }

  async addDocuments(paths: string[]): Promise<DocumentItem[]> {
    const filtered = (
      await Promise.all(
        paths.map(async (candidatePath) => {
          let resolved = '';
          try {
            resolved = await fs.realpath(candidatePath);
          } catch {
            return null;
          }
          const extension = path.extname(resolved).toLowerCase();
          if (!SUPPORTED_DOCUMENT_EXTENSIONS.includes(extension as (typeof SUPPORTED_DOCUMENT_EXTENSIONS)[number])) {
            return null;
          }
          return resolved;
        }),
      )
    ).filter((value): value is string => Boolean(value));

    const documents = this.store.add(filtered);
    this.logger.info('Documents added', { count: filtered.length });
    return documents;
  }

  clearDocuments(): DocumentItem[] {
    this.logger.info('Cleared all documents');
    return this.store.clear();
  }

  async saveSettings(input: AppSettings): Promise<AppSettings> {
    const template = normalizeTemplate(input.namingTemplate);
    const validation = validateTemplate(template);
    if (!validation.valid) {
      throw new Error(validation.message);
    }

    const nextSettings = {
      namingTemplate: template,
      openaiModel: input.openaiModel.trim() || 'gpt-4.1-mini',
    };

    const saved = await this.settingsStore.save(nextSettings);
    for (const item of this.store.list()) {
      if (!item.analysis) {
        continue;
      }
      const proposedName = ensureExtension(
        buildProposedFilename(item.analysis, saved.namingTemplate),
        path.extname(item.currentPath),
      );
      this.store.updateProposedName(item.key, proposedName);
    }
    return saved;
  }

  loadSettings(): Promise<AppSettings> {
    return this.settingsStore.load();
  }

  async analyzeDocuments(keys?: string[], force = false): Promise<DocumentItem[]> {
    const settings = await this.settingsStore.load();
    const targets = this.getAnalysisTargets(keys, force);
    if (targets.length === 0) {
      return this.store.list();
    }

    for (const item of targets) {
      this.store.markAnalyzing(item.key);
    }

    const batchable: DocumentItem[] = [];
    const singleItems: DocumentItem[] = [];

    for (const item of targets) {
      const extension = path.extname(item.currentPath).toLowerCase();
      if (extension === '.pdf' && (await this.analyzer.hasExtractableText(item.currentPath))) {
        batchable.push(item);
      } else {
        singleItems.push(item);
      }
    }

    if (batchable.length > 0) {
      try {
        const payload = await this.analyzer.analyzePdfs(batchable.map((item) => item.currentPath));
        for (const item of batchable) {
          const analysis = payload[item.currentPath];
          this.store.updateAnalysis(
            item.key,
            analysis,
            ensureExtension(buildProposedFilename(analysis, settings.namingTemplate), path.extname(item.currentPath)),
          );
        }
      } catch (error) {
        const message = toErrorMessage(error);
        for (const item of batchable) {
          this.store.markError(item.key, message);
        }
      }
    }

    await Promise.all(
      singleItems.map(async (item) => {
        try {
          const analysis = await this.analyzer.analyzeDocument(item.currentPath);
          this.store.updateAnalysis(
            item.key,
            analysis,
            ensureExtension(buildProposedFilename(analysis, settings.namingTemplate), path.extname(item.currentPath)),
          );
        } catch (error) {
          this.store.markError(item.key, toErrorMessage(error));
        }
      }),
    );

    return this.store.list();
  }

  retryDocuments(keys?: string[]): Promise<DocumentItem[]> {
    return this.analyzeDocuments(keys, true);
  }

  async renameDocuments(keys?: string[]): Promise<DocumentItem[]> {
    const targets = this.targetDocuments(keys);

    for (const item of targets) {
      if (!item.proposedName || item.status === 'renamed') {
        continue;
      }

      const extension = path.extname(item.currentPath);
      const normalizedName = ensureExtension(item.proposedName, extension);
      const sameNameTarget = path.join(path.dirname(item.currentPath), normalizedName);
      const target = sameNameTarget === item.currentPath ? sameNameTarget : await resolveCollision(path.dirname(item.currentPath), normalizedName, extension);

      if (target !== item.currentPath) {
        await fs.rename(item.currentPath, target);
      }
      this.store.markRenamed(item.key, target);
    }

    return this.store.list();
  }

  async skipDocuments(keys?: string[]): Promise<DocumentItem[]> {
    for (const item of this.targetDocuments(keys)) {
      this.store.markSkipped(item.key);
    }
    return this.store.list();
  }

  updateProposedName(request: UpdateProposedNameRequest): DocumentItem {
    const item = this.store.get(request.key);
    if (!item) {
      throw new Error('対象ドキュメントが見つかりません。');
    }

    const edited = sanitizeFilenameComponent(request.proposedName, 'renamed') || 'renamed';
    const nextName = ensureExtension(edited, path.extname(item.currentPath));
    return this.store.updateProposedName(request.key, nextName);
  }

  async listModels(): Promise<string[]> {
    return this.analyzer.listModels();
  }

  private getAnalysisTargets(keys?: string[], force = false): DocumentItem[] {
    return this.targetDocuments(keys).filter((item) => {
      if (force) {
        return item.status !== 'analyzing';
      }

      return ['pending', 'error', 'needs_review', 'ready'].includes(item.status);
    });
  }

  private targetDocuments(keys?: string[]): DocumentItem[] {
    const explicit = this.store.getMany(keys);
    if (explicit.length > 0) {
      return explicit;
    }
    return this.store.list();
  }
}

async function resolveCollision(directory: string, targetName: string, extension: string): Promise<string> {
  const candidate = path.join(directory, ensureExtension(targetName, extension));
  if (!(await exists(candidate))) {
    return candidate;
  }

  const { name, ext } = path.parse(candidate);
  let index = 1;
  while (true) {
    const nextCandidate = path.join(directory, `${name} (${index})${ext}`);
    if (!(await exists(nextCandidate))) {
      return nextCandidate;
    }
    index += 1;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
