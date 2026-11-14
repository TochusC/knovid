export const builtinStyles = {
  'paper-diagram': {
    style: '论文图解',
    summary: 'Use an explicitly white background (#FFFFFF), an ink palette (#172735) and restrained teal (#157067) for the active variable. Draw clean, thin paper-style diagrams with ample margins, short labels and aligned small multiples. Reveal one stage of a method or experimental result at a time. Preserve actual quantitative scales from evidence or label schematics clearly.',
  },
  blueprint: {
    style: '蓝图推演',
    summary: 'Use an explicitly deep blue blueprint canvas (#10263B), subtle drafting grid (#183E58), cyan paths (#53D7F5), and pale text (#E9F7FF). Reveal structural outlines in steps, follow moving signals along connections and highlight the active subsystem. Keep the grid quiet and labels brief and readable.',
  },
  'warm-story': {
    style: '暖色手绘',
    summary: 'Use an explicitly warm paper background (#FAEDDA) with terracotta (#AE4933), amber (#DA8839), muted green (#47735E) and dark brown ink (#3A2924). Favor hand-drawn contours, soft paper grain, and layered illustration. Reveal shapes as if drawn by hand and animate the physical changes that carry the story.',
  },
  'bold-geometry': {
    style: '几何动感',
    summary: 'Use an explicitly creamy yellow background (#FFF1C3) with cobalt (#303BC2), coral (#E85537) and dark navy ink (#1F2049). Use large geometric forms with crisp edges, clear hierarchy and bold contrast. Show relationships through rotation, shape transformation and matched movement. Keep motion purposeful and leave clear space around brief labels.',
  },
};

export function isBuiltinStyleId(value) {
  return value === 'default' || Object.hasOwn(builtinStyles, value);
}
