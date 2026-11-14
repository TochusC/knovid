import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';

// Credentials are read from disk and written to a private staging file, never stdout.
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node prepare-env.mjs BACKEND_ENV OUTPUT');
const source = parseEnv(await readFile(input, 'utf8'));
if (!source.LLM_API_KEY?.trim()) throw new Error('backend/.env is missing LLM_API_KEY');
const allowed = [
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_PLAN_MODEL', 'LLM_FAST_MODEL',
  'LLM_MOTION_MODEL', 'TTS_VOICE_ZH', 'TTS_VOICE_EN',
  'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_MODEL', 'OPENROUTER_MODEL',
];
const config = {
  POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
  API_TOKEN: randomBytes(32).toString('hex'),
  PRODUCTION_BILLING_TOKEN: randomBytes(32).toString('hex'),
  KNOVID_MODE: 'live',
  MODEL_REPLICAS: '2', MODEL_CONCURRENCY: '1', MODEL_QUEUE_RATE: '2', AUDIO_CONCURRENCY: '1',
  RENDER_CONCURRENCY: '2', RENDERER_REPLICAS: '2', REMOTION_CONCURRENCY: '1', RENDER_CHUNK_FRAMES: '200',
  SIGNUP_CREDITS: '0', SESSION_TTL_SECONDS: '604800',
};
for (const key of allowed) if (source[key]?.trim()) config[key] = source[key];
config.PREMIUM_MODEL_PROVIDERS = [
  config.DEEPSEEK_API_KEY && 'deepseek', config.OPENROUTER_API_KEY && 'openrouter',
].filter(Boolean).join(',');
function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Multiline environment values are not supported');
  return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
}
await writeFile(output, Object.entries(config).map(([key, value]) => `${key}=${quote(value)}`).join('\n') + '\n', { mode: 0o600 });
