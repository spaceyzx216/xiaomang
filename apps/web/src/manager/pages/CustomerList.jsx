import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { customerAPI } from '../services/api';

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN');
}

function getIpStatusInfo(status) {
  switch (status) {
    case 'confirmed': return { label: '已确认', className: 'ip-status-confirmed' };
    case 'needs_review': return { label: '待确认', className: 'ip-status-review' };
    case 'draft': return { label: '草稿', className: 'ip-status-draft' };
    default: return { label: '未开始', className: 'ip-status-not-started' };
  }
}

function CustomerList() {
  const location = useLocation();
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [notice, setNotice] = useState(location.state?.message || '');

  useEffect(() => {
    fetchCustomers();
  }, []);

  const fetchCustomers = async () => {
    try {
      setLoading(true);
      const response = await customerAPI.getAll();
      setCustomers(response.data);
      setLoadError('');
    } catch (error) {
      console.error('获取客户失败:', error);
      const reason = error?.response?.data?.error || '客户档案加载失败，请重试';
      setLoadError(reason);
      toast.error(reason);
    } finally {
      setLoading(false);
    }
  };

  const visibleCustomers = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(item => [item.name, item.occupation, item.contact]
      .some(field => String(field || '').toLowerCase().includes(q)));
  }, [customers, keyword]);

  const hasKeyword = keyword.trim().length > 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">客户档案</h1>
          <div className="page-subtitle">采集并确认客户 IP 信息，确认后即可据此派发任务</div>
        </div>
        <div>
          <Link className="btn btn-primary" to="/manager/customers/ip-profile/new">
            ＋ 新建 IP 档案
          </Link>
        </div>
      </div>

      {loadError && <div className="error-message">{loadError}</div>}

      {notice && (
        <div className="ip-message success customer-list-message flex items-start justify-between gap-3">
          <span>{notice}</span>
          <button
            type="button"
            className="shrink-0 text-emerald-700/70 transition hover:text-emerald-800"
            onClick={() => setNotice('')}
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      )}

      <div className="card">
        <div className="filter-bar">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              className="form-input"
              style={{ paddingLeft: '2.25rem' }}
              placeholder="搜索客户 / 职业 / 联系方式"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              aria-label="搜索客户档案"
            />
          </div>
          <span className="ml-auto text-xs text-slate-400">
            {loading ? '加载中…' : `共 ${visibleCustomers.length} 条`}
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
        ) : customers.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📇</div>
            <p>还没有客户档案，先采集一份 IP 信息才能派发任务</p>
            <Link className="btn btn-primary inline-flex w-fit" to="/manager/customers/ip-profile/new">
              新建第一份 IP 档案
            </Link>
          </div>
        ) : visibleCustomers.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🔍</div>
            <p>没有匹配「{keyword.trim()}」的客户</p>
            <button className="btn btn-secondary inline-flex w-fit" onClick={() => setKeyword('')}>
              清除搜索，查看全部 {customers.length} 条
            </button>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>客户</th>
                  <th>联系方式</th>
                  <th>IP 档案</th>
                  <th>最近更新</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleCustomers.map((customer) => {
                  const summary = customer.ipProfileSummary || {};
                  const status = getIpStatusInfo(summary.status);
                  const completion = summary.completion || { completed: 0, total: 3, percentage: 0 };
                  const ready = summary.status === 'confirmed';
                  return (
                    <tr key={customer._id}>
                      <td>
                        <div className="table-cell-primary">{customer.name}</div>
                        <div className="table-cell-sub">{customer.occupation || '尚未填写职业身份'}</div>
                      </td>
                      <td>{customer.contact || <span className="cell-empty">—</span>}</td>
                      <td>
                        <div className="customer-ip-summary">
                          <span className={`ip-status ${status.className}`}>{status.label}</span>
                          <span className="table-cell-sub">
                            {completion.completed}/{completion.total} 组 · {summary.profileVersion ? `v${summary.profileVersion}` : '未确认'}
                          </span>
                        </div>
                      </td>
                      <td><span className="table-cell-sub">{formatDate(summary.updatedAt || customer.updatedAt || customer.createdAt)}</span></td>
                      <td>
                        <div className="customer-row-actions">
                          {/* 档案未确认时把「补档案」放前面，因为这才是当前该做的事。 */}
                          <Link
                            className={`btn btn-sm ${ready ? 'btn-secondary' : 'btn-primary'}`}
                            to={`/manager/customers/${customer._id}/ip-profile`}
                          >
                            {ready ? '查看 IP 档案' : '完善 IP 档案'}
                          </Link>
                          {/* 反向动线：从客户直接看这个客户已经派发出去的任务。
                              客户名通过 state 带过去，这样任务页的筛选标签能显示是谁，
                              而不用把名字塞进 URL。 */}
                          <Link
                            className="btn btn-secondary btn-sm"
                            to={`/manager/tasks?customerId=${customer._id}`}
                            state={{ customerName: customer.name }}
                          >
                            查看任务
                          </Link>
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
    </div>
  );
}

export default CustomerList;
