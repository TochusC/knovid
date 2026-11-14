export const modelCatalog = {
  standard: {
    gateway: 'glm',
    label: 'GLM-5.1 HighSpeed',
    creditMultiplier: 0,
  },
  'glm-5.3': {
    gateway: 'glm',
    label: 'GLM-5.3',
    modelEnv: 'GLM_53_MODEL',
    upstreamModel: 'glm-5.3',
    creditMultiplier: 1,
  },
  deepseek: {
    gateway: 'deepseek',
    label: 'DeepSeek 4.1 Flash',
    modelEnv: 'DEEPSEEK_MODEL',
    upstreamModel: 'deepseek-flash',
    creditMultiplier: 1,
  },
  'deepseek-pro': {
    gateway: 'deepseek',
    label: 'DeepSeek 4.0 Pro',
    modelEnv: 'DEEPSEEK_PRO_MODEL',
    upstreamModel: 'deepseek-v4-pro',
    creditMultiplier: 2,
  },
  'openrouter-astra': {
    gateway: 'openrouter',
    label: 'GPT-6 Astra',
    modelEnv: 'OPENROUTER_ASTRA_MODEL',
    upstreamModel: 'openai/gpt-6-astra',
    creditMultiplier: 3,
  },
  'openrouter-sol': {
    gateway: 'openrouter',
    label: 'GPT-6.1 Sol',
    modelEnv: 'OPENROUTER_SOL_MODEL',
    upstreamModel: 'openai/gpt-6.1-sol',
    creditMultiplier: 2,
  },
  // Existing projects keep the original OpenRouter upstream model and price.
  openrouter: {
    gateway: 'openrouter',
    label: 'DeepSeek 4.1 Flash',
    modelEnv: 'OPENROUTER_MODEL',
    upstreamModel: 'deepseek/deepseek-v4.1-flash-1017',
    creditMultiplier: 1,
    legacy: true,
  },
};

export function isModelId(value) {
  return typeof value === 'string' && Object.hasOwn(modelCatalog, value);
}
