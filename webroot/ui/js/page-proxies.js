import { createCollapseButton, syncCollapseButton, bindCollapsibleCard } from './collapse-ui.js';
import { putProxy, fetchProxySnapshot, closeGroupConnections } from './mihomo-api.js';
// ============================================================
// 代理页：参考 zashboard 的代理组 / 节点面板
// 运行时数据来自 mihomo REST API；配置页仍负责编辑 YAML。
// ============================================================
import { h, state, cmdline, shell, parseJsonLoose, shq, uiToast, uiLog, note, card, badge, openSheet, closeSheet, copyText, onCoreConfigApplied } from './core.js';
import { POLICY, apiGet as executorApiGet, loadState, saveState, makeThrottledSaver } from './executor.js';

const TEST_URL = 'https://www.gstatic.com/generate_204';
const TEST_TIMEOUT = 5000;
// 批量测速使用较短的单节点超时，并在用户操作期间暂停发起下一个请求，
// 避免任何一个慢节点长期占用内核/执行桥。
const BATCH_TIMEOUT = 2000;
// 批量测速并发度：同时最多有几个节点请求在飞。
// 全量并发（几十路一起发）会把内核和执行桥一起压满，展开/滚动都跟着卡；
// 并发太低又退化成挨个测速。8 是稳的档位，想更激进就调大这个数。
const BATCH_CONCURRENCY = 8;
// 组级测速接口的总预算：内核不支持 / 进程卡住时不能一直挂着，超时就放弃走补测。
// 注意 mihomo.sh 的 api 子命令自身有 8 秒 curl 超时，这里取 7 秒先于它判定，避免竞态。
const GROUP_DELAY_BUDGET = 7000;
// 延迟多久才把胶囊刷成「测速中」。组接口常常不到 1 秒就返回，
// 立刻刷文字会闪一下，所以慢到这个阈值才给反馈。
const PENDING_HINT_MS = 400;
// mihomo 内置策略与配置页的 BUILTIN_POLICIES 保持一致；这些不是普通节点，
// 「隐藏不可用节点」不能把它们误删。

let liveData = null;
let loadedOnce = false;   // 首次 /proxies 往返是否结束（决定要不要画骨架屏）
let deadCountEl = null;   // 「隐藏不可用节点」菜单项上的数量标签（renderShell 创建）
// ⋯ 菜单的收起句柄（renderShell 每轮重建时更新）：菜单按钮挂在跨页常驻的顶栏里，
// 离开代理页 / 重挂 shell 前用它把还开着的菜单收起，摘掉 document 级监听。
let proxyMenuCloser = null;
export function closeProxyMenu() {
  if (typeof proxyMenuCloser === 'function') { try { proxyMenuCloser(); } catch (e) { /* 收起失败不阻断 */ } }
}
let providerData = null;
let providerIndexCache = new Map();
// provider（订阅）元数据加载情况。订阅节点往往不在 /proxies 里，只靠
// /providers/proxies 提供；它一失败，节点的协议类型就整片变「未知」。
let providerDiag = { ok: false, count: 0, indexed: 0, error: '' };
let liveError = '';
let loading = false;
let proxyMutationRev = 0;
const selectingGroups = new Set();
// 展开状态也落盘：浏览器刷新后该展开的组还在。
// 以前这是纯内存态 —— 管理器常驻看不出问题，浏览器一刷新全收起，
// 属于典型的「一边正常一边不正常」。
const savedOpenGroups = loadState('open-groups', []);
const openGroups = new Set((Array.isArray(savedOpenGroups) ? savedOpenGroups : []).map(String).filter(Boolean));
function setOpenGroups(names) {
  openGroups.clear();
  names.forEach(n => openGroups.add(n));
  // 展开/收起是低频操作（一次点击一个），直接写盘；节流只留给延迟那种高频写入
  saveState('open-groups', [...openGroups]);
}
// Session test results are latency samples, including 0 on failure. Never fall back
// to a previous session's positive delay when deciding whether to keep a node.
const nodeLatencyResults = new Map();
let availabilityRaf = 0;

const testing = new Set();
// 组头延迟胶囊测速（点胶囊测当前选中节点）的防重复 key：与「组名+成员名」的
// 普通 testKey 不共用命名空间，避免叶子节点恰好也是组内直属成员时互相踩锁。
function groupHeadTestKey(groupName) { return '\u0000head\u0000' + groupName; }
// 按代理组记录批量测速状态，避免页面因 provider/状态刷新重建按钮后绕过防重复锁。
const batchTestingGroups = new Set();
let allLatencyTesting = false;
let allLatencyDone = 0;
let allLatencyTotal = 0;
let allLatencyGeneration = 0;
const ALL_GROUP_CONCURRENCY = 3; // Limit group API pressure; fallback HTTP uses BATCH_CONCURRENCY.
const ALL_LATENCY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13.5 2.25-9 12h6.75l-.75 7.5 9-12h-6.75l.75-7.5Z"/></svg>';
const ALL_LATENCY_SPINNER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".2"/><path d="M12 3a9 9 0 0 1 9 9"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur=".8s" repeatCount="indefinite"/></path></svg>';
// 组头「当前：A → B」中间那枚小箭头（zashboard 的 ArrowRightCircleIcon 同语义，
// 这里用描边箭头，尺寸跟组头小字对齐，颜色跟着文字走）。
const NOW_LEAF_ARROW_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12h13"/><path d="M12.2 6.2 18 12l-5.8 5.8"/></svg>';
// disconnectOnSwitch：切换节点后断开经该组的旧连接（见 selectNode / closeGroupConnections）。
// 与截图面板保持一致默认开启；其余两项沿用原默认（关闭）。
// twoColumn：zashboard 同款「双列显示代理组」（双排布局）——组卡按左右两列交错排布，
// 展开的组移到列表顶部的整宽槽位显示节点；默认关闭，保持既有单列行为。
// showFinalOutbound：zashboard 同款「显示最终出站」——组头「当前：A」后面再跟
// 「→ 叶子节点」，把 A→B→C 这种嵌套选择链末端真正出网的节点摊开显示。
// 默认开启：这本来就是用户要的「一眼看到最终从哪个节点出去」。
const proxyPrefs = Object.assign({ hideDead: false, showIcons: false, disconnectOnSwitch: true, twoColumn: false, showFinalOutbound: true }, loadState('proxy-prefs', {}));
function saveProxyPrefs() { saveState('proxy-prefs', proxyPrefs); }
// 双排布局下「展开」弹的是一张悬浮在暗底之上的浮层卡，跟单列那种「列表内联
// 展开」完全是两回事——单列展开值得记住（刷新后原样续上，见上面 openGroups
// 的落盘注释），但双排的浮层要是也这么续，用户退出面板/刷新网页后一回到
// 代理页，什么都还没点，浮层就自己弹出来了，不像「记住了状态」，更像卡住
// 了（用户反馈的问题）。所以模块一加载（等价于刷新/重新进面板）如果当前
// 正是双排布局，就把这份展开记录清空：双排布局每次都从收起状态开始，跟
// zashboard 一样——展开是临时的 UI 动作，不是要被记住的偏好。单列模式不受
// 影响，继续保留原有的「刷新后原样恢复」。
if (proxyPrefs.twoColumn && openGroups.size) {
  openGroups.clear();
  saveState('open-groups', []);
}

// (上面整段已移入 js/executor.js)

function batchPath(path) {
  return String(path).replace('&timeout=' + TEST_TIMEOUT, '&timeout=' + BATCH_TIMEOUT);
}

let batchUserActiveUntil = 0;
function markBatchUserActivity(ev) {
  if (ev && ev.target && ev.target.closest && ev.target.closest('.proxy-batch-btn')) return;
  batchUserActiveUntil = Date.now() + 900;
}
function waitForBatchIdle() {
  const wait = Math.max(0, batchUserActiveUntil - Date.now());
  return wait ? new Promise(resolve => setTimeout(resolve, wait)) : Promise.resolve();
}
if (typeof document !== 'undefined') {
  ['pointerdown', 'touchstart', 'wheel', 'scroll'].forEach(type => {
    document.addEventListener(type, markBatchUserActivity, { capture: true, passive: true });
  });
}

// —— 命令执行一律走 executor：超时策略由它按任务性质决定，
// 每次调用都是一次独立的 HTTP 请求，无队列、无轮询。
const apiGet = (path, opts) => executorApiGet(path, opts);


function cfgProxyMap() {
  const m = new Map();
  (Array.isArray(state.cfg && state.cfg.proxies) ? state.cfg.proxies : []).forEach(p => {
    if (p && p.name) m.set(String(p.name), p);
  });
  return m;
}

function normalizeType(value) {
  const s = String(value || '').trim();
  if (!s) return '未知';
  const names = {
    Shadowsocks: 'SS', ShadowsocksR: 'SSR', Vmess: 'VMess', VMess: 'VMess', VLESS: 'VLESS',
    Trojan: 'Trojan', Hysteria: 'HY1', Hysteria2: 'HY2', Tuic: 'TUIC', TUIC: 'TUIC',
    Socks5: 'SOCKS5', SOCKS5: 'SOCKS5', HTTP: 'HTTP', WireGuard: 'WireGuard',
    Selector: '选择', URLTest: '自动测速', Fallback: '故障转移', LoadBalance: '负载均衡', Smart: 'Smart',
    Direct: 'DIRECT', Reject: 'REJECT', Pass: 'PASS', DNS: 'DNS',
    Compatible: 'COMPATIBLE',
  };
  return names[s] || s;
}

// 沿 now 链走到真正出网的那个叶子节点（A→B→C 这种嵌套代理组）。
// 带环检测：配置里出现互相引用时不能把建表卡死。
function nowLeafName(name, dict, pIndex) {
  const seen = new Set();
  let cur = String(name);
  for (let i = 0; i < 16; i++) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const node = nodeMeta(cur, dict, pIndex);
    if (!node || !node.now || node.now === node.name) return cur;
    const next = node.now;
    if (!nodeMeta(next, dict, pIndex)) return cur;
    cur = String(next);
  }
  return cur;
}

function historyDelay(apiProxy) {
  const history = Array.isArray(apiProxy?.history) ? apiProxy.history : [];
  const value = Number(history.at(-1)?.delay ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Mirrors Zashboard helper/isProxyGroup: its exemption also includes built-in
// policy types, not just objects with an `all` array.
const ZASHBOARD_RETAINED_TYPES = new Set([
  'direct', 'reject', 'rejectdrop', 'block', 'compatible', 'pass', 'passrule',
  'rematch', 'dns', 'relay', 'selector', 'fallback', 'urltest', 'smart', 'loadbalance',
]);
function retainedByZashboard(meta) {
  return !!meta && ((Array.isArray(meta.all) && meta.all.length > 0)
    || ZASHBOARD_RETAINED_TYPES.has(String(meta.type || '').toLowerCase()));
}
function latencySample(meta) {
  const history = Array.isArray(meta?.history) ? meta.history : [];
  const last = history.at(-1);
  return { signature: JSON.stringify([last?.time ?? '', last?.delay ?? null]),
    exists: !!last };
}
function latencyIdentity(name, meta) {
  return String(meta?.name || name);
}
function currentNodeDelay(name, meta) {
  const result = nodeLatencyResults.get(latencyIdentity(name, meta));
  if (result) {
    const sample = latencySample(meta);
    // Compare sample identity, never backend timestamps to the browser clock.
    // An unchanged/older snapshot must not resurrect a just-failed node.
    if (!sample.exists || sample.signature === result.before.signature) {
      return result.delay;
    }
  }
  return historyDelay(meta);
}
function recordNodeLatency(name, delay) {
  const dict = liveData?.proxies || {};
  const leaf = nowLeafName(name, dict, providerIndexCache);
  const meta = nodeMeta(leaf, dict, providerIndexCache);
  const value = Number(delay);
  nodeLatencyResults.set(latencyIdentity(leaf, meta), {
    delay: Number.isFinite(value) && value > 0 ? value : 0,
    before: latencySample(meta),
  });
  ++proxyMutationRev; // Reject reads issued before this test result.
  if (loading) softPending = true;
  bumpDataRev();
  scheduleAvailabilitySync();
}
function scheduleAvailabilitySync() {
  if (availabilityRaf || typeof document === 'undefined') return;
  availabilityRaf = requestAnimationFrame(() => {
    availabilityRaf = 0;
    syncProxyAvailability();
  });
}
function syncProxyAvailability() {
  const page = typeof document !== 'undefined' ? document.getElementById('page-proxies') : null;
  if (!page) return;
  const dict = liveData?.proxies || {};
  latencyTableFor(dict, providerIndexCache);
  const groups = [...page.querySelectorAll('.proxy-group-card')];
  groups.forEach(card => syncGroupCardNodes(card.dataset.proxyGroup));
  groups.forEach(card => card.querySelectorAll('.proxy-node').forEach(node => {
    const name = node.dataset.proxyNode;
    const meta = nodeMeta(name, dict, providerIndexCache);
    node.classList.toggle('dead', nodeIsDead(name, meta));
    const pill = node.querySelector('.proxy-latency-tag');
    const delayEl = node.querySelector('.proxy-node-delay');
    if (delayEl && !pill?.classList.contains('is-hidden')
      && !testing.has(card.dataset.proxyGroup + '\u0000' + name)
      && !batchTestingGroups.has(card.dataset.proxyGroup)) {
      setDelay(delayEl, delayValue(name, meta), { fail: nodeIsDead(name, meta) });
    }
  }));
  syncGroupDelayChips();
  groups.forEach(card => paintFinalOutbound(card));
  refreshProxyStats();
}

// ---------- 组头「当前选中节点延迟」chip ----------
// 默认布局下类型徽章后面跟一枚延迟 chip：值 = 该组 now 链叶子的延迟，与节点
// 胶囊同一口径（currentNodeDelay：本次测速样本优先，否则 API history 末条）。
// 没样本就整枚隐藏（不留空壳）；选中节点不可用显示红色感叹号；测速 / 数据刷新 /
// 换节点后由 syncProxyAvailability 与 paintSelections 各自触发更新。
function syncGroupDelayChip(card) {
  // 单列模式徽章/胶囊跟在组名后，双排模式用第三行 .proxy-group-row-delay 里的
  // 副本——两份胶囊一起同步，显隐交给 CSS 按模式切换。
  const tags = card ? [...card.querySelectorAll(':scope > .proxy-group-head .proxy-group-delaytag')] : [];
  if (!tags.length) return;
  const name = card.dataset.proxyGroup;
  // 胶囊本身就是测速入口（点它测当前选中节点，展开/收起都能点，与节点卡
  // 同款交互）：测速途中别被周期性的数据刷新顶掉「测速中」的转圈态。
  if (testing.has(groupHeadTestKey(name))) return;
  const dict = liveData?.proxies || {};
  const current = dict[name];
  // 没有选中节点就没得可显示；有选中节点时胶囊常显——未测速是闪电、
  // 不可用是红叹号、有样本是分层着色的数字，全部与单节点卡片同口径同样式。
  const leaf = current && current.now ? nowLeafName(name, dict, providerIndexCache) : null;
  const meta = leaf ? nodeMeta(leaf, dict, providerIndexCache) : null;
  const canTest = !!leaf && isProxySpeedTestable(leaf, meta);
  tags.forEach(tag => {
    const inner = tag.querySelector('.proxy-node-delay');
    if (!current || !current.now) { tag.hidden = true; return; }
    tag.hidden = false;
    tag.disabled = !canTest;
    tag.title = !canTest ? '' : '点击测速当前选中节点';
    if (inner) setDelay(inner, currentNodeDelay(leaf, meta), { fail: nodeIsDead(leaf, meta) });
  });
}
function syncGroupDelayChips() {
  const page = typeof document !== 'undefined' ? document.getElementById('page-proxies') : null;
  if (!page) return;
  page.querySelectorAll('.proxy-group-card').forEach(syncGroupDelayChip);
}

// ---------- 组头「最终出站」（zashboard「显示最终出站」） ----------
// 组头第二行是「当前：A」；A 自己还是代理组时，再跟「→ 叶子」把 A→B→C 这条
// 选择链末端真正出网的节点摊开。叶子口径与延迟胶囊完全一致（nowLeafName）。
// now 本身就是叶子时整段隐藏，避免「当前：香港 01 → 香港 01」这种重复信息。
function paintFinalOutbound(card, dict) {
  const row = card && card.querySelector(':scope > .proxy-group-head > .proxy-group-now');
  // 注意：最终出站段现在嵌在滚动用的 .proxy-group-now-text 里（与「当前」同名段
  // 同住一个 clip，保证永远单行），所以这里不能再用 :scope > 直接子选择器。
  const box = row && row.querySelector('.proxy-group-now-leaf');
  if (!box) return;
  const map = dict && typeof dict === 'object' ? dict : (liveData?.proxies || {});
  const name = card.dataset.proxyGroup;
  const node = map[name];
  const cur = node && node.now ? String(node.now) : '';
  const leaf = cur ? String(nowLeafName(name, map, providerIndexCache)) : '';
  const show = !!proxyPrefs.showFinalOutbound && !!cur && !!leaf && leaf !== cur;
  const value = show ? leaf : '';
  const changed = box._leaf !== value;
  box.hidden = !show;
  // 悬停看整条链：窄屏/双排下文字会被省略号截断，title 里始终是完整路径
  if (cur) {
    const path = nowChainNames(name, map);
    if (path[path.length - 1] !== leaf) path.push(leaf);
    row.title = path.join(' → ');
  } else {
    row.title = '';
  }
  if (!changed) return;   // 叶子没变：不重写文本、不重量宽度（这里被高频调用）
  box._leaf = value;
  const txt = box.querySelector('.proxy-group-now-leaf-text');
  if (txt) txt.textContent = value;
  // 多了一段 / 少了一段，整段的宽度变了：按新内容重测跑马灯
  refreshNowMarquee(row.querySelector(':scope > .proxy-group-now-clip'));
}

// 全局模式的组卡集合跟着 GLOBAL 的选择链走：在 GLOBAL 卡片里改选了另一个组，
// 链上会多出 / 少掉一张组卡。
//
// 两条硬约束（都是「展开的卡片一切换节点就闪」的根因，别再改回去）：
//   1) 判断「集合有没有变」必须按 **集合**，不能按 DOM 顺序比：
//      双排布局把卡片交错分进左右两列，展开的那张还被搬进了页尾的浮层容器，
//      DOM 顺序永远不等于链序 —— 按顺序比会让每一次选中变化（哪怕只是换个
//      叶子节点）都判成「变了」→ 整页重绘 → 浮层里的卡片重建一次 = 肉眼可见的一闪。
//   2) 集合真的变了也**不整页重绘**：只补缺、只摘多余的卡片，其余卡片连同
//      它们已挂载的节点、滚动位置、展开态原样复用，然后按链序把 DOM 挪回位置。
//      整页重绘会把浮层卡从浮层里摘出来再塞回去，同样会闪一下。
function syncGlobalChainCards(page) {
  if (!page || proxyMode() !== 'global') return;
  const groups = liveGroups(liveData);
  if (!groups.length) return;
  const order = groups.map(g => g.name);
  const want = new Set(order);
  const dict = (liveData && liveData.proxies) || {};
  const modal = page.querySelector(':scope > .proxy-modal');
  const modalCard = modal ? modal.querySelector('.proxy-group-card') : null;
  const cards = new Map();
  page.querySelectorAll('.proxy-group-card').forEach(c => {
    if (c.dataset.proxyGroup) cards.set(c.dataset.proxyGroup, c);
  });
  if (cards.size === want.size && order.every(n => cards.has(n))) return;

  // 1) 摘掉已经不在链上的卡片；摘的要是浮层里那张，浮层一起收掉
  let closedOpenCard = false;
  cards.forEach((card, name) => {
    if (want.has(name)) return;
    if (card === modalCard) closedOpenCard = true;
    if (card._dualMarker && card._dualMarker.isConnected) card._dualMarker.remove();
    card.remove();
    cards.delete(name);
  });
  // 展开记录跟着集合走：离开链的组不该继续记着「展开」（单列内联展开同理）
  const stillOpen = [...openGroups].filter(n => want.has(n));
  if (stillOpen.length !== openGroups.size) setOpenGroups(stillOpen);
  if (closedOpenCard && modal) { modal.hidden = true; syncProxyModalLock(modal); }

  // 2) 补上链上新增的组卡（懒挂载：收起的组只建组头，展开时才建节点）
  order.forEach(name => {
    if (cards.has(name)) return;
    const group = groups.find(g => g.name === name);
    if (group) cards.set(name, groupCard(group, dict, providerIndexCache));
  });

  // 3) 按链序摆放：只挪已有 DOM（浮层里那张挪的是它留在列里的占位），不重建
  const body = page.querySelector('.proxy-groups');
  if (!body) return;
  const cols = body.classList.contains('dual') ? body.querySelector('.proxy-groups-cols') : null;
  const slots = order.map(name => {
    const card = cards.get(name);
    if (!card) return null;
    return (card === modalCard && card._dualMarker && card._dualMarker.isConnected)
      ? card._dualMarker : card;
  }).filter(Boolean);
  if (cols && cols.children.length >= 2) {
    const [colA, colB] = cols.children;
    slots.forEach((el, i) => (i % 2 ? colB : colA).append(el));
  } else {
    slots.forEach(el => body.append(el));
  }
}

// ---------------------------------------------------------------
// 全局延迟表（照 zashboard 的 latencyMap 思路）
//
// 以前每张卡片各自解析一次 history，还要自己顺着 now 链找叶子；几百个节点
// 时同一批节点被重复解析上百遍。改成建一张覆盖全部节点的表：一趟 O(节点数)
// 建好，之后卡片/排序/筛选/计数都 O(1) 查表，延迟口径也只有这一个来源。
//
// 表是内存态的，随 API 数据和本次测速样本一起重建，不读取跨会话正延迟缓存。
// ---------------------------------------------------------------
let latencyTable = new Map();       // 节点名 → 延迟（查不到就不放进表里）
let latencyTableRev = -1;           // 建表时所依据的数据代数（-1 = 还没建过）
// 数据代数：liveData 或 provider 索引一变就 +1，作为表是否需要重建的唯一依据。
let dataRev = 0;
function bumpDataRev() { dataRev++; }
function latencyTableFor(dict, pIndex) {
  if (latencyTableRev === dataRev) return latencyTable;
  latencyTableRev = dataRev;
  buildMetaIndex(dict, pIndex);
  const t = new Map();
  // 遍历 metaIndex 而不是只遍历 dict：订阅节点通常不在 /proxies 里，
  // 只按 dict 建表会让它们的延迟永远查不到（卡片只剩闪电图标）。
  // metaIndex 已同时收录 /proxies 与 provider 两种来源、两种名字写法。
  metaIndex.forEach((_v, name) => {
    // 代理组的延迟 = 它当前选中叶子节点的延迟（与 zashboard 一致）
    const leaf = nowLeafName(name, dict, pIndex);
    const n = currentNodeDelay(leaf, nodeMeta(leaf, dict, pIndex));
    if (n != null) t.set(name, n);
  });
  latencyTable = t;
  return t;
}
function tableDelay(name) {
  const v = latencyTable.get(name);
  if (Number.isFinite(v) && v > 0) return v;
  // 延迟表的键来自 /proxies（纯名字），卡片拿到的可能是带 provider 前缀的写法
  const bare = bareNodeName(name);
  if (bare) {
    const b = latencyTable.get(bare);
    if (Number.isFinite(b) && b > 0) return b;
  }
  return null;
}

// Display, filtering and statistics use this same current latency sample.
function delayValue(name, apiProxy) {
  if (apiProxy?.now) {
    const dict = liveData?.proxies || {};
    const leaf = nowLeafName(name, dict, providerIndexCache);
    return currentNodeDelay(leaf, nodeMeta(leaf, dict, providerIndexCache) || apiProxy);
  }
  return currentNodeDelay(name, apiProxy);
}

// 与 zashboard 默认设置一致：低于 400ms 绿色，400–799ms 黄色，800ms 及以上红色。
function latencyClass(n) {
  if (!Number.isFinite(Number(n)) || Number(n) <= 0) return '';
  if (Number(n) < 400) return 'proxy-delay-low';
  if (Number(n) < 800) return 'proxy-delay-medium';
  return 'proxy-delay-high';
}
// 延迟胶囊的三态，与 zashboard 的 LatencyTag 对齐：
//   数值（按阈值着色）/ 测速中（跳动三个点）/ 空（闪电，未测速）/ 失败（叹号）
// 胶囊只有 40px 宽，所以这里不再写「未测速」「N ms」这类长文本。
// 按「代理组 + 节点名」在当前 DOM 里现找延迟胶囊。
//
// 测速期间页面可能整体重绘（切页、provider 数据补齐都会重建卡片），
// 手里那个 delayEl 会变成已从文档摘下的孤儿节点：结果写进去看不见，
// 用户看到的就是「点了没反应 / 测速失败」。写回前一律先现找一次。
// 用 dataset 逐个比对而不是拼选择器，节点名里的引号、斜杠都不会破坏匹配。
function liveNodeEl(groupName, nodeName) {
  const page = typeof document !== 'undefined' ? document.getElementById('page-proxies') : null;
  if (!page) return null;
  const cards = page.querySelectorAll('.proxy-group-card');
  for (const card of cards) {
    if (card.dataset.proxyGroup !== groupName) continue;
    const nodes = card.querySelectorAll('.proxy-node');
    for (const node of nodes) {
      if (node.dataset.proxyNode === nodeName) return node;
    }
  }
  return null;
}

function liveDelayEl(groupName, nodeName) {
  const node = liveNodeEl(groupName, nodeName);
  return node ? node.querySelector('.proxy-node-delay') : null;
}

function livePillEl(groupName, nodeName) {
  const node = liveNodeEl(groupName, nodeName);
  return node ? node.querySelector('.proxy-latency-tag') : null;
}

function setDelay(el, n, opts = {}) {
  el.classList.remove('proxy-delay-low', 'proxy-delay-medium', 'proxy-delay-high',
    'is-loading', 'is-empty', 'is-fail', 'is-hidden');
  if (opts.hidden) { el.textContent = ''; return; }
  if (opts.loading) { el.classList.add('is-loading'); el.textContent = ''; return; }
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) {
    el.classList.add(opts.fail ? 'is-fail' : 'is-empty');
    el.textContent = opts.fail ? '!' : '';
    return;
  }
  const cls = latencyClass(v);
  if (cls) el.classList.add(cls);
  el.textContent = String(Math.round(v));
}

// /providers/proxies 返回的是 provider → proxies 数组；provider 节点通常不在
// state.cfg.proxies 里，因此这里补一份运行时节点元数据，用于协议类型和 provider 测速接口。
function providerProxyMap(obj) {
  const index = new Map();
  const providers = obj && obj.providers && typeof obj.providers === 'object' ? obj.providers : {};
  Object.entries(providers).forEach(([providerName, provider]) => {
    const raw = provider && provider.proxies;
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
    list.forEach(proxy => {
      if (!proxy || !proxy.name) return;
      const p = Object.assign({}, proxy, { _providerName: String(providerName) });
      const name = String(proxy.name);
      index.set(name, p);
      index.set(String(providerName) + '/' + name, p);
    });
  });
  return index;
}

// 全量 /providers/proxies 取不到时的降级路径：按配置里声明的订阅逐个拉。
// 单次响应只含一个订阅的节点，体积比全量小一个量级，CGI 桥更容易扛住；
// 就算某个订阅单独失败，其余订阅的节点类型仍然正常，不会整片变「未知」。
async function loadProvidersOneByOne() {
  const cfg = state.cfg || {};
  const names = Object.keys(cfg['proxy-providers'] || {});
  if (!names.length) return null;
  const merged = { providers: {} };
  let bytes = 0;
  for (const n of names) {
    let r = null, j = null;
    // 单个订阅也重试一次：一次偶发的桥超时不该让整页缺类型
    for (let i = 0; i < 2 && !j; i++) {
      try {
        r = await apiGet('/providers/proxies/' + encodeURIComponent(n), { big: true, trim: true });
        j = parseJsonLoose(r && r.stdout);
      } catch (e) { j = null; }
    }
    const pr = j && j.proxies;
    if (pr && (Array.isArray(pr) || typeof pr === 'object')) {
      merged.providers[n] = j;
      bytes += ((r && r.stdout) || '').length;
    }
  }
  if (!Object.keys(merged.providers).length) return null;
  merged._bytes = bytes;
  return merged;
}

// 去掉「provider名/」前缀后的裸名字（"免流订阅/香港 01" → "香港 01"）
function bareNodeName(name) {
  const s = String(name);
  const i = s.indexOf('/');
  return i > 0 ? s.slice(i + 1) : '';
}

// 优先用 /proxies 的完整运行时对象；provider API 作为 provider 节点的补充。
//
// 为什么还要按裸名字回退：代理组的 all / now 里有时是「provider名/节点名」的
// 形式，而 /proxies 的键是纯节点名。两边写法对不上时 dict[name] 直接落空，
// 节点类型就退成「未知」—— provider 元数据再一缺失就整片未知。
// provider 索引已同时存两种键，这里主要补 /proxies 这一侧。
// 名字 → 运行时对象的统一索引（同时收录「原名」与「去掉 provider 前缀后的裸名」）。
//
// 为什么需要：订阅节点在组里常写成「provider名/节点名」，而 /proxies 与
// provider 接口的键写法不统一。逐个试匹配既慢又容易漏，这里一次性建索引，
// 之后所有查询都是 O(1)，且两种写法都能命中。
let metaIndex = new Map();
let metaIndexRev = -1;
function buildMetaIndex(dict, pIndex) {
  if (metaIndexRev === dataRev) return;
  metaIndexRev = dataRev;
  const m = new Map();
  const put = (key, v) => {
    if (!v) return;
    if (!m.has(key)) m.set(key, v);
    const bare = bareNodeName(key);
    if (bare && !m.has(bare)) m.set(bare, v);
  };
  if (dict) Object.keys(dict).forEach(k => put(k, dict[k]));
  if (pIndex && pIndex.size) pIndex.forEach((v, k) => put(k, v));
  metaIndex = m;
}

function nodeMeta(name, dict, pIndex) {
  if (dict && dict[name]) return dict[name];
  if (pIndex && pIndex.get(name)) return pIndex.get(name);
  const bare = bareNodeName(name);
  if (bare) {
    if (dict && dict[bare]) return dict[bare];
    if (pIndex && pIndex.get(bare)) return pIndex.get(bare);
  }
  buildMetaIndex(dict, pIndex);
  return metaIndex.get(name) || (bare ? metaIndex.get(bare) : null) || null;
}

function proxyType(name, apiProxy, cfgMap, pIndex) {
  if (apiProxy && Array.isArray(apiProxy.all)) return '代理组';
  let p = apiProxy || (pIndex && pIndex.get(name));
  // provider 索引的键有「简名」和「provider/简名」两种写法，直接按简名查不到时
  // 再扫一遍后缀匹配：订阅节点的协议类型靠这条路兜回来，否则一律显示「未知」。
  if ((!p || !p.type) && pIndex && pIndex.size) {
    const suffix = '/' + String(name);
    for (const [k, v] of pIndex) {
      if (v && v.type && (k === name || k.endsWith(suffix))) { p = v; break; }
    }
  }
  return normalizeType((p && p.type) || (cfgMap.get(name) && cfgMap.get(name).type));
}

// 当前运行模式（小写）。status 来自内核 /configs，读不到时退回配置里的 mode。
function proxyMode() {
  return String(state.status?.mode || state.cfg?.mode || 'rule').toLowerCase();
}

// 从 name 出发的「当前选择链」（与 zashboard 的 getProxyGroupChains 同口径）：
// 只要 now 指向的还是一枚代理组（有 all 数组）就继续往下走，直到末端叶子节点。
// 链里只会有代理组，最后一个元素是「倒数第二跳」——叶子本身不在链上。
// 带环检测与长度上限：配置里互相引用时不能把渲染卡死。
const MAX_NOW_CHAIN = 16;
function nowChainNames(name, dict) {
  const names = [];
  const seen = new Set();
  let cur = String(name || '');
  while (cur && !seen.has(cur) && names.length < MAX_NOW_CHAIN) {
    const node = dict && dict[cur];
    if (!node || typeof node !== 'object') break;
    seen.add(cur);
    names.push(cur);
    const next = node.now ? String(node.now) : '';
    if (!next || next === cur) break;
    const nextNode = dict[next];
    if (!nextNode || !Array.isArray(nextNode.all)) break;   // 下一跳是叶子节点：链到此为止
    cur = next;
  }
  return names;
}

function liveGroups(obj) {
  const dict = obj && obj.proxies && typeof obj.proxies === 'object' ? obj.proxies : {};
  const cfgMap = cfgProxyMap();
  const groups = [];
  Object.entries(dict).forEach(([name, p]) => {
    if (!p || !Array.isArray(p.all)) return;
    groups.push({
      name,
      type: normalizeType(p.type),
      now: p.now || '',
      all: p.all.filter(x => x != null).map(String),
      api: p,
      live: true,
      cfg: null,
      cfgMap,
    });
  });
  // 有些旧内核/异常响应不会把代理组的 all 返回出来，用配置作可用的降级列表。
  if (!groups.length) {
    const raw = Array.isArray(state.cfg && state.cfg['proxy-groups']) ? state.cfg['proxy-groups'] : [];
    raw.forEach(g => {
      if (!g || !g.name) return;
      const all = [];
      (Array.isArray(g.proxies) ? g.proxies : []).forEach(x => { if (x != null) all.push(String(x)); });
      groups.push({ name: String(g.name), type: normalizeType(g.type), now: '', all, api: null, live: false, cfg: g, cfgMap });
    });
  }
  // 运行时 /proxies 对象的键顺序不是用户配置顺序；先按 config.proxy-groups，
  // 再把 API 额外返回的内置组放在末尾。
  const order = new Map();
  const cfgGroups = Array.isArray(state.cfg && state.cfg['proxy-groups']) ? state.cfg['proxy-groups'] : [];
  cfgGroups.forEach((g, i) => { if (g && g.name != null) order.set(String(g.name), i); });
  // 全局模式的可见组 = GLOBAL 自己的那条选择链：GLOBAL → 它当前选中的代理组 →
  // 那个组当前选中的代理组……（zashboard 的 getProxyGroupChains(GLOBAL) 同款）。
  // mihomo 的 GLOBAL 组 all 里既有全部节点也有全部代理组：在 GLOBAL 卡片里选中
  // 某个组之后，必须把这个组自己的卡片也摆出来，否则它的成员无处可选——表现
  // 就是「全局模式里选了个组，却看不到这个组」。
  const mode = proxyMode();
  if (mode === 'global') {
    const chain = nowChainNames('GLOBAL', dict);
    const byName = new Map(groups.map(g => [g.name, g]));
    const chained = chain.map(n => byName.get(n)).filter(Boolean);
    // 链序即渲染序（GLOBAL 在最前，后面是被选中的组），不能再按配置顺序重排，
    // 否则「当前在走的链路」会被打散成一堆不相干的卡片。
    if (chained.length) return chained;
    // 配置预览等拿不到 GLOBAL 运行态时，退回「只显示 GLOBAL」。
    return groups.filter(g => g.name === 'GLOBAL');
  }
  const visibleGroups = groups.filter(g => (mode === 'rule' || mode === 'direct') ? g.name !== 'GLOBAL' : true);
  return visibleGroups.sort((a, b) => {
    const ai = order.has(a.name) ? order.get(a.name) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b.name) ? order.get(b.name) : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

function renderShell(el) {
  // 顶栏那三个按钮跨页常驻：重挂 shell 前先收起上一轮可能还开着的 ⋯ 菜单，
  // 摘掉它挂在 document 上的 pointerdown/keydown 监听。
  closeProxyMenu();
  el.innerHTML = '';
  // 「显示图标 / 隐藏不可用节点」等筛选收进一个 ⋯ 按钮：点按钮弹出可勾选菜单
  //（形态参考截图：单按钮 + 打勾的选项列表），再加「双列代理组」「切换节点断开连接」。
  // ⋯ 菜单与「测速所有节点」「节点匹配诊断」三个按钮挂在顶栏（appbar）的
  // 专用容器 #appbarProxyActions 里，仅停留在代理页时显示（app.js showPage 控制）。
  deadCountEl = h('span', { class: 'badge proxy-filter-count', text: '0', hidden: true });
  const menuWrap = h('div', { class: 'proxy-menu-wrap' });
  const menu = h('div', { class: 'proxy-menu', role: 'menu', hidden: true });
  const menuBtn = h('button', {
    class: 'proxy-menu-btn', type: 'button', title: '显示选项',
    'aria-haspopup': 'true', 'aria-expanded': 'false',
    html: '<svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.65"/><circle cx="8" cy="8" r="1.65"/><circle cx="13" cy="8" r="1.65"/></svg>',
  });
  // 诊断按钮与配置源码弹窗里的一致（btn sm circle + 脉搏图标）：代理页的
  // 诊断内容仍是节点匹配诊断（showMetaDiag），只是入口从「点统计行」换成
  // 这个明摆着的按钮，放在 ⋯ 菜单按钮左边。
  const testAllBtn = h('button', {
    type: 'button', class: 'btn sm circle proxy-test-all-btn',
    title: '测速所有节点', 'aria-label': '测速所有节点',
    html: ALL_LATENCY_ICON, onclick: () => testAllNodes(),
  });
  const diagBtn = h('button', {
    class: 'btn sm circle', title: '节点匹配诊断', 'aria-label': '节点匹配诊断',
    html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2 7 4-14 2 7h6"/></svg>',
    onclick: () => showMetaDiag(),
  });
  const onDocDown = (ev) => { if (!menu.hidden && !menuWrap.contains(ev.target)) closeMenu(); };
  const onDocKey = (ev) => {
    if (ev.key === 'Escape' && !menu.hidden) { closeMenu(); menuBtn.focus(); }
  };
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  }
  function openMenu() {
    menu.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
  }
  // 三个功能按钮挂在顶栏容器里，容器跨页面常驻：切到别的页时按钮被隐藏但 DOM 还在，
  // 菜单若仍开着，document 上的 pointerdown/keydown 监听就永远摘不掉。所以离开代理页
  // 时由 app.js 调 closeProxyMenu() 就地收起（句柄即上面赋值的 proxyMenuCloser）。
  proxyMenuCloser = closeMenu;
  menuBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  const CHECK_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.4l3.3 3.3L13 4.9"/></svg>';
  const addMenuItem = (key, label, trailing, onChange) => {
    const check = h('span', { class: 'proxy-menu-check', html: CHECK_SVG });
    const item = h('button', { class: 'proxy-menu-item', type: 'button', role: 'menuitemcheckbox' },
      h('span', { class: 'proxy-menu-label', text: label }), trailing || null, check);
    const sync = () => {
      const on = !!proxyPrefs[key];
      item.classList.toggle('on', on);
      item.setAttribute('aria-checked', on ? 'true' : 'false');
      check.hidden = !on;
    };
    // 点选不关菜单：可以连续勾/取消多项，再点 ⋯ 或菜单外任意处才收起。
    item.addEventListener('click', () => {
      proxyPrefs[key] = !proxyPrefs[key];
      saveProxyPrefs();
      sync();
      if (onChange) onChange();
    });
    sync();
    menu.append(item);
  };
  addMenuItem('showIcons', '显示图标', null, () => renderProxyData(el));
  // zashboard 同款「显示最终出站」：组头「当前：A」后面再跟「→ 叶子节点」，
  // 组里套组时一眼看出真正从哪个节点出去。
  addMenuItem('showFinalOutbound', '显示最终出站', null, () => renderProxyData(el));
  // 不可用节点数挂在「隐藏不可用节点」项上：勾上后被筛掉多少节点一眼可见。
  // 始终统计全部展示组，跨组/别名按既有节点身份去重。
  addMenuItem('hideDead', '隐藏不可用节点', deadCountEl, () => renderProxyData(el));
  addMenuItem('groupByProvider', '按提供商分组', null, () => renderProxyData(el));
  // 双列代理组：zashboard 同款「双列显示代理组」。组卡按左右两列交错排布，
  // 展开的组进居中浮层（zashboard 移动端 modal 同款），收起后原位放回。
  // 从单列切到双列时同理清掉展开记录（见模块顶部注释）：单列的「内联展开」
  // 和双列的「弹浮层」不是一回事，切过去不该让浮层凭空弹出来。
  // 排在「按提供商分组」下面：它只改组卡的摆法，跟着分组项一起属于「布局」，
  // 与上面几项「显示什么」的筛选类选项分开。
  addMenuItem('twoColumn', '双列代理组', null, () => {
    if (proxyPrefs.twoColumn && openGroups.size) { openGroups.clear(); saveState('open-groups', []); }
    renderProxyData(el);
  });
  addMenuItem('disconnectOnSwitch', '切换节点断开连接', null, null);
  menuWrap.append(menuBtn, menu);
  // 三个功能按钮不再占页面工具栏，统一挂到顶栏的代理页专用容器；
  // 容器由 app.js showPage 按当前页控制显隐（仅代理页可见）。
  // 顶栏容器缺失时（异常 DOM）退回页面工具栏右侧，功能不丢。
  const slot = typeof document !== 'undefined' ? document.getElementById('appbarProxyActions') : null;
  const toolbar = h('div', { class: 'proxy-toolbar' }, h('div', { class: 'proxy-summary' }));
  if (slot) {
    slot.innerHTML = '';
    slot.append(testAllBtn, diagBtn, menuWrap);
  } else {
    toolbar.append(h('div', { class: 'proxy-toolbar-right' }, testAllBtn, diagBtn, menuWrap));
  }
  el.append(toolbar, h('div', { class: 'proxy-groups' }));
  syncAllLatencyButtons();
}

// 占位卡片：只在首次读取期间出现，结构刻意做轻（收起的组本来也不建节点卡）
function skeletonGroup(nodeCount) {
  const grid = h('div', { class: 'proxy-node-grid' });
  for (let i = 0; i < nodeCount; i++) {
    grid.append(h('div', { class: 'proxy-node is-skeleton' },
      h('i', { class: 'sk sk-line' }),
      h('i', { class: 'sk sk-foot' })));
  }
  const c = card();
  c.classList.add('proxy-group-card', 'is-skeleton');
  c.append(
    h('div', { class: 'proxy-group-head' },
      h('div', { class: 'proxy-group-head-sk' },
        h('i', { class: 'sk sk-title' }), h('i', { class: 'sk sk-sub' }))),
    h('div', { class: 'proxy-node-body' }, grid));
  return c;
}

// ---------- 双排布局（zashboard 同款「双列显示代理组」） ----------
// 组卡按序左右两列交错排布；展开就在卡片原位展开（节点网格在窄列内单列排布），
// 不做任何搬运——列内顺序、滚动位置、懒挂载进度全部保持原样。
function appendDualScaffold(body) {
  body.classList.add('dual');
  const cols = h('div', { class: 'proxy-groups-cols' },
    h('div', { class: 'proxy-col' }), h('div', { class: 'proxy-col' }));
  body.append(cols);
  return cols;
}

// ---------- 双排布局的展开浮层（zashboard 移动端 modal 同款） ----------
// 双排里点组不在列内原地撑开：整张组卡移进居中的暗底浮层（宽 = 视口 − 两侧留白），
// 点暗底或卡内收起钮关闭并原位放回——交互与 ⋯ 菜单一致（点外面即收）。
// 浮层挂在 #page-proxies 内部：页面级查询（延迟同步 / 选中同步 / 批量测速 /
// paintSelections）照旧覆盖浮层里那张卡，不需要第二套同步逻辑。
function ensureProxyModal(pageEl) {
  let modal = pageEl.querySelector(':scope > .proxy-modal');
  if (!modal) {
    const host = h('div', { class: 'proxy-modal-body' });
    modal = h('div', { class: 'proxy-modal', hidden: true }, host);
    modal.addEventListener('click', ev => {
      if (ev.target !== modal) return;                      // 只认暗底本身
      const card = host.querySelector('.proxy-group-card');
      if (card && card._toggleOpen) card._toggleOpen();     // 点暗底 = 收起该组
    });
    pageEl.append(modal);
  }
  return modal;
}

// 浮层开着时锁住背景页滚动（暗底铺满视口，手势不该再滚后面的列表）。
// 根因排查：原来只给 html/body 切 overflow:hidden——这步本身不会把
// scrollTop 归零，只是冻结在原处；但顶栏 .appbar 是 position:sticky，
// sticky 的「贴顶」是靠它所在的滚动容器正在滚动来维持的。html 一旦变成
// overflow:hidden（不再是「正在滚动」的容器），sticky 直接退化成按文档流
// 原位摆放——而这时 scrollTop 还冻结在用户之前往下滚的那个值上，于是顶栏
// 的视口坐标变成「文档流原位 − 冻结的 scrollTop」，往上飞出屏幕，看起来
// 就是导航栏整个消失了（只要用户是在列表往下滚过一段之后再展开组，必现）。
// 用 Playwright 在真实 Chromium 里量过：scrollY=300 时点开组卡，
// .appbar 的 getBoundingClientRect().top 直接变成 -300。
// 修法：锁的时候把顶栏显式钉成 position:fixed（不再依赖 sticky 的滚动容器
// 判定），钉的位置/宽度量的是它锁之前的真实像素位置，不会因为居中最大宽度
// 布局而跑版；同时给 #pages 补一段等于顶栏高度的 marginTop 占住它让出的
// 文档流空间，背后内容的视觉位置分毫不差。关闭时原样拆除。
function syncProxyModalLock(modal) {
  const shouldLock = !!modal && !modal.hidden;
  const html = document.documentElement;
  const appbar = document.getElementById('appbar');
  const pages = document.getElementById('pages');
  const isLocked = html.classList.contains('proxy-modal-open');
  if (shouldLock && !isLocked) {
    if (appbar) {
      const rect = appbar.getBoundingClientRect();
      appbar.style.position = 'fixed';
      appbar.style.top = '0';
      appbar.style.left = `${rect.left}px`;
      appbar.style.width = `${rect.width}px`;
      if (pages) pages.style.marginTop = `${rect.height}px`;
    }
    html.classList.add('proxy-modal-open');
  } else if (!shouldLock && isLocked) {
    html.classList.remove('proxy-modal-open');
    if (appbar) {
      appbar.style.position = '';
      appbar.style.top = '';
      appbar.style.left = '';
      appbar.style.width = '';
    }
    if (pages) pages.style.marginTop = '';
  }
}

function moveCardToModal(card, pageEl) {
  if (!card || !pageEl) return;
  const modal = ensureProxyModal(pageEl);
  const host = modal.querySelector('.proxy-modal-body');
  if (card.parentElement !== host) {
    // 占位元素记住列内原位置，关闭时原位放回。占位高度量的是「收起态」
    // 紧凑卡的高度（量之前临时把节点区藏起来，量完立刻还原，同一拍内
    // 完成，不会闪）——这样卡片搬进浮层后，原来的位置留一个一样高的
    // 空当，下面的卡片不会跟着「补位」网上挤；跟 zashboard 一样，展开
    // 只是盖一层浮层，身后的两列列表位置纹丝不动。
    if (!card._dualMarker || !card._dualMarker.isConnected) {
      const bodyEl = card.querySelector(':scope > .proxy-node-body');
      const prevHidden = bodyEl ? bodyEl.hidden : null;
      if (bodyEl) bodyEl.hidden = true;
      const collapsedHeight = card.getBoundingClientRect().height;
      if (bodyEl) bodyEl.hidden = prevHidden;
      card._dualMarker = h('div', {
        class: 'proxy-col-placeholder',
        style: collapsedHeight > 0 ? `height:${collapsedHeight}px` : '',
      });
      card.before(card._dualMarker);
    }
    host.append(card);
  }
  modal.hidden = false;
  syncProxyModalLock(modal);
  // 窄列搬进整宽浮层后卡片变宽了：「当前节点」之前按窄列宽度量过的跑马灯
  // 状态要重新量一次，否则哪怕名字在浮层里已经放得下，还会一直跑马灯滚动。
  refreshCardNowMarquee(card);
}

// 浮层里的卡全部原位放回；空了就把暗底收掉
function dismissProxyModalCards() {
  const pageEl = document.getElementById('page-proxies');
  const modal = pageEl && pageEl.querySelector(':scope > .proxy-modal');
  if (!modal) return;
  [...modal.querySelectorAll('.proxy-group-card')].forEach(card => {
    const marker = card._dualMarker;
    if (marker && marker.isConnected) { marker.replaceWith(card); card._dualMarker = null; }
    else card.remove();   // 标记随旧 body 一起被销毁：这张卡已是弃件
    // 放回窄列后卡片变窄了，同样要重新量一次跑马灯状态（浮层里量出的「不用滚」
    // 回到窄列可能又装不下了，反之亦然）。
    refreshCardNowMarquee(card);
  });
  modal.hidden = true;
  syncProxyModalLock(modal);
}

// 离开代理页：浮层关闭且清掉展开态——再进来是干净的两列紧凑列表（zashboard 行为）
export function closeProxyModal() {
  const pageEl = document.getElementById('page-proxies');
  const modal = pageEl && pageEl.querySelector(':scope > .proxy-modal');
  if (!modal) return;
  [...modal.querySelectorAll('.proxy-group-card')].forEach(card => {
    const marker = card._dualMarker;
    if (marker && marker.isConnected) { marker.replaceWith(card); card._dualMarker = null; }
    else if (card.closest('.proxy-modal-body')) card.remove();
    refreshCardNowMarquee(card);
    const name = card.dataset.proxyGroup;

    if (openGroups.has(name)) {
      setOpenGroups([]);
      const body = card.querySelector('.proxy-node-body');
      if (body) body.hidden = true;
      const btn = card.querySelector('.proxy-group-toggle');
      if (btn) syncCollapseButton(btn, false, name);
      card.classList.remove('is-open');
    }
  });
  modal.hidden = true;
  syncProxyModalLock(modal);
}

// 会自动改选节点的代理组类型（内核侧 type）。测速会触发它们重新挑选节点，
// 前端必须回读一次，否则「选中态」一直停在旧值上。
const AUTO_SELECT_TYPES = new Set(['url-test', 'urltest', 'fallback']);
function groupAutoSelects(group) {
  return AUTO_SELECT_TYPES.has(speedTestGroupType(group));
}

// 测速后回读一次 /proxies，把内核改过的 now（选中节点）刷新到卡片上。
//
// 为什么需要：URLTest / Fallback 这类组在测速时会重新挑选节点，内核侧的 now
// 已经变了；但前端只是把延迟写回胶囊，不会重拉列表，于是「选中蓝框」还停在
// 测速前的那个节点上 —— 表现就是「测完不回退到第一个节点，重进/刷新才对」。
//
// 只拉 /proxies（不拉 provider），一次请求；失败就静默放弃，不影响已显示的延迟。
let selectionRefreshing = false;
// 采纳新的 /proxies 数据：同 PID 合并，不同 PID 整体替换。
//
// 合并是「一测速节点类型就全变未知」的根治点。回读时如果只拿到不完整响应
// （大响应超时被截断、CGI 回传不全等），parseJsonLoose 的修复逻辑仍会解析
// 出一个 proxies 字段存在但键不全的对象；整体替换就会把完整的 liveData 冲掉，
// 于是绝大多数节点查不到元数据 —— 表现就是整片「未知」。
// 一次刷新/回读只该让数据变新，绝不该让数据变少。
//
// 但合并有个前提：新旧数据来自同一个内核进程。配置替换 + 重启后，旧出站
// 在新内核里根本不存在，合并会让它们永远留在列表里（「上传/恢复配置后
// 出站不刷新」）；新配置出站不到旧一半时还会被数量守卫整批拒收。所以用
// state.status.pid 识别内核进程：PID 变了（带外重启且配置被换掉），旧数据
// 整体作废，直接采纳、不合并。PID 取不到时退回原来的合并逻辑。
// 只用 pid、不用 uptime 推启动时刻：etime 只有 1 秒精度，epoch-up 会在相邻
// 两次轮询间抖动 ±1，用它判断会把同进程误判成新进程、丢掉截断保护。
let adoptedPid = '';
function currentKernelPid() {
  const st = state.status || {};
  return String(st.pid || '');
}
function adoptProxyData(j) {
  const next = j && j.proxies;
  if (!next || typeof next !== 'object') return false;      // 明显不可用，不采纳
  const pid = currentKernelPid();
  const freshBoot = pid !== '' && pid !== adoptedPid;
  if (freshBoot && adoptedPid) nodeLatencyResults.clear();
  const prev = liveData && liveData.proxies;
  const prevCount = prev ? Object.keys(prev).length : 0;
  const nextCount = Object.keys(next).length;
  if (!freshBoot && prevCount && nextCount < prevCount * 0.5) {
    // 新数据节点数不到旧数据的一半：这次回读不可信，宁可不动。
    // 选中态会稍晚对齐，但至少不会把整页信息搞坏。
    return false;
  }
  if (prev && !freshBoot) {
    const merged = Object.assign({}, prev);
    Object.keys(next).forEach(k => { merged[k] = next[k]; });
    liveData = Object.assign({}, j, { proxies: merged });
  } else {
    liveData = j;
  }
  if (pid) adoptedPid = pid;
  return true;
}

// 内核配置已生效（保存后重启 / 热重载 / 服务重启）：旧运行数据整体作废。
// liveData 置空后，下次采纳必然走整体替换分支，陈旧出站不会再被合并回来。
// 如果人就在代理页上，原地重挂骨架并重拉；加载途中收到失效则由 loadProxyData
// 尾部的 revision 检查补排一次加载，页面不会停在空列表上。
export function invalidateProxyData() {
  ++allLatencyGeneration;
  liveData = null;
  nodeLatencyResults.clear();
  providerData = null;
  providerIndexCache = new Map();
  providerDiag = { ok: false, count: 0, indexed: 0, error: '' };
  liveError = '';
  ++proxyMutationRev;
  bumpDataRev();
  // 配置生效几乎总伴随内核进程重启（保存后重启 / 服务重启），新核的
  // external-controller 从进程拉起到开始监听有一小段空窗（实机几百毫秒～数秒）。
  // 不开启动宽限的话，空窗里的这次重拉会直接落到红字错误态且不再重试——
  // 这正是「重载内核后代理页的节点没有立即刷新出来」的根因。宽限只延长不缩短
  // （总开关启动流程可能已给了更长的 30 秒），期间 loadProxyData 静默轮询等就绪。
  markCoreStarting(20000);
  if (typeof document === 'undefined') return;
  const el = document.getElementById('page-proxies');
  if (el && el.isConnected) {
    el._proxyMounted = false;
    renderProxyPage(el);
  }
}
onCoreConfigApplied(invalidateProxyData);

// 软刷新：不清缓存、不拆页面、不挂骨架。数据在后台重拉，两路都回来后
// 只做一次原地替换；刷新期间旧内容原样保留，用户看不到「整页闪一下」。
// 用于启动成功后补拉内核刚就绪时才有的延迟历史 / 选中项 / 可用性。
let softPending = false;
export function refreshProxyDataSoft() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('page-proxies');
  if (!el || !el._proxyMounted || !el.isConnected) return;   // 没打开过代理页：下次进入自然会拉新数据
  if (loading) { softPending = true; return; }                 // 在途加载结束后补一轮
  loadProxyData(el, true, true);
}

async function refreshSelectionAfterTest() {
  const el = typeof document !== 'undefined' ? document.getElementById('page-proxies') : null;
  if (!el || !el.isConnected || selectionRefreshing) return;
  selectionRefreshing = true;
  const revision = proxyMutationRev;
  try {
    // 必须带 big：/proxies 在订阅节点多时能到几 MB，默认 8 秒超时会被打断，
    // 拿回截断数据（这正是「测完速类型全变未知」的直接触发条件）。
    const r = await apiGet('/proxies', { big: true });
    const j = parseJsonLoose(r && r.stdout);
    if (revision !== proxyMutationRev || !adoptProxyData(j)) return;
    bumpDataRev();
    // Preserve existing cards, lazy-mount tasks and scroll geometry after latency tests.
    if (el.isConnected) { paintSelections(); syncProxyAvailability(); }
  } catch (e) {
    // 回读失败无所谓：延迟已经写回，只是选中态等下次进页面再对齐
  } finally {
    selectionRefreshing = false;
  }
}

// 代理页的三处「一眼可见」统计，统一从这里出：
//   1) 顶部导航栏副标题：代理组 N · 节点 M
//   2) 「隐藏不可用节点」开关上的数字标签：当前不可用的节点数
//   3) 工具栏统计行的状态提示（延迟来源 / 类型未知 / 配置预览 / 暂无代理组）
// 口径只有这一份：测速、切页、provider 更新后三处不会互相打架。
function proxyStats(groups, dict, pIndex) {
  groups = groups || liveGroups(liveData);
  dict = dict || ((liveData && liveData.proxies) || {});
  pIndex = pIndex || providerIndexCache;
  latencyTableFor(dict, pIndex);
  const live = !!(liveData && liveData.proxies);
  const allNodes = new Set(groups.flatMap(g => g.all));
  if (!groups.length) {
    // 首次读取还没回来 / 配置里确实没有代理组：统计行只说这件事
    return { groups: 0, nodes: allNodes.size, dead: 0, live, ready: false,
      hints: [loadedOnce ? '暂无代理组' : '正在读取代理列表…'] };
  }
  // 不可用节点数与 Zashboard 保留规则及当前测速样本共用同一判定，
  // 但不受开关状态影响 —— 开关关着时也要能看出有多少节点不可用。
  let dead = 0;
  allNodes.forEach(n => { if (nodeUnavailable(n, nodeMeta(n, dict, pIndex))) dead++; });
  const hints = [];
  if (!live) hints.push('当前为配置预览');
  else if (allNodes.size) {
    // 诊断用：内核 /proxies 里带延迟历史的节点数。浏览器刷新后一片「未测速」
    // 时，看这里就能分清是内核没给 history，还是前端没读到。
    let withHistory = 0;
    allNodes.forEach(n => {
      const meta = nodeMeta(n, dict, pIndex);
      if (latencySample(meta).exists || nodeLatencyResults.has(latencyIdentity(n, meta))) withHistory++;
    });
    if (!withHistory) hints.push('内核暂无延迟历史，点 ⚡ 测速');
    // 协议类型显示「未知」的根因：运行时数据里查不到这个节点。
    // 常见原因是 provider 元数据没拉到，或节点名带「provider名/」前缀对不上。
    let noMeta = 0;
    allNodes.forEach(n => { if (!nodeMeta(n, dict, pIndex)) noMeta++; });
    if (noMeta) hints.push(`${noMeta} 个节点无运行时数据（类型未知）`);
  }
  return { groups: groups.length, nodes: allNodes.size, dead, live, ready: true, hints };
}

// Count all displayed groups at all times, independent of which test was clicked.
function hiddenNodeCountStats(groups, dict, pIndex) {
  if (!Number(state.status?.running) || !liveData?.proxies) return null;
  groups = groups || liveGroups(liveData);
  dict = dict || liveData.proxies;
  pIndex = pIndex || providerIndexCache;
  latencyTableFor(dict, pIndex);
  const hidden = new Set();
  groups.forEach(item => item.all.forEach(name => {
    const meta = nodeMeta(name, dict, pIndex);
    if (nodeUnavailable(name, meta)) hidden.add(latencyIdentity(name, meta));
  }));
  return { name: '', scope: 'all', dead: hidden.size };
}

function proxySubtitleText(stats) {
  return stats.ready ? `代理组 ${stats.groups} · 节点 ${stats.nodes}` : '代理组 · 节点';
}

function proxySummaryText(stats) {
  // 统计行不再重复导航栏里的组数 / 节点数：这里只留需要解释的状态。
  // 诊断入口已经是工具栏里的圆形按钮，没有状态提示时保持空白，
  // 不再显示会被误认为诊断入口的旧提示文字。
  return stats.hints.length ? stats.hints.join(' · ') : '';
}

// 把统计结果写到导航栏副标题、筛选开关的数字标签和工具栏统计行。
// 渲染时调一次；测速后卡片增减（可用性变了）再调一次。
function refreshProxyStats(groups, dict, pIndex) {
  if (typeof document === 'undefined') return;
  const stats = proxyStats(groups, dict, pIndex);
  const el = document.getElementById('page-proxies');
  const subtitleText = proxySubtitleText(stats);
  if (el) {
    // 写进 dataset：切页时 showPage 就是按它刷副标题的，前后不会打架
    el.dataset.sub = subtitleText;
    const sub = document.getElementById('pageSubtitle');
    const title = document.getElementById('pageTitle');
    // 判断「顶栏现在显示的就是本页」而不是看页面自身的 hidden：页面预构建时还没
    // 揭开，但顶栏已经切成「代理」，这时写进去正是对的。
    if (sub && title && title.textContent === (el.dataset.title || '代理')) sub.textContent = subtitleText;
  }
  if (deadCountEl) {
    // 只有拿到运行时数据才谈得上「可用性」：配置预览里不显示数字
    deadCountEl.hidden = !(stats.live && stats.ready);
    const scoped = hiddenNodeCountStats(groups, dict, pIndex);
    deadCountEl.textContent = scoped ? String(scoped.dead) : '—';
    deadCountEl.dataset.group = scoped ? scoped.name : '';
    deadCountEl.dataset.scope = scoped ? scoped.scope : '';
    deadCountEl.title = !scoped ? '尚无运行时统计数据'
      : `所有组${proxyPrefs.hideDead ? '隐藏' : '不可用'} ${scoped.dead} 个节点（跨组/别名去重，含未测速）`;
  }
  setProxySummary(el, proxySummaryText(stats));
}

// 工具栏状态行的唯一写入口：三个功能按钮搬进顶栏后，工具栏只剩这一行文字，
// 没有提示内容时整条收起来，代理页不再顶着一条空白带。
function setProxySummary(el, text) {
  const root = el || (typeof document !== 'undefined' ? document.getElementById('page-proxies') : null);
  const summary = root && root.querySelector && root.querySelector('.proxy-summary');
  if (!summary) return;
  summary.textContent = text || '';
  const toolbar = summary.parentElement;
  // 兜底形态（顶栏容器缺失、按钮仍留在工具栏右侧）时整条不能收，按钮要一直可点
  if (toolbar && toolbar.classList.contains('proxy-toolbar')) {
    toolbar.hidden = !summary.textContent && !toolbar.querySelector('.proxy-toolbar-right');
  }
}

function renderProxyData(el) {
  if (!el) return;
  // 重建前把浮层里的组卡放回旧列（随旧 body 一起销毁），避免浮层里留下弃件
  dismissProxyModalCards();
  syncAllLatencyButtons();
  const oldScroll = window.scrollY || 0;
  const groups = liveGroups(liveData);
  const dict = liveData && liveData.proxies && typeof liveData.proxies === 'object' ? liveData.proxies : {};
  const pIndex = providerIndexCache;
  // 渲染前先建好全局延迟表：后面每张卡片 O(1) 查表，不再各解析一次 history
  latencyTableFor(dict, pIndex);
  const allNodes = new Set(groups.flatMap(g => g.all));
  const live = !!(liveData && liveData.proxies);
  // 总开关关闭：运行缓存已作废，配置预览凑出来的组也不再显示——
  // 否则停核后整页仍是满满一组「点了也没用」的卡片，看起来像没停。
  const coreStopped = !!(state.status && !Number(state.status.running));
  if (coreStopped) groups.length = 0;

  const oldBody = el.querySelector('.proxy-groups');
  if (oldBody) {
    oldBody.querySelectorAll('.proxy-node-grid').forEach(grid => { if (grid._cancelMount) grid._cancelMount(); });
    oldBody.remove();
  }
  if (marqueeObserver) marqueeObserver.disconnect();
  refreshProxyStats(groups, dict, pIndex);

  const body = h('div', { class: 'proxy-groups' });
  // 双排布局（zashboard「双列显示代理组」）：组卡/骨架卡按序左右两列交错排布，
  // 展开在卡片原位进行（见 groupCard / applyOpenGroups）。
  // 脚手架懒建——纯提示页（停核 / 读失败 / 暂无组）不需要两列空壳。
  let dualCols = null;
  let cardSeq = 0;
  const putCard = (c) => {
    if (proxyPrefs.twoColumn) {
      if (!dualCols) dualCols = appendDualScaffold(body);
      dualCols.children[cardSeq++ % 2].append(c);
    } else {
      body.append(c);
    }
  };
  if (coreStopped) {
    // 总开关关闭后的即时态：不挂骨架、不报 API 错、不显示配置预览组，直接说明原因与去向。
    body.append(note('内核未运行，代理列表不可用。请到「主页」开启总开关。', 'warn'));
  } else if (liveError && !groups.length) {
    body.append(note('无法读取运行时代理列表：' + liveError + '。请确认内核已启动并配置 external-controller。', 'danger'));
  } else if (liveError && !live) {
    // 配置里能凑出组列表时页面看起来是正常的，不提示的话用户只会觉得
    // 「协议类型怎么全是未知」。这里把真实原因讲清楚。
    body.append(note('内核代理列表读取失败，当前是配置预览：协议类型、延迟、选中状态均不完整（' + liveError + '）。', 'danger'));
    // 常见根因逐条点破：这类设备上 wget 常常是缺 applet 的 toybox 软链接，
    // 光说「请确认内核已启动」会把人引到完全错误的方向。
    body.append(note(proxyFailureHint(liveError), 'danger'));
  } else if (!groups.length) {
    // 首次读取还没回来：先铺骨架，不留一整页空白（一次 CGI 往返
    // 常常要几百毫秒，空白会被看成「卡住 / 闪一下」）
    if (loadedOnce) body.append(h('div', { class: 'empty' }, '配置中暂无代理组。可在「配置 → 代理组」新建代理组。'));
    else for (let i = 0; i < 3; i++) putCard(skeletonGroup(i === 0 ? 6 : 4));
  } else {
    // 展开态由卡片自身的 openGroups/is-open 决定，原位展开，无需额外对齐
    groups.forEach(g => putCard(groupCard(g, dict, pIndex)));
  }
  el.append(body);
  // 双排布局：重建后仍处于展开态的组进浮层（数据刷新 / 刚勾上双排等场景），
  // 保证「紧凑两列 + 浮层展开」的形态不被重建打回原形。
  if (dualCols && openGroups.size) {
    const openName = [...openGroups][0];
    const opened = [...body.querySelectorAll('.proxy-group-card')]
      .find(c2 => c2.dataset.proxyGroup === openName);
    if (opened) {
      if (opened._mountNodes) opened._mountNodes(false);
      moveCardToModal(opened, el);
    }
  }
  if (Math.abs((window.scrollY || 0) - oldScroll) > 2) window.scrollTo({ top: oldScroll });
}

// 读取失败时按错误特征给出可操作的指引，而不是一律「请确认内核已启动」。
function proxyFailureHint(err) {
  const e = String(err || '');
  if (/Unknown command|无可用的 HTTP 客户端|no HTTP client/i.test(e)) {
    return '原因：系统缺少可用的 HTTP 客户端（curl / wget 都跑不起来，常见于 wget 是指向 toybox 的软链接、而该 toybox 未编译 wget）。'
      + '处理：安装 Busybox 模块（KernelSU/Magisk 的 Busybox 均可）后重新打开本页；模块会自动改用 busybox wget。';
  }
  if (/Request Timeout|timed out|超时|Connection refused/i.test(e)) {
    return '原因：请求内核 API 超时或被拒绝。处理：确认内核已启动（主页总开关）；订阅节点多时可稍后重试。';
  }
  if (/401|Unauthorized|Forbidden/i.test(e)) {
    return '原因：external-controller 的 secret 不匹配。处理：在「配置 → 常规」核对密钥后重试。';
  }
  return '处理：确认内核已启动（主页总开关）；订阅节点多时稍后重试，或到「内核管理」查看日志。';
}

function isBuiltinProxy(name, meta) {
  const n = String(name || '').toUpperCase();
  const t = String(meta && meta.type || '').toUpperCase();
  const builtin = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'PASS-RULE', 'COMPATIBLE'];
  return builtin.includes(n) || builtin.includes(t) || n === 'DNS' || t === 'DNS';
}

// 与 zashboard 的 isLatencyTestable 保持一致：DIRECT 也是可测速的出站类型，
// 只有拒绝/阻断类策略不应发起延迟请求。
function isLatencyTestable(name, meta) {
  const n = String(name || '').trim().toUpperCase().replace(/_/g, '-');
  const t = String(meta && meta.type || '').trim().toUpperCase().replace(/_/g, '-');
  return !['REJECT', 'REJECT-DROP', 'BLOCK'].includes(n)
    && !['REJECT', 'REJECT-DROP', 'BLOCK'].includes(t);
}

// The only special exemption is exactly Zashboard's retained policy/group types.
// All ordinary nodes require their CURRENT latency > 0, regardless of `alive`.
function nodeIsDead(name, meta) {
  if (retainedByZashboard(meta)) return false;
  const hasResult = nodeLatencyResults.has(latencyIdentity(name, meta)) || latencySample(meta).exists;
  return hasResult && delayValue(name, meta) <= 0;
}
function nodeUnavailable(name, meta) {
  return !retainedByZashboard(meta) && delayValue(name, meta) <= 0;
}

// 「隐藏不可用节点」的保留规则：开关关着一律保留。
// 计数一定要用 nodeUnavailable，不能用这个 —— 开关关着时它对所有节点都返回 true。
function keepWhenHidingDead(name, meta) {
  if (!proxyPrefs.hideDead) return true;
  return !nodeUnavailable(name, meta);
}

function isDirectProxy(name, meta) {
  const n = String(name || '').trim().toUpperCase();
  const t = String(meta && meta.type || '').trim().toUpperCase();
  return n === 'DIRECT' || t === 'DIRECT';
}

// COMPATIBLE 是 mihomo 的兼容出站：策略组筛不出节点时出现，行为等效 DIRECT。
// 它走的是真实网络，所以和 DIRECT 一样可以测延迟（拒绝类策略才不能测）。
function isCompatibleProxy(name, meta) {
  const n = String(name || '').trim().toUpperCase().replace(/_/g, '-');
  const t = String(meta && meta.type || '').trim().toUpperCase().replace(/_/g, '-');
  return n === 'COMPATIBLE' || t === 'COMPATIBLE';
}

// 普通节点和 DIRECT 可测速；其它内置策略不显示测速按钮，也不参与测速。
function isProxySpeedTestable(name, meta) {
  // DIRECT 与 COMPATIBLE 都是真实出站，可以测速
  if (isDirectProxy(name, meta) || isCompatibleProxy(name, meta)) return true;
  return !isBuiltinProxy(name, meta) && isLatencyTestable(name, meta);
}

// Config is authoritative for group icons, including when API groups lack icon.
function groupIconSource(group) {
  if (!proxyPrefs.showIcons) return '';
  const configs = Array.isArray(state.cfg?.['proxy-groups']) ? state.cfg['proxy-groups'] : [];
  const config = configs.find(g => g && String(g.name) === group.name) || group.cfg;
  const src = typeof config?.icon === 'string' ? config.icon.trim() : '';
  if (/^https?:\/\//i.test(src)) return src;
  if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/i.test(src)) return src;
  return '';
}
function groupIcon(group) {
  const src = groupIconSource(group);
  if (!src) return null;
  const img = h('img', {class: 'proxy-group-icon', src, alt: '', width: 44, height: 44,
    loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer'});
  img.onerror = () => img.remove();
  return img;
}

function groupCard(group, dict, pIndex) {
  const isOpen = openGroups.has(group.name);
  const current = group.now || '';
  // 展开/收起的唯一实现：右上角按钮与「点组头/卡片」共用，避免两套逻辑漂移。
  // 手风琴式：同时只展开一组（openGroups 始终至多一个组名）。
  const applyOpenGroups = () => {
    const page = document.getElementById('page-proxies');
    if (!page) return;
    page.querySelectorAll('.proxy-group-card').forEach(groupCardEl => {
      const isThis = openGroups.has(groupCardEl.dataset.proxyGroup);
      const body = groupCardEl.querySelector('.proxy-node-body');
      const btn = groupCardEl.querySelector('.proxy-group-toggle');
      // 收起时这一组还没建过卡片，展开的瞬间才建
      if (isThis && groupCardEl._mountNodes) groupCardEl._mountNodes(false);
      if (body) body.hidden = !isThis;
      if (btn) syncCollapseButton(btn, isThis, groupCardEl.dataset.proxyGroup);
      // 双排布局里靠它显示/隐藏组测速按钮（仅展开的组显示）
      groupCardEl.classList.toggle('is-open', isThis);
    });
    // 双排布局：展开的组整卡进居中浮层（zashboard 移动端 modal 同款），收起的原位放回；
    // 单列布局保持列内原地展开，且确保没有卡滞留在浮层里。
    const groupsBody = page.querySelector('.proxy-groups');
    if (groupsBody && groupsBody.classList.contains('dual')) {
      page.querySelectorAll('.proxy-group-card').forEach(groupCardEl => {
        if (openGroups.has(groupCardEl.dataset.proxyGroup)) moveCardToModal(groupCardEl, page);
        else if (groupCardEl._dualMarker && groupCardEl._dualMarker.isConnected) {
          groupCardEl._dualMarker.replaceWith(groupCardEl);   // 收起：原位放回所在列
          groupCardEl._dualMarker = null;
          refreshCardNowMarquee(groupCardEl);   // 宽度变窄了，跑马灯状态要跟着重新量
        }
      });
      const modal = page.querySelector(':scope > .proxy-modal');
      const host = modal && modal.querySelector('.proxy-modal-body');
      if (modal && host && !host.querySelector('.proxy-group-card')) modal.hidden = true;
      syncProxyModalLock(modal);
    } else {
      dismissProxyModalCards();
    }
  };
  const toggleGroupOpen = () => {
    setOpenGroups(openGroups.has(group.name) ? [] : [group.name]);
    applyOpenGroups();
  };
  // 延迟胶囊本身就是测速入口（zashboard 同款）：展开、收起都能点，测的是
  // 该组当前选中链条末端的叶子节点；点它不该顺带展开/收起组头。
  const onDelayChipClick = (ev) => {
    ev.stopPropagation();
    const cardEl = ev.currentTarget.closest('.proxy-group-card');
    const g = (cardEl && cardEl._proxyGroup) || group;
    testGroupHeadDelay(g, dict, pIndex, cardEl);
  };
  const makeDelayChip = () => h('button', {
    type: 'button', class: 'proxy-latency-tag proxy-group-delaytag', hidden: true,
    'aria-label': '测速当前选中节点',
    onpointerdown: (ev) => ev.stopPropagation(),
    onclick: onDelayChipClick,
  }, h('span', { class: 'proxy-node-delay' }));
  const title = h('div', { class: 'proxy-group-title' },
    h('span', { class: 'proxy-group-name', text: group.name }),
    badge(group.type || '代理组', 'b'),
    // 类型徽章后的延迟胶囊：与单节点卡片里的胶囊同款样式
    // （.proxy-latency-tag 外壳 + .proxy-node-delay 内容：数字/闪电/红叹号）
    makeDelayChip());
  // 双排紧凑卡的「类型」副本容器：单列模式隐藏（徽章跟在组名后），
  // 双排模式落到组名下面一行；延迟胶囊改放第三行（见 rowDelay，与「当前」同行对齐）。
  const meta = h('div', { class: 'proxy-group-meta' },
    badge(group.type || '代理组', 'b'));
  // 双排紧凑卡第三行右侧的延迟胶囊：与「当前选择」同一行，贴在展开按钮正下方
  // （zashboard 同款：当前节点靠左，延迟数字靠右）；单列/浮层整宽卡隐藏，
  // 延迟仍跟在标题徽章后面显示。
  const rowDelay = h('div', { class: 'proxy-group-row-delay' }, makeDelayChip());
  const icon = groupIcon(group);

  // 「当前节点」独立成行（网格第二行）：单列模式下与组名同宽，双排模式下横贯
  // 整张卡片（延伸到展开按钮下方）；文字超宽时走跑马灯滚动（observeNowMarquee）。
  // 结构固定为「当前： | [A → B]」——前缀定宽不滚，后面整段（当前节点 + 最终
  // 出站）放在同一个 clip 里：
  //   * 永远单行（不折行，折行会让双排窄卡忽高忽低）；
  //   * 放不下时整段一起跑马灯，「当前」和「最终出站」都不会缺字；
  //   * 只有「当前」时退化成原来那套单名滚动，行为不变。
  const nowCurText = h('span', { class: 'proxy-group-now-cur', text: current || (group.live ? '未选择' : '点击刷新读取当前节点') });
  // 「最终出站」（zashboard「显示最终出站」同款）：now 本身还是代理组时，
  // 紧跟一段「→ 叶子节点」，显示这条选择链末端真正出网的节点。
  const nowLeaf = h('span', { class: 'proxy-group-now-leaf', hidden: true },
    h('span', { class: 'proxy-group-now-arrow', html: NOW_LEAF_ARROW_SVG }),
    h('span', { class: 'proxy-group-now-leaf-text' }));
  const nowClipBox = h('span', { class: 'proxy-group-now-clip' },
    h('span', { class: 'proxy-group-now-text' }, nowCurText, nowLeaf));
  const now = h('div', { class: 'proxy-group-now' },
    h('span', { class: 'proxy-group-now-label', text: current || group.live ? '当前：' : '' }),
    nowClipBox);
  const toggle = createCollapseButton(isOpen, toggleGroupOpen, group.name);
  toggle.classList.add('proxy-group-toggle');
  const batchBtn = h('button', {
    type: 'button', class: 'btn sm circle proxy-batch-btn', html: ALL_LATENCY_ICON,
    title: group.live ? '测速此代理组的全部节点' : '启动内核后才能测速',
    'aria-label': '测速此代理组的全部节点', disabled: !group.live,
    onclick: (ev) => {
      ev.stopPropagation();
      testGroupAll(group, dict, pIndex, batchBtn);
    },
  });
  if (batchTestingGroups.has(group.name)) setBatchButtonBusy(batchBtn, true);
  const headActions = h('div', { class: 'proxy-group-head-actions' }, batchBtn, toggle);
  // 组头是 CSS 网格：第一行「图标 | 组名 | 按钮」（展开按钮与组名对齐），
  // 第二行「当前节点」——单列模式与组名同宽，双排模式横贯整卡（含按钮下方）。
  // 无图标时切 no-icon 模板，避免留下空的图标列把组名右推。
  const head = h('div', { class: 'proxy-group-head' + (icon ? '' : ' no-icon') }, title, now, headActions, meta, rowDelay);
  if (icon) head.prepend(icon);
  observeNowMarquee(nowClipBox);
  const getVisibleNames = () => group.all.filter(name => {
    const meta = nodeMeta(name, dict, pIndex);
    if (!keepWhenHidingDead(name, meta)) return false;
    return true;
  });
  const grid = h('div', { class: 'proxy-node-grid' });
  const nodeBody = h('div', { class: 'proxy-node-body' }, grid);
  nodeBody.hidden = !isOpen;
  const c = card();
  c.classList.add('proxy-group-card');
  // 双排布局靠它控制组测速按钮显隐（仅展开的组显示）；单列模式无副作用
  if (isOpen) c.classList.add('is-open');
  c.dataset.proxyGroup = group.name;
  c._proxyGroup = group;
  c._toggleOpen = toggleGroupOpen;   // 浮层暗底点击复用同一条展开/收起路径
  c.append(head, nodeBody);
  syncGroupDelayChip(c);             // 建卡即按当前数据填延迟 chip
  paintFinalOutbound(c, dict);       // 同理：建卡即按当前数据填「→ 最终出站」
  // 点组头（图标/组名/当前节点/空白处）或卡片边距也能展开/收起，不必瞄准
  // 右上角的小按钮。排除两类点击：节点区里是选节点/测速，按钮（展开钮、
  // 组测速）各有自己的处理 —— 它们还会 stopPropagation，这里再兜一层。
  bindCollapsibleCard(c, head, nodeBody, toggle, toggleGroupOpen);

  // 懒挂载：以前不管收起展开，每个组的全部节点卡片都在渲染时建好，
  // 大订阅一次就是上千张卡 —— 切页重建和点击展开都会被这一下卡住。
  // 现在收起的组只留组头，展开时才建；并且分批插入，首屏先出来。
  let mounted = false;
  c._mountNodes = (full) => {
    if (mounted) return;
    mounted = true;
    const visibleNames = getVisibleNames();
    if (!visibleNames.length) {
      grid.append(emptyHintEl());
      grid._nodesBuilt = true;
      flushPendingNodesSync(grid);
      return;
    }
    mountNodeCards(grid, visibleNames, group, dict, pIndex, full);
  };
  if (isOpen) c._mountNodes(false);
  return c;
}

// 一帧塞几百张卡片必然掉帧：先出前 N 张，剩下的交给后续帧。
// full=true 用于批量测速——结果要写回卡片，必须一次建完。
// 每帧插入的卡片数由执行层按渲染能力给出：管理器 WebView 更小批，避免长任务卡交互
const CARD_CHUNK = POLICY.cardChunk;
function emptyHintEl() {
  return h('div', { class: 'empty' }, proxyPrefs.hideDead ? '没有符合当前筛选的节点' : '此代理组暂无节点');
}

// ---------- 按提供商分组（与 zashboard 一致的组内小节） ----------
// 「是不是代理合集节点」以配置为准，不能只拿名字去 provider 索引里撞：
// 索引按裸名建键，本地手写节点与合集节点同名时就会误判（实测截图里本地
// 的 PASS、直连出口、嵌套组「国内节点」全被挂上了合集小节头）。判定链：
//   1) 名字（或其裸名）在配置 proxies 里手写过、或是任一代理组名 → 本地；
//   2) 「合集/节点」前缀写法：前缀必须是 proxy-providers 里真实声明的合集，
//      且本组的 use 包含它（查不到组配置时只认声明这一层）；
//   3) 裸名：provider 索引命中，且提供商同样落在声明 + use 范围内。
// 三条都不满足才是本地节点，不设小节。
function providerAttributionCtx(group, pIndex) {
  const cfg = state.cfg || {};
  const declared = new Set(Object.keys(cfg['proxy-providers'] || {}));
  const local = new Set(cfgProxyMap().keys());
  const cfgGroups = Array.isArray(cfg['proxy-groups']) ? cfg['proxy-groups'] : [];
  cfgGroups.forEach(g => { if (g && g.name != null) local.add(String(g.name)); });
  const gcfg = (group && group.cfg) || cfgGroups.find(g => g && group && String(g.name) === String(group.name)) || null;
  const use = gcfg && Array.isArray(gcfg.use) ? gcfg.use.map(String) : null;
  return { declared, local, use, pIndex };
}

function nodeProviderName(name, ctx) {
  if (!ctx) return '';
  const s = String(name);
  const bare = bareNodeName(s);
  const leaf = bare || s;
  // 1) 本地定义优先：手写节点与代理组名一律不算合集节点
  if (ctx.local.has(s) || ctx.local.has(leaf)) return '';
  // 2) 「合集/节点名」前缀写法
  if (bare) {
    const prefix = s.slice(0, s.length - bare.length - 1);
    if (ctx.declared.has(prefix) && (!ctx.use || ctx.use.includes(prefix))) return prefix;
    return '';
  }
  // 3) 裸名查 provider 索引
  const p = ctx.pIndex && ctx.pIndex.get(s);
  if (p && p._providerName) {
    const prov = String(p._providerName);
    if (ctx.declared.has(prov) && (!ctx.use || ctx.use.includes(prov))) return prov;
  }
  return '';
}

// 把一串节点名按提供商切成有序小节（保持组内原有顺序、按首次出现排列）。
// provider 为 '' 的是本地手写节点：只占位不设小节头（分组只需管代理合集
// 来源的节点，本地节点平铺在原位置即可）。
function providerSections(names, group, pIndex) {
  const ctx = providerAttributionCtx(group, pIndex);
  const out = [];
  const byKey = new Map();
  names.forEach(name => {
    const prov = nodeProviderName(name, ctx);
    let sec = byKey.get(prov);
    if (!sec) { sec = { provider: prov, names: [] }; byKey.set(prov, sec); out.push(sec); }
    sec.names.push(name);
  });
  return out;
}

// 小节标题行：提供商名 + 节点数，横贯网格整行。
function providerHeadEl(sec) {
  return h('div', { class: 'proxy-provider-head', dataset: { provider: sec.provider || '' } },
    h('span', { class: 'proxy-provider-name', text: sec.provider || '本地配置' }),
    h('span', { class: 'proxy-provider-count', text: sec.names.length + ' 个节点' }),
    h('span', { class: 'proxy-provider-line' }));
}

// 增量同步（syncGroupCardNodes）后的分组头对齐：节点卡顺序仍由 group.all
// 决定，头是可移动的 —— 按当前可见名单重算小节，该建的建、该删的删、
// 该挪到小节首卡之前的挪。不重建节点卡，不丢滚动与测速状态。
function syncProviderHeaders(grid, group, dict, pIndex, cardByName) {
  const heads = new Map();
  grid.querySelectorAll('.proxy-provider-head').forEach(el => heads.set(el.dataset.provider || '', el));
  const dropAll = () => heads.forEach(el => el.remove());
  if (!proxyPrefs.groupByProvider) { dropAll(); return; }
  const visibleNames = group.all.filter(n => keepWhenHidingDead(n, nodeMeta(n, dict, pIndex)));
  const sections = providerSections(visibleNames, group, pIndex);
  // 一个合集节点都没有（纯本地组、或订阅数据还没拉到）：不加任何头，
  // 与未分组时一模一样；provider 数据到达后页面会重渲染，届时自然出现。
  if (!sections.some(s => s.provider)) { dropAll(); return; }
  // 本地节点（provider 为空）不设小节：只对合集小节建/挪小节头
  const wanted = new Map(sections.filter(s => s.provider).map(s => [s.provider, s]));
  heads.forEach((el, key) => { if (!wanted.has(key)) el.remove(); });
  wanted.forEach((sec, key) => {
    const firstCard = cardByName && cardByName.get(sec.names[0]);
    if (!firstCard) return;   // 该小节当前没有已挂载的卡（理论上不会发生）
    let el = heads.get(key);
    if (!el) el = providerHeadEl(sec);
    const cnt = el.querySelector('.proxy-provider-count');
    if (cnt) cnt.textContent = sec.names.length + ' 个节点';
    const nm = el.querySelector('.proxy-provider-name');
    if (nm) nm.textContent = sec.provider || '本地配置';
    if (el.nextElementSibling !== firstCard) firstCard.before(el);
  });
}
function mountNodeCards(grid, names, group, dict, pIndex, full) {
  const finish = () => {
    grid._nodesBuilt = true;
    // 挂载期间安排的筛选对齐（syncGroupCardNodes）在这里补做：
    // 那时卡片还没建完，插队会和分批挂载抢同一块 DOM。
    flushPendingNodesSync(grid);
  };
  // 按提供商分组开启且确有订阅节点时，把名单展开成「小节头 + 该小节节点」
  // 的流水；头只是网格里横贯整行的元素，与节点卡走同一条分批通道。
  const items = [];
  if (proxyPrefs.groupByProvider) {
    const sections = providerSections(names, group, pIndex);
    if (sections.some(s => s.provider)) {
      sections.forEach(sec => {
        if (sec.provider) items.push({ head: sec });
        sec.names.forEach(name => items.push({ name }));
      });
    }
  }
  if (!items.length) names.forEach(name => items.push({ name }));
  if (typeof DocumentFragment === 'undefined') {
    items.forEach(it => {
      if (it.head) { grid.append(providerHeadEl(it.head)); return; }
      if (!keepWhenHidingDead(it.name, nodeMeta(it.name, dict, pIndex))) return;
      const el = nodeCard(group, it.name, nodeMeta(it.name, dict, pIndex), dict, pIndex);
      grid.append(el);
      observeMarquee(el);
    });
    finish();
    return;
  }
  let i = 0, raf = 0, cancelled = false;
  grid._cancelMount = () => { cancelled = true; cancelAnimationFrame(raf); };
  const step = () => {
    if (cancelled || !grid.isConnected) return;
    const started = performance.now();
    const end = Math.min(items.length, i + CARD_CHUNK);
    const frag = document.createDocumentFragment();
    const made = [];
    for (; i < end; i++) {
      if (!full && made.length && performance.now() - started >= 5) break;
      const it = items[i];
      if (it.head) { frag.append(providerHeadEl(it.head)); continue; }
      const name = it.name;
      if (!keepWhenHidingDead(name, nodeMeta(name, dict, pIndex))) continue;
      // 单张卡构建失败只跳过它自己：以前异常会冒到外层把整批中断，
      // 表现就是「展开后一个节点也没有」。错误照实打到控制台，不静默吞掉。
      let el = null;
      try {
        el = nodeCard(group, name, nodeMeta(name, dict, pIndex), dict, pIndex);
      } catch (e) {
        console.warn('节点卡构建失败', name, e);
        continue;
      }
      made.push(el);
      frag.append(el);
    }
    grid.append(frag);
    made.forEach(observeMarquee);
    if (i < items.length) {
      if (full) step();
      else raf = requestAnimationFrame(step);
    } else {
      finish();
    }
  };
  if (full) step();
  else raf = requestAnimationFrame(step);
}

function flushPendingNodesSync(grid) {
  const groupName = grid && grid._syncPending;
  if (!groupName) return;
  grid._syncPending = '';
  syncGroupCardNodes(groupName);
}

// 按当前筛选就地增删一个代理组里的节点卡。
//
// 为什么需要：可用性会变（一次组测速可能让一批节点从不通过变可用，也可能反过来），
// 而卡片是渲染时按当时的可用性建好的。不重新对齐的话，被「隐藏不可用节点」筛掉的节点
// 即使已经恢复也不会出现 —— 用户看到的就是「测速当前代理组后可用节点没显示出来」。
// 只动这一个组里变化的那几张卡：整页重绘会丢掉懒挂载进度、展开状态和滚动位置。
function syncGroupCardNodes(groupName) {
  if (typeof document === 'undefined') return;
  const page = document.getElementById('page-proxies');
  const cardEl = page && [...page.querySelectorAll('.proxy-group-card')]
    .find(el => el.dataset.proxyGroup === groupName);
  const group = cardEl && cardEl._proxyGroup;
  const grid = cardEl && cardEl.querySelector('.proxy-node-grid');
  if (!group || !grid) return;
  const dict = (liveData && liveData.proxies) || {};
  const meta = n => nodeMeta(n, dict, providerIndexCache);
  const visibleNames = group.all.filter(n => keepWhenHidingDead(n, meta(n)));
  const existing = new Map();
  grid.querySelectorAll('.proxy-node').forEach(el => existing.set(el.dataset.proxyNode, el));
  // 上一轮挂载途中摘过卡片（统计行还没刷）时，这一次要连统计一起补齐
  let changed = !!grid._syncChanged;
  grid._syncChanged = false;
  // 1) 已经不符合筛选的卡片摘掉
  existing.forEach((el, name) => {
    if (visibleNames.includes(name)) return;
    el.remove();
    existing.delete(name);
    changed = true;
  });
  if (!grid._nodesBuilt) {
    // 卡片还在分批挂载：等它收尾再补，避免和挂载流程重复插同一张卡。
    grid._syncPending = groupName;
    if (changed) grid._syncChanged = true;
    return;
  }
  // 2) 缺卡的补回来，并保持 group.all 的顺序（插在上一个可见节点之后）
  let prev = null;
  visibleNames.forEach(name => {
    let el = existing.get(name);
    if (!el) {
      try {
        el = nodeCard(group, name, meta(name), dict, providerIndexCache);
      } catch (e) {
        console.warn('节点卡构建失败', name, e);
        return;
      }
      if (prev) prev.after(el); else grid.prepend(el);
      observeMarquee(el);
      existing.set(name, el);
      changed = true;
    }
    prev = el;
  });
  // 空态提示跟着走：有卡就别留着「没有符合当前筛选的节点」，没卡就要显示它
  const hint = grid.querySelector('.empty');
  if (existing.size) {
    if (hint) { hint.remove(); changed = true; }
  } else if (!hint) {
    grid.append(emptyHintEl());
    changed = true;
  }
  // 按提供商分组的小节头跟着卡片增删对齐（建/删/挪/改计数，不动节点卡本身）
  syncProviderHeaders(grid, group, dict, providerIndexCache, existing);
  // 卡片增删会改变「已隐藏 N 个」这类统计，顺手把统计行对齐
  if (changed) refreshProxyStats();
}

// ---------- 文字过长时滚动（节点名 / 组头「当前节点」共用） ----------
// 卡片宽度有限，长文本只显示一截；超宽的才挂上滚动。
// 注意卡片带 content-visibility: auto——屏幕外的卡片不参与布局，此时量到的
// 宽度是 0，所以测量必须等卡片真正进入视口再做（IntersectionObserver）。
let marqueeObserver = null;
function observeMarqueeClip(clip) {
  if (!clip) return;
  if (typeof IntersectionObserver === 'undefined') { measureMarquee(clip); return; }
  if (!marqueeObserver) {
    marqueeObserver = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        marqueeObserver.unobserve(e.target);   // 量过一次就不再关注
        measureMarquee(e.target);
      });
    }, { rootMargin: '160px 0px' });
  }
  marqueeObserver.observe(clip);
}
function observeMarquee(nodeEl) {
  observeMarqueeClip(nodeEl && nodeEl.querySelector ? nodeEl.querySelector('.proxy-node-name') : null);
}
// 组头「当前节点」行：创建时登记；选中节点变化后由 refreshNowMarquee 重测
function observeNowMarquee(nowEl) { observeMarqueeClip(nowEl); }
function refreshNowMarquee(clip) {
  if (!clip) return;
  clip.classList.remove('is-overflow');
  clip.style.removeProperty('--node-shift');
  // 已布局（在视口内）立即重量；还没布局的重新登记，等进视口再量
  if (clip.clientWidth) measureMarquee(clip);
  else observeMarqueeClip(clip);
}
// 卡片在「双排窄列」与「zashboard 整宽浮层」之间搬动时宽度会跳变：
// 搬完都要重新量一次「当前节点」这行的跑马灯状态，否则会拿旧宽度量出的
// 结论（滚/不滚）继续用，窄列够不着的名字在浮层里也可能已经放得下。
function refreshCardNowMarquee(card) {
  if (!card) return;
  refreshNowMarquee(card.querySelector('.proxy-group-now-clip'));
}

function measureMarquee(clip) {
  const text = clip.querySelector('.proxy-node-name-text, .proxy-group-now-text');
  if (!text) return;
  clip.classList.remove('is-overflow');
  clip.style.removeProperty('--node-shift');
  // 还没布局（比如在收起的组里）就先不判定，等它真正可见时再量。
  // 组头「当前：」前缀固定不滚：滚动 clip 是前缀之后的独立 flex 项，
  // 它的 clientWidth 天然就是名字的可滚宽度，无需再扣前缀。
  if (!clip.clientWidth) return;
  const distance = Math.max(0, text.scrollWidth - clip.clientWidth);
  if (distance > 2) {
    clip.style.setProperty('--node-shift', `${distance + 10}px`);
    clip.classList.add('is-overflow');
  }
}

// 与 zashboard 一致：第二行是「协议类型 / 能力」，不再单独挂一枚类型徽章
function nodeTypeText(apiProxy, type) {
  const caps = apiProxy && apiProxy.udp ? (apiProxy.xudp ? 'xudp' : 'udp') : '';
  return [type, caps].filter(Boolean).join(' / ');
}

function nodeCard(group, name, apiProxy, dict, pIndex) {
  const cfgMap = group.cfgMap || cfgProxyMap();
  const isGroup = !!(apiProxy && Array.isArray(apiProxy.all));
  const selected = group.now === name;
  const builtin = isBuiltinProxy(name, apiProxy);
  const direct = isDirectProxy(name, apiProxy);
  const compatible = isCompatibleProxy(name, apiProxy);
  const type = proxyType(name, apiProxy, cfgMap, pIndex);
  const initialDelay = delayValue(name, apiProxy);
  // DIRECT / COMPATIBLE 仍可测速并显示延迟；其它内置策略不显示无意义的延迟占位。
  const showDelay = !(builtin && !direct && !compatible);
  const delay = h('span', { class: 'proxy-node-delay' });
  setDelay(delay, showDelay ? initialDelay : null, { hidden: !showDelay, fail: nodeIsDead(name, apiProxy) });
  // 节点卡生成时就确定测速目标；代理组只追踪当前叶子节点，不批量测速整个组。
  const target = testTargetFor(name, apiProxy, dict, pIndex);
  const currentTarget = () => {
    const currentDict = liveData?.proxies || dict;
    return testTargetFor(name, nodeMeta(name, currentDict, providerIndexCache) || apiProxy, currentDict, providerIndexCache);
  };
  const testKey = group.name + '\u0000' + name;
  // 测速途中被重绘：新卡片要接着显示「测速中」，不能退回未测速
  if (showDelay && testing.has(testKey)) setDelay(delay, null, { loading: true });
  const canTest = isProxySpeedTestable(name, apiProxy) && !!target && !!group.live;
  const pillTitle = !showDelay ? ''
    : (!group.live ? '启动内核后才能测速'
      : (!target ? '暂无可测速节点'
        : (Number.isFinite(Number(initialDelay)) && Number(initialDelay) > 0
          ? `延迟 ${initialDelay} ms · 点击重新测速` : '未测速 · 点击测速')));
  // zashboard 里延迟胶囊本身就是测速入口，卡片上不再有独立的「测速」按钮
  const pill = h('button', {
    class: 'proxy-latency-tag' + (showDelay ? '' : ' is-hidden'),
    type: 'button', title: pillTitle,
    'aria-label': '测速此节点',
    disabled: !canTest || testing.has(testKey),
    onpointerdown: (ev) => {
      ev.stopPropagation();
      const node = ev.currentTarget.closest('.proxy-node');
      if (node) node.classList.add('speed-press');
    },
    onpointercancel: (ev) => {
      ev.stopPropagation();
      const node = ev.currentTarget.closest('.proxy-node');
      if (node) node.classList.remove('speed-press');
    },
    onclick: (ev) => {
      ev.stopPropagation();
      const node = ev.currentTarget.closest('.proxy-node');
      testOne(group, name, testKey, delay, ev.currentTarget, currentTarget());
      // 等本次点击的 active/focus 绘制完成后再恢复卡片状态，避免瞬间闪一下。
      setTimeout(() => { if (node) node.classList.remove('speed-press'); }, 80);
    },
  }, delay);
  const nodeEl = h('div', {
    class: `proxy-node${selected ? ' selected' : ''}${nodeIsDead(name, apiProxy) ? ' dead' : ''}`,
    dataset: { proxyNode: name },
    role: 'button', tabindex: '0', title: isGroup ? '点击将此代理组设为当前代理' : '点击切换此节点',
    // 与 zashboard 对齐：右键（桌面）/ 长按菜单（移动端）也能直接测速
    oncontextmenu: (ev) => {
      if (!canTest) return;
      ev.preventDefault();
      ev.stopPropagation();
      const tag = ev.currentTarget.querySelector('.proxy-latency-tag');
      testOne(group, name, testKey, delay, tag, currentTarget());
    },
    // 代理组作为另一个代理组的成员时，同样可以通过父组的 PUT /proxies/{父组}
    // 进行选择；不能因为成员自身有 all 字段就屏蔽点击。
    onclick: () => selectNode(group, name),
    onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(group, name); } },
  },
    h('div', { class: 'proxy-node-name', title: name }, h('span', { class: 'proxy-node-name-text', text: name })),
    h('div', { class: 'proxy-node-foot' },
      h('span', { class: 'proxy-node-type', title: nodeTypeText(apiProxy, type), text: nodeTypeText(apiProxy, type) }),
      pill));
  return nodeEl;
}

function paintSelections() {
  const page = document.getElementById('page-proxies');
  if (!page) return;
  page.querySelectorAll('.proxy-group-card').forEach(card => {
    const current = liveData?.proxies?.[card.dataset.proxyGroup];
    if (!current) return;
    // Update the same model used by pending lazy-card tasks; do not rebuild the grid.
    if (card._proxyGroup) { card._proxyGroup.now = current.now; card._proxyGroup.api = current; }
    // 「当前节点」文字在内部 span 里（跑马灯需要），只改 span 并重测滚动
    const nowClip = card.querySelector('.proxy-group-now');
    // 只改「当前」那一小段（.proxy-group-now-cur）：最终出站段
    // （.proxy-group-now-leaf）与它是同一个 clip 里的兄弟节点，下面
    // paintFinalOutbound 会接着重画叶子段，这里绝不能整体改 textContent。
    const nowText = nowClip && nowClip.querySelector('.proxy-group-now-cur');
    if (nowText) {
      const nowLabel = nowClip.querySelector('.proxy-group-now-label');
      if (nowLabel) nowLabel.textContent = '当前：';
      nowText.textContent = current.now || '未选择';
      // 前缀固定、整段滚动：按新内容重测可滚宽度
      refreshNowMarquee(nowClip.querySelector('.proxy-group-now-clip'));
    }
    // 选中变了，链尾叶子多半也跟着变：重画「→ 最终出站」
    paintFinalOutbound(card);
    syncGroupDelayChip(card);   // 选中节点变了，延迟 chip 跟着换
    card.querySelectorAll('.proxy-node').forEach(node => node.classList.toggle('selected', node.dataset.proxyNode === current.now));
  });
  // 全局模式：这一步可能刚把 GLOBAL 的选中项换成了另一个组，
  // 链上的组卡要跟着增减（集合没变就什么都不做）。
  syncGlobalChainCards(page);
}

async function syncProxySnapshot(revision) {
  const snapshot = await fetchProxySnapshot();
  if (revision !== proxyMutationRev) return; // a later write owns the state
  if (!adoptProxyData(snapshot.proxies)) return;
  if (snapshot.providers?.providers) {
    providerData = snapshot.providers;
    providerIndexCache = providerProxyMap(providerData);
  }
  bumpDataRev();
  paintSelections();
  syncProxyAvailability();
}

async function selectNode(group, name) {
  if (!group.live) { uiToast('当前是配置预览，请先启动内核后再切换节点', 3000); return; }
  if (String(group.api?.type || group.type).toLowerCase().replace(/[- ]/g, '') === 'loadbalance' || group.type === '负载均衡') return;
  if (selectingGroups.has(group.name)) return;
  selectingGroups.add(group.name);
  let revision = ++proxyMutationRev;
  try {
    // Like upstream: re-check an already-selected node before deciding to skip PUT.
    if ((liveData?.proxies?.[group.name]?.now || group.now) === name) {
      await syncProxySnapshot(revision);
      if (liveData?.proxies?.[group.name]?.now === name) return;
    }
    await putProxy(group.name, name);
    // Success acknowledgement, not optimistic full-page repaint.
    if (group.api) group.api.now = name;
    group.now = name;
    if (liveData?.proxies?.[group.name]) liveData.proxies[group.name].now = name;
    revision = ++proxyMutationRev;
    bumpDataRev();
    paintSelections();
    // 「切换节点断开连接」：断开经该组的旧连接（chains 含组名的那些），
    // 让它们立刻经新节点重建；直连/其他组的连接不受影响。断开是切换的附加
    // 动作，失败只记日志——选中态已生效，不能误报成「切换失败」。
    let closed = 0;
    if (proxyPrefs.disconnectOnSwitch) {
      try { closed = await closeGroupConnections(group.name); }
      catch (e) { uiLog('warn', '切换后断开旧连接失败：', group.name, e && e.message); }
    }
    uiToast(closed ? `已切换到：${name}（已断开 ${closed} 条连接）` : '已切换到：' + name, 2400);
    syncProxySnapshot(revision).catch(e => {
      if (revision === proxyMutationRev) uiToast('节点已提交，回读失败：' + e.message, 3000);
    });
  } catch (e) {
    uiToast('切换失败：' + e.message, 3600);
  } finally { selectingGroups.delete(group.name); }
}

window.addEventListener('mihomo-mode-changed', () => {
  const page = document.getElementById('page-proxies');
  if (page?._proxyMounted && page.isConnected) renderProxyData(page);
});

window.addEventListener('mihomo-providers-updated', event => {
  const snapshot = event.detail;
  if (!snapshot?.proxies?.proxies) return;
  ++allLatencyGeneration;
  ++proxyMutationRev;
  // Provider refresh may legitimately remove nodes; use the authoritative full snapshot.
  liveData = snapshot.proxies;
  if (snapshot.providers?.providers) {
    providerData = snapshot.providers;
    providerIndexCache = providerProxyMap(providerData);
  }
  loadedOnce = true;
  bumpDataRev();
  const page = document.getElementById('page-proxies');
  if (page?._proxyMounted && page.isConnected) renderProxyData(page);
});

function testPaths(name, apiProxy) {
  const slash = String(name).indexOf('/');
  const inferredProvider = slash > 0 ? String(name).slice(0, slash) : '';
  const inferredNode = slash > 0 ? String(name).slice(slash + 1) : String(name);
  const providerName = (apiProxy && (apiProxy._providerName || apiProxy['provider-name'] || apiProxy.providerName)) || inferredProvider;
  const proxyName = (apiProxy && apiProxy.name) || (providerName ? inferredNode : name);
  const query = '?url=' + encodeURIComponent(TEST_URL) + '&timeout=' + TEST_TIMEOUT;
  // 候选路径按顺序试：mihomo 把 provider 节点合并进 /proxies，多数情况第一个就成；
  // 少数核心对这个名字只认 provider 接口，届时再退回 healthcheck（见 fetchOneDelay）。
  const paths = ['/proxies/' + encodeURIComponent(name) + '/delay' + query];
  if (providerName) {
    paths.push('/providers/proxies/' + encodeURIComponent(providerName) + '/' + encodeURIComponent(proxyName) + '/healthcheck' + query);
  }
  return paths;
}

// 单节点按钮对嵌套代理组沿着 now 解析到当前叶子节点；批量测速是否使用
// /group/{name}/delay 由 testGroupAll 按 zashboard 的代理组类型决定。
function testTargetFor(name, apiProxy, dict, pIndex) {
  // 与延迟表同一个「走到叶子」的实现：测谁和显示谁的延迟必须是同一个节点，
  // 否则会出现「显示的延迟是 A 的，测的却是 B」这种口径不一致。
  const targetName = nowLeafName(name, dict, pIndex);
  let targetMeta = nodeMeta(targetName, dict, pIndex);
  if (!isProxySpeedTestable(targetName, targetMeta)) return null;
  const paths = testPaths(targetName, Object.assign({}, pIndex?.get(targetName), targetMeta));
  return { path: paths[0], paths, name: targetName };
}

function yieldForPaint() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

// 页面切到后台时 requestAnimationFrame 不会触发，并发测速里一个卡住的 rAF
// 会白占一整条通道，所以后台一律退回 setTimeout。
function nextPaint() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  return new Promise(resolve => requestAnimationFrame(resolve));
}

// ---------------------------------------------------------------
// 测速结论的判定口径（对齐 mihomo 内核实现，hub/route/proxies.go、groups.go）
//
//   GET /proxies/{name}/delay（以及 provider 的 .../healthcheck，共用同一处理器）
//     200 {"delay": N>0}                          → 可用
//     503 {"message":"An error occurred in the delay test"} → 测过但不通
//     504 {"message":"Timeout"}                   → 测速超时（内核同样记 delay=0 / alive=false）
//     404 {"message":"Resource not found"}        → 名字不认识：不是对节点的结论，换下一条路径
//   GET /group/{name}/delay
//     200 {成员名: 延迟}，**只收录测通的成员**；一个都没通 → 504
//
// 区分响应仅用于决定是否尝试另一条路径/组接口。候选都耗尽之后，
// 单测或批量补测仍失败，就像 Zashboard 的 one-by-one catch 一样写入 0；
// 显示失败、隐藏判断、计数必须使用同一结果，不能只改成叹号而保留旧正延迟。
// ---------------------------------------------------------------
// 桥通道（wget / 不带 -f 的 curl）拿不到状态码：这时按内核固定的错误文案兜底判定。
// 两个文案来自 mihomo 自己（newError("An error occurred in the delay test") /
// ErrRequestTimeout = "Timeout"），且只在响应体里出现，不会与传输层报错混淆。
const KERNEL_DEAD_MESSAGE = /^(an error occurred in the delay test|timeout)$/i;

// HTTP 状态码：直连通道放在 res.status，桥通道由 mihomo.sh 打在 stderr 上
function apiHttpStatus(res) {
  const direct = Number(res && res.status);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const m = String((res && res.stderr) || '').match(/MH_API_HTTP_STATUS=(\d{3})/);
  return m ? Number(m[1]) : 0;
}

// 一次延迟请求的结论：state = 'alive'（可用，带 delay）/ 'dead'（测过但不通）/ 'unknown'
function delayVerdict(res) {
  const parsed = parseJsonLoose(res && res.stdout);
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  const reason = String((body && (body.message || body.error)) || (res && res.stderr) || '').trim();
  if (body && 'delay' in body) {
    const n = Number(body.delay);
    if (Number.isFinite(n) && n > 0) return { state: 'alive', delay: n, reason: '' };
    return { state: 'dead', delay: 0, reason: reason || '延迟为 0' };
  }
  const status = apiHttpStatus(res);
  if (status === 503 || status === 504) return { state: 'dead', delay: 0, reason: reason || `内核 HTTP ${status}` };
  if (body && !status && !body.delay && KERNEL_DEAD_MESSAGE.test(reason)) return { state: 'dead', delay: 0, reason };
  return { state: 'unknown', delay: null, reason };
}

// 单节点测速专用请求：单次 HTTP 直取，多个节点天然并发。
//
// 逐个试候选路径，返回第一个「内核确实作答」的响应 —— 可用或不通都算作答，
// 只有空响应 / 404 / 400 这类「路径或名字不对」才换下一条路。
// 这样不会因为一个不通的节点就把等待时间翻倍，也才能拿到「确定不通」的结论。
async function fetchOneDelay(paths, budgetMs, request = apiGet) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  let last = { stdout: '', stderr: '', hit: false };
  for (const path of list) {
    const r = await request(path, { timeout: Math.max(1, Math.ceil((budgetMs || 15000) / 1000)) });
    const res = { stdout: (r && r.stdout) || '', stderr: (r && r.stderr) || '', status: (r && r.status) || 0, hit: false };
    const v = delayVerdict(res);
    res.hit = v.state !== 'unknown';
    res.verdict = v;
    last = res;
    if (res.hit) return res;
  }
  return last;
}

// 单节点接口拿不到结果时的最后兜底：用一次组测速取这一个节点的延迟。
// 典型场景是 provider 节点走 /proxies/{name}/delay 被内核判为不存在，
// 而组测速接口能正常返回它 —— 没有这层兜底就是「能批量测、单个却永远失败」。
// 返回 {delay}（可用）/ {dead:true}（内核把它测成 0）/ null（没拿到结果）。
async function fetchDelayViaGroup(group, nodeName) {
  try {
    const path = groupDelayPath(group.name);
    let stdout = '';
    {
      const r = await withTimeout(apiGet(path, { timeout: Math.ceil((GROUP_DELAY_BUDGET + 2000) / 1000) }), TEST_TIMEOUT + 4000);
      stdout = (r && r.stdout) || '';
    }
    const j = parseJsonLoose(stdout);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    if (!Object.prototype.hasOwnProperty.call(j, nodeName)) return null;   // 没出现在表里：不冒充结论
    const n = Number(j[nodeName]);
    return Number.isFinite(n) && n > 0 ? { delay: n } : { dead: true };
  } catch (e) {
    return null;
  }
}

async function testOne(group, name, testKey, delayEl, button, target) {
  if (allLatencyTesting || !group.live || !target) return;
  if (testing.has(testKey)) return;
  testing.add(testKey);
  // 先独立更新胶囊反馈，再让出一帧给浏览器绘制；胶囊反馈不依赖测速返回。
  if (button) {
    button.disabled = true;
    button.classList.add('is-testing');
    button.setAttribute('aria-busy', 'true');
  }
  // 每次写回都现找一次胶囊：测速途中页面可能重绘，旧引用已经摘出文档
  const write = (n, opts) => {
    const el = liveDelayEl(group.name, name) || delayEl;
    if (el) setDelay(el, n, opts);
  };
  write(null, { loading: true });
  let ok = null;      // 成功时是延迟数值
  let reason = '';
  let dead = false;   // 内核明确回答了「测过但不通」：可以记成不可用
  try {
    await yieldForPaint();
    // 预算 = 内核单节点超时 + 桥/轮询的富余
    const res = await fetchOneDelay(target.paths || [target.path], TEST_TIMEOUT + 4000);
    const v = res.verdict || delayVerdict(res);
    if (v.state === 'alive') ok = v.delay;
    else if (v.state === 'dead') { dead = true; reason = v.reason; }
    else reason = v.reason || '没有返回有效延迟';
  } catch (e) {
    reason = (e && e.message) ? String(e.message) : '测速请求失败';
  }
  // 内核没作答（桥超时 / 路径不对，不是「不通」）时，改用组测速接口再试一次
  let usedGroupTest = false;
  if (ok == null && !dead) {
    const g = await fetchDelayViaGroup(group, name);
    usedGroupTest = true;
    if (g && g.delay) { ok = g.delay; reason = ''; }
    else if (g && g.dead) { dead = true; reason = reason || '内核组测速未通过'; }
  }
  try {
    if (ok != null) {
      recordNodeLatency(name, ok);
      write(ok);
    } else {
      // Like Zashboard's one-by-one test catch: a failed completed test is 0.
      // Do not paint `!` while keeping an older positive availability sample.
      recordNodeLatency(name, 0);
      write(0, { fail: true });
      // 失败原因：胶囊悬浮可见，同时弹一次提示——单节点测速是明确的手动操作，
      // 静默失败只会让人以为是界面坏了。
      const msg = String(reason || '').trim().slice(0, 140);
      const pill = livePillEl(group.name, name);
      if (pill) pill.title = msg ? `测速失败：${msg}` : '测速失败';
      try { uiToast(`测速失败：${name}${msg ? ' — ' + msg : ''}`, 3600); } catch (e) { /* 提示失败不影响结果写回 */ }
    }
  } finally {
    testing.delete(testKey);
    // 胶囊可能已被重绘换掉：旧的那个已经不在文档里，恢复也要落到当前这个
    const pill = livePillEl(group.name, name) || button;
    if (pill) {
      pill.disabled = false;
      pill.classList.remove('is-testing');
      pill.removeAttribute('aria-busy');
    }
    // 可用性有结论就立刻对齐卡片：勾着「隐藏不可用节点」时测不通的节点马上消失，
    // 组兜底里顺带复测恢复的其它节点也会自己出现。
    syncProxyAvailability();
    // 走组测速接口、或所在组会自动改选时，回读一次刷新「当前选中」标记
    if (usedGroupTest || groupAutoSelects(group)) await refreshSelectionAfterTest();
  }
}

// ---------- 组头延迟胶囊点击测速 ----------
// zashboard 同款：组头的延迟胶囊本身就是测速入口，测的是该组当前选中链条
// 末端的叶子节点——不管这个组是展开还是收起都能点（双排紧凑卡、单列组头、
// 浮层整宽卡三处胶囊共用这一个函数，写回时直接找这张卡自己的胶囊，不走
// liveDelayEl／livePillEl 那套「按组名+成员名找节点卡片」的查找，避免叶子
// 恰好是组内直属成员、组又展开着时，结果被错写进节点列表里的那一行。
async function testGroupHeadDelay(group, dict, pIndex, card) {
  if (!card || allLatencyTesting || !group.live) return;
  const headKey = groupHeadTestKey(group.name);
  if (testing.has(headKey)) return;
  const liveDict = liveData?.proxies || dict;
  const target = testTargetFor(group.name, liveDict[group.name], liveDict, pIndex);
  if (!target) return;
  const leaf = target.name;
  // 每次写回都现找一次这张卡自己的胶囊：测速途中卡片可能被重绘换掉。
  const liveChips = () => [...card.querySelectorAll(':scope > .proxy-group-head .proxy-group-delaytag')];
  const write = (n, opts) => {
    liveChips().forEach(tag => {
      const inner = tag.querySelector('.proxy-node-delay');
      if (inner) setDelay(inner, n, opts);
    });
  };
  const setBusy = (busy) => {
    liveChips().forEach(tag => {
      tag.disabled = busy;
      tag.classList.toggle('is-testing', busy);
      if (busy) tag.setAttribute('aria-busy', 'true'); else tag.removeAttribute('aria-busy');
    });
  };
  testing.add(headKey);
  setBusy(true);
  write(null, { loading: true });
  let ok = null;
  let reason = '';
  let dead = false;
  let usedGroupTest = false;
  try {
    await yieldForPaint();
    const res = await fetchOneDelay(target.paths || [target.path], TEST_TIMEOUT + 4000);
    const v = res.verdict || delayVerdict(res);
    if (v.state === 'alive') ok = v.delay;
    else if (v.state === 'dead') { dead = true; reason = v.reason; }
    else reason = v.reason || '没有返回有效延迟';
  } catch (e) {
    reason = (e && e.message) ? String(e.message) : '测速请求失败';
  }
  if (ok == null && !dead) {
    const g = await fetchDelayViaGroup(group, leaf);
    usedGroupTest = true;
    if (g && g.delay) { ok = g.delay; reason = ''; }
    else if (g && g.dead) { dead = true; reason = reason || '内核组测速未通过'; }
  }
  try {
    if (ok != null) {
      recordNodeLatency(leaf, ok);
      write(ok);
    } else {
      recordNodeLatency(leaf, 0);
      write(0, { fail: true });
      const msg = String(reason || '').trim().slice(0, 140);
      try { uiToast(`测速失败：${leaf}${msg ? ' — ' + msg : ''}`, 3600); } catch (e) { /* 提示失败不影响结果写回 */ }
    }
  } finally {
    testing.delete(headKey);
    setBusy(false);
    syncProxyAvailability();
    if (usedGroupTest || groupAutoSelects(group)) await refreshSelectionAfterTest();
    syncGroupDelayChip(card);   // 落定一次，保证最终显隐/数值与全局口径一致
  }
}

function speedTestGroupType(group) {
  const raw = (group && group.api && group.api.type) || (group && group.cfg && group.cfg.type) || '';
  return String(raw || '').trim().toLowerCase().replace(/_/g, '-');
}

function groupDelayPath(name) {
  return '/group/' + encodeURIComponent(name) + '/delay?url=' +
    encodeURIComponent(TEST_URL) + '&timeout=' + BATCH_TIMEOUT;
}

// 给 promise 套总预算：内核不支持组接口或进程卡住时不能一直挂着，
// 超时就放弃这次结果，交给下面的并发补测兜底。
function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  let timer = 0;
  const guard = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, guard]).finally(() => { clearTimeout(timer); });
}

// 一次请求让内核测完整组，返回 { 成员名: 延迟 }（0 表示测了但不通）；
// 拿不到可信结果时返回 null。这是最快的路径：前端只有一个请求在飞，
// 并发完全发生在内核内部，UI 和桥都没有压力。
async function fetchGroupDelays(groupName, names, request = apiGet) {
  try {
    // 单次请求直取：并发完全发生在内核内部，UI 和桥都没有压力。
    let j = null;
    {
      const r = await withTimeout(
        request(groupDelayPath(groupName), { timeout: Math.ceil((GROUP_DELAY_BUDGET + 2000) / 1000) }),
        GROUP_DELAY_BUDGET);
      j = r ? parseJsonLoose(r && r.stdout) : null;
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const out = new Map();
    names.forEach(name => {
      // 内核对这个成员的写法不一致（数值 / 0 / null），只认自己能识别的成员名；
      // 没出现的名字留给后面的补测，不在这里冒充结果。
      if (!Object.prototype.hasOwnProperty.call(j, name)) return;
      const n = Number(j[name]);
      out.set(name, Number.isFinite(n) && n > 0 ? n : 0);
    });
    // 一个成员都没回应才算组接口不可用（返回空对象 / 错误体），整批作废走补测。
    // 回应了但值是 0 不代表接口坏了——那更可能是节点真的不通，直接显示失败；
    // 否则几十个不通的节点会白白再跑一轮，前台按钮跟着变卡。
    return out.size ? out : null;
  } catch (e) {
    return null;
  }
}

function setBatchButtonBusy(button, busy) {
  if (!button) return;
  if (busy) {
    // 真正禁用原生按钮，避免测速中的第二次 pointer/click 事件进入桥；
    // 外观由 is-testing 自己控制，不使用默认灰色样式。
    button.innerHTML = ALL_LATENCY_SPINNER;
    button.disabled = true;
    button.dataset.batchBusy = 'true';
    button.classList.add('is-testing');
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
  } else {
    button.innerHTML = ALL_LATENCY_ICON;
    button.disabled = false;
    delete button.dataset.batchBusy;
    button.classList.remove('is-testing');
    button.removeAttribute('aria-busy');
    button.removeAttribute('aria-disabled');
  }
}

function syncBatchButtons(groupName, busy) {
  const page = document.getElementById('page-proxies');
  if (!page) return;
  page.querySelectorAll('.proxy-group-card').forEach(cardEl => {
    if (cardEl.dataset.proxyGroup !== groupName) return;
    setBatchButtonBusy(cardEl.querySelector('.proxy-batch-btn'), busy);
  });
}

// Collect all real leaf nodes independently of current mode, visibility and lazy DOM.
function allLatencyJobs() {
  const dict = liveData?.proxies || {};
  const jobs = new Map();
  for (const name of new Set([...Object.keys(dict), ...providerIndexCache.keys()])) {
    const meta = nodeMeta(name, dict, providerIndexCache);
    if (retainedByZashboard(meta) || !isLatencyTestable(name, meta)) continue;
    const identity = latencyIdentity(name, meta);
    if (!jobs.has(identity)) jobs.set(identity, { name });
  }
  return [...jobs.values()];
}
function syncAllLatencyButtons() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.proxy-test-all-btn').forEach(button => {
    button.disabled = allLatencyTesting || !Number(state.status?.running) || !liveData?.proxies;
    button.setAttribute('aria-busy', String(allLatencyTesting));
    button.title = allLatencyTesting ? `测速所有节点（${allLatencyDone}/${allLatencyTotal}）` : '测速所有节点';
    const busy = String(allLatencyTesting);
    if (button.dataset.testing !== busy) {
      button.dataset.testing = busy;
      button.innerHTML = allLatencyTesting ? ALL_LATENCY_SPINNER : ALL_LATENCY_ICON;
    }
  });
}
// All/group buttons share testGroupAll: kernel group delay first, then the
// SAME eight-lane fallback. This request gate is shared across all active groups
// so three group tasks cannot silently multiply fallback concurrency to 24.
function createBatchRequestGate(current) {
  let active = 0;
  const queue = [], cache = new Map();
  const drain = () => {
    while (active < BATCH_CONCURRENCY && queue.length) {
      const { path, opts, resolve, reject } = queue.shift();
      if (!current()) { resolve(null); continue; }
      ++active;
      Promise.resolve().then(() => apiGet(path, opts)).then(resolve, reject)
        .finally(() => { --active; drain(); });
    }
  };
  return (path, opts) => {
    if (!current()) return Promise.resolve(null);
    if (!cache.has(path)) cache.set(path, new Promise((resolve, reject) => {
      queue.push({ path, opts, resolve, reject }); drain();
    }));
    return cache.get(path);
  };
}
async function testAllNodes() {
  if (allLatencyTesting || !Number(state.status?.running) || !liveData?.proxies) return;
  if (testing.size || batchTestingGroups.size) {
    uiToast('已有节点测速进行中，请稍后再试', 2400); return;
  }
  const jobs = allLatencyJobs();
  if (!jobs.length) { uiToast('暂无可测速节点', 2400); return; }
  const generation = allLatencyGeneration, pid = currentKernelPid();
  const current = () => generation === allLatencyGeneration && pid === currentKernelPid()
    && !!Number(state.status?.running) && !!liveData?.proxies;
  const dict = liveData.proxies, pIndex = providerIndexCache;
  // Assign each real leaf to one owning group; group endpoints may internally
  // cover overlapping membership, but frontend results/fallbacks are deduplicated.
  const remaining = new Map(jobs.map(job => [latencyIdentity(job.name, nodeMeta(job.name, dict, pIndex)), job]));
  const groups = [];
  for (const [name, api] of Object.entries(dict)) {
    if (!Array.isArray(api?.all)) continue;
    const all = api.all.filter(member => {
      const meta = nodeMeta(member, dict, pIndex);
      if (retainedByZashboard(meta)) return false;
      return remaining.delete(latencyIdentity(member, meta));
    });
    if (all.length) groups.push({ name, all, api, live: true });
  }
  if (remaining.size) groups.push({ name: '\u0000all-unassigned',
    all: [...remaining.values()].map(job => job.name), api: { type: 'Selector' }, live: true, skipGroupDelay: true });
  allLatencyTesting = true; allLatencyDone = 0; allLatencyTotal = jobs.length;
  syncAllLatencyButtons();
  const results = new Map();
  const session = {
    current, request: createBatchRequestGate(current),
    onResult(name, delay) {
      results.set(latencyIdentity(name, nodeMeta(name, dict, pIndex)), delay);
      allLatencyDone = results.size; syncAllLatencyButtons();
    },
  };
  let cursor = 0;
  try {
    uiToast(`正在测速所有节点（共 ${jobs.length} 个）`, 1800);
    const lane = async () => {
      while (current()) {
        const group = groups[cursor++]; if (!group) return;
        await testGroupAll(group, dict, pIndex, null, { session, skipGroupDelay: !!group.skipGroupDelay });
      }
    };
    await Promise.all(Array.from({ length: Math.min(ALL_GROUP_CONCURRENCY, groups.length) }, lane));
    if (current()) {
      await refreshSelectionAfterTest();
      const success = [...results.values()].filter(value => value > 0).length;
      if (current()) uiToast(`所有节点测速完成：成功 ${success}，失败 ${results.size - success}，共 ${jobs.length} 个`, 3600);
    }
  } catch (e) {
    uiToast('所有节点测速失败：' + (e?.message || String(e)), 3600);
  } finally {
    allLatencyTesting = false;
    syncAllLatencyButtons(); syncProxyAvailability();
  }
}

async function testGroupAll(group, dict, pIndex, batchBtn, options = {}) {
  // 测速中用原生 disabled 阻断第二次事件，避免正在跑的这一批请求被再触发一次；
  // 锁放在代理组状态而不是按钮 DOM 上，页面重绘后也不能绕过。
  if ((allLatencyTesting && !options.session) || !group.live || batchTestingGroups.has(group.name)) return;
  const generation = allLatencyGeneration, pid = currentKernelPid();
  const current = options.session?.current || (() => generation === allLatencyGeneration
    && pid === currentKernelPid() && !!Number(state.status?.running) && !!liveData?.proxies);
  if (!current()) return;
  const request = options.session?.request || apiGet;
  const batchResults = new Map();
  const record = (name, value) => {
    if (!current()) return;
    batchResults.set(name, value);
    recordNodeLatency(name, value); options.session?.onResult(name, value);
  };
  batchTestingGroups.add(group.name);
  syncBatchButtons(group.name, true);
  setBatchButtonBusy(batchBtn, true);
  // 先让浏览器真正绘制闪电按钮的点击反馈，再做节点收集和测速准备。
  await yieldForPaint();
  if (!current()) {
    batchTestingGroups.delete(group.name); syncBatchButtons(group.name, false);
    setBatchButtonBusy(batchBtn, false); return;
  }
  const page = document.getElementById('page-proxies');
  const groupEl = page && [...page.querySelectorAll('.proxy-group-card')]
    .find(el => el.dataset.proxyGroup === group.name);
  const delayEls = new Map();
  if (groupEl) {
    // 收起的组还没有卡片 DOM，这里补建（分批，不阻塞）。
    // 来不及建的卡片拿不到 delayEl，结果仍会进入统一延迟样本，之后展开/重绘时自然显示。
    if (groupEl._mountNodes) groupEl._mountNodes(false);
    groupEl.querySelectorAll('.proxy-node').forEach(node => {
      const name = node.dataset.proxyNode;
      if (name) delayEls.set(name, node.querySelector('.proxy-node-delay'));
    });
  }

  // 与外部面板一样先过滤不可测速项目，但「隐藏不可用节点」筛掉的节点照样要测：
  // 它们当初就是因为不通才被藏起来的，不测就永远不知道它已经恢复，
  // 于是「测速当前代理组后可用节点一直不回来」。它们没有卡片，
  // 结果只更新健康状态与缓存，收尾时再由 syncGroupCardNodes 决定要不要显示。
  const items = [];
  group.all.forEach(name => {
    const meta = nodeMeta(name, dict, pIndex);
    if (!isProxySpeedTestable(name, meta)) return;
    const key = group.name + '\u0000' + name;
    if (testing.has(key)) return;
    // 与卡片显示保持同一套 Zashboard 保留规则
    const hidden = !keepWhenHidingDead(name, meta);
    items.push({ name, key, meta, hidden, delayEl: hidden ? null : (delayEls.get(name) || null), done: false });
  });
  if (!items.length) {
    batchTestingGroups.delete(group.name);
    syncBatchButtons(group.name, false);
    setBatchButtonBusy(batchBtn, false);
    if (!options.session && current()) uiToast(`代理组「${group.name}」暂无可测速节点`, 2400);
    return;
  }

  // 批量结果合帧写入，避免节点数量大时每个响应都触发一次布局和绘制。
  const paintQueue = new Map();
  let paintRaf = 0;
  // 以 item 为键（同一节点多次写入只保留最后一次），写回时现找胶囊：
  // 批量测速期间页面重绘会把旧引用摘出文档，直接写会写进孤儿节点。
  const paint = (item, n, opts) => {
    // 被筛选隐藏的节点没有卡片：结果已经进入统一延迟样本，
    // 收尾时该出现的节点会带着这次的延迟一起建出来。
    if (item.hidden || !current()) return;
    paintQueue.set(item, { n, opts });
    if (!paintRaf) {
      paintRaf = requestAnimationFrame(() => {
        if (!current()) { paintQueue.clear(); paintRaf = 0; return; }
        paintQueue.forEach((v, item) => {
          const el = liveDelayEl(group.name, item.name) || item.delayEl;
          if (el) setDelay(el, v.n, v.opts);
        });
        paintQueue.clear();
        paintRaf = 0;
      });
    }
  };

  // 组接口常常不到一秒就返回，立刻刷状态反而闪一下；慢到阈值才给测速中反馈。
  const hintTimer = setTimeout(() => {
    items.forEach(item => {
      if (item.done || !current()) return;
      const el = liveDelayEl(group.name, item.name) || item.delayEl;
      if (el) setDelay(el, null, { loading: true });
    });
  }, PENDING_HINT_MS);

  try {
    // 第一优先：mihomo 的组测速接口。一次请求测完整组，并发发生在内核内部，
    // 前端只有一个请求在飞，所以既最快也完全不影响展开和滚动。
    const groupDelays = options.skipGroupDelay ? null : await fetchGroupDelays(group.name, items.map(item => item.name), request);
    if (!current()) return;
    if (groupDelays) {
      items.forEach(item => {
        if (!groupDelays.has(item.name)) return;
        const n = groupDelays.get(item.name);
        item.done = true;
        record(item.name, n);
        // 0 是内核明确测过但不通，直接显示失败；不再丢进补测空耗一轮。
        if (n > 0) { paint(item, n); }
        else paint(item, 0, { fail: true });
      });
    }
    // 剩下的多是嵌套组（组接口只测第一层，不递归到叶子）和组接口没返回的成员，
    // 交给并发池补测；绝大多数普通组走到这里时已经全部完成。
    const pending = items.filter(item => !item.done);
    if (!pending.length) return;

    // 同一个测试路径的多个节点合并成一个请求，结果一次性写回所有卡片。
    const byPath = new Map();
    pending.forEach(item => {
      const target = testTargetFor(item.name, item.meta, dict, pIndex);
      if (!target) return;
      const path = batchPath(target.path);
      let job = byPath.get(path);
      if (!job) { job = { target: { path, paths: target.paths.map(batchPath) }, items: [] }; byPath.set(path, job); }
      job.items.push(item);
    });
    const jobs = [...byPath.values()];
    jobs.forEach(job => job.items.forEach(item => testing.add(item.key)));
    // 每路补测的结论：{delay} 可用 / {dead:true} 内核测过但不通 / null 没拿到结论
    const settleJob = (job, verdict) => {
      if (!current()) return;
      if (verdict && verdict.dead) {
        // 内核明确判不通 → 记成不可用：勾着「隐藏不可用节点」时卡片立刻消失
        job.items.forEach(item => { record(item.name, 0); paint(item, 0, { fail: true }); });
      } else if (verdict && Number.isFinite(verdict.delay) && verdict.delay > 0) {
        job.items.forEach(item => {
          record(item.name, verdict.delay);
          paint(item, verdict.delay);
        });
      } else {
        // An exhausted/throwing fallback is a failed completed sample too.
        job.items.forEach(item => { record(item.name, 0); paint(item, 0, { fail: true }); });
      }
      job.items.forEach(item => testing.delete(item.key));
    };

    // 后台通道不可用时的统一兜底：浏览器侧滑窗并发，并发度不变。
    const runLanePool = async (list) => {
      if (!list.length) return;
      const lanes = Math.max(1, Math.min(BATCH_CONCURRENCY, list.length));
      let cursor = 0;
      const runLane = async () => {
        while (current()) {
          const index = cursor++;
          if (index >= list.length) return;
          const job = list[index];
          await waitForBatchIdle();
          if (!current()) return;
          let verdict = null;
          try {
            // 走与单节点测速同一套判定：组接口漏掉的成员多是测不通的，
            // 这里必须把 503/504 认成「确定不通」，否则它们永远不会被隐藏。
            const res = await fetchOneDelay(job.target.paths, BATCH_TIMEOUT + 4000, request);
            const v = res.verdict || delayVerdict(res);
            verdict = v.state === 'dead' ? { dead: true }
              : v.state === 'alive' ? { delay: v.delay } : null;
          } catch (e) {
            verdict = null;
          }
          settleJob(job, verdict);
          await nextPaint();
        }
      };
      await Promise.all(Array.from({ length: lanes }, runLane));
    };

    // 并发池：每路都是一次独立的 HTTP 请求，天然并发，无需点火 + 轮询。
    await runLanePool(jobs);

  } finally {
    clearTimeout(hintTimer);
    // 无论请求失败、页面离开还是桥命令异常，都恢复整个代理组的批量按钮。
    items.forEach(item => testing.delete(item.key));
    if (paintRaf) await new Promise(resolve => requestAnimationFrame(resolve));
    // 这一批里可用性变过的节点，按当前筛选就地增删卡片：
    // 恢复可用的立刻出现（不等下次刷新），测不通的收起。
    syncProxyAvailability();
    batchTestingGroups.delete(group.name);
    syncBatchButtons(group.name, false);
    setBatchButtonBusy(batchBtn, false);
    // 自动选择类组（URLTest / Fallback）测完会换节点：回读一次刷新选中态
    if (current() && !options.session && groupAutoSelects(group)) await refreshSelectionAfterTest();
    // Global batches already have one aggregate toast. Only a fully completed,
    // still-current manual group batch reports a per-group result here.
    if (!options.session && current() && batchResults.size === new Set(items.map(item => item.name)).size) {
      const success = [...batchResults.values()].filter(value => value > 0).length;
      uiToast(`代理组「${group.name}」测速完成：成功 ${success}，失败 ${batchResults.size - success}，共 ${batchResults.size} 个`, 3600);
    }
  }
}

// 接口失败时把「到底是没返回、还是返回了但解析不了」讲清楚。
// 以前一律是「内核未返回代理列表」，看不出区别，只能靠猜；而这两类
// 失败的原因完全不同（一个在通道/内核侧，一个在数据格式侧）。
function describeApiFailure(path, r, j) {
  const raw = String((r && r.stdout) || '');
  const err = String((r && r.stderr) || '').trim();
  const status = apiHttpStatus(r);
  const parts = [
    `请求 ${path}`,
    `errno=${r && r.errno !== undefined ? r.errno : '?'}`,
    status ? `HTTP ${status}` : '',
    `返回 ${raw.length} 字节`,
    j ? '解析成功但缺少 proxies 字段' : '解析失败',
  ].filter(Boolean);
  if (err) parts.push(`stderr=${err.slice(0, 200)}`);
  // 只截取开头：足够判断是 JSON、HTML 错误页还是空响应
  if (raw) parts.push(`开头=${raw.slice(0, 160).replace(/\s+/g, ' ')}`);
  return parts.join(' | ');
}

// 节点元数据匹配诊断。订阅节点的协议类型全变「未知」时，原因通常是
// 「组里的名字」和「接口返回的键」写法对不上；这里把两边样例都列出来，
// 一眼就能看出差在哪（有没有 provider 前缀、有没有多余空格/emoji 等）。
function collectMetaDiag() {
  const dict = liveData && liveData.proxies && typeof liveData.proxies === 'object' ? liveData.proxies : {};
  const pIndex = providerIndexCache;
  const groups = liveGroups(liveData);
  const all = new Set(groups.flatMap(g => g.all));
  const missing = [];
  all.forEach(n => { if (!nodeMeta(n, dict, pIndex)) missing.push(n); });
  const lines = [];
  lines.push(`代理组 ${groups.length} · 节点 ${all.size} · 未匹配 ${missing.length}`);
  lines.push('');
  lines.push(`/proxies 键数量: ${Object.keys(dict).length}`);
  lines.push(`provider: ok=${providerDiag.ok} 订阅数=${providerDiag.count} 索引节点=${providerDiag.indexed || 0} 响应字节=${providerDiag.bytes || 0}`);
  if (providerDiag.error) lines.push(`provider 错误: ${providerDiag.error}`);
  lines.push('');
  if (missing.length) {
    lines.push(`未匹配节点（前 8 个）:`);
    missing.slice(0, 8).forEach(n => lines.push(`  [${n}]`));
    lines.push('  JSON: ' + JSON.stringify(missing.slice(0, 8)));
  }
  const keys = Object.keys(dict);
  if (keys.length) {
    lines.push('');
    lines.push(`/proxies 键样例（前 8 个）:`);
    keys.slice(0, 8).forEach(k => lines.push(`  [${k}]`));
    lines.push('  JSON: ' + JSON.stringify(keys.slice(0, 8)));
  }
  if (pIndex && pIndex.size) {
    const pk = [...pIndex.keys()];
    lines.push('');
    lines.push(`provider 索引键样例（前 8 个，共 ${pk.length}）:`);
    pk.slice(0, 8).forEach(k => lines.push(`  [${k}]`));
    lines.push('  JSON: ' + JSON.stringify(pk.slice(0, 8)));
  }
  return lines.join('\n');
}

function showMetaDiag() {
  const text = collectMetaDiag();
  const pre = h('pre', {
    class: 'logbox', style: 'max-height:52vh;white-space:pre-wrap;word-break:break-all;font-size:11.5px',
    text,
  });
  const copyBtn = h('button', { class: 'btn block pri', text: '复制诊断结果', style: 'margin-top:10px' });
  copyBtn.onclick = async () => {
    try { await copyText(text); uiToast('诊断结果已复制'); closeSheet(); }
    catch (e) { uiToast('复制失败，请长按选择文本'); }
  };
  openSheet('节点匹配诊断', pre, copyBtn);
}

// 启动宽限：内核进程拉起到 external-controller 开始监听有一小段空窗（实机几百毫秒～数秒）。
// 这段时间 /proxies 连不上是「还没好」而不是「坏了」——不应弹红字，静默等它就绪。
// 触发来源：① 总开关刚按下启动；② 重启服务按下瞬间（app.js cue）；③ 内核配置刚生效
// （invalidateProxyData：保存后重启 / 热重载 / 服务重启）；④ 状态显示内核刚起不久（uptime_sec 很小）。
let coreStartingUntil = 0;
// 只延长不缩短：多个入口（总开关 30s、重启 cue、配置生效 20s）可能先后调用，
// 后到的短窗口不能把先到的长窗口截短。
export function markCoreStarting(ms = 30000) {
  const until = Date.now() + ms;
  if (until > coreStartingUntil) coreStartingUntil = until;
}
function inStartGrace() {
  if (Date.now() < coreStartingUntil) return true;
  const st = state.status;
  const up = st ? Number(st.uptime_sec) : NaN;
  return !!(st && Number(st.running) && Number.isFinite(up) && up >= 0 && up < 20);
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 总开关已关：内核没在跑，/proxies 必然连不上。此时任何网络尝试（连接失败 → 重试 →
// provider 降级逐个取）都只是空等，白白让用户盯几秒骨架。
function coreIsStopped() {
  return !!(state.status && !Number(state.status.running));
}

async function loadProxyData(el, force = false, soft = false) {
  if (!el) return;
  if (coreIsStopped()) {   // 停止态：不发任何请求，直接出「内核未运行」
    liveData = null;
    loadedOnce = true;
    if (el.isConnected) renderProxyData(el);
    return;
  }
  if (loading) return;
  if (!force && liveData) { renderProxyData(el); return; }
  loading = true;
  // 软刷新且已有旧数据：中途不重绘（/proxies 先回、provider 后回会各画一次），
  // 等两路齐了只换一次，避免「先变一次、再变一次」的多次闪动。
  const quietFirst = soft && !!liveData;
  const revision = proxyMutationRev;
  liveError = '';
  // 先显示 /proxies 的组列表，provider 元数据在后台补齐；不让第二个请求阻塞首屏。
  const proxyPromise = apiGet('/proxies', { big: true });
  // trim：服务端只保留每个节点最近 3 条延迟 history。上百个订阅节点时这个
  // 响应能到几 MB，过 CGI 桥会被压垮（拿到空响应 → 节点类型全未知）。
  // 留 3 条是为了保住延迟显示：显示与过滤均取最后一条 history，不向前寻找旧的成功值。
  const providerPromise = apiGet('/providers/proxies', { big: true, trim: true })
    .catch(e => ({ errno: -1, stdout: '', stderr: String(e) }));
  try {
    let r = await proxyPromise;
    let j = parseJsonLoose(r && r.stdout);
    if ((!j || !j.proxies) && !liveData && inStartGrace() && !coreIsStopped()) {
      // 内核刚启动、控制器还没监听：骨架原样保留，每 0.7 秒静默重试，最多约 9 秒。
      // 静默等待期间给出解释；软刷新不写（旧内容原样保留，不闪状态行）
      if (!soft) setProxySummary(el, '内核启动中，等待代理列表…');
      for (let i = 0; i < 13 && (!j || !j.proxies); i++) {
        await sleep(700);
        if (revision !== proxyMutationRev || coreIsStopped()) break;
        r = await apiGet('/proxies', { big: true });
        j = parseJsonLoose(r && r.stdout);
      }
    }
    if ((!j || !j.proxies) && !coreIsStopped()) {
      // 大响应偶发一次拿不全（CGI 往返 + base64），重试一次再判失败。
      // 不重试的话整页会退回配置预览，节点协议类型全变「未知」。
      r = await apiGet('/proxies', { big: true });
      j = parseJsonLoose(r && r.stdout);
    }
    if (!j || !j.proxies) {
      // 已有可用数据时不因为一次失败就把整页清空：代价太大，
      // 而且这次失败很可能只是偶发的超时/截断。
      if (!liveData) throw new Error(describeApiFailure('/proxies', r, j));
      liveError = describeApiFailure('/proxies', r, j);
    } else if (revision === proxyMutationRev && !adoptProxyData(j)) {
      liveError = '新数据不完整，已保留上一次的代理列表';
    }
    bumpDataRev();
    if (!quietFirst && revision === proxyMutationRev && el.isConnected) renderProxyData(el);
  } catch (e) {
    liveError = e && e.message ? e.message : String(e);
    // 同上：只有确实没有数据时才置空，否则保留旧列表继续用
    if (!liveData) {
      providerData = null;
      providerIndexCache = new Map();
      bumpDataRev();
    }
  }
  if (coreIsStopped()) {   // 加载途中被关：跳过 provider 阶段（重试 + 逐个降级最慢）
    loading = false;
    loadedOnce = true;
    liveData = null;
    if (el.isConnected) renderProxyData(el);
    return;
  }
  try {
    let pr = await providerPromise;
    let pj = parseJsonLoose(pr && pr.stdout);
    if (pj && pj.providers) {
      providerDiag = { ok: true, count: Object.keys(pj.providers).length, bytes: (pr.stdout || '').length, error: '' };
    } else {
      // 订阅节点只存在于这个接口里：/proxies 通常不含它们，provider 一失败
      // 整片节点就只剩名字、类型全变「未知」。所以这里也要重试一次。
      pr = await apiGet('/providers/proxies', { big: true, trim: true });
      pj = parseJsonLoose(pr && pr.stdout);
      if (pj && pj.providers) {
        providerDiag = { ok: true, count: Object.keys(pj.providers).length, bytes: (pr.stdout || '').length, error: '' };
      } else {
        // 全量接口仍然拿不到（内核不支持 / 响应依旧过大）：退一步按订阅逐个取。
        // 单次只拉一个订阅，响应体积小一个量级，成功率远高于全量。
        const part = await loadProvidersOneByOne();
        if (part) {
          pj = part;
          providerDiag = { ok: true, count: Object.keys(pj.providers).length, bytes: part._bytes || 0, error: '（已降级：按订阅逐个获取）' };
        } else {
          providerDiag = {
            ok: false, count: 0, bytes: (pr.stdout || '').length,
            error: describeApiFailure('/providers/proxies', pr, pj) + (part === null ? ' | 逐个降级也未取到' : ''),
          };
        }
      }
    }
    if (pj && pj.providers && revision === proxyMutationRev) {
      providerData = pj;
      providerIndexCache = providerProxyMap(providerData);
      providerDiag.indexed = providerIndexCache.size;
    } else {
      // 失败时保留上一次的索引，绝不清空。
      // 订阅节点只存在于 provider 接口里，/proxies 通常不含它们 —— 索引一清，
      // 整片节点就只剩名字、协议类型全变「未知」。而切换节点这类频繁操作
      // 会反复触发重新加载，provider 偶发一次超时就把整页信息搞坏，代价太大。
      providerDiag.indexed = providerIndexCache.size;
    }
    bumpDataRev();
    if (revision === proxyMutationRev && liveData && el.isConnected) renderProxyData(el);
  } catch (e) {
    // 旧版核心没有 provider API 时，普通 /proxies 节点仍然可以正常显示和测速。
    providerDiag = { ok: false, count: 0, indexed: providerIndexCache.size, error: String(e && e.message || e) };
    if (quietFirst && revision === proxyMutationRev && liveData && el.isConnected) renderProxyData(el);
  }
  loading = false;
  loadedOnce = true;
  if (revision !== proxyMutationRev && !liveData && el.isConnected) {
    // 失效（或更新的写操作）发生在这次加载途中：在途数据已作废且尚无数据，
    // 重新排一次加载，否则页面会停在空列表上直到下次切页。
    // 正常失败时 revision 一致，不走这里，不会循环重试。
    renderProxyPage(el);
    return;
  }
  if (el.isConnected && !liveData) renderProxyData(el);
  if (softPending) {
    softPending = false;
    if (el.isConnected) loadProxyData(el, true, true);
  }
}

export function renderProxyPage(el) {
  if (!el) return;
  if (coreIsStopped()) {
    // 停止态直出：不挂骨架、不排队、也不被在途加载挡住——进页面即见「内核未运行」。
    if (!el._proxyMounted) { el._proxyMounted = true; renderShell(el); }
    liveData = null;
    loadedOnce = true;
    renderProxyData(el);
    return;
  }
  if (!el._proxyMounted) {
    el._proxyMounted = true;
    renderShell(el);
    setProxySummary(el, '正在读取代理列表…');
    const body = el.querySelector('.proxy-groups');
    // 初始骨架同样遵守双排布局：首屏形态与数据落地后一致，不闪单列再跳双列
    const cols = proxyPrefs.twoColumn ? appendDualScaffold(body) : null;
    for (let i = 0; i < 3; i++) {
      const sk = skeletonGroup(0);
      if (cols) cols.children[i % 2].append(sk); else body.append(sk);
    }
  }
  // 点击处理栈不同步发请求；boot 的重复渲染复用待执行/在途加载。
  if (el._proxyScheduled || loading) return;
  el._proxyScheduled = true;
  requestAnimationFrame(() => setTimeout(() => {
    el._proxyScheduled = false;
    if (!el.isConnected) return;
    loadProxyData(el, !!liveData);
  }, 0));
}
