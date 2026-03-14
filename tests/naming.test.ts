import { describe, expect, it } from 'vitest';

import {
  buildProposedFilename,
  ensureExtension,
  formatAmount,
  normalizeDate,
  sanitizeFilenameComponent,
  validateTemplate,
} from '../shared/naming.js';
import type { AnalysisResult } from '../shared/types.js';

const sampleAnalysis: AnalysisResult = {
  documentType: '請求書',
  issuerName: 'Reflex Atelier',
  date: '2026/03/14',
  amount: '¥12,000',
  title: '3月保守費',
  description: '月次サポート',
  confidence: 0.92,
};

describe('naming helpers', () => {
  it('normalizes dates into yyyy-mm-dd style tokens', () => {
    expect(normalizeDate('2026/3/4')).toBe('2026-03-04');
    expect(normalizeDate('3/4/2026')).toBe('2026-03-04');
    expect(normalizeDate('2026-03')).toBe('2026-03-01');
  });

  it('sanitizes filename parts and formats currency', () => {
    expect(sanitizeFilenameComponent(' ACME / Japan ')).toBe('ACME _ Japan');
    expect(formatAmount('¥12,000')).toBe('JPY12000');
    expect(formatAmount('USD 98.50')).toBe('USD98.50');
  });

  it('builds filenames from the shared token template', () => {
    expect(buildProposedFilename(sampleAnalysis)).toBe('2026-03-14_Reflex Atelier_請求書_JPY12000');
    expect(
      buildProposedFilename(sampleAnalysis, '{issuer_name}_{title}_{description}'),
    ).toBe('Reflex Atelier_3月保守費_月次サポート');
  });

  it('keeps extensions stable and validates templates', () => {
    expect(ensureExtension('invoice', '.pdf')).toBe('invoice.pdf');
    expect(ensureExtension('invoice.png', '.pdf')).toBe('invoice.pdf');
    expect(validateTemplate('{date}_{issuer_name}')).toEqual({ valid: true });
    expect(validateTemplate('plain-text')).toEqual({
      valid: false,
      message: 'トークンを1つ以上含めてください。例: {date}_{issuer_name}_{document_type}_{amount}',
    });
  });
});
