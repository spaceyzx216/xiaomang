import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { CircleDashed, CircleDot, CircleCheckBig, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { taskAPI } from '../services/api';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';

const AVATAR_CLASSES = ['avatar-indigo', 'avatar-violet', 'avatar-pink', 'avatar-teal', 'avatar-orange'];

function getAvatarClass(name) {
  if (!name) return 'avatar-indigo';
  const idx = name.charCodeAt(0) % AVATAR_CLASSES.length;
  return AVATAR_CLASSES[idx];
}

const STATUS_LABELS = { pending: '待处理', in_progress: '进行中', completed: '已完成' };

function getStatusInfo(status) {
  switch (status) {
    case 'pending':
      return { label: '待处理', cls: 'status-pending' };
    case 'in_progress':
      return { label: '进行中', cls: 'status-in_progress' };
    case 'completed':
      return { label: '已完成', cls: 'status-completed' };
    default:
      return { label: status, cls: '' };
  }
}

function getPriorityInfo(priority) {
  switch (priority) {
    case 'high':
      return { label: '高', cls: 'priority-high' };
    case 'medium':
      return { label: '中', cls: 'priority-medium' };
    case 'low':
      return { label: '低', cls: 'priority-low' };
    default:
      return { label: priority, cls: '' };
  }
}

function isOverdue(collaborationPeriod) {
  if (!collaborationPeriod?.end) return false;
  return new Date(collaborationPeriod.end) < new Date();
}

/**
 * 取任务的客户 id。
 *
 * `/api/management/tasks` 返回的 `customerId` 是**已 populate 的对象**（`{_id, name, …}`）
 * 而不是字符串。直接 String() 会得到 "[object Object]"，导致客户筛选永远筛不出东西、
 * 「查看产出」链接也会拼成 /topics?customerId=[object Object]。这里统一把两种形态都收成 id。
 */
function getTaskCustomerId(task) {
  const raw = task?.customerId;
  if (!raw) return '';
  return String(typeof raw === 'object' ? raw._id || '' : raw);
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function TaskList() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: '', employeeId: '', date: '' });
  const [detailTask, setDetailTask] = useState(null);
  // 删除确认：先把要删的任务挂起来，用户在站内弹窗里确认后才真正请求。
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // 「已完成」改回未完成属于回退操作，单独确认一次。
  const [pendingStatus, setPendingStatus] = useState(null);
  const [savingStatusId, setSavingStatusId] = useState('');
  const [notice, setNotice] = useState(location.state?.message || '');

  // 从客户档案跳过来时带着 ?customerId=：只显示这个客户的任务。
  const customerId = searchParams.get('customerId') || '';

  useEffect(() => {
    fetchTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const params = {};
      if (filter.status) params.status = filter.status;
      if (filter.employeeId) params.employeeId = filter.employeeId;
      if (filter.date) params.date = filter.date;
      const response = await taskAPI.getAll(params);
      setTasks(response.data);
    } catch (error) {
      console.error('获取任务失败:', error);
      toast.error('任务列表加载失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  /**
   * 客户维度的筛选放在前端做：后端 /tasks 只支持 employeeId / projectId / status / date，
   * 没有 customerId。这里不为了一个筛选去改后端接口，代价只是把已取回的一页数据再过滤一遍。
   */
  const visibleTasks = useMemo(
    () => (customerId ? tasks.filter(task => getTaskCustomerId(task) === customerId) : tasks),
    [tasks, customerId],
  );

  const customerLabel = useMemo(() => {
    const hit = tasks.find(task => getTaskCustomerId(task) === customerId);
    // 从客户档案页跳过来时名字由 state 带过来，避免这里显示成「已选定」。
    return hit?.customerName || location.state?.customerName || '';
  }, [tasks, customerId, location.state]);

  const clearCustomerFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('customerId');
    setSearchParams(next, { replace: true });
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await taskAPI.delete(pendingDelete._id);
      toast.success(`已删除任务「${pendingDelete.customerName || '未命名任务'}」`);
      setPendingDelete(null);
      fetchTasks();
    } catch (error) {
      console.error('删除任务失败:', error);
      toast.error(error?.response?.data?.error || '删除失败，请重试');
    } finally {
      setDeleting(false);
    }
  };

  const applyStatus = async (task, next) => {
    setSavingStatusId(task._id);
    try {
      await taskAPI.update(task._id, { status: next });
      toast.success(`「${task.customerName || '未命名任务'}」已更新为${STATUS_LABELS[next] || next}`);
      setDetailTask(prev => (prev && prev._id === task._id ? { ...prev, status: next } : prev));
      fetchTasks();
    } catch (error) {
      console.error('更新任务状态失败:', error);
      toast.error(error?.response?.data?.error || '状态更新失败，请重试');
    } finally {
      setSavingStatusId('');
    }
  };

  const handleStatusChange = (task, next) => {
    if (next === task.status) return;
    // 回退（已完成 → 未完成）需要确认；前进直接生效，避免每改一次状态都弹窗。
    if (task.status === 'completed' && next !== 'completed') {
      setPendingStatus({ task, next });
      return;
    }
    applyStatus(task, next);
  };

  const pending = visibleTasks.filter((t) => t.status === 'pending').length;
  const inProgress = visibleTasks.filter((t) => t.status === 'in_progress').length;
  const completed = visibleTasks.filter((t) => t.status === 'completed').length;
  const hasFilter = Boolean(filter.status || filter.date || customerId);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">任务列表</h1>
          <div className="page-subtitle">管理和追踪所有项目任务</div>
        </div>
        <Link to="/manager/tasks/new" className="btn btn-primary">
          <span>＋</span> 新建任务
        </Link>
      </div>

      {notice && (
        <div className="ip-message success customer-list-message flex items-start justify-between gap-3">
          <span>{notice}</span>
          <button type="button" className="shrink-0 text-emerald-700/70 transition hover:text-emerald-800" onClick={() => setNotice('')} aria-label="关闭提示">✕</button>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon stat-icon-yellow"><CircleDashed className="h-5 w-5 text-amber-500" /></div>
          <div>
            <div className="stat-value">{pending}</div>
            <div className="stat-label">待处理</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-blue"><CircleDot className="h-5 w-5 text-blue-600" /></div>
          <div>
            <div className="stat-value">{inProgress}</div>
            <div className="stat-label">进行中</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-green"><CircleCheckBig className="h-5 w-5 text-emerald-600" /></div>
          <div>
            <div className="stat-value">{completed}</div>
            <div className="stat-label">已完成</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="filter-bar">
          <select
            className="form-select"
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value })}
          >
            <option value="">全部状态</option>
            <option value="pending">待处理</option>
            <option value="in_progress">进行中</option>
            <option value="completed">已完成</option>
          </select>

          <input
            type="date"
            className="form-input"
            value={filter.date}
            onChange={(e) => setFilter({ ...filter, date: e.target.value })}
          />

          {customerId && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700">
              客户：{customerLabel || '已选定'}
              <button type="button" onClick={clearCustomerFilter} className="transition hover:text-blue-900" aria-label="清除客户筛选">
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          )}

          {/* 筛选变化会自动重新拉取，这里不再放一个语义重复的「刷新」，只如实报结果条数。 */}
          <span className="ml-auto text-xs text-slate-400">
            {loading ? '加载中…' : `共 ${visibleTasks.length} 条`}
          </span>

          {hasFilter && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setFilter({ status: '', employeeId: '', date: '' });
                clearCustomerFilter();
              }}
            >
              清除筛选
            </button>
          )}
        </div>

        {loading ? (
          <div className="loading">
            <span className="loading-spinner" />
            加载中...
          </div>
        ) : tasks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📭</div>
            <p>还没有任何任务</p>
            <Link to="/manager/tasks/new" className="btn btn-primary inline-flex w-fit">
              创建第一个任务
            </Link>
          </div>
        ) : visibleTasks.length === 0 ? (
          /* 和「一条都没有」区分开：这里是筛掉了，不是没数据。 */
          <div className="empty-state">
            <div className="empty-state-icon">🔍</div>
            <p>当前筛选条件下没有任务</p>
            <button
              className="btn btn-secondary inline-flex w-fit"
              onClick={() => {
                setFilter({ status: '', employeeId: '', date: '' });
                clearCustomerFilter();
              }}
            >
              清除筛选，查看全部 {tasks.length} 条
            </button>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>客户 / 任务信息</th>
                  <th>负责人</th>
                  <th>目标平台</th>
                  <th>任务周期</th>
                  <th>优先级</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleTasks.map((task) => {
                  const { label: priorityLabel, cls: priorityCls } = getPriorityInfo(task.priority);
                  const { cls: statusCls } = getStatusInfo(task.status);
                  const overdue = isOverdue(task.collaborationPeriod) && task.status !== 'completed';
                  const ownerName = task.ownerId?.name;
                  const saving = savingStatusId === task._id;

                  return (
                    <tr key={task._id}>
                      <td style={{ maxWidth: 340, minWidth: 220 }}>
                        <div className="table-cell-primary">{task.customerName}</div>
                        <div className="table-cell-sub">联系方式：{task.contact || '—'}</div>
                        <div className="table-cell-sub">
                          内容需求：
                          <span className="cell-clamp">{task.contentDirection || '—'}</span>
                        </div>
                        <div className="table-cell-sub">
                          对标账号：
                          <span className="cell-clamp">{task.benchmarkAccounts || '—'}</span>
                        </div>
                        <div className="table-cell-sub">
                          备注：
                          <span className="cell-clamp">{task.notes || '—'}</span>
                        </div>
                      </td>
                      <td>
                        {ownerName ? (
                          <div className="avatar-cell">
                            <div className={`avatar ${getAvatarClass(ownerName)}`}>
                              {ownerName[0]}
                            </div>
                            <span>{ownerName}</span>
                          </div>
                        ) : (
                          <span className="cell-empty">—</span>
                        )}
                      </td>
                      <td>{task.platformName || <span className="cell-empty">—</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {task.collaborationPeriod ? (
                          <span className={overdue ? 'text-[13px] font-medium text-rose-600' : 'text-[13px] text-slate-600'}>
                            {formatDateTime(task.collaborationPeriod.start)}
                            <span className="mx-1 text-slate-300">~</span>
                            {formatDateTime(task.collaborationPeriod.end)}
                            {overdue && <span className="ml-1.5 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600">逾期</span>}
                          </span>
                        ) : (
                          <span className="cell-empty">—</span>
                        )}
                      </td>
                      <td>
                        <span className={`priority-badge ${priorityCls}`}>{priorityLabel}</span>
                      </td>
                      <td>
                        {/* 状态可以直接改，但改完一定有反馈；回退到未完成会先确认。 */}
                        <select
                          className={`status-select status-badge ${statusCls}`}
                          value={task.status}
                          disabled={saving}
                          onChange={(e) => handleStatusChange(task, e.target.value)}
                          aria-label={`${task.customerName || '任务'}的状态`}
                        >
                          <option value="pending">待处理</option>
                          <option value="in_progress">进行中</option>
                          <option value="completed">已完成</option>
                        </select>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'nowrap' }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => setDetailTask(task)}>
                            详情
                          </button>
                          {/* 经理端的产出闭环入口：直接看这个客户已经沉淀下来的选题与脚本。 */}
                          {getTaskCustomerId(task) && (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => navigate(`/topics?view=newVideos&customerId=${encodeURIComponent(getTaskCustomerId(task))}`)}
                            >
                              查看产出
                            </button>
                          )}
                          <button className="btn btn-danger btn-sm" onClick={() => setPendingDelete(task)}>
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

      {detailTask && (
        <>
          <div className="drawer-overlay" onClick={() => setDetailTask(null)} />
          <div className="task-detail-modal">
            <div className="task-detail-header">
              <div>
                <div className="task-detail-title">任务详情</div>
                <div className="task-detail-subtitle">{detailTask.customerName || '未命名任务'}</div>
              </div>
              <button className="drawer-close" onClick={() => setDetailTask(null)}>✕</button>
            </div>

            <div className="task-detail-body">
              <div className="task-detail-grid">
                <div className="task-detail-item">
                  <div className="task-detail-label">客户名称</div>
                  <div className="task-detail-value">{detailTask.customerName || '—'}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">职业</div>
                  <div className="task-detail-value">{detailTask.customerOccupation || '—'}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">联系方式</div>
                  <div className="task-detail-value">{detailTask.contact || '—'}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">负责人</div>
                  <div className="task-detail-value">{detailTask.ownerId?.name || '—'}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">目标平台</div>
                  <div className="task-detail-value">{detailTask.platformName || '—'}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">任务周期</div>
                  <div className="task-detail-value">
                    {formatDateTime(detailTask.collaborationPeriod?.start)} ~ {formatDateTime(detailTask.collaborationPeriod?.end)}
                  </div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">优先级</div>
                  <div className="task-detail-value">{getPriorityInfo(detailTask.priority).label}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">状态</div>
                  <div className="task-detail-value">{getStatusInfo(detailTask.status).label}</div>
                </div>
              </div>

              <div className="task-detail-item">
                <div className="task-detail-label">个人IP定位</div>
                <div className="task-detail-value">{detailTask.ipPositioning || '—'}</div>
              </div>

              <div className="task-detail-item">
                <div className="task-detail-label">内容需求 / 创意方向</div>
                <div className="task-detail-value">{detailTask.contentDirection || '—'}</div>
              </div>

              <div className="task-detail-item">
                <div className="task-detail-label">对标账号</div>
                <div className="task-detail-value">{detailTask.benchmarkAccounts || '—'}</div>
              </div>

              <div className="task-detail-item">
                <div className="task-detail-label">备注</div>
                <div className="task-detail-value">{detailTask.notes || '—'}</div>
              </div>
            </div>

            <div className="task-detail-footer">
              <button className="btn btn-secondary" onClick={() => setDetailTask(null)}>
                关闭
              </button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={open => { if (!open) setPendingDelete(null); }}
        title="删除这条任务？"
        description={
          <>
            将删除「{pendingDelete?.customerName || '未命名任务'}」的任务记录，创建时间
            {pendingDelete?.createdAt ? ` ${formatDateTime(pendingDelete.createdAt)}` : ''}。
            删除后无法恢复；员工侧已经产出的选题与文案不会一并删除。
          </>
        }
        confirmLabel="删除任务"
        loading={deleting}
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={Boolean(pendingStatus)}
        onOpenChange={open => { if (!open) setPendingStatus(null); }}
        title="把已完成的任务改回未完成？"
        description={
          <span className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>
              「{pendingStatus?.task?.customerName || '未命名任务'}」将回到
              「{STATUS_LABELS[pendingStatus?.next] || ''}」，该任务在统计里不再计入已完成。
            </span>
          </span>
        }
        confirmLabel="确认回退"
        tone="primary"
        onConfirm={() => {
          const { task, next } = pendingStatus;
          setPendingStatus(null);
          applyStatus(task, next);
        }}
      />
    </div>
  );
}

export default TaskList;
