export function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
  return value;
}

export function computeConcurrency(role) {
  const defaults = {workflow: 8, research: 4, model: 3, audio: 2, render: 2, assembly: 2};
  return integerEnv(role.toUpperCase() + '_CONCURRENCY', defaults[role], 1, 64);
}
