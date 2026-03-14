import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, ipcMain, dialog, shell } from "electron";
import fs from "node:fs";
import dotenv from "dotenv";
import fs$1, { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { PDFParse } from "pdf-parse";
import { getData } from "pdf-parse/worker";
import { z } from "zod";
function resolveEnvFileCandidates(executablePath, cwd) {
  const candidates = [
    path.join(path.dirname(executablePath), ".env"),
    path.join(cwd, ".env")
  ];
  return [...new Set(candidates)];
}
function loadEnvironment(executablePath, cwd) {
  for (const candidate of resolveEnvFileCandidates(executablePath, cwd)) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    dotenv.config({ path: candidate, override: false });
    return candidate;
  }
  return null;
}
const AVAILABLE_TOKENS = [
  "date",
  "issuer_name",
  "document_type",
  "amount",
  "title",
  "description"
];
const DEFAULT_TEMPLATE = "{date}_{issuer_name}_{document_type}_{amount}";
const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const SUPPORTED_DOCUMENT_EXTENSIONS = [".pdf", ...SUPPORTED_IMAGE_EXTENSIONS];
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\r\n\t]+/g;
const MULTISPACE = /\s+/g;
const TOKEN_PATTERN = /{([a-z_]+)}/g;
const ALPHA_CURRENCY_MARKERS = [
  ["USD", "USD"],
  ["US$", "USD"],
  ["AUD", "AUD"],
  ["CAD", "CAD"],
  ["SGD", "SGD"],
  ["HKD", "HKD"],
  ["JPY", "JPY"],
  ["EUR", "EUR"],
  ["GBP", "GBP"],
  ["CNY", "CNY"],
  ["RMB", "CNY"],
  ["CHF", "CHF"],
  ["KRW", "KRW"],
  ["INR", "INR"],
  ["THB", "THB"],
  ["TWD", "TWD"],
  ["NT$", "TWD"]
];
const SYMBOL_CURRENCY_MARKERS = [
  ["¥", "JPY"],
  ["円", "JPY"],
  ["€", "EUR"],
  ["£", "GBP"],
  ["₩", "KRW"],
  ["₹", "INR"],
  ["฿", "THB"],
  ["$", "USD"]
];
function normalizeDate(value) {
  if (!value) {
    return "unknown-date";
  }
  const normalized = value.normalize("NFKC").trim();
  const parts = normalized.split(/[^\d]+/).filter(Boolean);
  if (parts.length >= 3) {
    const [first, second, third] = parts;
    if (first.length === 4) {
      return `${first}-${second.padStart(2, "0")}-${third.padStart(2, "0")}`;
    }
    if (third.length === 4) {
      const year = third;
      const [month, day] = Number(first) > 12 ? [second, first] : [first, second];
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }
  if (parts.length === 2) {
    const [first, second] = parts;
    if (first.length === 4) {
      return `${first}-${second.padStart(2, "0")}-01`;
    }
    if (second.length === 4) {
      return `${second}-${first.padStart(2, "0")}-01`;
    }
  }
  const digits = normalized.replace(/[^\d]/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  return digits || "unknown-date";
}
function sanitizeFilenameComponent(value, fallback = "unknown") {
  let text = (value ?? "").trim();
  if (!text) {
    text = fallback;
  }
  text = text.normalize("NFKC").replace(INVALID_FILENAME_CHARS, "_").replace(MULTISPACE, " ");
  text = text.replace(/^[ ._]+|[ ._]+$/g, "");
  return text.slice(0, 60) || fallback;
}
function detectCurrency(value) {
  const normalized = value.normalize("NFKC");
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
  return "";
}
function formatAmount(value) {
  if (!value) {
    return "unknown-amount";
  }
  const normalized = value.normalize("NFKC").replaceAll(",", "").trim();
  const currency = detectCurrency(normalized);
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) {
    return sanitizeFilenameComponent(normalized, "unknown-amount");
  }
  return currency ? `${currency}${match[0]}` : sanitizeFilenameComponent(match[0], "unknown-amount");
}
function analysisTokens(analysis) {
  return {
    date: normalizeDate(analysis.date),
    issuer_name: sanitizeFilenameComponent(analysis.issuerName, "unknown-issuer"),
    document_type: sanitizeFilenameComponent(analysis.documentType, "other"),
    amount: formatAmount(analysis.amount),
    title: sanitizeFilenameComponent(analysis.title, "untitled"),
    description: sanitizeFilenameComponent(analysis.description, "no-description")
  };
}
function normalizeTemplate(template) {
  const text = (template ?? "").normalize("NFKC").trim();
  return text || DEFAULT_TEMPLATE;
}
function validateTemplate(template) {
  const normalized = normalizeTemplate(template);
  const tokens = [...normalized.matchAll(TOKEN_PATTERN)].map((match) => match[1]);
  if (tokens.length === 0) {
    return {
      valid: false,
      message: "トークンを1つ以上含めてください。例: {date}_{issuer_name}_{document_type}_{amount}"
    };
  }
  const invalidTokens = [...new Set(tokens.filter((token) => !AVAILABLE_TOKENS.includes(token)))].sort();
  if (invalidTokens.length > 0) {
    return {
      valid: false,
      message: `未対応トークンがあります: ${invalidTokens.join(", ")}`
    };
  }
  return { valid: true };
}
function buildProposedFilename(analysis, template = DEFAULT_TEMPLATE) {
  const normalizedTemplate = normalizeTemplate(template);
  const tokenMap = analysisTokens(analysis);
  const rendered = normalizedTemplate.replace(TOKEN_PATTERN, (_match, token) => tokenMap[token] ?? "unknown");
  const parts = rendered.split("_").map((part) => sanitizeFilenameComponent(part, "")).filter(Boolean);
  if (parts.length === 0) {
    return [tokenMap.date, tokenMap.issuer_name, tokenMap.document_type].join("_");
  }
  return parts.join("_");
}
function ensureExtension(name, extension) {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  let stripped = name.trim();
  if (stripped.toLowerCase().endsWith(normalizedExtension.toLowerCase())) {
    return stripped;
  }
  const existingSuffix = /\.[^.]+$/.exec(stripped)?.[0] ?? "";
  if (existingSuffix) {
    stripped = stripped.slice(0, -existingSuffix.length);
  }
  return `${stripped}${normalizedExtension}`;
}
class DocumentStore {
  items = /* @__PURE__ */ new Map();
  list() {
    return [...this.items.values()].map((item) => this.toDocumentItem(item));
  }
  add(paths) {
    for (const resolvedPath of paths) {
      if (this.items.has(resolvedPath)) {
        continue;
      }
      this.items.set(resolvedPath, {
        key: resolvedPath,
        sourcePath: resolvedPath,
        currentPath: resolvedPath,
        status: "pending",
        analysis: null,
        proposedName: "",
        errorMessage: "",
        skipped: false,
        history: []
      });
    }
    return this.list();
  }
  clear() {
    this.items.clear();
    return [];
  }
  get(key) {
    const item = this.items.get(key);
    return item ? this.toDocumentItem(item) : null;
  }
  getMany(keys) {
    if (!keys || keys.length === 0) {
      return this.list();
    }
    return keys.map((key) => this.get(key)).filter((item) => Boolean(item));
  }
  updateAnalysis(key, analysis, proposedName) {
    const current = this.requireItem(key);
    current.analysis = analysis;
    current.proposedName = proposedName;
    current.errorMessage = "";
    current.status = analysis.confidence >= 0.8 ? "ready" : "needs_review";
    current.skipped = false;
    current.history = [...current.history, `analyzed:${JSON.stringify(analysis)}`];
    return this.toDocumentItem(current);
  }
  markAnalyzing(key) {
    return this.patch(key, {
      status: "analyzing",
      errorMessage: "",
      skipped: false
    });
  }
  markError(key, message) {
    const current = this.requireItem(key);
    current.status = "error";
    current.errorMessage = message;
    current.history = [...current.history, `error:${message}`];
    return this.toDocumentItem(current);
  }
  markSkipped(key) {
    const current = this.requireItem(key);
    current.status = "skipped";
    current.skipped = true;
    current.history = [...current.history, "skipped"];
    return this.toDocumentItem(current);
  }
  markRenamed(key, nextPath) {
    const current = this.requireItem(key);
    current.currentPath = nextPath;
    current.status = "renamed";
    current.history = [...current.history, `renamed:${path.basename(nextPath)}`];
    return this.toDocumentItem(current);
  }
  updateProposedName(key, proposedName) {
    return this.patch(key, { proposedName });
  }
  setStatus(key, status) {
    return this.patch(key, { status });
  }
  patch(key, partial) {
    const current = this.requireItem(key);
    const next = { ...current, ...partial };
    this.items.set(key, next);
    return this.toDocumentItem(next);
  }
  requireItem(key) {
    const item = this.items.get(key);
    if (!item) {
      throw new Error(`対象ドキュメントが見つかりません: ${key}`);
    }
    return item;
  }
  toDocumentItem(item) {
    return {
      ...item,
      displayName: path.basename(item.currentPath)
    };
  }
}
class DocumentController {
  constructor(settingsStore, analyzer, logger, store) {
    this.settingsStore = settingsStore;
    this.analyzer = analyzer;
    this.logger = logger;
    this.store = store ?? new DocumentStore();
  }
  store;
  listDocuments() {
    return this.store.list();
  }
  async addDocuments(paths) {
    const filtered = (await Promise.all(
      paths.map(async (candidatePath) => {
        let resolved = "";
        try {
          resolved = await fs$1.realpath(candidatePath);
        } catch {
          return null;
        }
        const extension = path.extname(resolved).toLowerCase();
        if (!SUPPORTED_DOCUMENT_EXTENSIONS.includes(extension)) {
          return null;
        }
        return resolved;
      })
    )).filter((value) => Boolean(value));
    const documents = this.store.add(filtered);
    this.logger.info("Documents added", { count: filtered.length });
    return documents;
  }
  clearDocuments() {
    this.logger.info("Cleared all documents");
    return this.store.clear();
  }
  async saveSettings(input) {
    const template = normalizeTemplate(input.namingTemplate);
    const validation = validateTemplate(template);
    if (!validation.valid) {
      throw new Error(validation.message);
    }
    const nextSettings = {
      namingTemplate: template,
      openaiModel: input.openaiModel.trim() || "gpt-4.1-mini"
    };
    const saved = await this.settingsStore.save(nextSettings);
    for (const item of this.store.list()) {
      if (!item.analysis) {
        continue;
      }
      const proposedName = ensureExtension(
        buildProposedFilename(item.analysis, saved.namingTemplate),
        path.extname(item.currentPath)
      );
      this.store.updateProposedName(item.key, proposedName);
    }
    return saved;
  }
  loadSettings() {
    return this.settingsStore.load();
  }
  async analyzeDocuments(keys, force = false) {
    const settings = await this.settingsStore.load();
    const targets = this.getAnalysisTargets(keys, force);
    if (targets.length === 0) {
      return this.store.list();
    }
    for (const item of targets) {
      this.store.markAnalyzing(item.key);
    }
    const batchable = [];
    const singleItems = [];
    for (const item of targets) {
      const extension = path.extname(item.currentPath).toLowerCase();
      if (extension === ".pdf" && await this.analyzer.hasExtractableText(item.currentPath)) {
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
            ensureExtension(buildProposedFilename(analysis, settings.namingTemplate), path.extname(item.currentPath))
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
            ensureExtension(buildProposedFilename(analysis, settings.namingTemplate), path.extname(item.currentPath))
          );
        } catch (error) {
          this.store.markError(item.key, toErrorMessage(error));
        }
      })
    );
    return this.store.list();
  }
  retryDocuments(keys) {
    return this.analyzeDocuments(keys, true);
  }
  async renameDocuments(keys) {
    const targets = this.targetDocuments(keys);
    for (const item of targets) {
      if (!item.proposedName || item.status === "renamed") {
        continue;
      }
      const extension = path.extname(item.currentPath);
      const normalizedName = ensureExtension(item.proposedName, extension);
      const sameNameTarget = path.join(path.dirname(item.currentPath), normalizedName);
      const target = sameNameTarget === item.currentPath ? sameNameTarget : await resolveCollision(path.dirname(item.currentPath), normalizedName, extension);
      if (target !== item.currentPath) {
        await fs$1.rename(item.currentPath, target);
      }
      this.store.markRenamed(item.key, target);
    }
    return this.store.list();
  }
  async skipDocuments(keys) {
    for (const item of this.targetDocuments(keys)) {
      this.store.markSkipped(item.key);
    }
    return this.store.list();
  }
  updateProposedName(request) {
    const item = this.store.get(request.key);
    if (!item) {
      throw new Error("対象ドキュメントが見つかりません。");
    }
    const edited = sanitizeFilenameComponent(request.proposedName, "renamed") || "renamed";
    const nextName = ensureExtension(edited, path.extname(item.currentPath));
    return this.store.updateProposedName(request.key, nextName);
  }
  async listModels() {
    return this.analyzer.listModels();
  }
  getAnalysisTargets(keys, force = false) {
    return this.targetDocuments(keys).filter((item) => {
      if (force) {
        return item.status !== "analyzing";
      }
      return ["pending", "error", "needs_review", "ready"].includes(item.status);
    });
  }
  targetDocuments(keys) {
    const explicit = this.store.getMany(keys);
    if (explicit.length > 0) {
      return explicit;
    }
    return this.store.list();
  }
}
async function resolveCollision(directory, targetName, extension) {
  const candidate = path.join(directory, ensureExtension(targetName, extension));
  if (!await exists(candidate)) {
    return candidate;
  }
  const { name, ext } = path.parse(candidate);
  let index = 1;
  while (true) {
    const nextCandidate = path.join(directory, `${name} (${index})${ext}`);
    if (!await exists(nextCandidate)) {
      return nextCandidate;
    }
    index += 1;
  }
}
async function exists(filePath) {
  try {
    await fs$1.access(filePath);
    return true;
  } catch {
    return false;
  }
}
function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
class Logger {
  filePath;
  constructor(filePath) {
    this.filePath = filePath;
  }
  async init() {
    await fs$1.mkdir(path.dirname(this.filePath), { recursive: true });
  }
  info(message, meta) {
    void this.write("INFO", message, meta);
  }
  warn(message, meta) {
    void this.write("WARN", message, meta);
  }
  error(message, meta) {
    void this.write("ERROR", message, meta);
  }
  async write(level, message, meta) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const suffix = meta === void 0 ? "" : ` ${safeSerialize(meta)}`;
    const line = `${timestamp} [${level}] ${message}${suffix}
`;
    await fs$1.appendFile(this.filePath, line, "utf8");
    if (level === "ERROR") {
      console.error(line.trimEnd());
      return;
    }
    if (level === "WARN") {
      console.warn(line.trimEnd());
      return;
    }
    console.info(line.trimEnd());
  }
}
function safeSerialize(value) {
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack
    });
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
PDFParse.setWorker(getData());
const SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const analysisSchema = z.object({
  documentType: z.string(),
  issuerName: z.string().nullable(),
  date: z.string().nullable(),
  amount: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  confidence: z.number()
});
const batchAnalysisSchema = z.object({
  documents: z.array(
    z.object({
      document_id: z.string(),
      analysis: analysisSchema
    })
  )
});
class OpenAiDocumentAnalyzer {
  modelRef;
  apiKeyRef;
  constructor(options) {
    this.modelRef = options.getModel;
    this.apiKeyRef = options.getApiKey;
  }
  async listModels() {
    const client = this.getClient();
    const response = await client.models.list();
    const preferredModels = response.data.map((model) => model.id).filter((modelId) => modelId.startsWith("gpt-")).filter((modelId) => !SNAPSHOT_SUFFIX.test(modelId)).filter((modelId) => !["realtime", "audio", "transcribe", "tts", "search"].some((token) => modelId.includes(token)));
    const priority = /* @__PURE__ */ new Map([
      ["gpt-5", 0],
      ["gpt-5-mini", 1],
      ["gpt-5-nano", 2],
      ["gpt-4.1", 3],
      ["gpt-4.1-mini", 4],
      ["gpt-4.1-nano", 5],
      ["gpt-4o", 6],
      ["gpt-4o-mini", 7]
    ]);
    return [...new Set(preferredModels)].sort((left, right) => {
      const leftPriority = priority.get(left) ?? 99;
      const rightPriority = priority.get(right) ?? 99;
      return leftPriority - rightPriority || left.localeCompare(right);
    });
  }
  async extractText(pdfPath, maxChars = 12e3) {
    const buffer = await readFile(pdfPath);
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    const text = parsed.text.trim();
    if (!text) {
      throw new Error("PDF からテキストを抽出できませんでした。画像PDFはOCRが必要です。");
    }
    return text.slice(0, maxChars);
  }
  async hasExtractableText(documentPath, threshold = 20) {
    try {
      const text = await this.extractText(documentPath, 2e3);
      return text.trim().length >= threshold;
    } catch {
      return false;
    }
  }
  async analyzePdfs(pdfPaths) {
    if (pdfPaths.length === 0) {
      return {};
    }
    const documents = await Promise.all(
      pdfPaths.map(async (pdfPath, index) => ({
        document_id: String(index + 1),
        filename: path.basename(pdfPath),
        text: await this.extractText(pdfPath, 6e3)
      }))
    );
    const input = [
      textMessage(
        "msg_system_batch",
        "system",
        "You extract structured metadata from PDF text. Multiple documents are included in one request. Treat each document independently, but use the full batch for consistency of naming and categorization. Return every provided document_id exactly once. The documentType must always be written in Japanese. Use labels such as '請求書', '領収書', '見積書', '納品書', '契約書', '注文書', '明細書', or 'その他'. Extract description from fields such as 内容, 内訳, Description, Item, Details, or similar. description should be a short summary of what the charge or document is for. For missing values, use null. Preserve the original currency in amount values and normalize it to ISO currency codes. For example use 'USD 12.34', 'JPY 1200', 'EUR 9.99', or 'GBP 72.10'. Dates must be normalized to YYYY-MM-DD when possible, or YYYY-MM-01 if only year and month are known. Confidence must be a number between 0.0 and 1.0."
      ),
      textMessage(
        "msg_user_batch",
        "user",
        `Analyze the following PDF texts and return structured results for all documents.

${JSON.stringify(documents, null, 2)}`
      )
    ];
    const response = await this.getClient().responses.parse({
      model: await this.modelRef(),
      input,
      text: {
        format: zodTextFormat(batchAnalysisSchema, "batch_document_analysis")
      }
    });
    const parsed = response.output_parsed;
    if (!parsed) {
      throw new Error("OpenAI から解析結果を取得できませんでした。");
    }
    const resultsById = new Map(parsed.documents.map((item) => [item.document_id, clampConfidence(item.analysis)]));
    const missingIds = documents.filter((document) => !resultsById.has(document.document_id)).map((document) => document.document_id);
    if (missingIds.length > 0) {
      throw new Error(`解析結果が不足しています: ${missingIds.join(", ")}`);
    }
    return Object.fromEntries(
      pdfPaths.map((pdfPath, index) => [pdfPath, resultsById.get(String(index + 1))])
    );
  }
  async analyzeDocument(documentPath) {
    const extension = path.extname(documentPath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) {
      return this.analyzeImage(documentPath);
    }
    if (extension === ".pdf") {
      if (await this.hasExtractableText(documentPath)) {
        const result = await this.analyzePdfs([documentPath]);
        return result[documentPath];
      }
      return this.analyzePdfWithFileInput(documentPath);
    }
    throw new Error(`未対応のファイル形式です: ${extension}`);
  }
  async analyzePdfWithFileInput(pdfPath) {
    const client = this.getClient();
    const uploaded = await client.files.create({
      file: fs.createReadStream(pdfPath),
      purpose: "user_data"
    });
    const input = [
      ...singleDocumentPrompt(),
      userMessage([
        {
          type: "input_file",
          file_id: uploaded.id
        },
        {
          type: "input_text",
          text: `Analyze this PDF file named '${path.basename(pdfPath)}'. Use OCR if needed and return the structured result.`
        }
      ])
    ];
    const response = await client.responses.parse({
      model: await this.modelRef(),
      input,
      text: {
        format: zodTextFormat(analysisSchema, "document_analysis")
      }
    });
    if (!response.output_parsed) {
      throw new Error("OpenAI からPDF解析結果を取得できませんでした。");
    }
    return clampConfidence(response.output_parsed);
  }
  async analyzeImage(imagePath) {
    const suffix = path.extname(imagePath).toLowerCase().replace(".", "") || "png";
    const encoded = (await readFile(imagePath)).toString("base64");
    const input = [
      ...singleDocumentPrompt(),
      userMessage([
        {
          type: "input_text",
          text: `Analyze this document image named '${path.basename(imagePath)}'. Read the image directly and return the structured result.`
        },
        {
          type: "input_image",
          detail: "auto",
          image_url: `data:image/${suffix};base64,${encoded}`
        }
      ])
    ];
    const response = await this.getClient().responses.parse({
      model: await this.modelRef(),
      input,
      text: {
        format: zodTextFormat(analysisSchema, "document_analysis")
      }
    });
    if (!response.output_parsed) {
      throw new Error("OpenAI から画像解析結果を取得できませんでした。");
    }
    return clampConfidence(response.output_parsed);
  }
  getClient() {
    const apiKey = this.apiKeyRef();
    if (!apiKey) {
      throw new Error("環境変数 OPENAI_API_KEY が設定されていません。");
    }
    return new OpenAI({ apiKey });
  }
}
function singleDocumentPrompt() {
  return [
    textMessage(
      "msg_system_single",
      "system",
      "You extract structured metadata from business documents. The documentType must always be written in Japanese. Use labels such as '請求書', '領収書', '見積書', '納品書', '契約書', '注文書', '明細書', or 'その他'. Extract description from fields such as 内容, 内訳, Description, Item, Details, or similar. description should be a short summary of what the charge or document is for. For missing values, use null. Preserve the original currency in amount values and normalize it to ISO currency codes. For example use 'USD 12.34', 'JPY 1200', 'EUR 9.99', or 'GBP 72.10'. Dates must be normalized to YYYY-MM-DD when possible, or YYYY-MM-01 if only year and month are known. Confidence must be a number between 0.0 and 1.0."
    )
  ];
}
function userMessage(content) {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    role: "user",
    content
  };
}
function textMessage(id, role, text) {
  return {
    id,
    role,
    content: [
      {
        type: "input_text",
        text
      }
    ]
  };
}
function clampConfidence(analysis) {
  return {
    documentType: analysis.documentType,
    issuerName: analysis.issuerName,
    date: analysis.date,
    amount: analysis.amount,
    title: analysis.title,
    description: analysis.description,
    confidence: Math.max(0, Math.min(1, analysis.confidence))
  };
}
const DEFAULT_SETTINGS = {
  namingTemplate: DEFAULT_TEMPLATE,
  openaiModel: "gpt-4.1-mini"
};
class SettingsStore {
  filePath;
  constructor(filePath) {
    this.filePath = filePath;
  }
  async load() {
    try {
      const raw = await fs$1.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        namingTemplate: parsed.namingTemplate || DEFAULT_SETTINGS.namingTemplate,
        openaiModel: parsed.openaiModel || DEFAULT_SETTINGS.openaiModel
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  async save(settings) {
    await fs$1.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs$1.writeFile(this.filePath, `${JSON.stringify(settings, null, 2)}
`, "utf8");
    return settings;
  }
}
let mainWindow = null;
let controller = null;
let diagnosticsState = null;
let loggerRef = null;
let ipcRegistered = false;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
async function bootstrap() {
  const executablePath = app.getPath("exe");
  const cwd = process.cwd();
  const envPath = loadEnvironment(executablePath, cwd);
  const userDataPath = app.getPath("userData");
  const logger = new Logger(path.join(userDataPath, "logs", "app.log"));
  await logger.init();
  loggerRef = logger;
  logger.info("Application starting", { executablePath, cwd, envPath });
  const settingsStore = new SettingsStore(path.join(userDataPath, "settings.json"));
  const analyzer = new OpenAiDocumentAnalyzer({
    getApiKey: () => process.env.OPENAI_API_KEY,
    getModel: async () => (await settingsStore.load()).openaiModel
  });
  controller = new DocumentController(settingsStore, analyzer, logger);
  diagnosticsState = {
    apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    cwd,
    envPath,
    executablePath,
    logPath: logger.filePath,
    settingsPath: settingsStore.filePath,
    supportedExtensions: [...SUPPORTED_DOCUMENT_EXTENSIONS]
  };
  if (!ipcRegistered) {
    registerIpcHandlers();
    ipcRegistered = true;
  }
  await createWindow();
}
async function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 720,
    title: "PDF Renamer",
    backgroundColor: "#06121c",
    webPreferences: {
      preload: path.join(moduleDir, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.resolve(moduleDir, "../renderer/index.html"));
  }
}
function requireController() {
  if (!controller) {
    throw new Error("アプリケーションの初期化が完了していません。");
  }
  return controller;
}
function requireDiagnostics() {
  if (!diagnosticsState) {
    throw new Error("診断情報がまだ利用できません。");
  }
  return diagnosticsState;
}
function registerIpcHandlers() {
  ipcMain.handle("settings:get", async () => requireController().loadSettings());
  ipcMain.handle("settings:save", async (_event, input) => requireController().saveSettings(input));
  ipcMain.handle("models:list", async () => requireController().listModels());
  ipcMain.handle("documents:pick", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Documents",
          extensions: SUPPORTED_DOCUMENT_EXTENSIONS.map((extension) => extension.replace(".", ""))
        }
      ]
    });
    if (result.canceled) {
      return requireController().listDocuments();
    }
    return requireController().addDocuments(result.filePaths);
  });
  ipcMain.handle("documents:add", async (_event, paths) => requireController().addDocuments(paths));
  ipcMain.handle("documents:list", async () => requireController().listDocuments());
  ipcMain.handle("documents:clear", async () => requireController().clearDocuments());
  ipcMain.handle("documents:analyze", async (_event, request) => requireController().analyzeDocuments(request?.keys));
  ipcMain.handle("documents:retry", async (_event, request) => requireController().retryDocuments(request?.keys));
  ipcMain.handle("documents:rename", async (_event, request) => requireController().renameDocuments(request?.keys));
  ipcMain.handle("documents:skip", async (_event, request) => requireController().skipDocuments(request?.keys));
  ipcMain.handle("documents:update-proposed-name", async (_event, request) => requireController().updateProposedName(request));
  ipcMain.handle("documents:open", async (_event, key) => {
    const item = requireController().store.get(key);
    if (!item) {
      throw new Error("対象ドキュメントが見つかりません。");
    }
    await shell.openPath(item.currentPath);
  });
  ipcMain.handle("documents:reveal", async (_event, key) => {
    const item = requireController().store.get(key);
    if (!item) {
      throw new Error("対象ドキュメントが見つかりません。");
    }
    shell.showItemInFolder(item.currentPath);
  });
  ipcMain.handle("app:get-diagnostics", async () => requireDiagnostics());
  app.on("window-all-closed", () => {
    loggerRef?.info("All windows closed");
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
app.whenReady().then(async () => {
  await bootstrap();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});
