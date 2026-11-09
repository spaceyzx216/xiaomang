import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { TriangleAlert } from 'lucide-react';
import { taskAPI, employeeAPI, customerAPI } from '../services/api';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';

function splitContentRequirements(value) {
  return [...new Set(String(value || '')
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean))].slice(0, 8);
}

const PROFILE_PREVIEW_SECTIONS = [
  {
    label: '身份信息',
    fields: [
      ['姓名 / 昵称', 'identity.name', 'name'],
      ['年龄', 'identity.age'],
      ['MBTI', 'identity.mbti'],
      ['人设反差点', 'identity.personaContrast'],
      ['职业身份', 'identity.occupation', 'occupation'],
      ['从业年限', 'identity.yearsExperience'],
      ['关键项目 / 代表案例', 'identity.keyCases']
    ]
  },
  {
    label: '产品信息',
    fields: [
      ['业务模式', 'product.businessModel'],
      ['产品类型', 'product.productType'],
      ['产品价格 / 区间', 'product.priceRange'],
      ['核心优势', 'product.coreAdvantages']
    ]
  },
  {
    label: '用户画像',
    fields: [
      ['性别', 'userProfile.gender'],
      ['年龄', 'userProfile.age'],
      ['职业 / 行业', 'userProfile.occupationIndustry'],
      ['收入水平', 'userProfile.incomeLevel'],
      ['消费习惯', 'userProfile.consumptionHabits'],
      ['消费场景', 'userProfile.consumptionScenarios'],
      ['痛点', 'userProfile.painPoints'],
      ['目标 / 需求', 'userProfile.goalsNeeds']
    ]
  }
];

function getPreviewValue(customer, path, fallbackKey) {
  const value = path.split('.').reduce((current, key) => current?.[key], customer?.ipProfile);
  if (String(value || '').trim()) return value;
  if (fallbackKey === 'name') return customer?.name || '';
  if (fallbackKey === 'occupation') return customer?.occupation || '';
  return '';
}

function combineLocalDateTime(date, time) {
  const value = new Date(`${date}T${time}`);
  return Number.isNaN(value.getTime()) ? '' : value.toISOString();
}

function TaskForm() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [customerLoading, setCustomerLoading] = useState(true);
  const [customerLoadError, setCustomerLoadError] = useState('');
  const [errors, setErrors] = useState({});
  const [profilePreviewOpen, setProfilePreviewOpen] = useState(false);
  const [confirmUnconfirmed, setConfirmUnconfirmed] = useState(false);

  const [formData, setFormData] = useState({
    customerId: '',
    contentRequirementsText: '',
    benchmarkAccounts: '',
    ownerId: '',
    platformName: '',
    collaborationStartDate: '',
    collaborationStartTime: '',
    collaborationEndDate: '',
    collaborationEndTime: '',
    priority: 'medium'
  });

  useEffect(() => {
    const fetchOptions = async () => {
      const [employeeResult, customerResult] = await Promise.allSettled([
        employeeAPI.getOptions(),
        customerAPI.getAll()
      ]);

      if (employeeResult.status === 'fulfilled') {
        setEmployees(employeeResult.value.data);
      } else {
        console.error('获取负责人失败:', employeeResult.reason);
      }

      if (customerResult.status === 'fulfilled') {
        setCustomers(customerResult.value.data);
        setCustomerLoadError('');
      } else {
        console.error('获取客户档案失败:', customerResult.reason);
        setCustomerLoadError(customerResult.reason?.response?.data?.error || '客户档案加载失败，请刷新重试');
      }
      setCustomerLoading(false);
    };
    fetchOptions();
  }, []);

  useEffect(() => {
    if (!profilePreviewOpen) return undefined;
    const handleEscape = (event) => {
      if (event.key === 'Escape') setProfilePreviewOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [profilePreviewOpen]);

  const selectedCustomer = customers.find((customer) => customer._id === formData.customerId);
  const selectedProfileSummary = selectedCustomer?.ipProfileSummary;
  // 文本框里写的是「逗号/换行分隔」的多个标签，这里实时解析出来给用户看，避免写完不知道会被切成什么。
  const requirementTags = useMemo(
    () => splitContentRequirements(formData.contentRequirementsText),
    [formData.contentRequirementsText],
  );

  const handleChange = (event) => {
    const { name, value } = event.target;
    setFormData((current) => ({ ...current, [name]: value }));
    if (errors[name]) setErrors((current) => ({ ...current, [name]: '' }));
    if (name === 'customerId') setProfilePreviewOpen(false);
  };

  const validate = () => {
    const nextErrors = {};
    if (!formData.customerId) nextErrors.customerId = '请选择客户档案';
    if (!formData.ownerId) nextErrors.ownerId = '请选择负责人';
    if (!formData.platformName) nextErrors.platformName = '请选择目标平台';

    const hasCompletePeriod = formData.collaborationStartDate
      && formData.collaborationStartTime
      && formData.collaborationEndDate
      && formData.collaborationEndTime;
    if (!hasCompletePeriod) {
      nextErrors.collaborationPeriod = '请选择完整的起止日期和时间';
    } else if (combineLocalDateTime(formData.collaborationStartDate, formData.collaborationStartTime)
      >= combineLocalDateTime(formData.collaborationEndDate, formData.collaborationEndTime)) {
      nextErrors.collaborationPeriod = '结束时间需要晚于开始时间';
    }
    return nextErrors;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const nextErrors = validate();
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    // 档案没确认不硬拦（业务上确实可能有「先建任务、回头补档案」的情况），但要用户
    // 明确知道自己在建一条基于未确认档案的任务。
    if (selectedProfileSummary?.status !== 'confirmed') {
      setConfirmUnconfirmed(true);
      return;
    }
    await submitTask();
  };

  const submitTask = async () => {
    try {
      setLoading(true);
      const created = await taskAPI.create({
        customerId: formData.customerId,
        useCustomerProfile: true,
        ownerId: formData.ownerId,
        platformName: formData.platformName,
        contentRequirements: splitContentRequirements(formData.contentRequirementsText),
        benchmarkAccounts: formData.benchmarkAccounts,
        priority: formData.priority,
        status: 'pending',
        collaborationPeriod: {
          start: combineLocalDateTime(formData.collaborationStartDate, formData.collaborationStartTime),
          end: combineLocalDateTime(formData.collaborationEndDate, formData.collaborationEndTime)
        }
      });
      // 回列表页时明确告诉他建成了什么，而不是默默跳走后什么都不说。
      const ownerName = employees.find(item => item._id === formData.ownerId)?.name;
      const customerName = selectedCustomer?.name;
      navigate('/manager/tasks', {
        state: {
          message: `已创建任务：${customerName || '客户'} · ${formData.platformName}${ownerName ? ` · 负责人 ${ownerName}` : ''}`
        }
      });
      return created;
    } catch (error) {
      console.error('创建任务失败:', error);
      setErrors({ _general: error?.response?.data?.error || '创建任务失败，请重试' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="task-form-page">
      {/* 其余经理端页面都有统一的 page-header，这一页原来直接就是两张卡，进去像掉进了表单里。 */}
      <div className="page-header">
        <div>
          <h1 className="page-title">新建任务</h1>
          <div className="page-subtitle">选择客户档案与负责人，指派一条内容生产任务</div>
        </div>
        <div>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/manager/tasks')}>
            返回任务列表
          </button>
        </div>
      </div>

      {errors._general && <div className="error-message">{errors._general}</div>}

      <form className="task-form-grid" onSubmit={handleSubmit} noValidate>
        <section className="card task-form-card" aria-labelledby="task-profile-title">
          <div className="task-form-card-header">
            <h2 id="task-profile-title" className="task-form-card-title">客户档案</h2>
          </div>

          <div className="task-form-card-body">
            <div className="form-group">
              <label className="form-label form-label-required" htmlFor="task-customer">
                选择客户档案
              </label>
              <select
                id="task-customer"
                name="customerId"
                className={`form-select${errors.customerId ? ' is-error' : ''}`}
                value={formData.customerId}
                onChange={handleChange}
              >
                <option value="">
                  {customerLoading ? '正在加载客户档案…' : customerLoadError ? '客户档案加载失败' : customers.length ? '请选择客户档案' : '暂无可用客户档案'}
                </option>
                {customers.map((customer) => (
                  <option key={customer._id} value={customer._id}>{customer.name}</option>
                ))}
              </select>
              {customerLoadError && <div className="form-error-text">⚠ {customerLoadError}</div>}
              {errors.customerId && <div className="form-error-text">⚠ {errors.customerId}</div>}
            </div>

            {selectedCustomer && (
              <div className="task-profile-brief">
                <div className="task-profile-brief-main">
                  <div>
                    <div className="task-profile-brief-label">{selectedCustomer.name}</div>
                    <div className="task-profile-brief-meta">
                      <span className={`ip-status ${selectedProfileSummary?.status === 'confirmed' ? 'ip-status-confirmed' : selectedProfileSummary?.status === 'needs_review' ? 'ip-status-review' : selectedProfileSummary?.status === 'draft' ? 'ip-status-draft' : 'ip-status-not-started'}`}>
                        {selectedProfileSummary?.status === 'confirmed' ? '已确认' : selectedProfileSummary?.status === 'needs_review' ? '待确认' : selectedProfileSummary?.status === 'draft' ? '草稿' : '未开始'}
                      </span>
                      <span>{selectedProfileSummary?.completion?.completed || 0}/{selectedProfileSummary?.completion?.total || 3} 组已完成</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setProfilePreviewOpen(true)}
                  >
                    预览档案
                  </button>
                </div>
                {/* 任务创建时会把 IP 档案快照写进任务（useCustomerProfile），所以档案没确认
                    就建任务，员工拿到的是一份不完整的输入。这里提前说清楚，并在提交前再确认一次。 */}
                {selectedProfileSummary?.status !== 'confirmed' && (
                  <div className="task-profile-warning">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      该客户的 IP 档案{selectedProfileSummary?.status === 'needs_review' ? '还在待确认' : '尚未完成'}，
                      创建任务时会写入当前这份未确认的档案，员工看到的内容需求可能不完整。
                      <button type="button" className="ml-1 font-semibold underline" onClick={() => setProfilePreviewOpen(true)}>先看看档案 →</button>
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="form-group">
              <label className="form-label" htmlFor="task-content-requirements">内容要求标签</label>
              <textarea
                id="task-content-requirements"
                name="contentRequirementsText"
                className="form-textarea task-form-textarea-compact"
                value={formData.contentRequirementsText}
                onChange={handleChange}
                placeholder="如：真实案例、口语化表达、给出可执行建议"
              />
              <div className="form-hint">多个标签可换行或用逗号分隔，最多 8 个。</div>
              {/* 实时回显「系统最终会存成什么」，避免用户写完不知道标签被怎么切分。 */}
              {requirementTags.length > 0 && (
                <div className="task-tag-preview">
                  <span className="task-tag-preview-label">将存为 {requirementTags.length} 个标签</span>
                  <div className="task-tag-preview-list">
                    {requirementTags.map((tag) => (
                      <span className="task-tag-chip" key={tag}>{tag}</span>
                    ))}
                  </div>
                </div>
              )}
              {splitContentRequirements(formData.contentRequirementsText).length === 8
                && String(formData.contentRequirementsText).split(/[\n,，;；]+/).map(i => i.trim()).filter(Boolean).length > 8 && (
                <div className="form-hint form-hint-warn">只保留前 8 个标签，多余的会被忽略。</div>
              )}
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="task-benchmark-accounts">对标账号</label>
              <textarea
                id="task-benchmark-accounts"
                name="benchmarkAccounts"
                className="form-textarea task-form-textarea-compact"
                value={formData.benchmarkAccounts}
                onChange={handleChange}
                placeholder="填写本次任务参考的账号或内容"
              />
            </div>
          </div>
        </section>

        <section className="card task-form-card" aria-labelledby="task-settings-title">
          <div className="task-form-card-header">
            <h2 id="task-settings-title" className="task-form-card-title">任务设置</h2>
          </div>

          <div className="task-form-card-body">
            <div className="form-group">
              <label className="form-label form-label-required" htmlFor="task-owner">负责人</label>
              <select
                id="task-owner"
                name="ownerId"
                className={`form-select${errors.ownerId ? ' is-error' : ''}`}
                value={formData.ownerId}
                onChange={handleChange}
              >
                <option value="">请选择负责人</option>
                {employees.map((employee) => (
                  <option key={employee._id} value={employee._id}>
                    {employee.name}{employee.department ? ` · ${employee.department}` : ''}
                  </option>
                ))}
              </select>
              {errors.ownerId && <div className="form-error-text">⚠ {errors.ownerId}</div>}
            </div>

            <div className="form-group">
              <div className="form-label form-label-required">任务周期</div>
              <div className="task-period-grid">
                <label className="task-period-field">
                  <span>开始</span>
                  <div className="task-date-time-row">
                    <input
                      type="date"
                      name="collaborationStartDate"
                      className={`form-input${errors.collaborationPeriod ? ' is-error' : ''}`}
                      value={formData.collaborationStartDate}
                      onChange={handleChange}
                      aria-label="任务开始日期"
                    />
                    <input
                      type="time"
                      name="collaborationStartTime"
                      className={`form-input${errors.collaborationPeriod ? ' is-error' : ''}`}
                      value={formData.collaborationStartTime}
                      onChange={handleChange}
                      step="60"
                      aria-label="任务开始时间"
                    />
                  </div>
                </label>
                <label className="task-period-field">
                  <span>结束</span>
                  <div className="task-date-time-row">
                    <input
                      type="date"
                      name="collaborationEndDate"
                      className={`form-input${errors.collaborationPeriod ? ' is-error' : ''}`}
                      value={formData.collaborationEndDate}
                      onChange={handleChange}
                      aria-label="任务结束日期"
                    />
                    <input
                      type="time"
                      name="collaborationEndTime"
                      className={`form-input${errors.collaborationPeriod ? ' is-error' : ''}`}
                      value={formData.collaborationEndTime}
                      onChange={handleChange}
                      step="60"
                      aria-label="任务结束时间"
                    />
                  </div>
                </label>
              </div>
              {errors.collaborationPeriod && <div className="form-error-text">⚠ {errors.collaborationPeriod}</div>}
            </div>

            <div className="form-group">
              <label className="form-label form-label-required" htmlFor="task-platform">目标平台</label>
              <select
                id="task-platform"
                name="platformName"
                className={`form-select${errors.platformName ? ' is-error' : ''}`}
                value={formData.platformName}
                onChange={handleChange}
              >
                <option value="">请选择目标平台</option>
                <option value="抖音">抖音</option>
                <option value="小红书">小红书</option>
                <option value="视频号">视频号</option>
                <option value="TikTok">TikTok</option>
              </select>
              {errors.platformName && <div className="form-error-text">⚠ {errors.platformName}</div>}
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="task-priority">任务优先级</label>
              <select
                id="task-priority"
                name="priority"
                className="form-select"
                value={formData.priority}
                onChange={handleChange}
              >
                <option value="high">高</option>
                <option value="medium">中</option>
                <option value="low">低</option>
              </select>
            </div>
          </div>

          <div className="task-form-card-footer">
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? '提交中…' : '创建任务'}
            </button>
          </div>
        </section>
      </form>

      {profilePreviewOpen && selectedCustomer && (
        <>
          <div className="drawer-overlay" onClick={() => setProfilePreviewOpen(false)} />
          <div
            className="customer-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="customer-preview-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="customer-preview-header">
              <div>
                <div id="customer-preview-title" className="task-detail-title">客户 IP 档案</div>
                <div className="task-detail-subtitle">{selectedCustomer.name}</div>
              </div>
              <button
                type="button"
                className="drawer-close"
                onClick={() => setProfilePreviewOpen(false)}
                aria-label="关闭客户档案预览"
              >
                ✕
              </button>
            </div>

            <div className="customer-preview-body">
              {PROFILE_PREVIEW_SECTIONS.map((section) => (
                <section key={section.label} className="customer-preview-section" aria-labelledby={`preview-${section.label}`}>
                  <h3 id={`preview-${section.label}`}>{section.label}</h3>
                  <div className="customer-preview-grid">
                    {section.fields.map(([label, path, fallbackKey]) => {
                      const value = getPreviewValue(selectedCustomer, path, fallbackKey);
                      return (
                        <div className="customer-preview-item" key={path}>
                          <div className="customer-preview-label">{label}</div>
                          <div className={`customer-preview-value${value ? '' : ' is-empty'}`}>
                            {value || '未填写'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

            <div className="customer-preview-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setProfilePreviewOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </>
      )}

      {/* 档案未确认不是错误，但需要用户点一下头，避免「不知道为什么员工拿到的是半份需求」。 */}
      <ConfirmDialog
        open={confirmUnconfirmed}
        onOpenChange={setConfirmUnconfirmed}
        tone="warning"
        title="IP 档案尚未确认"
        description={`「${selectedCustomer?.name || '该客户'}」的 IP 档案${selectedProfileSummary?.status === 'needs_review' ? '还在待确认' : '尚未完成'}。继续创建任务会把当前这份档案快照写进任务，员工看到的内容需求可能不完整。可以先去补档案，也可以照样创建。`}
        confirmLabel="仍然创建"
        cancelLabel="先去补档案"
        loading={loading}
        onConfirm={submitTask}
      />
    </div>
  );
}

export default TaskForm;
