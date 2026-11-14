import { useEffect, useRef, useState } from "react";
import type { MotionValue } from "motion/react";
import "./kinetic-sculpture.css";

interface KineticSculptureProps {
  progress: MotionValue<number>;
  active: boolean;
  quiet: boolean;
}
type Vec3 = [number, number, number];
type Point2 = [number, number];
const CAMERA = 7;
// The real favicon's width, spacing and descending heights: 13 / 18 / 48:32:20.
const bars = [
  { x: -0.9, height: 2.4 },
  { x: 0, height: 1.6 },
  { x: 0.9, height: 1.0 },
];
const BAR_WIDTH = 0.65;
const CORNER = 0.17;
const HALF_DEPTH = 0.15;
const BEVEL = 0.045;
function barDrift(index: number, time: number): Vec3 {
  return [
    0,
    (Math.sin(time * 0.52 + index * 0.85) - Math.sin(index * 0.85)) * 0.009,
    (Math.sin(time * 0.43 + index * 1.1) - Math.sin(index * 1.1)) * 0.014,
  ];
}
function outline(
  index: number,
  inset = 0,
): { point: Point2; normal: Point2 }[] {
  const halfWidth = BAR_WIDTH / 2,
    halfHeight = bars[index].height / 2;
  const result: { point: Point2; normal: Point2 }[] = [];
  for (let corner = 0; corner < 4; corner++) {
    const cx = (corner < 2 ? 1 : -1) * (halfWidth - CORNER);
    const cy = (corner === 0 || corner === 3 ? -1 : 1) * (halfHeight - CORNER);
    for (let step = 0; step <= 16; step++) {
      const angle =
        -Math.PI / 2 + (corner * Math.PI) / 2 + ((step / 16) * Math.PI) / 2;
      const nx = Math.cos(angle),
        ny = Math.sin(angle);
      result.push({
        point: [
          bars[index].x + cx + (CORNER - inset) * nx,
          cy + (CORNER - inset) * ny,
        ],
        normal: [nx, ny],
      });
    }
  }
  return result;
}
function makeBrand() {
  const vertices: number[] = [],
    indices: number[] = [],
    samples: { point: Vec3; bar: number }[] = [];
  function vertex(point: Vec3, normal: Vec3, bar: number) {
    const index = vertices.length / 8;
    vertices.push(...point, ...normal, bar, point[1] / bars[bar].height + 0.5);
    samples.push({ point, bar });
    return index;
  }
  for (let bar = 0; bar < 3; bar++) {
    const rings: number[][] = [];
    for (const end of [-1, 1])
      for (let step = 0; step <= 6; step++) {
        const angle =
          end < 0
            ? -Math.PI / 2 + ((step / 6) * Math.PI) / 2
            : ((step / 6) * Math.PI) / 2;
        const z = end * (HALF_DEPTH - BEVEL) + BEVEL * Math.sin(angle);
        const inset = BEVEL * (1 - Math.cos(angle));
        const ring = outline(bar, inset).map(({ point, normal }) =>
          vertex(
            [point[0], point[1], z],
            [
              normal[0] * Math.cos(angle),
              normal[1] * Math.cos(angle),
              Math.sin(angle),
            ],
            bar,
          ),
        );
        rings.push(ring);
      }
    for (let ring = 0; ring < rings.length - 1; ring++)
      for (let i = 0; i < rings[ring].length; i++) {
        const next = (i + 1) % rings[ring].length;
        const a = rings[ring][i],
          b = rings[ring][next],
          c = rings[ring + 1][next],
          d = rings[ring + 1][i];
        indices.push(a, b, c, a, c, d);
      }
    for (const end of [-1, 1]) {
      const ring = end < 0 ? rings[0] : rings[rings.length - 1];
      const centre = vertex(
        [bars[bar].x, 0, end * HALF_DEPTH],
        [0, 0, end],
        bar,
      );
      for (let i = 0; i < ring.length; i++)
        indices.push(centre, ring[i], ring[(i + 1) % ring.length]);
    }
  }
  return {
    vertices: new Float32Array(vertices),
    indices: new Uint16Array(indices),
    samples,
  };
}
const brand = makeBrand();
const vertexSource = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute float aBar;
attribute float aTone;
uniform mat3 uRotation;
uniform vec2 uResolution;
uniform vec2 uOffset;
uniform float uScale;
uniform float uTime;
varying vec3 vPosition;
varying vec3 vNormal;
varying float vFront;
varying float vTone;
varying float vBar;
void main(){
  vec3 drift=vec3(0.0,(sin(uTime*.52+aBar*.85)-sin(aBar*.85))*.009,(sin(uTime*.43+aBar*1.1)-sin(aBar*1.1))*.014);
  vec3 p=uRotation*(aPosition+drift);
  vPosition=p;vNormal=uRotation*aNormal;vFront=abs(aNormal.z);vTone=aTone;vBar=aBar;
  float w=7.0-p.z;
  vec2 xy=uOffset*w+vec2(p.x,-p.y)*(14.0*uScale/uResolution);
  gl_Position=vec4(xy,(15.0/13.0)*w-(28.0/13.0),w);
}`;
const fragmentSource = `
precision highp float;
varying vec3 vPosition;
varying vec3 vNormal;
varying float vFront;
varying float vTone;
varying float vBar;
uniform float uOpacity;
uniform float uDark;
void main(){
  vec3 view=normalize(vec3(0.0,0.0,7.0)-vPosition);
  vec3 n=normalize(vNormal);
  if(dot(n,view)<0.0)n=-n;
  vec3 key=normalize(vec3(-.65,-.85,1.5));
  vec3 fill=normalize(vec3(.95,.3,.6));
  float diffuse=max(dot(n,key),0.0),bounce=max(dot(n,fill),0.0);
  float studio=pow(max(dot(n,normalize(view+key)),0.0),18.0);
  float edge=pow(max(dot(n,normalize(view+fill)),0.0),34.0);
  vec3 blue=vec3(.045,.105,.56),violet=vec3(.27,.09,.51);
  vec3 pigment=mix(blue,violet,clamp(vTone*.52+vBar*.18,0.0,1.0));
  pigment=mix(pigment,vec3(.52,.48,.78),vBar*.07);
  float face=smoothstep(.12,.92,vFront);
  vec3 color=pigment*(.35+.61*diffuse+.18*bounce)*mix(.63,1.0,face);
  color+=vec3(.72,.77,.96)*studio*.22;
  color+=vec3(.68,.65,.93)*edge*.19;
  color*=1.0+uDark*.10;
  color=pow(clamp(color,0.0,1.0),vec3(.4545));
  gl_FragColor=vec4(color*uOpacity,uOpacity);
}`;
function rotation(x: number, y: number, z: number) {
  const sx = Math.sin(x),
    cx = Math.cos(x),
    sy = Math.sin(y),
    cy = Math.cos(y),
    sz = Math.sin(z),
    cz = Math.cos(z);
  return new Float32Array([
    cy * cz,
    cy * sz,
    -sy,
    sx * sy * cz - cx * sz,
    sx * sy * sz + cx * cz,
    sx * cy,
    cx * sy * cz + sx * sz,
    cx * sy * sz - sx * cz,
    cx * cy,
  ]);
}
function rotated(matrix: Float32Array, p: Vec3): Vec3 {
  return [
    matrix[0] * p[0] + matrix[3] * p[1] + matrix[6] * p[2],
    matrix[1] * p[0] + matrix[4] * p[1] + matrix[7] * p[2],
    matrix[2] * p[0] + matrix[5] * p[1] + matrix[8] * p[2],
  ];
}

export function KineticSculpture({
  progress,
  active,
  quiet,
}: KineticSculptureProps) {
  const canvas = useRef<HTMLCanvasElement>(null),
    shadow = useRef<HTMLDivElement>(null);
  const vector = useRef<SVGSVGElement>(null);
  const [fallback, setFallback] = useState(false),
    [epoch, setEpoch] = useState(0);
  const state = useRef({ active, quiet });
  state.current = { active, quiet };
  const clock = useRef(0),
    schedule = useRef<() => void>(() => undefined);
  useEffect(() => {
    schedule.current();
  }, [active, quiet, fallback]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const gl = element.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: "low-power",
    });
    let program: WebGLProgram | null = null,
      vertexBuffer: WebGLBuffer | null = null,
      indexBuffer: WebGLBuffer | null = null;
    const shaders: WebGLShader[] = [];
    let ready = false;
    if (gl)
      try {
        const compile = (source: string, type: number) => {
          const shader = gl.createShader(type);
          if (!shader) throw new Error("No shader");
          shaders.push(shader);
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw new Error("Shader compilation failed");
          return shader;
        };
        program = gl.createProgram();
        if (!program) throw new Error("No program");
        gl.attachShader(program, compile(vertexSource, gl.VERTEX_SHADER));
        gl.attachShader(program, compile(fragmentSource, gl.FRAGMENT_SHADER));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
          throw new Error("Shader link failed");
        gl.useProgram(program);
        vertexBuffer = gl.createBuffer();
        indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, brand.vertices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, brand.indices, gl.STATIC_DRAW);
        for (const [name, size, offset] of [
          ["aPosition", 3, 0],
          ["aNormal", 3, 12],
          ["aBar", 1, 24],
          ["aTone", 1, 28],
        ] as const) {
          const at = gl.getAttribLocation(program, name);
          gl.enableVertexAttribArray(at);
          gl.vertexAttribPointer(at, size, gl.FLOAT, false, 32, offset);
        }
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0, 0, 0, 0);
        ready = true;
      } catch {
        ready = false;
      }
    setFallback(!ready);
    element.dataset.renderer = ready ? "webgl-logo" : "svg-logo";
    const location = (name: string) =>
      gl && program && ready ? gl.getUniformLocation(program, name) : null;
    const uniforms = {
      rotation: location("uRotation"),
      resolution: location("uResolution"),
      offset: location("uOffset"),
      scale: location("uScale"),
      time: location("uTime"),
      opacity: location("uOpacity"),
      dark: location("uDark"),
    };
    let width = 0,
      height = 0,
      frame = 0,
      last = 0,
      wasRunning = false;
    let dark = document.documentElement.classList.contains("dark");
    let px = 0,
      py = 0,
      aimX = 0,
      aimY = 0;
    const render = () => {
      if (!width || !height) return;
      const p = progress.get(),
        fade = Math.max(0, Math.min(1, (0.4 - p) / 0.12));
      if (gl && ready) gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const landscape = width > height && height < 601,
        mobile = width < 701 && !landscape;
      const bounds = mobile
        ? [
            width * 0.1,
            width * 0.9,
            Math.max(height * 0.32, height * 0.195 + width * 0.192 + 12),
            height * 0.575,
          ]
        : landscape
          ? [width * 0.64, width * 0.94, height * 0.23, height * 0.8]
          : [width * 0.61, width * 0.97, height * 0.2, height * 0.84];
      const cx = (bounds[0] + bounds[1]) / 2,
        cy = (bounds[2] + bounds[3]) / 2 + Math.sin(clock.current * 0.45) * 3;
      const zoom = state.current.quiet
        ? 1
        : 1 + Math.max(0, p - 0.07) ** 2 * 46;
      if (state.current.active && !state.current.quiet) {
        px += (aimX - px) * 0.05;
        py += (aimY - py) * 0.05;
      }
      const t = clock.current;
      const matrix = rotation(
        -0.16 + py * 0.025 + Math.sin(t * 0.18) * 0.012,
        -0.32 + px * 0.03 + Math.sin(t * 0.15) * 0.018,
        -Math.PI / 18 + Math.sin(t * 0.13) * 0.008,
      );
      let left = Infinity,
        right = -Infinity,
        top = Infinity,
        bottom = -Infinity;
      for (const sample of brand.samples) {
        const drift = barDrift(sample.bar, t);
        const point = sample.point.map(
          (value, axis) => value + drift[axis],
        ) as Vec3;
        const [x, y, z] = rotated(matrix, point),
          perspective = CAMERA / (CAMERA - z);
        left = Math.min(left, x * perspective);
        right = Math.max(right, x * perspective);
        top = Math.min(top, y * perspective);
        bottom = Math.max(bottom, y * perspective);
      }
      const scale =
        Math.min(
          (bounds[1] - bounds[0]) / (right - left),
          (bounds[3] - bounds[2]) / (bottom - top),
        ) *
        0.985 *
        zoom;
      const ox = cx - (left + right) * 0.5 * scale,
        oy = cy - (top + bottom) * 0.5 * scale;
      if (shadow.current) {
        shadow.current.style.left = `${cx + scale * 0.12}px`;
        shadow.current.style.top = `${oy + bottom * scale + 21}px`;
        shadow.current.style.width = `${(right - left) * scale * 0.65}px`;
        shadow.current.style.opacity = `${fade * Math.max(0, 1 - (zoom - 1) * 2)}`;
      }
      if (!ready && vector.current) {
        vector.current.setAttribute("viewBox", `0 0 ${width} ${height}`);
        vector.current.style.opacity = `${fade}`;
        for (let bar = 0; bar < 3; bar++) {
          const drift = barDrift(bar, t);
          for (const layer of ["side", "front"]) {
            const points = outline(bar, layer === "front" ? BEVEL : 0).map(
              ({ point }) => {
                const [x, y, z] = rotated(matrix, [
                  point[0],
                  point[1] + drift[1],
                  (layer === "front" ? HALF_DEPTH : -HALF_DEPTH) + drift[2],
                ]);
                return [
                  ox + ((x * CAMERA) / (CAMERA - z)) * scale,
                  oy + ((y * CAMERA) / (CAMERA - z)) * scale,
                ] as Point2;
              },
            );
            vector.current
              .querySelector(`[data-bar="${bar}-${layer}"]`)
              ?.setAttribute(
                "d",
                points
                  .map(
                    ([x, y], i) =>
                      `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`,
                  )
                  .join(" ") + " Z",
              );
          }
        }
      }
      if (!ready || !gl || !fade) return;
      gl.uniformMatrix3fv(uniforms.rotation, false, matrix);
      gl.uniform2f(uniforms.resolution, width, height);
      gl.uniform2f(
        uniforms.offset,
        (ox / width) * 2 - 1,
        1 - (oy / height) * 2,
      );
      gl.uniform1f(uniforms.scale, scale);
      gl.uniform1f(uniforms.time, t);
      gl.uniform1f(uniforms.opacity, fade);
      gl.uniform1f(uniforms.dark, dark ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, brand.indices.length, gl.UNSIGNED_SHORT, 0);
    };
    const tick = (now: number) => {
      frame = 0;
      const running =
        state.current.active && !state.current.quiet && progress.get() < 0.4;
      if (last && now - last < 32 && running && wasRunning) {
        frame = requestAnimationFrame(tick);
        return;
      }
      if (last && running && wasRunning)
        clock.current += Math.min(70, now - last) / 1000;
      last = now;
      wasRunning = running;
      render();
      if (running) frame = requestAnimationFrame(tick);
    };
    schedule.current = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const resize = () => {
      width = element.clientWidth;
      height = element.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      element.width = Math.round(width * dpr);
      element.height = Math.round(height * dpr);
      if (gl) gl.viewport(0, 0, element.width, element.height);
      schedule.current();
    };
    const move = (event: PointerEvent) => {
      if (
        !state.current.active ||
        state.current.quiet ||
        event.pointerType === "touch"
      )
        return;
      aimX = (event.clientX / width - 0.5) * 2;
      aimY = (event.clientY / height - 0.5) * 2;
    };
    const leave = () => {
      aimX = 0;
      aimY = 0;
    };
    const lost = (event: Event) => {
      event.preventDefault();
      ready = false;
      setFallback(true);
      element.dataset.renderer = "svg-logo";
      schedule.current();
    };
    const restored = () => setEpoch((value) => value + 1);
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const theme = new MutationObserver(() => {
      dark = document.documentElement.classList.contains("dark");
      schedule.current();
    });
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    const unsubscribe = progress.on("change", () => schedule.current());
    element.addEventListener("webglcontextlost", lost);
    element.addEventListener("webglcontextrestored", restored);
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    resize();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      theme.disconnect();
      unsubscribe();
      element.removeEventListener("webglcontextlost", lost);
      element.removeEventListener("webglcontextrestored", restored);
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      schedule.current = () => undefined;
      if (gl) {
        gl.deleteBuffer(vertexBuffer);
        gl.deleteBuffer(indexBuffer);
        gl.deleteProgram(program);
        shaders.forEach((shader) => gl.deleteShader(shader));
      }
    };
  }, [progress, epoch]);
  return (
    <div className="kinetic-brand-stage" aria-hidden="true">
      <div ref={shadow} className="kinetic-brand-shadow" />
      <canvas ref={canvas} className="kinetic-brand-canvas" />
      {fallback && (
        <svg
          ref={vector}
          className="kinetic-brand-vector"
          data-renderer="svg-logo"
        >
          <defs>
            <linearGradient id="brand-satin" x1="0" y1="0" x2="1" y2="1">
              <stop stopColor="#7586e4" />
              <stop offset=".5" stopColor="#656bc9" />
              <stop offset="1" stopColor="#8764ca" />
            </linearGradient>
          </defs>
          {[0, 1, 2].map((bar) => (
            <g key={bar}>
              <path data-bar={`${bar}-side`} fill="#46447c" />
              <path
                data-bar={`${bar}-front`}
                fill="url(#brand-satin)"
                stroke="#a7abe4"
                strokeWidth=".7"
              />
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
