import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { aiAPI, customerAPI } from '../services/api';

const EMPTY_PROFILE = {
  interview: { rawNotes: '', source: 'client_interview' },
  identity: {
    name: '',
    age: '',
    mbti: '',
    personaContrast: '',
    occupation: '',
    yearsExperience: '',
    keyCases: ''
  },
  product: {
    businessModel: '',
    productType: '',
    priceRange: '',
    coreAdvantages: ''
  },
  userProfile: {
    gender: '',
    age: '',
    occupationIndustry: '',
    incomeLevel: '',
    consumptionHabits: '',
    consumptionScenarios: '',
    painPoints: '',
    goalsNeeds: ''
  }
};

const PRIMARY_RESULTS = [
  { key: 'identity.name', label: '姓名 / 昵称', placeholder: '还没有填写姓名或昵称' },
  { key: 'identity.occupation', label: '职业身份', placeholder: '还没有填写职业身份' },
  { key: 'product.productType', label: '产品类型', placeholder: '还没有填写产品类型' },
  { key: 'product.coreAdvantages', label: '核心优势', placeholder: '还没有提炼核心优势' },
  { key: 'userProfile.painPoints', label: '用户痛点', placeholder: '还没有填写用户痛点' },
  { key: 'userProfile.goalsNeeds', label: '目标 / 需求', placeholder: '还没有填写用户目标或需求' }
];

const ADVANCED_SECTIONS = [
  {
    key: 'identity',
    label: '身份信息',
    fields: [
      ['identity.name', '姓名 / 昵称', 'input'],
      ['identity.age', '年龄', 'input'],
      ['identity.mbti', 'MBTI', 'input'],
      ['identity.personaContrast', '人设反差点', 'textarea'],
      ['identity.occupation', '职业身份', 'input'],
      ['identity.yearsExperience', '从业年限', 'input'],
      ['identity.keyCases', '关键项目 / 代表案例', 'textarea']
    ]
  },
  {
    key: 'product',
    label: '产品信息',
    fields: [
      ['product.businessModel', '业务模式', 'textarea'],
      ['product.productType', '产品类型', 'input'],
      ['product.priceRange', '产品价格 / 区间', 'input'],
      ['product.coreAdvantages', '核心优势', 'textarea']
    ]
  },
  {
    key: 'userProfile',
    label: '用户画像',
    fields: [
      ['userProfile.gender', '性别', 'input'],
      ['userProfile.age', '年龄', 'input'],
      ['userProfile.occupationIndustry', '职业 / 行业', 'input'],
      ['userProfile.incomeLevel', '收入水平', 'input'],
      ['userProfile.consumptionHabits', '消费习惯', 'textarea'],
      ['userProfile.consumptionScenarios', '消费场景', 'textarea'],
      ['userProfile.painPoints', '痛点', 'textarea'],
      ['userProfile.goalsNeeds', '目标 / 需求', 'textarea']
    ]
  }
];

const COMPLETION_GROUPS = [
  ['identity', ['identity.name', 'identity.age', 'identity.mbti', 'identity.personaContrast', 'identity.occupation', 'identity.yearsExperience', 'identity.keyCases']],
  ['product', ['product.businessModel', 'product.productType', 'product.priceRange', 'product.coreAdvantages']],
  ['userProfile', ['userProfile.gender', 'userProfile.age', 'userProfile.occupationIndustry', 'userProfile.incomeLevel', 'userProfile.consumptionHabits', 'userProfile.consumptionScenarios', 'userProfile.painPoints', 'userProfile.goalsNeeds']]
];

const TEXT_DOCUMENT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeProfile(profile = {}) {
  const result = clone(EMPTY_PROFILE);
  Object.entries(result).forEach(([section, fields]) => {
    Object.keys(fields).forEach((field) => {
      const incoming = profile?.[section]?.[field];
      if (incoming !== undefined && incoming !== null) result[section][field] = clone(incoming);
    });
  });
  return result;
}

function getPathValue(object, path) {
  return path.split('.').reduce((current, key) => current?.[key], object);
}

function setPathValue(object, path, value) {
  const result = clone(object);
  const parts = path.split('.');
  const last = parts.pop();
  const target = parts.reduce((current, key) => {
    current[key] = current[key] || {};
    return current[key];
  }, result);
  target[last] = value;
  return result;
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(String(value || '').trim());
}

function getCompletion(profile) {
  const completed = COMPLETION_GROUPS.filter(([, paths]) => paths.some((path) => hasValue(getPathValue(profile, path)))).length;
  return {
    completed,
    total: COMPLETION_GROUPS.length,
    percentage: Math.round((completed / COMPLETION_GROUPS.length) * 100)
  };
}

function getMissingRequired(profile) {
  return [
    ['interview.rawNotes', '原始沟通纪要'],
    ['identity.name', '姓名 / 昵称']
  ].filter(([path]) => !hasValue(getPathValue(profile, path))).map(([, label]) => label);
}

function PenIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="ip-icon">
      <path d="m4 16.5-.7 3.7 3.7-.7L18.8 7.7a2.2 2.2 0 0 0-3.1-3.1L4 16.5Z" />
      <path d="m14.5 6.5 3 3" />
    </svg>
  );
}

function ChevronIcon({ open }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`ip-icon ip-chevron${open ? ' is-open' : ''}`}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="ip-icon ip-spark">
      <path d="m12 2 1.4 6.6L20 10l-6.6 1.4L12 18l-1.4-6.6L4 10l6.6-1.4L12 2Z" />
      <path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z" />
    </svg>
  );
}

function ResultCard({ item, value, source, editingPath, onEdit, onChange }) {
  const editing = editingPath === item.key;
  return (
    <div className={`ip-result-card${editing ? ' is-editing' : ''}`}>
      <div className="ip-result-label">{item.label}</div>
      <div className="ip-result-content">
        {editing ? (
          <textarea
            className="form-textarea ip-result-editor"
            value={value || ''}
            onChange={(event) => onChange(event.target.value)}
            placeholder={item.placeholder}
            autoFocus
          />
        ) : (
          <div className={`ip-result-value${value ? '' : ' is-empty'}`}>
            {value || item.placeholder}
          </div>
        )}
      </div>
      <div className="ip-result-actions">
        <span className={`ip-source${source === 'ai' ? ' is-ai' : ''}`}>
          {source === 'ai' && <SparkIcon />}
          {source === 'ai' ? 'AI建议' : '可编辑草稿'}
        </span>
        <button
          type="button"
          className="ip-icon-button"
          onClick={onEdit}
          aria-label={`${editing ? '完成编辑' : '编辑'}${item.label}`}
        >
          <PenIcon />
        </button>
      </div>
    </div>
  );
}

function AdvancedField({ path, label, type, profile, onChange }) {
  const value = getPathValue(profile, path);
  const inputValue = value || '';

  return (
    <label className="ip-advanced-field">
      <span>{label}</span>
      {type === 'input' ? (
        <input
          className="form-input"
          value={inputValue}
          onChange={(event) => onChange(path, event.target.value)}
        />
      ) : (
        <textarea
          className="form-textarea"
          value={inputValue}
          onChange={(event) => onChange(path, event.target.value)}
        />
      )}
    </label>
  );
}

function IpProfileForm() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isNew = !id;
  const [customerName, setCustomerName] = useState('');
  const [profile, setProfile] = useState(clone(EMPTY_PROFILE));
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(null);
  const [completion, setCompletion] = useState(getCompletion(EMPTY_PROFILE));
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [readingDocument, setReadingDocument] = useState(false);
  const [documentName, setDocumentName] = useState('');
  const [editingPath, setEditingPath] = useState(null);
  const [source, setSource] = useState('manual');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [openSections, setOpenSections] = useState({});
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (isNew) return;

    const load = async () => {
      try {
        setLoading(true);
        const [customerResponse, profileResponse] = await Promise.all([
          customerAPI.getById(id),
          customerAPI.getIpProfile(id)
        ]);
        const nextCustomerName = customerResponse.data.name || profileResponse.data.customerName || '';
        let nextProfile = mergeProfile(profileResponse.data.profile);
        if (!nextProfile.identity.name && nextCustomerName) {
          nextProfile = setPathValue(nextProfile, 'identity.name', nextCustomerName);
        }
        setCustomerName(nextCustomerName);
        setProfile(nextProfile);
        setExpectedUpdatedAt(profileResponse.data.updatedAt || null);
        setCompletion(profileResponse.data.completion || getCompletion(nextProfile));
        setSource('manual');
      } catch (error) {
        setMessage({ type: 'error', text: error?.response?.data?.error || '加载 IP 档案失败，请重试' });
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id, isNew]);

  const updateProfile = (path, value) => {
    const nextProfile = setPathValue(profile, path, value);
    setProfile(nextProfile);
    setCompletion(getCompletion(nextProfile));
    setMessage(null);
  };

  const handleDocumentUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setDocumentName(file.name);
    setReadingDocument(true);
    setMessage(null);

    try {
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (TEXT_DOCUMENT_EXTENSIONS.has(extension) || file.type.startsWith('text/')) {
        const text = await file.text();
        const nextNotes = text.slice(0, 12000);
        updateProfile('interview.rawNotes', nextNotes);
        setMessage({
          type: 'success',
          text: text.length > 12000 ? `已读取 ${file.name}，超出部分已截取` : `已读取 ${file.name}，可以让 Agent 开始整理`
        });
      } else {
        const response = await aiAPI.extractDocument(file);
        const extractedText = String(response.data.text || '').trim();
        if (!extractedText) throw new Error('未能从文档中提取到可用文字');
        updateProfile('interview.rawNotes', extractedText);
        setMessage({
          type: 'success',
          text: response.data.truncated
            ? `已解析 ${file.name}，超出 12000 字的部分已截取`
            : `已解析 ${file.name}，可以让 Agent 开始整理`
        });
      }
    } catch (error) {
      const requestUnavailable = !error.response && error.request;
      setMessage({
        type: 'error',
        text: error?.response?.data?.error
          || (requestUnavailable ? '文档解析服务暂时不可用，请确认服务已启动，或直接粘贴文字' : '文档解析失败，请确认文件未损坏，或直接粘贴文字')
      });
    } finally {
      setReadingDocument(false);
      event.target.value = '';
    }
  };

  const handleOrganize = async () => {
    const rawNotes = profile.interview.rawNotes.trim();
    if (!rawNotes) {
      setMessage({ type: 'error', text: '请先输入原始沟通纪要' });
      return;
    }

    try {
      setOrganizing(true);
      setMessage(null);
      const response = await aiAPI.organizeIpProfile({ rawNotes });
      let nextProfile = mergeProfile(response.data.profile);
      if (!nextProfile.identity.name && customerName.trim()) {
        nextProfile = setPathValue(nextProfile, 'identity.name', customerName.trim());
      }
      setProfile(nextProfile);
      setCompletion(getCompletion(nextProfile));
      setSource('ai');
      setMessage({ type: 'success', text: 'AI 已整理出草稿，请检查右侧内容后再确认建档' });
    } catch (error) {
      setMessage({ type: 'error', text: error?.response?.data?.error || 'AI 整理失败，可以继续手动编辑' });
    } finally {
      setOrganizing(false);
    }
  };

  const buildCustomerPayload = (profileToSave) => ({
    name: profileToSave.identity.name.trim() || customerName.trim(),
    occupation: profile.identity.occupation,
    notes: profile.interview.rawNotes
  });

  const save = async (action) => {
    const resolvedName = profile.identity.name.trim() || customerName.trim();
    if (!resolvedName) {
      setMessage({ type: 'error', text: '请先填写姓名 / 昵称' });
      return;
    }

    const profileToSave = !profile.identity.name && resolvedName
      ? setPathValue(profile, 'identity.name', resolvedName)
      : profile;

    if (action === 'confirm') {
      const missingRequired = getMissingRequired(profileToSave);
      if (missingRequired.length > 0) {
        setMessage({ type: 'error', text: `请先补充：${missingRequired.join('、')}` });
        return;
      }
    }

    try {
      setSaving(true);
      setMessage(null);
      const payload = {
        profile: profileToSave,
        action,
        expectedUpdatedAt
      };
      const response = isNew
        ? await customerAPI.createFromIpIntake({ customer: buildCustomerPayload(profileToSave), ...payload })
        : await customerAPI.saveIpProfile(id, payload);
      const responseData = response.data;

      if (isNew) {
        if (action === 'confirm') {
          navigate('/manager/customers', { state: { message: '客户 IP 档案已确认并完成建档' } });
        } else {
          navigate(`/manager/customers/${responseData.customerId}/ip-profile`, { replace: true });
        }
        return;
      }

      setExpectedUpdatedAt(responseData.updatedAt || null);
      if (responseData.profile) setProfile(mergeProfile(responseData.profile));
      setMessage({
        type: 'success',
        text: action === 'confirm' ? '档案已确认并完成建档' : action === 'mark_needs_review' ? '已保存并标记为待确认' : '草稿已保存'
      });
    } catch (error) {
      const missingRequired = error?.response?.data?.missingRequired || [];
      const errorText = missingRequired.length > 0
        ? `请先补充：${missingRequired.join('、')}`
        : error?.response?.data?.error || '保存失败，请重试';
      setMessage({ type: 'error', text: errorText });
    } finally {
      setSaving(false);
    }
  };

  const toggleSection = (section) => {
    setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  };

  if (loading) {
    return (
      <div className="ip-loading-state">
        <span className="loading-spinner" />
        正在加载 IP 档案…
      </div>
    );
  }

  return (
    <div className="ip-page">
      {message && <div className={`ip-message ${message.type}`} role="status">{message.text}</div>}

      <div className="ip-workspace">
        <section className="ip-panel ip-input-panel" aria-labelledby="ip-input-title">
          <div className="ip-panel-heading ip-panel-heading-compact">
            <h2 id="ip-input-title">上传资料</h2>
          </div>

          <div className="ip-input-body">
            <div className="ip-upload-block">
              <input
                id="ip-document-upload"
                className="ip-upload-input"
                type="file"
                accept=".txt,.md,.csv,.json,.doc,.docx,.pdf"
                onChange={handleDocumentUpload}
              />
              <label className={`ip-upload-dropzone${documentName ? ' has-file' : ''}`} htmlFor="ip-document-upload">
                <span className="ip-upload-icon" aria-hidden="true">↑</span>
                <span className="ip-upload-title">
                  {readingDocument ? '正在解析文档…' : documentName || '上传沟通文档'}
                </span>
                <span className="ip-upload-caption">
                  {documentName ? '点击重新选择文件' : 'TXT、Markdown、CSV、JSON、Word、PDF 均可自动提取文字'}
                </span>
              </label>
            </div>

            <label className="ip-field-label ip-notes-label">
              粘贴纪要
              <textarea
                className="form-textarea ip-notes-input"
                value={profile.interview.rawNotes}
                onChange={(event) => updateProfile('interview.rawNotes', event.target.value)}
                placeholder="把客户原话、背景、需求和边界粘贴到这里。"
                maxLength={12000}
              />
              <span className="ip-counter">{profile.interview.rawNotes.length} / 12000</span>
            </label>

            <button type="button" className="btn btn-primary btn-block ip-organize-button" onClick={handleOrganize} disabled={organizing}>
              <SparkIcon />
              {organizing ? '正在整理…' : '整理为 IP 档案'}
            </button>
            <div className="ip-input-hint">AI 只生成可编辑草稿，不会自动确认或建档。</div>
          </div>
        </section>

        <section className="ip-panel ip-output-panel" aria-labelledby="ip-output-title">
          <div className="ip-panel-heading ip-panel-heading-compact">
            <h2 id="ip-output-title">采集结果</h2>
            <span className="ip-completion-copy">{completion.completed}/{completion.total} 组已完成</span>
          </div>

          <div className="ip-results-list">
            {PRIMARY_RESULTS.map((item) => (
              <ResultCard
                key={item.key}
                item={item}
                value={getPathValue(profile, item.key)}
                source={source}
                editingPath={editingPath}
                onEdit={() => setEditingPath(editingPath === item.key ? null : item.key)}
                onChange={(value) => updateProfile(item.key, value)}
              />
            ))}
          </div>

          <button
            type="button"
            className={`ip-more-toggle${advancedOpen ? ' is-open' : ''}`}
            onClick={() => setAdvancedOpen((value) => !value)}
            aria-expanded={advancedOpen}
          >
            <span>更多信息</span>
            <ChevronIcon open={advancedOpen} />
          </button>

          {advancedOpen && (
            <div className="ip-advanced-list">
              {ADVANCED_SECTIONS.map((section) => (
                <div className="ip-advanced-section" key={section.key}>
                  <button
                    type="button"
                    className="ip-advanced-heading"
                    onClick={() => toggleSection(section.key)}
                    aria-expanded={Boolean(openSections[section.key])}
                  >
                    <span>{section.label}</span>
                    <ChevronIcon open={Boolean(openSections[section.key])} />
                  </button>
                  {openSections[section.key] && (
                    <div className="ip-advanced-fields">
                      {section.fields.map(([path, label, type]) => (
                        <AdvancedField
                          key={path}
                          path={path}
                          label={label}
                          type={type}
                          profile={profile}
                          onChange={updateProfile}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="ip-output-footer">
            <button type="button" className="btn btn-secondary" onClick={() => save('save_draft')} disabled={saving}>
              保存草稿
            </button>
            <button type="button" className="btn btn-primary" onClick={() => save('confirm')} disabled={saving}>
              {saving ? '保存中…' : '确认建档'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

export default IpProfileForm;
