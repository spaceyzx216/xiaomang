import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { LogOut } from 'lucide-react';
import { useAuth } from '../app/auth';
import './manager.css';

// 一级导航只放**目的地**。原来这里还有一个「新建任务」，那是动作不是页面 ——
// 任务列表页右上角已经有同名的主动作按钮，导航里再放一个只会让人以为它是另一个页面。
const navigation = [
  ['/manager', '工作台'], ['/manager/tasks', '任务'],
  ['/manager/customers', '客户档案'], ['/manager/employees', '团队成员'],
  ['/manager/account-positioning', '账号定位'], ['/workbench', '内容生产'],
];

export default function ManagerLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return <div className="manager-workspace min-h-screen bg-[#f5f7fb] text-slate-900">
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/85 px-5 py-3 backdrop-blur sm:px-8">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-5 gap-y-2">
        <NavLink to="/manager" className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-950 text-sm font-bold text-white">芒</span>
          <span className="text-base font-semibold tracking-tight text-slate-950">小芒 AI</span>
        </NavLink>
        <nav aria-label="项目经理导航" className="flex flex-1 flex-wrap gap-1">
          {navigation.map(([to, label]) => <NavLink key={to} to={to} end={to === '/manager'} className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm font-medium transition ${isActive ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>{label}</NavLink>)}
        </nav>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-slate-500 sm:inline">{user?.name}</span>
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
            onClick={async () => { await logout(); navigate('/login'); }}
          >
            <LogOut className="h-3.5 w-3.5" />退出
          </button>
        </div>
      </div>
    </header>
    <main className="mx-auto max-w-[1440px] px-5 py-7 sm:px-8">{children}</main>
  </div>;
}
