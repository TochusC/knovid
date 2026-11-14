import {join} from 'node:path';
import {Fault, json, read, revisionDir} from '../common.mjs';
import {acquire, extractFigures, extractText} from './research.mjs';
import {directVoice, makeEvidence, makeMotion, makePlan, prepareRevision, prepareSearch, requireReview, writeScript} from './agents.mjs';
import {synthesize} from './audio.mjs';
import {checkFrame, completeScene, renderChunk, renderInfo} from './render.mjs';
import {assemble} from './assembly.mjs';
import {reserveProduction, settleProduction} from '../production-credit.mjs';

export const queues = {
  workflow: 'knovid-workflow',
  research: 'knovid-research',
  model: 'knovid-model',
  audio: 'knovid-audio',
  render: 'knovid-render',
  assembly: 'knovid-assembly',
};

async function checkpoint(job, status, stage, problem) {
  const error = typeof problem?.code === 'string' && typeof problem?.message === 'string' ?
    {code: problem.code, message: problem.message} : null;
  const file = join(revisionDir(job), 'status.json');
  const current = await read(file);
  const updatedAt = new Date().toISOString();
  const queuedAt = current.queuedAt ?? (current.status === 'queued' ? current.updatedAt : undefined);
  const startedAt = current.startedAt ?? (status === 'running' && current.status === 'queued' ? updatedAt : undefined);
  const finishedAt = status === 'queued' || status === 'running' ? undefined : current.finishedAt ?? updatedAt;
  let billing = {};
  if (job.billing) {
    billing = finishedAt ? await settleProduction(job, status) : {creditReserved: job.billing.amount};
  }
  await json(file, {status, stage, error, queuedAt, updatedAt, startedAt, finishedAt, ...billing});
}

async function rejectFrame(_job, id, reason) {
  throw new Fault('INVALID_SCENE', 'Scene ' + id + ' failed its render check: ' + reason);
}

export const groups = {
  workflow: {checkpoint, prepareRevision, rejectFrame, reserveProduction},
  research: {acquire, extractText, extractFigures},
  model: {prepareSearch, makeEvidence, makePlan, directVoice, writeScript, requireReview, makeMotion},
  audio: {synthesize},
  render: {checkFrame, renderInfo, renderChunk},
  assembly: {completeScene, assemble},
};
