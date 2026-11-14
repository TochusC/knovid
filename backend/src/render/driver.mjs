import {createWriteStream} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {finished} from 'node:stream/promises';
import {Fault, media, run} from '../common.mjs';

const entryPoint = fileURLToPath(new URL('composition.jsx', import.meta.url));
const captureModule = new URL('paint.mjs', import.meta.url);
const executable = process.env.CHROMIUM_EXECUTABLE || undefined;

function inputProps(request) {
  return {...request.input, code: request.code};
}

async function remotion(request, dir, bundleLocation, signal) {
  const {selectComposition, renderStill, renderMedia, makeCancelSignal} = await import('@remotion/renderer');
  const serveUrl = bundleLocation || await bundle(join(dir, 'bundle'));
  const props = inputProps(request);
  const settings = {serveUrl, inputProps: props, browserExecutable: executable, timeoutInMilliseconds: 22_000,
    chromiumOptions: {gl: 'swangle'}, chromeMode: process.env.REMOTION_CHROME_MODE || 'headless-shell', logLevel: 'error'};
  const composition = await selectComposition({...settings, id: 'KnoVidScene'});
  signal.throwIfAborted();
  const {cancel, cancelSignal} = makeCancelSignal();
  signal.addEventListener('abort', cancel, {once: true});
  try {
    if (request.still) {
      await renderStill({...settings, composition, cancelSignal, frame: request.start, imageFormat: 'png', output: join(dir, 'frame.png')});
    } else {
      await renderMedia({...settings, composition, cancelSignal, frameRange: [request.start, request.end],
        codec: 'h264', pixelFormat: 'yuv420p', crf: 18, muted: true,
        x264Preset: 'veryfast', concurrency: Number(process.env.REMOTION_CONCURRENCY || 2), outputLocation: join(dir, 'raw.mp4')});
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export async function bundle(outDir) {
  const {bundle} = await import('@remotion/bundler');
  return bundle({entryPoint, outDir, enableCaching: false, onProgress: () => {}});
}

let captureScript;

function browserHelpers() {
  captureScript ??= import('esbuild').then(async ({build}) => {
    const {outputFiles} = await build({
      entryPoints: [fileURLToPath(captureModule)],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'KnoVidPaint',
      minify: true,
      write: false,
    });
    return outputFiles[0].text;
  });
  return captureScript;
}

async function browserCapture(request, dir, signal) {
  const packageURL = process.env.PLAYWRIGHT_MODULE;
  const {chromium} = await import(packageURL ? pathToFileURL(packageURL).href : 'playwright-core');
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  if (process.env.CHROMIUM_SINGLE_PROCESS === '1') args.push('--single-process', '--no-zygote');
  const browser = await chromium.launch({executablePath: executable, args});
  try {
    const page = await browser.newPage({
      viewport: {width: request.input.width, height: request.input.height},
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    await page.route('**/*', route => route.abort());
    const payload = inputProps(request);
    await page.setContent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; style-src \'unsafe-inline\'; connect-src \'none\'; frame-src \'none\'"><style>body{margin:0}canvas{display:block}</style><canvas></canvas>');
    const source = await browserHelpers();
    await page.evaluate(({payload, source}) => {
      const canvas = document.querySelector('canvas');
      canvas.width = payload.width;
      canvas.height = payload.height;
      const helpers = new Function(source + '\nreturn KnoVidPaint;')();
      const program = helpers.compile(payload.code);
      globalThis.draw = frame => helpers.paint(canvas, payload, frame, program);
    }, {source, payload});
    if (request.still) {
      await page.evaluate(frame => globalThis.draw(frame), request.start);
      await page.screenshot({path: join(dir, 'frame.png')});
      return;
    }
    const imageFile = join(dir, 'frames.mjpeg');
    const output = createWriteStream(imageFile);
    const flushed = finished(output);
    flushed.catch(() => {});
    try {
      for (let frame = request.start; frame <= request.end; frame++) {
        signal.throwIfAborted();
        await page.evaluate(frame => globalThis.draw(frame), frame);
        const screenshot = await page.screenshot({type: 'jpeg', quality: 92});
        await new Promise((resolve, reject) => output.write(screenshot, error => error ? reject(error) : resolve()));
      }
      output.end();
      await flushed;
    } finally {
      output.destroy();
    }
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'mjpeg', '-framerate', String(request.input.fps), '-i', imageFile,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', join(dir, 'raw.mp4')], {signal});
  } finally {
    await browser.close();
  }
}

export async function renderToDisk(request, dir, {driver, bundleLocation, signal}) {
  if (driver === 'chromium') await browserCapture(request, dir, signal);
  else await remotion(request, dir, bundleLocation, signal);
  if (!request.still) {
    const file = join(dir, 'raw.mp4');
    const metadata = await media(file, signal);
    const stream = metadata.streams.find(stream => stream.codec_type === 'video');
    const expected = request.end - request.start + 1;
    if (stream?.codec_name !== 'h264' || stream.width !== request.input.width ||
      stream.height !== request.input.height || Number(stream.nb_frames) !== expected ||
      metadata.streams.some(stream => stream.codec_type === 'audio')) {
      throw new Fault('FRAME_COUNT', 'Rendered chunk has unexpected dimensions, frame count or streams');
    }
  }
}
