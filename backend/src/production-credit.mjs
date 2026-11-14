import {Fault, FPS, read, revisionDir} from './common.mjs';
import {join} from 'node:path';

const premium = ['deepseek', 'openrouter'];
const creditsPerScene = 1;
const creditsPerDurationUnit = 1;
const durationUnitSeconds = 30;
export const maxSceneSeconds = 60;

export function modelProviders(identity) {
  const standard = {id: 'standard', creditsPerScene: 0, creditsPerDurationUnit: 0, durationUnitSeconds, maxSceneSeconds};
  if (identity.mode !== 'member' || !process.env.PRODUCTION_BILLING_TOKEN) return [standard];
  const enabled = new Set((process.env.PREMIUM_MODEL_PROVIDERS || '').split(',').map(id => id.trim()));
  return [standard, ...premium.filter(id => enabled.has(id)).map(id =>
    ({id, creditsPerScene, creditsPerDurationUnit, durationUnitSeconds, maxSceneSeconds}))];
}

function cost(scenes, frames) {
  return creditsPerScene * scenes + creditsPerDurationUnit * Math.ceil(frames / (durationUnitSeconds * FPS));
}

async function creditRequest(payload) {
  const token = process.env.PRODUCTION_BILLING_TOKEN;
  const unavailable = () => new Fault('CREDIT_SERVICE_UNAVAILABLE', 'The production credit service could not complete the request', {status: 503, retryable: true});
  if (!token) throw unavailable();
  let response;
  try {
    response = await fetch(new URL('/internal/production-credit', process.env.ACCOUNT_API_ORIGIN || 'http://127.0.0.1:3001'), {
      method: 'POST', headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload), signal: AbortSignal.timeout(8000), redirect: 'error',
    });
  } catch {
    throw unavailable();
  }
  const result = await response.json().catch(() => null);
  const code = result?.code;
  if (response.status === 402 && code === 'INSUFFICIENT_CREDITS') {
    throw new Fault('INSUFFICIENT_CREDITS', '可用 Credit 不足，需预留 ' + payload.amount + ' Credit。', {status: 402});
  }
  if (response.status === 403 && code === 'ACCOUNT_DISABLED') {
    throw new Fault('PREMIUM_LOGIN_REQUIRED', 'A valid active account is required', {status: 403});
  }
  if (!response.ok || !result) throw unavailable();
  return result;
}

export async function productionQuote(owner, provider, sceneCount) {
  if (!provider || provider === 'standard') return undefined;
  if (!owner?.startsWith('member:')) {
    throw new Fault('PREMIUM_LOGIN_REQUIRED', 'Sign in to use paid model providers', {status: 403});
  }
  if (!modelProviders({mode: 'member'}).some(item => item.id === provider)) {
    throw new Fault('MODEL_PROVIDER_UNAVAILABLE', 'This model provider is unavailable', {status: 503});
  }
  const userId = owner.slice('member:'.length);
  const amount = cost(sceneCount, sceneCount * maxSceneSeconds * FPS);
  const balance = await creditRequest({action: 'quote', userId});
  if (!Number.isSafeInteger(balance.available) || balance.available < amount) {
    throw new Fault('INSUFFICIENT_CREDITS', '可用 Credit 不足，需预留 ' + amount + ' Credit。', {status: 402});
  }
  return {userId, amount, sceneCount};
}

function requestFor(job, action, details) {
  const {projectId, revisionId, modelProvider: provider, billing: {userId, amount}} = job;
  return creditRequest({action, userId, projectId, revisionId, amount, provider, ...details});
}

export async function reserveProduction(job) {
  if (!modelProviders({mode: 'member'}).some(item => item.id === job.modelProvider)) {
    throw new Fault('MODEL_PROVIDER_UNAVAILABLE', 'This model provider is unavailable', {status: 503});
  }
  const result = await requestFor(job, 'reserve');
  if (result.state !== 'reserved') {
    throw new Fault('PRODUCTION_RESERVATION_CLOSED', 'The production reservation is closed', {status: 409});
  }
}

export async function settleProduction(job, status) {
  if (status !== 'succeeded') {
    const result = await requestFor(job, 'release');
    if (!['released', 'absent'].includes(result.state)) throw new Error('Invalid production release state');
    return {creditReserved: 0, creditCharged: 0};
  }
  const manifest = await read(join(revisionDir(job), 'manifest.json'));
  const scenes = manifest.scenes?.length;
  const frames = manifest.durationFrames;
  if (scenes !== job.billing.sceneCount || !Number.isSafeInteger(frames) || frames < 1 ||
    frames > scenes * maxSceneSeconds * FPS) throw new Error('Invalid billable production duration');
  const capturedAmount = cost(scenes, frames);
  const result = await requestFor(job, 'capture', {capturedAmount});
  if (result.state !== 'captured' || result.capturedAmount !== capturedAmount) throw new Error('Invalid production capture state');
  return {creditReserved: 0, creditCharged: capturedAmount};
}
