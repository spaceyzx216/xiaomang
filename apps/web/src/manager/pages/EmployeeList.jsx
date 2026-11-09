import React, { useEffect, useMemo, useState } from 'react';
import { Search, Users, UserCheck, UserMinus } from 'lucide-react';
import { toast } from 'sonner';
import { employeeAPI } from '../services/api';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';

const AVATAR_CLASSES = ['avatar-indigo', 'avatar-violet', 'avatar-pink', 'avatar-teal', 'avatar-orange'];

function getAvatarClass(name) {
  if (!name) return 'avatar-indigo';
  return AVATAR_CLASSES[name.charCodeAt(0) % AVATAR_CLASSES.length];
}

const STATUS_INFO = {
  active: { label: '在职', cls: 'status-active' },
  disabled: { label: '已停用', cls: 'status-disabled' }
};

function getStatusInfo(status) {
  return STATUS_INFO[status] || { label: status || '—', cls: 'status-archived' };
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('zh-CN');
}

function EmployeeList() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({ name: '', account: '', password: '', department: '', status: 'active' });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  // 删除：站内弹窗确认；被任务占用时留在弹窗里给出替代路径，而不是把报错吞进 console。
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [blockedReason, setBlockedReason] = useState('');
  // 停用：可直接在列表里切，但停用会挡住登录，所以单独确认一次。
  const [pendingDisable, setPendingDisable] = useState(null);
  const [togglingId, setTogglingId] = useState('');

  useEffect(() => { fetchEmployees(); }, []);

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      const response = await employeeAPI.getAll();
      setEmployees(response.data);
      setLoadError('');
    } catch (error) {
      console.error('获取员工失败:', error);
      const reason = error?.response?.data?.error || '团队成员加载失败，请重试';
      setLoadError(reason);
      toast.error(reason);
    } finally {
      setLoading(false);
    }
  };

  // 搜索放在前端：成员量级很小，不值得为它加一个后端查询参数。
  const visibleEmployees = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(emp => [emp.name, emp.account, emp.department]
      .some(field => String(field || '').toLowerCase().includes(q)));
  }, [employees, keyword]);

  const activeCount = employees.filter(emp => emp.status !== 'disabled').length;
  const disabledCount = employees.length - activeCount;

  const openDrawer = (emp = null) => {
    setFormError('');
    if (emp) {
      setFormData({
        name: emp.name || '',
        account: emp.account || '',
        password: '',
        department: emp.department || '',
        status: emp.status || 'active'
      });
      setEditingId(emp._id);
    } else {
      setFormData({ name: '', account: '', password: '', department: '', status: 'active' });
      setEditingId(null);
    }
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditingId(null);
    setFormError('');
    setFormData({ name: '', account: '', password: '', department: '', status: 'active' });
  };

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    if (!formData.name.trim()) { setFormError('请填写姓名'); return; }
    if (!formData.account.trim()) { setFormError('请填写登录账号'); return; }
    if (!editingId && formData.password.length < 6) { setFormError('密码至少 6 位'); return; }
    if (editingId && formData.password && formData.password.length < 6) { setFormError('新密码至少 6 位'); return; }

    try {
      setSaving(true);
      if (editingId) {
        // 密码留空表示不改：不要把空字符串发给后端，否则会触发「密码至少 6 位」。
        const { password, ...rest } = formData;
        await employeeAPI.update(editingId, password ? { ...rest, password } : rest);
        toast.success(`已保存「${formData.name}」的账号信息`);
      } else {
        await employeeAPI.create(formData);
        toast.success(`已添加成员「${formData.name}」，可以把这个账号发给 TA 了`);
      }
      closeDrawer();
      fetchEmployees();
    } catch (error) {
      console.error('保存员工失败:', error);
      const reason = error?.response?.data?.error || '保存失败，请重试';
      // 留在抽屉里显示原因（账号冲突这类问题需要用户当场改），同时给一条全局提示。
      setFormError(reason);
      toast.error(reason);
    } finally {
      setSaving(false);
    }
  };

  const applyStatus = async (emp, next) => {
    setTogglingId(emp._id);
    try {
      await employeeAPI.update(emp._id, { status: next });
      toast.success(next === 'disabled'
        ? `已停用「${emp.name}」，该账号将无法登录，历史任务记录保留`
        : `已恢复「${emp.name}」的登录权限`);
      fetchEmployees();
    } catch (error) {
      console.error('更新员工状态失败:', error);
      toast.error(error?.response?.data?.error || '状态更新失败，请重试');
    } finally {
      setTogglingId('');
    }
  };

  const handleStatusChange = (emp, next) => {
    if (next === emp.status) return;
    // 停用是要挡住别人登录的动作，确认一次；恢复登录是安全的，直接生效。
    if (next === 'disabled') {
      setPendingDisable(emp);
      return;
    }
    applyStatus(emp, next);
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await employeeAPI.delete(pendingDelete._id);
      toast.success(`已删除成员「${pendingDelete.name}」`);
      setPendingDelete(null);
      setBlockedReason('');
      fetchEmployees();
    } catch (error) {
      console.error('删除员工失败:', error);
      const reason = error?.response?.data?.error || '删除失败，请重试';
      // 后端在员工名下还有任务时会返回 409。以前这条信息只进了 console，
      // 用户点了删除什么都没发生——现在留在弹窗里，并给出「改为停用」的出口。
      setBlockedReason(reason);
      if (error?.response?.status === 409) toast.warning(reason);
      else toast.error(reason);
    } finally {
      setDeleting(false);
    }
  };

  const disableInstead = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await employeeAPI.update(pendingDelete._id, { status: 'disabled' });
      toast.success(`已停用「${pendingDelete.name}」，账号与历史任务都保留`);
      setPendingDelete(null);
      setBlockedReason('');
      fetchEmployees();
    } catch (error) {
      console.error('停用员工失败:', error);
      toast.error(error?.response?.data?.error || '停用失败，请重试');
    } finally {
      setDeleting(false);
    }
  };

  const hasKeyword = keyword.trim().length > 0;

  return (
    <div>
      {loadError && <div className="error-message">{loadError}</div>}

      <div className="page-header">
        <div>
          <h1 className="page-title">团队成员</h1>
          <div className="page-subtitle">管理员工登录账号、启用状态与密码</div>
        </div>
        <div>
          <button className="btn btn-primary" onClick={() => openDrawer()}>
            ＋ 添加员工
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon stat-icon-blue"><Users className="h-5 w-5 text-blue-600" /></div>
          <div>
            <div className="stat-value">{employees.length}</div>
            <div className="stat-label">全部成员</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-green"><UserCheck className="h-5 w-5 text-emerald-600" /></div>
          <div>
            <div className="stat-value">{activeCount}</div>
            <div className="stat-label">在职可登录</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-yellow"><UserMinus className="h-5 w-5 text-slate-500" /></div>
          <div>
            <div className="stat-value">{disabledCount}</div>
            <div className="stat-label">已停用</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="filter-bar">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              className="form-input"
              style={{ paddingLeft: '2.25rem' }}
              placeholder="搜索姓名 / 账号 / 部门"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              aria-label="搜索团队成员"
            />
          </div>
          <span className="ml-auto text-xs text-slate-400">
            {loading ? '加载中…' : `共 ${visibleEmployees.length} 条`}
          </span>
          {hasKeyword && (
            <button className="btn btn-ghost btn-sm" onClick={() => setKeyword('')}>清除搜索</button>
          )}
        </div>

        {loading ? (
          <div className="loading">
            <span className="loading-spinner" />
            加载中...
          </div>
        ) : employees.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">👥</div>
            <p>还没有团队成员，添加后他们才能登录创作端</p>
            <button className="btn btn-primary inline-flex w-fit" onClick={() => openDrawer()}>
              添加第一个成员
            </button>
          </div>
        ) : visibleEmployees.length === 0 ? (
          /* 和「一个成员都没有」区分开：这里是搜不到，不是没数据。 */
          <div className="empty-state">
            <div className="empty-state-icon">🔍</div>
            <p>没有匹配「{keyword.trim()}」的成员</p>
            <button className="btn btn-secondary inline-flex w-fit" onClick={() => setKeyword('')}>
              清除搜索，查看全部 {employees.length} 人
            </button>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>员工</th>
                  <th>账号</th>
                  <th>部门</th>
                  <th>状态</th>
                  <th>加入时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleEmployees.map(emp => {
                  const { label: statusLabel, cls: statusCls } = getStatusInfo(emp.status);
                  const toggling = togglingId === emp._id;

                  return (
                    <tr key={emp._id}>
                      <td>
                        <div className="avatar-cell">
                          <div className={`avatar ${getAvatarClass(emp.name)}`}>
                            {emp.name?.[0]}
                          </div>
                          <span className="table-cell-primary">{emp.name}</span>
                        </div>
                      </td>
                      <td><span className="table-cell-sub">{emp.account || '—'}</span></td>
                      <td>{emp.department || <span className="cell-empty">—</span>}</td>
                      <td>
                        {/* 状态可以直接切；停用会挡住登录，所以会先确认一次。 */}
                        <select
                          className={`status-select status-badge ${statusCls}`}
                          value={emp.status || 'active'}
                          disabled={toggling}
                          onChange={(e) => handleStatusChange(emp, e.target.value)}
                          aria-label={`${emp.name}的账号状态`}
                        >
                          <option value="active">在职</option>
                          <option value="disabled">已停用</option>
                        </select>
                      </td>
                      <td><span className="table-cell-sub">{formatDate(emp.createdAt)}</span></td>
                      <td>
                        <div className="flex gap-1.5">
                          <button className="btn btn-secondary btn-sm" onClick={() => openDrawer(emp)}>
                            编辑
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => { setBlockedReason(''); setPendingDelete(emp); }}>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {drawerOpen && (
        <>
          <div className="drawer-overlay" onClick={closeDrawer} />
          <div className="drawer">
            <div className="drawer-header">
              <div className="drawer-title">{editingId ? '编辑员工账号' : '添加员工账号'}</div>
              <button className="drawer-close" onClick={closeDrawer} aria-label="关闭">✕</button>
            </div>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div className="drawer-body">
                {formError && <div className="error-message">{formError}</div>}

                <div className="form-group">
                  <label className="form-label form-label-required" htmlFor="emp-name">姓名</label>
                  <input
                    id="emp-name"
                    type="text"
                    name="name"
                    className="form-input"
                    value={formData.name}
                    onChange={handleChange}
                    placeholder="请输入姓名"
                    autoFocus
                  />
                </div>

                <div className="form-group">
                  <label className="form-label form-label-required" htmlFor="emp-account">登录账号</label>
                  <input
                    id="emp-account"
                    type="text"
                    name="account"
                    className="form-input"
                    value={formData.account}
                    onChange={handleChange}
                    placeholder="员工用来登录的账号，全站唯一"
                  />
                  {editingId && <div className="form-hint">改账号后需要把新账号告知该员工。</div>}
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="emp-department">部门</label>
                  <input
                    id="emp-department"
                    type="text"
                    name="department"
                    className="form-input"
                    value={formData.department}
                    onChange={handleChange}
                    placeholder="如：内容组（可留空）"
                  />
                </div>

                <div className="form-group">
                  <label className={`form-label${editingId ? '' : ' form-label-required'}`} htmlFor="emp-password">密码</label>
                  <input
                    id="emp-password"
                    type="password"
                    name="password"
                    className="form-input"
                    value={formData.password}
                    onChange={handleChange}
                    placeholder={editingId ? '留空则保留原密码' : '至少 6 位'}
                  />
                  <div className="form-hint">
                    {editingId ? '只有需要重置密码时才填写，留空不会改动原密码。' : '账号密码由你创建后转告员工。'}
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="emp-status">状态</label>
                  <select
                    id="emp-status"
                    name="status"
                    className="form-select"
                    value={formData.status}
                    onChange={handleChange}
                  >
                    <option value="active">在职（可登录）</option>
                    <option value="disabled">已停用（禁止登录）</option>
                  </select>
                  <div className="form-hint">停用不会删除任何任务与产出，只是挡住登录。</div>
                </div>
              </div>
              <div className="drawer-footer">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? '保存中…' : (editingId ? '保存修改' : '添加员工')}
                </button>
                <button type="button" className="btn btn-secondary" onClick={closeDrawer}>
                  取消
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      <ConfirmDialog
        open={Boolean(pendingDisable)}
        onOpenChange={open => { if (!open) setPendingDisable(null); }}
        title="停用这个账号？"
        description={
          <>
            「{pendingDisable?.name}」将无法再登录创作端，名下已有的任务与产出不会删除。
            需要时可以在这里重新恢复为在职。
          </>
        }
        confirmLabel="停用账号"
        tone="primary"
        onConfirm={() => {
          const emp = pendingDisable;
          setPendingDisable(null);
          applyStatus(emp, 'disabled');
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={open => { if (!open) { setPendingDelete(null); setBlockedReason(''); } }}
        title="删除这个成员？"
        description={
          <>
            <span>
              将删除「{pendingDelete?.name}」（账号 {pendingDelete?.account || '—'}）的登录账号，
              该账号立刻失效。任务与产出记录会保留，但不再归属到具体成员。
            </span>
            {blockedReason && (
              <span className="mt-2.5 flex flex-col gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
                <span className="text-amber-800">{blockedReason}</span>
                {/* ⚠️ 弹窗挂在 body 上的 portal 里，不在 .manager-workspace 子树内，
                    所以这里不能用 .btn 这类 manager.css 的类（会完全没有样式），
                    只用全局的 Tailwind 工具类，和 ConfirmDialog 自己的按钮保持一致。 */}
                <button
                  type="button"
                  className="inline-flex h-9 w-fit items-center justify-center rounded-xl border border-slate-200 bg-white px-3.5 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-55"
                  disabled={deleting}
                  onClick={disableInstead}
                >
                  改为停用该账号
                </button>
              </span>
            )}
          </>
        }
        confirmLabel="确认删除"
        cancelLabel={blockedReason ? '返回' : '取消'}
        loading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}

export default EmployeeList;
