import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from 'react';

import {
  buildProposedFilename,
  ensureExtension,
  normalizeTemplate,
  validateTemplate,
} from '@shared/naming';
import { DEFAULT_TEMPLATE, STATUS_LABELS, type AppSettings, type Diagnostics, type DocumentItem } from '@shared/types';

declare global {
  interface Window {
    desktopApi: import('@shared/types').DesktopApi;
  }
}

type BusyAction = 'loading' | 'saving-settings' | 'loading-models' | 'analyzing' | 'retrying' | 'renaming' | 'skipping' | null;

const EMPTY_SETTINGS: AppSettings = {
  namingTemplate: DEFAULT_TEMPLATE,
  openaiModel: 'gpt-4.1-mini',
};

const EMPTY_DIAGNOSTICS: Diagnostics = {
  apiKeyConfigured: false,
  cwd: '',
  envPath: null,
  executablePath: '',
  logPath: '',
  settingsPath: '',
  supportedExtensions: [],
};

export default function App() {
  const api = window.desktopApi;
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(EMPTY_SETTINGS);
  const [templateDraft, setTemplateDraft] = useState(DEFAULT_TEMPLATE);
  const [modelDraft, setModelDraft] = useState('gpt-4.1-mini');
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>(EMPTY_DIAGNOSTICS);
  const [busyAction, setBusyAction] = useState<BusyAction>('loading');
  const [notice, setNotice] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [isDropActive, setIsDropActive] = useState(false);
  const deferredDocuments = useDeferredValue(documents);

  useEffect(() => {
    let isMounted = true;
    void (async () => {
      try {
        const [nextSettings, nextDiagnostics, nextDocuments] = await Promise.all([
          api.settings.get(),
          api.app.getDiagnostics(),
          api.documents.list(),
        ]);
        if (!isMounted) {
          return;
        }
        startTransition(() => {
          setSettings(nextSettings);
          setTemplateDraft(nextSettings.namingTemplate);
          setModelDraft(nextSettings.openaiModel);
          setDiagnostics(nextDiagnostics);
          setDocuments(nextDocuments);
          setBusyAction(null);
        });
      } catch (nextError) {
        if (!isMounted) {
          return;
        }
        setBusyAction(null);
        setError(toMessage(nextError));
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [api.app, api.documents, api.settings]);

  useEffect(() => {
    let isMounted = true;
    void (async () => {
      try {
        const nextModels = await api.models.list();
        if (!isMounted) {
          return;
        }
        startTransition(() => {
          setModelOptions(nextModels);
        });
      } catch {
        // Keep manual input usable even if model lookup fails.
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [api.models]);

  useEffect(() => {
    if (documents.length === 0) {
      setCurrentKey(null);
      setCheckedKeys([]);
      return;
    }

    if (currentKey && documents.some((item) => item.key === currentKey)) {
      return;
    }

    setCurrentKey(documents[0]?.key ?? null);
  }, [currentKey, documents]);

  useEffect(() => {
    setCheckedKeys((previous) => previous.filter((key) => documents.some((item) => item.key === key)));
  }, [documents]);

  const currentDocument = useMemo(
    () => deferredDocuments.find((item) => item.key === currentKey) ?? null,
    [currentKey, deferredDocuments],
  );

  const allChecked = documents.length > 0 && checkedKeys.length === documents.length;
  const checkedActionKeys = useMemo(() => checkedKeys, [checkedKeys]);
  const actionKeys = useMemo(() => {
    if (checkedKeys.length > 0) {
      return checkedKeys;
    }
    if (currentKey) {
      return [currentKey];
    }
    return [];
  }, [checkedKeys, currentKey]);

  async function refreshWith(promise: Promise<DocumentItem[]>, action: BusyAction, successMessage: string, optimistic?: (items: DocumentItem[]) => DocumentItem[]) {
    setBusyAction(action);
    setError('');
    setNotice('');
    if (optimistic) {
      startTransition(() => {
        setDocuments((previous) => optimistic(previous));
      });
    }

    try {
      const nextDocuments = await promise;
      startTransition(() => {
        setDocuments(nextDocuments);
        setNotice(successMessage);
      });
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePick() {
    setBusyAction(null);
    setError('');
    setNotice('');
    try {
      const previousKeys = new Set(documents.map((item) => item.key));
      const nextDocuments = await api.documents.pick();
      const addedKeys = nextDocuments.filter((item) => !previousKeys.has(item.key)).map((item) => item.key);
      startTransition(() => {
        setDocuments(nextDocuments);
        setCheckedKeys((previous) => [...new Set([...previous, ...addedKeys])]);
        setNotice('ドキュメントを追加しました。');
      });
    } catch (nextError) {
      setError(toMessage(nextError));
    }
  }

  async function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDropActive(false);
    await handleDroppedFiles(event.dataTransfer.files);
  }

  useEffect(() => {
    function onWindowDragOver(event: globalThis.DragEvent) {
      event.preventDefault();
      setIsDropActive(true);
    }

    function onWindowDragLeave(event: globalThis.DragEvent) {
      if (event.relatedTarget === null) {
        setIsDropActive(false);
      }
    }

    function onWindowDrop(event: globalThis.DragEvent) {
      event.preventDefault();
      setIsDropActive(false);
      if (!event.dataTransfer) {
        return;
      }
      void handleDroppedFiles(event.dataTransfer.files);
    }

    window.addEventListener('dragover', onWindowDragOver);
    window.addEventListener('dragleave', onWindowDragLeave);
    window.addEventListener('drop', onWindowDrop);

    return () => {
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('dragleave', onWindowDragLeave);
      window.removeEventListener('drop', onWindowDrop);
    };
  }, []);

  async function handleDroppedFiles(fileList: FileList) {
    const paths = Array.from(fileList)
      .map((file) => api.app.getPathForFile(file))
      .filter(Boolean);

    if (paths.length === 0) {
      setError('ドロップされたファイルのパスを取得できませんでした。');
      return;
    }

    try {
      const previousKeys = new Set(documents.map((item) => item.key));
      const nextDocuments = await api.documents.add(paths);
      const addedKeys = nextDocuments.filter((item) => !previousKeys.has(item.key)).map((item) => item.key);
      startTransition(() => {
        setDocuments(nextDocuments);
        setCheckedKeys((previous) => [...new Set([...previous, ...addedKeys])]);
        setNotice('ドキュメントを追加しました。');
        setError('');
      });
    } catch (nextError) {
      setError(toMessage(nextError));
    }
  }

  async function handleAnalyze() {
    if (checkedActionKeys.length === 0) {
      setError('解析するファイルにチェックを入れてください。');
      setNotice('');
      return;
    }
    await refreshWith(
      api.documents.analyze({ keys: checkedActionKeys }),
      'analyzing',
      '解析が完了しました。',
      (items) =>
        items.map((item) =>
          checkedActionKeys.includes(item.key) ? { ...item, status: 'analyzing', errorMessage: '' } : item,
        ),
    );
  }

  async function handleRetry() {
    if (checkedActionKeys.length === 0) {
      setError('再解析するファイルにチェックを入れてください。');
      setNotice('');
      return;
    }
    await refreshWith(
      api.documents.retry({ keys: checkedActionKeys }),
      'retrying',
      '再解析が完了しました。',
      (items) => items.map((item) => (checkedActionKeys.includes(item.key) ? { ...item, status: 'analyzing', errorMessage: '' } : item)),
    );
  }

  async function handleRename() {
    if (actionKeys.length === 0) {
      return;
    }
    await refreshWith(api.documents.rename({ keys: actionKeys }), 'renaming', 'リネームを反映しました。');
  }

  async function handleSkip() {
    if (actionKeys.length === 0) {
      return;
    }
    await refreshWith(api.documents.skip({ keys: actionKeys }), 'skipping', '対象をスキップしました。');
  }

  async function handleClear() {
    await refreshWith(api.documents.clear(), null, '一覧をクリアしました。');
  }

  async function handleSaveSettings() {
    const normalizedTemplate = normalizeTemplate(templateDraft);
    const validation = validateTemplate(normalizedTemplate);
    if (!validation.valid) {
      setError(validation.message);
      return;
    }

    setBusyAction('saving-settings');
    setError('');
    setNotice('');
    try {
      const saved = await api.settings.save({
        namingTemplate: normalizedTemplate,
        openaiModel: modelDraft,
      });

      startTransition(() => {
        setSettings(saved);
        setTemplateDraft(saved.namingTemplate);
        setModelDraft(saved.openaiModel);
        setDocuments((previous) =>
          previous.map((item) => {
            if (!item.analysis) {
              return item;
            }
            return {
              ...item,
              proposedName: ensureExtension(
                buildProposedFilename(item.analysis, saved.namingTemplate),
                extensionOf(item.currentPath),
              ),
            };
          }),
        );
        setNotice('設定を保存しました。');
      });
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleLoadModels() {
    setBusyAction('loading-models');
    setError('');
    setNotice('');
    try {
      const nextModels = await api.models.list();
      startTransition(() => {
        setModelOptions(nextModels);
        setNotice('OpenAI からモデル一覧を取得しました。');
      });
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleProposedNameSave(value: string) {
    if (!currentDocument) {
      return;
    }

    try {
      const nextItem = await api.documents.updateProposedName({
        key: currentDocument.key,
        proposedName: value,
      });
      setDocuments((previous) => previous.map((item) => (item.key === nextItem.key ? nextItem : item)));
      setNotice('候補ファイル名を更新しました。');
      setError('');
    } catch (nextError) {
      setError(toMessage(nextError));
    }
  }

  function toggleChecked(key: string) {
    setCheckedKeys((previous) => (previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key]));
  }

  function toggleAll() {
    setCheckedKeys(allChecked ? [] : documents.map((item) => item.key));
  }

  const templateTokens = useMemo(() => ['{date}', '{issuer_name}', '{document_type}', '{amount}', '{title}', '{description}'], []);
  const selectedCount = checkedKeys.length;

  return (
    <main
      className="h-screen overflow-hidden bg-[linear-gradient(180deg,_#08111b_0%,_#060c14_100%)] text-slate-50"
      onDragOver={(event) => {
        event.preventDefault();
        setIsDropActive(true);
      }}
      onDrop={(event) => void handleDrop(event)}
    >
      <div className="mx-auto flex h-screen max-w-[1280px] flex-col gap-3 px-3 py-3">
        <section
          className={`rounded-[20px] border px-4 py-3 transition ${isDropActive ? 'border-cyan-300 bg-cyan-300/10' : 'border-white/10 bg-white/[0.04]'}`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDropActive(true);
          }}
          onDragLeave={() => setIsDropActive(false)}
          onDrop={(event) => void handleDrop(event)}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <ActionButton disabled={documents.length === 0 || busyAction !== null} label={busyAction === 'analyzing' ? '解析中...' : '解析'} onClick={() => void handleAnalyze()} />
              <ActionButton disabled={actionKeys.length === 0 || busyAction !== null} label={busyAction === 'retrying' ? '再解析中...' : '再解析'} onClick={() => void handleRetry()} tone="secondary" />
              <ActionButton disabled={actionKeys.length === 0 || busyAction !== null} label={busyAction === 'renaming' ? 'リネーム中...' : 'リネーム'} onClick={() => void handleRename()} tone="success" />
              <ActionButton disabled={actionKeys.length === 0 || busyAction !== null} label={busyAction === 'skipping' ? '処理中...' : 'スキップ'} onClick={() => void handleSkip()} tone="muted" />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
              <CompactBadge label="件数" value={String(documents.length)} />
              <CompactBadge label="選択" value={String(selectedCount)} />
              <CompactBadge label="API" value={diagnostics.apiKeyConfigured ? 'OK' : 'NG'} tone={diagnostics.apiKeyConfigured ? 'good' : 'warn'} />
              <CompactBadge label="モデル" value={settings.openaiModel} />
            </div>
          </div>
        </section>

        <section className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[320px_minmax(0,1fr)_300px]">
          <div className="flex min-h-0 flex-col rounded-[20px] border border-white/10 bg-white/[0.035] p-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium text-white">ファイル</div>
                <ActionButton compact label="追加" onClick={() => void handlePick()} tone="secondary" />
                <ActionButton compact label="クリア" onClick={() => void handleClear()} tone="secondary" />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input checked={allChecked} onChange={toggleAll} type="checkbox" />
                すべて
              </label>
            </div>

            <div className="flex-1 overflow-auto">
              {documents.length === 0 ? (
                <EmptyState />
              ) : (
                <div className="space-y-2">
                  {documents.map((item) => (
                    <button
                      key={item.key}
                      className={`w-full rounded-[16px] border p-3 text-left transition ${
                        currentKey === item.key
                          ? 'border-cyan-300/70 bg-cyan-400/10'
                          : 'border-white/8 bg-white/[0.03] hover:border-white/16 hover:bg-white/[0.05]'
                      }`}
                      onClick={() => setCurrentKey(item.key)}
                      onDoubleClick={() => void api.documents.open(item.key)}
                      type="button"
                    >
                      <div className="flex items-start gap-3">
                        <input
                          checked={checkedKeys.includes(item.key)}
                          className="mt-1"
                          onChange={() => toggleChecked(item.key)}
                          onClick={(event) => event.stopPropagation()}
                          type="checkbox"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusPill status={item.status} />
                            <span className="text-[11px] text-slate-500">{item.analysis ? `${Math.round(item.analysis.confidence * 100)}%` : '-'}</span>
                          </div>
                          <p className="mt-2 truncate text-sm font-medium text-white">{item.displayName}</p>
                          <p className="mt-1 truncate text-[11px] text-slate-400">{item.proposedName || '候補名なし'}</p>
                          {item.errorMessage ? (
                            <p className="mt-2 cursor-text select-text whitespace-pre-wrap text-[11px] text-rose-300">
                              {item.errorMessage}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden rounded-[20px] border border-white/10 bg-white/[0.035] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-white">{currentDocument?.displayName ?? 'ドキュメントを選択してください'}</div>
                <div className="mt-1 truncate text-[11px] text-slate-500" title={currentDocument?.currentPath ?? ''}>
                  {currentDocument ? compactPath(currentDocument.currentPath) : '未選択'}
                </div>
              </div>
              {currentDocument ? (
                <div className="flex gap-2">
                  <GhostButton label="開く" onClick={() => void api.documents.open(currentDocument.key)} />
                  <GhostButton label="場所" onClick={() => void api.documents.reveal(currentDocument.key)} />
                </div>
              ) : null}
            </div>

            <div className="mt-3 min-h-0 flex-1 overflow-auto pr-1">
              <div className="grid gap-3">
                <div className="grid gap-2 md:grid-cols-2">
                  <StatusInfoCard status={currentDocument?.status ?? null} />
                  <InfoCard label="confidence" value={currentDocument?.analysis ? currentDocument.analysis.confidence.toFixed(2) : '-'} />
                  <InfoCard label="種別" value={currentDocument?.analysis?.documentType ?? '-'} />
                  <InfoCard label="発行元" value={currentDocument?.analysis?.issuerName ?? '-'} />
                  <InfoCard label="日付" value={currentDocument?.analysis?.date ?? '-'} />
                  <InfoCard label="金額" value={currentDocument?.analysis?.amount ?? '-'} />
                  <InfoCard label="タイトル" value={currentDocument?.analysis?.title ?? '-'} />
                  <InfoCard label="内容" value={currentDocument?.analysis?.description ?? '-'} />
                </div>

                <div className="rounded-[16px] border border-white/10 bg-black/20 p-3">
                  <div className="text-xs text-slate-400">候補ファイル名</div>
                  <input
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-300"
                    disabled={!currentDocument}
                    key={currentDocument?.key ?? 'empty'}
                    defaultValue={currentDocument?.proposedName ?? ''}
                    onBlur={(event) => void handleProposedNameSave(event.currentTarget.value)}
                    placeholder="解析後に候補ファイル名が入ります"
                  />
                  <p className="mt-2 text-[11px] text-slate-500">保存はフォーカスを外したタイミングで反映されます。</p>
                </div>

                <div className="overflow-hidden rounded-[16px] border border-white/10 bg-black/18 p-3">
                  <div className="mb-2 text-xs text-slate-400">JSON</div>
                  <pre className="min-h-[280px] max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-xl bg-black/25 p-3 text-[11px] leading-5 text-cyan-100">
                    {currentDocument?.analysis ? JSON.stringify(currentDocument.analysis, null, 2) : currentDocument?.errorMessage || '解析結果はここに表示されます。'}
                  </pre>
                </div>
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-3 overflow-hidden rounded-[20px] border border-white/10 bg-white/[0.035] p-4">
            <label className="block text-xs text-slate-400">
              モデル
              <select
                className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-300"
                onChange={(event) => setModelDraft(event.currentTarget.value)}
                value={modelDraft}
              >
                {modelOptions.length === 0 ? <option value={modelDraft}>{modelDraft}</option> : null}
                {!modelOptions.includes(modelDraft) && modelOptions.length > 0 ? <option value={modelDraft}>{modelDraft}</option> : null}
                {modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex gap-2">
              <ActionButton disabled={busyAction !== null} label={busyAction === 'loading-models' ? '取得中...' : '一覧'} onClick={() => void handleLoadModels()} tone="secondary" />
              <ActionButton disabled={busyAction !== null} label={busyAction === 'saving-settings' ? '保存中...' : '保存'} onClick={() => void handleSaveSettings()} />
            </div>

            <label className="block text-xs text-slate-400">
              命名テンプレート
              <input
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300"
                onChange={(event) => setTemplateDraft(event.currentTarget.value)}
                placeholder={DEFAULT_TEMPLATE}
                value={templateDraft}
              />
            </label>

            <div className="overflow-x-auto pb-1">
              <div className="flex min-w-max gap-1.5">
                {templateTokens.map((token) => (
                  <span key={token} className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[10px] text-slate-300">
                    {token}
                  </span>
                ))}
              </div>
            </div>

            <div className="grid gap-2 text-[11px] text-slate-400">
              <CompactInfo label="API Key" value={diagnostics.apiKeyConfigured ? '検出済み' : '未設定'} />
              <CompactInfo label=".env" value={diagnostics.envPath ?? '未検出'} />
              <CompactInfo label="設定" value={diagnostics.settingsPath || '-'} />
            </div>
          </div>
        </section>

        <footer className="grid gap-2 rounded-[16px] border border-white/10 bg-black/20 px-4 py-2 text-xs text-slate-300 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            {error ? <p className="cursor-text select-text whitespace-pre-wrap text-rose-300">{error}</p> : null}
            {!error && notice ? <p className="cursor-text select-text whitespace-pre-wrap text-emerald-300">{notice}</p> : null}
            {!error && !notice ? <p className="cursor-text select-text whitespace-pre-wrap text-slate-400">チェック済みがあればそれを優先、なければ選択中の1件を処理します。</p> : null}
          </div>
          <div className="text-[11px] text-slate-500">{diagnostics.logPath || '-'}</div>
        </footer>
      </div>
    </main>
  );
}

function ActionButton(props: {
  label: string;
  onClick: () => void;
  tone?: 'primary' | 'secondary' | 'success' | 'muted';
  disabled?: boolean;
  compact?: boolean;
}) {
  const tone =
    props.tone === 'secondary'
      ? 'bg-white/10 text-white hover:bg-white/16'
      : props.tone === 'success'
        ? 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'
        : props.tone === 'muted'
          ? 'bg-slate-600 text-white hover:bg-slate-500'
          : 'bg-cyan-300 text-slate-950 hover:bg-cyan-200';

  return (
    <button
      className={`rounded-xl font-medium transition disabled:cursor-not-allowed disabled:bg-white/8 disabled:text-slate-500 ${
        props.compact ? 'min-w-[56px] px-2 py-1 text-[11px]' : 'min-w-[92px] px-3 py-2 text-sm'
      } ${tone}`}
      disabled={props.disabled}
      onClick={props.onClick}
      type="button"
    >
      {props.label}
    </button>
  );
}

function GhostButton(props: { label: string; onClick: () => void }) {
  return (
    <button
      className="rounded-lg border border-white/12 bg-white/6 px-3 py-1.5 text-[11px] text-slate-200 transition hover:border-white/25 hover:bg-white/10"
      onClick={props.onClick}
      type="button"
    >
      {props.label}
    </button>
  );
}

function StatusPill({ status }: { status: DocumentItem['status'] }) {
  const classes: Record<DocumentItem['status'], string> = {
    pending: 'bg-slate-500/20 text-slate-200',
    analyzing: 'bg-cyan-300/20 text-cyan-100',
    ready: 'bg-emerald-400/20 text-emerald-100',
    needs_review: 'bg-amber-300/20 text-amber-100',
    skipped: 'bg-slate-400/20 text-slate-200',
    renamed: 'bg-emerald-500/25 text-emerald-100',
    error: 'bg-rose-400/20 text-rose-100',
  };

  return <span className={`rounded-full px-3 py-1 text-[11px] font-semibold tracking-[0.22em] uppercase ${classes[status]}`}>{STATUS_LABELS[status]}</span>;
}

function InfoCard(props: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] border border-white/8 bg-black/18 p-3">
      <p className="text-[10px] text-slate-500">{props.label}</p>
      <p className="mt-1 text-sm leading-5 text-white">{props.value}</p>
    </div>
  );
}

function StatusInfoCard(props: { status: DocumentItem['status'] | null }) {
  const status = props.status;
  const tone =
    status === 'ready'
      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
      : status === 'analyzing'
        ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100'
        : status === 'needs_review'
          ? 'border-amber-300/30 bg-amber-300/10 text-amber-100'
          : status === 'error'
            ? 'border-rose-400/30 bg-rose-400/10 text-rose-100'
            : status === 'renamed'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
              : status === 'skipped'
                ? 'border-slate-400/20 bg-slate-400/10 text-slate-200'
                : 'border-white/10 bg-white/[0.03] text-slate-200';

  return (
    <div className={`rounded-[14px] border p-3 ${tone}`}>
      <p className="text-[10px] text-inherit/70">状態</p>
      <p className="mt-1 text-sm font-medium leading-5">{status ? STATUS_LABELS[status] : '-'}</p>
    </div>
  );
}

function CompactBadge(props: { label: string; value: string; tone?: 'good' | 'warn' }) {
  return (
    <div className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1">
      <span className="mr-1 text-[10px] text-slate-500">{props.label}</span>
      <span className={`text-[11px] ${props.tone === 'good' ? 'text-emerald-200' : props.tone === 'warn' ? 'text-amber-200' : 'text-white'}`}>{props.value}</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="grid h-full place-items-center rounded-[16px] border border-dashed border-white/12 bg-black/10 p-6 text-center">
      <div>
        <p className="text-xs text-slate-500">ファイルを追加してください</p>
        <p className="mt-2 text-sm text-slate-300">PDF または画像をここにドロップできます。</p>
      </div>
    </div>
  );
}

function CompactInfo(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
      <div className="text-[10px] text-slate-500">{props.label}</div>
      <div className="mt-0.5 break-all text-[11px] text-slate-300">{props.value}</div>
    </div>
  );
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function extensionOf(filePath: string): string {
  const match = /\.[^.]+$/.exec(filePath);
  return match?.[0] ?? '';
}

function compactPath(filePath: string, maxLength = 64): string {
  if (filePath.length <= maxLength) {
    return filePath;
  }

  const startLength = Math.floor((maxLength - 3) * 0.55);
  const endLength = maxLength - 3 - startLength;
  return `${filePath.slice(0, startLength)}...${filePath.slice(-endLength)}`;
}
