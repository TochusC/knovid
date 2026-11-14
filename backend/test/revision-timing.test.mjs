import assert from 'node:assert/strict';
import {mkdtemp, rm, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'knovid-revision-timing-'));
process.env.KNOVID_DATA = root;
const {createProject, revision, retryRevision} = await import('../src/projects.mjs');
const {groups} = await import('../src/activities/index.mjs');
const {json, revisionDir} = await import('../src/common.mjs');
const {checkpoint} = groups.workflow;
const executor = {start: async () => {}};
const payload = {input: {type: 'topic', title: 'Timing test'}, options: {language: 'zh'}};
const epoch = Date.parse('2026-11-14T06:00:00Z');
const stamp = seconds => new Date(epoch + seconds * 1000).toISOString();
const readRevision = job => revision(job.projectId, job.revisionId);

try {
  await test('elapsed production time includes queue time, freezes on failure, and resets for a new revision', async t => {
    t.mock.timers.enable({apis: ['Date'], now: epoch});
    const job = await createProject(executor, payload);
    assert.equal((await readRevision(job)).queuedAt, stamp(0));
    t.mock.timers.tick(2000);
    assert.equal((await readRevision(job)).elapsedSeconds, 2);
    const sameJob = await retryRevision(executor, job.projectId, job.revisionId);
    assert.equal(sameJob.revisionId, job.revisionId);
    assert.equal((await readRevision(sameJob)).queuedAt, stamp(0));

    await checkpoint(job, 'running', 'research');
    t.mock.timers.tick(3000);
    await checkpoint(job, 'running', 'scenes');
    assert.equal((await readRevision(job)).startedAt, stamp(2));
    t.mock.timers.tick(4000);
    await checkpoint(job, 'failed', 'failed');
    t.mock.timers.tick(1000);
    await checkpoint(job, 'failed', 'failed');

    const completed = await readRevision(job);
    assert.equal(completed.elapsedSeconds, 9);
    assert.equal(completed.finishedAt, stamp(9));
    assert.equal(completed.timingEstimated, false);

    const next = await retryRevision(executor, job.projectId, job.revisionId);
    assert.notEqual(next.revisionId, job.revisionId);
    const restarted = await readRevision(next);
    assert.equal(restarted.queuedAt, stamp(10));
    assert.equal(restarted.elapsedSeconds, 0);
    assert.equal(restarted.startedAt, undefined);
    assert.equal(restarted.finishedAt, undefined);
  });

  await test('older attempts estimate elapsed time from their own request file when it has a valid timestamp', async () => {
    const job = await createProject(executor, payload);
    const request = join(revisionDir(job), 'request.json');
    const status = join(revisionDir(job), 'status.json');
    await json(status, {status: 'succeeded', stage: 'complete', updatedAt: stamp(21)});
    await utimes(request, new Date(stamp(4)), new Date(stamp(4)));
    const legacy = await readRevision(job);
    assert.equal(legacy.queuedAt, stamp(4));
    assert.equal(legacy.finishedAt, stamp(21));
    assert.equal(legacy.elapsedSeconds, 17);
    assert.equal(legacy.timingEstimated, true);
    assert.equal(legacy.startedAt, undefined);

    await utimes(request, new Date(stamp(25)), new Date(stamp(25)));
    const missing = await readRevision(job);
    assert.equal(missing.queuedAt, undefined);
    assert.equal(missing.elapsedSeconds, undefined);
  });
} finally {
  await rm(root, {recursive: true, force: true});
}
