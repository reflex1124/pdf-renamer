import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ResponseCreateParamsNonStreaming, ResponseInputContent, ResponseInputMessageItem } from 'openai/resources/responses/responses';
import { PDFParse } from 'pdf-parse';
import { z } from 'zod';

import type { AnalysisResult } from '../../../shared/types.js';

const SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

const analysisSchema = z.object({
  documentType: z.string(),
  issuerName: z.string().nullable(),
  date: z.string().nullable(),
  amount: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  confidence: z.number(),
});

const batchAnalysisSchema = z.object({
  documents: z.array(
    z.object({
      document_id: z.string(),
      analysis: analysisSchema,
    }),
  ),
});

export interface AnalyzerPort {
  listModels(): Promise<string[]>;
  hasExtractableText(documentPath: string, threshold?: number): Promise<boolean>;
  analyzePdfs(pdfPaths: string[]): Promise<Record<string, AnalysisResult>>;
  analyzeDocument(documentPath: string): Promise<AnalysisResult>;
}

export class OpenAiDocumentAnalyzer implements AnalyzerPort {
  private readonly modelRef: () => Promise<string>;
  private readonly apiKeyRef: () => string | undefined;

  constructor(options: { getModel: () => Promise<string>; getApiKey: () => string | undefined }) {
    this.modelRef = options.getModel;
    this.apiKeyRef = options.getApiKey;
  }

  async listModels(): Promise<string[]> {
    const client = this.getClient();
    const response = await client.models.list();

    const preferredModels = response.data
      .map((model) => model.id)
      .filter((modelId) => modelId.startsWith('gpt-'))
      .filter((modelId) => !SNAPSHOT_SUFFIX.test(modelId))
      .filter((modelId) => !['realtime', 'audio', 'transcribe', 'tts', 'search'].some((token) => modelId.includes(token)));

    const priority = new Map<string, number>([
      ['gpt-5', 0],
      ['gpt-5-mini', 1],
      ['gpt-5-nano', 2],
      ['gpt-4.1', 3],
      ['gpt-4.1-mini', 4],
      ['gpt-4.1-nano', 5],
      ['gpt-4o', 6],
      ['gpt-4o-mini', 7],
    ]);

    return [...new Set(preferredModels)].sort((left, right) => {
      const leftPriority = priority.get(left) ?? 99;
      const rightPriority = priority.get(right) ?? 99;
      return leftPriority - rightPriority || left.localeCompare(right);
    });
  }

  async extractText(pdfPath: string, maxChars = 12_000): Promise<string> {
    const buffer = await readFile(pdfPath);
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    const text = parsed.text.trim();
    if (!text) {
      throw new Error('PDF からテキストを抽出できませんでした。画像PDFはOCRが必要です。');
    }
    return text.slice(0, maxChars);
  }

  async hasExtractableText(documentPath: string, threshold = 20): Promise<boolean> {
    try {
      const text = await this.extractText(documentPath, 2_000);
      return text.trim().length >= threshold;
    } catch {
      return false;
    }
  }

  async analyzePdfs(pdfPaths: string[]): Promise<Record<string, AnalysisResult>> {
    if (pdfPaths.length === 0) {
      return {};
    }

    const documents = await Promise.all(
      pdfPaths.map(async (pdfPath, index) => ({
        document_id: String(index + 1),
        filename: path.basename(pdfPath),
        text: await this.extractText(pdfPath, 6_000),
      })),
    );

    const input: ResponseCreateParamsNonStreaming['input'] = [
      textMessage(
        'msg_system_batch',
        'system',
        "You extract structured metadata from PDF text. Multiple documents are included in one request. Treat each document independently, but use the full batch for consistency of naming and categorization. Return every provided document_id exactly once. The documentType must always be written in Japanese. Use labels such as '請求書', '領収書', '見積書', '納品書', '契約書', '注文書', '明細書', or 'その他'. Extract description from fields such as 内容, 内訳, Description, Item, Details, or similar. description should be a short summary of what the charge or document is for. For missing values, use null. Preserve the original currency in amount values and normalize it to ISO currency codes. For example use 'USD 12.34', 'JPY 1200', 'EUR 9.99', or 'GBP 72.10'. Dates must be normalized to YYYY-MM-DD when possible, or YYYY-MM-01 if only year and month are known. Confidence must be a number between 0.0 and 1.0.",
      ),
      textMessage(
        'msg_user_batch',
        'user',
        `Analyze the following PDF texts and return structured results for all documents.\n\n${JSON.stringify(documents, null, 2)}`,
      ),
    ];

    const response = await this.getClient().responses.parse({
      model: await this.modelRef(),
      input,
      text: {
        format: zodTextFormat(batchAnalysisSchema, 'batch_document_analysis'),
      },
    });

    const parsed = response.output_parsed;
    if (!parsed) {
      throw new Error('OpenAI から解析結果を取得できませんでした。');
    }

    const resultsById = new Map(parsed.documents.map((item) => [item.document_id, clampConfidence(item.analysis)]));
    const missingIds = documents.filter((document) => !resultsById.has(document.document_id)).map((document) => document.document_id);
    if (missingIds.length > 0) {
      throw new Error(`解析結果が不足しています: ${missingIds.join(', ')}`);
    }

    return Object.fromEntries(
      pdfPaths.map((pdfPath, index) => [pdfPath, resultsById.get(String(index + 1)) as AnalysisResult]),
    );
  }

  async analyzeDocument(documentPath: string): Promise<AnalysisResult> {
    const extension = path.extname(documentPath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) {
      return this.analyzeImage(documentPath);
    }
    if (extension === '.pdf') {
      if (await this.hasExtractableText(documentPath)) {
        const result = await this.analyzePdfs([documentPath]);
        return result[documentPath];
      }
      return this.analyzePdfWithFileInput(documentPath);
    }
    throw new Error(`未対応のファイル形式です: ${extension}`);
  }

  private async analyzePdfWithFileInput(pdfPath: string): Promise<AnalysisResult> {
    const client = this.getClient();
    const uploaded = await client.files.create({
      file: fs.createReadStream(pdfPath),
      purpose: 'user_data',
    });

    const input: ResponseCreateParamsNonStreaming['input'] = [
      ...singleDocumentPrompt(),
      userMessage([
        {
          type: 'input_file',
          file_id: uploaded.id,
        },
        {
          type: 'input_text',
          text: `Analyze this PDF file named '${path.basename(pdfPath)}'. Use OCR if needed and return the structured result.`,
        },
      ]),
    ];

    const response = await client.responses.parse({
      model: await this.modelRef(),
      input,
      text: {
        format: zodTextFormat(analysisSchema, 'document_analysis'),
      },
    });

    if (!response.output_parsed) {
      throw new Error('OpenAI からPDF解析結果を取得できませんでした。');
    }

    return clampConfidence(response.output_parsed);
  }

  private async analyzeImage(imagePath: string): Promise<AnalysisResult> {
    const suffix = path.extname(imagePath).toLowerCase().replace('.', '') || 'png';
    const encoded = (await readFile(imagePath)).toString('base64');
    const input: ResponseCreateParamsNonStreaming['input'] = [
      ...singleDocumentPrompt(),
      userMessage([
        {
          type: 'input_text',
          text: `Analyze this document image named '${path.basename(imagePath)}'. Read the image directly and return the structured result.`,
        },
        {
          type: 'input_image',
          detail: 'auto',
          image_url: `data:image/${suffix};base64,${encoded}`,
        },
      ]),
    ];

    const response = await this.getClient().responses.parse({
      model: await this.modelRef(),
      input,
      text: {
        format: zodTextFormat(analysisSchema, 'document_analysis'),
      },
    });

    if (!response.output_parsed) {
      throw new Error('OpenAI から画像解析結果を取得できませんでした。');
    }

    return clampConfidence(response.output_parsed);
  }

  private getClient(): OpenAI {
    const apiKey = this.apiKeyRef();
    if (!apiKey) {
      throw new Error('環境変数 OPENAI_API_KEY が設定されていません。');
    }
    return new OpenAI({ apiKey });
  }
}

function singleDocumentPrompt(): ResponseInputMessageItem[] {
  return [
    textMessage(
      'msg_system_single',
      'system',
        "You extract structured metadata from business documents. The documentType must always be written in Japanese. Use labels such as '請求書', '領収書', '見積書', '納品書', '契約書', '注文書', '明細書', or 'その他'. Extract description from fields such as 内容, 内訳, Description, Item, Details, or similar. description should be a short summary of what the charge or document is for. For missing values, use null. Preserve the original currency in amount values and normalize it to ISO currency codes. For example use 'USD 12.34', 'JPY 1200', 'EUR 9.99', or 'GBP 72.10'. Dates must be normalized to YYYY-MM-DD when possible, or YYYY-MM-01 if only year and month are known. Confidence must be a number between 0.0 and 1.0.",
    ),
  ];
}

function userMessage(content: ResponseInputContent[]): ResponseInputMessageItem {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content,
  };
}

function textMessage(
  id: string,
  role: ResponseInputMessageItem['role'],
  text: string,
): ResponseInputMessageItem {
  return {
    id,
    role,
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

function clampConfidence(analysis: z.infer<typeof analysisSchema>): AnalysisResult {
  return {
    documentType: analysis.documentType,
    issuerName: analysis.issuerName,
    date: analysis.date,
    amount: analysis.amount,
    title: analysis.title,
    description: analysis.description,
    confidence: Math.max(0, Math.min(1, analysis.confidence)),
  };
}
