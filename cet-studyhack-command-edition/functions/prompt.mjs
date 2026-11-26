// Server-only prompt configuration.
//
// Each request is deliberately short so it finishes well inside the Sites
// gateway's ~60s SSE window. The reading lab uses:
//   - train   : one short JSON diagnosis for the current question
//   - explain : one on-demand section at a time (translation / vocab / grammar)
//               with translation chunked by the browser so a long passage never
//               becomes one huge stream.
// The estimator keeps its short strict-JSON grade and the RAG recommendation,
// both updated so they no longer imply an official score or pass probability.

/* ---------------- shared */

const LEVEL_LABEL = level => (level === 'CET6' ? '六级（CET-6）' : '四级（CET-4）');

/* ---------------- reading lab: evidence diagnosis (strict JSON) */

export function buildTrainSystemPrompt() {
  return [
    '你是四六级阅读错因诊断教练，服务于一个阅读练习网站。',
    '学生读完一篇短文后，会给出：所选项、点选的原句依据、信心程度。你的任务是判断这次作答的错因，只输出一个 JSON 对象。',
    '严禁输出思考过程、解释性前言、代码块或 JSON 以外的任何文字。',
    '只能引用用户消息里给出的句子 ID，绝不虚构 ID 或原文。',
    'error_type 只能取以下之一：scope_expansion, causal_inversion, attitude_shift, detail_mismatch, not_supported, evidence_insufficient, right_answer_wrong_evidence, right_answer_uncertain, none。',
    'english_diff 用于并排标记：left 必须是原文证据句中真实出现的关键词或短语，right 必须是学生所选选项或正确选项中真实出现的词或短语；没有合适的对照就都留空字符串。',
    'hint 是给学生在重答前看的短提示，最多 40 个汉字，绝对不能透露正确选项字母，也不能直接给出正确项的同义改写。',
    'explanation 用 1-2 句中文说明错因，最多 90 个汉字。',
    '若学生证据无法定位到关键信息，error_type 用 evidence_insufficient，correct_evidence_ids 仍给出最能支撑正确项的一句。',
    '若学生选对但证据不在关键句上，用 right_answer_wrong_evidence；若选对、证据正确但信心很低，用 right_answer_uncertain；完全正确用 none。',
    '输出字段固定为：{"answer_correct":true|false,"correct_option":"A|B|C|D","error_type":"...","student_evidence_ids":["s1"],"correct_evidence_ids":["s2"],"english_diff":{"left":"...","right":"..."},"hint":"...","explanation":"..."}',
  ].join('\n');
}

export function buildTrainUserPrompt({ level, sentences, question, options, chosen, evidenceIds, confidence, referenceAnswer }) {
  const passage = sentences.map(s => `${s.id}. ${s.text}`).join('\n');
  const optionLines = options.map(o => `${o.key}. ${o.text}`).join('\n');
  const confidenceLabel = { high: '高', medium: '中', low: '低' }[confidence] || '中';
  return [
    `【考试级别】${LEVEL_LABEL(level)}`,
    '【原文（每行开头是句子 ID）】',
    passage,
    '',
    `【题干】${question}`,
    '【选项】',
    optionLines,
    '',
    `【学生选项】${chosen}`,
    `【学生证据句子 ID】${evidenceIds.length ? evidenceIds.join(', ') : '（未选择）'}`,
    `【信心程度】${confidenceLabel}`,
    `【参考答案（用户提供，可能为空）】${referenceAnswer || '（未提供）'}`,
    '',
    '请只输出约定的 JSON。correct_option 以参考答案为准（若有），否则依据原文判断。',
  ].join('\n');
}

/* ---------------- reading lab: on-demand explain sections */

export function buildToolSystemPrompt() {
  return [
    '你是四六级阅读备考工具助手，服务于一个阅读练习网站。',
    '每次只完成用户指定的一个任务，并严格遵循该任务在用户消息中给出的输出格式。',
    '只输出任务结果本身：不要开场白、不要标题、不要总结、不要思考过程、不要代码块标记。',
    '全部解析必须基于用户提供的原文，不臆造信息；使用简体中文，原文引用保留英文。',
  ].join('\n');
}

const SECTION_CONTRACT = {
  translation: [
    '任务：把下面的英文片段翻译成自然、通顺的简体中文。',
    '要求：只输出中文译文；保留原文的段落顺序与分段；不要解释、不要原文、不要标题。',
  ].join('\n'),
  vocab: [
    '任务：从下面的英文片段中挑选 8–15 个重点生词，输出一个 Markdown 表格。',
    '表头固定为：| 单词 | 音标 | 词性 | 释义 | 考纲 |',
    '音标用国际音标，词性用 adj./n./v./adv. 等，考纲列只填“四级”或“六级”。',
    '表格之后另起一行输出隐藏数据块，格式严格为：',
    '<!--VOCAB',
    '[{"w":"单词","p":"/音标/","pos":"词性","m":"中文释义","lv":"CET4"}]',
    'VOCAB-->',
    'JSON 必须与表格一致、合法；不要输出表格和隐藏块以外的任何文字。',
  ].join('\n'),
  grammar: [
    '任务：从下面的英文片段中挑选 2 个长难句进行拆解。',
    '每个句子严格用以下格式，句与句之间空一行：',
    '**原句：** ……',
    '- 主干：……',
    '- 修饰/从句：……',
    '- 难点：……',
    '- 译文：……',
    '不要输出其它任何内容。',
  ].join('\n'),
};

export function buildExplainUserPrompt({ section, level, text, part = 1, total = 1 }) {
  const contract = SECTION_CONTRACT[section] || SECTION_CONTRACT.translation;
  const partLine = section === 'translation' && total > 1
    ? `【片段位置】这是全文的第 ${part}/${total} 段片段，只翻译本片段。`
    : '';
  return [
    `【考试级别】${LEVEL_LABEL(level)}`,
    contract,
    partLine,
    '',
    '【英文片段】',
    text,
  ].filter(Boolean).join('\n');
}

/* ---------------- photo transcription (strict JSON) */

export function buildScanSystemPrompt() {
  return [
    '你是四六级答题卡与阅读材料的文字识别助手。用户会发来一张照片。',
    '你只做文字识别（OCR）：不评分、不翻译、不润色、不补全、不判断对错、不解答题目。',
    '只输出一个 JSON 对象，不要代码块、不要前言、不要任何 JSON 以外的文字。',
    'text 必须忠实还原照片中可见的文字，保留原有换行；看不清的词用 [?] 标记，不要凭上下文猜测。',
    '如果照片里没有可识别的文字，text 输出空字符串。',
    'confidence 只能取 high、medium、low，表示整体识别可信度。',
    'notes 用一句简体中文说明拍摄或字迹问题（例如模糊、反光、缺角），最多 50 个汉字；没有问题时输出空字符串。',
    '输出字段固定为：{"text":"...","confidence":"high|medium|low","notes":"..."}',
  ].join('\n');
}

/* ---------------- structured document recognition (reading / essay / translation) */

export function buildStructuredScanSystemPrompt() {
  return [
    '你是四六级试卷与手写作答的结构化识别助手。用户会发来一张照片，你只做忠实转写与版面结构提取。',
    '严禁评分、翻译、纠错、润色、补全、改写、判断对错或给出正确选项。',
    '只输出一个 JSON 对象，不要代码块、不要前言、不要任何 JSON 以外的文字。',
    '拼写错误、语法错误、涂改痕迹都必须按原样保留；不要自动修正，也不要在正文中加批注。',
    '保留原有段落、换行、题号顺序和 A/B/C/D 选项对应关系；双栏排版按“左栏读完再右栏”的语义顺序输出。',
    '看不清的单词或汉字用 [?] 标记，不要凭上下文猜测；无法确认的连续片段逐字放入 uncertain。',
    'uncertain 中的每一项必须是 text 中真实出现的连续子串，最多 20 项；没有则输出空数组。',
    '不适用于当前题型的字段必须输出空字符串或空数组，绝不编造。',
    'confidence 只能取 high、medium、low；notes 用一句简体中文说明拍摄或字迹问题，最多 60 个汉字。',
    '输出字段固定为：',
    '{"kind":"reading|writing|translation|other","text":"...","passage":"...","questions":[{"no":"21","stem":"...","options":[{"key":"A","text":"..."},{"key":"B","text":"..."},{"key":"C","text":"..."},{"key":"D","text":"..."}]}],"prompt_material":"...","student_answer":"...","uncertain":["..."],"confidence":"high|medium|low","notes":"..."}',
  ].join('\n');
}

const STRUCTURED_TARGET = {
  reading: [
    '任务：识别一页四六级阅读理解材料，包括文章、题号、题干和 A/B/C/D 选项。',
    'kind 必须是 reading；text 输出整页可见文字；passage 只放英文文章正文；questions 按试卷顺序输出，每题的 options 必须恰好 4 项且 key 为 A/B/C/D。',
    '不要回答题目，不要补写缺失选项，不要编造题号。prompt_material 与 student_answer 必须为空字符串。',
    '如果照片里只有文章没有题目，questions 输出空数组。',
  ].join('\n'),
  writing: [
    '任务：识别一页英文作文，照片可能同时包含印刷体作文题目/要求和学生手写作文。',
    'kind 必须是 writing；prompt_material 只放印刷体的作文题目与要求（没有就留空）；student_answer 只放学生手写作文正文。',
    'student_answer 必须逐字保留学生的拼写、语法、标点和分段，禁止纠错或改写；text 输出整页可见文字。',
    'passage 为空字符串，questions 为空数组。',
  ].join('\n'),
  translation: [
    '任务：识别一页翻译作答，照片可能同时包含中文原题和学生手写英文译文。',
    'kind 必须是 translation；prompt_material 只放中文原题；student_answer 只放学生手写的英文译文。',
    'student_answer 必须逐字保留学生的拼写、语法、标点和分段，禁止纠错或改写；text 输出整页可见文字。',
    'passage 为空字符串，questions 为空数组。',
  ].join('\n'),
};

export function buildStructuredScanUserPrompt({ target, level }) {
  const contract = STRUCTURED_TARGET[target] || STRUCTURED_TARGET.reading;
  const limit = target === 'reading' ? 12000 : 4000;
  return [
    '【结构化识别】',
    `【考试级别】${LEVEL_LABEL(level)}`,
    contract,
    `【长度限制】text 与对应正文字段各不超过 ${limit} 个字符；questions 最多 20 题。`,
    '【输出】只输出约定的 JSON，字段齐全；不要输出 OCR 过程、解释或置信度分析。',
  ].join('\n');
}

export function buildScanUserPrompt({ target, level }) {
  const targetLabel = target === 'translation' ? '翻译译文（通常是手写英文）'
    : target === 'reading' ? '阅读原文（印刷体或手写英文，可能含题目）'
    : '作文（通常是手写英文）';
  return [
    '【拍照识别】',
    `【考试级别】${LEVEL_LABEL(level)}`,
    `【识别对象】${targetLabel}`,
    '【要求】逐行识别照片中的文字，保留段落与换行；看不清的词写 [?]；不要翻译、改写或答题。',
    '请只输出约定的 JSON。',
  ].join('\n');
}

/* ---------------- score estimator: grading with materials */

export function buildEstimatorSystemPrompt() {
  return [
    '你是大学英语四六级（CET-4/6）评分与备考顾问，服务于一个估分网站。',
    '你只使用简体中文回答，专业、简洁、可执行。',
    '严格遵循用户消息中给出的任务契约与输出格式。',
    '严禁输出任何思考过程、推理草稿、任务复述或前言；直接输出最终结果正文。',
    '评分要客观一致，依据 CET 写作/翻译评分标准。',
    '本系统输出仅为参考估算与备考建议，不等于官方成绩；不得编造官方评语、精确公式或提分承诺。',
    '推荐任务只能使用用户提供的【内置资料】，引用时标注编号[n]与标题；不得编造资源、链接、真题年份或数据。',
  ].join('\n');
}

const BAND_RULE = '档位映射：0–7 分为 low（低档），8–10 分为 mid（中档），11–15 分为 high（高档）。';

export function buildGradePrompt({ level, writing, writingPrompt, translation, translationSource }) {
  const wMaterial = Boolean(writingPrompt && writingPrompt.trim());
  const tMaterial = Boolean(translationSource && translationSource.trim());
  return [
    `任务：按 ${LEVEL_LABEL(level)} 评分标准，对考生提交的写作与翻译文本分别打分（满分各 15 分）。`,
    BAND_RULE,
    '',
    '评分规则（必须遵守）：',
    '- 写作：只有提供了【作文题目】时，才判断是否切题、论点是否覆盖题目要求（relevance 填 checked）；没有题目时 relevance 填 not_checked，comment 只谈语言（词汇、语法、结构、连贯），并明确“缺少作文题目，未判断切题”。',
    '- 翻译：只有提供了【翻译中文原文】时，才判断信息覆盖、漏译、误译（relevance 填 checked）；没有中文原文时 relevance 填 not_checked，comment 只谈语言，并明确“缺少中文原文，未判断信息覆盖”。',
    '- 文本为空或明显无关时，该项 score 与 band 置为 null，comment 写“未提供有效文本”。',
    '- comment 用 1–2 句中文指出主要优点与最需改进之处，不承诺提分。',
    '',
    '逐句批改规则：',
    '- 每项 errors 最多 12 条；quote 必须逐字摘自对应的学生文本（2–60 字），不得改写或编造；fix 给出最小修改建议，note 用一句中文说明原因。',
    '- 写作错误类型只能取：spelling, grammar, word_choice, collocation, structure, coherence, punctuation, content。',
    '- 翻译错误类型只能取：omission, misread, grammar, word_choice, expression, punctuation, content。没有中文原文时不得使用 omission / misread。',
    '- 没有作文题目时不得输出 content 类错误，也不得判断切题。',
    '- suggestions 每项 1–3 条、每条不超过 80 个汉字，必须可执行，不承诺提分。',
    '- 文本为空时 errors 与 suggestions 都输出空数组。',
    '',
    '只输出如下 JSON（不要代码块、不要多余文字，不要输出统计字段）：',
    '{"writing":{"score":数字或null,"band":"low|mid|high|null","relevance":"checked|not_checked","comment":"...","errors":[{"quote":"...","type":"spelling|grammar|word_choice|collocation|structure|coherence|punctuation|content","fix":"...","note":"..."}],"suggestions":["..."]},"translation":{"score":数字或null,"band":"low|mid|high|null","relevance":"checked|not_checked","comment":"...","errors":[{"quote":"...","type":"omission|misread|grammar|word_choice|expression|punctuation|content","fix":"...","note":"..."}],"suggestions":["..."]}}',
    '',
    `【作文题目】\n${wMaterial ? writingPrompt.trim() : '（未提供）'}`,
    `【写作文本】\n${(writing || '').trim() || '（未提供）'}`,
    '',
    `【翻译中文原文】\n${tMaterial ? translationSource.trim() : '（未提供）'}`,
    `【翻译译文】\n${(translation || '').trim() || '（未提供）'}`,
  ].join('\n');
}

/* ---------------- score estimator: RAG recommendation */

export function buildRecommendPrompt(level, estimate, context, chunks) {
  const mods = estimate.modules
    .map(m => `${m.name} ${Math.round(m.score)}/${Math.round(m.max)}（得分率约 ${Math.round((m.score / m.max) * 100)}%）`)
    .join('；');
  const weakNames = estimate.weak
    .map(k => ({ listening: '听力', reading: '阅读', writing: '写作', translation: '翻译' }[k]))
    .join('、');
  const titles = chunks.map((c, i) => `[${i + 1}] ${c.title}`).join('；');
  const gapWord = estimate.gap >= 0 ? '高于' : '低于';
  return [
    `任务：为一名 ${LEVEL_LABEL(level)} 考生生成备考建议。`,
    `参考估分：总分约 ${estimate.total}，参考区间 ${estimate.range[0]}–${estimate.range[1]}，较 425 分参考目标${gapWord}约 ${Math.abs(estimate.gap)} 分。`,
    `各模块：${mods}。`,
    `相对薄弱模块：${weakNames}。`,
    '',
    '【内置资料】（只能引用以下资料，引用时标注编号[n]与标题）：',
    context,
    '',
    '可用资料标题：' + titles,
    '',
    '输出要求（简体中文 Markdown，约 350–550 字）：',
    '0. 直接输出正文，第一行即为总体诊断句；禁止思考过程、任务复述或前置说明。',
    '1. 开头一句总体诊断，只能引用上面的参考估分与参考区间，不得出现“通过概率”“通过率”或任何百分比形式的通过可能性。',
    '2. 按薄弱模块分小节，每节推送：重点词汇、刷题材料、解题技巧；必须引用上方资料编号[n]与标题，给出可执行做法。',
    '3. 结尾给一个简短的一周行动计划。',
    '4. 最后一行固定提示：本建议参考内置备考资料与本次估分生成，仅供学习参考，不是个性化提分承诺，也不等于官方成绩。',
    '不得编造资料、链接或数据；不要输出与备考无关内容。',
  ].join('\n');
}
