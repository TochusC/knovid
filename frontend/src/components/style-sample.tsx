import { useEffect, useRef } from "react";
import type { BuiltinStyleId } from "@/lib/builtin-styles";

type Context = CanvasRenderingContext2D;
type Point = readonly [number, number];
type Orbit = readonly [number, number, number, number, number];

const width = 640;
const height = 360;
const turn = Math.PI * 2;

function orbitPoint([x, y, major, minor, rotation]: Orbit, angle: number): Point {
  const dx = major * Math.cos(angle);
  const dy = minor * Math.sin(angle);
  return [x + dx * Math.cos(rotation) - dy * Math.sin(rotation), y + dx * Math.sin(rotation) + dy * Math.cos(rotation)];
}

function orbitFocus([x, y, major, minor, rotation]: Orbit): Point {
  const distance = Math.sqrt(major * major - minor * minor);
  return [x - distance * Math.cos(rotation), y - distance * Math.sin(rotation)];
}

function ellipse(ctx: Context, orbit: Orbit, color: string, weight = 1, start = 0, end = turn) {
  ctx.beginPath();
  ctx.ellipse(...orbit, start, end);
  ctx.lineWidth = weight;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function line(ctx: Context, points: readonly Point[], color: string, weight = 1) {
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (const point of points.slice(1)) ctx.lineTo(...point);
  ctx.lineWidth = weight;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function dot(ctx: Context, [x, y]: Point, radius: number, fill: string | CanvasGradient) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, turn);
  ctx.fillStyle = fill;
  ctx.fill();
}

function sphere(ctx: Context, point: Point, radius: number, light: string, shade: string) {
  const [x, y] = point;
  const pigment = ctx.createRadialGradient(x - radius * 0.32, y - radius * 0.4, 1, x, y, radius);
  pigment.addColorStop(0, light);
  pigment.addColorStop(1, shade);
  dot(ctx, point, radius, pigment);
}

function grid(ctx: Context, spacing: number, color: string, x = 0, y = 0, w = width, h = height) {
  ctx.beginPath();
  for (let gx = x; gx <= x + w; gx += spacing) {
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + h);
  }
  for (let gy = y; gy <= y + h; gy += spacing) {
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function violet(ctx: Context, phase: number) {
  const backdrop = ctx.createLinearGradient(0, 0, width, height);
  backdrop.addColorStop(0, "#fbfbff");
  backdrop.addColorStop(1, "#e5e3ff");
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, width, height);
  const orbit: Orbit = [315, 182, 206, 99, -0.27];
  const body = orbitPoint(orbit, phase);
  const sun = orbitFocus(orbit);
  ellipse(ctx, [315, 182, 259, 122, -0.27], "#d3d4f5", 1.3);
  ellipse(ctx, orbit, "#a9a6ee", 2);
  ellipse(ctx, orbit, "#7361e7", 4, phase - 1.33, phase);
  const glow = ctx.createRadialGradient(...sun, 4, ...sun, 95);
  glow.addColorStop(0, "#9ba2fa66");
  glow.addColorStop(1, "#b6beff00");
  dot(ctx, sun, 95, glow);
  sphere(ctx, sun, 48, "#fffaff", "#8c85ed");
  dot(ctx, body, 32, "#b1a8ff45");
  sphere(ctx, body, 19, "#bab6ff", "#4c40cb");
  for (const point of [[102, 84], [516, 249], [535, 89], [134, 280], [95, 210], [461, 66]] as const) {
    dot(ctx, point, 3, "#8b80e9");
    dot(ctx, point, 9, "#8b80e928");
  }
}

function paperDiagram(ctx: Context, phase: number) {
  ctx.fillStyle = "#faf9f5";
  ctx.fillRect(0, 0, width, height);
  grid(ctx, 26, "#e7e8e0", 52, 48, 525, 260);
  line(ctx, [[52, 192], [579, 192]], "#919b94");
  line(ctx, [[269, 48], [269, 308]], "#919b94");
  const orbit: Orbit = [275, 177, 177, 98, -0.13];
  const body = orbitPoint(orbit, phase);
  const focus = orbitFocus(orbit);
  ellipse(ctx, orbit, "#293c39", 2.3);
  ellipse(ctx, orbit, "#157067", 4, phase - 1.15, phase);
  ctx.setLineDash([4, 5]);
  line(ctx, [focus, body], "#5c847d", 1.5);
  ctx.setLineDash([]);
  dot(ctx, focus, 7, "#233932");
  dot(ctx, body, 12, "#157067");
  line(ctx, [body, [478, 236], [564, 236]], "#737e73", 1.2);
  line(ctx, [focus, [118, 240], [80, 240]], "#737e73", 1.2);
  ctx.fillStyle = "#273e38";
  ctx.font = "15px sans-serif";
  ctx.fillText("行星", 521, 225);
  ctx.fillText("焦点", 78, 261);
}

function blueprint(ctx: Context, phase: number) {
  ctx.fillStyle = "#10263b";
  ctx.fillRect(0, 0, width, height);
  grid(ctx, 20, "#8dd9fb26");
  grid(ctx, 100, "#8dd9fb40");
  ctx.strokeStyle = "#a7eafd85";
  ctx.strokeRect(20, 20, 600, 320);
  const orbit: Orbit = [318, 167, 215, 106, 0];
  const body = orbitPoint(orbit, phase);
  const focus = orbitFocus(orbit);
  ctx.setLineDash([6, 7]);
  line(ctx, [[70, 167], [568, 167]], "#c2f5fe92");
  line(ctx, [[318, 43], [318, 298]], "#c2f5fe92");
  line(ctx, [focus, body], "#a0ebfe9c", 1.5);
  ellipse(ctx, [318, 167, 232, 122, 0], "#a0ebfe60");
  ctx.setLineDash([]);
  ellipse(ctx, orbit, "#53d7f5", 2.5);
  ellipse(ctx, orbit, "#e5ffff", 4.5, phase - 0.93, phase);
  for (const point of [focus, body]) {
    const [x, y] = point;
    ellipse(ctx, [x, y, 16, 16, 0], "#a8f1ff", 1.1);
    dot(ctx, point, 5, "#e4fdff");
  }
  line(ctx, [[103, 286], [103, 312], [533, 312], [533, 286]], "#a0ebfe9c", 1.2);
  line(ctx, [[111, 305], [103, 312], [111, 319]], "#a0ebfe9c");
  line(ctx, [[525, 305], [533, 312], [525, 319]], "#a0ebfe9c");
}

function warmStory(ctx: Context, phase: number) {
  ctx.fillStyle = "#faedda";
  ctx.fillRect(0, 0, width, height);
  for (let index = 0; index < 1150; index++) {
    const x = (index * 173.173) % width;
    const y = (index * index * 1.1667) % height;
    ctx.fillStyle = index % 2 ? "#af65381a" : "#fff9ec70";
    ctx.fillRect(x, y, 2, 1.1);
  }
  const orbit: Orbit = [314, 175, 209, 104, -0.21];
  const body = orbitPoint(orbit, phase);
  const sun = orbitFocus(orbit);
  const ink = "#8b492d";
  ctx.setLineDash([11, 9]);
  ellipse(ctx, orbit, ink, 2.3);
  ctx.setLineDash([]);
  ellipse(ctx, [311, 177, 213, 108, -0.21], "#b0745254", 2);
  ellipse(ctx, orbit, "#ae4933", 4.3, phase - 1.02, phase);
  sphere(ctx, sun, 41, "#ffd987", "#e69747");
  ellipse(ctx, [...sun, 41, 42, -0.21], ink, 2.1);
  for (let ray = 0; ray < 10; ray++) {
    const angle = ray * turn / 10;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    line(ctx, [[sun[0] + x * 51, sun[1] + y * 51], [sun[0] + x * 60, sun[1] + y * 60]], ink, 2);
  }
  sphere(ctx, body, 19, "#f89c70", "#b84938");
  ellipse(ctx, [...body, 18, 20, -0.18], "#783b2e", 1.8);
}

function geometry(ctx: Context, phase: number) {
  ctx.fillStyle = "#fff1c3";
  ctx.fillRect(0, 0, width, height);
  dot(ctx, [30, 390], 176, "#e85537");
  dot(ctx, [635, 6], 142, "#303bc2");
  ctx.fillStyle = "#28262a";
  ctx.fillRect(0, 32, 120, 12);
  ctx.fillRect(520, 312, 120, 12);
  const orbit: Orbit = [323, 185, 208, 100, -0.33];
  const body = orbitPoint(orbit, phase);
  const sun = orbitFocus(orbit);
  ellipse(ctx, orbit, "#24242c", 6);
  ellipse(ctx, orbit, "#303bc2", 11, phase - 1.26, phase);
  dot(ctx, [sun[0] + 7, sun[1] + 7], 57, "#25232b");
  dot(ctx, sun, 57, "#e85537");
  ellipse(ctx, [...sun, 57, 57, 0], "#25232b", 4);
  dot(ctx, [body[0] + 5, body[1] + 5], 23, "#24242c");
  dot(ctx, body, 23, "#303bc2");
  ellipse(ctx, [...body, 23, 23, 0], "#24242c", 3.5);
}

const illustrations = {
  default: violet,
  "paper-diagram": paperDiagram,
  blueprint,
  "warm-story": warmStory,
  "bold-geometry": geometry,
} satisfies Record<BuiltinStyleId, (ctx: Context, phase: number) => void>;

export function StyleSample({ style, playing, onEnd }: {
  style: BuiltinStyleId;
  playing: boolean;
  onEnd: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const draw = illustrations[style];
    const initialPhase = 0.72;
    draw(context, initialPhase);
    if (!playing) return;
    let frame = 0;
    const started = performance.now();
    const animate = (now: number) => {
      const progress = Math.min(1, (now - started) / 5000);
      draw(context, initialPhase + progress * turn);
      if (progress < 1) frame = requestAnimationFrame(animate);
      else onEnd();
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [style, playing, onEnd]);

  return <canvas ref={canvas} width={width} height={height} aria-hidden="true" />;
}
