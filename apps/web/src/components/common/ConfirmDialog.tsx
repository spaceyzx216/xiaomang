import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../app/components/ui/alert-dialog";
import { LoaderCircle } from "lucide-react";

/**
 * 站内确认弹窗 —— 替代 `window.confirm`。
 *
 * 原来删除任务/员工走的是浏览器原生 confirm：样式和整站割裂、无法展示上下文
 * （比如「这个员工名下还有 3 个任务」）、在部分浏览器里还会被拦截。这里换成
 * 与设计系统同一套的弹窗，并把「会发生什么」写清楚。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "danger",
  loading = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "warning" | "primary";
  loading?: boolean;
  onConfirm: () => void;
}) {
  const actionClass =
    tone === "danger"
      ? "bg-rose-600 hover:bg-rose-700"
      : tone === "warning"
        ? "bg-amber-500 hover:bg-amber-600"
        : "bg-blue-600 hover:bg-blue-700";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="rounded-2xl border-slate-200">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base font-semibold text-slate-900">{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription asChild>
              <div className="text-sm leading-6 text-slate-500">{description}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={loading}
            className="h-10 rounded-xl border-slate-200 text-sm font-medium text-slate-600"
          >
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={loading}
            onClick={event => {
              // 交给调用方决定何时关闭：请求失败时要留在弹窗里展示原因。
              event.preventDefault();
              onConfirm();
            }}
            className={`h-10 rounded-xl text-sm font-semibold text-white ${actionClass}`}
          >
            {loading && <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
