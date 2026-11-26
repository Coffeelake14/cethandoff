// RAG 检索：按薄弱模块 + 级别 + 关键词相关度从内置资源库召回 top-K 资源块。
import { CORPUS } from './corpus.mjs';

const MODULE_KEYWORDS = {
  listening: ['听力', '新闻', '对话', '篇章', '讲座', '精听', '词汇'],
  reading: ['阅读', '选词', '匹配', '仔细', '定位', '词汇', '考纲'],
  writing: ['写作', '作文', '模板', '句型', '议论文', '评分'],
  translation: ['翻译', '文化', '社会', '主题词', '句型'],
};

const levelOk = (chunk, level) => chunk.level === 'both' || chunk.level === level;

function score(chunk, level, weakSet, queryTags) {
  let s = 0;
  if (weakSet.has(chunk.module)) s += 5;
  if (chunk.level === level) s += 1;
  for (const tag of chunk.tags) if (queryTags.includes(tag)) s += 2;
  for (const kw of queryTags) if (chunk.text.includes(kw)) s += 0.4;
  if (chunk.type === 'vocab') s += 0.6;
  if (chunk.type === 'practice') s += 0.6;
  return s;
}

// 返回最多 k 个资源块：优先覆盖每个薄弱模块（词汇+刷题/技巧），再按相关度补齐。
export function retrieve(level, weakModules, k = 8) {
  const weakSet = new Set(weakModules);
  const queryTags = [...new Set(weakModules.flatMap(m => MODULE_KEYWORDS[m] || []))];
  const pool = CORPUS.filter(c => levelOk(c, level))
    .map(c => ({ ...c, _score: score(c, level, weakSet, queryTags) }))
    .sort((a, b) => b._score - a._score);

  const picked = [];
  const seen = new Set();
  const take = c => { if (c && !seen.has(c.id)) { seen.add(c.id); picked.push(c); } };

  // 每个薄弱模块先保一个 vocab + 一个 skill/practice/template。
  for (const m of weakModules) {
    const ofModule = pool.filter(c => c.module === m);
    take(ofModule.find(c => c.type === 'vocab'));
    take(ofModule.find(c => c.type === 'practice') || ofModule.find(c => c.type === 'skill') || ofModule.find(c => c.type === 'template'));
  }
  for (const c of pool) { if (picked.length >= k) break; take(c); }
  return picked.slice(0, k).map(({ _score, ...rest }) => rest);
}

// 供 Function 把召回资源拼成可被模型引用的上下文（含资料编号、标题与来源）。
export function formatContext(chunks) {
  return chunks.map((c, i) => {
    const kind = c.source.kind === 'official' ? '官方资料' : '项目原创';
    const url = c.source.url ? `\n来源链接：${c.source.url}` : '';
    return `[资料 ${i + 1}] 资料编号：${c.id}\n标题：${c.title}\n来源：${c.source.title}（${kind}）${url}\n${c.text}`;
  }).join('\n\n');
}