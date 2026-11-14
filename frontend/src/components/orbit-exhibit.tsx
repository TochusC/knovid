import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import "./orbit-exhibit.css";

interface OrbitExhibitProps {
  active: boolean;
  quiet: boolean;
  onContinue: () => void;
  onDemo: () => void;
}

type Point = { x: number; y: number; z: number };
const TAU = Math.PI * 2;

// Advancing mean anomaly uniformly is equivalent to equal areas in equal time.
function eccentricAnomaly(mean: number, eccentricity: number) {
  let value = mean;
  for (let step = 0; step < 7; step += 1) {
    value -=
      (value - eccentricity * Math.sin(value) - mean) /
      (1 - eccentricity * Math.cos(value));
  }
  return value;
}

function OrbitalModel({
  eccentricity,
  moving,
}: {
  eccentricity: number;
  moving: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const phase = useRef(0.42);
  const near = useRef<HTMLSpanElement>(null);
  const far = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    let frame = 0;
    let previous = 0;
    let width = 0;
    let height = 0;
    let dark = document.documentElement.classList.contains("dark");
    const e = eccentricity;
    const b = Math.sqrt(1 - e * e);
    const rotate = -0.31;
    const tilt = 0.65;

    function draw() {
      if (!context || !width || !height) return;
      context.clearRect(0, 0, width, height);
      const scale = Math.min(width * 0.405, height * 0.49);
      const centerX = width * 0.51;
      const centerY = height * 0.47;
      // Center the ellipse visually; its attracting body stays at a focus.
      const focusX = centerX + e * scale * Math.cos(rotate);
      const focusY = centerY + e * scale * Math.sin(rotate);
      const project = (x: number, y: number): Point => {
        const yTilt = y * tilt;
        return {
          x: focusX + (x * Math.cos(rotate) - yTilt * Math.sin(rotate)) * scale,
          y: focusY + (x * Math.sin(rotate) + yTilt * Math.cos(rotate)) * scale,
          z: y * Math.sqrt(1 - tilt * tilt),
        };
      };
      const at = (angle: number) =>
        project(Math.cos(angle) - e, b * Math.sin(angle));
      const orbit = Array.from({ length: 241 }, (_, i) => at((i / 240) * TAU));
      const strokeOrbit = (front: boolean, shadow = false) => {
        context.lineCap = "round";
        for (let i = 1; i < orbit.length; i += 1) {
          const point = orbit[i];
          if (point.z >= 0 !== front) continue;
          context.beginPath();
          context.moveTo(orbit[i - 1].x, orbit[i - 1].y + (shadow ? 4 : 0));
          context.lineTo(point.x, point.y + (shadow ? 4 : 0));
          context.lineWidth = shadow ? 5 : front ? 3.4 : 2.5;
          context.strokeStyle = shadow
            ? dark
              ? "rgba(2,4,20,.34)"
              : "rgba(85,93,158,.09)"
            : dark
              ? front
                ? "#a4aedf"
                : "#535d91"
              : front
                ? "#b0b9db"
                : "#c5cbe2";
          context.stroke();
        }
      };
      const sphere = (point: Point, radius: number, type: "sun" | "planet") => {
        context.save();
        // The soft contact shadow and directional light share one source.
        const shadow = context.createRadialGradient(
          point.x + radius * 0.22,
          point.y + radius * 0.72,
          0,
          point.x + radius * 0.22,
          point.y + radius * 0.72,
          radius * 1.45,
        );
        shadow.addColorStop(
          0,
          dark ? "rgba(1,2,14,.45)" : "rgba(73,83,148,.18)",
        );
        shadow.addColorStop(1, "rgba(80,90,170,0)");
        context.fillStyle = shadow;
        context.beginPath();
        context.ellipse(
          point.x + radius * 0.22,
          point.y + radius * 0.72,
          radius * 1.45,
          radius * 0.72,
          0.25,
          0,
          TAU,
        );
        context.fill();
        const fill = context.createRadialGradient(
          point.x - radius * 0.39,
          point.y - radius * 0.48,
          radius * 0.03,
          point.x + radius * 0.15,
          point.y + radius * 0.18,
          radius * 1.23,
        );
        if (type === "sun") {
          fill.addColorStop(0, dark ? "#e5e9ff" : "#ffffff");
          fill.addColorStop(0.35, "#c7d4f5");
          fill.addColorStop(0.66, "#94a6dc");
          fill.addColorStop(0.84, "#697eb9");
          fill.addColorStop(1, "#3e508a");
        } else {
          fill.addColorStop(0, "#e3dcff");
          fill.addColorStop(0.25, "#b3a6f0");
          fill.addColorStop(0.58, "#8875d4");
          fill.addColorStop(0.83, "#5c4ba4");
          fill.addColorStop(1, "#38316b");
        }
        context.fillStyle = fill;
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, TAU);
        context.fill();
        context.strokeStyle = dark
          ? "rgba(240,244,255,.25)"
          : "rgba(255,255,255,.65)";
        context.lineWidth = 0.8;
        context.beginPath();
        context.arc(
          point.x,
          point.y,
          radius - 0.4,
          Math.PI * 1.04,
          Math.PI * 1.72,
        );
        context.stroke();
        context.restore();
      };

      // A quiet elliptical glass plane makes the orbital inclination tangible.
      const wash = context.createLinearGradient(
        centerX - scale,
        centerY - scale,
        centerX + scale,
        centerY + scale,
      );
      wash.addColorStop(
        0,
        dark ? "rgba(102,119,184,.015)" : "rgba(191,201,233,.05)",
      );
      wash.addColorStop(
        0.65,
        dark ? "rgba(119,127,196,.045)" : "rgba(190,201,235,.13)",
      );
      wash.addColorStop(
        1,
        dark ? "rgba(160,157,226,.025)" : "rgba(215,213,243,.1)",
      );
      context.beginPath();
      orbit.forEach((point, index) =>
        index
          ? context.lineTo(point.x, point.y)
          : context.moveTo(point.x, point.y),
      );
      context.closePath();
      context.fillStyle = wash;
      context.fill();
      strokeOrbit(false, true);
      strokeOrbit(false);

      const body = at(eccentricAnomaly(phase.current, e));
      // The fading arc is sampled in equal time, so spacing also shows speed.
      for (let step = 23; step > 0; step -= 1) {
        const from = at(eccentricAnomaly(phase.current - step * 0.025, e));
        const to = at(eccentricAnomaly(phase.current - (step - 1) * 0.025, e));
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.lineWidth = 3.5;
        context.strokeStyle = `rgba(${dark ? "182,167,238" : "118,96,190"},${(1 - step / 24) * 0.58})`;
        context.stroke();
      }
      const sun = { x: focusX, y: focusY, z: 0 };
      if (body.z < 0) sphere(body, scale * 0.105, "planet");
      sphere(sun, scale * 0.235, "sun");
      strokeOrbit(true, true);
      strokeOrbit(true);
      if (body.z >= 0) sphere(body, scale * 0.105, "planet");

      const nearPoint = at(0);
      const farPoint = at(Math.PI);
      [nearPoint, farPoint].forEach((point) => {
        context.beginPath();
        context.arc(point.x, point.y, 2.4, 0, TAU);
        context.fillStyle = dark ? "#a6b1db" : "#919fc5";
        context.fill();
      });
      if (near.current) {
        near.current.style.left = `${nearPoint.x}px`;
        near.current.style.top = `${nearPoint.y + 20}px`;
      }
      if (far.current) {
        far.current.style.left = `${farPoint.x}px`;
        far.current.style.top = `${farPoint.y + 20}px`;
      }
    }
    const tick = (now: number) => {
      frame = 0;
      if (previous && now - previous < 32) {
        if (moving) frame = requestAnimationFrame(tick);
        return;
      }
      if (previous && moving)
        phase.current =
          (phase.current + Math.min(now - previous, 70) * 0.00029) % TAU;
      previous = now;
      draw();
      if (moving) frame = requestAnimationFrame(tick);
    };
    const resize = () => {
      // Use layout dimensions: the enclosing scene scales while travelling.
      width = element.clientWidth;
      height = element.clientHeight;
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      element.width = Math.round(width * dpr);
      element.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const theme = new MutationObserver(() => {
      dark = document.documentElement.classList.contains("dark");
      draw();
    });
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    resize();
    if (moving) frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      theme.disconnect();
    };
  }, [eccentricity, moving]);

  return (
    <div
      className="orbit-model"
      role="img"
      aria-label={
        eccentricity
          ? "中心天体位于椭圆轨道的一个焦点，行星近处移动更快、远处移动更慢的立体模型"
          : "行星沿圆轨道匀速运行的立体模型"
      }
    >
      <canvas ref={canvas} aria-hidden="true" />
      <span
        ref={near}
        className="orbit-extreme orbit-extreme-near"
        aria-hidden="true"
      >
        {eccentricity ? "近 · 更快" : "等距"}
      </span>
      <span
        ref={far}
        className="orbit-extreme orbit-extreme-far"
        aria-hidden="true"
      >
        {eccentricity ? "远 · 更慢" : "等速"}
      </span>
    </div>
  );
}

export function OrbitExhibit({
  active,
  quiet,
  onContinue,
  onDemo,
}: OrbitExhibitProps) {
  const [elliptical, setElliptical] = useState(true);
  return (
    <div className="orbit-exhibit">
      <div className="orbit-story">
        <span className="orbit-eyebrow">
          02 <i /> 让规律，有迹可循
        </span>
        <h2 id="landing-chapter-1">
          行星的速度，
          <br />
          <span>谁说了算。</span>
        </h2>
        <p className="orbit-intro">
          沿一条椭圆轨道，
          <br />
          看见距离与速度的关系。
        </p>
        <div
          className="orbit-options"
          role="group"
          aria-label="选择行星轨道形状"
        >
          <button
            type="button"
            aria-pressed={!elliptical}
            onClick={() => setElliptical(false)}
          >
            <i className="orbit-option-circle" />
            圆轨道
          </button>
          <button
            type="button"
            aria-pressed={elliptical}
            onClick={() => setElliptical(true)}
          >
            <i className="orbit-option-ellipse" />
            椭圆轨道
          </button>
        </div>
        <div className="orbit-observation" aria-live="polite">
          <span>
            {elliptical ? "靠近时快，远离时慢。" : "距离不变，速度也不变。"}
          </span>
          <p>
            {elliptical
              ? "引力，让一圈旅程有了不同的节奏。"
              : "圆，是椭圆的一种特别模样。"}
          </p>
        </div>
        <div className="orbit-story-actions">
          <button type="button" className="orbit-watch" onClick={onDemo}>
            <Play size={10} fill="currentColor" /> 看一支样片
          </button>
          <Button
            variant="ghost"
            className="orbit-continue"
            onClick={onContinue}
          >
            下一站，神经网络 <ArrowUpRight size={14} />
          </Button>
        </div>
      </div>
      <div className="orbit-display">
        <div className="orbit-display-caption">
          <span>一条轨道，无数次靠近。</span>
          <i>e = {elliptical ? "0.55" : "0"}</i>
        </div>
        <OrbitalModel
          eccentricity={elliptical ? 0.55 : 0}
          moving={active && !quiet}
        />
        <p className="orbit-model-note">
          理想两体轨道示意 · 天体大小与距离非同比例
        </p>
      </div>
    </div>
  );
}
