// Shared fold controls: same .btn.sm.circle dimensions as latency-test buttons.
let collapseSerial = 0;
export function syncCollapseButton(button, open, label = '') {
  const action = open ? '收起' : '展开';
  button.type = 'button';
  button.classList.add('btn', 'sm', 'circle', 'collapse-toggle');
  button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'}"/></svg>`;
  button.setAttribute('aria-expanded', String(!!open));
  button.setAttribute('aria-label', action + (label ? ' ' + label : ''));
  button.title = button.getAttribute('aria-label');
  if (button._collapseHead) button._collapseHead.setAttribute('aria-expanded', String(!!open));
}
export function createCollapseButton(open, onToggle, label = '') {
  const button = document.createElement('button');
  syncCollapseButton(button, open, label);
  button.onclick = event => { event.stopPropagation(); onToggle(); };
  return button;
}
export function bindCollapsibleCard(card, head, body, button, onToggle) {
  card.classList.add('collapsible-card');
  head.classList.add('collapse-card-head');
  head.tabIndex = 0;
  head.setAttribute('role', 'group');
  head.setAttribute('aria-label', (head.querySelector('h3, .proxy-group-name')?.textContent || '卡片') + '，按 Enter 或空格展开或收起');
  head.setAttribute('aria-expanded', button.getAttribute('aria-expanded'));
  if (!body.id) body.id = 'collapse-panel-' + (++collapseSerial);
  button.setAttribute('aria-controls', body.id);
  button._collapseHead = head;
  card.addEventListener('click', event => {
    const target = event.target;
    if (event.defaultPrevented || !target?.closest || target.closest('.collapsible-card') !== card) return;
    if (target.closest('button, a, input, select, textarea, label, [contenteditable], [role="button"], [role="switch"], [role="checkbox"], [data-collapse-ignore]')) return;
    // Never fold on form/list content, even if its click bubbles through the card.
    if (body.contains(target) || (target !== card && !head.contains(target))) return;
    const selection = card.ownerDocument.defaultView?.getSelection();
    if (selection && !selection.isCollapsed && card.contains(selection.anchorNode)) return;
    onToggle();
  });
  head.addEventListener('keydown', event => {
    if (event.target !== head || event.repeat || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    onToggle();
  });
}
