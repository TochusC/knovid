import {join} from 'node:path';
import {groups, queues} from './activities/index.mjs';
import {Fault, revisionDir, sleep} from './common.mjs';
import {computeConcurrency} from './limits.mjs';
import {executePipeline, failureDetails} from './pipeline.mjs';

function limiter(max) {
  const waiting = [];
  let running = 0;
  function release() {
    running--;
    waiting.shift()?.();
  }
  return async (callback, signal) => {
    if (running >= max) await new Promise(resolve => waiting.push(() => { running++; resolve(); }));
    else running++;
    try {
      signal.throwIfAborted();
      return await callback();
    } finally {
      release();
    }
  };
}

function localExecutor() {
  const active = new Map();
  const limits = Object.fromEntries(Object.keys(groups).map(role => [role, limiter(computeConcurrency(role))]));
  function wrap(signal) {
    return Object.fromEntries(Object.entries(groups).flatMap(([role, list]) => Object.entries(list).map(([name, fn]) => [name,
      (...args) => limits[role](async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await fn(...args, signal);
          } catch (error) {
            if (attempt === 2 || !error.retryable) throw error;
            await sleep(error.retryAfterMs ?? 600, signal);
          }
        }
      }, signal),
    ])));
  }
  const stop = async () => {
    for (const run of active.values()) run.controller.abort();
    await Promise.allSettled([...active.values()].map(run => run.promise));
  };
  return {
    isActive: job => active.has(job.revisionId),
    async start(job) {
      if (active.has(job.revisionId)) return;
      const controller = new AbortController();
      const promise = (async () => {
        const activities = wrap(controller.signal);
        try {
          if (job.billing) await activities.reserveProduction(job);
          await executePipeline(activities, job);
        } catch (error) {
          if (controller.signal.aborted) await groups.workflow.checkpoint(job, 'cancelled', 'cancelled');
          else {
            const problem = failureDetails(error);
            console.error('Revision failed', job.revisionId, problem.code, error);
            await groups.workflow.checkpoint(job, 'failed', 'failed', problem);
          }
          return;
        }
        await groups.workflow.checkpoint(job, 'succeeded', 'complete');
      })().finally(() => active.delete(job.revisionId));
      promise.catch(error => console.error('Could not save revision state', error.name));
      active.set(job.revisionId, {controller, promise});
    },
    async cancel(job) {
      const entry = active.get(job.revisionId);
      if (entry) entry.controller.abort();
      else await groups.workflow.checkpoint(job, 'cancelled', 'cancelled');
    },
    close: stop,
  };
}

const temporalId = ({projectId, revisionId}) => 'knovid/' + projectId + '/' + revisionId;

async function temporalExecutor() {
  const {Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError} = await import('@temporalio/client');
  const connection = Connection.lazy({address: process.env.TEMPORAL_ADDRESS || 'temporal:7233', connectTimeout: '5s'});
  const client = new Client({connection, namespace: process.env.TEMPORAL_NAMESPACE || 'default'});
  return {
    isActive: null,
    async start(job) {
      try {
        await connection.withDeadline(Date.now() + 5_000, () => client.workflow.start('produceVideo', {
          taskQueue: queues.workflow,
          workflowId: temporalId(job),
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
          args: [job],
        }));
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) return;
        console.error('Temporal start failed', error.name);
        throw new Fault('QUEUE_UNAVAILABLE', 'Could not enqueue the revision. Use its retry endpoint after Temporal is available.', {status: 503});
      }
    },
    async cancel(job) {
      try {
        await connection.withDeadline(Date.now() + 5_000, () => client.workflow.getHandle(temporalId(job)).cancel());
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) {
          throw new Fault('QUEUE_UNAVAILABLE', 'Could not request cancellation. Try again after Temporal is available.', {status: 503});
        }
        await groups.workflow.checkpoint(job, 'cancelled', 'cancelled');
      }
    },
    close: () => connection.close(),
  };
}

export async function executor() {
  const mode = process.env.KNOVID_EXECUTOR || 'temporal';
  if (mode === 'local') return localExecutor();
  if (mode === 'temporal') return temporalExecutor();
  throw new Error('KNOVID_EXECUTOR must be temporal or local');
}
