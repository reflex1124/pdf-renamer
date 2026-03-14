import path from 'node:path';

import type { AnalysisResult, DocumentItem, ItemStatus } from '../../../shared/types.js';

type StoredDocument = Omit<DocumentItem, 'displayName'>;

export class DocumentStore {
  private readonly items = new Map<string, StoredDocument>();

  list(): DocumentItem[] {
    return [...this.items.values()].map((item) => this.toDocumentItem(item));
  }

  add(paths: string[]): DocumentItem[] {
    for (const resolvedPath of paths) {
      if (this.items.has(resolvedPath)) {
        continue;
      }
      this.items.set(resolvedPath, {
        key: resolvedPath,
        sourcePath: resolvedPath,
        currentPath: resolvedPath,
        status: 'pending',
        analysis: null,
        proposedName: '',
        errorMessage: '',
        skipped: false,
        history: [],
      });
    }
    return this.list();
  }

  clear(): DocumentItem[] {
    this.items.clear();
    return [];
  }

  get(key: string): DocumentItem | null {
    const item = this.items.get(key);
    return item ? this.toDocumentItem(item) : null;
  }

  getMany(keys?: string[]): DocumentItem[] {
    if (!keys || keys.length === 0) {
      return this.list();
    }
    return keys
      .map((key) => this.get(key))
      .filter((item): item is DocumentItem => Boolean(item));
  }

  updateAnalysis(key: string, analysis: AnalysisResult, proposedName: string): DocumentItem {
    const current = this.requireItem(key);
    current.analysis = analysis;
    current.proposedName = proposedName;
    current.errorMessage = '';
    current.status = analysis.confidence >= 0.8 ? 'ready' : 'needs_review';
    current.skipped = false;
    current.history = [...current.history, `analyzed:${JSON.stringify(analysis)}`];
    return this.toDocumentItem(current);
  }

  markAnalyzing(key: string): DocumentItem {
    return this.patch(key, {
      status: 'analyzing',
      errorMessage: '',
      skipped: false,
    });
  }

  markError(key: string, message: string): DocumentItem {
    const current = this.requireItem(key);
    current.status = 'error';
    current.errorMessage = message;
    current.history = [...current.history, `error:${message}`];
    return this.toDocumentItem(current);
  }

  markSkipped(key: string): DocumentItem {
    const current = this.requireItem(key);
    current.status = 'skipped';
    current.skipped = true;
    current.history = [...current.history, 'skipped'];
    return this.toDocumentItem(current);
  }

  markRenamed(key: string, nextPath: string): DocumentItem {
    const current = this.requireItem(key);
    current.currentPath = nextPath;
    current.status = 'renamed';
    current.history = [...current.history, `renamed:${path.basename(nextPath)}`];
    return this.toDocumentItem(current);
  }

  updateProposedName(key: string, proposedName: string): DocumentItem {
    return this.patch(key, { proposedName });
  }

  setStatus(key: string, status: ItemStatus): DocumentItem {
    return this.patch(key, { status });
  }

  private patch(key: string, partial: Partial<StoredDocument>): DocumentItem {
    const current = this.requireItem(key);
    const next = { ...current, ...partial };
    this.items.set(key, next);
    return this.toDocumentItem(next);
  }

  private requireItem(key: string): StoredDocument {
    const item = this.items.get(key);
    if (!item) {
      throw new Error(`対象ドキュメントが見つかりません: ${key}`);
    }
    return item;
  }

  private toDocumentItem(item: StoredDocument): DocumentItem {
    return {
      ...item,
      displayName: path.basename(item.currentPath),
    };
  }
}
