import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {ask, modelConfig} from '../src/llm.mjs';

test('the compatible gateway discovers models, authenticates and escalates an invalid answer', async () => {
  const requested = [];
  const server = createServer(async (req, res) => {
    requested.push(req.url);
    assert.equal(req.headers.authorization, 'Bearer local-test-only');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({data: [{id: 'claude-opus-test'}, {id: 'gpt-5-mini'}]}));
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
    requested.push(body.model);
    const answer = body.model === 'gpt-5-mini' ? '{"unknown":true}' : '\x60\x60\x60json\n{"answer":42}\n\x60\x60\x60';
    res.end(JSON.stringify({choices: [{message: {content: answer}}]}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.LLM_BASE_URL = 'http://127.0.0.1:' + server.address().port + '/v1';
  process.env.LLM_API_KEY = 'local-test-only';
  delete process.env.LLM_PLAN_MODEL;
  delete process.env.LLM_FAST_MODEL;
  try {
    const result = await ask({
      role: 'Writer', instructions: 'Provide answer', input: {example: true}, signal: AbortSignal.timeout(5000),
      validate(value) { assert.equal(typeof value.answer, 'number'); return value.answer; },
    });
    assert.deepEqual(result, {value: 42, model: 'claude-opus-test'});
    assert.deepEqual(requested, ['/v1/models', '/v1/chat/completions', 'gpt-5-mini', '/v1/chat/completions', 'claude-opus-test']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('long GLM jobs collect streamed JSON and ignore reasoning-only chunks', async () => {
  const server = createServer(async (req, res) => {
    const request = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
    assert.equal(request.stream, true);
    assert.deepEqual(request.thinking, {type: 'disabled'});
    res.setHeader('Content-Type', 'text/event-stream');
    const event = (choice) => 'data: ' + JSON.stringify({choices: [choice]}) + '\r\n\r\n';
    res.write(event({delta: {reasoning_content: 'hidden'}}));
    res.write(event({delta: {content: '{"ans'}}));
    res.write(event({delta: {content: 'wer":"月亮"}'}}));
    res.end(event({delta: {}, finish_reason: 'stop'}) + 'data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.LLM_BASE_URL = 'http://127.0.0.1:' + server.address().port + '/v1';
  process.env.LLM_API_KEY = 'local-test-only';
  process.env.LLM_PLAN_MODEL = 'glm-5.3';
  process.env.LLM_FAST_MODEL = 'glm-5.3-flash';
  try {
    const result = await ask({
      role: 'Director', tier: 'plan', instructions: 'Provide answer', input: {}, signal: AbortSignal.timeout(5000),
      validate: result => result.answer,
    });
    assert.deepEqual(result, {model: 'glm-5.3', value: '月亮'});
  } finally {
    delete process.env.LLM_PLAN_MODEL;
    delete process.env.LLM_FAST_MODEL;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('HighSpeed motion requests use the full output budget', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'glm-5.1-highspeed');
    assert.equal(body.max_tokens, 131_072);
    return Response.json({choices: [{message: {content: '{"ok":true}'}}]});
  });
  process.env.LLM_BASE_URL = 'https://sec.llm.autos/v1';
  process.env.LLM_API_KEY = 'local-test-only';
  t.after(() => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
  });
  const result = await ask({
    role: 'Motion Designer', tier: 'motion', instructions: 'Return JSON', input: {},
    signal: AbortSignal.timeout(5000), validate: value => value.ok,
  });
  assert.deepEqual(result, {model: 'glm-5.1-highspeed', value: true});
});

test('paid providers send distinct credentials to their configured gateways', async t => {
  const env = ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_MODEL', 'OPENROUTER_MODEL'];
  const previous = new Map(env.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.DEEPSEEK_API_KEY = 'test-deepseek';
  process.env.OPENROUTER_API_KEY = 'test-openrouter';
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.OPENROUTER_MODEL;
  const requests = [];
  const fetch = t.mock.method(globalThis, 'fetch', async (url, request) => {
    requests.push({url, authorization: request.headers.Authorization, body: JSON.parse(request.body)});
    return Response.json({choices: [{message: {content: '{"ok":true}'}}]});
  });
  const prompt = {role: 'Writer', instructions: 'Return JSON', input: {}, signal: AbortSignal.timeout(5000), validate: value => value.ok};
  const results = await Promise.all([
    ask({...prompt, modelProvider: 'deepseek'}),
    ask({...prompt, modelProvider: 'openrouter'}),
  ]);
  assert.deepEqual(results, [
    {model: 'deepseek-flash', value: true},
    {model: 'deepseek/deepseek-v4.1-flash-1017', value: true},
  ]);
  assert.deepEqual(requests.map(({url, authorization}) => [url, authorization]), [
    ['https://api.deepseek.com/chat/completions', 'Bearer test-deepseek'],
    ['https://openrouter.ai/api/v1/chat/completions', 'Bearer test-openrouter'],
  ]);
  assert.deepEqual(requests[0].body.thinking, {type: 'disabled'});
  assert.deepEqual(requests[1].body.reasoning, {enabled: false});
  assert.deepEqual(requests[0].body.response_format, {type: 'json_object'});
  assert.deepEqual(requests[1].body.response_format, {type: 'json_object'});
  assert.doesNotMatch(JSON.stringify([modelConfig('deepseek'), modelConfig('openrouter'), results]), /test-deepseek|test-openrouter/);

  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(ask({...prompt, modelProvider: 'openrouter'}), {code: 'LLM_NOT_CONFIGURED'});
  await assert.rejects(ask({...prompt, modelProvider: '__proto__'}), {code: 'INVALID_MODEL_PROVIDER'});
  assert.equal(fetch.mock.callCount(), 2);
});

function rateLimitProbe(t, fetch, signal = AbortSignal.timeout(5000)) {
  t.mock.method(globalThis, 'fetch', fetch);
  process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
  process.env.LLM_API_KEY = 'local-test-only';
  process.env.LLM_PLAN_MODEL = 'plan-model';
  process.env.LLM_FAST_MODEL = 'fast-model';
  t.after(() => {
    delete process.env.LLM_PLAN_MODEL;
    delete process.env.LLM_FAST_MODEL;
  });
  return ask({role: 'Writer', instructions: 'Provide an answer', input: {}, signal, validate: value => value.answer});
}

test('rate limited completions wait and retry the same model', async t => {
  const requests = [];
  const result = await rateLimitProbe(t, (_url, request) => {
    requests.push({time: performance.now(), model: JSON.parse(request.body).model});
    return requests.length === 1
      ? new Response(null, {status: 429, headers: {'Retry-After': '2'}})
      : Response.json({choices: [{message: {content: '{"answer":42}'}}]});
  });
  assert.deepEqual(result, {model: 'fast-model', value: 42});
  assert.deepEqual(requests.map(request => request.model), ['fast-model', 'fast-model']);
  assert.ok(requests[1].time - requests[0].time >= 1900);
});

test('long Retry-After dates are passed to the activity scheduler without a fallback request', async t => {
  const request = t.mock.fn(() => new Response(null, {
    status: 429, headers: {'Retry-After': new Date(Date.now() + 120_000).toUTCString()},
  }));
  await assert.rejects(rateLimitProbe(t, request), error =>
    error.code === 'LLM_HTTP_429' && error.retryable && error.retryAfterMs > 100_000 && error.retryAfterMs <= 120_000);
  assert.equal(request.mock.callCount(), 1);
});

test('a Retry-After beyond the scheduling limit does not trigger an early retry', async t => {
  const request = t.mock.fn(() => new Response(null, {status: 429, headers: {'Retry-After': '999999999999'}}));
  await assert.rejects(rateLimitProbe(t, request), error => error.code === 'LLM_HTTP_429' && !error.retryable);
  assert.equal(request.mock.callCount(), 1);
});

test('cancellation interrupts a model rate limit wait', async t => {
  const controller = new AbortController();
  const request = t.mock.fn(() => {
    setTimeout(() => controller.abort(), 10);
    return new Response(null, {status: 429, headers: {'Retry-After': '10'}});
  });
  await assert.rejects(rateLimitProbe(t, request, controller.signal), {name: 'AbortError'});
  assert.equal(request.mock.callCount(), 1);
});

test('Motion Designer retries truncated output with a shorter prompt and logs bounded diagnostics', async t => {
  const log = t.mock.method(console, 'warn', () => {});
  const requests = [];
  t.mock.method(globalThis, 'fetch', (_url, request) => {
    requests.push(JSON.parse(request.body));
    if (requests.length === 1) {
      const event = JSON.stringify({choices: [{delta: {}, finish_reason: 'length'}]});
      return new Response('data: ' + event + '\n\n', {headers: {'Content-Type': 'text/event-stream'}});
    }
    return Response.json({choices: [{message: {content: '{"answer":42}'}}]});
  });
  process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1';
  process.env.LLM_API_KEY = 'local-test-only';
  process.env.LLM_PLAN_MODEL = 'plan-model';
  process.env.LLM_FAST_MODEL = 'fast-model';
  process.env.LLM_MOTION_MODEL = 'glm-motion';
  t.after(() => {
    delete process.env.LLM_PLAN_MODEL;
    delete process.env.LLM_FAST_MODEL;
    delete process.env.LLM_MOTION_MODEL;
  });
  const logContext = {projectId: 'project', revisionId: 'revision', sceneId: 's1'};
  await assert.rejects(ask({
    role: 'Motion Designer', tier: 'motion', instructions: 'Provide an answer', input: {topic: 'user input'},
    signal: AbortSignal.timeout(5000), logContext,
    validate() { throw new Error('untrusted model response'); },
  }), {
    code: 'LLM_SCHEMA',
    message: 'Motion Designer returned invalid content: The response does not match the expected format',
  });
  const correction = JSON.parse(requests[1].messages[1].content);
  assert.match(correction.schemaCorrection, /output limit/);
  assert.match(correction.request, /shorten the Canvas code/);
  assert.deepEqual(log.mock.calls.map(call => JSON.parse(call.arguments[0])), [
    {event: 'motion_schema_rejected', reason: 'OUTPUT_LIMIT', model: 'glm-motion', attempt: 1, ...logContext},
    {event: 'motion_schema_rejected', reason: 'INVALID_CONTENT', model: 'plan-model', attempt: 2, ...logContext},
  ]);
});
