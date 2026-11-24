// DEV ONLY — canned AI replies for the local fixture upstream so the real
// Function handler and UI can be exercised without cloud credentials. Covers
// the short actions: train (evidence diagnosis JSON), explain (translation /
// vocab / grammar), grade, recommend and scan (transcription). Never packaged
// into the Function.

export const FIXTURE_TRAIN = JSON.stringify({
  answer_correct: false,
  correct_option: 'B',
  error_type: 'scope_expansion',
  student_evidence_ids: ['s2', 's99'],
  correct_evidence_ids: ['s1'],
  english_diff: { left: 'Some', right: 'all' },
  hint: '回到原文核对：数量范围是部分还是全部？',
  explanation: '原文只说部分（Some）学生屏幕阅读，选项把范围扩大到所有（all）屏幕。',
});

// Triggered by a NOEVIDENCE marker: the model cites an id that is not in the
// passage, so after validation there is no usable evidence and the UI must say
// it cannot diagnose rather than display an invented quote.
export const FIXTURE_TRAIN_NO_EVIDENCE = JSON.stringify({
  answer_correct: false,
  correct_option: 'B',
  error_type: 'evidence_insufficient',
  student_evidence_ids: ['s2'],
  correct_evidence_ids: ['s99'],
  english_diff: { left: 'some', right: 'all' },
  hint: '先回到原文，找一句最直接支撑选项的句子。',
  explanation: '未能定位到可核对的关键句。',
});

export const FIXTURE_TRANSLATION = '许多学生现在在屏幕上阅读课程材料，而不是纸质材料。部分使用平板的学生表示更容易被通知和链接分散注意力。研究者提醒，不能因此断言纸质阅读总是更好；快速浏览时，屏幕反而更方便。';

export const FIXTURE_VOCAB = `| 单词 | 音标 | 词性 | 释义 | 考纲 |
| --- | --- | --- | --- | --- |
| abandon | /əˈbændən/ | v. | 放弃；抛弃 | 四级 |
| efficient | /ɪˈfɪʃnt/ | adj. | 高效的 | 四级 |
| retain | /rɪˈteɪn/ | v. | 记住；保留 | 四级 |

<!--VOCAB
[{"w":"abandon","p":"/əˈbændən/","pos":"v.","m":"放弃；抛弃","lv":"CET4"},{"w":"efficient","p":"/ɪˈfɪʃnt/","pos":"adj.","m":"高效的","lv":"CET4"},{"w":"retain","p":"/rɪˈteɪn/","pos":"v.","m":"记住；保留","lv":"CET4"}]
VOCAB-->`;

export const FIXTURE_GRAMMAR = `**原句：** Some of the students who used tablets reported feeling more distracted by notifications and links.
- 主干：Some of the students reported feeling more distracted（主谓宾补）
- 修饰/从句：who used tablets 是定语从句，修饰 students；by notifications and links 说明分心的来源。
- 难点：who 引导的定语从句较长，易与主句谓语 reported 混淆。
- 译文：部分使用平板的学生表示，他们更容易被通知和链接分散注意力。`;

export function fixtureGrade(prompt) {
  const writingMissing = /【作文题目】\r?\n（未提供）/.test(prompt);
  const translationMissing = /【翻译中文原文】\r?\n（未提供）/.test(prompt);
  return JSON.stringify({
    writing: {
      score: 11,
      band: 'high',
      relevance: writingMissing ? 'not_checked' : 'checked',
      comment: writingMissing
        ? '缺少作文题目，未判断切题；语言整体准确，衔接自然，个别冠词用法可再打磨。'
        : '切题，观点明确，结构与衔接较好；个别冠词与主谓一致需打磨。',
      errors: [
        { quote: 'environment pollutions', type: 'word_choice', fix: 'environmental pollution', note: 'pollution 通常不可数，且此处需要形容词。' },
        { quote: 'is become', type: 'grammar', fix: 'has become', note: '现在完成时不能用 is + 过去分词。' },
        { quote: 'peoples', type: 'word_choice', fix: 'people', note: '泛指人们时 people 本身即复数。' },
        { quote: 'they can built', type: 'grammar', fix: 'they can build', note: '情态动词后接动词原形。' },
      ],
      suggestions: ['写完通读一遍，专门检查主谓一致与情态动词后的形式。', '积累 environment / environmental 这类同根词搭配。'],
    },
    translation: {
      score: 9,
      band: 'mid',
      relevance: translationMissing ? 'not_checked' : 'checked',
      comment: translationMissing
        ? '缺少中文原文，未判断信息覆盖；译文语法基本正确，部分长句语序可更自然。'
        : '信息覆盖较完整，主题词基本到位；部分长句语序与连接词可更地道。',
      errors: [
        { quote: 'with the fast development of city', type: 'expression', fix: 'with the rapid development of cities', note: 'fast 多修饰速度，rapid 更常与 development 搭配。' },
        { quote: 'more and more peoples', type: 'word_choice', fix: 'more and more people', note: 'people 表示人们时本身是复数。' },
        { quote: 'has been greatly improved', type: 'grammar', fix: 'have been greatly improved', note: '主语为复数，谓语应使用 have。' },
      ],
      suggestions: ['先核对中文原句的主语单复数，再确定英文谓语形式。', '整理 development、convenience 等高频名词的固定搭配。'],
    },
  });
}

/* Structured OCR fixtures: the server validates every field and drops anything
   inconsistent, so these double as schema tests. */
export const FIXTURE_SCAN_READING = JSON.stringify({
  kind: 'reading',
  text: 'Passage One\nMany students now read course materials on screens rather than on paper. Some tablet users say they are more often distracted by notifications. Researchers warn that this does not prove paper is always better; for quick browsing, screens can be more convenient.\n46. What do some tablet users report?\nA. They read faster.\nB. They are more distracted.\nC. They prefer paper.\nD. They save more money.\n47. What do researchers say about paper reading?\nA. It is always better.\nB. It should be banned.\nC. It cannot be declared always better.\nD. It is cheaper than screens.',
  passage: 'Many students now read course materials on screens rather than on paper. Some tablet users say they are more often distracted by notifications. Researchers warn that this does not prove paper is always better; for quick browsing, screens can be more convenient.',
  questions: [
    {
      no: '46',
      stem: 'What do some tablet users report?',
      options: [
        { key: 'A', text: 'They read faster.' },
        { key: 'B', text: 'They are more distracted.' },
        { key: 'C', text: 'They prefer paper.' },
        { key: 'D', text: 'They save more money.' },
      ],
    },
    {
      no: '47',
      stem: 'What do researchers say about paper reading?',
      options: [
        { key: 'A', text: 'It is always better.' },
        { key: 'B', text: 'It should be banned.' },
        { key: 'C', text: 'It cannot be declared always better.' },
        { key: 'D', text: 'It is cheaper than screens.' },
      ],
    },
  ],
  prompt_material: '',
  student_answer: '',
  uncertain: ['notifications', 'quick browsing'],
  confidence: 'high',
  notes: '',
});

export const FIXTURE_SCAN_WRITING = JSON.stringify({
  kind: 'writing',
  text: 'Writing\nDirections: Write an essay on the importance of protecting the environment.\nNowadays, environment pollutions is become a serious problem. More and more peoples realize that we should take actions. If everyone try to reduce waste, they can built a better future for the next generation.',
  passage: '',
  questions: [],
  prompt_material: 'Directions: Write an essay on the importance of protecting the environment.',
  student_answer: 'Nowadays, environment pollutions is become a serious problem. More and more peoples realize that we should take actions. If everyone try to reduce waste, they can built a better future for the next generation.',
  uncertain: ['pollutions', 'try'],
  confidence: 'medium',
  notes: '字迹较连，个别词辨认不确定',
});

export const FIXTURE_SCAN_TRANSLATION = JSON.stringify({
  kind: 'translation',
  text: '翻译题目：随着城市的快速发展，人们的生活越来越便利。\n译文：With the fast development of city, our life has become more and more convenient. Public transport has been greatly improved, and more and more peoples choose to travel by subway.',
  passage: '',
  questions: [],
  prompt_material: '随着城市的快速发展，人们的生活越来越便利。公共交通也得到了极大改善，越来越多的人选择乘地铁出行。',
  student_answer: 'With the fast development of city, our life has become more and more convenient. Public transport has been greatly improved, and more and more peoples choose to travel by subway.',
  uncertain: ['fast development'],
  confidence: 'medium',
  notes: '',
});

export const FIXTURE_SCAN = JSON.stringify({
  text: 'With the development of technology, online learning has become increasingly popular among college students. It offers flexibility and abundant resources, though self-discipline remains essential. Students who plan their time well can benefit greatly from digital courses.',
  confidence: 'high',
  notes: '',
});

export const FIXTURE_RECOMMEND = `本次参考估分约 440（参考区间约 415–465），较 425 参考目标高约 15 分，听力和阅读是相对薄弱的模块，建议优先补强以留出安全边际。

### 听力（相对薄弱）
- **重点词汇**：先巩固短篇新闻与讲座高频场景词，结合《短篇新闻高频词汇》[1] 按场景记忆，注意连读与弱读。
- **刷题材料**：用内置《听力刷题材料》[2] 的方法，每天精听 1 篇真题篇章，先盲听再对照原文。
- **技巧**：预读选项圈关键词，听时定位转折与结论句。

### 阅读（相对薄弱）
- **重点词汇**：按《仔细阅读高频学术词》[3] 补齐考纲词，重点掌握同义替换。
- **刷题材料**：用《阅读刷题材料》[4] 做限时精读，整理生词与长难句。
- **技巧**：先题干定位再比对选项，警惕 some / all 这类范围词。

### 一周行动计划
周一至周三每日精听 30 分钟 + 阅读 2 篇；周四整理生词；周五限时套题；周末复盘错题。

本建议参考内置备考资料与本次估分生成，仅供学习参考，不是个性化提分承诺，也不等于官方成绩。`;
