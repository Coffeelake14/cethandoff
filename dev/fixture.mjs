// DEV ONLY — canned AI replies for the local fixture upstream so the real
// Function handler and UI can be exercised without cloud credentials. Covers
// the short actions: train (evidence diagnosis JSON), explain (translation /
// vocab / grammar), grade and recommend. Never packaged into the Function.

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
    },
    translation: {
      score: 9,
      band: 'mid',
      relevance: translationMissing ? 'not_checked' : 'checked',
      comment: translationMissing
        ? '缺少中文原文，未判断信息覆盖；译文语法基本正确，部分长句语序可更自然。'
        : '信息覆盖较完整，主题词基本到位；部分长句语序与连接词可更地道。',
    },
  });
}

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
