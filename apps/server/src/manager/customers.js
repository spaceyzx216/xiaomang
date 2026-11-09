import express from 'express';
const router = express.Router();
import { findCustomers, findCustomer, insertCustomer, saveCustomer, deleteCustomer } from '../../api/_lib/manager/customers.js';
import {
  emptyProfileContent,
  normalizeIpProfileInput,
  getMissingRequired,
  getCompletion,
  mergeLegacyIntoProfile,
  buildStoredProfile,
  isProfileMeaningful
} from '../../api/_lib/manager/ipProfile.js';

const PROFILE_ACTIONS = ['save_draft', 'mark_needs_review', 'confirm'];

function normalizePayload(body = {}) {
  return {
    name: String(body.name || '').trim(),
    occupation: String(body.occupation || '').trim(),
    contact: String(body.contact || '').trim(),
    ipPositioning: String(body.ipPositioning || '').trim(),
    contentNeeds: String(body.contentNeeds || '').trim(),
    benchmarkAccounts: String(body.benchmarkAccounts || '').trim(),
    notes: String(body.notes || '').trim()
  };
}

function getProfileContent(customer) {
  // 同时用旧的客户字段补齐姓名、职业和原始纪要，兼容历史客户或旧版本草稿。
  return mergeLegacyIntoProfile(customer?.ipProfile, customer);
}

function serializeProfile(profile, fallbackStatus = 'draft') {
  if (!profile) {
    return {
      schemaVersion: 1,
      status: fallbackStatus,
      profileVersion: 0,
      ...emptyProfileContent(),
      updatedAt: null,
      confirmedAt: null,
      confirmedBy: null
    };
  }

  return {
    schemaVersion: profile.schemaVersion || 1,
    status: profile.status || fallbackStatus,
    profileVersion: Number(profile.profileVersion || 0),
    ...normalizeIpProfileInput(profile),
    updatedAt: profile.updatedAt || null,
    confirmedAt: profile.confirmedAt || null,
    confirmedBy: profile.confirmedBy || null
  };
}

function getProfileSummary(customer) {
  const hasStoredProfile = Boolean(customer?.ipProfile);
  const hasLegacyContent = !hasStoredProfile && [
    customer?.notes,
    customer?.occupation,
    customer?.ipPositioning,
    customer?.contentNeeds,
    customer?.benchmarkAccounts
  ].some((value) => String(value || '').trim());
  const content = hasStoredProfile || hasLegacyContent
    ? getProfileContent(customer)
    : emptyProfileContent();
  const completion = getCompletion(content);

  return {
    status: hasStoredProfile
      ? customer.ipProfile.status
      : hasLegacyContent
        ? 'needs_review'
        : 'not_started',
    profileVersion: hasStoredProfile ? Number(customer.ipProfile.profileVersion || 0) : 0,
    completion,
    updatedAt: hasStoredProfile ? customer.ipProfile.updatedAt || null : null
  };
}

function buildProfileResponse(customer, profileOverride = null) {
  const summary = getProfileSummary(customer);
  const profile = profileOverride || (customer.ipProfile
    ? serializeProfile(customer.ipProfile)
    : serializeProfile(getProfileContent(customer), summary.status));

  return {
    customerId: customer._id,
    customerName: customer.name,
    profile,
    status: summary.status,
    profileVersion: summary.profileVersion,
    completion: getCompletion(profile),
    missingRequired: getMissingRequired(profile),
    updatedAt: profile.updatedAt || null
  };
}

function getActionStatus(action) {
  if (!PROFILE_ACTIONS.includes(action)) {
    const error = new Error('不支持的档案操作');
    error.status = 400;
    throw error;
  }
  if (action === 'confirm') return 'confirmed';
  if (action === 'mark_needs_review') return 'needs_review';
  return 'draft';
}

function validateConfirmation(profile) {
  const missingRequired = getMissingRequired(profile);
  if (missingRequired.length > 0) {
    const error = new Error(`还有 ${missingRequired.length} 项必填信息未完成`);
    error.status = 400;
    error.missingRequired = missingRequired;
    throw error;
  }
}

function buildProfileForAction(content, action, currentProfile, userId) {
  const status = getActionStatus(action);
  if (action === 'confirm') validateConfirmation(content);

  const now = new Date();
  const currentVersion = Number(currentProfile?.profileVersion || 0);
  return buildStoredProfile(content, {
    status,
    profileVersion: action === 'confirm' ? currentVersion + 1 : currentVersion,
    updatedAt: now,
    confirmedAt: action === 'confirm' ? now : null,
    confirmedBy: action === 'confirm' ? userId : null
  });
}

function assertExpectedUpdatedAt(customer, expectedUpdatedAt) {
  if (!expectedUpdatedAt || !customer.ipProfile?.updatedAt) return;
  const expected = new Date(expectedUpdatedAt).getTime();
  const current = new Date(customer.ipProfile.updatedAt).getTime();
  if (!Number.isFinite(expected) || expected !== current) {
    const error = new Error('档案已被其他人更新，请刷新后再保存');
    error.status = 409;
    throw error;
  }
}

// 新建采集流程：用户确认后一次性创建 Customer 和结构化 IP 档案。
router.post('/intake', async (req, res) => {
  try {
    const customerPayload = normalizePayload(req.body.customer || req.body);
    if (!customerPayload.name) {
      return res.status(400).json({ error: '客户名称必填' });
    }

    const action = req.body.action || 'confirm';
    const profileContent = normalizeIpProfileInput(req.body.profile || {});
    if (!profileContent.identity.name) profileContent.identity.name = customerPayload.name;
    const storedProfile = buildProfileForAction(profileContent, action, null, req.user?._id);
    const customer = await insertCustomer({
      ...customerPayload,
      occupation: customerPayload.occupation || profileContent.identity.occupation,
      ipProfile: storedProfile
    });

    res.status(201).json(buildProfileResponse(customer));
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: '客户名称已存在，请勿重复创建' });
    }
    res.status(err.status || 400).json({
      error: err.message,
      missingRequired: err.missingRequired || []
    });
  }
});

router.get('/', async (req, res) => {
  try {
    const customers = await findCustomers();
    res.json(customers.map((customer) => ({
      ...customer,
      ipProfileSummary: getProfileSummary(customer)
    })));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/:id/ip-profile', async (req, res) => {
  try {
    const customer = await findCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });
    res.json(buildProfileResponse(customer));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/:id/ip-profile', async (req, res) => {
  try {
    const customer = await findCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });

    assertExpectedUpdatedAt(customer, req.body.expectedUpdatedAt);
    const previousUpdatedAt = customer.ipProfile?.updatedAt ?? null;
    const action = req.body.action || 'save_draft';
    const profileContent = normalizeIpProfileInput(req.body.profile || {});
    if (!profileContent.identity.name) profileContent.identity.name = customer.name;
    const storedProfile = buildProfileForAction(
      profileContent,
      action,
      customer.ipProfile,
      req.user?._id
    );

    customer.ipProfile = storedProfile;
    if (!customer.occupation && profileContent.identity.occupation) customer.occupation = profileContent.identity.occupation;
    await saveCustomer(customer, previousUpdatedAt);

    res.json(buildProfileResponse(customer));
  } catch (err) {
    res.status(err.status || 400).json({
      error: err.message,
      missingRequired: err.missingRequired || []
    });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const customer = await findCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });
    res.json(customer);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const payload = normalizePayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ error: '客户名称必填' });
    }

    const profile = mergeLegacyIntoProfile(null, payload);
    const customer = await insertCustomer({
      ...payload,
      ...(isProfileMeaningful(profile)
        ? { ipProfile: buildStoredProfile(profile, { status: 'draft', profileVersion: 0 }) }
        : {})
    });
    res.status(201).json(customer);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: '客户名称已存在，请勿重复创建' });
    }
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const payload = normalizePayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ error: '客户名称必填' });
    }

    const customer = await findCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });

    Object.assign(customer, payload);
    const profile = mergeLegacyIntoProfile(customer.ipProfile, { ...payload, name: customer.name });
    if (!customer.ipProfile && isProfileMeaningful(profile)) {
      customer.ipProfile = buildStoredProfile(profile, { status: 'needs_review', profileVersion: 0 });
    } else if (customer.ipProfile) {
      // 旧字段只负责补齐空结构化字段，不覆盖人工整理过的内容。
      customer.ipProfile = {
        ...customer.ipProfile,
        ...profile,
        status: customer.ipProfile.status,
        profileVersion: customer.ipProfile.profileVersion,
        updatedAt: customer.ipProfile.updatedAt,
        confirmedAt: customer.ipProfile.confirmedAt,
        confirmedBy: customer.ipProfile.confirmedBy
      };
    }
    await saveCustomer(customer);
    res.json(customer);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: '客户名称已存在，请更换名称' });
    }
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const customer = await deleteCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });
    res.json({ message: '客户已删除' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
