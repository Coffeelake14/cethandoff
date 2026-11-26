const devicePlans = {
  evidence: [[148, 17, 92, 32], [137, 12, 82, 14], [113, 9, 66, -6], [95, 7, 54, -27]],
  optics: [[150, 16, 88, 31], [130, 10, 78, 13], [87, 15, 60, -9], [71, 12, 48, -30]],
  calibration: [[157, 17, 82, 32], [141, 10, 73, 14], [111, 10, 59, -7], [82, 10, 49, -28]],
};

function mountInstrument(windowEl) {
  const plan = devicePlans[windowEl.dataset.instrument];
  const slabs = plan.map(([width, height, depth, level]) => `
    <span class="instrument-slab" style="--width:${width}px;--height:${height}px;--depth:${depth}px;--level:${level}px">
      <i class="instrument-face face-front"></i><i class="instrument-face face-side"></i><i class="instrument-face face-top"></i>
    </span>`).join('');
  windowEl.innerHTML = `<div class="instrument-scene">${slabs}<span class="instrument-lens"></span></div>`;

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  windowEl.addEventListener('pointermove', event => {
    if (reducedMotion.matches || event.pointerType !== 'mouse') return;
    const rect = windowEl.getBoundingClientRect();
    const horizontal = (event.clientX - rect.left) / rect.width - .5;
    const vertical = (event.clientY - rect.top) / rect.height - .5;
    windowEl.style.setProperty('--device-yaw', `${horizontal * 35}deg`);
    windowEl.style.setProperty('--device-pitch', `${vertical * -18}deg`);
  });
  windowEl.addEventListener('pointerleave', () => {
    windowEl.style.removeProperty('--device-yaw');
    windowEl.style.removeProperty('--device-pitch');
  });
}

export function initWorkbench() {
  document.querySelectorAll('[data-instrument]').forEach(mountInstrument);
}
