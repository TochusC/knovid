const sectionSize = 18_000;
const summaryLimit = 1_400;
const previewEdge = 3_000;

export function creativeBriefPreview(text) {
  if (!text || text.length <= previewEdge * 2) return text;
  const first = text.slice(0, previewEdge).replace(/[\uD800-\uDBFF]$/u, '');
  const last = text.slice(-previewEdge).replace(/^[\uDC00-\uDFFF]/u, '');
  return first + '\n\n…\n\n' + last;
}

function splitBrief(text) {
  const sections = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + sectionSize, text.length);
    if (end < text.length) {
      const paragraph = text.lastIndexOf('\n', end - 1);
      if (paragraph > start + sectionSize / 2) end = paragraph + 1;
      else if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    }
    sections.push(text.slice(start, end));
    start = end;
  }
  return sections;
}

export async function fitCreativeBrief(text, summarize, signal) {
  if (!text || text.length <= sectionSize) return text;
  while (text.length > sectionSize) {
    const sections = splitBrief(text);
    const summaries = [];
    for (let offset = 0; offset < sections.length; offset += 3) {
      signal?.throwIfAborted();
      const batch = await Promise.allSettled(sections.slice(offset, offset + 3).map(section => summarize(section, summaryLimit)));
      for (const result of batch) {
        if (result.status === 'rejected') throw result.reason;
        summaries.push(result.value);
      }
    }
    text = summaries.join('\n\n');
  }
  return text;
}
