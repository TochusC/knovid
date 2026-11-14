import { modelProviderLabels, type CreateProjectInput, type ExportResult, type HealthStatus, type ModelProvider, type Project, type ProjectSummary, type Scene, type SceneParameterSchema, type SceneUpdate, type StylePreset, type VisitorAccess, type WorkflowTrace } from "./types.ts";

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
export const API_BASE_URL = (configuredBaseUrl || "/api").replace(/\/$/, "");

function knownModel(id: unknown): id is ModelProvider {
  return typeof id === "string" && Object.hasOwn(modelProviderLabels, id);
}

export const apiCapabilities = {
  creationOptions: false,
  sceneTitle: false,
  visualDescription: false,
  instruction: false,
  reorderScenes: false,
  autoRenderOnSave: true,
  manualSceneRender: false,
  manualProjectRender: false,
  pdfMusic: true,
} as const;

interface AcceptedOperation { projectId: string; revisionId: string }

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  acceptedOperation?: AcceptedOperation;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface BackendScene {
  id: string;
  title: string;
  visual: string;
  status: "preparing" | "rendering" | "ready";
  narration?: string;
  evidenceIds: string[];
  durationFrames?: number;
  params?: Scene["parameters"];
  paramSchema?: Record<string, SceneParameterSchema>;
  issues?: string[];
  artifacts: Record<string, string>;
}

interface BackendRevision {
  projectId: string;
  revisionId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  updatedAt: string;
  elapsedSeconds?: number;
  timingEstimated?: boolean;
  title?: string;
  sourceRevisionId?: string;
  error?: { code: string; message: string } | null;
  scenes: BackendScene[];
  evidence: Array<{ id: string; title: string; url?: string; page?: number | null; quote: string }>;
  artifacts: Record<string, string>;
}

interface BackendProject {
  id: string;
  createdAt: string;
  input: { type: string; title: string; url?: string };
  options: { language: string; sceneCount: number; width: number; height: number; music: boolean; modelProvider?: ModelProvider };
  latestRevisionId: string;
  revisionIds: string[];
  latest: BackendRevision;
  access?: Project["access"];
}

interface Submission extends AcceptedOperation {
  accepted: boolean;
  queueError?: string;
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  acceptQueueFailure?: boolean;
}

const messages: Record<string, string> = {
  STALE_REVISION: "项目已有新版本，请刷新后核对并重新保存。",
  REVISION_NOT_READY: "当前视频制作完成后，就可以修改镜头。",
  REVISION_NOT_RETRYABLE: "这个版本当前无需重试，请刷新查看制作进度。",
  ARTIFACT_NOT_READY: "文件还在准备中，制作完成后即可下载。",
  BODY_TOO_LARGE: "文件过大，请上传不超过 20 MB 的 PDF。",
  INVALID_PDF: "文件不是有效的 PDF，请检查后重新上传。",
  NO_PDF_TEXT: "这份 PDF 暂时无法提取文字，请上传经过文字识别的版本。",
  SEARCH_UNAVAILABLE: "资料检索服务暂时不可用，请稍后重试。",
  PAPER_UNAVAILABLE: "暂时无法下载这篇论文，可以改为上传 PDF。",
  LLM_HTTP_429: "模型服务正在限流，请稍后重新制作。",
  LLM_SCHEMA: "模型生成的内容格式不符合制作要求，可以点击「重新制作」再试。（LLM_SCHEMA）",
  QUEUE_UNAVAILABLE: "制作服务暂时不可用，恢复后可以重试。",
  INVALID_JSON: "提交内容格式有误，请刷新页面后重试。",
  SERVER_ERROR: "制作服务暂时不可用，请稍后重试。",
  PIPELINE_FAILED: "制作任务暂时未完成，请稍后重试。",
  TASK_TIMEOUT: "制作任务超时，可以重试继续。",
  EVIDENCE_REVIEW_FAILED: "这段讲解未通过资料核对，请检查旁白与引用后重试。",
  GUEST_LIMIT_REACHED: "访客免费生成额度已用完，登录后可以继续创作。",
  GUEST_RETRY_LIMIT: "这份作品的访客重试额度已用完，登录后可以继续。",
  INSUFFICIENT_CREDITS: "可用 Credit 不足，请查看账户额度，或在新建作品时选择默认模型。",
  PREMIUM_LOGIN_REQUIRED: "请登录后使用这个模型。",
  MODEL_PROVIDER_UNAVAILABLE: "所选模型暂不可用，请选择其他模型或稍后重试。",
  MODEL_PROVIDER_REGION_UNAVAILABLE: "所选模型受当前服务器地区限制，请切换模型。",
  CREDIT_SERVICE_UNAVAILABLE: "暂时无法核对 Credit，请稍后重试。",
  STYLE_PRESET_NOT_FOUND: "这个风格已不可用，请重新选择。",
  GUEST_DURATION_LIMIT: "这份作品最长为 30 秒，请缩短讲解后重试。",
  GUEST_NARRATION_LIMIT: "这支短片的单段讲解较长，请精简旁白后保存。",
  ACCOUNT_SERVICE_UNAVAILABLE: "暂时无法确认账号状态，请稍后重试。",
  UNAUTHENTICATED: "登录状态已过期，请重新登录后继续。",
  NOT_FOUND: "这份作品不存在，或当前身份无法访问。",
  GUEST_BUSY: "另一项请求正在保存，请稍后再试。",
  PROJECT_BUSY: "当前项目的另一项请求正在保存，请稍后再试。",
};

const inputErrorMessages = [
  ["Supported paper link hosts", "目前支持 arXiv、OpenReview 和 ACL Anthology 链接，其他资料请上传 PDF。"],
  ["Paper URLs", "请使用 HTTPS 论文链接，其他资料可以上传 PDF。"],
  ["input.url", "请填写有效的 HTTPS 论文链接。"],
  ["input.topic", "请输入 1 到 300 字的知识主题。"],
  ["input.title", "资料标题请控制在 200 字以内。"],
  ["sceneCount", "请输入 2 到 32 个镜头。"],
  ["options.size", "请选择 360p、720p 或 1080p 清晰度。"],
  ["narration", "旁白不能为空，中文请控制在 320 字以内，英文请控制在 1000 字符以内。"],
  ["scene parameter", "画面参数超出允许范围，请检查后再保存。"],
  ["baseRevisionId", "项目版本信息已变化，请刷新后重新保存。"],
] as const;

function responseError(payload: unknown, status: number): ApiError {
  const response = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const nested = response.error && typeof response.error === "object" ? response.error as Record<string, unknown> : response;
  const code = typeof nested.code === "string" ? nested.code : undefined;
  if (code === "UNAUTHORIZED") {
    return new ApiError("制作服务的连接凭据需要配置，请检查服务端代理设置。", status, "API_AUTH_REQUIRED");
  }
  const fallback = status >= 500 ? "制作服务暂时不可用，请稍后重试。"
    : status === 409 ? "项目状态已变化，请刷新后重试。" : `请求未完成（${status}），请稍后重试。`;
  const rawMessage = typeof nested.message === "string" ? nested.message : fallback;
  if (code === "INVALID_INPUT") {
    const message = inputErrorMessages.find(([fragment]) => rawMessage.includes(fragment))?.[1];
    return new ApiError(message || "提交内容有误，请检查主题、资料或设置后重试。", status, code);
  }
  if (status >= 500) return new ApiError((code && messages[code]) || fallback, status, code);
  return new ApiError((code && messages[code]) || rawMessage, status, code);
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const needsIdentity = path.startsWith("/v1/") && path !== "/v1/access" && path !== "/v1/audio/catalog";
  if (needsIdentity && initializedIdentityEpoch !== identityEpoch) await getAccess(options.signal ?? undefined);
  const { timeoutMs = 20_000, signal, acceptQueueFailure = false, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort("timeout"), timeoutMs);
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const headers = new Headers(fetchOptions.headers);
  headers.set("Accept", "application/json");
  if (fetchOptions.body && !(fetchOptions.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, { credentials: "include", ...fetchOptions, headers, signal: controller.signal });
    if (response.status === 204) return undefined as T;
    const isJson = response.headers.get("content-type")?.includes("json");
    const payload: unknown = isJson ? await response.json() : undefined;
    // Failed dispatch still persists a revision. Preserve its identity for retries.
    const savedSubmission = acceptQueueFailure && response.status === 503 && payload
      && typeof payload === "object" && "accepted" in payload && payload.accepted === false
      && "projectId" in payload && typeof payload.projectId === "string"
      && "revisionId" in payload && typeof payload.revisionId === "string";
    if (!response.ok && !savedSubmission) throw responseError(payload, response.status);
    if (!isJson) throw new ApiError("接口返回了无法识别的内容，请检查后端服务地址。", response.status, "INVALID_RESPONSE");
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError || signal?.aborted) throw error;
    if (error instanceof SyntaxError) throw new ApiError("接口返回了无法识别的内容，请稍后重试。", 0, "INVALID_RESPONSE");
    if (controller.signal.aborted) throw new ApiError("连接超时，请稍后重试。", 0, "TIMEOUT");
    throw new ApiError("暂时无法连接制作服务，请确认后端已启动。", 0, "NETWORK_ERROR");
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

let identityEpoch = 0;
let initializedIdentityEpoch = -1;
let pendingIdentity: {
  epoch: number;
  controller: AbortController;
  promise: Promise<VisitorAccess>;
} | undefined;

async function readAccess(signal?: AbortSignal): Promise<VisitorAccess> {
  const access = await request<VisitorAccess>("/v1/access", { signal, cache: "no-store" });
  const nullableCount = (value: unknown) => value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  const valid = access && ["guest", "member"].includes(access.mode)
    && typeof access.canGenerate === "boolean"
    && Number.isSafeInteger(access.usage?.generations) && access.usage.generations >= 0
    && nullableCount(access.limits?.maxDurationSeconds)
    && nullableCount(access.limits?.maxGenerations)
    && (access.limits?.maxRetriesPerProject === undefined || nullableCount(access.limits.maxRetriesPerProject))
    && nullableCount(access.remainingGenerations);
  if (!valid) throw new ApiError("暂时无法读取可用生成额度，请稍后重试。", 0, "INVALID_ACCESS_RESPONSE");
  const modelProviders = access.mode === "member" && Array.isArray(access.modelProviders)
    ? access.modelProviders.filter((option) =>
      knownModel(option?.id) && option.id !== "standard"
      && (option.creditMultiplier === undefined || (Number.isSafeInteger(option.creditMultiplier) && option.creditMultiplier > 0))
      && Number.isSafeInteger(option.creditsPerScene) && option.creditsPerScene > 0
      && Number.isSafeInteger(option.creditsPerDurationUnit) && option.creditsPerDurationUnit > 0
      && Number.isSafeInteger(option.durationUnitSeconds) && option.durationUnitSeconds > 0
      && Number.isSafeInteger(option.maxSceneSeconds) && option.maxSceneSeconds > 0)
    : [];
  return { ...access, modelProviders };
}

function initializeIdentity(): Promise<VisitorAccess> {
  const epoch = identityEpoch;
  if (pendingIdentity?.epoch === epoch) return pendingIdentity.promise;
  const controller = new AbortController();
  const promise = readAccess(controller.signal).then((access) => {
    if (identityEpoch === epoch) initializedIdentityEpoch = epoch;
    return access;
  }).finally(() => {
    if (pendingIdentity?.epoch === epoch) pendingIdentity = undefined;
  });
  pendingIdentity = { epoch, controller, promise };
  return promise;
}

function waitForAccess(promise: Promise<VisitorAccess>, signal?: AbortSignal): Promise<VisitorAccess> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function getAccess(signal?: AbortSignal): Promise<VisitorAccess> {
  // Initial requests share one cookie-establishing read. Subsequent reads always
  // fetch the server's current quota. A caller abort does not cancel other callers.
  while (true) {
    signal?.throwIfAborted();
    const epoch = identityEpoch;
    const promise = initializedIdentityEpoch === epoch ? readAccess(signal) : initializeIdentity();
    try {
      const access = await waitForAccess(promise, signal);
      signal?.throwIfAborted();
      if (epoch === identityEpoch) return access;
    } catch (error) {
      if (signal?.aborted || epoch === identityEpoch) throw error;
    }
  }
}

const projectPath = (id: string) => `/v1/projects/${encodeURIComponent(id)}`;
const revisionPath = (project: Project) => `${projectPath(project.id)}/revisions/${encodeURIComponent(project.revisionId || "")}`;
const assetUrl = (path?: string) => path ? `${API_BASE_URL}${path}` : undefined;
const dispatchFailures = new Map<string, { revisionId: string; message: string }>();

function normalizeProject(raw: BackendProject, editingSource?: BackendRevision): Project {
  if (!raw?.id || !raw.latest || !Array.isArray(raw.latest.scenes)) throw new ApiError("项目数据格式不正确，请检查后端接口。", 0, "INVALID_RESPONSE");
  const revision = raw.latest;
  const stageStatuses: Record<string, Project["status"]> = { research: "researching", planning: "writing", reusing: "producing", scenes: "producing", assembly: "rendering" };
  let status: Project["status"] = "queued";
  if (revision.status === "succeeded") status = "ready";
  if (revision.status === "running") status = stageStatuses[revision.stage] || "producing";
  if (["failed", "cancelled"].includes(revision.status)) status = "failed";

  // A failed edit can have no plan yet. Source data is for repair only: never
  // expose its media or timing as output from the latest failed revision.
  const sceneData = editingSource ? editingSource.scenes.map((scene): BackendScene => ({
    ...scene, artifacts: {}, durationFrames: undefined, status: "preparing",
  })) : revision.scenes;
  const scenes: Scene[] = sceneData.map((scene) => ({
    id: scene.id, title: scene.title, narration: scene.narration || "", visualDescription: scene.visual || "",
    durationSeconds: (scene.durationFrames || 0) / 25,
    status: scene.status === "ready" ? "ready" : scene.status === "rendering" ? "rendering"
      : revision.status === "failed" ? "failed" : revision.status === "running" ? "generating" : "pending",
    previewUrl: assetUrl(scene.artifacts["frame.png"]), videoUrl: assetUrl(scene.artifacts["preview.mp4"]),
    sourceIds: scene.evidenceIds || [], parameters: scene.params, parameterSchema: scene.paramSchema,
    error: scene.issues?.length ? scene.issues.join("；") : undefined,
  }));
  const stageLabels: Record<string, string> = {
    queued: "等待制作服务", research: "正在查证资料", planning: "正在编写讲解与分镜",
    reusing: "正在准备修改后的镜头", scenes: "正在制作画面与声音", assembly: "正在合成完整视频",
    complete: "视频已完成", failed: "制作需要处理", cancelled: "制作已停止",
  };
  const completed = scenes.filter((scene) => scene.status === "ready").length;
  const sceneCount = Math.max(raw.options.sceneCount, scenes.length);
  const stageUnits: Record<string, number> = { research: 0, planning: 1, reusing: 1, scenes: 2 + completed, assembly: 2 + sceneCount };
  const progress = status === "ready" ? 100 : Math.round(((stageUnits[revision.stage] || 0) / (sceneCount + 3)) * 100);
  const dispatchFailure = dispatchFailures.get(raw.id);
  const pendingDispatch = dispatchFailure?.revisionId === raw.latestRevisionId && revision.status === "queued";
  if (dispatchFailure && !pendingDispatch) dispatchFailures.delete(raw.id);
  const durationSeconds = scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  const writerFormatFailure = revision.error?.code === "LLM_SCHEMA" &&
    revision.error.message === "Writer returned invalid content: Expected a single valid JSON object";
  const error = pendingDispatch ? dispatchFailure.message : revision.status === "cancelled" ? "制作已停止，可以重试继续。"
    : writerFormatFailure ? "编写讲解时，模型未返回可读取的 JSON。可以点击「重新制作」继续。（LLM_SCHEMA）"
    : revision.error ? messages[revision.error.code] || revision.error.message : undefined;

  return {
    id: raw.id, title: revision.title || editingSource?.title || raw.input.title || "未命名作品", status, progress,
    progressIsEstimated: status !== "ready", stageLabel: stageLabels[revision.stage] || "正在准备制作",
    createdAt: raw.createdAt, updatedAt: revision.updatedAt || raw.createdAt,
    productionElapsedSeconds: typeof revision.elapsedSeconds === "number" && Number.isFinite(revision.elapsedSeconds)
      && revision.elapsedSeconds >= 0 ? revision.elapsedSeconds : undefined,
    productionTimingEstimated: revision.timingEstimated === true,
    durationSeconds, sceneCount, thumbnailUrl: scenes.find((scene) => scene.previewUrl)?.previewUrl,
    input: {
      type: raw.input.type === "topic" ? "topic" : "paper", topic: raw.input.type === "topic" ? raw.input.title : undefined,
      paperUrl: raw.input.url, fileName: raw.input.type === "pdf" ? raw.input.title : undefined,
    },
    settings: {
      audience: "", durationSeconds, style: "editorial", aspectRatio: "16:9",
      language: raw.options.language === "en" ? "en" : "zh",
      modelProvider: knownModel(raw.options.modelProvider) ? raw.options.modelProvider : undefined,
    },
    scenes,
    sources: (editingSource?.evidence || revision.evidence).map((source) => ({ id: source.id, title: source.title, url: source.url, page: source.page ?? undefined, excerpt: source.quote })),
    videoUrl: assetUrl(revision.artifacts["video.mp4"]), downloadUrl: assetUrl(revision.artifacts["video.mp4"]),
    projectArchiveUrl: assetUrl(revision.artifacts["project.zip"]), error,
    revision: raw.revisionIds.length, revisionId: raw.latestRevisionId,
    editingSourceRevisionId: editingSource?.revisionId,
    canRetry: raw.access?.canRetry ?? ["queued", "failed", "cancelled"].includes(revision.status),
    canEdit: raw.access?.canEdit ?? revision.status === "succeeded",
    access: raw.access,
  };
}

async function getProject(projectId: string, signal?: AbortSignal): Promise<Project> {
  const raw = await request<BackendProject>(projectPath(projectId), { signal });
  const latest = raw?.latest;
  if (raw?.access?.canEdit && latest && ["failed", "cancelled"].includes(latest.status)
    && latest.scenes?.length === 0 && latest.sourceRevisionId) {
    const source = await request<BackendRevision>(`${projectPath(projectId)}/revisions/${encodeURIComponent(latest.sourceRevisionId)}`, { signal });
    if (source.projectId !== projectId || source.revisionId !== latest.sourceRevisionId
      || source.status !== "succeeded" || !Array.isArray(source.scenes) || !Array.isArray(source.evidence)) {
      throw new ApiError("暂时无法读取可供修改的镜头，请刷新项目后重试。", 0, "INVALID_RESPONSE");
    }
    return normalizeProject(raw, source);
  }
  return normalizeProject(raw);
}

async function submittedProject(submission: Submission): Promise<Project> {
  if (submission.accepted) {
    dispatchFailures.delete(submission.projectId);
  } else {
    dispatchFailures.set(submission.projectId, { revisionId: submission.revisionId, message: "项目已保存，制作服务暂时不可用。恢复服务后可重试启动。" });
  }
  try {
    return await getProject(submission.projectId);
  } catch (cause) {
    const error = new ApiError("请求已保存，暂时无法读取最新状态。请刷新项目，避免重复提交。", cause instanceof ApiError ? cause.status : 0, "ACCEPTED_STATUS_UNAVAILABLE");
    error.acceptedOperation = { projectId: submission.projectId, revisionId: submission.revisionId };
    throw error;
  }
}

export const api = {
  getHealth(signal?: AbortSignal) {
    return request<HealthStatus>("/healthz", { signal, timeoutMs: 5_000 });
  },

  getAccess,

  resetIdentity() {
    identityEpoch++;
    initializedIdentityEpoch = -1;
    const previous = pendingIdentity;
    pendingIdentity = undefined;
    previous?.controller.abort(new DOMException("Identity changed", "AbortError"));
  },

  async listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
    const result = await request<{ projects: Array<{ id: string }> }>("/v1/projects", { signal });
    if (!Array.isArray(result?.projects)) throw new ApiError("项目列表格式不正确，请检查后端接口。", 0, "INVALID_RESPONSE");
    const projects: ProjectSummary[] = [];
    // The backend list supplies metadata only. Bound its detail requests.
    for (let offset = 0; offset < result.projects.length; offset += 6) {
      projects.push(...await Promise.all(result.projects.slice(offset, offset + 6).map((project) => getProject(project.id, signal))));
    }
    return projects;
  },

  getProject,

  async getWorkflowTrace(projectId: string, revisionId: string, signal?: AbortSignal): Promise<WorkflowTrace> {
    const trace = await request<WorkflowTrace>(`${projectPath(projectId)}/revisions/${encodeURIComponent(revisionId)}/trace`, {
      signal, cache: "no-store", timeoutMs: 10_000,
    });
    if (!trace || !["temporal", "unavailable"].includes(trace.source) || !Array.isArray(trace.activities) || !Number.isFinite(Date.parse(trace.observedAt))) {
      throw new ApiError("暂时无法读取制作轨迹。", 0, "INVALID_RESPONSE");
    }
    return trace;
  },

  async listStylePresets(signal?: AbortSignal): Promise<StylePreset[]> {
    const result = await request<{ presets: StylePreset[] }>("/v1/rixin/styles", { signal, cache: "no-store" });
    if (!Array.isArray(result?.presets)) throw new ApiError("暂时无法读取已保存风格。", 0, "INVALID_RESPONSE");
    return result.presets.filter((preset) =>
      typeof preset?.id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(preset.id)
      && typeof preset.style === "string" && Boolean(preset.style.trim()) && typeof preset.summary === "string");
  },

  createStylePreset(input: Pick<StylePreset, "style" | "summary">): Promise<StylePreset> {
    return request<StylePreset>("/v1/rixin/styles", { method: "POST", body: JSON.stringify(input) });
  },

  updateStylePreset(id: string, input: Pick<StylePreset, "style" | "summary">): Promise<StylePreset> {
    return request<StylePreset>(`/v1/rixin/styles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
  },

  async deleteStylePreset(id: string): Promise<void> {
    await request(`/v1/rixin/styles/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async createProject(input: CreateProjectInput): Promise<Project> {
    const modelProvider = input.modelProvider === "standard" ? undefined : input.modelProvider;
    const options = {
      language: input.language ?? "zh", sceneCount: input.sceneCount ?? 3, size: input.size ?? "1080p",
      music: input.music ?? true, modelProvider,
      narration: input.narration === false ? false : undefined, stylePresetId: input.stylePresetId,
    };
    if (input.paperFile) {
      if (input.paperFile.size > 20 * 1024 * 1024) throw new ApiError("请选择不超过 20 MB 的 PDF。", 413, "BODY_TOO_LARGE");
      const query = new URLSearchParams({ title: input.title || input.paperFile.name, language: options.language, sceneCount: String(options.sceneCount), size: options.size, music: String(options.music) });
      if (modelProvider) query.set("modelProvider", modelProvider);
      if (options.narration === false) query.set("narration", "false");
      if (options.stylePresetId) query.set("stylePresetId", options.stylePresetId);
      const result = await request<Submission>(`/v1/projects?${query}`, {
        method: "POST", headers: { "Content-Type": "application/pdf" }, body: input.paperFile, timeoutMs: 60_000, acceptQueueFailure: true,
      });
      return submittedProject(result);
    }
    const metadata = {
      input: input.inputType === "topic" ? { type: "topic", topic: input.topic } : { type: "paper-url", url: input.paperUrl, title: input.title || "论文讲解" }, options,
    };
    return submittedProject(await request<Submission>("/v1/projects", { method: "POST", body: JSON.stringify(metadata), acceptQueueFailure: true }));
  },

  async updateScene(projectId: string, sceneId: string, update: SceneUpdate): Promise<Project> {
    const result = await request<Submission>(`${projectPath(projectId)}/scenes/${encodeURIComponent(sceneId)}`, {
      method: "PATCH", acceptQueueFailure: true,
      body: JSON.stringify({ baseRevisionId: update.baseRevisionId, narration: update.narration, params: update.parameters }),
    });
    return submittedProject(result);
  },

  async renderScene(_projectId: string, _sceneId: string): Promise<Project> {
    throw new ApiError("保存镜头修改后会自动更新视频。", 400, "UNSUPPORTED_OPERATION");
  },

  async renderProject(projectId: string): Promise<Project> {
    const project = await getProject(projectId);
    if (!project.canRetry && project.access?.remainingRetries === 0) {
      throw new ApiError(messages.GUEST_RETRY_LIMIT, 429, "GUEST_RETRY_LIMIT");
    }
    if (!project.canRetry) throw new ApiError("当前版本无需重试，请查看制作进度。", 409, "REVISION_NOT_RETRYABLE");
    return submittedProject(await request<Submission>(`${revisionPath(project)}/retry`, { method: "POST", acceptQueueFailure: true }));
  },

  async reorderScenes(_projectId: string, _sceneIds: string[], _baseRevision?: number): Promise<Project> {
    throw new ApiError("镜头排序功能正在接入。", 400, "UNSUPPORTED_OPERATION");
  },

  async exportProject(projectId: string, format: "mp4" | "project" = "mp4"): Promise<ExportResult> {
    const project = await getProject(projectId);
    const url = format === "mp4" ? project.downloadUrl : project.projectArchiveUrl;
    if (!url) throw new ApiError("制作完成后即可下载，请稍后刷新。", 409, "ARTIFACT_NOT_READY");
    return { status: "ready", url, filename: `${project.title}.${format === "mp4" ? "mp4" : "zip"}` };
  },
};
