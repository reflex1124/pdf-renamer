import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { DocumentController } from '../electron/services/document-controller.js';
import { Logger } from '../electron/services/logger.js';
import { SettingsStore } from '../electron/services/settings.js';
import type { AnalysisResult } from '../shared/types.js';

class MockAnalyzer {
  batchCalls: string[][] = [];
  singleCalls: string[] = [];

  async listModels(): Promise<string[]> {
    return ['gpt-5-mini', 'gpt-4.1-mini'];
  }

  async hasExtractableText(documentPath: string): Promise<boolean> {
    return documentPath.endsWith('invoice-a.pdf') || documentPath.endsWith('invoice-b.pdf');
  }

  async analyzePdfs(pdfPaths: string[]): Promise<Record<string, AnalysisResult>> {
    this.batchCalls.push(pdfPaths);
    return Object.fromEntries(
      pdfPaths.map((pdfPath, index) => [
        pdfPath,
        {
          documentType: '請求書',
          issuerName: `Batch ${index + 1}`,
          date: '2026-03-14',
          amount: `JPY ${index + 1}000`,
          title: 'Batch',
          description: 'PDF text',
          confidence: 0.93,
        },
      ]),
    );
  }

  async analyzeDocument(documentPath: string): Promise<AnalysisResult> {
    this.singleCalls.push(documentPath);
    if (documentPath.endsWith('broken.png')) {
      throw new Error('vision failed');
    }
    return {
      documentType: '領収書',
      issuerName: 'Single',
      date: '2026-03-14',
      amount: 'USD 20.00',
      title: 'Image',
      description: 'Single doc',
      confidence: 0.74,
    };
  }
}

describe('document controller', () => {
  let tempDir: string;
  let controller: DocumentController;
  let analyzer: MockAnalyzer;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-renamer-docs-'));
    const settingsStore = new SettingsStore(path.join(tempDir, 'settings.json'));
    await settingsStore.save({
      namingTemplate: '{date}_{issuer_name}_{document_type}_{amount}',
      openaiModel: 'gpt-4.1-mini',
    });
    analyzer = new MockAnalyzer();
    const logger = new Logger(path.join(tempDir, 'logs', 'app.log'));
    await logger.init();
    controller = new DocumentController(settingsStore, analyzer, logger);
  });

  it('routes extractable PDFs through batch analysis and other files through single analysis', async () => {
    const files = await createFiles(tempDir, ['invoice-a.pdf', 'invoice-b.pdf', 'scan.pdf', 'receipt.png', 'broken.png']);
    const documents = await controller.addDocuments(files);

    expect(documents).toHaveLength(5);

    const analyzed = await controller.analyzeDocuments();

    expect(analyzer.batchCalls).toHaveLength(1);
    expect(analyzer.batchCalls[0]).toHaveLength(2);
    expect(analyzer.singleCalls).toHaveLength(3);
    expect(analyzed.find((item) => item.displayName === 'invoice-a.pdf')?.status).toBe('ready');
    expect(analyzed.find((item) => item.displayName === 'scan.pdf')?.status).toBe('needs_review');
    expect(analyzed.find((item) => item.displayName === 'broken.png')?.status).toBe('error');
  });

  it('updates proposed names, resolves rename collisions, and supports skip', async () => {
    const [filePath] = await createFiles(tempDir, ['rename-me.pdf']);
    const [existingCollision] = await createFiles(tempDir, ['2026-03-14_Single_領収書_USD20.00.pdf']);
    const [document] = await controller.addDocuments([filePath]);

    await controller.analyzeDocuments([document.key], true);

    const updated = controller.updateProposedName({
      key: document.key,
      proposedName: path.basename(existingCollision),
    });

    expect(updated.proposedName).toBe('2026-03-14_Single_領収書_USD20.00.pdf');

    const renamed = await controller.renameDocuments([document.key]);
    expect(renamed[0]?.displayName).toBe('2026-03-14_Single_領収書_USD20.00 (1).pdf');
    expect(renamed[0]?.status).toBe('renamed');

    const skipped = await controller.skipDocuments([document.key]);
    expect(skipped[0]?.status).toBe('skipped');
  });
});

async function createFiles(baseDir: string, names: string[]): Promise<string[]> {
  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(baseDir, name);
      await fs.writeFile(filePath, `${name}\n`, 'utf8');
      return filePath;
    }),
  );
}
