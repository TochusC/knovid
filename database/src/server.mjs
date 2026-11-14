import { createServer } from 'node:http';
import { createDatabase, migrate, AccountService, CreditService, ProjectAccessService, createAccountHandler } from './index.mjs';
import { createProductionCreditHandler } from './http.mjs';

function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const db = createDatabase({ connectionString: process.env.DATABASE_URL });
let server;
try {
  const port = integerEnv('PORT', 3001, 1, 65535);
  const secureSetting = process.env.SECURE_COOKIES ?? 'true';
  if (!['true', 'false'].includes(secureSetting)) throw new Error('SECURE_COOKIES must be true or false');
  if (process.env.NODE_ENV === 'production' && secureSetting !== 'true') throw new Error('Production requires secure cookies');
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowedOrigins.length) throw new Error('ALLOWED_ORIGINS is required');
  const accounts = new AccountService(db, {
    signupCredits: integerEnv('SIGNUP_CREDITS', 0, 0, 2147483647),
    sessionTtlSeconds: integerEnv('SESSION_TTL_SECONDS', 604800, 1, 2592000),
  });
  const credits = new CreditService(db);
  const handler = createAccountHandler({ accounts, credits, allowedOrigins, secureCookies: secureSetting === 'true' });
  const handleProductionCredit = createProductionCreditHandler({
    credits, access: new ProjectAccessService(db), token: process.env.PRODUCTION_BILLING_TOKEN,
  });
  await migrate(db);
  server = createServer(async (req, res) => {
    try {
      if (await handleProductionCredit(req, res) || await handler(req, res)) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (req.url === '/api/account-health' && req.method === 'GET') {
        await db.query('SELECT 1');
        res.end(JSON.stringify({ status: 'ok', component: 'accounts-credits' }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 'NOT_FOUND', message: '接口不存在。' }));
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用。' }));
      } else res.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, process.env.HOST ?? '127.0.0.1', resolve);
  });
  console.log(`KnoVid account API listening on port ${port}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeIdleConnections();
    const timer = setTimeout(() => server.closeAllConnections(), 5000);
    timer.unref();
    await new Promise((resolve) => server.once('close', resolve));
    clearTimeout(timer);
    await db.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  // Report the error class/code, never a DSN/password-bearing connection error.
  console.error(`Account API could not start (${error.code ?? error.name}). Check database and environment configuration.`);
  if (server?.listening) server.close();
  await db.close();
  process.exitCode = 1;
}
