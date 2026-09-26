import { putProxy, fetchProxySnapshot } from './mihomo-api.js';
// ============================================================
// 代理页：参考 zashboard 的代理组 / 节点面板
// 运行时数据来自 mihomo REST API；配置页仍负责编辑 YAML。
// ============================================================
import { h, state, cmdline, shell, parseJsonLoose, shq, uiToast, note, card, badge, openSheet, closeSheet, copyText, onCoreConfigApplied } from './core.js';
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
// 「隐藏不可用」不能把它们误删。

let liveData = null;
let loadedOnce = false;   // 首次 /proxies 往返是否结束（决定要不要画骨架屏）
let deadCountEl = null;   // 「隐藏不可用」开关上的数量标签（renderShell 创建）
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
const delayCache = new Map();
// 测速结果跨刷新留存：页面一刷新内存缓存就没了，延迟只能靠内核 history 恢复。
// 存一份，刷新后立刻能显示上次测到的值（两个环境行为一致，不搞特例）。
const DELAY_STORE_TTL = 12 * 3600 * 1000;   // 12 小时：太久的延迟没有参考价值
const DELAY_STORE_MAX = 3000;               // 条目上限，防止长期累积
const delayStore = (() => {
  const m = new Map();
  const raw = loadState('proxy-delay', {});
  const now = Date.now();
  Object.keys(raw || {}).forEach(k => {
    const e = raw[k];
    const v = Number(e && e.v);
    const t = Number(e && e.t);
    if (Number.isFinite(v) && v > 0 && Number.isFinite(t) && now - t < DELAY_STORE_TTL) m.set(k, v);
  });
  return m;
})();
function serializeDelayStore() {
  const now = Date.now();
  const out = {};
  let count = 0;
  delayStore.forEach((v, k) => {
    if (count >= DELAY_STORE_MAX) return;
    out[k] = { v, t: now };
    count++;
  });
  return out;
}
// 合批落盘：批量测速一次会写几十条，逐条写存储没必要
const saveDelayStore = makeThrottledSaver('proxy-delay', 1500);
function rememberDelay(name, n) {
  if (!Number.isFinite(n) || n <= 0) return;
  delayStore.set(name, n);
  saveDelayStore(serializeDelayStore());
}

const testing = new Set();
// 按代理组记录批量测速状态，避免页面因 provider/状态刷新重建按钮后绕过防重复锁。
const batchTestingGroups = new Set();
const proxyPrefs = Object.assign({ hideDead: false, showIcons: false }, loadState('proxy-prefs', {}));
function saveProxyPrefs() { saveState('proxy-prefs', proxyPrefs); }

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
    if (!node || !Array.isArray(node.all)) return cur;
    const next = node.now || node.all[0];
    if (!next) return cur;
    cur = String(next);
  }
  return cur;
}

function historyDelay(apiProxy) {
  const h = apiProxy && Array.isArray(apiProxy.history) ? apiProxy.history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    const n = Number(h[i] && h[i].delay);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// ---------------------------------------------------------------
// 全局延迟表（照 zashboard 的 latencyMap 思路）
//
// 以前每张卡片各自解析一次 history，还要自己顺着 now 链找叶子；几百个节点
// 时同一批节点被重复解析上百遍。改成建一张覆盖全部节点的表：一趟 O(节点数)
// 建好，之后卡片/排序/筛选/计数都 O(1) 查表，延迟口径也只有这一个来源。
//
// 表是内存态的，随 liveData 一起重建；测速结果另存 delayCache，优先级更高。
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
    const n = historyDelay(nodeMeta(leaf, dict, pIndex));
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

// 取值优先级：本次会话测过的 → 内核 history（查全局表）→ 上次会话存下来的
function delayValue(name, apiProxy) {
  if (nodeIsDead(name, apiProxy)) return 0;
  if (delayCache.has(name)) return delayCache.get(name);
  const h = tableDelay(name);
  if (h != null) return h;
  return delayStore.has(name) ? delayStore.get(name) : null;
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
  const mode = String(state.status?.mode || state.cfg?.mode || 'rule').toLowerCase();
  const visibleGroups = groups.filter(g => mode === 'global' ? g.name === 'GLOBAL'
    : (mode === 'rule' || mode === 'direct') ? g.name !== 'GLOBAL' : true);
  return visibleGroups.sort((a, b) => {
    const ai = order.has(a.name) ? order.get(a.name) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b.name) ? order.get(b.name) : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

function renderShell(el) {
  el.innerHTML = '';
  const filterBox = h('div', { class: 'proxy-filters' });
  const addSwitch = (key, label, trailing) => {
    const input = h('input', { type: 'checkbox', checked: proxyPrefs[key] });
    input.addEventListener('change', () => {
      proxyPrefs[key] = !!input.checked;
      saveProxyPrefs();
      renderProxyData(el);
    });
    filterBox.append(h('label', { class: 'proxy-switch' }, input, h('span', { text: label }), trailing || null));
  };
  addSwitch('showIcons', '显示图标');
  // 不可用节点数直接挂在开关后面：勾上「隐藏不可用」后，被筛掉多少节点一眼可见。
  // 数值由 refreshProxyStats 统一维护（与卡片增删、统计行同一个口径）。
  deadCountEl = h('span', { class: 'badge proxy-filter-count', text: '0', hidden: true });
  addSwitch('hideDead', '隐藏不可用', deadCountEl);
  el.append(
    h('div', { class: 'proxy-toolbar' },
      // 点统计行弹出诊断：协议类型显示「未知」时，靠猜要来回好几轮，
      // 直接把「哪些节点没匹配上 / 内核实际给了哪些键」列出来，可一键复制。
      h('div', {
        class: 'proxy-summary',
        style: 'cursor:pointer',
        title: '点击查看匹配诊断',
        onclick: () => showMetaDiag(),
      }),
      h('div', { class: 'proxy-toolbar-right' }, filterBox)),
    h('div', { class: 'proxy-groups' })
  );
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
      h('div', { style: 'flex:1 1 auto' },
        h('i', { class: 'sk sk-title' }), h('i', { class: 'sk sk-sub' }))),
    h('div', { class: 'proxy-node-body' }, grid));
  return c;
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
  liveData = null;
  providerData = null;
  providerIndexCache = new Map();
  providerDiag = { ok: false, count: 0, indexed: 0, error: '' };
  liveError = '';
  ++proxyMutationRev;
  bumpDataRev();
  if (typeof document === 'undefined') return;
  const el = document.getElementById('page-proxies');
  if (el && el.isConnected) {
    el._proxyMounted = false;
    renderProxyPage(el);
  }
}
onCoreConfigApplied(invalidateProxyData);

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
    if (el.isConnected) paintSelections();
  } catch (e) {
    // 回读失败无所谓：延迟已经写回，只是选中态等下次进页面再对齐
  } finally {
    selectionRefreshing = false;
  }
}

// 代理页的三处「一眼可见」统计，统一从这里出：
//   1) 顶部导航栏副标题：代理组 N · 节点 M
//   2) 「隐藏不可用」开关上的数字标签：当前不可用的节点数
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
  // 不可用节点数：与卡片筛选同一套判定（内置策略、被引用的组不算「不可用」），
  // 但不受开关状态影响 —— 开关关着时也要能看出有多少节点不可用。
  let dead = 0;
  allNodes.forEach(n => { if (nodeUnavailable(n, nodeMeta(n, dict, pIndex))) dead++; });
  const hints = [];
  if (!live) hints.push('当前为配置预览');
  else if (allNodes.size) {
    // 诊断用：内核 /proxies 里带延迟历史的节点数。浏览器刷新后一片「未测速」
    // 时，看这里就能分清是内核没给 history，还是前端没读到。
    let withHistory = 0;
    allNodes.forEach(n => { if (tableDelay(n) != null) withHistory++; });
    if (!withHistory && delayStore.size) hints.push('延迟来自上次记录');
    else if (!withHistory) hints.push('内核暂无延迟历史，点 ⚡ 测速');
    // 协议类型显示「未知」的根因：运行时数据里查不到这个节点。
    // 常见原因是 provider 元数据没拉到，或节点名带「provider名/」前缀对不上。
    let noMeta = 0;
    allNodes.forEach(n => { if (!nodeMeta(n, dict, pIndex)) noMeta++; });
    if (noMeta) hints.push(`${noMeta} 个节点无运行时数据（类型未知）`);
  }
  return { groups: groups.length, nodes: allNodes.size, dead, live, ready: true, hints };
}

function proxySubtitleText(stats) {
  return stats.ready ? `代理组 ${stats.groups} · 节点 ${stats.nodes}` : '代理组 · 节点';
}

function proxySummaryText(stats) {
  // 统计行不再重复导航栏里的组数 / 节点数：这里只留需要解释的状态。
  // 一句提示都没有时也留着文字 —— 它是「节点匹配诊断」的入口，空行点不出来。
  return stats.hints.length ? stats.hints.join(' · ') : '点按查看节点诊断';
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
    deadCountEl.textContent = String(stats.dead);
    deadCountEl.title = !stats.dead ? '当前没有不可用的节点'
      : proxyPrefs.hideDead ? `已隐藏 ${stats.dead} 个不可用节点`
        : `当前有 ${stats.dead} 个节点不可用（勾选后隐藏）`;
  }
  const summary = el && el.querySelector('.proxy-summary');
  if (summary) summary.textContent = proxySummaryText(stats);
}

function renderProxyData(el) {
  if (!el) return;
  const oldScroll = window.scrollY || 0;
  const groups = liveGroups(liveData);
  const dict = liveData && liveData.proxies && typeof liveData.proxies === 'object' ? liveData.proxies : {};
  const pIndex = providerIndexCache;
  // 渲染前先建好全局延迟表：后面每张卡片 O(1) 查表，不再各解析一次 history
  latencyTableFor(dict, pIndex);
  const allNodes = new Set(groups.flatMap(g => g.all));
  const live = !!(liveData && liveData.proxies);

  const oldBody = el.querySelector('.proxy-groups');
  if (oldBody) {
    oldBody.querySelectorAll('.proxy-node-grid').forEach(grid => { if (grid._cancelMount) grid._cancelMount(); });
    oldBody.remove();
  }
  if (marqueeObserver) marqueeObserver.disconnect();
  refreshProxyStats(groups, dict, pIndex);

  const body = h('div', { class: 'proxy-groups' });
  if (liveError && !groups.length) {
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
    else for (let i = 0; i < 3; i++) body.append(skeletonGroup(i === 0 ? 6 : 4));
  } else {
    groups.forEach(g => body.append(groupCard(g, dict, pIndex)));
  }
  el.append(body);
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

// One availability decision for filtering, dimming and latency display.
const nodeHealth = new Map();
function nodeIsDead(name, meta) {
  if (isBuiltinProxy(name, meta) || Array.isArray(meta?.all)) return false;
  const latest = Array.isArray(meta?.history) ? meta.history.at(-1) : null;
  const stamp = Date.parse(latest?.time || '');
  const local = nodeHealth.get(name);
  if (local && Date.now() - local.at < 300000 && (!Number.isFinite(stamp) || stamp <= local.at)) return !local.alive;
  if (latest && typeof latest.delay === 'number' && Number.isFinite(latest.delay)) return latest.delay <= 0;
  return meta?.alive === false;
}
function recordNodeHealth(name, alive) {
  nodeHealth.set(name, {alive, at: Date.now()});
  if (!alive) { delayCache.delete(name); delayStore.delete(name); }
  const page = document.getElementById('page-proxies');
  page?.querySelectorAll('.proxy-node').forEach(node => {
    if (node.dataset.proxyNode === name) node.classList.toggle('dead', !alive);
  });
}

// 节点算不算「不可用」。与开关状态无关，供计数与筛选共用同一口径。
// 以下三类即使 alive === false 也不算不可用：
//  1) 内置策略（DIRECT / REJECT / PASS / DNS …）：不是真实节点，删了规则就断了；
//  2) 被引用的代理组：它是别的组的成员，隐藏会让父组少一个可选项、切不回去；
//  3) mihomo 没给出 alive 字段的节点（meta 为空或 alive 不是 false）：一律当作可用。
function nodeUnavailable(name, meta) {
  if (isBuiltinProxy(name, meta)) return false;
  // 有 all 数组 = 它本身是代理组，即被当前组引用的组
  if (meta && Array.isArray(meta.all)) return false;
  return nodeIsDead(name, meta);
}

// 「隐藏不可用」的保留规则：开关关着一律保留。
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
  const title = h('div', { class: 'proxy-group-title' },
    h('span', { class: 'proxy-group-name', text: group.name }),
    badge(group.type || '代理组', 'b'));
  const icon = groupIcon(group);
  const now = h('div', { class: 'proxy-group-now', text: current ? '当前：' + current : (group.live ? '当前：未选择' : '点击刷新读取当前节点') });
  const toggle = h('button', {
    class: 'btn sm proxy-group-toggle', text: isOpen ? '收起 ▴' : '展开 ▾',
    'aria-expanded': isOpen ? 'true' : 'false',
    onclick: (ev) => {
      ev.stopPropagation();
      const open = !openGroups.has(group.name);
      setOpenGroups(open ? [group.name] : []);
      const page = document.getElementById('page-proxies');
      page.querySelectorAll('.proxy-group-card').forEach(groupCardEl => {
        const isThis = openGroups.has(groupCardEl.dataset.proxyGroup);
        const body = groupCardEl.querySelector('.proxy-node-body');
        const btn = groupCardEl.querySelector('.proxy-group-toggle');
        // 收起时这一组还没建过卡片，展开的瞬间才建
        if (isThis && groupCardEl._mountNodes) groupCardEl._mountNodes(false);
        if (body) body.hidden = !isThis;
        if (btn) {
          btn.textContent = isThis ? '收起 ▴' : '展开 ▾';
          btn.setAttribute('aria-expanded', isThis ? 'true' : 'false');
        }
      });
    },
  });
  const batchBtn = h('button', {
    class: 'btn sm proxy-batch-btn',
    html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 2.8 5 13h5.5l-.8 8.2L19 10.4h-5.6z"/></svg>',
    title: group.live ? '测速此代理组的全部节点' : '启动内核后才能测速',
    'aria-label': '测速此代理组的全部节点',
    disabled: !group.live,
    onpointerdown: () => {
      if (!batchBtn.dataset.batchBusy) batchBtn.classList.add('pointer-press');
    },
    onpointerup: () => batchBtn.classList.remove('pointer-press'),
    onpointercancel: () => batchBtn.classList.remove('pointer-press'),
    onclick: (ev) => {
      ev.stopPropagation();
      batchBtn.classList.remove('pointer-press');
      testGroupAll(group, dict, pIndex, batchBtn);
    },
  });
  if (batchTestingGroups.has(group.name)) setBatchButtonBusy(batchBtn, true);
  const headActions = h('div', { class: 'proxy-group-head-actions' }, batchBtn, toggle);
  const head = h('div', { class: 'proxy-group-head' }, h('div', { class: 'proxy-group-head-main' }, title, now), headActions);
  if (icon) head.prepend(icon);
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
  c.dataset.proxyGroup = group.name;
  c._proxyGroup = group;
  c.append(head, nodeBody);

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

function mountNodeCards(grid, names, group, dict, pIndex, full) {
  const finish = () => {
    grid._nodesBuilt = true;
    // 挂载期间安排的筛选对齐（syncGroupCardNodes）在这里补做：
    // 那时卡片还没建完，插队会和分批挂载抢同一块 DOM。
    flushPendingNodesSync(grid);
  };
  if (typeof DocumentFragment === 'undefined') {
    names.forEach(name => {
      const el = nodeCard(group, name, nodeMeta(name, dict, pIndex), dict, pIndex);
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
    const end = Math.min(names.length, i + CARD_CHUNK);
    const frag = document.createDocumentFragment();
    const made = [];
    for (; i < end; i++) {
      if (!full && made.length && performance.now() - started >= 5) break;
      const name = names[i];
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
    if (i < names.length) {
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
// 而卡片是渲染时按当时的可用性建好的。不重新对齐的话，被「隐藏不可用」筛掉的节点
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
  // 卡片增删会改变「已隐藏 N 个」这类统计，顺手把统计行对齐
  if (changed) refreshProxyStats();
}

// ---------- 节点名过长时滚动 ----------
// 卡片宽度有限，长名只显示一截；超宽的才挂上滚动。
// 注意卡片带 content-visibility: auto——屏幕外的卡片不参与布局，此时量到的
// 宽度是 0，所以测量必须等卡片真正进入视口再做（IntersectionObserver）。
let marqueeObserver = null;
function observeMarquee(nodeEl) {
  const clip = nodeEl && nodeEl.querySelector && nodeEl.querySelector('.proxy-node-name');
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

function measureMarquee(clip) {
  const text = clip.querySelector('.proxy-node-name-text');
  if (!text) return;
  clip.classList.remove('is-overflow');
  clip.style.removeProperty('--node-shift');
  // 还没布局（比如在收起的组里）就先不判定，等它真正可见时再量
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
    const now = card.querySelector('.proxy-group-now');
    if (now) now.textContent = current.now ? '当前：' + current.now : '当前：未选择';
    card.querySelectorAll('.proxy-node').forEach(node => node.classList.toggle('selected', node.dataset.proxyNode === current.now));
  });
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
    uiToast('已切换到：' + name, 2200);
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
  const paths = testPaths(targetName, targetMeta);
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
// 为什么非要分清：只有「内核确实测过并判不通」才能把节点记成不可用 ——
// 勾着「隐藏不可用」时卡片会立刻消失，把「桥超时 / 路径不对」也当成不通，
// 会把好节点藏起来。旧代码只认 200 里带 delay 字段，于是真实设备上
// 503/504 一律被当成「没测出来」，节点测不通也不会被隐藏。
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
async function fetchOneDelay(paths, budgetMs) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  let last = { stdout: '', stderr: '', hit: false };
  for (const path of list) {
    const r = await apiGet(path, { timeout: Math.max(1, Math.ceil((budgetMs || 15000) / 1000)) });
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
  if (!group.live || !target) return;
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
      recordNodeHealth(name, true);
      delayCache.set(name, ok);
      rememberDelay(name, ok);
      write(ok);
    } else {
      // 只有「内核测过并判不通」才记成不可用：勾着「隐藏不可用」时卡片立刻消失，
      // 而桥超时之类的未知结果只显示失败胶囊，不动可用性（否则会把好节点藏起来）。
      if (dead) recordNodeHealth(name, false);
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
    // 可用性有结论就立刻对齐卡片：勾着「隐藏不可用」时测不通的节点马上消失，
    // 组兜底里顺带复测恢复的其它节点也会自己出现。
    if (dead || ok != null) syncGroupCardNodes(group.name);
    // 走组测速接口、或所在组会自动改选时，回读一次刷新「当前选中」标记
    if (usedGroupTest || groupAutoSelects(group)) await refreshSelectionAfterTest();
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
async function fetchGroupDelays(groupName, names) {
  try {
    // 单次请求直取：并发完全发生在内核内部，UI 和桥都没有压力。
    let j = null;
    {
      const r = await withTimeout(
        apiGet(groupDelayPath(groupName), { timeout: Math.ceil((GROUP_DELAY_BUDGET + 2000) / 1000) }),
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
    button.disabled = true;
    button.dataset.batchBusy = 'true';
    button.classList.add('is-testing');
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
  } else {
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

async function testGroupAll(group, dict, pIndex, batchBtn) {
  // 测速中用原生 disabled 阻断第二次事件，避免正在跑的这一批请求被再触发一次；
  // 锁放在代理组状态而不是按钮 DOM 上，页面重绘后也不能绕过。
  if (!group.live || batchTestingGroups.has(group.name)) return;
  batchTestingGroups.add(group.name);
  syncBatchButtons(group.name, true);
  setBatchButtonBusy(batchBtn, true);
  // 先让浏览器真正绘制闪电按钮的点击反馈，再做节点收集和测速准备。
  await yieldForPaint();
  const page = document.getElementById('page-proxies');
  const groupEl = page && [...page.querySelectorAll('.proxy-group-card')]
    .find(el => el.dataset.proxyGroup === group.name);
  const delayEls = new Map();
  if (groupEl) {
    // 收起的组还没有卡片 DOM，这里补建（分批，不阻塞）。
    // 来不及建的卡片拿不到 delayEl，结果仍会进 delayCache，之后展开/重绘时自然显示。
    if (groupEl._mountNodes) groupEl._mountNodes(false);
    groupEl.querySelectorAll('.proxy-node').forEach(node => {
      const name = node.dataset.proxyNode;
      if (name) delayEls.set(name, node.querySelector('.proxy-node-delay'));
    });
  }

  // 与外部面板一样先过滤不可测速项目，但「隐藏不可用」筛掉的节点照样要测：
  // 它们当初就是因为不通才被藏起来的，不测就永远不知道它已经恢复，
  // 于是「测速当前代理组后可用节点一直不回来」。它们没有卡片，
  // 结果只更新健康状态与缓存，收尾时再由 syncGroupCardNodes 决定要不要显示。
  const items = [];
  group.all.forEach(name => {
    const meta = nodeMeta(name, dict, pIndex);
    if (!isProxySpeedTestable(name, meta)) return;
    const key = group.name + '\u0000' + name;
    if (testing.has(key)) return;
    // 与卡片显示保持同一套保留规则（内置策略 / 被引用的组不隐藏）
    const hidden = !keepWhenHidingDead(name, meta);
    items.push({ name, key, meta, hidden, delayEl: hidden ? null : (delayEls.get(name) || null), done: false });
  });
  if (!items.length) {
    batchTestingGroups.delete(group.name);
    syncBatchButtons(group.name, false);
    return;
  }

  // 批量结果合帧写入，避免节点数量大时每个响应都触发一次布局和绘制。
  const paintQueue = new Map();
  let paintRaf = 0;
  // 以 item 为键（同一节点多次写入只保留最后一次），写回时现找胶囊：
  // 批量测速期间页面重绘会把旧引用摘出文档，直接写会写进孤儿节点。
  const paint = (item, n, opts) => {
    // 被筛选隐藏的节点没有卡片：结果已经进了 delayCache / 健康表，
    // 收尾时该出现的节点会带着这次的延迟一起建出来。
    if (item.hidden) return;
    paintQueue.set(item, { n, opts });
    if (!paintRaf) {
      paintRaf = requestAnimationFrame(() => {
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
      if (item.done) return;
      const el = liveDelayEl(group.name, item.name) || item.delayEl;
      if (el) setDelay(el, null, { loading: true });
    });
  }, PENDING_HINT_MS);

  try {
    // 第一优先：mihomo 的组测速接口。一次请求测完整组，并发发生在内核内部，
    // 前端只有一个请求在飞，所以既最快也完全不影响展开和滚动。
    const groupDelays = await fetchGroupDelays(group.name, items.map(item => item.name));
    if (groupDelays) {
      items.forEach(item => {
        if (!groupDelays.has(item.name)) return;
        const n = groupDelays.get(item.name);
        item.done = true;
        recordNodeHealth(item.name, n > 0);
        // 0 是内核明确测过但不通，直接显示失败；不再丢进补测空耗一轮。
        if (n > 0) { delayCache.set(item.name, n); rememberDelay(item.name, n); paint(item, n); }
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
      if (!job) { job = { target: { path }, items: [] }; byPath.set(path, job); }
      job.items.push(item);
    });
    const jobs = [...byPath.values()];
    jobs.forEach(job => job.items.forEach(item => testing.add(item.key)));
    // 每路补测的结论：{delay} 可用 / {dead:true} 内核测过但不通 / null 没拿到结论
    const settleJob = (job, verdict) => {
      if (verdict && verdict.dead) {
        // 内核明确判不通 → 记成不可用：勾着「隐藏不可用」时卡片立刻消失
        job.items.forEach(item => { recordNodeHealth(item.name, false); paint(item, 0, { fail: true }); });
      } else if (verdict && Number.isFinite(verdict.delay) && verdict.delay > 0) {
        job.items.forEach(item => {
          recordNodeHealth(item.name, true);
          delayCache.set(item.name, verdict.delay);
          rememberDelay(item.name, verdict.delay);
          paint(item, verdict.delay);
        });
      } else {
        // 桥超时 / 路径不对这类「没测出来」：只标失败胶囊，不动可用性
        job.items.forEach(item => paint(item, 0, { fail: true }));
      }
      job.items.forEach(item => testing.delete(item.key));
    };

    // 后台通道不可用时的统一兜底：浏览器侧滑窗并发，并发度不变。
    const runLanePool = async (list) => {
      if (!list.length) return;
      const lanes = Math.max(1, Math.min(BATCH_CONCURRENCY, list.length));
      let cursor = 0;
      const runLane = async () => {
        for (;;) {
          const index = cursor++;
          if (index >= list.length) return;
          const job = list[index];
          await waitForBatchIdle();
          let verdict = null;
          try {
            // 走与单节点测速同一套判定：组接口漏掉的成员多是测不通的，
            // 这里必须把 503/504 认成「确定不通」，否则它们永远不会被隐藏。
            const v = delayVerdict(await apiGet(job.target.path));
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
    syncGroupCardNodes(group.name);
    batchTestingGroups.delete(group.name);
    syncBatchButtons(group.name, false);
    setBatchButtonBusy(batchBtn, false);
    // 自动选择类组（URLTest / Fallback）测完会换节点：回读一次刷新选中态
    if (groupAutoSelects(group)) await refreshSelectionAfterTest();
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

async function loadProxyData(el, force = false) {
  if (!el || loading) return;
  if (!force && liveData) { renderProxyData(el); return; }
  loading = true;
  const revision = proxyMutationRev;
  liveError = '';
  // 先显示 /proxies 的组列表，provider 元数据在后台补齐；不让第二个请求阻塞首屏。
  const proxyPromise = apiGet('/proxies', { big: true });
  // trim：服务端只保留每个节点最近 3 条延迟 history。上百个订阅节点时这个
  // 响应能到几 MB，过 CGI 桥会被压垮（拿到空响应 → 节点类型全未知）。
  // 留 3 条是为了保住延迟显示：它正由 history 末段的非零 delay 推出。
  const providerPromise = apiGet('/providers/proxies', { big: true, trim: true })
    .catch(e => ({ errno: -1, stdout: '', stderr: String(e) }));
  try {
    let r = await proxyPromise;
    let j = parseJsonLoose(r && r.stdout);
    if (!j || !j.proxies) {
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
    if (revision === proxyMutationRev && el.isConnected) renderProxyData(el);
  } catch (e) {
    liveError = e && e.message ? e.message : String(e);
    // 同上：只有确实没有数据时才置空，否则保留旧列表继续用
    if (!liveData) {
      providerData = null;
      providerIndexCache = new Map();
      bumpDataRev();
    }
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
}

export function renderProxyPage(el) {
  if (!el) return;
  if (!el._proxyMounted) {
    el._proxyMounted = true;
    renderShell(el);
    el.querySelector('.proxy-summary').textContent = '正在读取代理列表…';
    const body = el.querySelector('.proxy-groups');
    for (let i = 0; i < 3; i++) body.append(skeletonGroup(0));
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
