import { FormEvent, useState } from "react";
import { ArrowRight, BriefcaseBusiness, KeyRound, LoaderCircle, ShieldCheck, UsersRound } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "./auth";

type AuthPageProps = { mode?: "login" | "register" };

const getRedirectPath = (location: ReturnType<typeof useLocation>) => {
  const from = location.state?.from;
  return typeof from?.pathname === "string" && from.pathname !== "/login" && from.pathname !== "/register"
    ? `${from.pathname}${from.search || ""}${from.hash || ""}`
    : "";
};

export default function AuthPage({ mode = "login" }: AuthPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, registerManager } = useAuth();
  const [registering, setRegistering] = useState(mode === "register");
  const [name, setName] = useState("");
  const [loginName, setLoginName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const user = registering
        ? await registerManager({ name, email, password, inviteCode })
        : await login(loginName, password);
      navigate(getRedirectPath(location) || (user.role === "manager" ? "/manager" : "/"), { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "操作失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  const switchMode = () => {
    setRegistering(value => !value);
    setError("");
  };

  return (
    <main className="min-h-screen overflow-hidden bg-[#f5f7fb] text-slate-900">
      <div className="pointer-events-none fixed -left-28 -top-24 h-96 w-96 rounded-full bg-blue-200/35 blur-3xl" />
      <div className="pointer-events-none fixed -right-28 bottom-0 h-[28rem] w-[28rem] rounded-full bg-violet-200/25 blur-3xl" />
      <div className="relative mx-auto grid min-h-screen max-w-6xl items-center gap-12 px-6 py-10 lg:grid-cols-[1fr_430px] lg:px-10">
        <section className="max-w-xl">
          <div className="mb-5 flex items-center gap-3 text-xs font-semibold tracking-[0.2em] text-blue-700"><span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-950 text-sm text-white">X</span> XIAOMANG AI WORKSPACE</div>
          <h1 className="max-w-lg text-4xl font-semibold leading-tight tracking-[-0.04em] text-slate-950 sm:text-6xl">让每个账号的内容工作，<span className="text-blue-700">从今天开始有序。</span></h1>
          <p className="mt-6 max-w-lg text-base leading-8 text-slate-500">统一登录后，项目经理进入管理工作台，员工直接进入自己的今日任务，不再依赖链接里的员工 ID。</p>
          <div className="mt-9 grid gap-3 text-sm text-slate-600 sm:grid-cols-3">
            <div className="rounded-2xl border border-white/80 bg-white/75 p-4 shadow-sm"><BriefcaseBusiness className="mb-3 h-5 w-5 text-blue-600" /><div className="font-medium text-slate-800">经理工作台</div><div className="mt-1 text-xs leading-5 text-slate-400">管理客户、任务与团队</div></div>
            <div className="rounded-2xl border border-white/80 bg-white/75 p-4 shadow-sm"><UsersRound className="mb-3 h-5 w-5 text-violet-600" /><div className="font-medium text-slate-800">员工任务</div><div className="mt-1 text-xs leading-5 text-slate-400">只查看分配给自己的任务</div></div>
            <div className="rounded-2xl border border-white/80 bg-white/75 p-4 shadow-sm"><ShieldCheck className="mb-3 h-5 w-5 text-emerald-600" /><div className="font-medium text-slate-800">统一认证</div><div className="mt-1 text-xs leading-5 text-slate-400">账号来自同一 MongoDB</div></div>
          </div>
        </section>

        <section className="rounded-[28px] border border-white/90 bg-white/95 p-7 shadow-[0_24px_80px_rgba(31,41,55,0.12)] sm:p-9">
          <div className="mb-8"><div className="flex items-center gap-2 text-xs font-semibold tracking-[0.16em] text-blue-600"><KeyRound className="h-4 w-4" /> {registering ? "MANAGER REGISTRATION" : "SECURE SIGN IN"}</div><h2 className="mt-3 text-2xl font-semibold tracking-tight">{registering ? "注册经理账号" : "登录工作区"}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{registering ? "经理账号需要邀请码；员工账号由项目经理创建。" : "请输入经理邮箱，或项目经理分配的员工账号。"}</p></div>
          {error && <div role="alert" className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700">{error}</div>}
          <form className="space-y-5" onSubmit={submit}>
            {registering ? (
              <>
                <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">姓名</span><input value={name} onChange={event => setName(event.target.value)} className="h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none transition focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100" placeholder="请输入姓名" required /></label>
                <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">经理邮箱</span><input type="email" value={email} onChange={event => setEmail(event.target.value)} className="h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none transition focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100" placeholder="you@example.com" required /></label>
              </>
            ) : (
              <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">邮箱 / 员工账号</span><input value={loginName} onChange={event => setLoginName(event.target.value)} className="h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none transition focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100" placeholder="经理邮箱或员工账号" autoFocus required /></label>
            )}
            <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">密码</span><input type="password" value={password} onChange={event => setPassword(event.target.value)} className="h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none transition focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100" placeholder="请输入密码" minLength={6} required /></label>
            {registering && <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">邀请码</span><input value={inviteCode} onChange={event => setInviteCode(event.target.value)} className="h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none transition focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100" placeholder="请输入经理邀请码" required /></label>}
            <button type="submit" disabled={loading} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-slate-950 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60">{loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}{loading ? "处理中…" : registering ? "注册并进入经理工作台" : "登录"}</button>
          </form>
          <div className="mt-7 border-t border-slate-100 pt-5 text-center text-sm text-slate-500">{registering ? "已有经理账号？" : "需要注册经理账号？"}<button type="button" onClick={switchMode} className="ml-1 font-semibold text-blue-700 hover:text-blue-900">{registering ? "返回登录" : "使用邀请码注册"}</button></div>
        </section>
      </div>
    </main>
  );
}
