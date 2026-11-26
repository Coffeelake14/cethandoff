import { ERROR_LABELS, LAB_PRESETS } from './lab-data.js';
import { escapeHtml } from './markdown.js';
import { __labState, openReadingLab } from './lab.js';
import { currentTab, openEstimator, returnToLearning } from './shell.js';
import { groupErrorRecords, historyStorageStatus, listHistory, summarizeHistory } from './command-history.js';
import { GRAPH_NODES, graphNodeLabel, initCommandGraph } from './command-graph.js';
import { renderCommandRadar } from './command-radar.js';

const $ = id => document.getElementById(id);
const selected = { node: 'reading' };
let records = [];
let expandedLogs = false;
let baselineReady = false;
let seenKeys = new Set();

const graph = initCommandGraph({ onSelect: nodeId => selectNode(nodeId) });

const metricDefinitions = [
  ['firstCorrect', '首答正确', '可判断主练习'],
  ['evidenceAligned', '首答证据对齐', '可核对证据'],
  ['reanswerCorrect', '重答修正', '首答错误且已重答'],
  ['transferCorrect', '同类题答对且依据对齐', '已提交同类题'],
];

const localTime = timestamp => new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(timestamp));

const hasActiveAttempt = () => __labState.screen !== 'pick' && Boolean(__labState.material);

function renderMetrics(summary) {
  $('commandMetrics').innerHTML = metricDefinitions.map(([key, label, sampleLabel]) => {
    const metric = summary[key];
    const empty = metric.samples === 0;
    const success = !empty && !metric.value.startsWith('0/');
    return `<div class="metric${empty ? ' is-empty' : success ? ' is-success' : ''}">
      <span class="metric-label">${label}</span>
      <strong class="metric-value">${metric.value}</strong>
      <span class="metric-sample">${empty ? '待练习' : `${sampleLabel} · 样本 ${metric.samples}`}</span>
    </div>`;
  }).join('');
}

function countFor(nodeId) {
  const main = records.filter(record => record.kind === 'main' && record.firstAnswer.judgeable);
  if (nodeId === 'reading') return main.length;
  return main.filter(record => record.errorType === nodeId).length;
}

function renderNodeDetail() {
  const node = GRAPH_NODES.find(item => item.id === selected.node) || GRAPH_NODES[0];
  const label = graphNodeLabel(node.id);
  const group = groupErrorRecords(records.filter(record => record.firstAnswer.judgeable && record.kind === 'main'))
    .find(item => item.errorType === node.id);
  const count = group?.count || countFor(node.id);
  const latest = node.core ? null : records.find(record => record.kind === 'main' && record.errorType === node.id && record.firstAnswer.judgeable);
  let description = '选择一个节点，查看对应错因和训练入口。';
  let action = '<button type="button" class="node-train" data-action="continue">开始阅读练习</button>';
  if (node.peripheral) {
    description = '在参考估分中查看。';
    action = '<button type="button" class="node-train" data-action="estimator">前往参考估分</button>';
  } else if (hasActiveAttempt()) {
    description = __labState.material.title;
    action = node.core ? '' : '<button type="button" class="node-train" data-action="continue">继续当前练习</button>';
  } else if (node.id === 'reading') {
    description = countFor('reading')
      ? `${countFor('reading')} 次可核对的主练习`
      : '选一个错因，查看对应练习。';
    action = '';
  } else {
    const preset = LAB_PRESETS.find(item => item.errorType === node.id);
    description = preset ? `对应练习：${preset.title}` : '查看题库中的阅读练习。';
    action = `<button type="button" class="node-train" data-action="train"${preset ? ` data-preset="${preset.id}"` : ''}>${preset ? escapeHtml(preset.title) : '查看阅读练习'}</button>`;
  }
  const detail = $('commandNodeDetail');
  detail.dataset.recorded = String(Boolean(latest));
  const evidenceStatus = latest?.evidence.judgeable ? (latest.evidence.aligned ? '依据已对齐' : '依据需核对') : '依据待确认';
  detail.innerHTML = `<div class="node-detail-top"><div><h4>${escapeHtml(label)}</h4><p>${escapeHtml(description)}</p></div>
    <span class="detail-count">${node.peripheral ? '外围' : count ? `${count} 次` : '暂无记录'}</span></div>
    ${latest ? `<div class="node-latest"><span>最近一次</span><strong>${evidenceStatus}</strong></div>` : ''}${action}`;
}

function selectNode(nodeId) {
  selected.node = nodeId;
  renderNodeDetail();
  graph.setSelected(nodeId);
  document.querySelectorAll('.monitor-row').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.node === nodeId));
  });
  if (nodeId === 'none' || nodeId === 'evidence_insufficient') {
    if (nodeId === 'evidence_insufficient') {
      $('commandGraphStatus').textContent = '证据不足：回到练习补选最直接的原文依据';
    }
    $('commandLogTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderMonitor(groups) {
  if (!groups.length) {
    $('commandMonitor').innerHTML = '<div class="command-empty">完成一道阅读练习后，这里会显示本机的错因记录</div>';
    return;
  }
  $('commandMonitor').innerHTML = groups.map(group => `<button type="button" class="monitor-row" data-node="${group.errorType}" aria-pressed="${selected.node === group.errorType}">
    <span class="monitor-name">${escapeHtml(ERROR_LABELS[group.errorType] || group.errorType)}</span>
    <span class="monitor-count">${group.count}</span>
    <span class="monitor-meta">${localTime(group.latest)} · ${escapeHtml(group.sources.join(' / '))}</span>
  </button>`).join('');
}

function logTitle(record) {
  if (record.kind === 'transfer') {
    return record.firstAnswer.correct && record.evidence.aligned ? '同类题已提交 · 答对且依据对齐' : '同类题已提交 · 仍需巩固';
  }
  return record.errorType === 'none' ? '已查看错因 · 无明显错因' : `已查看错因 · ${ERROR_LABELS[record.errorType] || record.errorType}`;
}

function renderLogs() {
  const visible = expandedLogs ? records : records.slice(0, 8);
  $('commandShowAll').hidden = records.length <= 8;
  $('commandShowAll').textContent = expandedLogs ? '收起' : '查看全部';
  if (!visible.length) {
    $('commandLogs').innerHTML = '<div class="command-empty">暂无练习记录</div>';
    return;
  }
  $('commandLogs').innerHTML = visible.map(record => `<div class="log-row ${record.kind}${record.source.includes('AI') ? ' ai' : ''}" data-record-key="${escapeHtml(record.key)}">
    <span class="log-dot" aria-hidden="true"></span>
    <div class="log-main"><div class="log-title">${escapeHtml(logTitle(record))}</div>
      <div class="log-meta">${record.kind === 'transfer' ? '同类题' : '主练习'} · ${escapeHtml(record.questionId)} · ${escapeHtml(record.source)}</div></div>
    <time class="log-time" datetime="${new Date(record.submittedAt).toISOString()}">${localTime(record.submittedAt)}</time>
  </div>`).join('');
}

function renderContinue() {
  const active = hasActiveAttempt();
  $('commandContinueText').textContent = active ? __labState.material.title : '';
  $('commandContinueLabel').textContent = active ? '继续当前练习' : '开始阅读练习';
}

function flashRecord(record) {
  graph.pulse(record);
  const panel = record.kind === 'main' ? $('commandNodeDetail') : $('commandRadar');
  panel.classList.add('record-flash');
  const logRow = [...$('commandLogs').querySelectorAll('.log-row')]
    .find(row => row.dataset.recordKey === record.key);
  logRow?.classList.add('record-flash');
  const errorTarget = record.kind === 'main' ? record.errorType : 'reading';
  const monitorRow = [...$('commandMonitor').querySelectorAll('.monitor-row')]
    .find(row => row.dataset.node === errorTarget);
  monitorRow?.classList.add('record-flash');
  const metric = record.kind === 'transfer' ? $('commandMetrics').children[3] : null;
  metric?.classList.add('record-flash');
  setTimeout(() => {
    panel.classList.remove('record-flash');
    logRow?.classList.remove('record-flash');
    monitorRow?.classList.remove('record-flash');
    metric?.classList.remove('record-flash');
  }, 850);
}

function refresh({ allowFeedback = false } = {}) {
  records = listHistory();
  const fresh = baselineReady ? records.filter(record => !seenKeys.has(record.key)) : [];
  if (!baselineReady) {
    seenKeys = new Set(records.map(record => record.key));
    baselineReady = true;
  }
  let feedback = null;
  if (allowFeedback && fresh.length) {
    fresh.forEach(record => seenKeys.add(record.key));
    feedback = fresh[0];
    selected.node = feedback.kind === 'main' ? feedback.errorType : 'reading';
  }
  const localMain = records.filter(record => record.kind === 'main' && record.firstAnswer.judgeable);
  const groups = groupErrorRecords(localMain);
  const storage = historyStorageStatus();
  $('commandStorageWarning').innerHTML = storage.unavailable ? '<p class="storage-warning" role="status">记录仅在本次打开期间可用</p>' : '';
  renderMetrics(summarizeHistory(records));
  renderCommandRadar($('commandRadar'), records);
  renderNodeDetail();
  renderMonitor(groups);
  renderLogs();
  renderContinue();
  $('commandGraphStatus').textContent = localMain.length
    ? `${localMain.length} 次本机主练习`
    : `${LAB_PRESETS.length} 篇预置练习`;
  graph.setData({ selected: selected.node, records });
  if (feedback) requestAnimationFrame(() => flashRecord(feedback));
}

function openTraining(button) {
  if (button.dataset.action === 'continue') {
    openReadingLab({ presetId: __labState.material?.id || null });
    return;
  }
  if (button.dataset.action === 'estimator') {
    openEstimator();
    return;
  }
  openReadingLab({ presetId: button.dataset.preset || null, startPresetMaterial: Boolean(button.dataset.preset) });
}

$('commandReturn').addEventListener('click', returnToLearning);
$('commandContinue').addEventListener('click', () => openReadingLab({ presetId: __labState.material?.id || null }));
$('commandShowAll').addEventListener('click', () => { expandedLogs = !expandedLogs; renderLogs(); });
$('commandNodeDetail').addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (button) openTraining(button);
});
$('commandMonitor').addEventListener('click', event => {
  const button = event.target.closest('[data-node]');
  if (button) selectNode(button.dataset.node);
});

window.addEventListener('cet:viewchange', event => {
  if (event.detail.key !== 'command') return;
  refresh({ allowFeedback: true });
});
window.addEventListener('storage', event => {
  if (event.key?.startsWith('cet.command.history.v1.')) {
    refresh({ allowFeedback: currentTab() === 'command' });
  }
});

export function initCommandCenter() {
  refresh();
}

