import type { ModelProvider } from "./types";

export const MIN_CREATION_SCENES = 2;
export const MAX_CREATION_SCENES = 32;

interface EstimateOptions {
  sceneCount: number;
  narration: boolean;
  size: "360p" | "720p" | "1080p";
  isGuest: boolean;
  modelProvider: ModelProvider;
}

function formatSeconds(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (!minutes) return `${remainder} 秒`;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
}

function durationRange(low: number, high: number) {
  if (low !== high && high < 60) return `${low}–${high} 秒`;
  return low === high ? formatSeconds(low) : `${formatSeconds(low)}–${formatSeconds(high)}`;
}

export function estimateProduction({ sceneCount, narration, size, isGuest, modelProvider }: EstimateOptions) {
  // Without narration, the audio stage assigns 6–12 seconds for 1–4 cues.
  // Guest scenes have one cue each and a total duration limit of 30 seconds.
  const lowVideo = sceneCount * (narration ? 5 : 6);
  const highVideo = narration
    ? isGuest ? 30 : sceneCount * 18
    : sceneCount * (isGuest ? 6 : 12);

  // Two three-scene 1080p runs took 197 and 277 seconds. Use a wide planning
  // range as scene count grows and allow more render time at higher sizes.
  const renderAllowance = { "360p": 0, "720p": 10, "1080p": 20 }[size];
  const lowMinutes = Math.max(1, Math.floor((45 + sceneCount * 48) / 60));
  const highMinutes = Math.ceil((60 + sceneCount * (100 + renderAllowance)) / 60);
  return {
    videoDurationLabel: durationRange(lowVideo, highVideo),
    productionDurationLabel: `${lowMinutes}–${highMinutes} 分钟`,
    note: modelProvider === "standard"
      ? "制作时长为粗估，排队、模型重试和渲染复杂度会影响实际耗时。"
      : "制作耗时参考默认模型，所选模型的速度、排队和渲染复杂度会影响实际耗时。",
  };
}
