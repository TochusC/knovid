import {fileURLToPath} from 'node:url';
import {Context} from '@temporalio/activity';
import {ApplicationFailure} from '@temporalio/common';
import {NativeConnection, Worker} from '@temporalio/worker';
import {computeConcurrency} from './limits.mjs';
import {groups, queues} from './activities/index.mjs';
import {Fault} from './common.mjs';

const role = process.argv[2];
if (!Object.hasOwn(groups, role)) throw new Error('Expected a worker role: ' + Object.keys(groups).join(', '));
const connection = await NativeConnection.connect({address: process.env.TEMPORAL_ADDRESS || 'temporal:7233'});
const activities = Object.fromEntries(Object.entries(groups[role]).map(([name, activity]) => [name, async (...args) => {
  const context = Context.current();
  const heartbeat = setInterval(() => context.heartbeat(), 1500);
  try {
    context.heartbeat();
    return await activity(...args, context.cancellationSignal);
  } catch (error) {
    if (error instanceof Fault) {
      throw ApplicationFailure.create({
        type: error.code, message: error.message, nonRetryable: !error.retryable, nextRetryDelay: error.retryAfterMs,
      });
    }
    if (!context.cancellationSignal.aborted) console.error(name, error.name, error.code || '', error.message?.slice(0, 180));
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}]));

const worker = await Worker.create({
  connection,
  namespace: process.env.TEMPORAL_NAMESPACE || 'default',
  taskQueue: queues[role],
  activities,
  maxConcurrentActivityTaskExecutions: computeConcurrency(role),
  ...(role === 'model' && {maxTaskQueueActivitiesPerSecond: Number(process.env.MODEL_QUEUE_RATE || 4)}),
  ...(role === 'workflow' && {workflowsPath: fileURLToPath(new URL('workflow.ts', import.meta.url))}),
});
console.info('KnoVid worker ready:', queues[role]);
try {
  await worker.run();
} finally {
  await connection.close();
}
