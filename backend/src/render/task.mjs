import {join} from 'node:path';
import {json, read} from '../common.mjs';
import {renderToDisk} from './driver.mjs';

const [, , dir, bundleLocation] = process.argv;
const signal = AbortSignal.timeout(245_000);
try {
  const request = await read(join(dir, 'request.json'));
  await renderToDisk(request, dir, {bundleLocation, signal});
  await json(join(dir, 'result.json'), {ok: true});
} catch (error) {
  const detail = String(error?.message || error).split('\n')[0].slice(0, 240);
  await json(join(dir, 'result.json'), {ok: false, detail});
}
