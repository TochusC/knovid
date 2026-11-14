import {longProductionThreshold} from './scene-limits.mjs';

async function together(tasks) {
  const results = await Promise.allSettled(tasks);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}

async function inBatches(items, size, run) {
  for (let offset = 0; offset < items.length; offset += size) {
    await together(items.slice(offset, offset + size).map(run));
  }
}

async function makeScene(a, job, id, {reused = false, regenerateVoice = false, reviewBeforeMotion = false, longProduction = false} = {}) {
  const audio = async () => {
    if (!reused) await a.writeScript(job, id);
    await a.requireReview(job, id);
    await a.synthesize(job, id);
  };
  let canRepairMotion = !reused;
  if (reviewBeforeMotion && (!reused || regenerateVoice)) {
    if (!reused) await a.writeScript(job, id);
    const audit = await a.requireReview(job, id);
    const repair = reused && audit?.visualChanged ? 'Use the corrected, approved visual directions and narration.' : null;
    canRepairMotion ||= repair !== null;
    await together([a.synthesize(job, id), ...(canRepairMotion ? [a.makeMotion(job, id, repair)] : [])]);
  } else if (reused) {
    if (regenerateVoice) await audio();
  } else {
    await together([audio(), a.makeMotion(job, id, null)]);
  }
  let sample = await a.checkFrame(job, id);
  if (!sample.ok && canRepairMotion) {
    await a.makeMotion(job, id, sample.reason);
    sample = await a.checkFrame(job, id);
  }
  if (!sample.ok) {
    await a.rejectFrame(job, id, sample.reason);
  }

  const {durationFrames, heavy} = await a.renderInfo(job, id);
  const block = Math.min(job.chunkFrames, heavy ? 100 : job.chunkFrames);
  const starts = Array.from({length: Math.ceil(durationFrames / block)}, (_, i) => i * block);
  const renderChunk = start => a.renderChunk(job, id, start, Math.min(durationFrames, start + block) - 1);
  if (longProduction) await inBatches(starts, 2, renderChunk);
  else await together(starts.map(renderChunk));
  await a.completeScene(job, id, starts);
}

function makeScenes(a, job, ids, options) {
  const longProduction = ids.length > longProductionThreshold;
  const produce = id => makeScene(a, job, id, {...options, longProduction});
  return longProduction ? inBatches(ids, 4, produce) : together(ids.map(produce));
}

export async function executePipeline(a, job, {reviewBeforeMotion = true, prepareCreativeBriefSearch = true} = {}) {
  let ids;
  if (job.edit) {
    await a.checkpoint(job, 'running', 'reusing');
    const edit = await a.prepareRevision(job);
    ids = edit.scenes;
    if (edit.voiceChanged) {
      await a.checkpoint(job, 'running', 'scenes');
      await makeScenes(a, job, ids, {reused: true, regenerateVoice: true, reviewBeforeMotion});
    } else if (edit.changedScene) {
      await a.checkpoint(job, 'running', 'scenes');
      await makeScene(a, job, edit.changedScene, {reused: true, regenerateVoice: edit.narrationChanged, reviewBeforeMotion,
        longProduction: ids.length > longProductionThreshold});
    }
  } else {
    await a.checkpoint(job, 'running', 'research');
    const source = await a.acquire(job);
    if (prepareCreativeBriefSearch && source === 'long-topic') await a.prepareSearch?.(job);
    await together([a.extractText(job), a.extractFigures(job)]);
    await a.makeEvidence(job);
    await a.checkpoint(job, 'running', 'planning');
    ids = await a.makePlan(job);
    await a.directVoice(job);
    await a.checkpoint(job, 'running', 'scenes');
    await makeScenes(a, job, ids, {reviewBeforeMotion});
  }
  await a.checkpoint(job, 'running', 'assembly');
  const assemble = ids.length > longProductionThreshold && a.assembleLong ? a.assembleLong : a.assemble;
  await assemble(job, ids);
}

export function failureDetails(error) {
  let current = error;
  while (current.cause && !current.type && !current.code) current = current.cause;
  const code = current.type || current.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(code)) return {code, message: current.message.slice(0, 400)};
  if (current.name === 'TimeoutFailure') return {code: 'TASK_TIMEOUT', message: 'An activity timed out'};
  return {code: 'PIPELINE_FAILED', message: 'A pipeline task failed; inspect the worker log'};
}
