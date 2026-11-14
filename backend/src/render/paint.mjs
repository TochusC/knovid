import * as THREE from 'three';

export function compile(code) {
  return new Function('"use strict";\n' + code + '\nreturn renderFrame;')();
}

const layers = new WeakMap();

function draw3D(layer, ctx, settings, setup) {
  if (typeof setup !== 'function') throw new Error('draw3D requires a setup function');
  if (!layer.renderer) {
    const canvas = layer.canvas.ownerDocument.createElement('canvas');
    const context = canvas.getContext('webgl2', {alpha: true, antialias: true, preserveDrawingBuffer: true});
    if (!context) throw new Error('WebGL 2 is unavailable in the scene renderer');
    layer.renderer = new THREE.WebGLRenderer({canvas, context, alpha: true, antialias: true});
    layer.renderer.setClearColor(0x000000, 0);
    layer.renderer.debug.onShaderError = () => {
      throw new Error('A Three.js shader failed to compile or link. Check vertex and fragment syntax, uniforms and varyings.');
    };
  }
  const {renderer} = layer;
  const {width, height} = settings;
  if (renderer.domElement.width !== width || renderer.domElement.height !== height) renderer.setSize(width, height, false);
  if (!layer.scene3D) {
    layer.scene3D = setup(THREE);
    if (typeof layer.scene3D !== 'function') throw new Error('draw3D setup must return a function that accepts the frame and returns {scene, camera}');
  }
  const frame3D = layer.scene3D(settings);
  if (!frame3D?.scene?.isScene || !frame3D?.camera?.isCamera) throw new Error('draw3D must return a Three.js scene and camera for each frame');
  if (renderer.getContext().isContextLost()) throw new Error('The scene WebGL context was lost');
  renderer.render(frame3D.scene, frame3D.camera);
  ctx.drawImage(renderer.domElement, 0, 0);
}

function lines(ctx, text, width) {
  const units = text.includes(' ') && !/[\u3400-\u9fff]/u.test(text) ? text.split(/(?<= )/u) : Array.from(text);
  const result = [];
  let current = '';
  for (const unit of units) {
    if (current && ctx.measureText(current + unit).width > width) {
      result.push(current.trim());
      current = '';
    }
    current += unit;
  }
  if (current) result.push(current.trim());
  return result;
}

function subtitle(ctx, text, width, height) {
  const scale = height / 360;
  const size = 14 * scale;
  const padX = 12 * scale;
  const padY = 7 * scale;
  const lineHeight = 18 * scale;
  const maxWidth = width * 0.86 - 2 * padX;
  ctx.font = '500 ' + size + 'px "Noto Sans CJK SC", "PingFang SC", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const captions = lines(ctx, text, maxWidth);
  const boxWidth = Math.min(maxWidth, Math.max(...captions.map(line => ctx.measureText(line).width))) + 2 * padX;
  const boxHeight = captions.length * lineHeight + 2 * padY;
  const top = height - 13 * scale - boxHeight;
  ctx.fillStyle = 'rgba(14, 26, 35, 0.91)';
  ctx.beginPath();
  ctx.roundRect((width - boxWidth) / 2, top, boxWidth, boxHeight, 6 * scale);
  ctx.fill();
  ctx.fillStyle = '#fff8e9';
  captions.forEach((line, index) => ctx.fillText(line, width / 2, top + padY + (index + 0.5) * lineHeight, maxWidth));
}

export function paint(canvas, input, frame, scene) {
  const {width, height, fps, durationFrames, params, cues, captions} = input;
  const ctx = canvas.getContext('2d', {alpha: false});
  let layer = layers.get(canvas);
  if (!layer || layer.program !== scene) {
    layer?.renderer?.dispose();
    const clean = canvas.ownerDocument.createElement('canvas');
    layer = {canvas: clean, program: scene, ctx: clean.getContext('2d', {alpha: false})};
    layers.set(canvas, layer);
  }
  if (layer.canvas.width !== width || layer.canvas.height !== height) {
    layer.canvas.width = width;
    layer.canvas.height = height;
  }
  const sceneCtx = layer.ctx;
  sceneCtx.reset();
  sceneCtx.fillStyle = '#f6f0e5';
  sceneCtx.fillRect(0, 0, width, height);
  const settings = {frame, fps, width, height, durationFrames, params, cues};
  scene({...settings, ctx: sceneCtx, draw3D: setup => draw3D(layer, sceneCtx, settings, setup)});
  ctx.reset();
  ctx.drawImage(layer.canvas, 0, 0);
  const time = frame / fps;
  const caption = captions.find(item => item.start <= time && time < item.end);
  if (caption) {
    subtitle(ctx, caption.text, width, height);
  }
}
