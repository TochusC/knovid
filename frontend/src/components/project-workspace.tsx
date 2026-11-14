import { useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Download,
  ExternalLink,
  FileText,
  Film,
  LoaderCircle,
  LogIn,
  MessageSquare,
  Play,
  RefreshCw,
  Save,
  Send,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProductionTime } from "./production-time";
import { WorkflowTrace } from "./workflow-trace";
import { api, apiCapabilities, ApiError } from "@/lib/api";
import {
  modelProviderLabels,
  projectStatusLabels,
  sceneStatusLabels,
  type Project,
  type Scene,
  type SceneUpdate,
  type VisitorAccess,
} from "@/lib/types";
import "./project-workspace.css";

interface ProjectWorkspaceProps {
  project: Project;
  onProjectChange: (project: Project) => void;
  onBack: () => void;
  onNotify: (message: string, tone?: "success" | "error") => void;
  access?: VisitorAccess | null;
  onLogin?: () => void;
  onAccessRefresh?: () => void;
}

interface SceneDraft {
  title: string;
  narration: string;
  visualDescription: string;
  parameters: Record<string, string | number | boolean>;
  baseRevision?: number;
  baseRevisionId?: string;
}

type EditorTab = "narration" | "visual" | "sources";
const editorTabs: { value: EditorTab; label: string }[] = [
  { value: "narration", label: "旁白" },
  { value: "visual", label: "画面" },
  { value: "sources", label: "资料来源" },
];

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)
    .toString()
    .padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
}

function safeLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value, window.location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function sceneDraft(scene: Scene, project: Project): SceneDraft {
  return {
    title: scene.title,
    narration: scene.narration,
    visualDescription: scene.visualDescription,
    parameters: { ...scene.parameters },
    baseRevision: project.revision,
    baseRevisionId: project.revisionId,
  };
}

const stageOrder = [
  "queued",
  "researching",
  "writing",
  "producing",
  "rendering",
  "review",
  "ready",
];
const stages = [
  { label: "梳理内容", position: 1 },
  { label: "编写讲解", position: 2 },
  { label: "制作画面", position: 3 },
  { label: "合成与审阅", position: 4 },
];

export function ProjectWorkspace({
  project,
  onProjectChange,
  onBack,
  onNotify,
  access = null,
  onLogin,
  onAccessRefresh,
}: ProjectWorkspaceProps) {
  const [selectedId, setSelectedId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, SceneDraft>>({});
  const [tab, setTab] = useState<EditorTab>("narration");
  const tabButtons = useRef<
    Partial<Record<EditorTab, HTMLButtonElement | null>>
  >({});
  const [previewChoice, setPreviewChoice] = useState<{
    revisionId?: string;
    mode: "project" | "scene";
  }>();
  const player = useRef<HTMLVideoElement>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [errorRequiresLogin, setErrorRequiresLogin] = useState(false);
  const [downloads, setDownloads] = useState<{
    revisionId?: string;
    mp4?: string;
    project?: string;
  }>({});

  const firstPlayableScene = project.scenes.find((scene) => scene.videoUrl);
  const playableSceneCount = project.scenes.filter((scene) => scene.videoUrl).length;
  const selected =
    project.scenes.find((scene) => scene.id === selectedId) ??
    (project.videoUrl ? undefined : firstPlayableScene) ??
    project.scenes[0];
  const draft = selected
    ? (drafts[selected.id] ?? sceneDraft(selected, project))
    : undefined;
  const narrationChanged = Boolean(
    selected && draft && draft.narration !== selected.narration,
  );
  const titleChanged = Boolean(
    apiCapabilities.sceneTitle && selected && draft && draft.title !== selected.title,
  );
  const visualDescriptionChanged = Boolean(
    apiCapabilities.visualDescription && selected && draft &&
    draft.visualDescription !== selected.visualDescription,
  );
  const changedParameters = Object.fromEntries(
    Object.entries(draft?.parameters ?? {}).filter(
      ([name, value]) => !Object.is(value, selected?.parameters?.[name]),
    ),
  );
  const dirty = narrationChanged || titleChanged || visualDescriptionChanged ||
    Object.keys(changedParameters).length > 0;
  const narrationLimit = Math.min(
    project.settings.language === "en" ? 1000 : 320,
    project.access?.maxNarrationCharacters ?? Infinity,
  );
  const narrationError = draft && narrationChanged
    ? !draft.narration.trim()
      ? "请填写这一段的旁白。"
      : draft.narration.length > narrationLimit
        ? `这一段最多 ${narrationLimit} 个字符，请精简后再保存。`
        : ""
    : "";
  const outdated =
    dirty &&
    Boolean(project.revisionId && draft?.baseRevisionId !== project.revisionId);
  const selectedIndex = selected
    ? project.scenes.findIndex((scene) => scene.id === selected.id)
    : -1;
  const progress = Math.max(0, Math.min(100, project.progress));
  const isProducing = [
    "queued",
    "researching",
    "writing",
    "producing",
    "rendering",
  ].includes(project.status);
  const canEdit = project.canEdit ?? project.status === "ready";
  const accessReady = access !== null;
  const isGuest = access?.mode === "guest";
  const guestQuotaExhausted = Boolean(
    isGuest &&
    (!access.canGenerate || project.access?.remainingGenerations === 0),
  );
  const guestRetryExhausted = Boolean(
    isGuest &&
    project.status === "failed" &&
    project.access?.remainingRetries === 0 &&
    !project.canRetry,
  );
  const canSaveGeneration = Boolean(
    access?.canGenerate && !guestQuotaExhausted,
  );
  const currentStage = stageOrder.indexOf(project.status);
  const previewMode = previewChoice?.revisionId === project.revisionId
    ? previewChoice?.mode
    : undefined;
  const preview = previewMode ??
    (!project.videoUrl && firstPlayableScene ? "scene" : "project");
  const previewScene = !previewMode && !selected?.videoUrl
    ? firstPlayableScene
    : selected;
  const videoUrl = preview === "scene" ? previewScene?.videoUrl : project.videoUrl;
  const previewImage = preview === "scene" ? previewScene?.previewUrl : undefined;
  const selectedSources = project.sources.filter((source) =>
    selected?.sourceIds.includes(source.id),
  );
  const footageCredits = selected?.mediaCredits ?? [];
  const sourceCount = selectedSources.length + footageCredits.length;
  const invalidParameters = Boolean(
    draft &&
    Object.entries(draft.parameters).some(([name, value]) => {
      if (typeof value !== "number") return false;
      const schema = selected?.parameterSchema?.[name];
      return (
        !Number.isFinite(value) ||
        (schema?.min !== undefined && value < schema.min) ||
        (schema?.max !== undefined && value > schema.max)
      );
    }),
  );
  const currentDownloads =
    downloads.revisionId === project.revisionId ? downloads : {};
  const mp4Download = safeLink(currentDownloads.mp4 ?? project.downloadUrl);
  const archiveDownload = safeLink(
    currentDownloads.project ?? project.projectArchiveUrl,
  );

  function choosePreview(mode: "project" | "scene") {
    setPreviewChoice({revisionId: project.revisionId, mode});
  }

  function selectScene(scene: Scene, showPreview = !project.videoUrl) {
    setSelectedId(scene.id);
    setInstruction("");
    if (showPreview) choosePreview("scene");
  }

  function playScene(scene: Scene) {
    flushSync(() => selectScene(scene, true));
    player.current?.scrollIntoView({block: "nearest"});
    void player.current?.play().catch(() => {});
  }

  function editScene(update: Partial<SceneDraft>) {
    if (!selected || !canEdit) return;
    setDrafts((current) => ({
      ...current,
      [selected.id]: {
        ...(current[selected.id] ?? sceneDraft(selected, project)),
        ...update,
      },
    }));
  }

  function navigateTab(
    event: KeyboardEvent<HTMLButtonElement>,
    value: EditorTab,
  ) {
    const currentIndex = editorTabs.findIndex((item) => item.value === value);
    const destinations: Record<string, number> = {
      ArrowRight: (currentIndex + 1) % editorTabs.length,
      ArrowLeft: (currentIndex + editorTabs.length - 1) % editorTabs.length,
      Home: 0,
      End: editorTabs.length - 1,
    };
    const nextIndex = destinations[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = editorTabs[nextIndex].value;
    setTab(nextTab);
    tabButtons.current[nextTab]?.focus();
  }

  function reportError(cause: unknown) {
    const message = cause instanceof ApiError && cause.code === "GUEST_NARRATION_LIMIT"
      ? `这一段最多 ${narrationLimit} 个字符，请精简后保存。`
      : cause instanceof Error ? cause.message : "操作暂时未完成，请稍后重试。";
    setError(message);
    setConflict(cause instanceof ApiError && cause.status === 409);
    const accessError =
      cause instanceof ApiError &&
      (cause.status === 0 ||
        cause.status === 401 ||
        cause.status >= 500 ||
        [
          "GUEST_LIMIT_REACHED",
          "GUEST_RETRY_LIMIT",
          "GUEST_DURATION_LIMIT",
          "ACCOUNT_SERVICE_UNAVAILABLE",
        ].includes(cause.code || ""));
    setErrorRequiresLogin(
      Boolean(
        cause instanceof ApiError &&
        ((cause.status === 401 && cause.code !== "API_AUTH_REQUIRED") ||
          (isGuest &&
            [
              "GUEST_LIMIT_REACHED",
              "GUEST_RETRY_LIMIT",
              "GUEST_DURATION_LIMIT",
            ].includes(cause.code || ""))),
      ),
    );
    if (accessError) onAccessRefresh?.();
    onNotify(message, "error");
  }

  async function runAction(name: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(name);
    setError("");
    setConflict(false);
    setErrorRequiresLogin(false);
    try {
      await action();
    } catch (cause) {
      if (cause instanceof ApiError && cause.acceptedOperation) {
        onProjectChange(submittedProject(cause.acceptedOperation.revisionId));
        onAccessRefresh?.();
        onNotify("制作请求已提交，正在更新进度。", "success");
        return;
      }
      reportError(cause);
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          onProjectChange(await api.getProject(project.id));
        } catch {
          // Keep the draft and let the user explicitly retry the read.
        }
      }
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    await runAction("refresh", async () => {
      onProjectChange(await api.getProject(project.id));
      onNotify("项目已更新，你正在编辑的内容已保留。", "success");
    });
  }

  function submittedProject(revisionId: string): Project {
    return {
      ...project,
      revisionId,
      status: "queued",
      progress: 0,
      progressIsEstimated: true,
      productionElapsedSeconds: undefined,
      productionTimingEstimated: undefined,
      canEdit: false,
      canRetry: false,
      stageLabel: "制作请求已提交，正在更新进度",
      scenes: [],
      videoUrl: undefined,
      downloadUrl: undefined,
      projectArchiveUrl: undefined,
      error: undefined,
    };
  }

  async function saveScene(withInstruction = false) {
    if (
      !selected ||
      !draft ||
      (!dirty && !withInstruction) ||
      invalidParameters ||
      narrationError ||
      outdated ||
      !canEdit ||
      !canSaveGeneration
    )
      return;
    if (withInstruction && !instruction.trim()) return;
    const savingId = selected.id;
    const update: SceneUpdate = {
      baseRevision: draft.baseRevision,
      baseRevisionId: draft.baseRevisionId,
    };
    if (narrationChanged) update.narration = draft.narration;
    if (Object.keys(changedParameters).length > 0)
      update.parameters = changedParameters;
    if (titleChanged) update.title = draft.title;
    if (visualDescriptionChanged)
      update.visualDescription = draft.visualDescription;
    if (withInstruction) update.instruction = instruction.trim();
    await runAction(withInstruction ? "instruction" : "save", async () => {
      let result: Project;
      try {
        result = await api.updateScene(project.id, savingId, update);
      } catch (cause) {
        if (!(cause instanceof ApiError) || !cause.acceptedOperation)
          throw cause;
        result = submittedProject(cause.acceptedOperation.revisionId);
      }
      setDrafts((current) => {
        const next = { ...current };
        delete next[savingId];
        return next;
      });
      if (withInstruction) setInstruction("");
      setDownloads({});
      onProjectChange(result);
      onAccessRefresh?.();
      onNotify(
        apiCapabilities.autoRenderOnSave
          ? "修改已提交，正在重新制作这个镜头。"
          : withInstruction
            ? "修改建议已提交。"
            : "镜头内容已保存。",
        "success",
      );
    });
  }

  async function render(sceneOnly: boolean) {
    if (!accessReady || (sceneOnly && (!selected || !canSaveGeneration)))
      return;
    if (!sceneOnly && !project.canRetry && !apiCapabilities.manualProjectRender)
      return;
    await runAction(sceneOnly ? "scene-render" : "render", async () => {
      const result = sceneOnly
        ? await api.renderScene(project.id, selected!.id)
        : await api.renderProject(project.id);
      onProjectChange(result);
      onAccessRefresh?.();
      onNotify(
        sceneOnly ? "这个镜头已加入制作。" : "视频已重新加入制作。",
        "success",
      );
    });
  }

  async function moveScene(direction: -1 | 1) {
    if (
      !selected ||
      !canSaveGeneration ||
      selectedIndex + direction < 0 ||
      selectedIndex + direction >= project.scenes.length
    )
      return;
    const sceneIds = project.scenes.map((scene) => scene.id);
    [sceneIds[selectedIndex], sceneIds[selectedIndex + direction]] = [
      sceneIds[selectedIndex + direction],
      sceneIds[selectedIndex],
    ];
    await runAction("reorder", async () => {
      onProjectChange(
        await api.reorderScenes(project.id, sceneIds, project.revision),
      );
      onNotify("镜头顺序已更新。", "success");
      onAccessRefresh?.();
    });
  }

  async function exportVideo(format: "mp4" | "project") {
    await runAction(`export-${format}`, async () => {
      const result = await api.exportProject(project.id, format);
      if (result.status === "ready") {
        const url = safeLink(result.url);
        if (!url)
          throw new Error(
            "导出已返回，但下载地址暂时不可用，请刷新项目后重试。",
          );
        setDownloads((current) => ({
          ...(current.revisionId === project.revisionId ? current : {}),
          revisionId: project.revisionId,
          [format]: url,
        }));
        onNotify("导出已准备好，点击下载即可保存。", "success");
      } else {
        onNotify("导出已开始，准备好后会显示下载入口。", "success");
        onProjectChange(await api.getProject(project.id));
      }
    });
  }

  return (
    <section className="project-workspace" aria-label="视频创作工作台">
      <div className="workspace-heading">
        <div className="workspace-heading-main">
          <button
            className="workspace-back"
            onClick={onBack}
            disabled={Boolean(busy)}
            aria-label="返回我的作品"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="workspace-eyebrow">作品工作台</div>
            <h1>{project.title || "未命名作品"}</h1>
          </div>
        </div>
        <div className="workspace-header-actions">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={Boolean(busy)}
            aria-label="刷新项目"
          >
            <RefreshCw
              size={14}
              className={busy === "refresh" ? "workspace-spin" : ""}
            />
            <span>刷新</span>
          </Button>
          {archiveDownload ? (
            <Button variant="outline" size="sm" asChild>
              <a
                href={archiveDownload}
                download
                target="_blank"
                rel="noreferrer"
              >
                下载项目包
              </a>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void exportVideo("project")}
              disabled={Boolean(busy) || project.status !== "ready"}
            >
              项目包
            </Button>
          )}
          {mp4Download ? (
            <Button size="sm" asChild>
              <a href={mp4Download} download target="_blank" rel="noreferrer">
                <Download size={14} />
                下载视频
              </a>
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void exportVideo("mp4")}
              disabled={
                Boolean(busy) || project.status !== "ready" || !project.videoUrl
              }
            >
              {busy === "export-mp4" ? (
                <LoaderCircle size={14} className="workspace-spin" />
              ) : (
                <Download size={14} />
              )}
              导出视频
            </Button>
          )}
        </div>
      </div>

      <div className="workspace-meta">
        <span className={`workspace-status status-${project.status}`}>
          {isProducing ? (
            <LoaderCircle size={13} className="workspace-spin" />
          ) : project.status === "ready" ? (
            <CheckCircle2 size={13} />
          ) : (
            <span className="workspace-status-dot" />
          )}
          {projectStatusLabels[project.status]}
        </span>
        <span>{project.sceneCount ?? project.scenes.length} 个镜头</span>
        <span>
          {project.durationSeconds > 0
            ? formatDuration(project.durationSeconds)
            : "时长待生成"}
        </span>
        <ProductionTime key={project.revisionId} project={project} />
        {project.settings.modelProvider && (
          <span>{modelProviderLabels[project.settings.modelProvider]}</span>
        )}
        <span>{project.settings.aspectRatio}</span>
      </div>

      {!accessReady && (
        <div className="workspace-access-notice" role="status">
          <LoaderCircle size={16} className="workspace-spin" />
          <p>正在检查可用额度。</p>
          {onAccessRefresh && (
            <Button size="sm" variant="ghost" onClick={onAccessRefresh}>
              重新检查
            </Button>
          )}
        </div>
      )}
      {(guestQuotaExhausted || guestRetryExhausted) && (
        <div className="workspace-access-notice" role="status">
          <CircleAlert size={16} />
          <p>
            {guestQuotaExhausted
              ? "访客生成机会已用完，登录后继续编辑。"
              : "这条作品的访客重试次数已用完，登录后继续制作。"}
          </p>
        </div>
      )}

      {(error || project.error) && (
        <div className="workspace-error" role="alert">
          <CircleAlert size={17} />
          <div>
            <p>{error || project.error}</p>
            {conflict && (
              <span>
                刷新可查看最新版本。你的编辑草稿会保留，核对后再重新编辑并保存。
              </span>
            )}
          </div>
          {conflict && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh()}
              disabled={Boolean(busy)}
            >
              刷新项目
            </Button>
          )}
          {errorRequiresLogin && onLogin && (
            <Button size="sm" onClick={onLogin}>
              <LogIn size={14} />
              登录后继续
            </Button>
          )}
        </div>
      )}

      {project.editingSourceRevisionId && (
        <div className="workspace-access-notice" role="status">
          <RefreshCw size={16} />
          <p>本次制作未完成。下方载入了上次成功版本的讲解与参数，你可以修改后重新保存。</p>
        </div>
      )}

      {outdated && selected && canEdit && (
        <div className="workspace-version-review" role="status">
          <div>
            <CircleAlert size={16} />
            <p>项目已更新。核对最新内容后，再保存你的修改。</p>
          </div>
          <details>
            <summary>查看这个镜头的最新旁白</summary>
            <p>{selected.narration}</p>
          </details>
          <div className="workspace-version-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(busy)}
              onClick={() => {
                setDrafts((current) => {
                  const next = { ...current };
                  delete next[selected.id];
                  return next;
                });
                setError("");
                setConflict(false);
              }}
            >
              采用最新内容
            </Button>
            <Button
              size="sm"
              disabled={Boolean(busy)}
              onClick={() => {
                editScene({
                  baseRevision: project.revision,
                  baseRevisionId: project.revisionId,
                });
                setError("");
                setConflict(false);
              }}
            >
              已核对，保留我的修改
            </Button>
          </div>
        </div>
      )}

      <div className="workspace-layout">
        <div className="workspace-stage-column">
          <div className="workspace-preview-shell">
            <div className="workspace-preview-header">
              <div className="workspace-preview-tabs" aria-label="预览范围">
                <button
                  aria-pressed={preview === "project"}
                  onClick={() => choosePreview("project")}
                >
                  完整视频
                </button>
                <button
                  aria-pressed={preview === "scene"}
                  disabled={!selected}
                  onClick={() => choosePreview("scene")}
                >
                  当前镜头
                </button>
              </div>
              <span>
                {preview === "scene" && previewScene ? previewScene.title : "视频预览"}
              </span>
            </div>
            <div
              className={`workspace-player ${project.settings.aspectRatio === "9:16" ? "is-portrait" : ""}`}
            >
              {videoUrl ? (
                <video
                  key={videoUrl}
                  ref={player}
                  controls
                  playsInline
                  preload="metadata"
                  src={videoUrl}
                  poster={previewImage}
                  aria-label={preview === "scene" ? "当前镜头视频" : "完整视频"}
                  onPlay={() => {
                    if (preview === "scene" && !previewMode && previewScene)
                      selectScene(previewScene, true);
                  }}
                />
              ) : previewImage ? (
                <div className="workspace-still">
                  <img src={previewImage} alt={previewScene?.title || "镜头预览"} />
                  <span>镜头静帧</span>
                </div>
              ) : (
                <div className="workspace-player-empty">
                  <div className="workspace-film-icon">
                    <Film size={30} strokeWidth={1.3} />
                  </div>
                  <h2>
                    {project.status === "failed"
                      ? "制作需要一点帮助"
                      : isProducing
                        ? "正在把知识变成画面"
                        : "你的画面会出现在这里"}
                  </h2>
                  <p>
                    {project.status === "failed"
                      ? "查看问题后，可以重新尝试制作。"
                      : project.status === "draft"
                        ? "开始制作，生成这份知识的讲解与画面。"
                        : project.stageLabel ||
                          (project.scenes.length
                            ? "审阅镜头内容，准备好后开始合成。"
                            : "分镜与预览就绪后，会自动更新到工作台。")}
                  </p>
                  {project.status === "draft" &&
                    apiCapabilities.manualProjectRender && (
                      <Button
                        variant="secondary"
                        onClick={() => void render(false)}
                        disabled={Boolean(busy) || !canSaveGeneration}
                      >
                        <Play size={15} />
                        开始制作
                      </Button>
                    )}
                </div>
              )}
            </div>
            <div className="workspace-preview-footer">
              <span>
                <Play size={12} fill="currentColor" />
                {preview === "scene" && previewScene
                  ? formatDuration(previewScene.durationSeconds)
                  : formatDuration(project.durationSeconds)}
              </span>
              <span>
                {videoUrl
                  ? "可播放预览"
                  : previewImage
                    ? "镜头完成后即可播放"
                    : "预览准备中"}
              </span>
              {project.canRetry && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void render(false)}
                  disabled={Boolean(busy) || !accessReady}
                >
                  <RefreshCw size={15} />
                  {project.status === "queued" ? "尝试启动" : "重新制作"}
                </Button>
              )}
              {guestRetryExhausted && onLogin && (
                <Button size="sm" variant="secondary" onClick={onLogin}>
                  <LogIn size={15} />
                  登录后继续制作
                </Button>
              )}
            </div>
          </div>

          {isProducing && (
            <div className="workspace-progress-panel" aria-live="polite">
              <div className="workspace-progress-title">
                <span>
                  {project.stageLabel || projectStatusLabels[project.status]}
                </span>
                <span>
                  {project.progressIsEstimated ? "阶段进度 · " : ""}
                  {Math.round(progress)}%
                </span>
              </div>
              <progress
                max={100}
                value={progress}
                aria-label={
                  project.progressIsEstimated
                    ? "制作阶段进度估算"
                    : "视频制作进度"
                }
              />
              <div className="workspace-stages">
                {stages.map((stage) => (
                  <span
                    key={stage.label}
                    className={
                      currentStage >= stage.position ? "is-reached" : ""
                    }
                  >
                    {currentStage > stage.position ? (
                      <Check size={12} />
                    ) : (
                      <span className="workspace-stage-dot" />
                    )}
                    {stage.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {project.revisionId && (
            <WorkflowTrace
              key={`${project.id}:${project.revisionId}`}
              projectId={project.id}
              revisionId={project.revisionId}
              scenes={project.scenes}
              active={isProducing || project.status === "review"}
            />
          )}

          <div className="workspace-scenes-header">
            <div>
              <h2>镜头与讲解</h2>
              {project.scenes.length > 0 && (
                <span>{playableSceneCount} / {project.sceneCount ?? project.scenes.length} 个镜头可播放</span>
              )}
            </div>
            {apiCapabilities.manualProjectRender && (
              <Button
                variant="outline"
                size="sm"
                disabled={
                  Boolean(busy) ||
                  !canSaveGeneration ||
                  isProducing ||
                  !project.scenes.length ||
                  Object.keys(drafts).length > 0
                }
                onClick={() => void render(false)}
              >
                {busy === "render" ? (
                  <LoaderCircle size={14} className="workspace-spin" />
                ) : (
                  <Film size={14} />
                )}
                合成视频
              </Button>
            )}
          </div>
          {project.scenes.length > 0 && (
            <div
              className="workspace-scene-list"
              role="region"
              aria-label="镜头列表"
              tabIndex={project.scenes.length > 2 ? 0 : undefined}
            >
              {project.scenes.map((scene, index) => (
                <div
                  key={scene.id}
                  className={`workspace-scene-card ${selected?.id === scene.id ? "is-selected" : ""}`}
                >
                  <button
                    className="workspace-scene-select"
                    onClick={() => selectScene(scene)}
                    aria-pressed={selected?.id === scene.id}
                    disabled={Boolean(busy)}
                  >
                    <span className="workspace-scene-thumb">
                      {scene.previewUrl ? (
                        <img src={scene.previewUrl} alt="" loading="lazy" />
                      ) : (
                        <span>{String(index + 1).padStart(2, "0")}</span>
                      )}
                      <small>{formatDuration(scene.durationSeconds)}</small>
                    </span>
                    <span className="workspace-scene-info">
                      <strong>
                        {scene.title || `镜头 ${index + 1}`}
                        {drafts[scene.id] && (
                          <span
                            className="workspace-dirty-dot"
                            title="有未保存修改"
                          />
                        )}
                      </strong>
                      <span
                        className={scene.status === "failed" ? "has-error" : ""}
                      >
                        {sceneStatusLabels[scene.status]}
                        {scene.mediaMode === "footage" && " · 真实影像"}
                      </span>
                    </span>
                  </button>
                  {scene.videoUrl && (
                    <button
                      type="button"
                      className="workspace-scene-play"
                      onClick={() => playScene(scene)}
                      aria-label={`播放镜头 ${index + 1}${scene.title ? ` ${scene.title}` : ""}`}
                      title="播放镜头"
                    >
                      <Play size={14} fill="currentColor" aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {!project.scenes.length && (
            <div className="workspace-scenes-empty">
              <FileText size={20} />
              <span>
                {isProducing
                  ? "讲解内容正在准备中，镜头会陆续出现在这里。"
                  : "开始制作后，分镜与讲解会出现在这里。"}
              </span>
            </div>
          )}
          {Object.keys(drafts).length > 0 && (
            <p className="workspace-unsaved-hint">
              {apiCapabilities.autoRenderOnSave
                ? "保存修改后，会自动更新这个镜头和完整视频。"
                : "先保存修改过的镜头，再合成完整视频。"}
            </p>
          )}
        </div>

        <aside className="workspace-editor" aria-label="镜头编辑">
          {selected && draft ? (
            <>
              <div className="workspace-editor-top">
                <span>
                  镜头 {String(selectedIndex + 1).padStart(2, "0")}
                  {selected.mediaMode === "footage" && (
                    <span className="workspace-footage-badge">真实影像</span>
                  )}
                </span>
                {apiCapabilities.reorderScenes && (
                  <div>
                    <button
                      title="上移镜头"
                      aria-label="上移镜头"
                      disabled={
                        Boolean(busy) ||
                        !canSaveGeneration ||
                        selectedIndex === 0 ||
                        isProducing
                      }
                      onClick={() => void moveScene(-1)}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      title="下移镜头"
                      aria-label="下移镜头"
                      disabled={
                        Boolean(busy) ||
                        !canSaveGeneration ||
                        selectedIndex === project.scenes.length - 1 ||
                        isProducing
                      }
                      onClick={() => void moveScene(1)}
                    >
                      <ArrowDown size={15} />
                    </button>
                  </div>
                )}
              </div>
              <div className="workspace-scene-title-label">
                {apiCapabilities.sceneTitle ? (
                  <input
                    aria-label="镜头标题"
                    value={draft.title}
                    onChange={(event) =>
                      editScene({ title: event.target.value })
                    }
                    readOnly={!apiCapabilities.sceneTitle}
                    disabled={Boolean(busy) || !canEdit}
                    maxLength={120}
                    placeholder="为这个镜头起个名字"
                  />
                ) : (
                  <h2 className="workspace-scene-heading">{draft.title}</h2>
                )}
              </div>
              <div
                className="workspace-editor-tabs"
                role="tablist"
                aria-label="编辑内容"
              >
                {editorTabs.map(({ value, label }) => (
                  <button
                    key={value}
                    ref={(button) => {
                      tabButtons.current[value] = button;
                    }}
                    id={`scene-tab-${project.id}-${value}`}
                    role="tab"
                    onClick={() => setTab(value)}
                    onKeyDown={(event) => navigateTab(event, value)}
                    aria-selected={tab === value}
                    aria-controls={`scene-editor-${project.id}`}
                    tabIndex={tab === value ? 0 : -1}
                  >
                    {label}
                    {value === "sources" && sourceCount > 0 && (
                      <span>{sourceCount}</span>
                    )}
                  </button>
                ))}
              </div>
              <div
                className="workspace-editor-body"
                id={`scene-editor-${project.id}`}
                role="tabpanel"
                aria-labelledby={`scene-tab-${project.id}-${tab}`}
                tabIndex={0}
              >
                {tab === "narration" && (
                  <>
                    <label
                      htmlFor="scene-narration"
                      className="workspace-field-label"
                    >
                      这一段，怎么讲
                    </label>
                    <textarea
                      id="scene-narration"
                      value={draft.narration}
                      onChange={(event) =>
                        editScene({ narration: event.target.value })
                      }
                      disabled={Boolean(busy) || !canEdit}
                      placeholder="写下这一段的旁白…"
                      maxLength={narrationLimit}
                      aria-invalid={canEdit && Boolean(narrationError)}
                      aria-describedby={
                        canEdit && narrationError
                          ? "scene-narration-count scene-narration-error"
                          : "scene-narration-count"
                      }
                      rows={9}
                    />
                    <div className="workspace-field-meta">
                      <span id="scene-narration-count">
                        {draft.narration.length} / {narrationLimit} 字符
                      </span>
                      <span>
                        当前时长 {formatDuration(selected.durationSeconds)}
                      </span>
                    </div>
                    {canEdit && narrationError && (
                      <p
                        id="scene-narration-error"
                        className="workspace-inline-error"
                        role="status"
                      >
                        {narrationError}
                      </p>
                    )}
                    <p className="workspace-field-note">
                      {canEdit
                        ? "保存修改后，会自动更新这个镜头的声音、画面节奏和完整视频。"
                        : "视频制作完成后，可以继续调整讲解。"}
                    </p>
                  </>
                )}
                {tab === "visual" && (
                  <>
                    <label
                      htmlFor="scene-visual"
                      className="workspace-field-label"
                    >
                      画面里发生什么
                    </label>
                    {apiCapabilities.visualDescription ? (
                      <textarea
                        id="scene-visual"
                        value={draft.visualDescription}
                        onChange={(event) =>
                          editScene({ visualDescription: event.target.value })
                        }
                        readOnly={!apiCapabilities.visualDescription}
                        disabled={Boolean(busy) || !canEdit}
                        placeholder="描述希望呈现的画面与变化…"
                        rows={6}
                      />
                    ) : (
                      <p className="workspace-visual-description">
                        {draft.visualDescription ||
                          "画面说明会随分镜一起更新。"}
                      </p>
                    )}
                    {Object.keys(draft.parameters).length > 0 && (
                      <div className="workspace-parameters">
                        <h3>
                          <SlidersHorizontal size={14} />
                          画面参数
                        </h3>
                        {Object.entries(draft.parameters).map(
                          ([name, value]) => (
                            <label key={name} className="workspace-parameter">
                              <span>
                                {selected.parameterSchema?.[name]?.label ||
                                  name}
                                {selected.parameterSchema?.[name]?.type ===
                                  "number" && (
                                  <small>
                                    {selected.parameterSchema[name].min} –{" "}
                                    {selected.parameterSchema[name].max}
                                  </small>
                                )}
                              </span>
                              {typeof value === "boolean" ? (
                                <input
                                  type="checkbox"
                                  checked={value}
                                  onChange={(event) =>
                                    editScene({
                                      parameters: {
                                        ...draft.parameters,
                                        [name]: event.target.checked,
                                      },
                                    })
                                  }
                                  disabled={Boolean(busy) || !canEdit}
                                />
                              ) : (
                                <input
                                  type={
                                    typeof value === "number"
                                      ? "number"
                                      : "text"
                                  }
                                  step={
                                    typeof value === "number"
                                      ? "any"
                                      : undefined
                                  }
                                  min={selected.parameterSchema?.[name]?.min}
                                  max={selected.parameterSchema?.[name]?.max}
                                  value={
                                    typeof value === "number" &&
                                    !Number.isFinite(value)
                                      ? ""
                                      : value
                                  }
                                  onChange={(event) =>
                                    editScene({
                                      parameters: {
                                        ...draft.parameters,
                                        [name]:
                                          typeof value === "number"
                                            ? event.target.value === ""
                                              ? Number.NaN
                                              : Number(event.target.value)
                                            : event.target.value,
                                      },
                                    })
                                  }
                                  disabled={Boolean(busy) || !canEdit}
                                />
                              )}
                            </label>
                          ),
                        )}
                        {invalidParameters && (
                          <p className="workspace-inline-error">
                            请在标注范围内填写有效数值。
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
                {tab === "sources" && (
                  <div className="workspace-sources">
                    {selectedSources.length > 0 && (
                      selectedSources.map((source) => (
                        <article key={source.id}>
                          <div>
                            <FileText size={15} />
                            <h3>{source.title}</h3>
                          </div>
                          {source.page !== undefined && (
                            <span>第 {source.page} 页</span>
                          )}
                          {source.excerpt && <p>{source.excerpt}</p>}
                          {safeLink(source.url) && (
                            <a
                              href={safeLink(source.url)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              查看原文
                              <ExternalLink size={12} />
                            </a>
                          )}
                        </article>
                      ))
                    )}
                    {footageCredits.map((credit, index) => (
                      <article key={`${credit.sourceUrl ?? credit.title}-${index}`}>
                        <div>
                          <Film size={15} aria-hidden="true" />
                          <h3>{credit.title}</h3>
                        </div>
                        <span>真实影像素材{credit.author && ` · ${credit.author}`}</span>
                        {credit.sourceUrl && (
                          <a href={credit.sourceUrl} target="_blank" rel="noreferrer">
                            素材出处 <ExternalLink size={12} aria-hidden="true" />
                          </a>
                        )}
                        {credit.license && (credit.licenseUrl ? (
                          <a className="workspace-credit-license" href={credit.licenseUrl} target="_blank" rel="noreferrer">
                            {credit.license} <ExternalLink size={12} aria-hidden="true" />
                          </a>
                        ) : <span>许可 {credit.license}</span>)}
                      </article>
                    ))}
                    {sourceCount === 0 && (
                      <div className="workspace-sources-empty">
                        <FileText size={24} />
                        <p>这个镜头还没有关联资料。</p>
                        <span>资料就绪后，可以在这里核对出处。</span>
                      </div>
                    )}
                  </div>
                )}
                {selected.error && (
                  <p className="workspace-inline-error" role="alert">
                    {selected.error}
                  </p>
                )}
              </div>
              {isGuest && !guestQuotaExhausted && (
                <div className="workspace-usage-note">
                  <p>
                    保存并更新视频会使用 1 次生成机会。
                    {access.remainingGenerations !== null
                      ? `当前还可生成 ${access.remainingGenerations} 次。`
                      : ""}
                  </p>
                  {access.limits.maxDurationSeconds !== null && (
                    <span>
                      访客作品最长 {access.limits.maxDurationSeconds} 秒。
                    </span>
                  )}
                </div>
              )}
              <div className="workspace-save-row">
                <span>
                  {!accessReady
                    ? "正在检查可用额度"
                    : guestQuotaExhausted
                      ? "体验次数已用完"
                      : canEdit && narrationError
                        ? "请先检查旁白"
                        : dirty
                          ? "有未保存的修改"
                          : "已同步"}
                </span>
                {guestQuotaExhausted ? (
                  <Button
                    size="sm"
                    onClick={onLogin}
                    disabled={Boolean(busy) || !onLogin}
                  >
                    <LogIn size={14} />
                    登录继续编辑
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => void saveScene()}
                    disabled={
                      Boolean(busy) ||
                      !dirty ||
                      invalidParameters ||
                      Boolean(narrationError) ||
                      !draft.title.trim() ||
                      outdated ||
                      !canEdit ||
                      !canSaveGeneration
                    }
                  >
                    {busy === "save" ? (
                      <LoaderCircle size={14} className="workspace-spin" />
                    ) : (
                      <Save size={14} />
                    )}
                    {apiCapabilities.autoRenderOnSave
                      ? "保存并更新视频"
                      : "保存修改"}
                  </Button>
                )}
              </div>
              {apiCapabilities.instruction ? (
                <div className="workspace-instruction">
                  <label htmlFor="scene-instruction">
                    <MessageSquare size={15} />
                    说说你想怎么改
                  </label>
                  <textarea
                    id="scene-instruction"
                    placeholder="例如，把这个概念讲得更直白一些…"
                    rows={3}
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    disabled={Boolean(busy) || !canEdit}
                  />
                  <div>
                    {apiCapabilities.manualSceneRender && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void render(true)}
                        disabled={
                          Boolean(busy) ||
                          !canSaveGeneration ||
                          dirty ||
                          isProducing
                        }
                      >
                        {busy === "scene-render" ? (
                          <LoaderCircle size={13} className="workspace-spin" />
                        ) : (
                          <RefreshCw size={13} />
                        )}
                        重做此镜头
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() => void saveScene(true)}
                      disabled={
                        Boolean(busy) ||
                        !canSaveGeneration ||
                        !canEdit ||
                        !instruction.trim() ||
                        invalidParameters ||
                        Boolean(narrationError) ||
                        outdated ||
                        !apiCapabilities.instruction
                      }
                    >
                      {busy === "instruction" ? (
                        <LoaderCircle size={14} className="workspace-spin" />
                      ) : (
                        <Send size={14} />
                      )}
                      提交
                    </Button>
                  </div>
                </div>
              ) : apiCapabilities.manualSceneRender ? (
                <div className="workspace-regenerate-row">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void render(true)}
                    disabled={
                      Boolean(busy) ||
                      !canSaveGeneration ||
                      dirty ||
                      isProducing
                    }
                  >
                    {busy === "scene-render" ? (
                      <LoaderCircle size={14} className="workspace-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    重新制作这个镜头
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="workspace-editor-empty">
              <Sparkles size={27} strokeWidth={1.3} />
              <h2>一起打磨你的讲解</h2>
              <p>镜头准备好后，你可以在这里调整旁白、画面和资料引用。</p>
              <span>
                梳理内容
                <ChevronRight size={13} />
                审阅讲解
                <ChevronRight size={13} />
                制作视频
              </span>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
