import {
  CheckCircledIcon,
  CrossCircledIcon,
  ExternalLinkIcon,
  FileIcon,
  InfoCircledIcon,
  MixerHorizontalIcon,
  OpenInNewWindowIcon,
  PlusIcon,
  ReloadIcon,
  TrashIcon,
} from '@radix-ui/react-icons';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  IconButton,
  ScrollArea,
  Select,
  Text,
  TextField,
} from '@radix-ui/themes';
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
import {
  DEFAULT_TEMPLATE,
  STATUS_LABELS,
  type AppSettings,
  type Diagnostics,
  type DocumentItem,
} from '@shared/types';

declare global {
  interface Window {
    desktopApi: import('@shared/types').DesktopApi;
  }
}

type BusyAction =
  | 'loading'
  | 'saving-settings'
  | 'loading-models'
  | 'analyzing'
  | 'retrying'
  | 'renaming'
  | 'skipping'
  | null;

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

const TEMPLATE_TOKENS = ['{date}', '{issuer_name}', '{document_type}', '{amount}', '{title}', '{description}'];

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
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
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
        // Manual model input remains usable even if model lookup fails.
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
    setCheckedKeys((previous) =>
      previous.filter((key) => documents.some((item) => item.key === key)),
    );
  }, [documents]);

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
  const selectedCount = checkedKeys.length;
  const modelChoices = useMemo(
    () => [...new Set(modelDraft ? [modelDraft, ...modelOptions] : modelOptions)],
    [modelDraft, modelOptions],
  );

  async function refreshWith(
    promise: Promise<DocumentItem[]>,
    action: BusyAction,
    successMessage: string,
    optimistic?: (items: DocumentItem[]) => DocumentItem[],
  ) {
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
      const addedKeys = nextDocuments
        .filter((item) => !previousKeys.has(item.key))
        .map((item) => item.key);
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
      const addedKeys = nextDocuments
        .filter((item) => !previousKeys.has(item.key))
        .map((item) => item.key);
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
          checkedActionKeys.includes(item.key)
            ? { ...item, status: 'analyzing', errorMessage: '' }
            : item,
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
      (items) =>
        items.map((item) =>
          checkedActionKeys.includes(item.key)
            ? { ...item, status: 'analyzing', errorMessage: '' }
            : item,
        ),
    );
  }

  async function handleRename() {
    if (actionKeys.length === 0) {
      return;
    }
    await refreshWith(
      api.documents.rename({ keys: actionKeys }),
      'renaming',
      'リネームを反映しました。',
    );
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
      setDocuments((previous) =>
        previous.map((item) => (item.key === nextItem.key ? nextItem : item)),
      );
      setNotice('候補ファイル名を更新しました。');
      setError('');
    } catch (nextError) {
      setError(toMessage(nextError));
    }
  }

  function toggleChecked(key: string) {
    setCheckedKeys((previous) =>
      previous.includes(key)
        ? previous.filter((item) => item !== key)
        : [...previous, key],
    );
  }

  function toggleAll() {
    setCheckedKeys(allChecked ? [] : documents.map((item) => item.key));
  }

  return (
    <main
      className="app-shell h-[100dvh] overflow-hidden"
      onDragOver={(event) => {
        event.preventDefault();
        setIsDropActive(true);
      }}
      onDrop={(event) => void handleDrop(event)}
    >
      <div className="mx-auto flex h-full w-full max-w-[1280px] min-w-0 flex-col gap-3 px-3 py-3">
        <Card
          className={`w-full border-0 bg-[color-mix(in_oklab,var(--blue-3)_18%,var(--gray-2))] shadow-[0_10px_30px_rgba(2,12,27,0.28)] transition-all ${isDropActive ? 'ring-2 ring-blue-9' : ''}`}
          size="2"
          variant="surface"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Text className="shrink-0 font-semibold tracking-tight" size="3">PDF Renamer</Text>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <ToolbarButton
                active={busyAction === 'analyzing'}
                disabled={documents.length === 0 || busyAction !== null}
                label="解析"
                onClick={() => void handleAnalyze()}
              />
              <ToolbarButton
                active={busyAction === 'retrying'}
                disabled={actionKeys.length === 0 || busyAction !== null}
                label="再解析"
                onClick={() => void handleRetry()}
                variant="soft"
              />
              <ToolbarButton
                active={busyAction === 'renaming'}
                color="green"
                disabled={actionKeys.length === 0 || busyAction !== null}
                label="リネーム"
                onClick={() => void handleRename()}
                variant="solid"
              />
              <ToolbarButton
                active={busyAction === 'skipping'}
                color="gray"
                disabled={actionKeys.length === 0 || busyAction !== null}
                label="スキップ"
                onClick={() => void handleSkip()}
                variant="soft"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <MetaBadge label="件数" value={String(documents.length)} />
              <MetaBadge label="選択" value={String(selectedCount)} />
              <MetaBadge
                color={diagnostics.apiKeyConfigured ? 'green' : 'amber'}
                label="API"
                value={diagnostics.apiKeyConfigured ? 'OK' : 'NG'}
              />
              <MetaBadge label="モデル" value={settings.openaiModel} />
            </div>
          </div>
        </Card>

        <section className="grid min-h-0 flex-1 grid-rows-1 gap-3 overflow-hidden lg:grid-cols-[280px_minmax(0,1fr)_272px]">
          <Card className="!flex min-h-0 !flex-col overflow-hidden" size="2" variant="surface">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--gray-a5)] pb-3">
              <div className="flex items-center gap-2">
                <Text size="2" weight="medium">
                  ファイル
                </Text>
                <IconButton
                  aria-label="ファイルを追加"
                  color="gray"
                  onClick={() => void handlePick()}
                  size="1"
                  variant="soft"
                >
                  <PlusIcon />
                </IconButton>
                <IconButton
                  aria-label="一覧をクリア"
                  color="gray"
                  onClick={() => void handleClear()}
                  size="1"
                  variant="soft"
                >
                  <TrashIcon />
                </IconButton>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox checked={allChecked} onCheckedChange={toggleAll} />
                <Text color="gray" size="1">
                  すべて
                </Text>
              </div>
            </div>

            <ScrollArea className="mt-3 !h-0 flex-1 [&>[data-radix-scroll-area-viewport]]:overflow-x-hidden" scrollbars="vertical" type="scroll">
              {documents.length === 0 ? (
                <EmptyState />
              ) : (
                <div className="w-full space-y-2 pb-1">
                  {documents.map((item) => (
                    <button
                      key={item.key}
                      className={`w-full min-w-0 overflow-hidden rounded-[16px] border p-3 text-left transition ${
                        currentKey === item.key
                          ? 'border-blue-8 bg-blue-3 shadow-[inset_0_0_0_1px_var(--blue-8)]'
                          : 'border-[var(--gray-a5)] bg-[var(--gray-a2)] hover:border-[var(--gray-a7)] hover:bg-[var(--gray-a3)]'
                      }`}
                      onClick={() => setCurrentKey(item.key)}
                      onDoubleClick={() => void api.documents.open(item.key)}
                      type="button"
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className="pt-0.5"
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <Checkbox
                            checked={checkedKeys.includes(item.key)}
                            onCheckedChange={() => toggleChecked(item.key)}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge status={item.status} />
                            <Text color="gray" size="1">
                              {item.analysis ? `${Math.round(item.analysis.confidence * 100)}%` : '-'}
                            </Text>
                          </div>
                          <Text as="p" className="mt-2 truncate" size="2" weight="medium">
                            {item.displayName}
                          </Text>
                          <Text as="p" className="mt-1 truncate" color="gray" size="1">
                            {item.proposedName || '候補名なし'}
                          </Text>
                          {item.errorMessage ? (
                            <Text as="p" className="mt-2 cursor-text select-text whitespace-pre-wrap" color="red" size="1">
                              {item.errorMessage}
                            </Text>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </Card>

          <Card className="!flex min-h-0 !flex-col overflow-hidden" size="2" variant="surface">
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--gray-a5)] pb-3">
              <div className="min-w-0 flex-1">
                <Text as="p" className="truncate" size="2" weight="medium">
                  {currentDocument?.displayName ?? 'ドキュメントを選択してください'}
                </Text>
                <Text
                  as="p"
                  className="mt-1 truncate"
                  color="gray"
                  size="1"
                  title={currentDocument?.currentPath ?? ''}
                >
                  {currentDocument ? compactPath(currentDocument.currentPath) : '未選択'}
                </Text>
              </div>
              {currentDocument ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    color="gray"
                    onClick={() => void api.documents.open(currentDocument.key)}
                    size="1"
                    variant="soft"
                  >
                    <OpenInNewWindowIcon />
                    開く
                  </Button>
                  <Button
                    color="gray"
                    onClick={() => void api.documents.reveal(currentDocument.key)}
                    size="1"
                    variant="soft"
                  >
                    <ExternalLinkIcon />
                    場所
                  </Button>
                </div>
              ) : null}
            </div>

            <ScrollArea className="mt-3 !h-0 flex-1" scrollbars="vertical" type="scroll">
              <div className="!w-full grid gap-3 pb-px">
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

                <Card size="2" variant="surface">
                  <div className="grid gap-2">
                    <Text color="gray" size="1">
                      候補ファイル名
                    </Text>
                    <TextField.Root
                      defaultValue={currentDocument?.proposedName ?? ''}
                      disabled={!currentDocument}
                      key={currentDocument?.key ?? 'empty'}
                      onBlur={(event) => void handleProposedNameSave(event.currentTarget.value)}
                      placeholder="解析後に候補ファイル名が入ります"
                      size="2"
                      variant="surface"
                    />
                    <Text as="p" color="gray" size="1">
                      保存はフォーカスを外したタイミングで反映されます。
                    </Text>
                  </div>
                </Card>

                <Card size="2" variant="surface">
                  <div className="mb-2 flex items-center gap-2">
                    <FileIcon />
                    <Text color="gray" size="1">
                      JSON
                    </Text>
                  </div>
                  <ScrollArea
                    className="!h-[340px] rounded-[12px] border border-[var(--gray-a5)] bg-[var(--gray-a2)] [scrollbar-gutter:stable_both-edges]"
                    scrollbars="vertical"
                    type="auto"
                  >
                    <pre className="min-h-full cursor-text select-text whitespace-pre-wrap break-all px-2 py-3 font-mono text-[11px] leading-5 text-[var(--gray-12)]">
                      {currentDocument?.analysis
                        ? JSON.stringify(currentDocument.analysis, null, 2)
                        : currentDocument?.errorMessage || '解析結果はここに表示されます。'}
                    </pre>
                  </ScrollArea>
                </Card>
              </div>
            </ScrollArea>
          </Card>

          <Card className="!flex min-h-0 !flex-col overflow-hidden" size="2" variant="surface">
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--gray-a5)] pb-3">
              <MixerHorizontalIcon />
              <Text size="2" weight="medium">
                設定
              </Text>
            </div>
            <ScrollArea className="mt-3 !h-0 flex-1" scrollbars="vertical" type="scroll">
              <div className="!w-full grid gap-3 pb-4">
                <div className="grid gap-2.5">
                  <Text className="leading-none" color="gray" size="1">
                    モデル
                  </Text>
                  <Select.Root onValueChange={setModelDraft} value={modelDraft}>
                    <Select.Trigger className="w-full" radius="large" variant="surface" />
                    <Select.Content position="popper" variant="soft">
                      {modelChoices.map((model) => (
                        <Select.Item key={model} value={model}>
                          {model}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    className="flex-1 justify-center"
                    color="gray"
                    disabled={busyAction !== null}
                    onClick={() => void handleLoadModels()}
                    size="2"
                    variant="soft"
                  >
                    {busyAction === 'loading-models' ? <ReloadIcon className="animate-spin" /> : <ReloadIcon />}
                    一覧
                  </Button>
                  <Button
                    className="flex-1 justify-center"
                    disabled={busyAction !== null}
                    onClick={() => void handleSaveSettings()}
                    size="2"
                    variant="solid"
                  >
                    {busyAction === 'saving-settings' ? <ReloadIcon className="animate-spin" /> : <MixerHorizontalIcon />}
                    保存
                  </Button>
                </div>

                <div className="grid gap-2">
                  <Text as="label" color="gray" size="1">
                    命名テンプレート
                  </Text>
                  <TextField.Root
                    onChange={(event) => setTemplateDraft(event.currentTarget.value)}
                    placeholder={DEFAULT_TEMPLATE}
                    size="2"
                    value={templateDraft}
                    variant="surface"
                  />
                </div>

                <ScrollArea scrollbars="horizontal" type="auto">
                  <div className="flex min-w-max items-center gap-2 pb-1">
                    {TEMPLATE_TOKENS.map((token) => (
                      <Badge key={token} color="gray" radius="full" size="1" variant="soft">
                        {token}
                      </Badge>
                    ))}
                  </div>
                </ScrollArea>

                <div className="grid gap-2">
                  <CompactInfo
                    label="API Key"
                    value={diagnostics.apiKeyConfigured ? '検出済み' : '未設定'}
                  />
                  <CompactInfo label=".env" value={diagnostics.envPath ?? '未検出'} />
                  <CompactInfo label="設定" value={diagnostics.settingsPath || '-'} />
                </div>
              </div>
            </ScrollArea>
          </Card>
        </section>

        <StatusCallout error={error} logPath={diagnostics.logPath || '-'} notice={notice} />
      </div>
    </main>
  );
}

function ToolbarButton(props: {
  label: string;
  onClick: () => void;
  variant?: 'solid' | 'soft';
  color?: 'blue' | 'gray' | 'green';
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Button
      className="min-w-[96px] justify-center"
      color={props.color ?? 'blue'}
      disabled={props.disabled}
      onClick={props.onClick}
      size="2"
      variant={props.variant ?? 'solid'}
    >
      {props.active ? <ReloadIcon className="animate-spin" /> : null}
      {props.label}
    </Button>
  );
}

function MetaBadge(props: { label: string; value: string; color?: 'gray' | 'green' | 'amber' }) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-[var(--gray-a5)] bg-[var(--gray-a2)] px-2.5 py-1">
      <Text color="gray" size="1">
        {props.label}
      </Text>
      <Badge color={props.color ?? 'gray'} radius="full" size="1" variant="soft">
        {props.value}
      </Badge>
    </div>
  );
}

function StatusBadge({ status }: { status: DocumentItem['status'] }) {
  return (
    <Badge color={statusColor(status)} radius="full" size="1" variant="soft">
      {STATUS_LABELS[status]}
    </Badge>
  );
}

function InfoCard(props: { label: string; value: string }) {
  return (
    <Card size="1" variant="surface">
      <div className="grid gap-1">
        <Text color="gray" size="1">
          {props.label}
        </Text>
        <Text as="p" className="leading-5" size="2">
          {props.value}
        </Text>
      </div>
    </Card>
  );
}

function StatusInfoCard(props: { status: DocumentItem['status'] | null }) {
  const status = props.status;
  return (
    <Card
      className={`${status ? statusSurfaceClass(status) : ''}`}
      size="1"
      variant="surface"
    >
      <div className="grid gap-1">
        <Text color="gray" size="1">
          状態
        </Text>
        <Text as="p" size="2" weight="medium">
          {status ? STATUS_LABELS[status] : '-'}
        </Text>
      </div>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card className="grid min-h-[240px] place-items-center border border-dashed" size="2" variant="surface">
      <div className="grid gap-2 text-center">
        <Text color="gray" size="1">
          ファイルを追加してください
        </Text>
        <Text as="p" size="2">
          PDF または画像をここにドロップできます。
        </Text>
      </div>
    </Card>
  );
}

function CompactInfo(props: { label: string; value: string }) {
  return (
    <Card size="1" variant="surface">
      <div className="grid gap-1">
        <Text color="gray" size="1">
          {props.label}
        </Text>
        <Code className="block break-all whitespace-pre-wrap" size="1" variant="ghost">
          {props.value}
        </Code>
      </div>
    </Card>
  );
}

function StatusCallout(props: { error: string; notice: string; logPath: string }) {
  const isError = Boolean(props.error);
  const isNotice = Boolean(props.notice);
  const icon = isError ? <CrossCircledIcon /> : isNotice ? <CheckCircledIcon /> : <InfoCircledIcon />;
  const toneClass = isError
    ? 'border-[color-mix(in_oklab,var(--red-8)_35%,transparent)] bg-[color-mix(in_oklab,var(--red-3)_55%,transparent)] text-[var(--red-11)]'
    : isNotice
      ? 'border-[color-mix(in_oklab,var(--green-8)_32%,transparent)] bg-[color-mix(in_oklab,var(--green-3)_55%,transparent)] text-[var(--green-11)]'
      : 'border-[var(--gray-a5)] bg-[var(--gray-a2)] text-[var(--gray-11)]';
  const message =
    props.error ||
    props.notice ||
    'チェック済みがあればそれを優先、なければ選択中の1件を処理します。';

  return (
    <Card className={`shrink-0 py-1 ${toneClass}`} size="1" variant="surface">
      <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 leading-none">{icon}</span>
          <Text className="cursor-text select-text whitespace-pre-wrap leading-[18px]" size="1">
            {message}
          </Text>
        </div>
        <Code className="leading-[18px]" size="1" variant="ghost">
          {props.logPath}
        </Code>
      </div>
    </Card>
  );
}

function statusColor(status: DocumentItem['status']): 'gray' | 'blue' | 'green' | 'amber' | 'red' {
  switch (status) {
    case 'analyzing':
      return 'blue';
    case 'ready':
    case 'renamed':
      return 'green';
    case 'needs_review':
      return 'amber';
    case 'error':
      return 'red';
    case 'pending':
    case 'skipped':
    default:
      return 'gray';
  }
}

function statusSurfaceClass(status: DocumentItem['status']): string {
  switch (status) {
    case 'ready':
      return 'bg-[color-mix(in_oklab,var(--green-3)_72%,transparent)]';
    case 'analyzing':
      return 'bg-[color-mix(in_oklab,var(--blue-3)_72%,transparent)]';
    case 'needs_review':
      return 'bg-[color-mix(in_oklab,var(--amber-3)_72%,transparent)]';
    case 'error':
      return 'bg-[color-mix(in_oklab,var(--red-3)_72%,transparent)]';
    case 'renamed':
      return 'bg-[color-mix(in_oklab,var(--green-4)_72%,transparent)]';
    case 'skipped':
      return 'bg-[color-mix(in_oklab,var(--gray-3)_72%,transparent)]';
    case 'pending':
    default:
      return '';
  }
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
