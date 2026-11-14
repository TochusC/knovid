import {FPS, sceneId} from './common.mjs';

const agentActivities = new Set(['makeEvidence', 'makePlan', 'directVoice', 'writeScript', 'requireReview', 'makeMotion']);
const workerActivities = new Set([
  'checkpoint', 'prepareRevision', 'reserveProduction', 'acquire', 'extractText', 'extractFigures',
  'synthesize', 'checkFrame', 'rejectFrame', 'renderInfo', 'renderChunk', 'completeScene', 'assemble',
]);
const sceneActivities = new Set([
  'writeScript', 'requireReview', 'makeMotion', 'synthesize', 'checkFrame', 'rejectFrame', 'renderInfo', 'renderChunk', 'completeScene',
]);
const failureCodes = new Set([
  'WorkerShutdown', 'LLM_SCHEMA', 'LLM_NETWORK', 'LLM_BAD_RESPONSE', 'LLM_MODEL_REQUIRED', 'LLM_NOT_CONFIGURED',
  'COMMAND_FAILED', 'MISSING_COMMAND', 'EVIDENCE_REVIEW_FAILED', 'FRAME_COUNT', 'INVALID_SCENE', 'INVALID_PREVIEW',
  'GUEST_DURATION_LIMIT', 'TTS_ALIGNMENT', 'TTS_DURATION', 'TTS_FAILED', 'SCENE_TOO_LONG', 'INVALID_PDF',
  'NO_PDF_TEXT', 'NO_SOURCES', 'PAPER_UNAVAILABLE', 'PDF_MISSING', 'PDF_TOO_LARGE', 'SEARCH_UNAVAILABLE',
  'RENDER_ERROR', 'RENDER_TIMEOUT', 'CREDIT_SERVICE_UNAVAILABLE', 'ASSEMBLY_MISMATCH', 'TASK_TIMEOUT',
]);
const maxActivities = 768;

function timestamp(value) {
  if (!value || value.seconds == null) return undefined;
  const date = new Date(Number(value.seconds) * 1000 + Math.floor((value.nanos ?? 0) / 1_000_000));
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

function safeFailure(failure) {
  if (failure?.timeoutFailureInfo) return 'TASK_TIMEOUT';
  const type = failure?.applicationFailureInfo?.type;
  return typeof type === 'string' && (failureCodes.has(type) || /^LLM_HTTP_[45][0-9]{2}$/.test(type)) ? type : undefined;
}

function argument(input, index) {
  const payload = input?.payloads?.[index];
  const data = payload?.data;
  if (!data?.length || data.length > 4096) return undefined;
  if (payload.metadata?.encoding && Buffer.from(payload.metadata.encoding).toString() !== 'json/plain') return undefined;
  try {
    return JSON.parse(Buffer.from(data).toString('utf8'));
  } catch {
    return undefined;
  }
}

export function unavailableTrace() {
  return {source: 'unavailable', observedAt: new Date().toISOString(), activities: []};
}

export function workflowTrace(events, pending, {truncated = false} = {}) {
  const byEvent = new Map();
  const byActivity = new Map();
  const pendingIds = new Set();
  let closedAt;
  for (const event of events) {
    const at = timestamp(event.eventTime);
    if (!at) continue;
    const scheduled = event.activityTaskScheduledEventAttributes;
    if (scheduled) {
      const name = scheduled.activityType?.name;
      const kind = agentActivities.has(name) ? 'agent' : workerActivities.has(name) ? 'worker' : undefined;
      if (!kind || scheduled.activityId == null || event.eventId == null) continue;
      const activityId = String(scheduled.activityId);
      const id = /^\d{1,20}$/.test(activityId) ? activityId : String(event.eventId);
      const trace = {id, name, kind, status: 'queued', scheduledAt: at};
      if (sceneActivities.has(name)) {
        const scene = argument(scheduled.input, 1);
        if (typeof scene === 'string' && sceneId.test(scene)) trace.sceneId = scene;
      }
      if (name === 'makeMotion') {
        const fix = argument(scheduled.input, 2);
        if (typeof fix === 'string' && fix.length > 0) trace.repair = true;
      }
      if (name === 'renderChunk') {
        const fromFrame = argument(scheduled.input, 2);
        const toFrame = argument(scheduled.input, 3);
        if (Number.isInteger(fromFrame) && Number.isInteger(toFrame) && fromFrame >= 0 && toFrame >= fromFrame && toFrame < 60 * FPS) {
          trace.chunk = {fromFrame, toFrame};
        }
      }
      byEvent.set(String(event.eventId), trace);
      byActivity.set(activityId, trace);
      continue;
    }
    const started = event.activityTaskStartedEventAttributes;
    const completed = event.activityTaskCompletedEventAttributes;
    const failed = event.activityTaskFailedEventAttributes;
    const timedOut = event.activityTaskTimedOutEventAttributes;
    const cancelled = event.activityTaskCanceledEventAttributes;
    const activityEvent = started ?? completed ?? failed ?? timedOut ?? cancelled;
    if (activityEvent) {
      const trace = byEvent.get(String(activityEvent.scheduledEventId));
      if (!trace) continue;
      if (started) {
        trace.status = 'running';
        trace.startedAt = at;
        trace.attempt = started.attempt || undefined;
        trace.failureCode = safeFailure(started.lastFailure);
      } else {
        trace.status = completed ? 'succeeded' : cancelled ? 'cancelled' : 'failed';
        trace.finishedAt = at;
        trace.failureCode = timedOut ? 'TASK_TIMEOUT' : failed ? safeFailure(failed.failure) : trace.failureCode;
      }
    } else if (event.workflowExecutionCanceledEventAttributes || event.workflowExecutionTerminatedEventAttributes ||
      event.workflowExecutionTimedOutEventAttributes || event.workflowExecutionFailedEventAttributes) {
      closedAt = at;
    }
  }
  for (const activity of pending) {
    const trace = byActivity.get(String(activity.activityId));
    if (!trace || trace.finishedAt) continue;
    pendingIds.add(trace.id);
    const startedAt = timestamp(activity.lastStartedTime);
    const retryAt = timestamp(activity.nextAttemptScheduleTime);
    const running = activity.state === 2 || (activity.state === 3 && startedAt !== undefined);
    trace.status = running ? 'running' : activity.attempt > 1 || retryAt ? 'retrying' : 'queued';
    trace.startedAt = running ? startedAt ?? trace.startedAt : undefined;
    trace.retryAt = running ? undefined : retryAt;
    trace.attempt = activity.attempt || trace.attempt;
    trace.failureCode = safeFailure(activity.lastFailure) ?? trace.failureCode;
  }
  const all = [...byEvent.values()].filter(trace => !truncated || trace.finishedAt || pendingIds.has(trace.id));
  if (closedAt) {
    for (const trace of all) {
      if (!trace.finishedAt) {
        trace.status = 'cancelled';
        trace.finishedAt = closedAt;
        delete trace.retryAt;
      }
    }
  }
  let activities = all;
  if (all.length > maxActivities) {
    const active = all.filter(activity => !activity.finishedAt).slice(0, maxActivities);
    const remaining = maxActivities - active.length;
    const recent = remaining ? all.filter(activity => activity.finishedAt).slice(-remaining) : [];
    activities = [...active, ...recent]
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }
  return {source: 'temporal', observedAt: new Date().toISOString(), activities, ...(truncated || all.length > maxActivities ? {truncated: true} : {})};
}

export function temporalTraceReader(client, connection, namespace) {
  const cache = new Map();
  async function read(workflowId) {
    try {
      return await connection.withDeadline(Date.now() + 6500, async () => {
        const run = await client.workflow.getHandle(workflowId).describe();
        const events = [];
        let nextPageToken;
        for (let i = 0; i < 16; i++) {
          const response = await client.workflowService.getWorkflowExecutionHistory({
            namespace, execution: {workflowId, runId: run.runId}, maximumPageSize: 500, nextPageToken, skipArchival: true,
          });
          events.push(...(response.history?.events ?? []));
          nextPageToken = response.nextPageToken;
          if (!nextPageToken?.length) break;
        }
        const value = workflowTrace(events, run.raw.pendingActivities ?? [], {truncated: Boolean(nextPageToken?.length)});
        return {value, ttl: run.closeTime ? 60_000 : 5_000};
      });
    } catch {
      return {value: unavailableTrace(), ttl: 2_000};
    }
  }
  return workflowId => {
    const now = Date.now();
    const cached = cache.get(workflowId);
    if (cached && (cached.expiresAt === undefined || cached.expiresAt > now)) return cached.result;
    cache.delete(workflowId);
    if (cache.size >= 96) {
      const evict = [...cache].find(([, row]) => row.expiresAt !== undefined);
      if (!evict) return unavailableTrace();
      cache.delete(evict[0]);
    }
    const row = {};
    row.result = read(workflowId).then(({value, ttl}) => {
      row.expiresAt = Date.now() + ttl;
      return value;
    });
    cache.set(workflowId, row);
    return row.result;
  };
}
