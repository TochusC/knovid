import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {renderToDisk} from '../src/render/driver.mjs';

const code = `
function renderFrame({ctx, frame, draw3D}) {
  ctx.fillStyle = '#00cc00';
  ctx.fillRect(0, 0, 160, 90);
  draw3D(THREE => {
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 2;
    const material = new THREE.ShaderMaterial({
      uniforms: {uFrame: {value: 0}},
      vertexShader: "void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: "uniform float uFrame; void main(){gl_FragColor=vec4(1.0-uFrame,0.0,uFrame,1.0);}"
    });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material));
    return ({frame}) => {
      material.uniforms.uFrame.value = frame / 3;
      return {scene, camera};
    };
  });
  ctx.fillStyle = '#ffff00';
  ctx.fillRect(45, 26, 16, 16);
}
`;

function pixel(file, x, y, frame) {
  const filter = (frame === undefined ? '' : 'select=eq(n\\,' + frame + '),') +
    'format=rgb24,crop=1:1:' + x + ':' + y;
  return [...execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', filter, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];
}

for (const driver of ['remotion', 'chromium']) {
  test(driver + ' composites animated Three.js shaders between Canvas layers', {
    skip: process.env.KNOVID_TEST_RENDER !== '1', timeout: 100_000,
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'knovid-webgl-'));
    const input = {width: 160, height: 90, fps: 25, durationFrames: 4, params: {}, cues: {}, captions: []};
    const signal = AbortSignal.timeout(90_000);
    try {
      await renderToDisk({input, code, start: 0, still: true}, dir, {driver, signal});
      const image = join(dir, 'frame.png');
      const [red, green, blue] = pixel(image, 3, 3);
      assert.ok(red < 20 && green > 180 && blue < 20, 'Canvas background survives transparent WebGL');
      assert.deepEqual(pixel(image, 50, 34), [255, 255, 0], 'Canvas can paint over WebGL');
      assert.deepEqual(pixel(image, 80, 45), [255, 0, 0], 'The shader draws the first frame');

      await renderToDisk({input, code, start: 0, end: 3}, dir, {driver, signal});
      const movie = join(dir, 'raw.mp4');
      const [firstRed, , firstBlue] = pixel(movie, 80, 45, 0);
      const [lastRed, , lastBlue] = pixel(movie, 80, 45, 3);
      assert.ok(firstRed > 210 && firstBlue < 40, 'First video frame reflects the initial shader uniform');
      assert.ok(lastRed < 40 && lastBlue > 210, 'Last video frame reflects the updated shader uniform');

      const invalidShader = code.replace('gl_FragColor=vec4(1.0-uFrame,0.0,uFrame,1.0);', 'bad_shader_syntax;');
      await assert.rejects(renderToDisk({input, code: invalidShader, start: 0, still: true}, dir, {driver, signal}),
        /A Three\.js shader failed to compile or link/);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
}
