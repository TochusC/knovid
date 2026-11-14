export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export function creditAmount(value, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 2_147_483_647) {
    throw new AppError('INVALID_AMOUNT', 'Credit 必须是范围内的整数。');
  }
  return value;
}

export function requiredText(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new AppError('INVALID_INPUT', `${name} 无效。`);
  }
  return value.trim();
}

export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError('INVALID_INPUT', '账号 ID 无效。');
  }
  return value;
}

export function pageLimit(value = 20) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new AppError('INVALID_INPUT', 'limit 必须为 1 到 100 的整数。');
  }
  return value;
}
