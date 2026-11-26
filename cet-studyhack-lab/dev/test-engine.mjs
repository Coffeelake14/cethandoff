// Engine regression: nonlinear norm conversion, reference interval, gap to the
// 425 target, and the explicit removal of pass-probability / official-score
// fields from the UI contract.
import { computeEstimate, WEIGHTS, normCdf, percentileToReported, NORM_TABLES, MODULE_MAX, TOTAL_MAX, TARGET_LINE, gapText } from '../web/engine.js';

const full = (level, frac) => {
  const mk = mod => Object.fromEntries(WEIGHTS[level][mod].map(d => [d.key, Math.round(d.count * frac)]));
  return { level, listening: mk('listening'), reading: mk('reading'), writing: { mode: 'band', band: 'mid' }, translation: { mode: 'band', band: 'mid' } };
};
const show = (label, est) => console.log(label, JSON.stringify({
  total: est.total, range: est.range, gap: est.gap, gapLabel: est.gapLabel, weak: est.weak,
  mods: est.modules.map(m => `${m.name}:${m.score}(${m.range[0]}–${m.range[1]})`),
}));

let fail = 0;
const assert = (cond, msg) => { if (!cond) { fail++; console.log('ASSERT FAIL:', msg); } };

const zero = computeEstimate(full('CET4', 0));
const mid = computeEstimate(full('CET4', 0.6));
const high = computeEstimate({ ...full('CET4', 1), writing: { mode: 'band', band: 'high' }, translation: { mode: 'band', band: 'high' } });
show('CET4 0%  ', zero);
show('CET4 60% ', mid);
show('CET4 100%+high', high);
show('CET6 60% ', computeEstimate(full('CET6', 0.6)));
show('CET6 100%', computeEstimate(full('CET6', 1)));

assert(zero.total < mid.total && mid.total < high.total, 'monotonic total');
assert(zero.gap < mid.gap && mid.gap < high.gap, 'monotonic gap');
assert(high.total <= 710 && high.total > 600, 'high near max');
assert(zero.total >= 0 && zero.total < 330, 'zero low');
assert(zero.gap < 0, 'zero below target');
assert(high.gap > 100, 'high well above target');
assert(mid.total > 400 && mid.total < 480, '60%+mid near reference target');
assert(mid.gapLabel.includes('425'), 'gap label references 425');

// interval sanity: total inside its own range; module score inside module range
for (const est of [zero, mid, high]) {
  assert(est.range[0] <= est.total && est.total <= est.range[1], 'total inside range');
  for (const m of est.modules) {
    assert(m.range[0] <= m.score && m.score <= m.range[1], `module inside range: ${m.key}`);
    assert(m.range[0] >= 0 && m.range[1] <= m.max, `module range clamped: ${m.key}`);
  }
  assert(typeof est.limits === 'string' && est.limits.length > 20, 'limits text present');
  assert(est.target === TARGET_LINE, 'target is 425');
}

// Contract regression: no pass probability / official percentile fields leak.
for (const est of [zero, mid, high]) {
  assert(!('passProb' in est), 'no passProb field');
  assert(!('passLabel' in est), 'no passLabel field');
  assert(!('totalPercentile' in est), 'no totalPercentile field');
  for (const m of est.modules) assert(!('percentile' in m), 'no module percentile field');
}

// AI and self-assessment share the same uncertainty assumption.
const aiHigh = computeEstimate({ ...full('CET4', 0.6), writing: { mode: 'ai', score: 13 }, translation: { mode: 'ai', score: 13 } });
const bandLow = computeEstimate({ ...full('CET4', 0.6), writing: { mode: 'band', band: 'low' }, translation: { mode: 'band', band: 'low' } });
show('AI high  ', aiHigh);
show('band low ', bandLow);
assert(aiHigh.total > bandLow.total, 'ai high > band low');
assert(aiHigh.sigma === bandLow.sigma, 'unvalidated AI feedback does not narrow the interval');

// gap text
assert(gapText(0).includes('持平'), 'gap 0 flat');
assert(gapText(12).includes('高于'), 'gap positive');
assert(gapText(-12).includes('低于'), 'gap negative');

// official table interpolation + cdf
assert(percentileToReported(NORM_TABLES.CET4.listening, 249, 12) === 140, 'table exact 140@12');
assert(normCdf(0) === 0.5, 'cdf(0)=0.5');
assert(Object.values(MODULE_MAX).reduce((sum, max) => sum + max, 0) === TOTAL_MAX, 'module maxima add up to 710');
assert(!NORM_TABLES.CET6.reading.some(([score]) => score === 100), 'omit the blank CET6 reading percentile');

console.log(fail === 0 ? 'ENGINE TESTS: PASS' : `ENGINE TESTS: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
