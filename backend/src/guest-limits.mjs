import {Fault, FPS} from './common.mjs';

export function narrationBudget(options) {
  return options.maxDurationSeconds ? (options.language === 'en' ? 110 : 32) : undefined;
}

export function sceneFrameLimit(options) {
  if (!options.maxDurationSeconds) return 60 * FPS;
  // Leave three frames for container/audio rounding at the final 30-second boundary.
  return Math.floor((options.maxDurationSeconds * FPS - 3) / options.sceneCount);
}

export function requireSceneDuration(options, frames) {
  if (options.maxDurationSeconds && (!Number.isFinite(frames) || frames <= 0 || frames > sceneFrameLimit(options))) {
    throw new Fault('GUEST_DURATION_LIMIT', '访客短片每段需控制在 10 秒内，请精简讲解后重新制作。', {status: 422});
  }
}

export function requireTotalDuration(options, seconds) {
  if (options.maxDurationSeconds && (!Number.isFinite(seconds) || seconds <= 0 || seconds > options.maxDurationSeconds)) {
    throw new Fault('GUEST_DURATION_LIMIT', '访客短片最多 30 秒，请精简讲解后重新制作。', {status: 422});
  }
}
