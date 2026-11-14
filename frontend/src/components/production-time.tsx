import { useEffect, useState } from "react";
import type { Project } from "@/lib/types";

function formatElapsed(seconds: number) {
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor(rounded / 60) % 60;
  return `${hours ? `${hours} 小时 ` : ""}${minutes || hours ? `${minutes} 分 ` : ""}${rounded % 60} 秒`;
}

export function ProductionTime({ project }: { project: Project }) {
  const { productionElapsedSeconds, productionTimingEstimated, status } = project;
  const active = status !== "ready" && status !== "failed";
  const [extraSeconds, setExtraSeconds] = useState(0);

  useEffect(() => {
    setExtraSeconds(0);
    if (!active || productionElapsedSeconds === undefined) return;

    const measuredAt = performance.now();
    const timer = window.setInterval(() => setExtraSeconds((performance.now() - measuredAt) / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [active, productionElapsedSeconds, project.revisionId]);

  if (productionElapsedSeconds === undefined) return null;
  const elapsed = productionElapsedSeconds + (active ? extraSeconds : 0);
  return (
    <span title="从提交当前版本到制作结束，包含排队时间">
      {active ? "已用时" : "制作耗时"} {productionTimingEstimated ? "约 " : ""}{formatElapsed(elapsed)}
    </span>
  );
}
