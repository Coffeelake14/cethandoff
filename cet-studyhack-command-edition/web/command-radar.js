const AXES = [
  { key: 'first', label: '首答', title: '首答正确', kind: 'main', field: 'firstAnswer', success: 'correct', x: 50, y: 9 },
  { key: 'evidence', label: '依据', title: '首答依据对齐', kind: 'main', field: 'evidence', success: 'aligned', x: 87, y: 38 },
  { key: 'retry', label: '重答', title: '重答纠错', kind: 'main', field: 'reanswer', success: 'correct', x: 73, y: 83 },
  { key: 'transfer', label: '同类答题', title: '同类题答对', kind: 'transfer', field: 'firstAnswer', success: 'correct', x: 27, y: 83 },
  { key: 'transfer-evidence', label: '同类依据', title: '同类题依据对齐', kind: 'transfer', field: 'evidence', success: 'aligned', x: 13, y: 38 },
];

const CENTER = { x: 150, y: 128 };
const RADIUS = 88;

function position(index, ratio) {
  const angle = index * Math.PI * 2 / AXES.length - Math.PI / 2;
  return [CENTER.x + Math.cos(angle) * RADIUS * ratio, CENTER.y + Math.sin(angle) * RADIUS * ratio];
}

const point = ([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`;

function measure(records, axis) {
  const samples = records.filter(record => record.kind === axis.kind && record[axis.field]?.judgeable);
  const hits = samples.filter(record => record[axis.field][axis.success] === true).length;
  return { ...axis, hits, total: samples.length, ratio: samples.length ? hits / samples.length : null };
}

function radarPlot(readings) {
  const rings = [.25, .5, .75, 1].map(scale =>
    `<polygon class="radar-grid" points="${AXES.map((_, index) => point(position(index, scale))).join(' ')}"/>`,
  ).join('');
  const spokes = AXES.map((axis, index) => `<path class="radar-spoke" data-axis="${axis.key}" d="M${point([CENTER.x, CENTER.y])}L${point(position(index, 1))}"/>`).join('');
  const measured = readings.map((axis, index) => axis.ratio === null ? null : point(position(index, axis.ratio)));
  const complete = measured.every(Boolean);
  const silhouette = complete ? `<polygon class="radar-shape" points="${measured.join(' ')}"/>` : '';
  const edges = complete ? '' : measured.map((end, index) => {
    const next = measured[(index + 1) % measured.length];
    return end && next ? `<path class="radar-edge" d="M${end}L${next}"/>` : '';
  }).join('');
  const markers = readings.map((axis, index) => {
    const [x, y] = position(index, axis.ratio ?? 1);
    const className = axis.ratio === null ? 'radar-point is-pending' : 'radar-point is-measured';
    return `<circle class="${className}" data-axis="${axis.key}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.3"/>`;
  }).join('');
  return `<svg class="radar-plot" viewBox="0 0 300 247" aria-hidden="true">
    <circle class="radar-dial" cx="150" cy="128" r="101"/>
    ${rings}${spokes}${silhouette}${edges}${markers}
  </svg>`;
}

function showAxis(host, readings, axisKey) {
  const axis = readings.find(item => item.key === axisKey) || readings[0];
  host.dataset.activeAxis = axis.key;
  for (const control of host.querySelectorAll('.radar-axis')) {
    control.setAttribute('aria-pressed', String(control.dataset.axis === axis.key));
  }
  for (const marker of host.querySelectorAll('.radar-point, .radar-spoke')) {
    marker.classList.toggle('is-active', marker.dataset.axis === axis.key);
  }
  const fraction = axis.total ? `${axis.hits} / ${axis.total}` : '—';
  host.querySelector('.radar-value').textContent = fraction;
  host.querySelector('.radar-caption').textContent = axis.title;
  host.querySelector('.radar-sample').textContent = axis.total ? `${axis.total} 次可判定` : '暂无样本';
}

export function renderCommandRadar(host, records) {
  const active = host.contains(document.activeElement) && document.activeElement.dataset.axis;
  const readings = AXES.map(axis => measure(records, axis));
  host.innerHTML = `<div class="radar-board" role="group" aria-label="五项练习表现">
    ${radarPlot(readings)}
    ${readings.map(axis => {
      const fraction = axis.total ? `${axis.hits}/${axis.total}` : '—';
      const description = axis.total ? `${axis.hits} / ${axis.total}` : '暂无样本';
      return `<button class="radar-axis" type="button" data-axis="${axis.key}" data-samples="${axis.total}" style="--axis-x:${axis.x}%;--axis-y:${axis.y}%" aria-label="${axis.title}，${description}">
        <span>${axis.label}</span><b>${fraction}</b>
      </button>`;
    }).join('')}
  </div><div class="radar-readout" aria-live="polite" aria-atomic="true">
    <div><strong class="radar-caption"></strong><span class="radar-sample"></span></div><output class="radar-value"></output>
  </div>`;
  showAxis(host, readings, host.dataset.activeAxis);
  if (active) host.querySelector(`[data-axis="${CSS.escape(active)}"].radar-axis`)?.focus({ preventScroll: true });
  host.querySelector('.radar-board').addEventListener('click', event => {
    const button = event.target.closest('.radar-axis');
    if (button) showAxis(host, readings, button.dataset.axis);
  });
}
