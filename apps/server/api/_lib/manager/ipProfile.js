const MAX = {
  short: 120,
  medium: 500,
  long: 2000,
  rawNotes: 12000
};

// 清单中的字段默认都可为空，只有原始纪要和姓名/昵称是确认建档的最低条件。
// 这样既能避免空档案被误确认，也不会要求客户一次性回答完所有问题。
const REQUIRED_FIELDS = [
  { path: 'interview.rawNotes', label: '原始沟通纪要' },
  { path: 'identity.name', label: '姓名 / 昵称' }
];

const PROFILE_GROUPS = [
  {
    key: 'identity',
    label: '身份信息',
    paths: [
      'identity.name',
      'identity.age',
      'identity.mbti',
      'identity.personaContrast',
      'identity.occupation',
      'identity.yearsExperience',
      'identity.keyCases'
    ]
  },
  {
    key: 'product',
    label: '产品信息',
    paths: ['product.businessModel', 'product.productType', 'product.priceRange', 'product.coreAdvantages']
  },
  {
    key: 'userProfile',
    label: '用户画像',
    paths: [
      'userProfile.gender',
      'userProfile.age',
      'userProfile.occupationIndustry',
      'userProfile.incomeLevel',
      'userProfile.consumptionHabits',
      'userProfile.consumptionScenarios',
      'userProfile.painPoints',
      'userProfile.goalsNeeds'
    ]
  }
];

function tooLong(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function cleanString(value, maxLength) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const result = String(value).trim();
  if (result.length > maxLength) throw tooLong(`字段内容不能超过 ${maxLength} 个字符`);
  return result;
}

function emptyProfileContent() {
  return {
    interview: {
      rawNotes: '',
      source: 'client_interview'
    },
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
}

function normalizeIpProfileInput(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const profile = emptyProfileContent();

  profile.interview.rawNotes = cleanString(raw.interview?.rawNotes, MAX.rawNotes);
  profile.interview.source = ['client_interview', 'manual', 'imported'].includes(raw.interview?.source)
    ? raw.interview.source
    : 'client_interview';

  // 接受上一个版本中少量同义字段的读取，避免升级后已有草稿内容消失；
  // 新写入的数据只会经过下面这套三组清单字段。
  profile.identity.name = cleanString(raw.identity?.name, MAX.short);
  profile.identity.age = cleanString(raw.identity?.age, MAX.short);
  profile.identity.mbti = cleanString(raw.identity?.mbti, MAX.short);
  profile.identity.personaContrast = cleanString(raw.identity?.personaContrast, MAX.medium);
  profile.identity.occupation = cleanString(raw.identity?.occupation || raw.identity?.role, MAX.short);
  profile.identity.yearsExperience = cleanString(raw.identity?.yearsExperience, MAX.short);
  profile.identity.keyCases = cleanString(raw.identity?.keyCases, MAX.long);
  if (!profile.identity.keyCases && Array.isArray(raw.story?.cases)) {
    profile.identity.keyCases = cleanString(raw.story.cases.join('；'), MAX.long);
  }

  profile.product.businessModel = cleanString(raw.product?.businessModel, MAX.medium);
  profile.product.productType = cleanString(raw.product?.productType, MAX.medium);
  profile.product.priceRange = cleanString(raw.product?.priceRange, MAX.short);
  profile.product.coreAdvantages = cleanString(raw.product?.coreAdvantages, MAX.long);

  profile.userProfile.gender = cleanString(raw.userProfile?.gender, MAX.short);
  profile.userProfile.age = cleanString(raw.userProfile?.age, MAX.short);
  profile.userProfile.occupationIndustry = cleanString(raw.userProfile?.occupationIndustry, MAX.medium);
  profile.userProfile.incomeLevel = cleanString(raw.userProfile?.incomeLevel, MAX.short);
  profile.userProfile.consumptionHabits = cleanString(raw.userProfile?.consumptionHabits, MAX.long);
  profile.userProfile.consumptionScenarios = cleanString(raw.userProfile?.consumptionScenarios, MAX.long);
  profile.userProfile.painPoints = cleanString(raw.userProfile?.painPoints, MAX.long);
  profile.userProfile.goalsNeeds = cleanString(raw.userProfile?.goalsNeeds, MAX.long);

  return profile;
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(String(value || '').trim());
}

function getPathValue(object, path) {
  return path.split('.').reduce((current, key) => current?.[key], object);
}

function getMissingRequired(profile) {
  return REQUIRED_FIELDS
    .filter((field) => !hasValue(getPathValue(profile, field.path)))
    .map((field) => field.label);
}

function getCompletion(profile) {
  const completed = PROFILE_GROUPS.filter((group) => group.paths.some((path) => hasValue(getPathValue(profile, path)))).length;
  const total = PROFILE_GROUPS.length;
  return {
    completed,
    total,
    percentage: total ? Math.round((completed / total) * 100) : 0
  };
}

function createProfileFromLegacy(customer = {}) {
  const profile = emptyProfileContent();
  profile.interview.rawNotes = cleanString(customer.notes, MAX.rawNotes);
  profile.interview.source = 'imported';
  profile.identity.name = cleanString(customer.name, MAX.short);
  profile.identity.occupation = cleanString(customer.occupation, MAX.short);
  return profile;
}

function mergeLegacyIntoProfile(existing, legacy = {}) {
  const profile = normalizeIpProfileInput(existing || {});
  const oldProfile = createProfileFromLegacy(legacy);

  if (!hasValue(profile.interview.rawNotes) && hasValue(oldProfile.interview.rawNotes)) {
    profile.interview.rawNotes = oldProfile.interview.rawNotes;
    profile.interview.source = 'imported';
  }
  if (!hasValue(profile.identity.name)) profile.identity.name = oldProfile.identity.name;
  if (!hasValue(profile.identity.occupation)) profile.identity.occupation = oldProfile.identity.occupation;
  return profile;
}

function buildStoredProfile(content, metadata = {}) {
  return {
    schemaVersion: 1,
    status: metadata.status || 'draft',
    profileVersion: Number.isFinite(Number(metadata.profileVersion)) ? Number(metadata.profileVersion) : 0,
    ...normalizeIpProfileInput(content),
    updatedAt: metadata.updatedAt || new Date(),
    confirmedAt: metadata.confirmedAt || null,
    confirmedBy: metadata.confirmedBy || null
  };
}

function createProfileSnapshot(profile) {
  if (!profile) return null;
  return buildStoredProfile(profile, {
    status: profile.status || 'draft',
    profileVersion: profile.profileVersion || 0,
    updatedAt: profile.updatedAt || null,
    confirmedAt: profile.confirmedAt || null,
    confirmedBy: profile.confirmedBy || null
  });
}

function isProfileMeaningful(profile) {
  const normalized = normalizeIpProfileInput(profile);
  return PROFILE_GROUPS.some((group) => group.paths
    .filter((path) => path !== 'identity.name')
    .some((path) => hasValue(getPathValue(normalized, path))));
}

export {
  REQUIRED_FIELDS,
  PROFILE_GROUPS,
  emptyProfileContent,
  normalizeIpProfileInput,
  getMissingRequired,
  getCompletion,
  createProfileFromLegacy,
  mergeLegacyIntoProfile,
  buildStoredProfile,
  createProfileSnapshot,
  isProfileMeaningful
};
