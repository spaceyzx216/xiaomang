export const weeklyDictionary = [
  { name: '风险防御', subcategories: [{ name: '入职合规' }, { name: '薪酬设计' }] },
  { name: '危机管理', subcategories: [{ name: '离职管理' }] },
];
export const weeklyInput = (patch = {}) => ({ platform: 'douyin', accountName: '测试账号', period: { start: '2026-10-01', end: '2026-10-07' }, nextWeekCount: 10,
  rows: [200, 700, 1000, 3500, 10000, 12500].map((plays, i) => ({ id: `v${i}`, publishedAt: `2026-10-0${i + 1}`, title: `测试${i}`, link: '', script: '',
    metrics: { plays, likes: plays * 0.06, comments: plays * 0.01, shares: plays * 0.01, bookmarks: plays * 0.01, completionRate: '32%', bounce2sRate: '18%', completion5sRate: '55%', avgPlaySeconds: 42, durationSeconds: 118 },
    structureTags: { categoryName: i < 4 ? '风险防御' : '危机管理', subcategoryName: i < 2 ? '入职合规' : i < 4 ? '薪酬设计' : '离职管理', goldThreeSecondsType: i % 2 ? 'pain' : 'fear', titleType: 'curiosity', endingHookType: 'interaction' },
  })), ...patch });
