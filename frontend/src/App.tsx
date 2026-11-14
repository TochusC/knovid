import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CircleHelp,
  Clapperboard,
  Clock3,
  FileVideo,
  FolderOpen,
  LayoutGrid,
  Loader2,
  Menu,
  Palette,
  Plus,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CreateWorkspace } from "@/components/create-workspace";
import { KnowledgeArtwork } from "@/components/knowledge-artwork";
import { ProjectWorkspace } from "@/components/project-workspace";
import { StyleManagement } from "@/components/style-management";
import { api, ApiError } from "@/lib/api";
import { legacyRoute, readRoute } from "@/lib/app-route";
import { AccountControl } from "@/components/account-control";
import { ThemeControl } from "@/components/theme-control";
import { LandingPage } from "@/components/landing-page";
import { VisitorBanner } from "@/components/visitor-banner";
import {
  projectStatusLabels,
  type CreateProjectInput,
  type Project,
  type ProjectSummary,
  type VisitorAccess,
} from "@/lib/types";
import "./app.css";

type Connection = "checking" | "online" | "offline" | "unauthorized";

function readCurrentRoute() {
  const location = new URL(window.location.href);
  return readRoute(legacyRoute(location) ?? location);
}

function durationLabel(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "时长待定";
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
      }).format(date);
}

const ideas = [
  {
    kind: "orbit" as const,
    category: "探索宇宙",
    title: "行星的速度，谁说了算？",
    subtitle: "把看不见的规律，变成看得懂的运动。",
    prompt:
      "为什么行星越靠近太阳，运行得越快？用轨道动画解释开普勒第二定律，讲给初次接触天文学的人听。",
    sample: {
      asset: "orbit",
      seconds: 12,
      description: "比较行星在相同时间内走过的轨迹和扫过的面积。",
      audio: "中文旁白",
    },
  },
  {
    kind: "probability" as const,
    category: "发现数学",
    title: "随机背后，也有规律",
    subtitle: "从一枚骰子开始，重新认识概率。",
    prompt:
      "用掷骰子的故事解释概率与大数定律，展示次数增多时频率如何逐渐趋于稳定，讲给没有统计学基础的人听。",
    sample: {
      asset: "dice",
      seconds: 20,
      description: "反复掷一枚骰子，观察掷出六点的频率如何接近六分之一。",
      audio: "背景音乐",
      poster: "/examples/dice.webp",
    },
  },
  {
    kind: "neural" as const,
    category: "读懂前沿",
    title: "AI 是怎样学会识别的？",
    subtitle: "顺着一次信息传递，走进神经网络。",
    prompt:
      "用识别手写数字的例子，讲解神经网络怎样从数据中学习。用直观动画解释输入、隐藏层、输出和训练。",
    sample: {
      asset: "neural-network",
      seconds: 20,
      description: "跟着一个手写数字经过网络的各层，看看训练如何改变它的判断。",
      audio: "背景音乐",
      poster: "/examples/neural-network.webp",
    },
  },
];

export default function App() {
  const [route, setRoute] = useState(readCurrentRoute);
  const [connection, setConnection] = useState<Connection>("checking");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [project, setProject] = useState<Project | null>(null);
  const [projectError, setProjectError] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [guide, setGuide] = useState(false);
  const [loginRequest, setLoginRequest] = useState(0);
  const [demo, setDemo] = useState<(typeof ideas)[number] | null>(null);
  const demoTrigger = useRef<HTMLElement | null>(null);
  const [access, setAccess] = useState<VisitorAccess | null>(null);
  const [accessError, setAccessError] = useState("");
  const accessRequest = useRef(0);
  const [suggestion, setSuggestion] = useState<{
    topic: string;
    nonce: number;
  } | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const syncRoute = useCallback(() => {
    setRoute(readCurrentRoute());
    setMobileNav(false);
    if (!window.location.hash) window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const migrateLegacyRoute = () => {
      const target = legacyRoute(new URL(window.location.href));
      if (!target) return false;
      window.history.replaceState(window.history.state, "", target);
      return true;
    };
    const onPopState = () => {
      migrateLegacyRoute();
      syncRoute();
    };
    const onHashChange = () => {
      if (migrateLegacyRoute()) syncRoute();
    };
    onHashChange();
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [syncRoute]);

  useEffect(() => {
    if (route.page === "landing") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    async function load() {
      controller = new AbortController();
      try {
        const result = await api.listProjects(controller.signal);
        if (!alive) return;
        setProjects(result);
        setConnection("online");
      } catch (cause) {
        if (alive) {
          const unauthorized =
            cause instanceof ApiError &&
            cause.status === 401 &&
            cause.code !== "API_AUTH_REQUIRED";
          setConnection(unauthorized ? "unauthorized" : "offline");
          if (unauthorized) setProjects([]);
        }
      } finally {
        if (alive) {
          setLoaded(true);
          timer = setTimeout(() => {
            if (document.hidden) timer = setTimeout(load, 8000);
            else void load();
          }, 8000);
        }
      }
    }
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [refreshKey, route.page === "landing"]);

  const refreshAccess = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++accessRequest.current;
    try {
      const next = await api.getAccess(signal);
      if (signal?.aborted || requestId !== accessRequest.current) return;
      setAccess(next);
      setAccessError("");
    } catch (cause) {
      if (signal?.aborted || requestId !== accessRequest.current) return;
      setAccess(null);
      setAccessError(
        cause instanceof Error ? cause.message : "暂时无法读取试用额度。",
      );
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshAccess(controller.signal);
    const check = () => {
      if (!document.hidden) void refreshAccess(controller.signal);
    };
    const timer = window.setInterval(check, 30_000);
    window.addEventListener("focus", check);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [refreshAccess, refreshKey]);

  useEffect(() => {
    if (!route.projectId) return;
    const projectId = route.projectId;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    setProjectError("");
    async function load() {
      controller = new AbortController();
      try {
        const result = await api.getProject(projectId, controller.signal);
        if (!alive) return;
        setProject((current) =>
          current?.id === result.id &&
          current.revision !== undefined &&
          result.revision !== undefined &&
          current.revision > result.revision
            ? current
            : result,
        );
        setProjectError("");
      } catch (cause) {
        if (alive)
          setProjectError(
            cause instanceof Error ? cause.message : "暂时无法打开这个作品。",
          );
      } finally {
        if (alive) timer = setTimeout(load, document.hidden ? 15000 : 5000);
      }
    }
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [route.projectId, refreshKey]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const notify = useCallback(
    (message: string, tone: "success" | "error" = "success") => {
      clearTimeout(toastTimer.current);
      setToast({ message, tone });
      toastTimer.current = setTimeout(() => setToast(null), 5000);
    },
    [],
  );

  const navigate = useCallback((path: string) => {
    const target = new URL(path, window.location.origin);
    if (target.href !== window.location.href) {
      window.history.pushState(null, "", target);
      syncRoute();
    } else {
      setMobileNav(false);
    }
  }, [syncRoute]);

  function followRoute(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(event.currentTarget.href);
  }

  const newProject = useCallback((topic = "") => {
    navigate("/workspace");
    setSuggestion({ topic, nonce: Date.now() });
    window.setTimeout(
      () => document.getElementById("creation-topic")?.focus(),
      100,
    );
  }, [navigate]);

  function openDemo(idea: (typeof ideas)[number], trigger = document.activeElement) {
    demoTrigger.current = trigger instanceof HTMLElement ? trigger : null;
    setDemo(idea);
  }

  async function createProject(input: CreateProjectInput) {
    let created: Project;
    try {
      const currentAccess = await api.getAccess();
      setAccess(currentAccess);
      if (!currentAccess.canGenerate) {
        throw new ApiError(
          "访客试用次数已用完，登录后继续创作。",
          429,
          "GUEST_LIMIT_REACHED",
        );
      }
      if (input.modelProvider && input.modelProvider !== "standard") {
        if (currentAccess.mode !== "member") {
          throw new ApiError("请登录后使用这个模型。", 401, "PREMIUM_LOGIN_REQUIRED");
        }
        if (!currentAccess.modelProviders?.some(({ id }) => id === input.modelProvider)) {
          throw new ApiError("所选模型暂不可用，请选择其他模型或稍后重试。", 503, "MODEL_PROVIDER_UNAVAILABLE");
        }
      }
      created = await api.createProject(input);
    } catch (cause) {
      void refreshAccess();
      if (cause instanceof ApiError && cause.acceptedOperation) {
        setProject(null);
        setRefreshKey((value) => value + 1);
        navigate(
          `/projects/${encodeURIComponent(cause.acceptedOperation.projectId)}`,
        );
        notify("作品已提交，正在重新获取制作进度。请勿重复创建。");
        return;
      }
      if (
        cause instanceof ApiError &&
        (cause.code === "PREMIUM_LOGIN_REQUIRED" ||
          (cause.status === 401 && cause.code !== "API_AUTH_REQUIRED"))
      )
        setLoginRequest((value) => value + 1);
      throw cause;
    }
    window.dispatchEvent(new Event("knovid:credits-changed"));
    void refreshAccess();
    setProject(created);
    setProjects((previous) => [
      created,
      ...previous.filter((item) => item.id !== created.id),
    ]);
    navigate(`/projects/${encodeURIComponent(created.id)}`);
    notify("作品已创建，制作进度会在这里更新。");
  }

  function updateProject(updated: Project) {
    window.dispatchEvent(new Event("knovid:credits-changed"));
    void refreshAccess();
    setProject(updated);
    setProjects((previous) => [
      updated,
      ...previous.filter((item) => item.id !== updated.id),
    ]);
  }

  const sidebar = (
    <>
      <a className="brand" href="/" onClick={followRoute} aria-label="KnoVid 知视首页">
        <img
          className="brand-icon"
          src="/favicon.svg"
          alt=""
          width="32"
          height="32"
        />
        <span>
          KnoVid<span className="brand-chinese">知视</span>
        </span>
      </a>
      <Button className="new-project" onClick={() => newProject()}>
        <Plus size={18} />
        新建作品<span>⌘ K</span>
      </Button>
      <nav className="main-nav" aria-label="主要导航">
        <a
          href="/workspace"
          onClick={followRoute}
          className={route.page === "home" ? "active" : ""}
          aria-current={route.page === "home" ? "page" : undefined}
        >
          <LayoutGrid size={18} />
          创作工作台
        </a>
        <a
          href="/projects"
          onClick={followRoute}
          className={
            route.page === "projects" || route.page === "project"
              ? "active"
              : ""
          }
          aria-current={route.page === "projects" ? "page" : undefined}
        >
          <FolderOpen size={18} />
          我的作品{projects.length > 0 && <span>{projects.length}</span>}
        </a>
        <a
          href="/styles"
          onClick={followRoute}
          className={route.page === "styles" ? "active" : ""}
          aria-current={route.page === "styles" ? "page" : undefined}
        >
          <Palette size={18} />
          风格管理
        </a>
        <a
          href="/rixin"
          onClick={followRoute}
          className={route.page === "rixin" ? "active" : ""}
          aria-current={route.page === "rixin" ? "page" : undefined}
        >
          <Sparkles size={18} />
          日新
        </a>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-note">
        <span className="note-icon">
          <Sparkles size={18} />
        </span>
        <strong>好奇心，值得被分享。</strong>
        <p>把你知道的，讲给更多人听。</p>
        <button onClick={(event) => openDemo(ideas[0], event.currentTarget)}>
          看看一支样片
          <ArrowUpRight size={14} />
        </button>
      </div>
      <button className="sidebar-help" onClick={() => setGuide(true)}>
        <CircleHelp size={17} />
        创作指南
        <ArrowUpRight size={14} />
      </button>
    </>
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        newProject();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [newProject]);

  return (
    <div
      className={`app-shell ${route.page === "landing" ? "is-landing" : ""}`}
    >
      {route.page === "landing" && (
        <LandingPage
          onEnter={(topic) =>
            topic ? newProject(topic) : navigate("/workspace")
          }
          onDemo={() => openDemo(ideas[0])}
          onLogin={() => setLoginRequest((value) => value + 1)}
          accountLabel={access?.mode === "member" ? "我的账户" : undefined}
        />
      )}
      <aside
        className="sidebar"
        style={route.page === "landing" ? { display: "none" } : undefined}
      >
        {sidebar}
        <AccountControl
          loginRequest={loginRequest}
          onSessionChange={() => {
            api.resetIdentity();
            setProjects([]);
            setProject(null);
            setAccess(null);
            setRefreshKey((value) => value + 1);
          }}
          onNotify={notify}
        />
      </aside>
      <div
        className="main-shell"
        style={route.page === "landing" ? { display: "none" } : undefined}
      >
        <header className="topbar">
          <div className="topbar-left">
            <Button
              variant="ghost"
              size="icon"
              className="mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </Button>
            <span>{access?.mode === "guest" ? "访客空间" : "创作空间"}</span>
            <span className="breadcrumb-separator">/</span>
            <strong>
              {route.page === "rixin"
                ? "日新"
                : route.page === "styles"
                  ? "风格管理"
                  : route.page === "home"
                    ? "工作台"
                    : route.page === "projects"
                      ? "我的作品"
                      : "视频工作台"}
            </strong>
          </div>
          <div className="topbar-right">
            <Button
              variant="ghost"
              size="sm"
              className="mobile-account"
              onClick={() => setLoginRequest((value) => value + 1)}
            >
              账户
            </Button>
            <button
              className={`connection-status ${connection}`}
              onClick={() => setRefreshKey((value) => value + 1)}
              aria-label={
                connection === "online"
                  ? "制作服务已连接，点击刷新"
                  : "重新连接制作服务"
              }
            >
              <span />
              <span className="connection-label">
                {connection === "online"
                  ? "制作服务已连接"
                  : connection === "checking"
                    ? "正在连接"
                    : connection === "unauthorized"
                      ? "登录后开始创作"
                      : "制作服务待连接"}
              </span>
              {connection === "offline" && <RefreshCw size={12} />}
            </button>
            <span className="topbar-divider" />
            <ThemeControl />
            <Button
              variant="ghost"
              size="sm"
              className="help-button"
              aria-label="使用指南"
              onClick={() => setGuide(true)}
            >
              <BookOpen size={15} />
              <span>使用指南</span>
            </Button>
          </div>
        </header>
        <main
          id="main-content"
          className={`main-content ${route.page === "rixin" ? "rixin-main" : route.page === "project" ? "editor-main" : ""}`}
        >
          {route.page === "rixin" ? (
            <iframe
              className="rixin-frame"
              src="/rixin.html?embedded=1"
              title="日新 · 视频风格复盘"
              key={`${access?.mode}:${refreshKey}`}
            />
          ) : route.page !== "styles" && (
            <VisitorBanner
              access={access}
              error={accessError}
              onRetry={() => void refreshAccess()}
              onLogin={() => setLoginRequest((value) => value + 1)}
            />
          )}
          {route.page === "styles" && (
            <StyleManagement
              access={access}
              accessError={accessError}
              onRetryAccess={() => void refreshAccess()}
              onLogin={() => setLoginRequest((value) => value + 1)}
              onNavigate={followRoute}
            />
          )}
          {route.page === "home" && (
            <motion.div
              className="home-page"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              <section className="welcome-section">
                <div>
                  <p className="eyebrow">让知识更好看，让创作更简单</p>
                  <h1>
                    今天，想讲点
                    <span className="heading-accent">
                      什么？
                      <span />
                    </span>
                  </h1>
                  <p className="welcome-description">
                    从一个好问题开始，把你的好奇变成一支精彩的知识视频。
                  </p>
                </div>
                <button
                  className="sample-link"
                  onClick={(event) => openDemo(ideas[0], event.currentTarget)}
                >
                  <span>
                    <Play size={13} fill="currentColor" />
                  </span>
                  先看一支样片
                  <ArrowUpRight size={15} />
                </button>
              </section>
              <CreateWorkspace
                onCreate={createProject}
                suggestion={suggestion}
                access={access}
                initialStylePresetId={route.stylePresetId}
                onLogin={() => setLoginRequest((value) => value + 1)}
              />
              <div className="creation-reassurance">
                <span>
                  <Check size={13} />
                  先看讲解思路，再打磨画面
                </span>
                <span>
                  <Check size={13} />
                  每个片段都可以继续修改
                </span>
              </div>
              <section className="inspiration-section">
                <div className="section-heading">
                  <div>
                    <h2>给灵感一个起点</h2>
                    <p>挑一个感兴趣的方向，试着讲点不一样的。</p>
                  </div>
                  <span className="section-caption">为你的下一支作品</span>
                </div>
                <div className="inspiration-grid">
                  {ideas.map((idea, index) => (
                    <IdeaCard
                      key={idea.kind}
                      idea={idea}
                      index={index}
                      onSelect={() => newProject(idea.prompt)}
                      onPreview={(button) => openDemo(idea, button)}
                    />
                  ))}
                </div>
              </section>
              {projects.length > 0 ? (
                <section className="recent-section">
                  <div className="section-heading">
                    <h2>继续你的创作</h2>
                    <button
                      className="text-link"
                      onClick={() => navigate("/projects")}
                    >
                      查看全部
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  <div className="recent-list">
                    {projects.slice(0, 3).map((item) => (
                      <ProjectRow
                        key={item.id}
                        project={item}
                        onOpen={() =>
                          navigate(`/projects/${encodeURIComponent(item.id)}`)
                        }
                      />
                    ))}
                  </div>
                </section>
              ) : (
                <div className="workspace-footer">
                  <span className="footer-brand">KnoVid</span>
                  <span>让每一份知识，都有动人的表达。</span>
                </div>
              )}
            </motion.div>
          )}
          {route.page === "projects" && (
            <ProjectsPage
              projects={projects}
              loaded={loaded}
              connection={connection}
              onCreate={() => newProject()}
              onLogin={() => setLoginRequest((value) => value + 1)}
              onOpen={(id) => navigate(`/projects/${encodeURIComponent(id)}`)}
              onRetry={() => setRefreshKey((value) => value + 1)}
            />
          )}
          {route.page === "project" &&
            (project && project.id === route.projectId ? (
              <>
                <div className="project-connection-warning">
                  {projectError && (
                    <p role="status">
                      <WifiOff size={14} />
                      {projectError}
                      <button
                        onClick={() => setRefreshKey((value) => value + 1)}
                      >
                        重试
                      </button>
                    </p>
                  )}
                </div>
                <ProjectWorkspace
                  key={project.id}
                  project={project}
                  onProjectChange={updateProject}
                  onBack={() => navigate("/projects")}
                  onNotify={notify}
                  access={access}
                  onLogin={() => setLoginRequest((value) => value + 1)}
                  onAccessRefresh={() => void refreshAccess()}
                />
              </>
            ) : (
              <div className="page-state">
                {projectError ? (
                  <>
                    <WifiOff size={30} />
                    <h2>暂时无法打开作品</h2>
                    <p>{projectError}</p>
                    <Button onClick={() => setRefreshKey((value) => value + 1)}>
                      重新连接
                    </Button>
                  </>
                ) : (
                  <>
                    <Loader2 className="animate-spin" size={26} />
                    <p>正在打开你的作品…</p>
                  </>
                )}
              </div>
            ))}
        </main>
      </div>
      <Dialog open={mobileNav} onOpenChange={setMobileNav}>
        <DialogContent className="mobile-navigation">
          <DialogHeader className="sr-only">
            <DialogTitle>工作台导航</DialogTitle>
            <DialogDescription>打开创作工作台或你的作品。</DialogDescription>
          </DialogHeader>
          {sidebar}
          <Button
            variant="outline"
            className="mobile-account-button"
            onClick={() => {
              setMobileNav(false);
              setLoginRequest((value) => value + 1);
            }}
          >
            账户与额度
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={demo !== null}
        onOpenChange={(open) => {
          if (!open) setDemo(null);
        }}
      >
        <DialogContent
          className="demo-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            demoTrigger.current?.focus();
          }}
        >
          {demo && (
            <>
              <DialogHeader>
                <div className="dialog-eyebrow">{demo.category} · {demo.sample.seconds} 秒</div>
                <DialogTitle>{demo.title}</DialogTitle>
                <DialogDescription>{demo.sample.description}</DialogDescription>
              </DialogHeader>
              <video
                className="demo-video"
                aria-label={demo.title}
                controls
                autoPlay
                playsInline
                poster={"poster" in demo.sample ? demo.sample.poster : undefined}
                src={`/examples/${demo.sample.asset}.mp4`}
              >
                <track
                  kind="captions"
                  src={`/examples/${demo.sample.asset}.vtt`}
                  srcLang="zh"
                  label="中文"
                />
              </video>
              <div className="demo-footer">
                <span>
                  <Clapperboard size={15} />
                  程序化动画 · {demo.sample.audio}
                </span>
                <Button
                  onClick={() => {
                    demoTrigger.current = null;
                    setDemo(null);
                    newProject(demo.prompt);
                  }}
                >
                  从这个主题开始
                  <ArrowUpRight size={16} />
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={guide} onOpenChange={setGuide}>
        <DialogContent className="guide-dialog">
          <DialogHeader>
            <div className="dialog-eyebrow">创作指南</div>
            <DialogTitle>把一份知识，变成一支好视频</DialogTitle>
            <DialogDescription>
              从一个小问题开始，留出一点空间，慢慢打磨。
            </DialogDescription>
          </DialogHeader>
          <div className="guide-steps">
            <div>
              <span>
                <Plus size={19} />
              </span>
              <div>
                <h3>写下主题，或放入论文</h3>
                <p>
                  告诉知视你想讲什么、讲给谁听。具体的问题，会带来更清晰的讲解。
                </p>
              </div>
            </div>
            <div>
              <span>
                <Play size={19} />
              </span>
              <div>
                <h3>看看脚本和画面</h3>
                <p>
                  制作进度会自动更新。你可以按片段检查旁白、画面说明与资料出处。
                </p>
              </div>
            </div>
            <div>
              <span>
                <ArrowDownToLine size={19} />
              </span>
              <div>
                <h3>改到满意，再导出</h3>
                <p>
                  修改讲解或调整画面参数，保存后自动更新视频。成片完成后，可以下载视频和项目文件。
                </p>
              </div>
            </div>
          </div>
          <Button
            className="guide-start"
            onClick={() => {
              setGuide(false);
              newProject();
            }}
          >
            开始我的第一支作品
            <ArrowRight size={16} />
          </Button>
        </DialogContent>
      </Dialog>
      <AnimatePresence>
        {toast && (
          <motion.div
            className={`app-toast ${toast.tone}`}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            role={toast.tone === "error" ? "alert" : "status"}
          >
            {toast.tone === "success" ? (
              <Check size={18} />
            ) : (
              <CircleHelp size={18} />
            )}
            <span>{toast.message}</span>
            <button aria-label="关闭提示" onClick={() => setToast(null)}>
              <X size={15} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function IdeaCard({
  idea,
  index,
  onSelect,
  onPreview,
}: {
  idea: (typeof ideas)[number];
  index: number;
  onSelect: () => void;
  onPreview: (button: HTMLButtonElement) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <motion.article
      className={`idea-card idea-${idea.kind}`}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.12 + index * 0.08, duration: 0.4 }}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setHovered(false);
      }}
    >
      <div className="idea-artwork">
        <KnowledgeArtwork kind={idea.kind} animated={hovered} />
        <span className="idea-category">{idea.category}</span>
        <button
          type="button"
          className="artwork-play"
          onClick={(event) => onPreview(event.currentTarget)}
          aria-label={`观看样片 · ${idea.title}`}
        >
          <Play size={15} fill="currentColor" />
          <span>观看样片</span>
        </button>
      </div>
      <button className="idea-copy" onClick={onSelect}>
        <span>
          <strong>{idea.title}</strong>
          <span>{idea.subtitle}</span>
        </span>
        <span className="idea-arrow">
          <ArrowUpRight size={18} />
        </span>
      </button>
    </motion.article>
  );
}

function ProjectRow({
  project,
  onOpen,
}: {
  project: ProjectSummary;
  onOpen: () => void;
}) {
  return (
    <button className="project-row" onClick={onOpen}>
      <span className="project-row-icon">
        <FileVideo size={22} />
      </span>
      <span className="project-row-name">
        <strong>{project.title}</strong>
        <span>
          {dateLabel(project.updatedAt)}
          <span>·</span>
          {durationLabel(project.durationSeconds)}
        </span>
      </span>
      <span className={`project-status status-${project.status}`}>
        <span />
        {project.stageLabel || projectStatusLabels[project.status]}
      </span>
      <ArrowUpRight size={17} />
    </button>
  );
}

function ProjectsPage({
  projects,
  loaded,
  connection,
  onCreate,
  onLogin,
  onOpen,
  onRetry,
}: {
  projects: ProjectSummary[];
  loaded: boolean;
  connection: Connection;
  onCreate: () => void;
  onLogin: () => void;
  onOpen: (id: string) => void;
  onRetry: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const filtered = useMemo(
    () =>
      projects.filter(
        (item) =>
          item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
          (filter === "all" ||
            (filter === "ready"
              ? item.status === "ready"
              : item.status !== "ready")),
      ),
    [projects, query, filter],
  );
  return (
    <motion.div
      className="projects-page"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="projects-heading">
        <div>
          <p className="eyebrow">每个作品，都从一个想法开始</p>
          <h1>
            我的作品<span>{projects.length}</span>
          </h1>
        </div>
        <Button onClick={onCreate}>
          <Plus size={17} />
          新建作品
        </Button>
      </div>
      <div className="projects-toolbar">
        <div className="project-filters" role="group" aria-label="筛选作品">
          {[
            { id: "all", label: "全部作品" },
            { id: "working", label: "制作中" },
            { id: "ready", label: "已完成" },
          ].map((item) => (
            <button
              key={item.id}
              className={filter === item.id ? "active" : ""}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="project-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索作品"
            aria-label="搜索作品"
          />
        </label>
      </div>
      {!loaded ? (
        <div className="page-state">
          <Loader2 size={24} className="animate-spin" />
          <p>正在加载作品…</p>
        </div>
      ) : connection === "unauthorized" ? (
        <div className="page-state">
          <span className="empty-icon">
            <FolderOpen size={28} />
          </span>
          <h2>登录，继续你的创作</h2>
          <p>登录后可以查看作品、制作进度和可用额度。</p>
          <Button onClick={onLogin}>登录 / 注册</Button>
        </div>
      ) : connection === "offline" && projects.length === 0 ? (
        <div className="page-state">
          <span className="empty-icon">
            <WifiOff size={28} />
          </span>
          <h2>等待制作服务连接</h2>
          <p>连接后，你的作品与制作进度会出现在这里。</p>
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw size={15} />
            重新连接
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="page-state">
          <span className="empty-icon">
            <Clapperboard size={28} />
          </span>
          <h2>
            {projects.length === 0
              ? "第一支作品，从你的好奇开始"
              : "还没有符合条件的作品"}
          </h2>
          <p>
            {projects.length === 0
              ? "一个知识点，一篇论文，都可以成为起点。"
              : "试试其他关键词，或切换筛选条件。"}
          </p>
          {projects.length === 0 && (
            <Button onClick={onCreate}>
              <Plus size={16} />
              开始创作
            </Button>
          )}
        </div>
      ) : (
        <div className="project-grid">
          {filtered.map((item) => (
            <button
              className="project-card"
              key={item.id}
              onClick={() => onOpen(item.id)}
            >
              <div className="project-thumbnail">
                {item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl} alt={item.title} />
                ) : (
                  <div className="project-placeholder-art">
                    <Clapperboard size={40} />
                    <span>
                      {item.status === "ready" ? "查看成片" : "创作进行中"}
                    </span>
                  </div>
                )}
                <span className={`project-status status-${item.status}`}>
                  <span />
                  {item.stageLabel || projectStatusLabels[item.status]}
                </span>
              </div>
              <div className="project-card-info">
                <strong>{item.title}</strong>
                <div>
                  <span>{dateLabel(item.updatedAt)}</span>
                  <span>
                    <Clock3 size={12} />
                    {durationLabel(item.durationSeconds)}
                  </span>
                </div>
                {item.status !== "ready" && (
                  <div className="project-progress-track">
                    <div
                      style={{
                        width: `${Math.min(100, Math.max(0, item.progress || 0))}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}
