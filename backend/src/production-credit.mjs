import {Fault, FPS, read, revisionDir} from './common.mjs';
import {join} from 'node:path';
import {isModelId, modelCatalog} from './model-catalog.mjs';

const durationUnitSeconds = 30;
export const maxSceneSeconds = 60;

function listedModels(config) {
  return new Set((config || '').split(',').map(id => id.trim()));
}

function enabledPaidModel(id, enabled) {
  if (!isModelId(id) || !process.env.PRODUCTION_BILLING_TOKEN) return undefined;
  const model = modelCatalog[id];
  return model.creditMultiplier > 0 && (enabled.has(id) || enabled.has(model.gateway)) ? model : undefined;
}

function pricing(id, {gateway: provider, label, creditMultiplier}) {
  return {id, provider, label, creditMultiplier, creditsPerScene: creditMultiplier,
    creditsPerDurationUnit: creditMultiplier, durationUnitSeconds, maxSceneSeconds};
}

export function modelProviders(identity) {
  const available = [pricing('standard', modelCatalog.standard)];
  if (identity.mode !== 'member') return available;
  const enabled = listedModels(process.env.PREMIUM_MODEL_PROVIDERS);
  const blocked = listedModels(process.env.PRODUCTION_MODELS_REGION_BLOCKED);
  for (const [id, model] of Object.entries(modelCatalog)) {
    if (!model.legacy && enabledPaidModel(id, enabled)) {
      available.push({...pricing(id, model), ...(blocked.has(id) && {available: false, unavailableReason: 'region'})});
    }
  }
  return available;
}

function availablePaidModel(id) {
  if (listedModels(process.env.PRODUCTION_MODELS_REGION_BLOCKED).has(id)) {
    throw new Fault('MODEL_PROVIDER_REGION_UNAVAILABLE', 'This model is not available in the deployment region', {status: 503});
  }
  const model = enabledPaidModel(id, listedModels(process.env.PREMIUM_MODEL_PROVIDERS));
  if (!model) {
    throw new Fault('MODEL_PROVIDER_UNAVAILABLE', 'This model provider is unavailable', {status: 503});
  }
  return model;
}

function cost(scenes, frames, multiplier) {
  return multiplier * (scenes + Math.ceil(frames / (durationUnitSeconds * FPS)));
}

function billingMultiplier(billing) {
  // Older reservations used the fixed 1× rate.
  const multiplier = billing.creditMultiplier ?? 1;
  if (!Number.isSafeInteger(multiplier) || multiplier < 1) throw new Error('Invalid billing multiplier');
  return multiplier;
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

export async function productionQuote(owner, provider, sceneCount, previousBilling) {
  if (!provider || provider === 'standard') return undefined;
  if (!owner?.startsWith('member:')) {
    throw new Fault('PREMIUM_LOGIN_REQUIRED', 'Sign in to use paid model providers', {status: 403});
  }
  const model = availablePaidModel(provider);
  const userId = owner.slice('member:'.length);
  const creditMultiplier = previousBilling ? billingMultiplier(previousBilling) : model.creditMultiplier;
  const amount = cost(sceneCount, sceneCount * maxSceneSeconds * FPS, creditMultiplier);
  const balance = await creditRequest({action: 'quote', userId});
  if (!Number.isSafeInteger(balance.available) || balance.available < amount) {
    throw new Fault('INSUFFICIENT_CREDITS', '可用 Credit 不足，需预留 ' + amount + ' Credit。', {status: 402});
  }
  return {userId, amount, sceneCount, creditMultiplier};
}

function requestFor(job, action, details) {
  const {projectId, revisionId, modelProvider: provider, billing: {userId, amount}} = job;
  return creditRequest({action, userId, projectId, revisionId, amount, provider, ...details});
}

export async function reserveProduction(job) {
  availablePaidModel(job.modelProvider);
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
  const capturedAmount = cost(scenes, frames, billingMultiplier(job.billing));
  if (capturedAmount > job.billing.amount) throw new Error('Production charge exceeds its reservation');
  const result = await requestFor(job, 'capture', {capturedAmount});
  if (result.state !== 'captured' || result.capturedAmount !== capturedAmount) throw new Error('Invalid production capture state');
  return {creditReserved: 0, creditCharged: capturedAmount};
}
