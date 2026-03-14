export const AVAILABLE_TOKENS = [
  'date',
  'issuer_name',
  'document_type',
  'amount',
  'title',
  'description',
] as const;

export const DEFAULT_TEMPLATE = '{date}_{issuer_name}_{document_type}_{amount}';

export const ITEM_STATUSES = [
  'pending',
  'analyzing',
  'ready',
  'needs_review',
  'skipped',
  'renamed',
  'error',
] as const;

export type AvailableToken = (typeof AVAILABLE_TOKENS)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface AnalysisResult {
  documentType: string;
  issuerName: string | null;
  date: string | null;
  amount: string | null;
  title: string | null;
  description: string | null;
  confidence: number;
}

export interface AppSettings {
  namingTemplate: string;
  openaiModel: string;
}

export interface DocumentItem {
  key: string;
  sourcePath: string;
  currentPath: string;
  displayName: string;
  status: ItemStatus;
  analysis: AnalysisResult | null;
  proposedName: string;
  errorMessage: string;
  skipped: boolean;
  history: string[];
}

export interface Diagnostics {
  apiKeyConfigured: boolean;
  cwd: string;
  envPath: string | null;
  executablePath: string;
  logPath: string;
  settingsPath: string;
  supportedExtensions: string[];
}

export interface RenameResult {
  renamed: DocumentItem[];
  skipped: string[];
}

export interface AnalyzeDocumentsRequest {
  keys?: string[];
}

export interface UpdateProposedNameRequest {
  key: string;
  proposedName: string;
}

export interface SaveSettingsInput {
  namingTemplate: string;
  openaiModel: string;
}

export interface DesktopApi {
  settings: {
    get: () => Promise<AppSettings>;
    save: (input: SaveSettingsInput) => Promise<AppSettings>;
  };
  models: {
    list: () => Promise<string[]>;
  };
  documents: {
    list: () => Promise<DocumentItem[]>;
    pick: () => Promise<DocumentItem[]>;
    add: (paths: string[]) => Promise<DocumentItem[]>;
    clear: () => Promise<DocumentItem[]>;
    analyze: (request?: AnalyzeDocumentsRequest) => Promise<DocumentItem[]>;
    retry: (request?: AnalyzeDocumentsRequest) => Promise<DocumentItem[]>;
    rename: (request?: AnalyzeDocumentsRequest) => Promise<DocumentItem[]>;
    skip: (request?: AnalyzeDocumentsRequest) => Promise<DocumentItem[]>;
    updateProposedName: (request: UpdateProposedNameRequest) => Promise<DocumentItem>;
    open: (key: string) => Promise<void>;
    reveal: (key: string) => Promise<void>;
  };
  app: {
    getDiagnostics: () => Promise<Diagnostics>;
    getPathForFile: (file: File) => string;
  };
}

export const STATUS_LABELS: Record<ItemStatus, string> = {
  pending: '未解析',
  analyzing: '解析中',
  ready: '解析済み',
  needs_review: '要確認',
  skipped: 'スキップ',
  renamed: 'リネーム済み',
  error: 'エラー',
};

export const SUPPORTED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;
export const SUPPORTED_DOCUMENT_EXTENSIONS = ['.pdf', ...SUPPORTED_IMAGE_EXTENSIONS] as const;
