import { h, openSheet, setSheetFooter, uiToast } from './core.js';
import { updateAllProviders } from './mihomo-api.js';
let task = null;

// Mount and paint first; calling an async function alone does not guarantee a paint.
function afterPaint(fn) {
  let started = false;
  const run = () => { if (started) return; started = true; clearTimeout(fallback); fn(); };
  const fallback = setTimeout(run, 200); // hidden WebView may suspend rAF
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(run, 0));
  else setTimeout(run, 0);
}

export function showUpdateAllProviders() {
  const fresh = !task;
  if (fresh) task = {
    startedAt: Date.now(),
    state: { stage: 'listing', done: 0, total: 0, ok: 0, fail: 0, detail: [], listingDone: 0, listingTotal: 2, pendingKinds: ['代理订阅', '规则订阅'] },
    listeners: new Set(),
  };
  else uiToast('更新进行中，切入进度…');
  const current = task;
  const stage = h('div', { style: 'font-size:15px;font-weight:700;margin-bottom:8px' });
  const summary = h('div', { style: 'font-size:13px;margin-bottom:10px' });
  const elapsed = h('div', { style: 'font-size:12px;color:var(--text-3);margin-bottom:10px' });
  const bar = h('div', { class: 'progress-line', role: 'progressbar', 'aria-label': '订阅更新进度', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i', { style: 'width:0%' }));
  const log = h('pre', { class: 'logbox subscription-log', hidden: true, style: 'max-height:160px;margin:12px 0 0;flex:none' });
  let timer = null;
  const detach = () => { current.listeners.delete(paint); clearInterval(timer); };
  const button = h('button', { class: 'btn block', text: '关闭', onclick: () => { detach(); close(); } });
  const content = h('div', { class: 'subscription-progress', style: 'display:flex;flex-direction:column;gap:8px;min-width:0;padding-bottom:4px' }, stage, summary, elapsed, bar, log);
  const close = openSheet('更新订阅', content);
  setSheetFooter(button);
  function paint(s) {
    if (!close.isCurrent()) { detach(); return; }
    const listing = s.stage === 'listing';
    const done = s.stage === 'done';
    stage.textContent = listing ? '正在读取运行时订阅列表…'
      : s.stage === 'refreshing' ? '订阅请求已结束，正在刷新数据…'
      : done ? (s.total ? '订阅更新结束' : s.fail ? '订阅列表读取失败' : '没有可更新的订阅') : '正在更新订阅…';
    summary.textContent = listing
      ? `列表 ${s.listingDone || 0} / ${s.listingTotal || 2} · 已发现 ${s.total} 项订阅 · 等待：${(s.pendingKinds || []).join('、') || '汇总'}`
      : `已完成 ${s.done} / ${s.total} · 成功 ${s.ok} · 失败 ${s.fail}`;
    elapsed.textContent = `已等待 ${Math.floor((Date.now() - current.startedAt) / 1000)} 秒`;
    const percent = s.total ? Math.round(s.done / s.total * 100) : 0;
    bar.classList.toggle('indeterminate', listing);
    bar.firstElementChild.style.width = `${percent}%`;
    if (listing) bar.removeAttribute('aria-valuenow');
    else bar.setAttribute('aria-valuenow', String(percent));
    log.textContent = s.detail.join('\n');
    log.hidden = s.detail.length === 0;
    if (done) clearInterval(timer);
  }
  current.listeners.add(paint);
  paint(current.state);
  // UI-only elapsed clock; it issues no HTTP/bridge requests.
  if (current.state.stage !== 'done') timer = setInterval(() => paint(current.state), 1000);
  if (fresh) afterPaint(() => {
    const publish = value => { current.state = value; current.listeners.forEach(fn => fn(value)); };
    current.promise = updateAllProviders(publish).catch(e => {
      publish({ ...current.state, stage: 'done', fail: current.state.fail + 1, detail: [...current.state.detail, '✗ ' + e.message] });
    }).finally(() => { if (task === current) task = null; });
  });
}
