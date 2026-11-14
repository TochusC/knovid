import { useEffect, useId, useRef, useState } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import "./wave-studio.css";

interface WaveStudioProps {
  progress: MotionValue<number>;
  quiet: boolean;
  active: boolean;
  onContinue: () => void;
}

type Phase = 0 | 90 | 180;
const phaseOptions: Phase[] = [0, 90, 180];
const explanations = {
  0: {
    amplitude: "2",
    name: "相长叠加",
    description: "波峰与波峰相遇，起伏成为原来的两倍。",
  },
  90: {
    amplitude: "√2",
    name: "部分叠加",
    description: "错开四分之一个周期，起伏重新组合。",
  },
  180: {
    amplitude: "0",
    name: "相消干涉",
    description: "波峰与波谷相遇，起伏恰好被抵消。",
  },
} satisfies Record<
  Phase,
  { amplitude: string; name: string; description: string }
>;

const centers = [90, 230, 415];

function WaveDiagram({ phase, active }: { phase: Phase; active: boolean }) {
  const id = useId().replaceAll(":", "");
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const surfaces = useRef<(SVGPathElement | null)[]>([]);
  const heads = useRef<(SVGCircleElement | null)[]>([]);
  const clock = useRef(0);

  useEffect(() => {
    let frame = 0;
    let previous = 0;
    const radians = (phase * Math.PI) / 180;
    const value = (row: number, x: number, t: number) => {
      const a = Math.sin(x * Math.PI * 4 - t);
      const b = Math.sin(x * Math.PI * 4 - t + radians);
      // Keep exact opposition flat, avoiding floating-point roundoff.
      return row === 0 ? a : row === 1 ? b : phase === 180 ? 0 : a + b;
    };
    const render = (now = performance.now()) => {
      if (active) frame = requestAnimationFrame(render);
      if (active && previous && now - previous < 30) return;
      if (active && previous)
        clock.current += Math.min(now - previous, 80) / 1000;
      previous = now;
      const t = clock.current * 0.62;
      centers.forEach((center, row) => {
        const samples = Array.from({ length: 161 }, (_, index) => {
          const u = index / 160;
          return [8 + u * 684, center - value(row, u, t) * 31];
        });
        const line = samples
          .map(
            ([x, y], index) =>
              `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`,
          )
          .join(" ");
        paths.current[row]?.setAttribute("d", line);
        surfaces.current[row]?.setAttribute(
          "d",
          `${line} L692,${center} L8,${center} Z`,
        );
        const probe = 0.61;
        heads.current[row]?.setAttribute("cx", String(8 + probe * 684));
        heads.current[row]?.setAttribute(
          "cy",
          String(center - value(row, probe, t) * 31),
        );
      });
    };
    render();
    return () => cancelAnimationFrame(frame);
  }, [phase, active]);

  return (
    <svg
      className="wave-diagram"
      viewBox="0 0 700 520"
      preserveAspectRatio="none"
      role="img"
      aria-label={`两列同频等振幅正弦波，相位差 ${phase} 度；合成振幅 ${explanations[phase].amplitude} 倍。`}
    >
      <defs>
        {centers.map((_, row) => (
          <g key={row}>
            <linearGradient
              id={`${id}-wash-${row}`}
              className={`wave-trace-${row}`}
              x1="0"
              x2="1"
              y1="0"
              y2="0"
            >
              <stop stopColor="currentColor" stopOpacity=".02" />
              <stop offset=".45" stopColor="currentColor" stopOpacity=".13" />
              <stop offset="1" stopColor="currentColor" stopOpacity=".02" />
            </linearGradient>
            <path
              id={`${id}-line-${row}`}
              ref={(node) => {
                paths.current[row] = node;
              }}
            />
          </g>
        ))}
      </defs>
      {centers.map((center, row) => (
        <g className={`wave-trace wave-trace-${row}`} key={row}>
          <line
            x1="8"
            x2="692"
            y1={center}
            y2={center}
            className="wave-baseline"
          />
          <path
            ref={(node) => {
              surfaces.current[row] = node;
            }}
            fill={`url(#${id}-wash-${row})`}
          />
          <use href={`#${id}-line-${row}`} className="wave-line-halo" />
          <use href={`#${id}-line-${row}`} className="wave-line" />
          <circle
            ref={(node) => {
              heads.current[row] = node;
            }}
            r="4.5"
            className="wave-probe"
          />
        </g>
      ))}
    </svg>
  );
}

export function WaveStudio({
  progress,
  quiet,
  active,
  onContinue,
}: WaveStudioProps) {
  const [phase, setPhase] = useState<Phase>(180);
  const answer = explanations[phase];
  const arrival = useTransform(progress, [0.3, 0.43], quiet ? [0, 0] : [30, 0]);
  const reveal = useTransform(
    progress,
    [0.31, 0.42],
    quiet ? [1, 1] : [0.35, 1],
  );

  return (
    <div
      className={`wave-studio ${active && !quiet ? "wave-studio-live" : "wave-studio-still"}`}
    >
      <div className="wave-story">
        <span className="wave-eyebrow">
          02 <i /> 让原理发生
        </span>
        <h2 id="landing-chapter-1">
          声音，
          <br />
          如何让声音<span>消失。</span>
        </h2>
        <p className="wave-intro">
          两列声波，可以放大彼此，
          <br />
          也可以恰好抵消。改变相位，看看结果。
        </p>
        <div className="wave-phase-heading">
          相位差 <i>φ</i>
        </div>
        <div
          className="wave-phase-options"
          role="group"
          aria-label="选择两道声波的相位差"
        >
          {phaseOptions.map((option) => (
            <button
              key={option}
              className="wave-phase-button"
              onClick={() => setPhase(option)}
              aria-pressed={phase === option}
              aria-label={`相位差 ${option} 度`}
            >
              <span>
                {option}
                <sup>°</sup>
              </span>
              <small>
                {option === 0 ? "同相" : option === 90 ? "错开" : "反相"}
              </small>
            </button>
          ))}
        </div>
        <div className="wave-answer" aria-live="polite" aria-atomic="true">
          <div className="wave-answer-value">
            <strong>{answer.amplitude}</strong>
            <span>
              倍<br />
              <small>合成振幅</small>
            </span>
          </div>
          <p>{answer.description}</p>
        </div>
        <Button variant="ghost" className="wave-continue" onClick={onContinue}>
          现在，讲讲你的知识 <ArrowUpRight size={16} />
        </Button>
      </div>
      <motion.div
        className="wave-canvas"
        style={{ y: arrival, opacity: reveal }}
      >
        <div className="wave-canvas-heading">
          <span>两列波 · 一个答案</span>
          <span>相位差 {phase}°</span>
        </div>
        <div className="wave-experiment">
          <div className="wave-plot-label wave-label-a">
            <i>A</i>
            <span>参考声波</span>
          </div>
          <div className="wave-plot-label wave-label-b">
            <i>B</i>
            <span>相移 {phase}°</span>
          </div>
          <div className="wave-plot-label wave-label-result">
            <i>A + B</i>
            <span>{answer.name}</span>
          </div>
          <WaveDiagram phase={phase} active={active && !quiet} />
        </div>
        <p className="wave-footnote">
          同频、等振幅的理想波形示意。振幅以单列声波为 1，
          <br className="wave-note-break" />
          不代表全空间消声。
        </p>
      </motion.div>
    </div>
  );
}
