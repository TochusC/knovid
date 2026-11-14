export type InputType = "topic" | "paper";

export type ModelProvider = "standard" | "deepseek" | "openrouter";

export const modelProviderLabels: Record<ModelProvider, string> = {
  standard: "GLM",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

export interface ModelProviderPricing {
  id: ModelProvider;
  creditsPerScene: number;
  creditsPerDurationUnit: number;
  durationUnitSeconds: number;
  maxSceneSeconds: number;
}

export interface StylePreset {
  id: string;
  style: string;
  summary: string;
}

export type ProjectStatus =
  | "draft"
  | "queued"
  | "researching"
  | "writing"
  | "producing"
  | "rendering"
  | "review"
  | "ready"
  | "failed";

export type SceneStatus = "pending" | "generating" | "rendering" | "ready" | "failed";

export interface ProjectSettings {
  audience: string;
  durationSeconds: number;
  style: string;
  aspectRatio: "16:9" | "9:16";
  voice?: string;
  language?: "zh" | "en";
  modelProvider?: ModelProvider;
}

export interface ProjectInput {
  type: InputType;
  topic?: string;
  paperUrl?: string;
  fileName?: string;
}

export interface Source {
  id: string;
  title: string;
  url?: string;
  page?: number;
  excerpt?: string;
}

export interface SceneParameterSchema {
  type: "number" | "boolean";
  label: string;
  default: number | boolean;
  min?: number;
  max?: number;
}

export interface Scene {
  id: string;
  title: string;
  narration: string;
  visualDescription: string;
  durationSeconds: number;
  status: SceneStatus;
  previewUrl?: string;
  videoUrl?: string;
  sourceIds: string[];
  parameters?: Record<string, string | number | boolean>;
  parameterSchema?: Record<string, SceneParameterSchema>;
  error?: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  status: ProjectStatus;
  /** Overall completion, from 0 to 100. */
  progress: number;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  productionElapsedSeconds?: number;
  productionTimingEstimated?: boolean;
  thumbnailUrl?: string;
  sceneCount?: number;
  stageLabel?: string;
  progressIsEstimated?: boolean;
}

export interface Project extends ProjectSummary {
  input: ProjectInput;
  settings: ProjectSettings;
  scenes: Scene[];
  sources: Source[];
  videoUrl?: string;
  downloadUrl?: string;
  projectArchiveUrl?: string;
  error?: string;
  revision?: number;
  revisionId?: string;
  /** Source text/parameters shown to repair a failed revision with no scene plan. */
  editingSourceRevisionId?: string;
  canRetry?: boolean;
  canEdit?: boolean;
  access?: {
    canEdit: boolean;
    canRetry: boolean;
    remainingGenerations: number | null;
    remainingRetries: number | null;
    maxDurationSeconds: number | null;
    maxNarrationCharacters?: number | null;
  };
}

export interface CreateProjectInput extends ProjectSettings {
  inputType: InputType;
  topic?: string;
  paperUrl?: string;
  paperFile?: File;
  title?: string;
  sceneCount?: number;
  size?: "360p" | "720p" | "1080p";
  language?: "zh" | "en";
  music?: boolean;
  narration?: boolean;
  stylePresetId?: string;
}

export interface SceneUpdate {
  title?: string;
  narration?: string;
  visualDescription?: string;
  parameters?: Record<string, string | number | boolean>;
  instruction?: string;
  baseRevision?: number;
  baseRevisionId?: string;
}

export interface ExportResult {
  status: "ready" | "queued" | "rendering";
  url?: string;
  filename?: string;
}

export interface HealthStatus {
  status: string;
  version?: string;
}

export interface VisitorAccess {
  mode: "guest" | "member";
  limits: {
    maxDurationSeconds: number | null;
    maxGenerations: number | null;
    maxRetriesPerProject?: number | null;
  };
  usage: { generations: number };
  remainingGenerations: number | null;
  canGenerate: boolean;
  modelProviders?: ModelProviderPricing[];
}

export const projectStatusLabels: Record<ProjectStatus, string> = {
  draft: "草稿",
  queued: "等待制作",
  researching: "整理资料",
  writing: "编写讲解",
  producing: "制作画面",
  rendering: "合成视频",
  review: "待你审阅",
  ready: "已完成",
  failed: "需要处理",
};

export const sceneStatusLabels: Record<SceneStatus, string> = {
  pending: "等待制作",
  generating: "制作中",
  rendering: "合成中",
  ready: "已就绪",
  failed: "需要重试",
};
