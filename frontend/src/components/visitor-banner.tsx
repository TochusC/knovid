import { ArrowUpRight, Clock3, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { VisitorAccess } from "@/lib/types";

export function VisitorBanner({
  access,
  error,
  onRetry,
  onLogin,
}: {
  access: VisitorAccess | null;
  error: string;
  onRetry: () => void;
  onLogin: () => void;
}) {
  if (access?.mode === "member") return null;
  return (
    <section
      className={`visitor-banner ${access && !access.canGenerate ? "visitor-exhausted" : ""}`}
      aria-label="访客试用额度"
    >
      <span className="visitor-symbol">
        <Sparkles size={19} />
      </span>
      <div className="visitor-copy">
        <strong>
          {access
            ? access.canGenerate
              ? "以访客身份，试做一支知识短片"
              : "访客试用次数已用完"
            : "先以访客身份，试做一支知识短片"}
        </strong>
        <p>
          {access ? (
            <>
              <Clock3 size={12} />
              每条最多 {access.limits.maxDurationSeconds} 秒
              <span className="visitor-separator">·</span>剩余{" "}
              <b>{access.remainingGenerations}</b> /{" "}
              {access.limits.maxGenerations} 次生成
            </>
          ) : error ? (
            error
          ) : (
            "正在确认你的访客身份和试用额度…"
          )}
        </p>
        {access && (
          <small>
            {access.canGenerate
              ? "新建与保存修改各使用一次，失败重试不重复扣除。"
              : "已有作品仍可查看和下载，登录后可继续创作。"}
          </small>
        )}
      </div>
      {!access && error ? (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          <RefreshCw size={14} />
          重新连接
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={onLogin}>
          登录继续
          <ArrowUpRight size={14} />
        </Button>
      )}
    </section>
  );
}
