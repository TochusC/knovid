import {
  ActivityCancellationType, ApplicationFailure, CancellationScope, isCancellation, patched, proxyActivities,
} from '@temporalio/workflow';
import {executePipeline, failureDetails} from './pipeline.mjs';
import type {groups} from './activities/index.mjs';

type Job = {projectId: string; revisionId: string; edit: boolean; chunkFrames: number; billing?: unknown};

function on<K extends keyof typeof groups>(role: K, startToCloseTimeout: string) {
  return proxyActivities<(typeof groups)[K]>({
    taskQueue: 'knovid-' + role,
    startToCloseTimeout,
    scheduleToCloseTimeout: '45m',
    heartbeatTimeout: '25s',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {initialInterval: '2s', maximumInterval: '20s', maximumAttempts: 3},
  });
}

const io = on('workflow', '1m');
const research = on('research', '3m');
const model = on('model', '10m');
const motion = on('model', '18m');
const review = on('model', '22m');
const audio = on('audio', '6m');
const render = on('render', '330s');
const assembly = on('assembly', '6m');
const longAssembly = on('assembly', '18m');
const paidStatus = proxyActivities<typeof groups.workflow>({
  taskQueue: 'knovid-workflow', startToCloseTimeout: '1m', heartbeatTimeout: '25s',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {initialInterval: '2s', maximumInterval: '2m'},
});

const activities = {
  checkpoint: io.checkpoint, prepareRevision: io.prepareRevision, rejectFrame: io.rejectFrame,
  acquire: research.acquire, extractText: research.extractText, extractFigures: research.extractFigures,
  makeEvidence: model.makeEvidence, makePlan: model.makePlan, directVoice: model.directVoice,
  writeScript: model.writeScript, requireReview: model.requireReview, makeMotion: motion.makeMotion,
  synthesize: audio.synthesize, checkFrame: render.checkFrame, renderInfo: render.renderInfo, renderChunk: render.renderChunk,
  completeScene: assembly.completeScene, assemble: assembly.assemble, assembleLong: longAssembly.assemble,
};

export async function produceVideo(job: Job) {
  const finish = job.billing ? paidStatus.checkpoint : io.checkpoint;
  try {
    const reviewBeforeMotion = patched('review-before-motion');
    const sceneActivities = reviewBeforeMotion ? {...activities, requireReview: review.requireReview} : activities;
    if (job.billing) await CancellationScope.nonCancellable(() => io.reserveProduction(job));
    await executePipeline(sceneActivities, job, {reviewBeforeMotion});
  } catch (error) {
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(() => finish(job, 'cancelled', 'cancelled'));
      throw error;
    }
    const problem = failureDetails(error);
    await CancellationScope.nonCancellable(() => finish(job, 'failed', 'failed', problem));
    throw ApplicationFailure.nonRetryable(problem.message, problem.code);
  }
  await CancellationScope.nonCancellable(() => finish(job, 'succeeded', 'complete'));
}
