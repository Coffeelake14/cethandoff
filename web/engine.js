// CET-4/6 估分引擎：官方常模参照换算（非线性），内置题型分值权重表与官方常模百分位对照表。
// 数据来源：教育部教育考试院《分数解释》(cet.neea.edu.cn/xhtml1/folder/19081/5124-1.htm)。
// 报道分公式 TotSco = (X - Mean)/SD*70 + 500；单项满分 听力249 / 阅读249 / 翻译和写作212。
// 本引擎用官方"报道分→百分位"对照表做插值反查（百分位→报道分），实现非线性常模换算，
// 而非卷面分线性放大。原始得分率→百分位采用正态近似，参数（RAW_NORM）是经验假设，
// 不是官方公布的校准值。因此对外只提供参考区间、距目标分的参考差与算法限制，
// 不提供“通过概率”，也不暗示官方估分。

export const DISCLAIMER = '本结果仅为参考估算，不等于官方成绩';
export const TARGET_LINE = 425;
export const LIMITS_TEXT = '算法限制：① 原始得分率→常模百分位采用正态近似，均值和标准差为项目假设，未经实际成绩校准；② 写译自评或 AI 语言反馈与真实阅卷存在差距；③ 答对题数由用户自报。结果只能作为参考区间，误差可能较大，不构成官方估分或通过承诺。';

// 各题型小题分值权重表（官方占比换算）。max 为该模块卷面加权满分。
export const WEIGHTS = {
  CET4: {
    listening: [
      { key: 'news', name: '短篇新闻', count: 7, each: 7.1 },
      { key: 'longConv', name: '长对话', count: 8, each: 7.1 },
      { key: 'passages', name: '听力篇章', count: 10, each: 14.2 },
    ],
    reading: [
      { key: 'banked', name: '选词填空', count: 10, each: 3.55 },
      { key: 'matching', name: '长篇匹配', count: 10, each: 7.1 },
      { key: 'careful', name: '仔细阅读', count: 10, each: 14.2 },
    ],
  },
  CET6: {
    listening: [
      { key: 'longConv', name: '长对话', count: 8, each: 7.1 },
      { key: 'passages', name: '听力篇章', count: 7, each: 7.1 },
      { key: 'lectures', name: '讲座/讲话', count: 10, each: 14.2 },
    ],
    reading: [
      { key: 'banked', name: '选词填空', count: 10, each: 3.55 },
      { key: 'matching', name: '长篇匹配', count: 10, each: 7.1 },
      { key: 'careful', name: '仔细阅读', count: 10, each: 14.2 },
    ],
  },
};

export const MODULE_MAX = { listening: 249, reading: 249, writing: 106, translation: 106 };
export const TOTAL_MAX = 710;

// 官方常模百分位对照表 [报道分, 百分位%]。插值时两端补 [0,0] 与 [满分,100]。
export const NORM_TABLES = {
  CET4: {
    listening: [[100,1],[110,2],[120,3],[130,7],[140,12],[150,18],[160,26],[170,37],[180,48],[190,59],[200,70],[210,82],[220,91],[230,97],[240,99]],
    reading: [[100,1],[110,2],[120,4],[130,9],[140,17],[150,26],[160,37],[170,48],[180,62],[190,72],[200,82],[210,90],[220,96],[230,98],[240,99]],
    wt: [[95,1],[103,2],[111,4],[119,8],[127,16],[135,27],[143,42],[151,58],[159,72],[167,86],[175,94],[183,98],[191,99]],
    total: [[330,1],[350,2],[370,4],[390,7],[410,11],[430,17],[450,25],[470,34],[490,44],[510,55],[530,65],[550,74],[570,83],[590,90],[610,95],[630,98],[650,99]],
  },
  CET6: {
    listening: [[100,2],[110,5],[120,9],[130,13],[140,19],[150,26],[160,37],[170,47],[180,59],[190,69],[200,78],[210,86],[220,92],[230,97],[240,99]],
    reading: [[110,1],[120,2],[130,3],[140,5],[150,9],[160,14],[170,22],[180,28],[190,40],[200,54],[210,69],[220,83],[230,93],[240,98]],
    wt: [[85,1],[93,3],[101,6],[109,14],[117,24],[125,38],[133,51],[141,66],[149,79],[157,88],[165,93],[173,97],[181,99]],
    total: [[330,1],[350,2],[370,4],[390,6],[410,10],[430,16],[450,23],[470,33],[490,42],[510,53],[530,66],[550,76],[570,84],[590,90],[610,95],[630,98],[650,99]],
  },
};

// 原始得分率→参考百分位的正态近似校准参数（均值/标准差）。
// 这些参数是项目假设，缺乏原始答题数据与实际成绩的配对数据来校准。
const RAW_NORM = {
  listening: { mean: 0.72, sd: 0.15 },
  reading: { mean: 0.70, sd: 0.16 },
  wt: { mean: 0.69, sd: 0.15 },
};

// 写译自评档位 → 原始评分（满分15）中值与区间。
export const BANDS = {
  low: { name: '低档', mid: 5.5, lo: 4, hi: 7 },
  mid: { name: '中档', mid: 9, lo: 8, hi: 10 },
  high: { name: '高档', mid: 12.5, lo: 11, hi: 14 },
};

export function erf(x) {
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
export const normCdf = x => 0.5 * (1 + erf(x / Math.SQRT2));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 百分位 → 报道分：在官方对照表上线性插值（非线性曲线由官方表本身决定）。
export function percentileToReported(table, max, percentile) {
  const pts = [[0, 0], ...table, [max, 100]];
  const p = clamp(percentile, 0, 100);
  for (let i = 1; i < pts.length; i++) {
    const [r0, p0] = pts[i - 1], [r1, p1] = pts[i];
    if (p <= p1) {
      const t = p1 === p0 ? 0 : (p - p0) / (p1 - p0);
      return r0 + t * (r1 - r0);
    }
  }
  return max;
}

function rawPercentile(sectionKey, ratio) {
  const { mean, sd } = RAW_NORM[sectionKey];
  return clamp(100 * normCdf((ratio - mean) / sd), 0.5, 99.5);
}

function objectiveRaw(level, module, answers) {
  const defs = WEIGHTS[level][module];
  let points = 0;
  for (const d of defs) {
    const n = clamp(Math.round(Number(answers?.[d.key] ?? 0)), 0, d.count);
    points += n * d.each;
  }
  const max = defs.reduce((s, d) => s + d.count * d.each, 0);
  return { points, max, ratio: max ? points / max : 0 };
}

function writingRaw(item) {
  if (item?.mode === 'ai' && Number.isFinite(Number(item.score))) {
    return clamp(Number(item.score), 0, 15) / 15;
  }
  const band = BANDS[item?.band] || BANDS.mid;
  return band.mid / 15;
}

// 各模块报道分的不确定度（标准差），用于总分与模块的参考区间。
const MODULE_SIGMA = 13; // 参考区间使用统一的经验误差项。
const MODEL_SIGMA = 16; // 常模近似校准的模型误差底噪

export function gapText(gap) {
  if (Math.abs(gap) <= 5) return `与 425 参考目标基本持平（${gap >= 0 ? '+' : ''}${gap} 分）`;
  return gap > 0 ? `高于 425 参考目标约 ${gap} 分` : `低于 425 参考目标约 ${Math.abs(gap)} 分`;
}

export function computeEstimate(input) {
  const level = input.level === 'CET6' ? 'CET6' : 'CET4';
  const tables = NORM_TABLES[level];

  const listen = objectiveRaw(level, 'listening', input.listening);
  const read = objectiveRaw(level, 'reading', input.reading);
  const lPct = rawPercentile('listening', listen.ratio);
  const rPct = rawPercentile('reading', read.ratio);
  const listening = percentileToReported(tables.listening, MODULE_MAX.listening, lPct);
  const reading = percentileToReported(tables.reading, MODULE_MAX.reading, rPct);

  const wRatio = writingRaw(input.writing);
  const tRatio = writingRaw(input.translation);
  const wPct = rawPercentile('wt', wRatio);
  const tPct = rawPercentile('wt', tRatio);
  const writing = percentileToReported(tables.wt, 212, wPct) / 2;
  const translation = percentileToReported(tables.wt, 212, tPct) / 2;

  const modules = [
    { key: 'listening', name: '听力', score: listening, max: MODULE_MAX.listening, percentile: lPct, ratio: listen.ratio },
    { key: 'reading', name: '阅读', score: reading, max: MODULE_MAX.reading, percentile: rPct, ratio: read.ratio },
    { key: 'writing', name: '写作', score: writing, max: MODULE_MAX.writing, percentile: wPct, ratio: wRatio },
    { key: 'translation', name: '翻译', score: translation, max: MODULE_MAX.translation, percentile: tPct, ratio: tRatio },
  ];

  const total = listening + reading + writing + translation;
  const sigma = Math.hypot(...modules.map(() => MODULE_SIGMA), MODEL_SIGMA);
  const range = [clamp(total - 1.5 * sigma, 0, TOTAL_MAX), clamp(total + 1.5 * sigma, 0, TOTAL_MAX)];
  const gap = Math.round(total - TARGET_LINE);

  // 薄弱模块取相对最弱的两项（常模群体偏强，绝对百分位普遍偏低，故按相对排名定位）。
  // 百分位只在内部用于定位薄弱项，不对外展示，避免暗示官方估分。
  const weak = modules.slice().sort((a, b) => a.percentile - b.percentile).slice(0, 2).map(m => m.key);

  return {
    level,
    modules: modules.map(m => {
      const lo = clamp(m.score - 1.5 * MODULE_SIGMA, 0, m.max);
      const hi = clamp(m.score + 1.5 * MODULE_SIGMA, 0, m.max);
      return {
        key: m.key,
        name: m.name,
        score: Math.round(m.score * 10) / 10,
        max: m.max,
        range: [Math.round(lo), Math.round(hi)],
      };
    }),
    total: Math.round(total),
    range: [Math.round(range[0]), Math.round(range[1])],
    sigma: Math.round(sigma),
    target: TARGET_LINE,
    gap,
    gapLabel: gapText(gap),
    gapTone: gap >= 0 ? 'ok' : 'warn',
    limits: LIMITS_TEXT,
    weak,
    raw: { listening: listen, reading: read },
  };
}