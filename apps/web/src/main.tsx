import "./styles/index.css";

import { lazy, Suspense } from "react";
import ManagerLayout from "./manager/ManagerLayout";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Toaster } from "sonner";
import App from "./app/App.tsx";
import AccountPositioningPage from "./app/AccountPositioningPage.tsx";
import AuthPage from "./app/AuthPage.tsx";
import ContentPage from "./app/ContentPage.tsx";
import FinalEditorPage from "./app/FinalEditorPage.tsx";
import ManagerHomePage from "./app/ManagerHomePage.tsx";
import PublishWarehousePage from "./app/PublishWarehousePage.tsx";
import TodayTasksPage from "./app/TodayTasksPage.tsx";
import { TopicLibraryStage } from "./app/TopicLibraryStage.tsx";
import { AuthProvider, PublicOnly, RequireAuth, RequireRole, useAuth } from "./app/auth.tsx";
import { ErrorBoundary } from "./app/ErrorBoundary.tsx";

const TaskList = lazy(() => import('./manager/pages/TaskList.jsx'));
const TaskForm = lazy(() => import('./manager/pages/TaskForm.jsx'));
const CustomerList = lazy(() => import('./manager/pages/CustomerList.jsx'));
const EmployeeList = lazy(() => import('./manager/pages/EmployeeList.jsx'));
const IpProfileForm = lazy(() => import('./manager/pages/IpProfileForm.jsx'));
const managed = (page: React.ReactNode) => <RequireRole role="manager"><ManagerLayout><Suspense fallback={<p className="p-6 text-slate-500">正在加载…</p>}>{page}</Suspense></ManagerLayout></RequireRole>;

function HomePage() {
  const { user } = useAuth();
  return user?.role === "manager" ? <ManagerHomePage /> : <TodayTasksPage />;
}

/**
 * 员工端的「新更新视频筛选与打标签」（模块 3 的 2.4 **只读视图**）。
 *
 * `/topics` 是员工路由，而 2.4 原本只挂在经理端的 `/manager/account-positioning` 下，
 * 员工进不去。这里复用同一个组件给员工开一扇门：`readOnly` 藏掉建库/改库入口，
 * 客户由 `?customerId=` 锁定 —— 值来自临时任务的「绑定客户」。
 *
 * ⚠️ 分支放在**路由元素这一层**，不要塞进 `App` 里提前 return：
 *    `App` 有几十个 hook，条件式提前 return 会让 hook 顺序随 query 变化而改变。
 */
function TopicsRoute() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  if (params.get("view") === "newVideos") {
    // 这个视图被经理端（任务列表「查看产出」）和员工端（今日任务）共用。
    // 它不挂在任何一侧的导航外壳里，所以自带一个头部和「从哪来回哪去」的出口，
    // 否则点进来会像掉进了一个没有导航的死胡同。
    const isManager = user?.role === "manager";
    const backTo = isManager ? "/manager/tasks" : "/workbench";
    return (
      <main className="min-h-screen bg-[#f5f7fb] text-slate-900">
        <header className="border-b border-slate-200/80 bg-white/85 px-5 py-4 backdrop-blur sm:px-8 lg:px-10">
          <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3">
            <div className="min-w-0">
              {/* 和经理端各页一致：只有标题 + 副标题，不加英文眉题。
                  这个视图是从经理端「任务列表 → 查看产出」进来的，页头形态要能接上。 */}
              <h1 className="truncate text-xl font-semibold tracking-tight text-slate-950">客户内容产出</h1>
              <p className="mt-1 truncate text-sm text-slate-500">
                这个客户已经沉淀下来的选题与脚本。
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate(backTo)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
            >
              <ArrowLeft className="h-4 w-4" />
              {isManager ? "返回任务列表" : "返回今日任务"}
            </button>
          </div>
        </header>
        <div className="mx-auto max-w-[1500px] px-5 py-6 sm:px-8 lg:px-10 lg:py-9">
          <TopicLibraryStage embedded readOnly lockedCustomerId={params.get("customerId") || ""} />
        </div>
      </main>
    );
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    {/* 兜住所有渲染期异常，避免任何一处报错都变成整页白屏。 */}
    <ErrorBoundary>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<PublicOnly><AuthPage /></PublicOnly>} />
          <Route path="/register" element={<PublicOnly><AuthPage mode="register" /></PublicOnly>} />
          <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
          <Route path="/manager" element={managed(<ManagerHomePage />)} />
          <Route path="/workbench" element={<RequireAuth><TodayTasksPage /></RequireAuth>} />
          <Route path="/manager/tasks" element={managed(<TaskList />)} />
          <Route path="/manager/tasks/new" element={managed(<TaskForm />)} />
          <Route path="/manager/customers" element={managed(<CustomerList />)} />
          <Route path="/manager/customers/ip-profile/new" element={managed(<IpProfileForm />)} />
          <Route path="/manager/customers/:id/ip-profile" element={managed(<IpProfileForm />)} />
          <Route path="/manager/employees" element={managed(<EmployeeList />)} />
          <Route path="/manager/account-positioning" element={managed(<AccountPositioningPage />)} />
          {/* 账号定位已经收敛成单一入口；旧路径保留重定向，避免已有书签或外链失效。 */}
          <Route path="/manager/benchmark-analysis" element={<Navigate to="/manager/account-positioning" replace />} />
          <Route path="/manager/gold-three-seconds" element={<Navigate to="/manager/account-positioning" replace />} />
          <Route path="/topics" element={<RequireAuth><TopicsRoute /></RequireAuth>} />
          <Route path="/content" element={<RequireAuth><ContentPage /></RequireAuth>} />
          {/* 发布仓：内容生成页之后、最终文案编辑页之前（2026-09-21 第七轮，HANDOFF §0.3）。 */}
          <Route path="/publish-warehouse" element={<RequireAuth><PublishWarehousePage /></RequireAuth>} />
          <Route path="/final-editor" element={<RequireAuth><FinalEditorPage /></RequireAuth>} />
          <Route path="*" element={<RequireAuth><HomePage /></RequireAuth>} />
        </Routes>
        {/* 全站统一的操作反馈出口：删除/保存/状态变更的结果都走这里，
            不再出现「操作成功了但页面什么都不说」的情况。 */}
        <Toaster position="top-center" richColors closeButton duration={3200} />
      </AuthProvider>
    </ErrorBoundary>
  </BrowserRouter>
);
