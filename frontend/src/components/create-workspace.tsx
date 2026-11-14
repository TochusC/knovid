import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpRight,
  BookOpenText,
  BrainCircuit,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  Info,
  Lightbulb,
  Loader2,
  Minus,
  Palette,
  Paperclip,
  Plus,
  ScanLine,
  Users,
  X,
  Layers3,
  Languages,
  Monitor,
  Volume2,
} from "lucide-react";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  modelProviderLabels,
  type CreateProjectInput,
  type InputType,
  type ModelProvider,
  type StylePreset,
  type VisitorAccess,
} from "@/lib/types";
import { api, apiCapabilities } from "@/lib/api";
import { builtinStyles, isBuiltinStyleId } from "@/lib/builtin-styles";
import { estimateProduction, MAX_CREATION_SCENES, MIN_CREATION_SCENES } from "@/lib/production-estimate";
import { recommendSceneCount } from "@/lib/scene-recommendation";

interface CreateWorkspaceProps {
  onCreate: (input: CreateProjectInput) => Promise<void>;
  suggestion: { topic: string; nonce: number } | null;
  access: VisitorAccess | null;
  onLogin: () => void;
  initialStylePresetId?: string;
}

const draftKey = "knovid.creation-draft.v1";
const modelGroups = [
  { name: "GLM", models: ["standard", "glm-5.3"] },
  { name: "DeepSeek", models: ["deepseek", "deepseek-pro"] },
  { name: "OpenRouter", models: ["openrouter-astra", "openrouter-sol"] },
] as const satisfies ReadonlyArray<{ name: string; models: readonly ModelProvider[] }>;
const audiences = [
  "对这个主题感兴趣的普通人",
  "中小学生",
  "大学生",
  "有专业基础的观众",
];

function readDraft() {
  try {
    const stored = JSON.parse(localStorage.getItem(draftKey) || "null");
    if (stored && typeof stored.topic === "string")
      return stored as { topic: string; paperUrl?: string };
  } catch {
    /* A draft is optional when browser storage is unavailable. */
  }
  return { topic: "", paperUrl: "" };
}

export function CreateWorkspace({
  onCreate,
  suggestion,
  access,
  onLogin,
  initialStylePresetId,
}: CreateWorkspaceProps) {
  const isGuest = access?.mode === "guest";
  const isMember = access?.mode === "member";
  const exhausted = Boolean(access && !access.canGenerate);
  const [draft] = useState(readDraft);
  const [inputType, setInputType] = useState<InputType>("topic");
  const [topic, setTopic] = useState(draft.topic);
  const [paperUrl, setPaperUrl] = useState(draft.paperUrl || "");
  const [file, setFile] = useState<File | null>(null);
  const [audience, setAudience] = useState(audiences[0]);
  const [duration, setDuration] = useState("90");
  const [style, setStyle] = useState("editorial");
  const [stylePresetId, setStylePresetId] = useState<string>(() =>
    initialStylePresetId && isBuiltinStyleId(initialStylePresetId) ? initialStylePresetId : "default",
  );
  const [stylePresets, setStylePresets] = useState<StylePreset[]>([]);
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [manualSceneCount, setManualSceneCount] = useState<string | null>(null);
  const [modelProvider, setModelProvider] = useState<ModelProvider>("standard");
  const [size, setSize] = useState<"360p" | "720p" | "1080p">("1080p");
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [music, setMusic] = useState(true);
  const [narration, setNarration] = useState(true);
  const [showMore, setShowMore] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sceneCountRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const paidProviders = isMember ? access.modelProviders : undefined;
  const selectedPricing = modelProvider === "standard" ? undefined : paidProviders?.find((provider) => provider.id === modelProvider);
  const pricing = selectedPricing?.available === false ? undefined : selectedPricing;
  const modelUnavailable = modelProvider !== "standard" && !pricing;
  const unavailableModelHint = !access ? "正在核对可用模型" : isGuest ? "登录后可用" : "暂不可用";
  const selectedModelHint = selectedPricing?.unavailableReason === "region" ? "当前地区不可用" : unavailableModelHint;
  const selectedStyle = isMember || isBuiltinStyleId(stylePresetId) ? stylePresetId : "default";
  const recommendedScenes = recommendSceneCount({ inputType, topic, hasPaper: Boolean(file || paperUrl.trim()) });
  const sceneCount = manualSceneCount ?? String(recommendedScenes ?? 3);
  const selectedSceneCount = isGuest ? 3 : Number(sceneCount);
  const validSceneCount = isGuest || (/^\d+$/.test(sceneCount)
    && selectedSceneCount >= MIN_CREATION_SCENES && selectedSceneCount <= MAX_CREATION_SCENES);
  const sceneCountHint = `请输入 ${MIN_CREATION_SCENES}–${MAX_CREATION_SCENES} 之间的整数。`;
  const estimate = validSceneCount ? estimateProduction({
    sceneCount: selectedSceneCount,
    narration,
    size,
    isGuest,
    modelProvider,
  }) : undefined;
  const maximumCredits = pricing && validSceneCount && (
    pricing.creditsPerScene * selectedSceneCount
    + pricing.creditsPerDurationUnit * Math.ceil(selectedSceneCount * pricing.maxSceneSeconds / pricing.durationUnitSeconds)
  );

  function stepSceneCount(step: -1 | 1) {
    const current = sceneCount ? Math.round(Number(sceneCount)) : (recommendedScenes ?? 3);
    const next = Math.min(MAX_CREATION_SCENES, Math.max(MIN_CREATION_SCENES, current + step));
    setManualSceneCount(String(next));
    setError("");
  }

  useEffect(() => {
    setStylePresets([]);
    if (!isMember) {
      setStylePresetId((current) => isBuiltinStyleId(current) ? current : "default");
      return;
    }
    const controller = new AbortController();
    void api.listStylePresets(controller.signal).then((presets) => {
      if (!controller.signal.aborted) setStylePresets(presets);
    }).catch(() => {
      // Users can still create with the website's default style.
    });
    return () => controller.abort();
  }, [isMember]);

  useEffect(() => {
    if (initialStylePresetId && isBuiltinStyleId(initialStylePresetId)) {
      setStylePresetId(initialStylePresetId);
    }
  }, [initialStylePresetId]);

  useEffect(() => {
    if (!suggestion) return;
    setInputType("topic");
    setTopic(suggestion.topic);
    setError("");
    textRef.current?.focus();
  }, [suggestion]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({ topic, paperUrl }));
      } catch {
        /* Storage is optional. */
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [topic, paperUrl]);

  function selectFile(candidate?: File) {
    if (!candidate) return;
    if (!candidate.name.toLowerCase().endsWith(".pdf")) {
      setError("请选择 PDF 格式的论文或资料。");
      return;
    }
    if (candidate.size > 20 * 1024 * 1024) {
      setError("这份 PDF 超过 20 MB，请选择更小的文件。");
      return;
    }
    setInputType("paper");
    setFile(candidate);
    setPaperUrl("");
    setError("");
  }

  async function submit() {
    if (pending) return;
    if (!access) {
      setError("制作服务连接后即可开始，请先确认上方的试用额度。");
      return;
    }
    if (exhausted) {
      onLogin();
      return;
    }
    if (modelUnavailable) {
      setError(`${modelProviderLabels[modelProvider]} ${selectedModelHint}，请确认账号状态或切换模型。`);
      return;
    }
    if (!validSceneCount) {
      sceneCountRef.current?.focus();
      return;
    }
    if (inputType === "topic" && !topic.trim()) {
      setError("先写下一个想讲的主题吧。");
      textRef.current?.focus();
      return;
    }
    if (inputType === "paper" && !file) {
      try {
        const url = new URL(paperUrl);
        if (
          url.protocol !== "https:" ||
          ![
            "arxiv.org",
            "export.arxiv.org",
            "openreview.net",
            "aclanthology.org",
          ].includes(url.hostname) ||
          url.username ||
          url.password ||
          url.port
        )
          throw new Error();
      } catch {
        setError(
          "请使用 arXiv、OpenReview 或 ACL 的 HTTPS 论文链接，其他资料可以上传 PDF。",
        );
        return;
      }
    }
    setError("");
    setPending(true);
    try {
      await onCreate({
        inputType,
        topic: inputType === "topic" ? topic.trim() : undefined,
        paperUrl: inputType === "paper" && !file ? paperUrl.trim() : undefined,
        paperFile: inputType === "paper" && file ? file : undefined,
        audience,
        durationSeconds: isGuest
          ? (access.limits.maxDurationSeconds ?? 30)
          : Number(duration),
        style,
        stylePresetId: selectedStyle,
        aspectRatio,
        sceneCount: selectedSceneCount,
        modelProvider,
        size,
        language,
        music,
        narration,
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "创建暂未完成，请稍后重试。",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className={`creation-card ${dragging ? "is-dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        selectFile(event.dataTransfer.files[0]);
      }}
    >
      <div
        className="creation-tabs"
        role="tablist"
        aria-label="选择创作素材"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? "topic"
              : event.key === "End"
                ? "paper"
                : inputType === "topic"
                  ? "paper"
                  : "topic";
          setInputType(next);
          setError("");
          document.getElementById(`${next}-tab`)?.focus();
        }}
      >
        <button
          id="topic-tab"
          role="tab"
          aria-selected={inputType === "topic"}
          tabIndex={inputType === "topic" ? 0 : -1}
          aria-controls="creation-input"
          className={inputType === "topic" ? "active" : ""}
          onClick={() => {
            setInputType("topic");
            setError("");
          }}
        >
          <Lightbulb size={16} /> 一个想法
        </button>
        <button
          id="paper-tab"
          role="tab"
          aria-selected={inputType === "paper"}
          tabIndex={inputType === "paper" ? 0 : -1}
          aria-controls="creation-input"
          className={inputType === "paper" ? "active" : ""}
          onClick={() => {
            setInputType("paper");
            setError("");
          }}
        >
          <BookOpenText size={16} /> 一篇论文
        </button>
        <span className="draft-note">
          <span /> 灵感会自动保存
        </span>
      </div>
      <div
        id="creation-input"
        role="tabpanel"
        aria-labelledby={`${inputType}-tab`}
        className="creation-input"
      >
        {inputType === "paper" && file ? (
          <div className="attached-file">
            <div className="file-icon">
              <FileText size={24} />
            </div>
            <div>
              <strong>{file.name}</strong>
              <span>{(file.size / 1024 / 1024).toFixed(1)} MB · PDF 文档</span>
            </div>
            <Check className="file-check" size={17} />
            <Button
              variant="ghost"
              size="icon"
              aria-label="移除已选文件"
              onClick={() => {
                setFile(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
            >
              <X size={16} />
            </Button>
          </div>
        ) : (
          <textarea
            ref={textRef}
            id="creation-topic"
            aria-label={inputType === "topic" ? "想讲的知识主题" : "论文链接"}
            placeholder={
              inputType === "topic"
                ? "比如，为什么行星越靠近太阳，跑得越快？"
                : "粘贴论文链接，或把 PDF 拖到这里…"
            }
            value={inputType === "topic" ? topic : paperUrl}
            onChange={(event) => {
              if (inputType === "topic") setTopic(event.target.value);
              else setPaperUrl(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            disabled={pending}
            maxLength={inputType === "topic" ? 300 : 500}
          />
        )}
        <div className="input-hint">
          {inputType === "topic"
            ? "写下你想讲的内容，也可以加上观众、故事或希望呈现的方式。"
            : "支持 arXiv、OpenReview、ACL 论文链接，或上传 20 MB 以内的 PDF。"}
        </div>
      </div>
      <div className="creation-options">
        <div className="setting-group">
          {apiCapabilities.creationOptions ? (
            <>
              <Select
                value={audience}
                onValueChange={setAudience}
                disabled={pending}
              >
                <SelectTrigger
                  aria-label="目标观众"
                  className="setting-select audience-select"
                >
                  <Users size={15} />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {audiences.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={duration}
                onValueChange={setDuration}
                disabled={pending}
              >
                <SelectTrigger aria-label="目标时长" className="setting-select">
                  <Clock3 size={15} />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="60">约 1 分钟</SelectItem>
                  <SelectItem value="90">约 1.5 分钟</SelectItem>
                  <SelectItem value="180">约 3 分钟</SelectItem>
                </SelectContent>
              </Select>
              <Select value={style} onValueChange={setStyle} disabled={pending}>
                <SelectTrigger aria-label="视觉风格" className="setting-select">
                  <Palette size={15} />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="editorial">质感科普</SelectItem>
                  <SelectItem value="playful">轻松有趣</SelectItem>
                  <SelectItem value="minimal">简洁清晰</SelectItem>
                </SelectContent>
              </Select>
            </>
          ) : (
            <>
              {isGuest ? (
                <div className="guest-duration-chip">
                  <Clock3 size={14} />
                  访客短片 · 3 段 · {access.limits.maxDurationSeconds} 秒内
                </div>
              ) : (
                <div className="scene-count-control">
                  <label htmlFor="creation-scene-count">
                    <Layers3 size={14} aria-hidden="true" /> 镜头数
                  </label>
                  <div className="scene-count-stepper">
                    <button
                      type="button"
                      aria-label="减少一个镜头"
                      disabled={pending || (validSceneCount && selectedSceneCount <= MIN_CREATION_SCENES)}
                      onClick={() => stepSceneCount(-1)}
                    >
                      <Minus size={15} aria-hidden="true" />
                    </button>
                    <input
                      id="creation-scene-count"
                      ref={sceneCountRef}
                      type="number"
                      inputMode="numeric"
                      min={MIN_CREATION_SCENES}
                      max={MAX_CREATION_SCENES}
                      step={1}
                      required
                      aria-invalid={!validSceneCount}
                      aria-describedby={validSceneCount ? "creation-scene-count-range" : "creation-scene-count-error"}
                      value={sceneCount}
                      disabled={pending}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => {
                        setManualSceneCount(event.target.value);
                        setError("");
                      }}
                    />
                    <button
                      type="button"
                      aria-label="增加一个镜头"
                      disabled={pending || (validSceneCount && selectedSceneCount >= MAX_CREATION_SCENES)}
                      onClick={() => stepSceneCount(1)}
                    >
                      <Plus size={15} aria-hidden="true" />
                    </button>
                  </div>
                  <span id="creation-scene-count-range" className="sr-only">
                    可选 {MIN_CREATION_SCENES}–{MAX_CREATION_SCENES} 个镜头。
                    {inputType === "paper" && recommendedScenes && "论文内容在提交后读取，当前按 8 个镜头估算。"}
                  </span>
                  {manualSceneCount !== null ? (
                    <button className="scene-count-auto" type="button" aria-label="恢复自动推荐" disabled={pending}
                      onClick={() => { setManualSceneCount(null); setError(""); }}>
                      用推荐{recommendedScenes ? ` ${recommendedScenes}` : ""}
                    </button>
                  ) : recommendedScenes !== undefined ? (
                    <span className="scene-count-suggestion" title={inputType === "paper" ? "提交后读取论文内容，当前按 8 个镜头估算" : "按输入内容推荐，可手动调整"}>
                      {inputType === "paper" ? "论文预估" : "自动推荐"}
                    </span>
                  ) : <span className="scene-count-range" aria-hidden="true">{MIN_CREATION_SCENES}–{MAX_CREATION_SCENES}</span>}
                </div>
              )}
              <Select
                value={size}
                onValueChange={(value) => setSize(value as typeof size)}
                disabled={pending}
              >
                <SelectTrigger aria-label="输出画质" className="setting-select">
                  <Monitor size={15} />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1080p">高清 1080p</SelectItem>
                  <SelectItem value="720p">标准 720p</SelectItem>
                  <SelectItem value="360p">快速预览 360p</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={language}
                onValueChange={(value) => setLanguage(value as typeof language)}
                disabled={pending}
              >
                <SelectTrigger aria-label="讲解语言" className="setting-select">
                  <Languages size={15} />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="zh">中文讲解</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </>
          )}
          <Select
            value={selectedStyle}
            onValueChange={setStylePresetId}
            disabled={pending}
          >
            <SelectTrigger aria-label="视频风格" className="setting-select">
              <Palette size={15} />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {builtinStyles.map(({ id, name }) => (
                <SelectItem key={id} value={id}>{id === "default" ? `${name}（默认）` : name}</SelectItem>
              ))}
              {isMember && <SelectItem value="auto">日新择优</SelectItem>}
              {isMember && stylePresets.map(({ id, style }) => (
                <SelectItem key={id} value={id}>{style}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={modelProvider}
            onValueChange={(value) => {
              setModelProvider(value as ModelProvider);
              setError("");
            }}
            disabled={pending}
          >
            <SelectTrigger
              aria-label="制作模型"
              aria-describedby={modelUnavailable ? "creation-model-unavailable" : pricing && validSceneCount ? "creation-model-pricing" : undefined}
              className="setting-select creation-model-trigger"
            >
              <BrainCircuit size={15} />
              <SelectValue>{modelProviderLabels[modelProvider]}</SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align="start" className="creation-model-menu">
              {modelGroups.map(({ name, models }, index) => (
                <SelectGroup key={name}>
                  {index > 0 && <SelectSeparator />}
                  <SelectLabel>{name}</SelectLabel>
                  {models.map((id) => {
                    const isDefault = id === "standard";
                    const optionPricing = paidProviders?.find((provider) => provider.id === id);
                    const available = Boolean(optionPricing && optionPricing.available !== false);
                    const costLabel = optionPricing ? `${optionPricing.creditMultiplier ?? 1}× Credit` : unavailableModelHint;
                    const regionBlocked = optionPricing?.unavailableReason === "region";
                    return (
                      <SelectItem key={id} value={id} disabled={!isDefault && !available} className="creation-model-option">
                        <span>{modelProviderLabels[id]}</span>
                        <span className="creation-model-rate">{isDefault ? "免费 · 默认" : regionBlocked ? `${costLabel} · 地区限制` : costLabel}</span>
                      </SelectItem>
                    );
                  })}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <Popover.Root>
            <Popover.Trigger asChild>
              <button className="setting-select creation-audio-trigger" type="button" disabled={pending}>
                <Volume2 aria-hidden="true" /> 声音 <ChevronDown aria-hidden="true" />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="start" sideOffset={6} collisionPadding={12} className="creation-audio-options" aria-label="视频声音">
                <label>
                  <input type="checkbox" checked={music} disabled={pending} onChange={(event) => setMusic(event.target.checked)} />
                  背景配乐
                </label>
                <label>
                  <input type="checkbox" checked={narration} disabled={pending} onChange={(event) => setNarration(event.target.checked)} />
                  语音旁白
                </label>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          {apiCapabilities.creationOptions && (
            <button
              className={`more-settings ${showMore ? "active" : ""}`}
              aria-expanded={showMore}
              onClick={() => setShowMore(!showMore)}
            >
              更多
              <ChevronDown size={13} />
            </button>
          )}
        </div>
        {!validSceneCount && (
          <p id="creation-scene-count-error" className="creation-scene-count-error" role="status">{sceneCountHint}</p>
        )}
        {estimate && (
          <div className="creation-estimate">
            <dl aria-label="预计时长" aria-live="polite" aria-atomic="true">
              <div>
                <dt>成片<span className="creation-estimate-approx">约</span></dt>
                <dd>{estimate.videoDurationLabel}</dd>
              </div>
              <div>
                <dt>制作<span className="creation-estimate-approx">约</span></dt>
                <dd>{estimate.productionDurationLabel}</dd>
              </div>
            </dl>
            {estimate.note && (
              <details className="creation-estimate-info">
                <summary aria-label="查看估算说明">
                  <Info size={15} aria-hidden="true" />
                </summary>
                <p>{estimate.note}</p>
              </details>
            )}
          </div>
        )}
        {pricing && validSceneCount && (
          <p id="creation-model-pricing" className="creation-model-pricing">
            <strong>{pricing.creditMultiplier ?? 1}× Credit</strong> · 预留 {maximumCredits} Credit。每个镜头 {pricing.creditsPerScene} Credit，成片每 {pricing.durationUnitSeconds} 秒再计 {pricing.creditsPerDurationUnit} Credit，向上取整。失败或取消会释放预留额度。
          </p>
        )}
        {modelUnavailable && (
          <p id="creation-model-unavailable" className="creation-model-pricing" role="status">
            {modelProviderLabels[modelProvider]} {selectedModelHint}。请确认账号状态或切换模型。
          </p>
        )}
        <AnimatePresence>
          {showMore && (
            <motion.div
              className="extended-settings"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
            >
              {apiCapabilities.creationOptions && (
                <>
                  <ScanLine size={16} />
                  <span>画面比例</span>
                  <div className="aspect-options">
                    <button
                      className={aspectRatio === "16:9" ? "selected" : ""}
                      onClick={() => setAspectRatio("16:9")}
                      aria-pressed={aspectRatio === "16:9"}
                    >
                      16:9 横屏
                    </button>
                    <button
                      className={aspectRatio === "9:16" ? "selected" : ""}
                      onClick={() => setAspectRatio("9:16")}
                      aria-pressed={aspectRatio === "9:16"}
                    >
                      9:16 竖屏
                    </button>
                  </div>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="creation-footer">
        <div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,application/pdf"
            hidden
            onChange={(event) => selectFile(event.target.files?.[0])}
          />
          <Button
            variant="ghost"
            size="sm"
            className="upload-button"
            onClick={() => fileRef.current?.click()}
            disabled={pending}
          >
            <Paperclip size={16} />
            上传 PDF
          </Button>
          <span className="shortcut-hint">⌘ / Ctrl + Enter</span>
        </div>
        <Button
          className="create-button"
          onClick={() => (exhausted ? onLogin() : void submit())}
          disabled={pending || !access || !validSceneCount || (modelUnavailable && !exhausted)}
        >
          {pending ? (
            <Loader2 className="animate-spin" size={17} />
          ) : (
            <ArrowUpRight size={18} />
          )}
          {pending
            ? "正在创建…"
            : exhausted
              ? "登录后继续"
              : !access
                ? "等待制作服务"
                : "开始创作"}
        </Button>
      </div>
      <AnimatePresence>
        {error && (
          <motion.p
            className="form-error"
            role="alert"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
      {dragging && (
        <div className="drop-overlay">
          <Paperclip size={30} />
          <strong>松开，添加 PDF 资料</strong>
        </div>
      )}
    </div>
  );
}
