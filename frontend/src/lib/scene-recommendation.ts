import { MAX_CREATION_SCENES, MIN_CREATION_SCENES } from "./production-estimate.ts";
import type { InputType } from "./types";

const PAPER_FALLBACK_SCENES = 8;
const SIMPLE_TOPIC_SCENES = 3;

function contentSize(text: string) {
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? [];
  const otherWords = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, " ")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return cjk.length + otherWords.length * 3;
}

export function recommendSceneCount({ inputType, topic, hasPaper }: {
  inputType: InputType;
  topic: string;
  hasPaper: boolean;
}): number | undefined {
  if (inputType === "paper") return hasPaper ? PAPER_FALLBACK_SCENES : undefined;

  // Links may accompany a topic, but their length does not describe its scope.
  const text = topic.replace(/\b(?:https?:\/\/|www\.)[^\s，。；！？、]+/giu, " ").trim();
  const size = contentSize(text);
  if (!size) return undefined;

  const points = text.split(/[\r\n。！？；、，,;!?]+|\.(?=\s|$)/u)
    .filter((part) => contentSize(part.replace(/^\s*(?:[-*•#]+|\d+[.、)）])\s*/u, "")) >= 5)
    .length;
  const byLength = SIMPLE_TOPIC_SCENES + Math.max(0, Math.ceil((size - 24) / 20));
  const byPoints = points + 2; // Leave room for an introduction and synthesis.
  return Math.min(MAX_CREATION_SCENES, Math.max(MIN_CREATION_SCENES, byLength, byPoints));
}
