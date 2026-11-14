import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEventHandler } from "react";
import { ArrowRight, Loader2, Palette, Pencil, Play, Plus, RotateCw, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import { builtinStyles, type BuiltinStyleId } from "@/lib/builtin-styles";
import type { StylePreset, VisitorAccess } from "@/lib/types";
import { StyleSample } from "./style-sample";
import "./style-management.css";

type StyleDialog =
  | { kind: "form"; id?: string; style: string; summary: string }
  | { kind: "delete"; preset: StylePreset };

export function StyleManagement({ access, accessError, onRetryAccess, onLogin, onNavigate }: {
  access: VisitorAccess | null;
  accessError: string;
  onRetryAccess: () => void;
  onLogin: () => void;
  onNavigate: MouseEventHandler<HTMLAnchorElement>;
}) {
  return (
    <div className="styles-page">
      <header className="styles-page-header">
        <h1>风格管理</h1>
        <p>保存常用的配色、画面与动效规则，创建视频时直接选用。</p>
      </header>

      <BuiltinStyleGallery onNavigate={onNavigate} />

      {access?.mode === "member" ? (
        <SavedStyles />
      ) : (
        <section className="styles-library" aria-labelledby="saved-styles-heading">
          <h2 id="saved-styles-heading">我的风格</h2>
          <div className="styles-message">
            {access?.mode === "guest" ? (
              <>
                <p>登录后即可保存和管理你的风格。</p>
                <Button onClick={onLogin}>登录 <ArrowRight /></Button>
              </>
            ) : accessError ? (
              <>
                <p role="alert">{accessError}</p>
                <Button variant="outline" onClick={onRetryAccess}><RotateCw /> 重试</Button>
              </>
            ) : <p role="status">正在确认账户…</p>}
          </div>
        </section>
      )}
    </div>
  );
}

function BuiltinStyleGallery({ onNavigate }: { onNavigate: MouseEventHandler<HTMLAnchorElement> }) {
  const [playing, setPlaying] = useState<BuiltinStyleId | null>(null);
  const stopPlaying = useCallback(() => setPlaying(null), []);

  return (
    <section className="styles-gallery" aria-labelledby="builtin-styles-heading">
      <h2 id="builtin-styles-heading">内置风格</h2>
      <p>用同一个行星轨道示意比较画面和动效。</p>
      <ul className="styles-gallery-grid">
        {builtinStyles.map((style) => {
          const active = playing === style.id;
          return (
            <li className="styles-example-card" key={style.id}>
              <div className="styles-example-media">
                <StyleSample style={style.id} playing={active} onEnd={stopPlaying} />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  className="styles-example-play"
                  aria-label={active ? `停止${style.name}示意` : `播放${style.name}示意`}
                  onClick={() => setPlaying(active ? null : style.id)}
                >
                  {active ? <Square fill="currentColor" /> : <Play fill="currentColor" />}
                </Button>
              </div>
              <div className="styles-example-copy">
                <div className="styles-example-title">
                  <h3>{style.name}</h3>
                  {style.id === "default" && <span>默认</span>}
                </div>
                <p>{style.summary}</p>
                <Button asChild variant="outline" size="sm">
                  <a href={`/workspace?style=${style.id}`} onClick={onNavigate} aria-label={`使用${style.name}风格`}>
                    使用此风格 <ArrowRight />
                  </a>
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SavedStyles() {
  const [presets, setPresets] = useState<StylePreset[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [dialog, setDialog] = useState<StyleDialog | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const newButton = useRef<HTMLButtonElement>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api.listStylePresets(controller.signal).then((styles) => {
      if (!controller.signal.aborted) setPresets(styles);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setLoadError(cause instanceof Error ? cause.message : "暂时无法读取已保存风格。");
      }
    });
    return () => controller.abort();
  }, [loadAttempt]);

  function openDialog(next: StyleDialog, trigger: HTMLElement) {
    dialogTrigger.current = trigger;
    setDialog(next);
    setDialogOpen(true);
    setDialogError("");
    setNotice("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog || pending) return;
    setPending(true);
    setDialogError("");
    try {
      if (dialog.kind === "delete") {
        await api.deleteStylePreset(dialog.preset.id);
        setPresets((current) => (current ?? []).filter((preset) => preset.id !== dialog.preset.id));
        setNotice("风格已删除。");
      } else {
        const input = { style: dialog.style.trim(), summary: dialog.summary.trim() };
        const saved = dialog.id
          ? await api.updateStylePreset(dialog.id, input)
          : await api.createStylePreset(input);
        setPresets((current) => dialog.id
          ? (current ?? []).map((preset) => preset.id === saved.id ? saved : preset)
          : [...(current ?? []), saved]);
        setNotice("风格已保存。");
      }
      setDialogOpen(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "STYLE_PRESET_NOT_FOUND") {
        const removedId = dialog.kind === "delete" ? dialog.preset.id : dialog.id;
        setPresets((current) => (current ?? []).filter((preset) => preset.id !== removedId));
        setNotice("此风格已被删除。");
        setDialogOpen(false);
      } else {
        setDialogError(cause instanceof Error ? cause.message : "操作暂时失败，请重试。");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="styles-library" aria-labelledby="saved-styles-heading">
      <div className="styles-library-header">
        <h2 id="saved-styles-heading">我的风格</h2>
        <Button
          ref={newButton}
          disabled={!presets}
          onClick={(event) => openDialog({ kind: "form", style: "", summary: "" }, event.currentTarget)}
        >
          <Plus /> 新建风格
        </Button>
      </div>
      {loadError ? (
        <div className="styles-message">
          <p role="alert">{loadError}</p>
          <Button variant="outline" onClick={() => {
            setLoadError("");
            setLoadAttempt((attempt) => attempt + 1);
          }}><RotateCw /> 重试</Button>
        </div>
      ) : !presets ? (
        <div className="styles-message" role="status"><p>正在读取风格…</p></div>
      ) : presets.length ? (
        <ul className="styles-grid">
          {presets.map((preset) => (
            <li key={preset.id} className="styles-card">
              <h3><Palette aria-hidden="true" />{preset.style}</h3>
              <p>{preset.summary}</p>
              <div className="styles-card-actions">
                <Button variant="outline" size="sm" aria-label={`编辑 ${preset.style}`} onClick={(event) => {
                  openDialog({ kind: "form", ...preset }, event.currentTarget);
                }}><Pencil /> 编辑</Button>
                <Button variant="ghost" size="icon-sm" aria-label={`删除 ${preset.style}`} onClick={(event) => {
                  openDialog({ kind: "delete", preset }, event.currentTarget);
                }}><Trash2 /></Button>
              </div>
            </li>
          ))}
        </ul>
      ) : <div className="styles-message"><p>暂无自定义风格。</p></div>}
      <p className="styles-notice" role="status">{notice}</p>

      <Dialog open={dialogOpen} onOpenChange={(open) => {
        if (!open && !pending) setDialogOpen(false);
      }}>
        <DialogContent
          className="styles-dialog"
          showCloseButton={!pending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = dialogTrigger.current;
            (trigger?.isConnected ? trigger : newButton.current)?.focus();
          }}
        >
          {dialog && (
            <form onSubmit={(event) => void submit(event)}>
              <DialogHeader>
                <DialogTitle>{dialog.kind === "delete" ? "删除风格" : dialog.id ? "编辑风格" : "新建风格"}</DialogTitle>
                <DialogDescription>
                  {dialog.kind === "delete"
                    ? `确定从你的风格库中删除「${dialog.preset.style}」？`
                    : "描述你希望在视频中复用的视觉与动效规则。"}
                </DialogDescription>
              </DialogHeader>
              {dialog.kind === "form" && (
                <div className="styles-fields">
                  <label>名称
                    <input name="style" value={dialog.style} placeholder="如 水彩科普" maxLength={60} required disabled={pending}
                      onChange={(event) => setDialog({ ...dialog, style: event.target.value })} />
                  </label>
                  <label>风格说明
                    <textarea name="summary" value={dialog.summary} placeholder="如 米白纸张背景，水彩手绘图解，重点用暖橙色标记，随旁白逐步揭示。"
                      rows={6} maxLength={2400} required disabled={pending}
                      onChange={(event) => setDialog({ ...dialog, summary: event.target.value })} />
                  </label>
                </div>
              )}
              {dialogError && <p className="styles-dialog-error" role="alert">{dialogError}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" disabled={pending} onClick={() => setDialogOpen(false)}>取消</Button>
                <Button type="submit" variant={dialog.kind === "delete" ? "destructive" : "default"}
                  disabled={pending || (dialog.kind === "form" && (!dialog.style.trim() || !dialog.summary.trim()))}>
                  {pending && <Loader2 className="animate-spin" />}
                  {dialog.kind === "delete" ? "删除" : "保存风格"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
