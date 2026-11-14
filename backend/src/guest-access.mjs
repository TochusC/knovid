import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdir, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {Fault, json, maybe, projectDir, read, root, sleep} from './common.mjs';
import {listProjects, metadata, withProjectLock} from './projects.mjs';
import {narrationBudget} from './guest-limits.mjs';
import {guestSceneCount} from './scene-limits.mjs';

export const guestLimits = Object.freeze({maxDurationSeconds: 30, maxGenerations: 3, maxRetriesPerProject: 2});
const cookieName = 'knovid_guest';
const storage = join(root, 'access');
const digest = value => createHash('sha256').update(value).digest('hex');
const ledgerFile = identity => join(storage, 'guests', identity.id + '.json');
const blank = () => ({generations: 0, retries: {}, reservations: []});

function cookie(request, name) {
  const matches = String(request.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : undefined;
}

export async function authenticateAccount(request) {
  const token = cookie(request, 'knovid_session');
  if (!token && !String(request.headers.cookie || '').includes('knovid_session=')) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Fault('UNAUTHENTICATED', 'Please sign in again', {status: 401});
  let response;
  try {
    const origin = process.env.ACCOUNT_API_ORIGIN || 'http://127.0.0.1:3001';
    response = await fetch(new URL('/api/auth/me', origin), {
      headers: {cookie: 'knovid_session=' + token, Accept: 'application/json'},
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
  } catch {
    throw new Fault('ACCOUNT_SERVICE_UNAVAILABLE', 'The account service could not verify the session', {status: 503});
  }
  if (response.status === 401) throw new Fault('UNAUTHENTICATED', 'Please sign in again', {status: 401});
  if (!response.ok) throw new Fault('ACCOUNT_SERVICE_UNAVAILABLE', 'The account service could not verify the session', {status: 503});
  const payload = await response.json().catch(() => null);
  if (!payload?.user?.id || payload.user.status !== 'active') throw new Fault('ACCOUNT_SERVICE_UNAVAILABLE', 'Account verification returned an invalid response', {status: 503});
  return payload.user;
}

export async function resolveIdentity(request, response, authenticate = authenticateAccount) {
  const member = await authenticate(request);
  if (member) {
    if (typeof member.id !== 'string' || !member.id) throw new Fault('ACCOUNT_SERVICE_UNAVAILABLE', 'Account verification returned an invalid identity', {status: 503});
    const identity = {mode: 'member', id: member.id, owner: 'member:' + member.id, displayName: member.displayName};
    await claimGuestProjects(request, identity);
    return identity;
  }
  let token = cookie(request, cookieName);
  let id = /^[a-f0-9]{64}$/.test(token || '') ? digest(token) : undefined;
  if (!id || !(await maybe(join(storage, 'guests', id + '.json')))) {
    token = randomBytes(32).toString('hex');
    id = digest(token);
    await json(join(storage, 'guests', id + '.json'), blank());
    const secure = process.env.NODE_ENV === 'production' || request.socket.encrypted;
    response.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`);
  }
  return {mode: 'guest', id, owner: 'guest:' + id};
}

export async function accessSnapshot(identity) {
  if (identity.mode === 'member') return {
    mode: 'member', displayName: identity.displayName,
    limits: {maxDurationSeconds: null, maxGenerations: null, maxRetriesPerProject: null},
    usage: {generations: 0}, remainingGenerations: null, canGenerate: true,
  };
  const state = await read(ledgerFile(identity));
  const remainingGenerations = Math.max(0, guestLimits.maxGenerations - state.generations);
  return {mode: 'guest', limits: guestLimits, usage: {generations: state.generations}, remainingGenerations, canGenerate: remainingGenerations > 0};
}

export async function requireOwner(identity, project) {
  if (project.owner !== identity.owner) throw new Fault('NOT_FOUND', 'Project or revision does not exist', {status: 404});
}

export async function projectAccess(identity, projectId, revisionStatus, options, sourceRevisionId) {
  const access = await accessSnapshot(identity);
  const state = identity.mode === 'guest' ? await read(ledgerFile(identity)) : null;
  const remainingRetries = state ? Math.max(0, guestLimits.maxRetriesPerProject - (state.retries[projectId] || 0)) : null;
  let editable = revisionStatus === 'succeeded';
  if (['failed', 'cancelled'].includes(revisionStatus) && sourceRevisionId) {
    const source = await read(join(projectDir(projectId), 'revisions', sourceRevisionId, 'status.json'));
    editable = source.status === 'succeeded';
  }
  return {
    canEdit: editable && access.canGenerate,
    canRetry: ['queued', 'failed', 'cancelled'].includes(revisionStatus) && (remainingRetries === null || remainingRetries > 0),
    remainingGenerations: access.remainingGenerations, remainingRetries,
    maxDurationSeconds: options?.maxDurationSeconds ?? access.limits.maxDurationSeconds,
    maxNarrationCharacters: options ? narrationBudget(options) ?? null : null,
  };
}

async function claimGuestProjects(request, member) {
  const token = cookie(request, cookieName);
  if (!/^[a-f0-9]{64}$/.test(token || '')) return;
  const guest = {id: digest(token), owner: 'guest:' + digest(token)};
  if (!(await maybe(ledgerFile(guest)))) return;
  await locked(guest, async () => {
    const state = await read(ledgerFile(guest));
    if (state.claimedGenerations === state.generations) return;
    for (const project of await listProjects()) {
      if (project.owner === guest.owner) await withProjectLock(project.id, async () => {
        const current = await metadata(project.id);
        if (current.owner === guest.owner) await json(join(projectDir(project.id), 'project.json'), {...current, owner: member.owner});
      });
    }
    state.claimedGenerations = state.generations;
    await json(ledgerFile(guest), state);
  });
}

async function locked(identity, callback) {
  const lock = join(storage, 'locks', identity.id);
  await mkdir(join(storage, 'locks'), {recursive: true});
  const deadline = Date.now() + 12000;
  while (true) {
    try { await mkdir(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = await stat(lock).catch(() => null);
      if (age && Date.now() - age.mtimeMs > 120000) await rm(lock, {recursive: true, force: true});
      if (Date.now() >= deadline) throw new Fault('GUEST_BUSY', 'Another request is being saved, please retry shortly', {status: 409});
      await sleep(25);
    }
  }
  try { return await callback(); } finally { await rm(lock, {recursive: true, force: true}); }
}

// Reserve before dispatch so a crash cannot turn a saved generation into a free operation.
export async function limitedOperation(identity, kind, projectId, action) {
  if (identity.mode !== 'guest') return action();
  return locked(identity, async () => {
    if (projectId) await requireOwner(identity, await metadata(projectId));
    const state = await read(ledgerFile(identity));
    const retry = kind === 'retry';
    if (retry && (state.retries[projectId] || 0) >= guestLimits.maxRetriesPerProject) {
      throw new Fault('GUEST_RETRY_LIMIT', 'This trial project has used its two retries', {status: 429});
    }
    if (!retry && state.generations >= guestLimits.maxGenerations) {
      throw new Fault('GUEST_LIMIT_REACHED', 'The three trial generations have been used', {status: 429});
    }
    const reservation = randomUUID();
    if (retry) state.retries[projectId] = (state.retries[projectId] || 0) + 1;
    else state.generations++;
    state.reservations.push({id: reservation, kind, projectId, createdAt: new Date().toISOString()});
    await json(ledgerFile(identity), state);
    try {
      const result = await action();
      Object.assign(state.reservations.find(item => item.id === reservation), {projectId: result.projectId, revisionId: result.revisionId});
      await json(ledgerFile(identity), state);
      return result;
    } catch (error) {
      // Validation and stale-version faults cannot have dispatched a new job.
      if (error instanceof Fault && [400, 404, 409].includes(error.status)) {
        if (retry) state.retries[projectId]--;
        else state.generations--;
        state.reservations = state.reservations.filter(item => item.id !== reservation);
        await json(ledgerFile(identity), state);
      }
      throw error;
    }
  });
}

export function limitPayload(identity, payload) {
  if (identity.mode !== 'guest') return payload;
  return {...payload, options: {...payload.options, sceneCount: guestSceneCount, maxDurationSeconds: guestLimits.maxDurationSeconds}};
}
