import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const storage = await mkdtemp(join(tmpdir(), 'knovid-production-credit-'));
process.env.KNOVID_DATA = storage;
process.env.PRODUCTION_BILLING_TOKEN = 'internal-test-only';
process.env.PREMIUM_MODEL_PROVIDERS = 'deepseek,openrouter';
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
  assert.deepEqual(modelProviders({mode: 'member'}).map(provider => provider.id), ['standard', 'deepseek', 'openrouter']);
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
});
