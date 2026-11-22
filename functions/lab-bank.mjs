// Server-side vetted transfer-question bank for the error-cause lab.
//
// When a user submits their own passage, after the model diagnoses the error
// type the client asks the `transfer` action for a same-type verification
// question. We prefer these pre-written, human-checked items over asking the
// model to invent new material. Each item is self-contained: passage with
// sentence ids, question, options, verified answer, evidence ids and traps, so
// the client can grade the transfer attempt locally without another model call.
//
// These items mirror the transfer questions shipped in web/lab-data.js. Keep
// them in sync if the wording changes.

const BANK = [
  {
    id: 'bank-scope-coffee',
    errorType: 'scope_expansion',
    tag: '范围扩大',
    title: '咖啡与睡眠（预置同类题）',
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
        hint: '回到原文核对：喝咖啡较多的是部分学生还是所有学生？',
        explanation: '原文只说部分（some）学生每天喝超过三杯，选项扩大到所有（all）学生。',
      },
      C: {
        type: 'scope_expansion',
        diff: { left: '', right: '' },
        hint: '注意 however 之后对“所有人”的限制。',
        explanation: '原文说适量饮用并非对所有人有害，选项反过来说对所有人都有害。',
      },
      D: {
        type: 'detail_mismatch',
        diff: { left: 'some students', right: 'recommend at least three cups' },
        hint: '医生是在提醒风险，还是在给推荐量？',
        explanation: '原文是调查显示部分学生每天超过三杯，医生警告过量风险；选项改写成“医生推荐至少三杯”。',
      },
    },
    correctNote: 's2 明确说部分学生每天摄入量较大，与选项 B 一致。',
  },
  {
    id: 'bank-causal-exercise',
    errorType: 'causal_inversion',
    tag: '因果倒置',
    title: '运动与情绪（预置同类题）',
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
        explanation: '原文明确说研究没有证明运动能治愈抑郁，选项把未经证实的结论说成事实。',
      },
      C: {
        type: 'scope_expansion',
        diff: { left: '', right: '' },
        hint: '研究中报告变平静的是哪一部分人？',
        explanation: '原文只说参与步行实验的志愿者报告更平静，选项扩大到每个人。',
      },
      D: {
        type: 'detail_mismatch',
        diff: { left: '', right: '' },
        hint: '对症状严重者的建议是寻求帮助，还是停止运动？',
        explanation: '原文建议症状严重者寻求专业帮助，并没有让他们停止运动。',
      },
    },
    correctNote: 's3 的 may release chemicals that reduce stress 与选项 B 对应。',
  },
  {
    id: 'bank-attitude-screens',
    errorType: 'attitude_shift',
    tag: '态度/语气变化',
    title: '家长与手机（预置同类题）',
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
        explanation: '原文说家长开始同时看到好处和风险，选项却说完全无害。',
      },
      B: {
        type: 'attitude_shift',
        diff: { left: 'have begun to see', right: 'remain strongly opposed' },
        hint: 'in recent years, however 之后态度有没有变化？',
        explanation: '原文表明态度已经变化，选项说仍然强烈反对。',
      },
      D: {
        type: 'attitude_shift',
        diff: { left: 'still setting daily limits', right: 'without any rules' },
        hint: '家长在认可学习类应用的同时，还保留了什么做法？',
        explanation: '原文说家长仍会设置每日限制，选项说完全不加规则。',
      },
    },
    correctNote: 's3 表明家长同时看到益处与风险，s4 补充仍设每日限制，与选项 C 一致。',
  },
];

const FALLBACK_ORDER = ['scope_expansion', 'causal_inversion', 'attitude_shift'];

export function pickTransfer(errorType, seed = 0) {
  const key = FALLBACK_ORDER.includes(errorType) ? errorType : 'scope_expansion';
  const matches = BANK.filter(item => item.errorType === key);
  const pool = matches.length ? matches : BANK;
  const idx = Math.abs(Math.trunc(Number(seed) || 0)) % pool.length;
  return JSON.parse(JSON.stringify(pool[idx]));
}

export function listTransferTypes() {
  return [...new Set(BANK.map(item => item.errorType))];
}

export const TRANSFER_SOURCE = 'engine-verified';
