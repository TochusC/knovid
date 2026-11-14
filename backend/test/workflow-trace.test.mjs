import assert from 'node:assert/strict';
import test from 'node:test';
import {temporalTraceReader, workflowTrace} from '../src/workflow-trace.mjs';

const time = seconds => ({seconds});
const iso = seconds => new Date(seconds * 1000).toISOString();
const event = (eventId, field, attributes, seconds = eventId) => ({eventId, eventTime: time(seconds), [field]: attributes});
const payloads = (...args) => ({payloads: args.map(arg => ({
  metadata: {encoding: Buffer.from('json/plain')}, data: Buffer.from(JSON.stringify(arg)),
}))});
const schedule = (eventId, activityId, name, ...args) => event(eventId, 'activityTaskScheduledEventAttributes', {
  activityId, activityType: {name}, input: payloads(...args),
});
const plain = value => JSON.parse(JSON.stringify(value));

test('reads publishable activity details from history and current retry/queue state', () => {
  const privateInput = {unrelated: 'private topic and narrative'};
  const events = [
    schedule(1, '8', 'makeMotion', privateInput, 's12', 'regenerate motion repair details'),
    event(2, 'activityTaskStartedEventAttributes', {scheduledEventId: 1, attempt: 2,
      lastFailure: {applicationFailureInfo: {type: 'LLM_HTTP_429'}, message: 'private failure context'}}),
    event(3, 'activityTaskCompletedEventAttributes', {scheduledEventId: 1, result: payloads('private output')}),
    schedule(4, '9', 'renderChunk', privateInput, 's2', 100, 199),
    schedule(5, '10', 'renderChunk', privateInput, 's2', 200, 299),
    schedule(6, '11', 'writeScript', privateInput, 's3'),
    schedule(7, '12', 'makeEvidence', privateInput),
    schedule(8, '13', 'unknownActivity', privateInput),
    schedule(9, '14', 'rejectFrame', privateInput, 's40'),
    event(10, 'activityTaskFailedEventAttributes', {scheduledEventId: 9,
      failure: {applicationFailureInfo: {type: 'unknown-private-failure'}, message: 'private failure'}}),
  ];
  const pending = [
    {activityId: '9', state: 2, attempt: 1, lastStartedTime: time(7)},
    {activityId: '10', state: 1, attempt: 3, lastStartedTime: time(6), nextAttemptScheduleTime: time(15),
      lastFailure: {applicationFailureInfo: {type: 'WorkerShutdown'}, message: 'private failure'}},
    {activityId: '11', state: 1, attempt: 1, scheduledTime: time(6)},
  ];
  const result = plain(workflowTrace(events, pending));
  assert.equal(result.source, 'temporal');
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  assert.deepEqual(result.activities, [
    {id: '8', name: 'makeMotion', kind: 'agent', sceneId: 's12', repair: true, status: 'succeeded',
      scheduledAt: iso(1), startedAt: iso(2), finishedAt: iso(3), attempt: 2, failureCode: 'LLM_HTTP_429'},
    {id: '9', name: 'renderChunk', kind: 'worker', sceneId: 's2', chunk: {fromFrame: 100, toFrame: 199},
      status: 'running', scheduledAt: iso(4), startedAt: iso(7), attempt: 1},
    {id: '10', name: 'renderChunk', kind: 'worker', sceneId: 's2', chunk: {fromFrame: 200, toFrame: 299},
      status: 'retrying', scheduledAt: iso(5), retryAt: iso(15), attempt: 3, failureCode: 'WorkerShutdown'},
    {id: '11', name: 'writeScript', kind: 'agent', sceneId: 's3', status: 'queued', scheduledAt: iso(6), attempt: 1},
    {id: '12', name: 'makeEvidence', kind: 'agent', status: 'queued', scheduledAt: iso(7)},
    {id: '14', name: 'rejectFrame', kind: 'worker', status: 'failed', scheduledAt: iso(9), finishedAt: iso(10)},
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('a closed workflow does not present abandoned activities as queued', () => {
  const result = plain(workflowTrace([
    schedule(1, '1', 'renderChunk', null, 's1', 120, 1499),
    schedule(2, '2', 'renderChunk', null, 's2', 1500, 1510),
    event(3, 'activityTaskTimedOutEventAttributes', {scheduledEventId: 1}),
    event(4, 'workflowExecutionFailedEventAttributes', {}),
  ], []));
  assert.deepEqual(result.activities.map(({status, finishedAt, failureCode, chunk}) => [status, finishedAt, failureCode, chunk]), [
    ['failed', iso(3), 'TASK_TIMEOUT', {fromFrame: 120, toFrame: 1499}],
    ['cancelled', iso(4), undefined, undefined],
  ]);
});

test('a paginated read shares concurrent polls and reports an unavailable source when Temporal fails', async () => {
  const pages = [];
  let descriptions = 0;
  const workflowId = 'knovid/project/revision';
  const client = {
    workflow: {getHandle: id => ({describe: async () => {
      assert.equal(id, workflowId);
      descriptions++;
      return {runId: 'run', closeTime: new Date(), raw: {pendingActivities: []}};
    }})},
    workflowService: {getWorkflowExecutionHistory: async request => {
      assert.deepEqual(request.execution, {workflowId, runId: 'run'});
      assert.equal(request.namespace, 'tests');
      pages.push(request.nextPageToken);
      return request.nextPageToken?.length
        ? {history: {events: [event(2, 'activityTaskCompletedEventAttributes', {scheduledEventId: 1})]}}
        : {history: {events: [schedule(1, '10', 'makePlan', null)]}, nextPageToken: Buffer.from('next')};
    }},
  };
  const connection = {withDeadline: (_end, callback) => callback()};
  const read = temporalTraceReader(client, connection, 'tests');
  const [first, second] = await Promise.all([read(workflowId), read(workflowId)]);
  assert.equal(first.activities[0].status, 'succeeded');
  assert.equal(first, second);
  assert.equal(first, await read(workflowId));
  assert.equal(descriptions, 1);
  assert.equal(pages.length, 2);

  const readUnavailable = temporalTraceReader(client, {withDeadline: async () => { throw Error('private failure'); }}, 'tests');
  assert.deepEqual({...await readUnavailable(workflowId), observedAt: undefined},
    {source: 'unavailable', activities: [], observedAt: undefined});
});
