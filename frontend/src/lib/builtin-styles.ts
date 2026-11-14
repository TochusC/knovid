export const builtinStyles = [
  { id: "default", name: "紫蓝白", summary: "明亮留白、柔和光影，用紫蓝色突出关键变化。" },
  { id: "paper-diagram", name: "论文图解", summary: "白底细线和简洁标注，逐步揭示实验过程与数据关系。" },
  { id: "blueprint", name: "蓝图推演", summary: "深蓝网格和青色线框，沿流程拆解系统与结构。" },
  { id: "warm-story", name: "暖色手绘", summary: "纸张肌理和手绘线条，用暖色描绘自然与生活场景。" },
  { id: "bold-geometry", name: "几何动感", summary: "明快色块和鲜明对比，用几何变形呈现抽象关系。" },
] as const;

export type BuiltinStyleId = (typeof builtinStyles)[number]["id"];

export function isBuiltinStyleId(value: string): value is BuiltinStyleId {
  return builtinStyles.some((style) => style.id === value);
}
