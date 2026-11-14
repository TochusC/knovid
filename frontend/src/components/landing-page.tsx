import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import { ArrowDown, ArrowUpRight, Pause, Play, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeControl } from "@/components/theme-control";
import { KineticSculpture } from "@/components/kinetic-sculpture";
import {
  ProcessExhibit,
  PlatformExhibit,
} from "@/components/platform-exhibits";
import "./landing-page.css";

interface LandingPageProps {
  onEnter: (topic?: string) => void;
  onDemo: () => void;
  onLogin: () => void;
  accountLabel?: string;
}

const chapters = ["开场", "创作之旅", "知视的不同"];
const destinations = [0, 0.49, 1];

function StoryLayer({
  progress,
  quiet,
  current,
  index,
  range,
  opacity,
  children,
  className = "",
}: {
  progress: MotionValue<number>;
  quiet: boolean;
  current: number;
  index: number;
  range: number[];
  opacity: number[];
  children: ReactNode;
  className?: string;
}) {
  const fade = useTransform(progress, range, opacity);
  const scale = useTransform(
    progress,
    range,
    quiet ? [1, 1, 1, 1] : [0.94, 1, 1, 1.2],
  );
  const y = useTransform(
    progress,
    range,
    quiet ? [0, 0, 0, 0] : [28, 0, 0, -24],
  );
  return (
    <motion.section
      className={`landing-depth-story ${className}`}
      aria-labelledby={`landing-chapter-${index}`}
      aria-hidden={current !== index}
      inert={current !== index}
      style={{ opacity: fade, scale, y, pointerEvents: "none" }}
    >
      {children}
    </motion.section>
  );
}

export function LandingPage({
  onEnter,
  onDemo,
  onLogin,
  accountLabel,
}: LandingPageProps) {
  const track = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [chapter, setChapter] = useState(0);
  const { scrollYProgress } = useScroll({
    target: track,
    offset: ["start start", "end end"],
  });
  const smoothProgress = useSpring(scrollYProgress, {
    stiffness: 95,
    damping: 28,
    mass: 0.6,
  });
  const quiet = Boolean(reduced) || paused;
  const progress = quiet ? scrollYProgress : smoothProgress;
  const active = !quiet && visible;
  const wordmarkFade = useTransform(progress, [0, 0.13, 0.31], [1, 1, 0]);
  const wordmarkScale = useTransform(
    progress,
    [0, 0.13, 0.36],
    quiet ? [1, 1, 1] : [1, 1.03, 1.7],
  );

  useEffect(() => {
    const sync = (value: number) =>
      setChapter(value < 0.31 ? 0 : value < 0.73 ? 1 : 2);
    sync(progress.get());
    return progress.on("change", sync);
  }, [progress]);

  useEffect(() => {
    document.documentElement.classList.add("knovid-immersive-page");
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.documentElement.classList.remove("knovid-immersive-page");
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  function travelTo(index: number) {
    if (!track.current || !viewport.current) return;
    const top = window.scrollY + track.current.getBoundingClientRect().top;
    const distance = track.current.offsetHeight - viewport.current.offsetHeight;
    window.scrollTo({
      top: top + distance * destinations[index],
      behavior: quiet ? "instant" : "smooth",
    });
  }

  return (
    <div
      ref={track}
      className={`landing-journey ${quiet ? "landing-still" : ""}`}
    >
      <div
        ref={viewport}
        className={`landing-viewport landing-current-${chapter}`}
      >
        <div className="landing-paper-texture" aria-hidden="true" />
        <main className="landing-world" aria-label="知视沉浸式展示">
          <motion.div
            className="landing-wordmark"
            style={{ opacity: wordmarkFade, scale: wordmarkScale }}
            aria-hidden="true"
          >
            <span>Kno</span>
            <span>Vid</span>
          </motion.div>
          <KineticSculpture
            progress={progress}
            active={active && chapter === 0}
            quiet={quiet}
          />
          <StoryLayer
            progress={progress}
            quiet={quiet}
            current={chapter}
            index={0}
            range={[-0.2, 0, 0.13, 0.31]}
            opacity={[1, 1, 1, 0]}
            className="landing-opening"
          >
            <div className="landing-edition">
              <span>让好奇，有了形状。</span>
              <i>KNOWLEDGE IN MOTION</i>
            </div>
            <div className="landing-opening-copy">
              <span className="landing-overline">AI 知识影像创作</span>
              <h1 id="landing-chapter-0">
                知识视频，
                <br />
                从一个好问题开始。
              </h1>
              <p>
                输入想法或资料，
                <br />和 AI 一起，把它讲清楚。
              </p>
              <div className="landing-opening-actions">
                <Button
                  className="landing-create-button"
                  onClick={() => onEnter()}
                >
                  <span className="landing-create-mark" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="landing-create-label">
                    <small>MAKE IT A VIDEO</small>
                    <span>开始创作</span>
                  </span>
                  <span className="landing-create-arrow">
                    <ArrowUpRight size={19} strokeWidth={1.5} />
                  </span>
                </Button>
                <button className="landing-film-link" onClick={onDemo}>
                  <span className="landing-play-icon">
                    <Play size={10} fill="currentColor" />
                  </span>
                  <span>看一支样片</span>
                </button>
              </div>
              <span className="landing-free-note">
                无需注册<span>·</span>3 次免费试用<span>·</span>每条 30 秒
              </span>
            </div>
          </StoryLayer>
          <StoryLayer
            progress={progress}
            quiet={quiet}
            current={chapter}
            index={1}
            range={[0.28, 0.4, 0.58, 0.74]}
            opacity={[0, 1, 1, 0]}
            className="landing-process-scene"
          >
            <ProcessExhibit
              quiet={quiet}
              active={active && chapter === 1}
              onContinue={() => travelTo(2)}
              onDemo={onDemo}
            />
          </StoryLayer>
          <StoryLayer
            progress={progress}
            quiet={quiet}
            current={chapter}
            index={2}
            range={[0.7, 0.86, 1, 1.2]}
            opacity={[0, 1, 1, 1]}
            className="landing-platform-scene"
          >
            <PlatformExhibit
              active={active && chapter === 2}
              quiet={quiet}
              onEnter={() => onEnter()}
            />
          </StoryLayer>
        </main>
        <button
          className="landing-floating-brand"
          onClick={() => travelTo(0)}
          aria-label="KnoVid 知视，回到开场"
        >
          <img src="/favicon.svg" width={26} height={26} alt="" />
          <strong>
            知视<span>KNOVID</span>
          </strong>
        </button>
        <button className="landing-skip" onClick={() => onEnter()}>
          进入工作台 <ArrowUpRight size={15} />
        </button>
        <div className="landing-tools" aria-label="展示设置">
          <ThemeControl />
          <button
            onClick={() => setPaused((value) => !value)}
            disabled={Boolean(reduced)}
            aria-pressed={quiet}
            aria-label={
              reduced
                ? "已跟随系统减少动态效果"
                : paused
                  ? "播放动效"
                  : "暂停动效"
            }
            title={
              reduced
                ? "已跟随系统减少动态效果"
                : paused
                  ? "播放动效"
                  : "暂停动效"
            }
          >
            {quiet ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button
            onClick={onLogin}
            aria-label={accountLabel || "登录账号"}
            title={accountLabel || "登录账号"}
          >
            <UserRound size={15} />
          </button>
        </div>
        <div className="landing-journey-controls">
          <div
            className="landing-chapters"
            role="group"
            aria-label="切换展示场景"
          >
            {chapters.map((label, index) => (
              <button
                key={label}
                onClick={() => travelTo(index)}
                aria-label={`前往${label}`}
                aria-current={chapter === index ? "step" : undefined}
              >
                <span>0{index + 1}</span>
                <i />
                <b>{label}</b>
              </button>
            ))}
          </div>
          <button
            className="landing-scroll-cue"
            onClick={() => travelTo(chapter === 2 ? 0 : chapter + 1)}
          >
            <span>
              {chapter === 2
                ? "回到开场"
                : chapter === 1
                  ? "继续，认识知视"
                  : "向下，进入知视"}
            </span>
            <ArrowDown
              size={16}
              strokeWidth={1.3}
              className={chapter === 2 ? "landing-back-arrow" : ""}
            />
          </button>
        </div>
        <motion.div
          className="landing-depth-progress"
          style={{ scaleY: progress }}
          aria-hidden="true"
        />
        <span className="sr-only" aria-live="polite">
          {chapters[chapter]}
        </span>
      </div>
    </div>
  );
}
