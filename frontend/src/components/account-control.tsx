import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AlertCircle, ArrowDownLeft, ArrowUpRight, ChevronRight, Coins, Eye, EyeOff, LoaderCircle, LogOut, RefreshCw, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccountApiError, accountApi, type AccountUser, type CreditBalance, type CreditEntry, type CreditLedger } from "@/lib/account-api";
import "./account-control.css";

interface AccountControlProps {
  loginRequest: number;
  onSessionChange: () => void;
  onNotify: (message: string, tone?: "success" | "error") => void;
}

const numberFormat = new Intl.NumberFormat("zh-CN");
const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const emptyLedger: CreditLedger = { entries: [], nextCursor: null };

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "请求暂时未能完成，请稍后重试。";
}

function ledgerChange(entry: CreditEntry) {
  if (entry.kind === "reserve") return `冻结 ${numberFormat.format(entry.deltaReserved)}`;
  if (entry.kind === "release") return `释放 ${numberFormat.format(-entry.deltaReserved)}`;
  const sign = entry.deltaBalance > 0 ? "+" : "";
  return `${sign}${numberFormat.format(entry.deltaBalance)} Credit`;
}

function ledgerReason(entry: CreditEntry) {
  if (entry.reason === "signup") return "注册赠送";
  return entry.reason || { grant: "额度发放", reserve: "任务预留", capture: "任务结算", release: "额度释放" }[entry.kind];
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : dateFormat.format(date);
}

export function AccountControl({ loginRequest, onSessionChange, onNotify }: AccountControlProps) {
  const fieldId = useId();
  const [user, setUser] = useState<AccountUser | null>(null);
  const [sessionStatus, setSessionStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sessionError, setSessionError] = useState("");
  const [credits, setCredits] = useState<CreditBalance | null>(null);
  const [creditError, setCreditError] = useState("");
  const [creditLoading, setCreditLoading] = useState(false);
  const [ledger, setLedger] = useState<CreditLedger>(emptyLedger);
  const [ledgerError, setLedgerError] = useState("");
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState<"auth" | "logout" | null>(null);
  const userRef = useRef<AccountUser | null>(null);
  const sessionRequest = useRef(0);
  const ledgerRequest = useRef(0);
  const creditRequest = useRef(0);
  const mounted = useRef(true);
  const callbacks = useRef({ onSessionChange, onNotify });

  useEffect(() => { callbacks.current = { onSessionChange, onNotify }; }, [onSessionChange, onNotify]);

  const applyUser = useCallback((nextUser: AccountUser | null) => {
    const accountChanged = userRef.current?.id !== nextUser?.id;
    userRef.current = nextUser;
    setUser(nextUser);
    setSessionStatus("ready");
    setSessionError("");
    if (!nextUser || accountChanged) {
      creditRequest.current += 1;
      ledgerRequest.current += 1;
      setCredits(null);
      setLedger(emptyLedger);
      setCreditLoading(false);
      setLedgerLoading(false);
      setCreditError("");
      setLedgerError("");
    }
  }, []);

  const expireSession = useCallback(() => {
    if (!userRef.current) return;
    applyUser(null);
    setFormError("登录已过期，请重新登录。");
    callbacks.current.onSessionChange();
  }, [applyUser]);

  const refreshCredits = useCallback(async () => {
    const userId = userRef.current?.id;
    if (!userId) return;
    const requestId = ++creditRequest.current;
    setCreditLoading(true);
    setCreditError("");
    try {
      const result = await accountApi.getCredits();
      if (mounted.current && requestId === creditRequest.current && userRef.current?.id === userId) setCredits(result);
    } catch (error) {
      if (!mounted.current || requestId !== creditRequest.current || userRef.current?.id !== userId) return;
      if (error instanceof AccountApiError && error.status === 401) expireSession();
      else setCreditError(messageOf(error));
    } finally {
      if (mounted.current && requestId === creditRequest.current) setCreditLoading(false);
    }
  }, [expireSession]);

  const refreshSession = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++sessionRequest.current;
    setSessionStatus("loading");
    setSessionError("");
    try {
      const nextUser = await accountApi.getUser(signal);
      if (!mounted.current || signal?.aborted || requestId !== sessionRequest.current) return;
      const changed = userRef.current?.id !== nextUser?.id;
      applyUser(nextUser);
      if (changed) callbacks.current.onSessionChange();
      if (nextUser) void refreshCredits();
    } catch (error) {
      if (!mounted.current || signal?.aborted || requestId !== sessionRequest.current) return;
      setSessionStatus("error");
      setSessionError(messageOf(error));
    }
  }, [applyUser, refreshCredits]);

  const refreshLedger = useCallback(async (before?: string) => {
    const userId = userRef.current?.id;
    if (!userId) return;
    const requestId = ++ledgerRequest.current;
    setLedgerLoading(true);
    setLedgerError("");
    try {
      const result = await accountApi.getLedger(before);
      if (!mounted.current || requestId !== ledgerRequest.current || userRef.current?.id !== userId) return;
      setLedger((current) => ({
        entries: before ? [...current.entries, ...result.entries.filter((entry) => !current.entries.some((existing) => existing.id === entry.id))] : result.entries,
        nextCursor: result.nextCursor,
      }));
    } catch (error) {
      if (!mounted.current || requestId !== ledgerRequest.current || userRef.current?.id !== userId) return;
      if (error instanceof AccountApiError && error.status === 401) expireSession();
      else setLedgerError(messageOf(error));
    } finally {
      if (mounted.current && requestId === ledgerRequest.current) setLedgerLoading(false);
    }
  }, [expireSession]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refreshSession(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [refreshSession]);

  useEffect(() => {
    if (loginRequest > 0) {
      setMode("login");
      setFormError("");
      setOpen(true);
    }
  }, [loginRequest]);

  useEffect(() => {
    if (open && user?.id) {
      void refreshCredits();
      void refreshLedger();
    }
  }, [open, user?.id, refreshCredits, refreshLedger]);

  useEffect(() => {
    const refresh = () => { if (!document.hidden && !busy) void refreshSession(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [busy, refreshSession]);

  useEffect(() => {
    if (!user?.id) return;
    const refresh = () => { if (!document.hidden) void refreshCredits(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("knovid:credits-changed", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("knovid:credits-changed", refresh);
    };
  }, [user?.id, refreshCredits]);

  const openAuthentication = (nextMode: "login" | "register") => {
    setMode(nextMode);
    setFormError("");
    setOpen(true);
  };

  const authenticate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (mode === "register" && !displayName.trim()) {
      setFormError("请填写你希望使用的昵称。");
      return;
    }
    setBusy("auth");
    setFormError("");
    setSessionError("");
    const requestId = ++sessionRequest.current;
    try {
      const nextUser = mode === "login"
        ? await accountApi.login(email.trim(), password)
        : await accountApi.register(email.trim(), password, displayName.trim());
      if (!mounted.current || requestId !== sessionRequest.current) return;
      applyUser(nextUser);
      setPassword("");
      setPasswordVisible(false);
      setOpen(false);
      callbacks.current.onSessionChange();
      callbacks.current.onNotify(mode === "register" ? "账号已创建并登录。" : "登录成功，欢迎回来。", "success");
      void refreshCredits();
    } catch (error) {
      if (mounted.current && requestId === sessionRequest.current) {
        setFormError(messageOf(error));
        setSessionStatus("ready");
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const logout = async () => {
    if (busy) return;
    setBusy("logout");
    setFormError("");
    sessionRequest.current += 1;
    try {
      await accountApi.logout();
      if (!mounted.current) return;
      applyUser(null);
      setOpen(false);
      setPassword("");
      callbacks.current.onSessionChange();
      callbacks.current.onNotify("已退出登录。", "success");
    } catch (error) {
      if (mounted.current) {
        if (error instanceof AccountApiError && error.status === 401) expireSession();
        else setFormError(messageOf(error));
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <>
      <div className="account-control">
        {user ? (
          <button className="account-profile-button" onClick={() => setOpen(true)} aria-label="打开我的账户与额度">
            <span className="account-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
            <span className="account-profile-copy">
              <strong>{user.displayName}</strong>
              <span>{creditError ? "额度暂时不可用" : credits ? `${numberFormat.format(credits.available)} Credit 可用` : "正在读取额度…"}</span>
            </span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        ) : (
          <div className="account-signed-out">
            <span className="account-avatar"><UserRound size={16} aria-hidden="true" /></span>
            <div>
              <div className="account-auth-actions">
                <button onClick={() => openAuthentication("login")}>登录</button>
                <span aria-hidden="true">/</span>
                <button onClick={() => openAuthentication("register")}>注册</button>
              </div>
              <span className="account-sidebar-hint">{sessionStatus === "loading" ? "正在确认账号…" : sessionStatus === "error" ? "访客浏览 · 账号服务待连接" : "当前为访客，无需登录也可试用"}</span>
            </div>
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (!nextOpen) { setPassword(""); setPasswordVisible(false); } }}>
        <DialogContent className={`account-dialog ${user ? "account-details-dialog" : ""}`}>
          <DialogHeader>
            <div className="account-dialog-symbol"><Coins size={20} aria-hidden="true" /></div>
            <DialogTitle>{user ? "我的账户" : mode === "login" ? "欢迎回到知视" : "创建知视账号"}</DialogTitle>
            <DialogDescription>{user ? user.email : "登录后，查看账户信息、可用额度与使用记录。"}</DialogDescription>
          </DialogHeader>

          {sessionStatus === "loading" && !user ? (
            <div className="account-loading" role="status"><LoaderCircle className="animate-spin" size={20} />正在确认登录状态…</div>
          ) : user ? (
            <div className="account-details">
              <div className="account-name-row"><span className="account-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><strong>{user.displayName}</strong><span>创作账户</span></div>
              <section className="account-credit-section" aria-label="Credit 额度">
                <div className="account-section-heading"><h3>创作额度</h3><Button variant="ghost" size="sm" disabled={creditLoading} onClick={() => { void refreshCredits(); void refreshLedger(); }} aria-label="刷新额度与记录"><RefreshCw size={13} className={creditLoading ? "animate-spin" : ""} />刷新</Button></div>
                {creditError ? (
                  <div className="account-error" role="alert"><AlertCircle size={16} /><span>{creditError}</span><button onClick={() => void refreshCredits()}>重试</button></div>
                ) : (
                  <div className="account-credit-stats" aria-live="polite">
                    <div className="account-credit-available"><span>可用 Credit</span><strong>{credits ? numberFormat.format(credits.available) : "—"}</strong></div>
                    <div><span>总余额</span><strong>{credits ? numberFormat.format(credits.balance) : "—"}</strong></div>
                    <div><span>进行中冻结</span><strong>{credits ? numberFormat.format(credits.reserved) : "—"}</strong></div>
                  </div>
                )}
                <p className="account-credit-note">冻结额度用于已预留的任务，结算或释放后更新可用额度。</p>
              </section>

              <section aria-label="额度使用记录" className="account-ledger-section">
                <div className="account-section-heading"><h3>额度记录</h3><span>Credit 为创作额度</span></div>
                {ledgerLoading && ledger.entries.length === 0 ? (
                  <div className="account-loading" role="status"><LoaderCircle className="animate-spin" size={18} />正在读取记录…</div>
                ) : ledger.entries.length === 0 && !ledgerError ? (
                  <div className="account-ledger-empty"><Coins size={22} /><p>还没有额度记录</p><span>额度发放、任务预留与结算会显示在这里。</span></div>
                ) : (
                  <ul className="account-ledger">
                    {ledger.entries.map((entry) => (
                      <li key={entry.id}>
                        <span className={`account-entry-icon ${entry.kind}`}>
                          {entry.kind === "grant" || entry.kind === "release" ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}
                        </span>
                        <div className="account-entry-reason"><strong>{ledgerReason(entry)}</strong><span>{formatDate(entry.createdAt)}</span></div>
                        <div className="account-entry-amount"><strong className={entry.kind === "grant" ? "positive" : ""}>{ledgerChange(entry)}</strong><span>可用 {numberFormat.format(entry.balanceAfter - entry.reservedAfter)}</span></div>
                      </li>
                    ))}
                  </ul>
                )}
                {ledgerError && <div className="account-error" role="alert"><AlertCircle size={16} /><span>{ledgerError}</span><button onClick={() => void refreshLedger()}>重试</button></div>}
                {ledger.nextCursor && !ledgerError && <Button variant="ghost" size="sm" className="account-load-more" disabled={ledgerLoading} onClick={() => void refreshLedger(ledger.nextCursor ?? undefined)}>{ledgerLoading ? <LoaderCircle size={14} className="animate-spin" /> : null}{ledgerLoading ? "读取中…" : "查看更早的记录"}</Button>}
              </section>
              {formError && <p className="account-form-error" role="alert">{formError}</p>}
              <Button variant="outline" className="account-logout" disabled={busy !== null} onClick={() => void logout()}>{busy === "logout" ? <LoaderCircle size={15} className="animate-spin" /> : <LogOut size={15} />}退出登录</Button>
            </div>
          ) : (
            <form className="account-auth-form" onSubmit={(event) => void authenticate(event)}>
              <div className="account-mode-switch" aria-label="选择登录或注册">
                <button type="button" aria-pressed={mode === "login"} className={mode === "login" ? "active" : ""} disabled={busy !== null} onClick={() => { setMode("login"); setFormError(""); }}>登录</button>
                <button type="button" aria-pressed={mode === "register"} className={mode === "register" ? "active" : ""} disabled={busy !== null} onClick={() => { setMode("register"); setFormError(""); }}>注册账号</button>
              </div>
              {sessionError && <div className="account-error" role="alert"><AlertCircle size={16} /><span>{sessionError}</span><button type="button" onClick={() => void refreshSession()}>重试</button></div>}
              {mode === "register" && <label htmlFor={`${fieldId}-name`} className="account-field"><span>昵称</span><input id={`${fieldId}-name`} name="name" type="text" autoComplete="nickname" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="我们该怎么称呼你？" required maxLength={80} disabled={busy !== null} /></label>}
              <label htmlFor={`${fieldId}-email`} className="account-field"><span>邮箱</span><input id={`${fieldId}-email`} name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required maxLength={254} disabled={busy !== null} /></label>
              <label htmlFor={`${fieldId}-password`} className="account-field"><span>密码</span><div className="account-password-input"><input id={`${fieldId}-password`} name="password" type={passwordVisible ? "text" : "password"} autoComplete={mode === "register" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "register" ? "设置 12–128 个字符的密码" : "输入你的密码"} required minLength={mode === "register" ? 12 : undefined} maxLength={128} disabled={busy !== null} /><button type="button" aria-label={passwordVisible ? "隐藏密码" : "显示密码"} onClick={() => setPasswordVisible((visible) => !visible)}>{passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
              {mode === "register" && <p className="account-password-hint">密码需要包含 12 至 128 个字符。</p>}
              {formError && <p className="account-form-error" role="alert">{formError}</p>}
              <Button type="submit" className="account-submit" disabled={busy !== null}>{busy === "auth" ? <LoaderCircle size={16} className="animate-spin" /> : null}{busy === "auth" ? "正在处理…" : mode === "login" ? "登录账号" : "创建账号"}</Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
