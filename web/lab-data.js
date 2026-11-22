// Built-in preset exercises for the reading error-cause lab.
//
// Everything here is original, hand-written material. Each preset ships with:
//   - a short passage split into addressable sentences (stable ids),
//   - one question with four options and a verified correct answer,
//   - the sentence ids that actually support the correct option,
//   - trap metadata for each wrong option (error type + English contrast + hint),
//   - a same-type transfer question on fresh material.
//
// These presets are labelled "预置练习 · 人工核对" in the UI. They never call a
// model; the diagnosis is computed locally from this verified data. Only
// user-supplied passages go through Qoder Cloud Agents. Fixture-only data lives
// in dev/, never here.

export const ERROR_LABELS = {
  scope_expansion: '范围扩大',
  causal_inversion: '因果倒置',
  attitude_shift: '态度/语气变化',
  detail_mismatch: '细节错配',
  not_supported: '无中生有',
  evidence_insufficient: '证据不足',
  right_answer_wrong_evidence: '答案对但依据不对',
  right_answer_uncertain: '答案对但信心不足',
  none: '无明显错因',
};

export const ERROR_TYPES = [
  'scope_expansion',
  'causal_inversion',
  'attitude_shift',
  'detail_mismatch',
  'not_supported',
  'evidence_insufficient',
  'right_answer_wrong_evidence',
  'right_answer_uncertain',
  'none',
];

const SCREEN_READING_TRANSFER = {
  id: 'transfer-coffee',
  title: '咖啡与睡眠（同类新材料）',
  level: 'CET4',
  passage: [
    { id: 's1', para: 1, text: 'College students often rely on coffee to stay awake during exam week.' },
    { id: 's2', para: 1, text: 'Recent surveys show that some students drink more than three cups a day.' },
    { id: 's3', para: 1, text: 'Doctors warn that too much caffeine can disturb sleep for many people.' },
    { id: 's4', para: 2, text: 'However, moderate coffee drinking is not harmful to everyone.' },
    { id: 's5', para: 2, text: 'The effect depends on the individual and the amount consumed.' },
  ],
  question: {
    stem: 'According to the passage, which statement about coffee is supported?',
    options: [
      { key: 'A', text: 'Coffee destroys the sleep of all students.' },
      { key: 'B', text: 'Some students consume a large amount of coffee daily.' },
      { key: 'C', text: 'Coffee is harmful to everyone.' },
      { key: 'D', text: 'Doctors recommend at least three cups per day.' },
    ],
    answer: 'B',
  },
  evidence: ['s2'],
  traps: {
    A: {
      type: 'scope_expansion',
      diff: { left: 'some students', right: 'all students' },
      hint: '回到原文核对：喝咖啡较多的到底是部分学生还是所有学生？',
      explanation: '原文只说部分（some）学生每天喝超过三杯，选项把范围扩大到所有（all）学生，属于范围扩大。',
    },
    C: {
      type: 'scope_expansion',
      diff: { left: '', right: '' },
      hint: '注意 however 之后对“所有人”的限制。',
      explanation: '原文说适量饮用并非对所有人有害，选项反过来说对所有人都有害，扩大了范围。',
    },
    D: {
      type: 'detail_mismatch',
      diff: { left: 'some students', right: 'recommend at least three cups' },
      hint: '医生是在提醒风险，还是在给推荐量？',
      explanation: '原文是调查显示部分学生每天超过三杯，医生警告过量风险；选项把它改写成“医生推荐至少三杯”。',
    },
  },
  correctNote: '原文明确说部分（some）学生每天摄入量较大，与选项 B 一致；s2 是最直接的依据。',
};

const MUSIC_TRANSFER = {
  id: 'transfer-exercise',
  title: '运动与情绪（同类新材料）',
  level: 'CET4',
  passage: [
    { id: 's1', para: 1, text: 'Many people say that exercise improves their mood.' },
    { id: 's2', para: 1, text: 'In a small study, volunteers who walked for thirty minutes reported feeling calmer afterwards.' },
    { id: 's3', para: 1, text: 'The authors suggested that physical activity may release chemicals that reduce stress.' },
    { id: 's4', para: 2, text: 'The study did not prove that exercise can cure depression.' },
    { id: 's5', para: 2, text: 'People with serious symptoms were advised to seek professional help.' },
  ],
  question: {
    stem: 'What did the small study suggest about exercise?',
    options: [
      { key: 'A', text: 'Exercise can cure depression in all cases.' },
      { key: 'B', text: 'Physical activity may reduce stress through chemicals.' },
      { key: 'C', text: 'Walking for thirty minutes makes everyone calmer.' },
      { key: 'D', text: 'People with serious symptoms should stop exercising.' },
    ],
    answer: 'B',
  },
  evidence: ['s3'],
  traps: {
    A: {
      type: 'causal_inversion',
      diff: { left: 'reduce stress', right: 'cure depression in all cases' },
      hint: '原文对“治愈抑郁”是肯定、否定还是保留？',
      explanation: '原文明确说研究没有证明运动能治愈抑郁，选项把未经证实的结论说成事实，并夸大为 all cases。',
    },
    C: {
      type: 'scope_expansion',
      diff: { left: '', right: '' },
      hint: '研究中报告变平静的是哪一部分人？',
      explanation: '原文只说参与步行实验的志愿者报告更平静，选项扩大到每个人（everyone）。',
    },
    D: {
      type: 'detail_mismatch',
      diff: { left: '', right: '' },
      hint: '对症状严重者的建议是寻求帮助，还是停止运动？',
      explanation: '原文建议症状严重者寻求专业帮助，并没有让他们停止运动。',
    },
  },
  correctNote: '原文的 suggested ... may release chemicals that reduce stress 与选项 B 对应，s3 是依据句。',
};

const ONLINE_COURSE_TRANSFER = {
  id: 'transfer-screens',
  title: '家长与手机（同类新材料）',
  level: 'CET4',
  passage: [
    { id: 's1', para: 1, text: 'At first, many parents worried that smartphones would distract their children.' },
    { id: 's2', para: 1, text: 'Some schools even asked families to limit screen time at home.' },
    { id: 's3', para: 1, text: 'In recent years, however, a growing number of parents have begun to see both benefits and risks.' },
    { id: 's4', para: 2, text: 'They now value apps that help children learn, while still setting daily limits.' },
    { id: 's5', para: 2, text: 'Most parents agree that balance matters more than total avoidance.' },
  ],
  question: {
    stem: "How have many parents' views on smartphones changed?",
    options: [
      { key: 'A', text: 'They now believe smartphones are completely harmless.' },
      { key: 'B', text: 'They remain strongly opposed to any screen use.' },
      { key: 'C', text: 'Many see learning benefits but still set limits.' },
      { key: 'D', text: 'They think children should use smartphones without any rules.' },
    ],
    answer: 'C',
  },
  evidence: ['s3', 's4', 's5'],
  traps: {
    A: {
      type: 'attitude_shift',
      diff: { left: 'both benefits and risks', right: 'completely harmless' },
      hint: '原文说的是只看到好处，还是好处与风险并存？',
      explanation: '原文说家长开始同时看到好处和风险（both benefits and risks），选项却说完全无害，态度被推向另一个极端。',
    },
    B: {
      type: 'attitude_shift',
      diff: { left: 'have begun to see', right: 'remain strongly opposed' },
      hint: 'in recent years, however 之后态度有没有变化？',
      explanation: '原文用 in recent years, however 表明态度已经变化，选项说仍然强烈反对，忽略了时间线的转变。',
    },
    D: {
      type: 'attitude_shift',
      diff: { left: 'still setting daily limits', right: 'without any rules' },
      hint: '家长在认可学习类应用的同时，还保留了什么做法？',
      explanation: '原文说家长仍会设置每日限制，选项说完全不加规则，属于过度推断。',
    },
  },
  correctNote: 's3 表明家长同时看到益处与风险，s4 补充他们仍设每日限制，与选项 C 一致。',
};

export const LAB_PRESETS = [
  {
    id: 'screen-reading',
    level: 'CET4',
    tag: ERROR_LABELS.scope_expansion,
    errorType: 'scope_expansion',
    title: '屏幕阅读真的更差吗？',
    blurb: '训练识别 some / all 这类数量范围被放大的选项。',
    passage: [
      { id: 's1', para: 1, text: 'Many students now read their course materials on screens rather than on paper.' },
      { id: 's2', para: 1, text: 'At first glance, digital reading appears to save both money and time.' },
      { id: 's3', para: 1, text: 'Yet a number of studies suggest that screens may be less effective for deep comprehension.' },
      { id: 's4', para: 2, text: 'In one experiment, researchers asked students to read the same article on paper or on a tablet.' },
      { id: 's5', para: 2, text: 'Some of the students who used tablets reported feeling more distracted by notifications and links.' },
      { id: 's6', para: 2, text: 'Those readers often paused to check messages, which broke their concentration.' },
      { id: 's7', para: 3, text: 'The researchers were careful not to claim that paper is always better.' },
      { id: 's8', para: 3, text: 'For quick scanning or searching, a screen is clearly more convenient.' },
      { id: 's9', para: 3, text: 'The real difference seems to lie in how we read, not only in what we read from.' },
    ],
    question: {
      stem: 'What can we learn about screen reading from the passage?',
      options: [
        { key: 'A', text: "Screens always harm students' concentration." },
        { key: 'B', text: 'Some tablet readers were more easily distracted.' },
        { key: 'C', text: 'Paper reading is always more efficient than screen reading.' },
        { key: 'D', text: 'Notifications make all reading impossible.' },
      ],
      answer: 'B',
    },
    evidence: ['s5', 's6'],
    traps: {
      A: {
        type: 'scope_expansion',
        diff: { left: 'Some', right: 'always' },
        hint: '回到原文核对：受影响的是部分学生还是所有学生？',
        explanation: '原文只说部分（Some）平板读者更容易分心，选项把范围扩大到所有（always）学生，属于范围扩大。',
      },
      C: {
        type: 'scope_expansion',
        diff: { left: '', right: '' },
        hint: '原文是否说纸质阅读在任何情况下都更高效？',
        explanation: '原文只说屏幕对深度理解可能较弱，并承认快速浏览时屏幕更方便，选项夸大为 always，属于范围扩大。',
      },
      D: {
        type: 'scope_expansion',
        diff: { left: 'Some', right: 'all reading impossible' },
        hint: '原文提到的干扰是否严重到让所有阅读都无法进行？',
        explanation: '原文仅说部分读者被通知打断注意力，并未说所有阅读都无法进行，选项把影响放大到全部。',
      },
    },
    correctNote: 's5 明确指出部分平板读者更容易分心，s6 补充他们因查看消息而中断专注，与选项 B 对应。',
    transfer: SCREEN_READING_TRANSFER,
  },
  {
    id: 'music-anxiety',
    level: 'CET4',
    tag: ERROR_LABELS.causal_inversion,
    errorType: 'causal_inversion',
    title: '音乐让你更聪明，还是更放松？',
    blurb: '训练区分“降低焦虑从而帮助专注”与“直接提高智力”的因果偷换。',
    passage: [
      { id: 's1', para: 1, text: 'Some students believe that listening to music makes them study more efficiently.' },
      { id: 's2', para: 1, text: 'In a recent study, students who felt anxious performed better when soft music was played.' },
      { id: 's3', para: 1, text: 'The researchers explained that the music reduced anxiety, which in turn helped attention.' },
      { id: 's4', para: 2, text: 'They did not find that music itself increased intelligence or memory.' },
      { id: 's5', para: 2, text: 'Students who were already calm showed little change.' },
    ],
    question: {
      stem: 'Why did some anxious students perform better with music?',
      options: [
        { key: 'A', text: 'Music directly raised their intelligence.' },
        { key: 'B', text: 'Music reduced their anxiety and thus helped attention.' },
        { key: 'C', text: 'Calm students needed music most.' },
        { key: 'D', text: 'Music increased their memory capacity.' },
      ],
      answer: 'B',
    },
    evidence: ['s3'],
    traps: {
      A: {
        type: 'causal_inversion',
        diff: { left: 'reduced anxiety', right: 'raised their intelligence' },
        hint: '原文是否说音乐直接提高了智力？',
        explanation: '原文明确说没有发现音乐本身提高智力或记忆；真正起作用的是降低焦虑，选项把间接作用说成直接因果。',
      },
      C: {
        type: 'detail_mismatch',
        diff: { left: '', right: '' },
        hint: '原文里本来平静的学生发生了什么变化？',
        explanation: '原文说本已平静的学生变化很小，选项反过来说他们最需要音乐，属于细节错配。',
      },
      D: {
        type: 'causal_inversion',
        diff: { left: 'reduced anxiety', right: 'increased their memory' },
        hint: '原文对“记忆提高”的说法是肯定还是否定？',
        explanation: '原文是否定：没有发现音乐提高记忆，选项说成提高记忆，属于因果倒置。',
      },
    },
    correctNote: 's3 说明音乐降低焦虑、进而帮助注意力，与选项 B 的因果链一致。',
    transfer: MUSIC_TRANSFER,
  },
  {
    id: 'online-courses',
    level: 'CET4',
    tag: ERROR_LABELS.attitude_shift,
    errorType: 'attitude_shift',
    title: '老师们对网课的态度变了吗？',
    blurb: '训练抓住 however / over time 标记的态度转向，而不是停在最初印象。',
    passage: [
      { id: 's1', para: 1, text: 'When online courses first appeared, many teachers were skeptical.' },
      { id: 's2', para: 1, text: 'They worried that students would lose the direct contact of a classroom.' },
      { id: 's3', para: 1, text: 'Over time, however, a number of teachers have changed their minds.' },
      { id: 's4', para: 2, text: 'They now appreciate the flexibility that online tools offer.' },
      { id: 's5', para: 2, text: 'Still, most agree that face-to-face discussion remains valuable.' },
    ],
    question: {
      stem: "How have many teachers' attitudes toward online courses changed?",
      options: [
        { key: 'A', text: 'They have become completely opposed to online courses.' },
        { key: 'B', text: 'They remain as skeptical as they were at the beginning.' },
        { key: 'C', text: 'Many now value online tools while still respecting face-to-face discussion.' },
        { key: 'D', text: 'They believe online courses should replace classrooms entirely.' },
      ],
      answer: 'C',
    },
    evidence: ['s3', 's4', 's5'],
    traps: {
      A: {
        type: 'attitude_shift',
        diff: { left: 'now appreciate', right: 'completely opposed' },
        hint: '注意 however 之后态度发生了什么变化。',
        explanation: '原文说许多老师已经改变看法、开始认可灵活性，选项却说完全反对，态度方向相反。',
      },
      B: {
        type: 'attitude_shift',
        diff: { left: 'changed their minds', right: 'remain as skeptical' },
        hint: '原文的时间线是过去与现在对比。',
        explanation: '原文用 Over time, however 表示态度已经改变，选项说仍然和最初一样怀疑，忽略了态度转向。',
      },
      D: {
        type: 'attitude_shift',
        diff: { left: 'face-to-face discussion remains valuable', right: 'replace classrooms entirely' },
        hint: '原文对线下讨论的最终态度是什么？',
        explanation: '原文说多数人仍认为面对面讨论有价值，并未主张完全取代课堂，属于过度推断。',
      },
    },
    correctNote: 's3 表明态度已改变，s4 说现在认可灵活性，s5 补充仍重视面对面讨论，与选项 C 对应。',
    transfer: ONLINE_COURSE_TRANSFER,
  },
];

export function findPreset(id) {
  return LAB_PRESETS.find(p => p.id === id) || null;
}

export function presetCard(preset) {
  return {
    id: preset.id,
    level: preset.level,
    tag: preset.tag,
    title: preset.title,
    blurb: preset.blurb,
  };
}
