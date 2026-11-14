import { useEffect, useRef } from "react";

type ArtworkKind = "orbit" | "probability" | "neural";

interface KnowledgeArtworkProps {
  kind: ArtworkKind;
  animated?: boolean;
  className?: string;
}

type Point = { x: number; y: number };

interface ArtworkPalette {
  background: Record<ArtworkKind, string>;
  grid: string;
  line: string;
  mutedLine: string;
  primary: string;
  primarySoft: string;
  primaryHighlight: string;
  secondary: string;
  secondarySoft: string;
  secondaryHighlight: string;
  tertiary: string;
  foreground: string;
  surface: string;
  surfaceBorder: string;
  depth: string;
  side: string;
  bright: string;
}

const palettes: Record<"light" | "dark", ArtworkPalette> = {
  light: {
    background: { orbit: "#ebeefe", probability: "#e8f0fb", neural: "#eeeafa" },
    grid: "#bac5e8",
    line: "#7e8dbb",
    mutedLine: "#bdc7e7",
    primary: "#7965d6",
    primarySoft: "#d3cdf5",
    primaryHighlight: "#ae9ff0",
    secondary: "#5688b5",
    secondarySoft: "#b0c5e4",
    secondaryHighlight: "#a3d3e7",
    tertiary: "#769bc5",
    foreground: "#435d94",
    surface: "#fcfdff",
    surfaceBorder: "#c8d3ee",
    depth: "#879ec8",
    side: "#becdec",
    bright: "#fbfcff",
  },
  dark: {
    background: { orbit: "#171e38", probability: "#16263b", neural: "#221e3b" },
    grid: "#3d4b73",
    line: "#7588bd",
    mutedLine: "#3c486d",
    primary: "#a48af1",
    primarySoft: "#40365f",
    primaryHighlight: "#cbb9ff",
    secondary: "#709fcf",
    secondarySoft: "#405b82",
    secondaryHighlight: "#a9dce9",
    tertiary: "#75bccd",
    foreground: "#a8bce9",
    surface: "#2c3d59",
    surfaceBorder: "#6379a2",
    depth: "#142136",
    side: "#415679",
    bright: "#edf5ff",
  },
};

const descriptions: Record<ArtworkKind, string> = {
  orbit: "太阳与沿椭圆轨道运行的行星插画",
  probability: "骰子与钟形概率分布插画",
  neural: "信号在多层神经网络节点间流动的插画",
};

function circle(context: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
}

function dotGrid(context: CanvasRenderingContext2D, x: number, y: number, color: string) {
  context.fillStyle = color;
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      circle(context, x + column * 12, y + row * 12, 1);
      context.fill();
    }
  }
}

function drawOrbit(context: CanvasRenderingContext2D, time: number, palette: ArtworkPalette) {
  context.fillStyle = palette.background.orbit;
  context.fillRect(0, 0, 640, 360);
  dotGrid(context, 52, 267, palette.grid);
  dotGrid(context, 538, 40, palette.grid);

  context.save();
  context.translate(332, 180);
  context.rotate(-0.28);
  const orbits = [{ x: 111, y: 66 }, { x: 185, y: 105 }, { x: 253, y: 141 }];
  for (const [index, orbit] of orbits.entries()) {
    context.beginPath();
    context.ellipse(0, 0, orbit.x, orbit.y, 0, 0, Math.PI * 2);
    context.lineWidth = index === 1 ? 1.6 : 1;
    context.strokeStyle = index === 1 ? palette.line : palette.mutedLine;
    context.stroke();
  }

  context.save();
  context.setLineDash([3, 8]);
  context.strokeStyle = palette.line;
  context.beginPath();
  context.ellipse(0, 0, 198, 117, 0, 0.13, Math.PI * 0.9);
  context.stroke();
  context.restore();

  context.fillStyle = palette.primarySoft;
  circle(context, -38, 0, 44);
  context.fill();
  context.fillStyle = palette.primary;
  circle(context, -38, 0, 32);
  context.fill();
  context.fillStyle = palette.primaryHighlight;
  circle(context, -46, -9, 17);
  context.fill();

  const angle = -0.7 + time * 0.25;
  const earth = { x: Math.cos(angle) * 185, y: Math.sin(angle) * 105 };
  context.strokeStyle = palette.mutedLine;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(-38, 0);
  context.lineTo(earth.x, earth.y);
  context.stroke();
  context.fillStyle = palette.secondary;
  circle(context, earth.x, earth.y, 14);
  context.fill();
  context.fillStyle = palette.secondaryHighlight;
  circle(context, earth.x - 4, earth.y - 4, 7);
  context.fill();
  context.strokeStyle = palette.secondary;
  circle(context, earth.x, earth.y, 21);
  context.stroke();

  const innerAngle = 2.3 + time * 0.38;
  context.fillStyle = palette.primaryHighlight;
  circle(context, Math.cos(innerAngle) * 111, Math.sin(innerAngle) * 66, 6);
  context.fill();
  const outerAngle = 2.7 + time * 0.15;
  context.fillStyle = palette.tertiary;
  circle(context, Math.cos(outerAngle) * 253, Math.sin(outerAngle) * 141, 9);
  context.fill();
  context.restore();
}

function drawDie(context: CanvasRenderingContext2D, x: number, y: number, rotation: number, pips: Point[], palette: ArtworkPalette) {
  context.save();
  context.translate(x, y);
  context.rotate(rotation);
  context.fillStyle = palette.depth;
  context.beginPath();
  context.moveTo(-36, 31);
  context.lineTo(-23, 44);
  context.lineTo(41, 44);
  context.lineTo(31, 31);
  context.closePath();
  context.fill();
  context.fillStyle = palette.side;
  context.beginPath();
  context.moveTo(31, -36);
  context.lineTo(44, -23);
  context.lineTo(44, 38);
  context.quadraticCurveTo(44, 44, 38, 44);
  context.lineTo(31, 31);
  context.closePath();
  context.fill();
  context.fillStyle = palette.surface;
  context.beginPath();
  context.roundRect(-36, -36, 72, 72, 12);
  context.fill();
  context.strokeStyle = palette.surfaceBorder;
  context.lineWidth = 1;
  context.stroke();
  context.fillStyle = palette.foreground;
  for (const pip of pips) {
    circle(context, pip.x, pip.y, 4.5);
    context.fill();
  }
  context.restore();
}

function drawProbability(context: CanvasRenderingContext2D, time: number, palette: ArtworkPalette) {
  context.fillStyle = palette.background.probability;
  context.fillRect(0, 0, 640, 360);
  dotGrid(context, 535, 263, palette.grid);
  const baseline = 274;

  context.strokeStyle = palette.mutedLine;
  context.lineWidth = 1;
  for (let row = 0; row < 4; row += 1) {
    context.beginPath();
    context.moveTo(212, baseline - row * 47);
    context.lineTo(548, baseline - row * 47);
    context.stroke();
  }

  for (let index = 0; index < 13; index += 1) {
    const distance = (index - 6) / 2.5;
    const height = Math.exp(-distance * distance / 2) * 168;
    const movement = Math.sin(time * 1.2 + index * 0.3) * 2;
    context.fillStyle = index === 6 ? palette.primary : index > 3 && index < 9 ? palette.secondary : palette.secondarySoft;
    context.beginPath();
    context.roundRect(218 + index * 24, baseline - height + movement, 16, height - movement, [4, 4, 0, 0]);
    context.fill();
  }

  context.beginPath();
  for (let step = 0; step <= 100; step += 1) {
    const x = 206 + step * 3.35;
    const distance = (x - 371) / 64;
    const y = baseline - 184 * Math.exp(-distance * distance / 2);
    if (step === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.strokeStyle = palette.foreground;
  context.lineWidth = 2;
  context.stroke();

  const floating = Math.sin(time * 0.9) * 4;
  drawDie(context, 130, 153 + floating, -0.2 + Math.sin(time * 0.5) * 0.025, [
    { x: -15, y: -15 }, { x: 15, y: -15 }, { x: 0, y: 0 }, { x: -15, y: 15 }, { x: 15, y: 15 },
  ], palette);
  drawDie(context, 185, 230 - floating, 0.19, [
    { x: -15, y: -15 }, { x: 15, y: 15 }, { x: 0, y: 0 },
  ], palette);

  context.fillStyle = palette.primary;
  circle(context, 532, 81, 11);
  context.fill();
  context.strokeStyle = palette.line;
  circle(context, 532, 81, 21);
  context.stroke();
}

function drawNeural(context: CanvasRenderingContext2D, time: number, palette: ArtworkPalette) {
  context.fillStyle = palette.background.neural;
  context.fillRect(0, 0, 640, 360);
  dotGrid(context, 51, 269, palette.grid);

  const layers: Point[][] = [
    [{ x: 124, y: 106 }, { x: 124, y: 180 }, { x: 124, y: 254 }],
    [{ x: 260, y: 70 }, { x: 260, y: 143 }, { x: 260, y: 217 }, { x: 260, y: 290 }],
    [{ x: 395, y: 106 }, { x: 395, y: 180 }, { x: 395, y: 254 }],
    [{ x: 524, y: 180 }],
  ];

  context.strokeStyle = palette.mutedLine;
  context.lineWidth = 1.2;
  for (let layer = 0; layer < layers.length - 1; layer += 1) {
    for (const start of layers[layer]) {
      for (const end of layers[layer + 1]) {
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }
    }
  }

  const path = [layers[0][1], layers[1][1], layers[2][1], layers[3][0]];
  context.beginPath();
  context.moveTo(path[0].x, path[0].y);
  for (const point of path.slice(1)) context.lineTo(point.x, point.y);
  context.strokeStyle = palette.line;
  context.lineWidth = 2;
  context.stroke();

  for (const [layerIndex, layer] of layers.entries()) {
    for (const [nodeIndex, point] of layer.entries()) {
      const active = nodeIndex === 1 || layerIndex === 3;
      context.fillStyle = layerIndex === 3 ? palette.primary : active ? palette.secondary : palette.surface;
      context.strokeStyle = layerIndex === 3 ? palette.primaryHighlight : palette.line;
      context.lineWidth = 1.5;
      circle(context, point.x, point.y, layerIndex === 3 ? 22 : 13);
      context.fill();
      context.stroke();
      if (active) {
        context.fillStyle = palette.bright;
        circle(context, point.x, point.y, layerIndex === 3 ? 5 : 3);
        context.fill();
      }
    }
  }

  context.strokeStyle = palette.line;
  context.lineWidth = 1;
  circle(context, 524, 180, 34 + Math.sin(time * 1.1) * 3);
  context.stroke();

  const progress = (0.34 + time * 0.4) % 3;
  const segment = Math.floor(progress);
  const fraction = progress - segment;
  const start = path[segment];
  const end = path[segment + 1];
  context.fillStyle = palette.primaryHighlight;
  circle(context, start.x + (end.x - start.x) * fraction, start.y + (end.y - start.y) * fraction, 4);
  context.fill();
}

const painters: Record<ArtworkKind, (context: CanvasRenderingContext2D, time: number, palette: ArtworkPalette) => void> = {
  orbit: drawOrbit,
  probability: drawProbability,
  neural: drawNeural,
};

export function KnowledgeArtwork({ kind, animated = false, className }: KnowledgeArtworkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const root = document.documentElement;
    const currentPalette = () => palettes[root.classList.contains("dark") || root.dataset.theme === "dark" ? "dark" : "light"];
    let palette = currentPalette();
    let animationFrame = 0;
    let time = 0;

    const draw = () => {
      context.setTransform(canvas.width / 640, 0, 0, canvas.height / 360, 0, 0);
      painters[kind](context, time, palette);
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      draw();
    };

    const startAnimation = () => {
      window.cancelAnimationFrame(animationFrame);
      time = 0;
      draw();
      if (!animated || motionPreference.matches) return;
      const startedAt = performance.now();
      const tick = (now: number) => {
        time = (now - startedAt) / 1000;
        draw();
        animationFrame = window.requestAnimationFrame(tick);
      };
      animationFrame = window.requestAnimationFrame(tick);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const themeObserver = new MutationObserver(() => {
      palette = currentPalette();
      draw();
    });
    themeObserver.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
    motionPreference.addEventListener("change", startAnimation);
    resize();
    startAnimation();

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      motionPreference.removeEventListener("change", startAnimation);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [kind, animated]);

  return (
    <canvas
      ref={canvasRef}
      width={640}
      height={360}
      className={className}
      role="img"
      aria-label={descriptions[kind]}
      style={{ display: "block", width: "100%", height: "100%", aspectRatio: "16 / 9" }}
    />
  );
}
