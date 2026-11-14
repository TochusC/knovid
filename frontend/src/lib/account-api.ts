export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface CreditBalance {
  balance: number;
  reserved: number;
  available: number;
}

export interface CreditEntry {
  id: string;
  kind: "grant" | "reserve" | "capture" | "release";
  reservationId: string | null;
  deltaBalance: number;
  deltaReserved: number;
  balanceAfter: number;
  reservedAfter: number;
  reason: string;
  createdAt: string;
}

export interface CreditLedger {
  entries: CreditEntry[];
  nextCursor: string | null;
}

export class AccountApiError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string) {
    super(message);
    this.name = "AccountApiError";
  }
}

const baseUrl = (import.meta.env.VITE_API_BASE_URL?.trim() || "/api").replace(/\/$/, "");

const errorTranslations: Record<string, string> = {
  INVALID_CREDENTIALS: "邮箱或密码不正确，请重新输入。",
  UNAUTHENTICATED: "登录已过期，请重新登录。",
  EMAIL_EXISTS: "这个邮箱已经注册，可以直接登录。",
  RATE_LIMITED: "尝试次数较多，请稍后再试。",
  ORIGIN_NOT_ALLOWED: "当前页面地址尚未获准访问账号服务，请联系项目管理员。",
  CORS_NOT_ALLOWED: "当前页面暂时无法访问账号服务，请联系项目管理员。",
  ACCOUNT_DISABLED: "账号已停用，请联系项目管理员。",
  ACCOUNT_UNAVAILABLE: "账号暂时不可用，请稍后重试。",
  INSUFFICIENT_CREDITS: "可用 Credit 不足。",
  INTERNAL_ERROR: "账号服务暂时不可用，请稍后重试。",
};

function readableError(status: number, payload: unknown): AccountApiError {
  const body = payload && typeof payload === "object"
    ? payload as { code?: string; message?: string }
    : {};
  const code = typeof body.code === "string" ? body.code : undefined;
  const message = typeof body.message === "string" ? body.message : "";
  if (code && errorTranslations[code]) return new AccountApiError(errorTranslations[code], status, code);
  if (code === "INVALID_INPUT") {
    if (message.includes("Password")) return new AccountApiError("密码需要包含 12 至 128 个字符。", status, code);
    if (message.toLowerCase().includes("email")) return new AccountApiError("请输入有效的邮箱地址。", status, code);
    if (message.includes("Display name")) return new AccountApiError("昵称需要包含 1 至 80 个字符。", status, code);
  }
  if (status === 401) return new AccountApiError("登录已过期，请重新登录。", status, code);
  if (status === 404) return new AccountApiError("账号服务尚未就绪，请稍后重试。", status, code);
  if (status === 429) return new AccountApiError("尝试次数较多，请稍后再试。", status, code);
  if (status >= 500) return new AccountApiError("账号服务暂时无法连接，请稍后重试。", status, code);
  if (/[\u3400-\u9fff]/.test(message)) return new AccountApiError(message, status, code);
  return new AccountApiError("请求暂时未能完成，请稍后重试。", status, code);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { signal, ...fetchOptions } = options;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort("timeout"), 15_000);
  const headers = new Headers(fetchOptions.headers);
  headers.set("Accept", "application/json");
  if (fetchOptions.body) headers.set("Content-Type", "application/json");

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...fetchOptions,
      credentials: "include",
      headers,
      signal: controller.signal,
    });
    if (response.status === 204) return undefined as T;
    const isJson = response.headers.get("content-type")?.includes("json");
    const payload: unknown = isJson ? await response.json() : undefined;
    if (!response.ok) throw readableError(response.status, payload);
    if (!isJson) throw new AccountApiError("账号服务返回异常，请稍后重试。", response.status, "INVALID_RESPONSE");
    return payload as T;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof AccountApiError) throw error;
    if (controller.signal.aborted) throw new AccountApiError("连接账号服务超时，请重试。", 0, "TIMEOUT");
    if (error instanceof SyntaxError) throw new AccountApiError("账号服务返回异常，请稍后重试。", 0, "INVALID_RESPONSE");
    throw new AccountApiError("暂时无法连接账号服务，请检查连接后重试。", 0, "NETWORK_ERROR");
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function readUser(result: { user: AccountUser }): AccountUser {
  if (!result?.user || typeof result.user.id !== "string" || typeof result.user.displayName !== "string"
    || typeof result.user.email !== "string") {
    throw new AccountApiError("账号资料返回异常，请稍后重试。", 0, "INVALID_RESPONSE");
  }
  return result.user;
}

export const accountApi = {
  async getUser(signal?: AbortSignal): Promise<AccountUser | null> {
    try {
      return readUser(await request<{ user: AccountUser }>("/auth/me", { signal }));
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 401) return null;
      throw error;
    }
  },
  async login(email: string, password: string) {
    return readUser(await request<{ user: AccountUser }>("/auth/login", {
      method: "POST", body: JSON.stringify({ email, password }),
    }));
  },
  async register(email: string, password: string, displayName: string) {
    return readUser(await request<{ user: AccountUser }>("/auth/register", {
      method: "POST", body: JSON.stringify({ email, password, displayName }),
    }));
  },
  logout() {
    return request<void>("/auth/logout", { method: "POST" });
  },
  async getCredits(signal?: AbortSignal): Promise<CreditBalance> {
    const result = await request<CreditBalance>("/credits", { signal });
    if (!result || ![result.balance, result.reserved, result.available].every(Number.isSafeInteger)
      || result.balance < 0 || result.reserved < 0 || result.available < 0
      || result.available !== result.balance - result.reserved) {
      throw new AccountApiError("额度信息返回异常，请稍后重试。", 0, "INVALID_RESPONSE");
    }
    return result;
  },
  async getLedger(before?: string, signal?: AbortSignal): Promise<CreditLedger> {
    const query = new URLSearchParams({ limit: "20" });
    if (before) query.set("before", before);
    const result = await request<CreditLedger>(`/credits/ledger?${query}`, { signal });
    if (!result || !Array.isArray(result.entries)
      || (result.nextCursor !== null && typeof result.nextCursor !== "string")) {
      throw new AccountApiError("额度记录返回异常，请稍后重试。", 0, "INVALID_RESPONSE");
    }
    return result;
  },
};
