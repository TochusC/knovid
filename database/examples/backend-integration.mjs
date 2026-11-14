/**
 * Copyable integration helpers for the existing native Node HTTP backend.
 * Import this module; it does not start a second server or create a database.
 * Run migrations once during deployment, not for each incoming request.
 */
import { randomUUID } from 'node:crypto';
import { AccountService } from '../src/accounts.mjs';
import { CreditService } from '../src/credits.mjs';
import { ProjectAccessService } from '../src/access.mjs';
import { AppError } from '../src/errors.mjs';
import { createAccountHandler, getSessionToken } from '../src/http.mjs';

export function createAccountServices(db, {
  allowedOrigins = [],
  secureCookies = true,
  sessionTtlSeconds = 604800,
  signupCredits = 0,
} = {}) {
  const accounts = new AccountService(db, { sessionTtlSeconds, signupCredits });
  const credits = new CreditService(db);
  const access = new ProjectAccessService(db);
  const handleAccountRequest = createAccountHandler({ accounts, credits, allowedOrigins, secureCookies });
  // Copy after validation by createAccountHandler, so a caller cannot later expand it.
  const origins = new Set(allowedOrigins);
  return { accounts, credits, access, origins, handleAccountRequest };
}

/**
 * Use on EVERY project route, including creation, render/retry/export, reorder,
 * scene changes and protected media downloads. The account handler's Origin
 * policy only covers its own paths; it does not protect the host's project API.
 *
 * Handle project-route OPTIONS in the host's exact-origin CORS policy before
 * calling this helper. Do not use a wildcard with credentialed requests.
 */
export async function authenticateRequest(req, services) {
  const method = req.method || 'GET';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !services.origins.has(req.headers.origin)) {
    throw new AppError('ORIGIN_NOT_ALLOWED', '请求来源不被允许。', 403);
  }
  return services.accounts.authenticate(getSessionToken(req));
}

/** Authenticate AND check ownership before reading any project or artifact data. */
export async function requireProjectOwner(req, services, projectId) {
  const user = await authenticateRequest(req, services);
  await services.access.requireOwner({ projectId, userId: user.id });
  return user;
}

/**
 * Preserve the backend's existing project store. `saveProject` receives a
 * server-generated ID and trusted ownerId; input must already be validated by
 * the backend and must not override these fields when it builds its document.
 *
 * Ownership is written BEFORE making a new project visible. A failed save may
 * leave an unused ownership row; it cannot expose another account's project.
 * This is not a transaction across PostgreSQL and a filesystem/object store.
 * For idempotent project creation, the host should persist its request -> ID
 * mapping and recover interrupted saves instead of creating a new ID on retry.
 */
export async function createOwnedProject(req, services, validatedInput, saveProject) {
  const user = await authenticateRequest(req, services);
  const id = randomUUID();
  await services.access.bind({ projectId: id, userId: user.id });
  return saveProject({ id, ownerId: user.id, input: validatedInput });
}

/** List only authorized IDs; never return a global project list to the browser. */
export async function listOwnedProjects(req, services, readProjectsByIds) {
  const user = await authenticateRequest(req, services);
  const ids = await services.access.listProjectIds(user.id);
  return readProjectsByIds(ids);
}

/**
 * Wrap an existing native Node router. `handleApplicationRequest` must return
 * true when it handled a route and false otherwise. It must call the ownership
 * helpers above on project/media routes. This wrapper alone does not authorize
 * those routes. Keep the host's bounded JSON/multipart parsers and path checks.
 */
export function mountAccountRoutes(services, handleApplicationRequest) {
  return async (req, res) => {
    try {
      if (await services.handleAccountRequest(req, res)) return;
      if (await handleApplicationRequest(req, res, services)) return;
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: '接口不存在。' }));
    } catch (error) {
      // Never serialize a database/Temporal exception or its connection string.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = error instanceof AppError ? error.status : 500;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(error instanceof AppError
        ? { code: error.code, message: error.message }
        : { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' }));
    }
  };
}

/**
 * Register these ONLY with a trusted Temporal Worker. Do not expose them as
 * browser routes, and never call database code inside deterministic Workflows.
 * Workflow inputs must derive userId from the authenticated session and price
 * from a server-side quote. Amounts here are integer product credits, not money.
 *
 * Lifecycle enforced by the calling Workflow:
 *  1. Reserve before production, with a persisted operationKey and project
 *     revision. A Temporal retry uses exactly the same key and estimate.
 *  2. Capture only after durable successful production, using its recorded
 *     actual charge <= the reserved amount. Retrying capture uses that amount.
 *  3. Release only on CONFIRMED terminal failure/cancellation. Ordinary Activity
 *     retries or a workflow-start timeout do not prove work failed or stopped.
 *
 * There is deliberately no try/render/catch/refund wrapper: a timeout may mean
 * the render or workflow started successfully and only the response was lost.
 * Persist dispatch intent plus stable workflow ID; reconcile ambiguous starts
 * with Temporal and retry settlement/release until the ledger acknowledges it.
 */
export function makeCreditActivities(services) {
  return {
    reserveCredits: (input) => services.credits.reserve(input),
    captureCredits: (input) => services.credits.capture(input),
    releaseCredits: (input) => services.credits.release(input),
  };
}

/*
Native Node mount (inside backend/src/api.mjs, adapt relative paths):

  import { createServer } from 'node:http';
  import { createDatabase } from '../../database/src/db.mjs';
  import {
    createAccountServices, mountAccountRoutes, requireProjectOwner,
    createOwnedProject, listOwnedProjects,
  } from '../../database/examples/backend-integration.mjs';

  const db = createDatabase({ connectionString: process.env.DATABASE_URL });
  const services = createAccountServices(db, {
    allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    secureCookies: process.env.NODE_ENV === 'production',
  });
  const server = createServer(mountAccountRoutes(services, existingRouter));
  server.listen(3000, '127.0.0.1');

Inside existingRouter, BEFORE projectStore.get/update/render/download:

  const user = await requireProjectOwner(req, services, projectId);
  // Now access this project. Never get userId from req.body or query parameters.

For creation, AFTER validating the requested topic/PDF/settings:

  const project = await createOwnedProject(req, services, input,
    ({ id, ownerId, input }) => projectStore.create({ ...input, id, ownerId }));

For listing:

  const projects = await listOwnedProjects(req, services,
    (ids) => projectStore.readByIds(ids));

Apply the same ownership check to the backend's media/download routes. An
unguarded static directory with user artifacts bypasses otherwise-correct API
authorization. Generated render containers receive artifact references only,
never account cookies, PostgreSQL credentials or these trusted activity methods.

Frontend requests (Vite /api proxy is recommended):

  await fetch('/api/auth/login', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  await fetch('/api/credits', { credentials: 'include' });

Browsers set Origin themselves. Script callers must explicitly send one of the
configured origins for mutations. Do not put the session token in localStorage.
*/
