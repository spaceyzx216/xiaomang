import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router";
import { AlertTriangle, RotateCcw } from "lucide-react";

/**
 * 全局渲染错误兜底。
 *
 * 没有它的时候，任何渲染期异常都会被 React 卸载整棵树，用户看到的是一张纯白页面，
 * 控制台之外没有任何提示 —— 2026-09-17 的黄金三秒白屏就是这样，排查成本很高。
 * 这里把它变成一张可读的错误卡片。
 *
 * 注意：React 18 的错误边界只能用 class 组件实现，没有对应的 hook。
 */

type ErrorBoundaryProps = {
  children: ReactNode;
  /** 变化时自动清除错误。传入路由 key，让用户导航离开后能自动恢复。 */
  resetKey?: string;
};

type ErrorBoundaryState = {
  error: Error | null;
};

class ErrorBoundaryInner extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 完整堆栈留给开发者，用户那边只看到可读卡片。
    console.error("[ErrorBoundary] 渲染期异常：", error, info.componentStack);
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) return <ErrorFallback error={this.state.error} />;
    return this.props.children;
  }
}

function ErrorFallback({ error }: { error: Error }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f7fb] px-6 py-10 text-slate-900">
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-red-50 text-red-600"><AlertTriangle className="h-5 w-5" /></span>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-slate-950">页面出错了</h1>
        <p className="mt-2 break-words text-sm leading-6 text-slate-600">{error.message || "发生了未知错误"}</p>
        <details className="mt-4 rounded-xl bg-slate-50 px-4 py-3">
          <summary className="cursor-pointer select-none text-xs font-medium text-slate-600">技术细节</summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-5 text-slate-500">{error.stack || error.message}</pre>
        </details>
        <div className="mt-5 flex flex-wrap gap-2">
          {/* 用整页跳转而不是客户端路由：出错时保证拿到一个干净的应用状态。 */}
          <button type="button" onClick={() => window.location.reload()} className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"><RotateCcw className="h-4 w-4" />重新加载页面</button>
          <a href="/" className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900">返回首页</a>
        </div>
      </div>
    </main>
  );
}

/** 读取路由 key，让用户导航离开出错页面后错误边界自动复位。 */
export function ErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ErrorBoundaryInner resetKey={location.key}>{children}</ErrorBoundaryInner>;
}
