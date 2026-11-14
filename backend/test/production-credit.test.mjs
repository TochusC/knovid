import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const storage = await mkdtemp(join(tmpdir(), 'knovid-production-credit-'));
process.env.KNOVID_DATA = storage;
process.env.PRODUCTION_BILLING_TOKEN = 'internal-test-only';
process.env.PREMIUM_MODEL_PROVIDERS = 'glm, deepseek, openrouter';
const {modelProviders, productionQuote, reserveProduction, settleProduction} = await import('../src/production-credit.mjs');
const {json, revisionDir} = await import('../src/common.mjs');

test('paid selection requires a member and reserves for scenes before settling by actual frames', async t => {
  t.after(() => rm(storage, {recursive: true, force: true}));
  let available = 8;
  let reservation;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url.pathname, '/internal/production-credit');
    assert.equal(request.headers.Authorization, 'Bearer internal-test-only');
    const body = JSON.parse(request.body);
    requests.push(body);
    switch (body.action) {
      case 'quote': return Response.json({available});
      case 'reserve': {
        if (reservation) return Response.json(reservation);
        if (available < body.amount) return Response.json({code: 'INSUFFICIENT_CREDITS'}, {status: 402});
        reservation = {state: 'reserved'};
        return Response.json(reservation);
      }
      case 'capture': {
        reservation = {state: 'captured', capturedAmount: body.capturedAmount};
        return Response.json(reservation);
      }
      case 'release': return Response.json({state: 'released'});
      default: assert.fail('Unexpected billing operation');
    }
  });
  assert.deepEqual(modelProviders({mode: 'guest'}).map(provider => provider.id), ['standard']);
  assert.deepEqual(modelProviders({mode: 'member'}).map(({id, provider, creditMultiplier}) => [id, provider, creditMultiplier]), [
    ['standard', 'glm', 0], ['glm-5.3', 'glm', 1],
    ['deepseek', 'deepseek', 1], ['deepseek-pro', 'deepseek', 2],
    ['openrouter-astra', 'openrouter', 3], ['openrouter-sol', 'openrouter', 2],
  ]);
  const astraPricing = modelProviders({mode: 'member'}).find(({id}) => id === 'openrouter-astra');
  assert.equal(astraPricing.label, 'GPT-6 Astra');
  assert.equal(astraPricing.creditsPerScene, 3);
  assert.equal(astraPricing.creditsPerDurationUnit, 3);
  assert.equal(await productionQuote('guest:id', 'standard', 3), undefined);
  await assert.rejects(productionQuote('guest:id', 'glm-5.3', 3), {code: 'PREMIUM_LOGIN_REQUIRED'});
  await assert.rejects(productionQuote('guest:id', 'deepseek', 3), {code: 'PREMIUM_LOGIN_REQUIRED'});
  assert.equal(requests.length, 0);
  await assert.rejects(productionQuote('member:id', 'deepseek', 3), {code: 'INSUFFICIENT_CREDITS', status: 402});
  available = 9;
  const billing = await productionQuote('member:id', 'deepseek', 3);
  assert.equal(billing.amount, 9);
  const job = {projectId: 'project', revisionId: 'revision', modelProvider: 'deepseek', billing};
  available = 8;
  await assert.rejects(reserveProduction(job), {code: 'INSUFFICIENT_CREDITS', status: 402});
  available = 9;
  await reserveProduction(job);
  await json(join(revisionDir(job), 'manifest.json'), {scenes: [{}, {}, {}], durationFrames: 751});
  assert.deepEqual(await settleProduction(job, 'succeeded'), {creditReserved: 0, creditCharged: 5});
  assert.equal(requests.at(-1).capturedAmount, 5);
  assert.equal(requests.at(-1).amount, 9);
  assert.deepEqual(await settleProduction({...job, revisionId: 'failed-revision'}, 'failed'), {creditReserved: 0, creditCharged: 0});

  available = 26;
  await assert.rejects(productionQuote('member:id', 'openrouter-astra', 3), {code: 'INSUFFICIENT_CREDITS', status: 402});
  available = 27;
  const astra = await productionQuote('member:id', 'openrouter-astra', 3);
  assert.deepEqual(astra, {userId: 'id', amount: 27, sceneCount: 3, creditMultiplier: 3});
  reservation = undefined;
  const astraJob = {...job, modelProvider: 'openrouter-astra', billing: astra};
  await reserveProduction(astraJob);
  assert.equal(requests.at(-1).provider, 'openrouter-astra');
  assert.deepEqual(await settleProduction(astraJob, 'succeeded'), {creditReserved: 0, creditCharged: 15});
  assert.equal(requests.at(-1).capturedAmount, 15);

  const oldBilling = {userId: 'id', amount: 9, sceneCount: 3};
  const legacy = await productionQuote('member:id', 'openrouter', 3, oldBilling);
  assert.equal(legacy.amount, 9);
  assert.equal(legacy.creditMultiplier, 1);
  assert.deepEqual(await settleProduction({...job, modelProvider: 'openrouter', billing: oldBilling}, 'succeeded'),
    {creditReserved: 0, creditCharged: 5});
  assert.equal(requests.at(-1).provider, 'openrouter');
  assert.equal((await productionQuote('member:id', 'deepseek-pro', 3)).amount, 18);
  assert.equal((await productionQuote('member:id', 'openrouter-sol', 3)).amount, 18);
  assert.equal((await productionQuote('member:id', 'glm-5.3', 3)).amount, 9);

  const previousBlocked = process.env.PRODUCTION_MODELS_REGION_BLOCKED;
  t.after(() => {
    if (previousBlocked === undefined) delete process.env.PRODUCTION_MODELS_REGION_BLOCKED;
    else process.env.PRODUCTION_MODELS_REGION_BLOCKED = previousBlocked;
  });
  process.env.PRODUCTION_MODELS_REGION_BLOCKED = 'openrouter-astra, openrouter-sol';
  const blockedAstra = modelProviders({mode: 'member'}).find(({id}) => id === 'openrouter-astra');
  assert.deepEqual(blockedAstra, {...astraPricing, available: false, unavailableReason: 'region'});
  assert.notEqual(modelProviders({mode: 'member'}).find(({id}) => id === 'deepseek-pro').available, false);
  const requestsBeforeRejection = requests.length;
  await assert.rejects(productionQuote('member:id', 'openrouter-astra', 3), {code: 'MODEL_PROVIDER_REGION_UNAVAILABLE', status: 503});
  await assert.rejects(reserveProduction({...astraJob, revisionId: 'unstarted'}), {code: 'MODEL_PROVIDER_REGION_UNAVAILABLE', status: 503});
  assert.equal(requests.length, requestsBeforeRejection);
  assert.deepEqual(await settleProduction(astraJob, 'succeeded'), {creditReserved: 0, creditCharged: 15});
  assert.deepEqual(await settleProduction({...astraJob, revisionId: 'blocked-failure'}, 'failed'),
    {creditReserved: 0, creditCharged: 0});
});
