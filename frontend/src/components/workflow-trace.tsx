import { useEffect, useId, useState, type CSSProperties } from "react";
import { Activity, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import type { Scene, WorkflowActivity, WorkflowTrace as Trace } from "@/lib/types";
import "./workflow-trace.css";

const stageLabels: Record<string, string> = {
  prepareSearch: "拟定检索词", makeEvidence: "资料研究", makePlan: "导演分镜", directVoice: "配音指导",
  writeScript: "编写讲解", requireReview: "内容审校", makeMotion: "设计动效",
  acquire: "获取资料", extractText: "提取文字", extractFigures: "提取图表",
  synthesize: "合成音频", checkFrame: "检查画面", renderInfo: "准备渲染",
  renderChunk: "渲染画面", completeScene: "生成镜头预览", assemble: "合成全片",
  prepareRevision: "复用已有素材", reserveProduction: "预留制作额度", rejectFrame: "记录画面检查失败",
};

const statusLabels: Record<WorkflowActivity["status"], string> = {
  queued: "排队中", running: "进行中", retrying: "等待重试",
  succeeded: "已完成", failed: "失败", cancelled: "已取消",
};

function activityLabel(activity: WorkflowActivity) {
  if (activity.repair && activity.name === "makeMotion") return "修正动效";
  return Object.hasOwn(stageLabels, activity.name) ? stageLabels[activity.name] : "制作任务";
}

function statusLabel(activity: WorkflowActivity) {
  if (activity.repair && activity.status === "running") return "修正中";
  if (activity.status === "running" && (activity.attempt ?? 1) > 1) return "重试中";
  return statusLabels[activity.status];
}

const dateValue = (value?: string) => value ? Date.parse(value) : NaN;
const timeLabel = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function formattedTime(value?: string) {
  const time = dateValue(value);
  return Number.isFinite(time) ? timeLabel.format(time) : undefined;
}
const taskPriority: Record<WorkflowActivity["status"], number> = {
  running: 0, retrying: 1, queued: 2, failed: 3, cancelled: 4, succeeded: 5,
};

function durationLabel(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

function TraceTrack({ activities, start, end }: { activities: WorkflowActivity[]; start: number; end: number }) {
  const span = Math.max(end - start, 1000);
  const percent = (value: number) => Math.max(0, Math.min(100, (value - start) / span * 100));
  const trackSegment = (from: number, to: number): CSSProperties => {
    const left = Math.min(99, percent(from));
    return {
      "--workflow-start": `${left}%`,
      "--workflow-length": `${Math.max(1, percent(to) - left)}%`,
    } as CSSProperties;
  };
  return (
    <div className="workflow-track" aria-hidden="true">
      {(["agent", "worker"] as const).map((kind) => (
        <div className={`workflow-track-lane workflow-track-${kind}`} key={kind}>
          {activities.filter((activity) => activity.kind === kind).map((activity) => {
            const scheduled = dateValue(activity.scheduledAt);
            const started = dateValue(activity.startedAt);
            const finished = dateValue(activity.finishedAt);
            const until = Number.isFinite(finished) ? finished : end;
            const hasStarted = Number.isFinite(started);
            const waitUntil = hasStarted ? started : until;
            if (!Number.isFinite(scheduled) || !Number.isFinite(waitUntil)) return null;
            return (
              <span key={activity.id}>
                {waitUntil > scheduled && <span className="workflow-track-block workflow-track-wait" style={trackSegment(scheduled, waitUntil)} />}
                {(hasStarted || activity.status === "failed" || activity.status === "cancelled") && (
                  <span className={`workflow-track-block workflow-task-${activity.status}`} style={trackSegment(hasStarted ? started : until, until)} />
                )}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function TraceGroup({ title, description, activities, start, end }: {
  title: string; description?: string; activities: WorkflowActivity[]; start: number; end: number;
}) {
  const latest = activities.reduce<WorkflowActivity | undefined>((current, activity) => {
    if (!current || taskPriority[activity.status] < taskPriority[current.status] ||
      (taskPriority[activity.status] === taskPriority[current.status] && (activity.kind === "agent" || current.kind === "worker"))) {
      return activity;
    }
    return current;
  }, undefined);
  const pending = activities.filter((activity) => ["queued", "running", "retrying"].includes(activity.status)).length;
  const summary = (
    <>
      <span className="workflow-row-name">
        <strong>{title}</strong>
        {description && <span title={description}>{description}</span>}
      </span>
      <TraceTrack activities={activities} start={start} end={end} />
      <span className="workflow-row-status">
        {latest ? (
          <>
            <span className="workflow-row-task">{activityLabel(latest)}</span>
            <span className={`workflow-task-${latest.status}`}>{statusLabel(latest)}{pending > 1 ? ` · +${pending - 1}` : ""}</span>
          </>
        ) : "尚无任务记录"}
      </span>
    </>
  );
  if (!latest) return <div className="workflow-row workflow-row-empty">{summary}</div>;
  return (
    <details className="workflow-row-details">
      <summary className="workflow-row">
        {summary}
        <ChevronDown className="workflow-row-chevron" size={14} aria-hidden="true" />
      </summary>
      <ul className="workflow-activity-list" aria-label={`${title}任务明细`}>
        {activities.map((activity) => {
          const started = dateValue(activity.startedAt);
          const timestamp = activity.startedAt ?? activity.scheduledAt;
          const time = formattedTime(timestamp);
          const retryTime = formattedTime(activity.retryAt);
          const scheduled = dateValue(activity.scheduledAt);
          const finishedAt = dateValue(activity.finishedAt);
          const finished = Number.isFinite(finishedAt) ? finishedAt : end;
          const hasStarted = Number.isFinite(started);
          const wait = (hasStarted ? started : finished) - scheduled;
          const delayed = activity.status === "retrying" || (activity.attempt ?? 1) > 1;
          return (
            <li key={activity.id}>
              <span className="workflow-activity-role">{activity.kind === "agent" ? "Agent" : "程序"}</span>
              <strong>{activityLabel(activity)}</strong>
              {activity.chunk && <span className="workflow-activity-detail">帧 {activity.chunk.fromFrame}–{activity.chunk.toFrame}</span>}
              <span className={`workflow-activity-status workflow-task-${activity.status}`}>{statusLabel(activity)}</span>
              {(activity.attempt ?? 1) > 1 && <span className="workflow-activity-detail">第 {activity.attempt} 次</span>}
              {time && <time dateTime={timestamp}>{time}</time>}
              {wait >= 1000 && <span className="workflow-activity-detail">{delayed ? "含此前尝试" : "排队"} {durationLabel(wait)}</span>}
              {hasStarted && Number.isFinite(finished) && <span className="workflow-activity-detail">运行 {durationLabel(finished - started)}</span>}
              {retryTime && <span className="workflow-activity-detail">{retryTime} 后重试</span>}
              {activity.failureCode && <span className="workflow-activity-detail">{activity.failureCode}</span>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function WorkflowTrace({ projectId, revisionId, scenes, active }: {
  projectId: string; revisionId: string; scenes: Scene[]; active: boolean;
}) {
  const headingId = useId();
  const [trace, setTrace] = useState<Trace>();
  const [connectionFailed, setConnectionFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api.getWorkflowTrace(projectId, revisionId, controller.signal);
        if (controller.signal.aborted) return;
        setConnectionFailed(result.source === "unavailable");
        if (result.source === "temporal") setTrace(result);
      } catch {
        if (!controller.signal.aborted) setConnectionFailed(true);
      } finally {
        if (active && !controller.signal.aborted) timer = setTimeout(refresh, document.hidden ? 18000 : 6500);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [projectId, revisionId, active]);

  const activities = trace?.activities.filter((activity) => activity.name !== "checkpoint") ?? [];
  const live = active && !connectionFailed;
  const ongoing = live ? activities.filter((activity) => activity.status === "running") : [];
  const runningWorkers = ongoing.filter((activity) => activity.kind === "worker").length;
  const runningAgents = ongoing.length - runningWorkers;
  const activeRoles = new Map<string, number>();
  for (const task of ongoing.filter((activity) => activity.kind === "agent")) {
    const role = stageLabels[task.name] ?? "制作任务";
    activeRoles.set(role, (activeRoles.get(role) ?? 0) + 1);
  }
  const waiting = activities.filter((activity) => live && activity.status === "queued").length;
  const retrying = activities.filter((activity) => live && activity.status === "retrying").length;
  const grouped = new Map<string, WorkflowActivity[]>();
  for (const activity of activities) {
    const id = activity.sceneId ?? "project";
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id)?.push(activity);
  }
  const sceneNames = scenes.map((scene, index) => ({ id: scene.id, title: `镜头 ${index + 1}`, description: scene.title }));
  const seen = new Set(sceneNames.map((scene) => scene.id));
  const groups = [
    { id: "project", title: "全片流程", description: "" },
    ...sceneNames,
    ...[...grouped.keys()].filter((id) => id !== "project" && !seen.has(id)).map((id) => ({ id, title: `镜头 ${id.replace(/^s/, "")}`, description: "" })),
  ];
  const observedAt = dateValue(trace?.observedAt);
  const start = trace?.activities.reduce((earliest, activity) => Math.min(earliest, dateValue(activity.scheduledAt) || Infinity), Infinity) ?? Infinity;
  const lastTask = trace?.activities.reduce((latest, activity) => Math.max(latest, dateValue(activity.finishedAt ?? activity.startedAt ?? activity.scheduledAt) || 0), 0) ?? 0;
  const end = active && Number.isFinite(observedAt) ? Math.max(lastTask, observedAt) : lastTask;

  return (
    <section className="workflow-panel" aria-labelledby={headingId}>
      <header className="workflow-header">
        <h2 id={headingId}><Activity size={16} aria-hidden="true" /> 制作时间轴</h2>
        {trace && !connectionFailed && (
          <span className="workflow-connection">{active ? "实时更新" : "制作记录"}</span>
        )}
      </header>
      {!trace ? (
        <p className="workflow-empty" role="status">{connectionFailed ? "暂时无法读取制作记录。" : "正在获取制作记录…"}</p>
      ) : (
        <>
          {connectionFailed && <p className="workflow-empty" role="status">制作记录暂未刷新，以下为上次记录。</p>}
          {activities.length ? (
            <>
              {live && (
                <div className="workflow-counts" aria-live="polite">
                  <strong>{runningAgents} 个 Agent 运行中</strong>
                  <span>{runningWorkers} 个程序任务运行中</span>
                  {[...activeRoles].map(([role, count]) => <span key={role}>{role} ×{count}</span>)}
                  {waiting > 0 && <span>{waiting} 个任务排队</span>}
                  {retrying > 0 && <span>{retrying} 个任务等待重试</span>}
                </div>
              )}
              <div className="workflow-axis" aria-hidden="true">
                <span className="workflow-axis-key"><i /> Agent<i /> 程序</span>
                <span className="workflow-axis-scale"><span>0 秒</span><span>{durationLabel(end - start)}</span></span>
              </div>
              <div className="workflow-rows" role="region" aria-label="全片与镜头任务" tabIndex={0}>
                {groups.map((group) => <TraceGroup key={group.id} {...group} activities={grouped.get(group.id) ?? []} start={start} end={end} />)}
              </div>
              {trace.truncated && <p className="workflow-empty">仅显示最近的部分任务。</p>}
            </>
          ) : <p className="workflow-empty">{active ? "等待工作流安排任务。" : "没有可显示的制作任务。"}</p>}
        </>
      )}
    </section>
  );
}
