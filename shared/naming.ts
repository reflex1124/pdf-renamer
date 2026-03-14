import { AVAILABLE_TOKENS, DEFAULT_TEMPLATE, type AnalysisResult } from './types.js';

const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\r\n\t]+/g;
const MULTISPACE = /\s+/g;
const TOKEN_PATTERN = /{([a-z_]+)}/g;

const ALPHA_CURRENCY_MARKERS: Array<[string, string]> = [
  ['USD', 'USD'],
  ['US$', 'USD'],
  ['AUD', 'AUD'],
  ['CAD', 'CAD'],
  ['SGD', 'SGD'],
  ['HKD', 'HKD'],
  ['JPY', 'JPY'],
  ['EUR', 'EUR'],
  ['GBP', 'GBP'],
  ['CNY', 'CNY'],
  ['RMB', 'CNY'],
  ['CHF', 'CHF'],
  ['KRW', 'KRW'],
  ['INR', 'INR'],
  ['THB', 'THB'],
  ['TWD', 'TWD'],
  ['NT$', 'TWD'],
];

const SYMBOL_CURRENCY_MARKERS: Array<[string, string]> = [
  ['¥', 'JPY'],
  ['円', 'JPY'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['₩', 'KRW'],
  ['₹', 'INR'],
  ['฿', 'THB'],
  ['$', 'USD'],
];

export function normalizeDate(value: string | null | undefined): string {
  if (!value) {
    return 'unknown-date';
  }

  const normalized = value.normalize('NFKC').trim();
  const parts = normalized.split(/[^\d]+/).filter(Boolean);

  if (parts.length >= 3) {
    const [first, second, third] = parts;
    if (first.length === 4) {
      return `${first}-${second.padStart(2, '0')}-${third.padStart(2, '0')}`;
    }
    if (third.length === 4) {
      const year = third;
      const [month, day] = Number(first) > 12 ? [second, first] : [first, second];
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }

  if (parts.length === 2) {
    const [first, second] = parts;
    if (first.length === 4) {
      return `${first}-${second.padStart(2, '0')}-01`;
    }
    if (second.length === 4) {
      return `${second}-${first.padStart(2, '0')}-01`;
    }
  }

  const digits = normalized.replace(/[^\d]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  return digits || 'unknown-date';
}

export function sanitizeFilenameComponent(
  value: string | null | undefined,
  fallback = 'unknown',
): string {
  let text = (value ?? '').trim();
  if (!text) {
    text = fallback;
  }
  text = text.normalize('NFKC').replace(INVALID_FILENAME_CHARS, '_').replace(MULTISPACE, ' ');
  text = text.replace(/^[ ._]+|[ ._]+$/g, '');
  return text.slice(0, 60) || fallback;
}

export function detectCurrency(value: string): string {
  const normalized = value.normalize('NFKC');
  const upper = normalized.toUpperCase();

  for (const [marker, code] of ALPHA_CURRENCY_MARKERS) {
    if (upper.includes(marker.toUpperCase())) {
      return code;
    }
  }

  for (const [marker, code] of SYMBOL_CURRENCY_MARKERS) {
    if (normalized.includes(marker)) {
      return code;
    }
  }

  return '';
}

export function formatAmount(value: string | null | undefined): string {
  if (!value) {
    return 'unknown-amount';
  }

  const normalized = value.normalize('NFKC').replaceAll(',', '').trim();
  const currency = detectCurrency(normalized);
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) {
    return sanitizeFilenameComponent(normalized, 'unknown-amount');
  }
  return currency ? `${currency}${match[0]}` : sanitizeFilenameComponent(match[0], 'unknown-amount');
}

export function analysisTokens(analysis: AnalysisResult): Record<string, string> {
  return {
    date: normalizeDate(analysis.date),
    issuer_name: sanitizeFilenameComponent(analysis.issuerName, 'unknown-issuer'),
    document_type: sanitizeFilenameComponent(analysis.documentType, 'other'),
    amount: formatAmount(analysis.amount),
    title: sanitizeFilenameComponent(analysis.title, 'untitled'),
    description: sanitizeFilenameComponent(analysis.description, 'no-description'),
  };
}

export function normalizeTemplate(template: string): string {
  const text = (template ?? '').normalize('NFKC').trim();
  return text || DEFAULT_TEMPLATE;
}

export function validateTemplate(template: string): { valid: true } | { valid: false; message: string } {
  const normalized = normalizeTemplate(template);
  const tokens = [...normalized.matchAll(TOKEN_PATTERN)].map((match) => match[1]);

  if (tokens.length === 0) {
    return {
      valid: false,
      message: 'トークンを1つ以上含めてください。例: {date}_{issuer_name}_{document_type}_{amount}',
    };
  }

  const invalidTokens = [...new Set(tokens.filter((token) => !AVAILABLE_TOKENS.includes(token as never)))].sort();
  if (invalidTokens.length > 0) {
    return {
      valid: false,
      message: `未対応トークンがあります: ${invalidTokens.join(', ')}`,
    };
  }

  return { valid: true };
}

export function buildProposedFilename(analysis: AnalysisResult, template = DEFAULT_TEMPLATE): string {
  const normalizedTemplate = normalizeTemplate(template);
  const tokenMap = analysisTokens(analysis);

  const rendered = normalizedTemplate.replace(TOKEN_PATTERN, (_match, token: string) => tokenMap[token] ?? 'unknown');
  const parts = rendered
    .split('_')
    .map((part) => sanitizeFilenameComponent(part, ''))
    .filter(Boolean);

  if (parts.length === 0) {
    return [tokenMap.date, tokenMap.issuer_name, tokenMap.document_type].join('_');
  }

  return parts.join('_');
}

export function ensureExtension(name: string, extension: string): string {
  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;
  let stripped = name.trim();
  if (stripped.toLowerCase().endsWith(normalizedExtension.toLowerCase())) {
    return stripped;
  }
  const existingSuffix = /\.[^.]+$/.exec(stripped)?.[0] ?? '';
  if (existingSuffix) {
    stripped = stripped.slice(0, -existingSuffix.length);
  }
  return `${stripped}${normalizedExtension}`;
}
