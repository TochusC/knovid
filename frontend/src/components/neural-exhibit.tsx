import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, MoveRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import "./neural-exhibit.css";

interface NeuralExhibitProps {
  active: boolean;
  quiet: boolean;
  onEnter: () => void;
}

type Point = { x: number; y: number; z: number };
type Projected = Point & { s: number };
const layerX = [-1.9, -0.64, 0.64, 1.9];
const layerNames = ["输入", "特征", "组合", "输出"];
const layout = [
  [
    [-0.82, 0],
    [-0.27, 0],
    [0.27, 0],
    [0.82, 0],
  ],
  [
    [-0.82, -0.33],
    [0, -0.33],
    [0.82, -0.33],
    [-0.82, 0.33],
    [0, 0.33],
    [0.82, 0.33],
  ],
  [
    [-0.82, -0.33],
    [0, -0.33],
    [0.82, -0.33],
    [-0.82, 0.33],
    [0, 0.33],
    [0.82, 0.33],
  ],
  [
    [-0.65, 0],
    [0, 0],
    [0.65, 0],
  ],
];

function NeuralModel({
  active,
  quiet,
  pulse,
}: {
  active: boolean;
  quiet: boolean;
  pulse: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const clock = useRef(0.4);
  const lastPulse = useRef(pulse);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    let width = 0;
    let height = 0;
    let frame = 0;
    let previous = 0;
    let dark = document.documentElement.classList.contains("dark");
    const live = active && !quiet;
    if (pulse !== lastPulse.current) {
      clock.current = quiet ? (pulse % 4) * 1.1 + 0.28 : 0.28;
      lastPulse.current = pulse;
    }

    const draw = () => {
      if (!width || !height) return;
      ctx.clearRect(0, 0, width, height);
      const scale = Math.min(width / 4.7, height / 3.7);
      const time = clock.current;
      const cycle = time % 6.2;
      const turn = -0.57 + (live ? Math.sin(time * 0.17) * 0.025 : 0);
      const tilt = 0.17;
      const ca = Math.cos(turn),
        sa = Math.sin(turn);
      const cb = Math.cos(tilt),
        sb = Math.sin(tilt);
      const project = (x: number, y: number, z: number): Projected => {
        const a = x * ca + z * sa;
        const c = -x * sa + z * ca;
        const b = y * cb - c * sb;
        const depth = y * sb + c * cb;
        const perspective = 9 / (9 + depth);
        return {
          x: width * 0.51 + a * scale * perspective,
          y: height * 0.46 + b * scale * perspective,
          z: depth,
          s: perspective,
        };
      };
      const path = (points: Projected[]) => {
        ctx.beginPath();
        points.forEach((p, i) =>
          i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
        );
        ctx.closePath();
      };
      const planes = layerX
        .map((x, index) => ({
          index,
          points: [
            project(x, -1.27, -0.75),
            project(x, -1.27, 0.75),
            project(x, 1.27, 0.75),
            project(x, 1.27, -0.75),
          ],
          back: [
            project(x + 0.055, -1.27, -0.75),
            project(x + 0.055, -1.27, 0.75),
            project(x + 0.055, 1.27, 0.75),
            project(x + 0.055, 1.27, -0.75),
          ],
          depth: project(x, 0, 0).z,
        }))
        .sort((a, b) => b.depth - a.depth);

      // Soft elliptical shadows keep the network grounded without a floor grid.
      for (const x of layerX) {
        const p = project(x, 1.55, 0);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(1, 0.25);
        const shadow = ctx.createRadialGradient(0, 0, 1, 0, 0, scale * 0.67);
        shadow.addColorStop(
          0,
          dark ? "rgba(88,83,161,.18)" : "rgba(76,76,129,.11)",
        );
        shadow.addColorStop(1, "rgba(80,80,140,0)");
        ctx.fillStyle = shadow;
        ctx.fillRect(-scale, -scale, scale * 2, scale * 2);
        ctx.restore();
      }

      for (const plane of planes) {
        const p = plane.points;
        const b = plane.back;
        path([p[1], b[1], b[2], p[2]]);
        ctx.fillStyle = dark
          ? "rgba(146,144,205,.19)"
          : "rgba(122,126,184,.18)";
        ctx.fill();
        path([p[2], b[2], b[3], p[3]]);
        ctx.fillStyle = dark
          ? "rgba(146,144,205,.13)"
          : "rgba(105,109,170,.13)";
        ctx.fill();
        const fill = ctx.createLinearGradient(p[0].x, p[0].y, p[2].x, p[2].y);
        fill.addColorStop(
          0,
          dark ? "rgba(177,181,245,.13)" : "rgba(255,255,255,.72)",
        );
        fill.addColorStop(
          0.45,
          dark ? "rgba(111,109,176,.06)" : "rgba(173,184,229,.08)",
        );
        fill.addColorStop(
          1,
          dark ? "rgba(126,120,189,.15)" : "rgba(149,147,210,.18)",
        );
        path(p);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = dark
          ? "rgba(201,205,251,.28)"
          : "rgba(124,133,188,.28)";
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p[0].x, p[0].y);
        ctx.lineTo(p[1].x, p[1].y);
        ctx.lineTo(p[2].x, p[2].y);
        ctx.strokeStyle = dark
          ? "rgba(214,216,255,.32)"
          : "rgba(255,255,255,.95)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      const nodes = layout.map((layer, index) =>
        layer.map(([y, z], n) => ({
          ...project(layerX[index] - 0.03, y, z),
          layer: index,
          n,
        })),
      );
      nodes.slice(0, -1).forEach((layer, l) => {
        layer.forEach((p, i) => {
          nodes[l + 1].forEach((q, j) => {
            // Sparse visible routes keep the structure legible; this is a model, not inference.
            const emphasized = (i + j * 2 + l) % 3 === 0;
            if (!emphasized && (i + j) % 2) return;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.strokeStyle = dark
              ? `rgba(151,147,214,${emphasized ? 0.26 : 0.08})`
              : `rgba(109,112,178,${emphasized ? 0.24 : 0.08})`;
            ctx.lineWidth = emphasized ? 0.85 : 0.6;
            ctx.stroke();
            const u = (cycle - l * 1.1 - i * 0.035) / 1.1;
            if (emphasized && u >= 0 && u <= 1) {
              const headX = p.x + (q.x - p.x) * u;
              const headY = p.y + (q.y - p.y) * u;
              const tail = Math.max(0, u - 0.13);
              const trail = ctx.createLinearGradient(
                p.x + (q.x - p.x) * tail,
                p.y + (q.y - p.y) * tail,
                headX,
                headY,
              );
              trail.addColorStop(0, "rgba(110,93,206,0)");
              trail.addColorStop(
                1,
                dark ? "rgba(204,196,255,.85)" : "rgba(105,86,198,.75)",
              );
              ctx.beginPath();
              ctx.moveTo(p.x + (q.x - p.x) * tail, p.y + (q.y - p.y) * tail);
              ctx.lineTo(headX, headY);
              ctx.strokeStyle = trail;
              ctx.lineWidth = 2;
              ctx.stroke();
              ctx.beginPath();
              ctx.arc(headX, headY, 1.8, 0, Math.PI * 2);
              ctx.fillStyle = dark ? "#d6ceff" : "#7662cc";
              ctx.fill();
            }
          });
        });
      });

      const allNodes = nodes.flat().sort((a, b) => b.z - a.z);
      for (const p of allNodes) {
        const activation = Math.exp(
          -((cycle - p.layer * 1.1 - 0.18) ** 2) / 0.2,
        );
        const radius =
          Math.max(5, Math.min(12.2, scale * 0.096)) *
          p.s *
          (1 + activation * 0.13);
        ctx.save();
        ctx.translate(p.x, p.y);
        const fill = ctx.createRadialGradient(
          -radius * 0.38,
          -radius * 0.42,
          0,
          0,
          0,
          radius,
        );
        fill.addColorStop(0, dark ? "#eeebff" : "#f6f7ff");
        fill.addColorStop(
          0.2,
          activation > 0.25 ? "#c1b4f3" : dark ? "#b8b8e6" : "#d0d7f0",
        );
        fill.addColorStop(0.68, activation > 0.25 ? "#8571ce" : "#8d9acb");
        fill.addColorStop(1, activation > 0.25 ? "#594891" : "#596b9d");
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = dark
          ? "rgba(224,221,255,.4)"
          : "rgba(244,246,255,.85)";
        ctx.lineWidth = 0.65;
        ctx.stroke();
        ctx.restore();
      }

      ctx.font = `${Math.max(8, Math.min(11, width / 48))}px "PingFang SC", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = dark ? "#9296b5" : "#777e9b";
      layerX.forEach((x, i) => {
        const p = project(x, 1.64, 0);
        ctx.fillText(layerNames[i], p.x, p.y);
      });
    };

    const tick = (now: number) => {
      if (live) frame = requestAnimationFrame(tick);
      if (previous && now - previous < 32) return;
      if (previous && live)
        clock.current += Math.min(now - previous, 80) / 1000;
      previous = now;
      draw();
    };
    const resize = () => {
      width = element.clientWidth;
      height = element.clientHeight;
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      element.width = Math.round(width * dpr);
      element.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const themeObserver = new MutationObserver(() => {
      dark = document.documentElement.classList.contains("dark");
      draw();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    resize();
    if (live) frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
    };
  }, [active, quiet, pulse]);

  return (
    <canvas ref={canvas} className="neural-exhibit-canvas" aria-hidden="true" />
  );
}

export function NeuralExhibit({ active, quiet, onEnter }: NeuralExhibitProps) {
  const [pulse, setPulse] = useState(0);
  return (
    <div className="neural-exhibit">
      <div className="neural-exhibit-copy">
        <span className="neural-exhibit-index">
          03 <i /> 理解的形状
        </span>
        <h2 id="landing-chapter-2">
          AI 如何
          <br />
          <span>学会识别？</span>
        </h2>
        <p>
          从输入到输出，
          <br />
          跟随一次信号的传递。
        </p>
        <button
          className="neural-exhibit-pulse"
          onClick={() => setPulse((value) => value + 1)}
        >
          <span>{quiet ? "推进一道信号" : "发送一道信号"}</span>
          <MoveRight size={17} strokeWidth={1.3} />
        </button>
        <div className="neural-exhibit-creation">
          <Button className="neural-exhibit-enter" onClick={onEnter}>
            开始创作
            <ArrowUpRight size={19} strokeWidth={1.4} />
          </Button>
          <small>无需注册 · 3 次试用 · 每条 30 秒</small>
        </div>
      </div>
      <figure
        className="neural-exhibit-figure"
        aria-label="四层神经网络的立体结构示意，球形节点与连接展示信号从输入流向输出"
      >
        <div className="neural-exhibit-model">
          <NeuralModel active={active} quiet={quiet} pulse={pulse} />
        </div>
        <figcaption>
          <span>
            输入 <ArrowRight size={12} /> 特征 <ArrowRight size={12} /> 输出
          </span>
          <small>神经网络结构示意，非实时模型推理</small>
        </figcaption>
      </figure>
      <span className="sr-only" aria-live="polite">
        {pulse > 0
          ? quiet
            ? `已推进至第 ${(pulse % 4) + 1} 层信号示意`
            : "已重新发送信号，依次经过四层网络"
          : "四层神经网络结构示意"}
      </span>
    </div>
  );
}
