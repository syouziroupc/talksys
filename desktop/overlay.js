const svg = document.getElementById('svg');
const label = document.getElementById('label');

function clearArrow() {
  svg.replaceChildren();
  label.textContent = '';
  label.classList.add('hidden');
}

function showArrow(value) {
  const x = Math.max(30, Math.min(970, Number(value?.x) || 500));
  const y = Math.max(30, Math.min(970, Number(value?.y) || 500));
  const startX = x < 500 ? Math.min(940, x + 190) : Math.max(60, x - 190);
  const startY = y < 300 ? Math.min(940, y + 160) : Math.max(60, y - 160);

  svg.innerHTML = `
    <defs>
      <marker id="head" markerWidth="42" markerHeight="42" refX="36" refY="21" orient="auto" markerUnits="userSpaceOnUse">
        <path d="M0,0 L0,42 L42,21 z" fill="#ff3b30"></path>
      </marker>
    </defs>
    <line x1="${startX}" y1="${startY}" x2="${x}" y2="${y}" stroke="#ff3b30" stroke-width="16" stroke-linecap="round" marker-end="url(#head)"></line>
    <circle cx="${x}" cy="${y}" r="34" fill="none" stroke="#ff3b30" stroke-width="13"></circle>
  `;

  label.textContent = `→ ${String(value?.label || 'ここです')}`;
  label.style.left = `${x / 10}%`;
  label.style.top = `${Math.max(90, y) / 10}%`;
  label.classList.remove('hidden');
}

if (window.overlayApi) {
  window.overlayApi.onShow(showArrow);
  window.overlayApi.onClear(clearArrow);
}

if (new URLSearchParams(location.search).get('debug') === '1') {
  document.body.classList.add('debug');
  showArrow({ x: 690, y: 460, label: 'Google Chrome アイコン（表示例）' });
}
