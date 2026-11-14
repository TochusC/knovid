import { useEffect, useRef } from "react";

type SceneKind = "orbit" | "probability" | "neural";

/** A live, deliberately illustrative knowledge scene; no video or external assets. */
export function LandingVisual({
  active,
  kind,
  focusX = 0.54,
  focusY = 0.46,
  depth = 0,
}: {
  active: boolean;
  kind: SceneKind;
  /** Normalized scene center, independent of the canvas dimensions. */
  focusX?: number;
  focusY?: number;
  /** 0–1 controls the sense of forward travel, not the scene scale. */
  depth?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clock = useRef(0);
  const pointer = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const settings = useRef({ focusX, focusY, depth });
  const redraw = useRef<(() => void) | null>(null);

  // Scroll-driven props update the drawing state without restarting the RAF loop.
  useEffect(() => {
    settings.current = {
      focusX: Math.max(0, Math.min(1, focusX)),
      focusY: Math.max(0, Math.min(1, focusY)),
      depth: Math.max(0, Math.min(1, depth)),
    };
    if (!active) redraw.current?.();
  }, [focusX, focusY, depth, active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = 0;
    const random = (n: number) => {
      const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    const colors = ["#8b82ff", "#72c7ff", "#bd9aff", "#d8ecff"];
    const project = (x: number, y: number, z: number, turn = 0) => {
      const angle = -0.38 + pointer.current.x * 0.12 + turn;
      const nx = x * Math.cos(angle) - z * Math.sin(angle);
      const nz = x * Math.sin(angle) + z * Math.cos(angle);
      const tilt = 0.42 + pointer.current.y * 0.08;
      const ny = y * Math.cos(tilt) - nz * Math.sin(tilt);
      const depth = y * Math.sin(tilt) + nz * Math.cos(tilt);
      const focal = Math.max(680, Math.min(width * 0.39, height * 0.35) * 3.4);
      const scale = focal / (focal + depth);
      return {
        x:
          width * settings.current.focusX + nx * scale + pointer.current.x * 14,
        y:
          height * settings.current.focusY +
          ny * scale +
          pointer.current.y * 10,
        depth,
        scale,
      };
    };
    const glow = (
      x: number,
      y: number,
      radius: number,
      color: string,
      alpha = 1,
    ) => {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, "transparent");
      ctx.globalAlpha = alpha;
      ctx.fillStyle = gradient;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      ctx.globalAlpha = 1;
    };
    const dot = (x: number, y: number, radius: number, color: string) => {
      ctx.beginPath();
      ctx.arc(x, y, Math.max(radius, 0.2), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    const draw = (now = performance.now()) => {
      if (active) frame = requestAnimationFrame(draw);
      if (!width || !height) return;
      // At most 40 drawn frames per second; idle/reduced-motion scenes render once.
      if (active && last && now - last < 25) return;
      if (active && last) clock.current += Math.min(now - last, 100) / 1000;
      last = now;
      const t = clock.current;
      pointer.current.x += (pointer.current.tx - pointer.current.x) * 0.035;
      pointer.current.y += (pointer.current.ty - pointer.current.y) * 0.035;
      ctx.clearRect(0, 0, width, height);
      const unit = Math.min(width * 0.39, height * 0.35);
      const { focusX: fx, focusY: fy, depth: travel } = settings.current;
      const cx = width * fx;
      const cy = height * fy;
      glow(cx + width * 0.04, cy - height * 0.04, unit * 1.9, "#4c31a8", 0.34);
      glow(cx + width * 0.31, cy + height * 0.25, unit * 1.25, "#0d65b0", 0.15);
      // A vanishing grid sets the scene in space, with quiet depth particles.
      ctx.lineWidth = 0.6;
      for (let i = -12; i <= 12; i++) {
        ctx.beginPath();
        ctx.moveTo(cx - width * 0.01 + i * 6, cy + height * 0.15);
        ctx.lineTo(cx - width * 0.01 + i * width * 0.13, height * 1.1);
        ctx.strokeStyle = "rgba(131,133,232,.08)";
        ctx.stroke();
      }
      for (let i = 0; i < 9; i++) {
        const y = cy + height * 0.16 + (i / 9) ** 2 * (height * 0.94 - cy);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.strokeStyle = `rgba(131,133,232,${0.025 + i * 0.006})`;
        ctx.stroke();
      }
      for (let i = 0; i < 85; i++) {
        const x = (random(i + 1) * width + t * (2 + random(i + 6) * 5)) % width;
        const y = random(i + 47) * height;
        const a = 0.13 + random(i + 29) * 0.45 + Math.sin(t * 0.7 + i) * 0.08;
        ctx.globalAlpha = a;
        dot(
          x + pointer.current.x * random(i) * 9,
          y,
          random(i + 2) * 1.1 + 0.25,
          "#bfc9ff",
        );
      }
      ctx.globalAlpha = 1;
      // Fixed seeds move through a shallow 3-D star field toward the viewer.
      // Short tails grow with depth, adding immersion without a full-screen blur pass.
      for (let i = 0; i < 72; i++) {
        const seed = random(i + 401);
        const angle = random(i + 208) * Math.PI * 2;
        const z = 1.12 - ((seed + t * 0.035 + travel * 0.22) % 1);
        const reach = 0.08 + random(i + 717) * 0.34;
        const tailZ = z + 0.003 + travel * 0.009;
        const dx = Math.cos(angle) * width * reach;
        const dy = Math.sin(angle) * height * reach;
        const x = cx + dx / z + (pointer.current.x * 6) / z;
        const y = cy + dy / z + (pointer.current.y * 5) / z;
        if (x < -10 || x > width + 10 || y < -10 || y > height + 10) continue;
        const opacity = Math.min(0.55, (1.12 - z) * 0.5) * (0.6 + travel * 0.4);
        ctx.beginPath();
        ctx.moveTo(
          cx + dx / tailZ + (pointer.current.x * 6) / tailZ,
          cy + dy / tailZ + (pointer.current.y * 5) / tailZ,
        );
        ctx.lineTo(x, y);
        ctx.lineWidth = Math.min(1.35, 0.35 / z);
        ctx.strokeStyle = `rgba(166,177,255,${opacity})`;
        ctx.stroke();
        ctx.globalAlpha = opacity;
        dot(x, y, Math.min(1.7, 0.35 / z), "#d2d9ff");
      }
      ctx.globalAlpha = 1;
      if (kind === "orbit") {
        // Ellipses, plane inclinations and orbiting points form a luminous armillary sphere.
        const center = project(0, 0, 0);
        glow(center.x, center.y, unit * 0.7, "#7752ed", 0.52);
        for (let ring = 0; ring < 5; ring++) {
          const radius = unit * (0.72 + ring * 0.19);
          const tilt = [-0.04, 0.35, -0.5, 0.85, -0.9][ring];
          for (let step = 0; step < 150; step++) {
            const a = (step / 150) * Math.PI * 2;
            const b = ((step + 1) / 150) * Math.PI * 2;
            const pos = (angle: number) =>
              project(
                Math.cos(angle) * radius,
                Math.sin(angle) * radius * Math.sin(tilt),
                Math.sin(angle) * radius * Math.cos(tilt),
                0.12 * Math.sin(t * 0.07),
              );
            const p = pos(a);
            const q = pos(b);
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.strokeStyle = `rgba(${ring % 2 ? "131,165,255" : "164,123,255"},${p.depth > 0 ? 0.15 : 0.47})`;
            ctx.lineWidth = ring === 1 ? 1.5 : 0.8;
            ctx.stroke();
          }
          const angle = t * (0.22 - ring * 0.025) + ring * 1.6;
          const p = project(
            Math.cos(angle) * radius,
            Math.sin(angle) * radius * Math.sin(tilt),
            Math.sin(angle) * radius * Math.cos(tilt),
            0.12 * Math.sin(t * 0.07),
          );
          for (let trail = 28; trail > 0; trail--) {
            const a = angle - trail * 0.008;
            const q = project(
              Math.cos(a) * radius,
              Math.sin(a) * radius * Math.sin(tilt),
              Math.sin(a) * radius * Math.cos(tilt),
              0.12 * Math.sin(t * 0.07),
            );
            ctx.globalAlpha = (1 - trail / 29) * 0.7;
            dot(q.x, q.y, 2.8 * q.scale, colors[ring % 4]);
          }
          ctx.globalAlpha = 1;
          glow(p.x, p.y, 22, colors[ring % 4], 0.6);
          dot(p.x, p.y, (ring === 1 ? 5.5 : 3.5) * p.scale, "#e5e7ff");
        }
        const orb = unit * 0.27;
        const fill = ctx.createRadialGradient(
          center.x - orb * 0.4,
          center.y - orb * 0.5,
          0,
          center.x,
          center.y,
          orb,
        );
        fill.addColorStop(0, "#c8b1ff");
        fill.addColorStop(0.18, "#9a74f5");
        fill.addColorStop(0.55, "#5248b1");
        fill.addColorStop(0.94, "#25255e");
        fill.addColorStop(1, "#a394fb");
        ctx.beginPath();
        ctx.arc(center.x, center.y, orb, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.arc(center.x, center.y, orb - 1, 0, Math.PI * 2);
        ctx.clip();
        for (let i = -5; i <= 5; i++) {
          ctx.beginPath();
          ctx.ellipse(
            center.x,
            center.y + i * orb * 0.19,
            orb,
            orb * 0.17,
            -0.3,
            0,
            Math.PI * 2,
          );
          ctx.strokeStyle = "rgba(215,200,255,.12)";
          ctx.lineWidth = 0.7;
          ctx.stroke();
        }
        ctx.restore();
        // Tiny satellites give a sense of scale without competing with the teaching visual.
        for (let i = 0; i < 55; i++) {
          const a = (i / 55) * Math.PI * 2 + t * 0.05;
          const r = unit * (1.39 + random(i + 29) * 0.13);
          const p = project(
            Math.cos(a) * r,
            (random(i + 40) - 0.5) * unit * 0.12,
            Math.sin(a) * r,
          );
          ctx.globalAlpha = 0.15 + random(i) * 0.4;
          dot(p.x, p.y, 1, "#a49dff");
        }
        ctx.globalAlpha = 1;
      } else if (kind === "probability") {
        const turn = -0.16 + Math.sin(t * 0.08) * 0.12;
        for (let row = 0; row < 7; row++) {
          for (let column = 0; column < 23; column++) {
            const x = (column - 11) / 11;
            const value =
              Math.exp(-x * x * 3.5) *
              (0.88 + Math.sin(t * 0.9 + row * 0.5 + column * 0.1) * 0.07);
            const p = project(
              x * unit * 1.2,
              unit * 0.45,
              (row - 3) * unit * 0.16,
              turn,
            );
            const q = project(
              x * unit * 1.2,
              unit * 0.45 - value * unit * 1.55,
              (row - 3) * unit * 0.16,
              turn,
            );
            const gradient = ctx.createLinearGradient(p.x, p.y, q.x, q.y);
            gradient.addColorStop(0, "rgba(100,90,230,.01)");
            gradient.addColorStop(
              1,
              row % 2 ? "rgba(123,180,255,.7)" : "rgba(173,135,255,.7)",
            );
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.strokeStyle = gradient;
            ctx.lineWidth = unit * 0.023;
            ctx.stroke();
            dot(q.x, q.y, 1.8, "#d8ceff");
          }
        }
        for (let i = 0; i < 45; i++) {
          const x = (random(i + 13) - 0.5) * unit * 2.6;
          const y = ((random(i + 7) + t * 0.09) % 1) * unit * 1.7 - unit * 1.3;
          const p = project(x, y, (random(i + 42) - 0.5) * unit);
          ctx.globalAlpha = 0.45;
          dot(p.x, p.y, 2.2 * p.scale, colors[i % 4]);
        }
        ctx.globalAlpha = 1;
      } else {
        const nodes = Array.from({ length: 5 }, (_, layer) =>
          Array.from(
            { length: layer === 0 || layer === 4 ? 4 : 6 },
            (_, index) => {
              const count = layer === 0 || layer === 4 ? 4 : 6;
              return project(
                (layer - 2) * unit * 0.57,
                (index - (count - 1) / 2) * unit * 0.31,
                Math.sin(index * 1.3 + t * 0.15) * unit * 0.2,
                Math.sin(t * 0.09) * 0.08,
              );
            },
          ),
        );
        nodes.forEach((layer, l) => {
          if (l < nodes.length - 1)
            layer.forEach((p, i) =>
              nodes[l + 1].forEach((q, j) => {
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(q.x, q.y);
                ctx.strokeStyle = `rgba(145,135,255,${0.07 + random(i * 17 + j * 7 + l) * 0.13})`;
                ctx.lineWidth = 0.7;
                ctx.stroke();
                if ((i + j + l) % 3 === 0) {
                  const u = (t * 0.34 - l * 0.2 + i * 0.08 + 10) % 1;
                  const x = p.x + (q.x - p.x) * u;
                  const y = p.y + (q.y - p.y) * u;
                  glow(x, y, 10, "#9984ff", 0.5);
                  dot(x, y, 1.4, "#d9d0ff");
                }
              }),
            );
          layer.forEach((p, i) => {
            const pulse = 0.5 + Math.sin(t * 2 - l * 1.4 + i * 0.6) * 0.5;
            glow(p.x, p.y, 22 + pulse * 7, colors[l % 4], 0.28 + pulse * 0.17);
            dot(p.x, p.y, 5 + pulse, "#b4a1ff");
            dot(p.x - 1, p.y - 1, 2, "#edf0ff");
          });
        });
      }
    };
    redraw.current = active ? null : () => draw();
    const resize = () => {
      // Layout dimensions stay stable while the parent camera scales the canvas.
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.75);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (!active) draw();
    };
    const handlePointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.current.tx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.current.ty = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    };
    const resetPointer = () => {
      pointer.current.tx = 0;
      pointer.current.ty = 0;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    draw();
    canvas.addEventListener("pointermove", handlePointer);
    canvas.addEventListener("pointerleave", resetPointer);
    return () => {
      cancelAnimationFrame(frame);
      redraw.current = null;
      observer.disconnect();
      canvas.removeEventListener("pointermove", handlePointer);
      canvas.removeEventListener("pointerleave", resetPointer);
    };
  }, [active, kind]);

  return (
    <canvas
      ref={canvasRef}
      className="landing-universe-canvas"
      aria-hidden="true"
    />
  );
}
