import { controller, patchMode, getConfigs, restartService } from './mihomo-api.js';
import { showUpdateAllProviders } from './subscription-actions.js';
// ============================================================
// Mihomo Box WebUI — 主程序
// ============================================================
import { h, state, DEMO, REMOTE, shell, cmdline, loadConfig, saveConfig, ntoast, selectCtl, segCtl, scanAnchorGraph, entryFieldAnchors, uiToast, confirmSheet, openSheet, openChildSheet, closeSheet, setSheetFooter, badge, note, groupTitle, card, chev, switchCtl, clearEl, readText, writeText, pickFileWithFeedback, copyText, hasSelectionIn, CONFIG_PATH, WORKDIR, MODDIR, set, unset, get, subsSheet, shq, parseJsonLoose, lastJsonRepair, execBrief, uiLog, uiLogBuffer, uiLogDiskFailed, flushUiLogNow, clearUiLog, isInteracting, setBackgroundWorkPaused, bumpUiRev, uiRev, deepClone, anchorDefBlock, patchAnchorDefBlock, applyConfigDraft, commitConfigEdit, editConfigSource, flushConfigSource, parseConfigText, tidyMihomoConfig, onConfigDraftChange, emitCoreConfigApplied, renderKeepScroll, setSaveBarSuppressed, b64ToUtf8, applyConfigText, applyBackendInfo, isOpenWrt } from './core.js';
import { mountSaveBar, focusTextInput, installTextInputHandling, installCloseOnEscape } from './core.js';
import { renderConfigHub, renderGeneral, renderDns, renderInbound, renderSniff, renderNtp, renderTunnels, renderExperimental, policyNames, setEbpfEnabled, setTunListenerEnabled, ebpfRoles } from './pages-config.js';
import { renderProxies, renderSubs, renderGroups, renderRules, renderRuleProviders, renderSubRules } from './pages-flow.js';
import { renderCore } from './pages-core.js';
import { renderProxyPage } from './page-proxies.js';
import { qrSvg } from './qr.js';
import { REMOTE as IS_REMOTE, getToken, setToken, probeAuth, setUnauthorizedHandler } from './kernelsu.js';

// 所有输入框统一在原生点按结束的同一次手势中请求聚焦。
// 不再拦截 touchstart、切换 readonly、延时 blur/focus 或把光标送到末尾。
installTextInputHandling();

document.addEventListener('DOMContentLoaded', boot);

// ================= 路由 =================
const pages = [...document.querySelectorAll('.page')];
const initialDashboardMarkup = document.getElementById('page-dashboard')?.innerHTML || '正在加载主页…';
const PAGE_RENDER = {};
let current = 'page-dashboard';
let pageStack = [];
// 切页平移方向的稳定语义（供 showPage 挂滑入类）：主页面互切按底栏 tab 的左右顺序——往更右的
// tab 走＝向左滑入，往更左的 tab 走＝向右滑入（乒乓连点必然左右交替，不会两跳同向）；
// 子页回主页面＝出来（向右）；进子页只向左；屏上返回键与手势返回置 navFlipBack 走向右。
const tabIdx = Object.create(null);
document.querySelectorAll('#tabbar .tab[data-page]').forEach((b, i) => { tabIdx[b.dataset.page] = i; });
let navFlipBack = false;
let navRaf = 0;
let navPending = false;
const scrollMem = {};   // 页面 id → 上次离开时的滚动位置：返回时原位续看，长列表不用重新滑
let navScrollTo = -1;   // 内容落位后要恢复的位置（-1 = 无待恢复）

// ============================================================
// 外部面板前台标志：面板内嵌层开着时，WebUI 侧所有周期性工作全部停摆。
// ------------------------------------------------------------
// 面板（zashboard 等）是跨域 iframe，但它与 WebUI 跑在同一个 WebView 里：同一条
// 渲染管线、同一颗 SoC、同一套 GPU/合成带宽。WebUI 若继续在后台干活，面板里每一次
// 滚动、每一次点节点都要和这些活抢帧预算，表现出来就是「面板内卡顿、点按反应慢」：
//   · 日志环每秒一次桥往返（httpd fork → sh → tail/grep → base64），是实打实的
//     进程创建 + IO，占的是同一颗 CPU；
//   · 状态心跳每 5 秒一次 shell + JSON 解析；
//   · 运行时长每秒一次 DOM 写入，触发样式重算与重绘；
//   · 状态点/扫描点/进度条上的常驻 CSS 动画一直在申请合成帧；
//   · 背景文档的 appbar/tabbar 带 backdrop-filter，任何重绘都要重算模糊。
// 处理方式：打开面板即静默（定时器空转跳过、DOM 不写、CSS 停绘制），关闭时一次性补齐。
// 注意：这里只是「不主动干活」，DOM、滚动位置、页面栈全部原样保留——
// 返回时依旧是零重载，改的只是后台的耗电与抢帧。
let panelForeground = false;
let panelResumeT = 0;     // 关闭面板后延迟补齐状态/日志的句柄（避开退场动画那一帧）
let panelScrollY0 = -1;   // 进面板时的文档滚动位置：关闭时按它摆回（见 closeExternalPanel）

const landedRev = {};   // 页面 id → 上次完整渲染时的内容代数
const landedAt = {};    // 页面 id → 上次渲染时间戳（60 秒 TTL：相对时间类文案到期重绘）
function rerenderCurrent() {
  if (PAGE_RENDER[current]) PAGE_RENDER[current](document.getElementById(current));
  landedRev[current] = uiRev();
  landedAt[current] = Date.now();
  afterRenderSettle();
}
function afterRenderSettle() {
  // 内容落位后再校一次滚动：重渲染会拉长内容，落位前的滚动常被钳回顶部
  if (navScrollTo >= 0) {
    const y = navScrollTo; navScrollTo = -1;
    if (Math.abs((window.scrollY || 0) - y) > 2) window.scrollTo({ top: y });
  }
  updateToTop();   // 重渲染后钳位/回位都可能不产生 scroll 事件，落位时补刷
  // 非概览页落地后软性补一次状态（8 秒节流）——延后到首个静默窗口再发：
  // 落地即发的话，回调正好砸进下一次点按的动画帧里（上版「每隔几秒」的来源之一）
  if (!DEMO && !panelForeground && current !== 'page-dashboard' && Date.now() - lastStatusFetchTs > 8000) {
    clearTimeout(idleStatusT);
    idleStatusT = setTimeout(() => {
      if (panelForeground) return;   // 等待期间面板开了：取消这次补刷，等关闭时统一补
      if (document.visibilityState !== 'visible' || userScrollingOrEditing()) return;   // 还在忙：放弃本次，落地时再排
      if (Date.now() - lastStatusFetchTs > 8000) refreshStatus(false, true);
    }, 1700);
  }
}
function pageIsFresh(id) {
  const el = document.getElementById(id);
  return !!(el && el.childElementCount > 0 && landedRev[id] === uiRev() && Date.now() - (landedAt[id] || 0) < 60000);
}

window.rerenderCurrent = rerenderCurrent;
function rerenderCurrentDeferred() {
  cancelAnimationFrame(navRaf);
  navRaf = requestAnimationFrame(() => requestAnimationFrame(() => {
    navPending = false;
    // 内容代数没变 → 目标页 DOM 仍是热的：跳过整页重渲染（来回切页从「每次落地重建一次」
    // 变为纯显隐切换；这正是「切换时顿一下」的最后一段——数百节点重建 + 样式重算撞在入场动画上）
    // 入站页的 TUN 卡片有「默认收起」的进入态；再次进入时必须重建，
    // 不能复用上次离开时已经展开的 DOM。
    if (pageIsFresh(current) && current !== 'page-c-inbound') {
      if (current === 'page-dashboard') startDashLogLoop();   // 复用 DOM 时日志环也要确保在跑
      afterRenderSettle();
      return;
    }
    rerenderCurrent();
  }));
}

function showPage(id) {
  // 导航优先：面板退场后尚未执行的管理器状态补读不能占住切页资源。
  if (panelResumeT) { clearTimeout(panelResumeT); panelResumeT = 0; }
  if (id === current && !navPending && document.getElementById(id) && !document.getElementById(id).hidden) { navFlipBack = false; return; }
  navPending = true;
  lastNavTs = Date.now();   // 切页突发计时：连续点导航栏时把桥留给动画（见 userScrollingOrEditing）
  const sec = document.getElementById(id);
  // 滚动位置记忆：**必须抢在显隐切换前**记录——旧页一 hidden，文档高度塌到新页尺寸，
  // 浏览器立刻把 scrollY 钳到新页可滚上限，那时再读记下的就是钳后的假位置（设置子页普遍
  // 被钳成 0，「没记住滚动」的根源）。记下位置后再切显隐；新页先跳到它的历史位置，
  // 内容落位后（afterRenderSettle）再补一次。
  scrollMem[current] = window.scrollY || window.pageYOffset || 0;
  // —— 切页平移方向：只在「从可见旧页真换了页」时挂类播放（首帧直落不动画）——
  pages.forEach(p => { p.classList.remove('slide-from-right', 'slide-from-left'); });
  const fromEl = current !== id ? document.getElementById(current) : null;
  let back = navFlipBack;
  navFlipBack = false;   // 标志即取即清，绝不让它漏到下一跳
  // 页面切换保留平移动画；管理器 WebView 的卡顿问题只通过减少桥请求处理，
  // 不在这里移除页面过渡效果。
  if (fromEl && !fromEl.hidden) {
    const a = tabIdx[current], b = tabIdx[id];
    if (a !== undefined && b !== undefined) back = b < a;            // 主页面↔主页面：tab 顺序定方向
    else if (b !== undefined && fromEl.dataset.parent) back = true;  // 子页直接点回主页面＝「出来」，算返回
    sec.classList.add(back ? 'slide-from-left' : 'slide-from-right');
  }
  // 标题/返回键先行。内核页、工具页和代理页首次构建较重：若先把空页揭开、再等双 rAF
  // 才填充内容，Android 管理器 WebView 会在平移过程中先画一帧空白，再突然出现整页，
  // 看起来就是「眨眼 / 淡入淡出」。这些页在切换前就于 hidden 状态完成预热构建，
  // 然后再揭开 —— 不用等到落在当前页才加载数据，页面本身的平移动画仍然保留。
  // 配置页等轻页继续走原来的双 rAF 路径。
  document.getElementById('pageTitle').textContent = sec.dataset.title || 'Mihomo Box';
  document.getElementById('pageSubtitle').textContent = sec.dataset.sub || '';
  document.getElementById('backBtn').hidden = !sec.dataset.parent;
  current = id;
  // 代理页、内核页和工具页在切换前预构建：首次落地即可同步画出内容，
  // 预构建后揭开时第一帧就不是空白，切换平滑秒开。
  const prebuild = !DEMO
    && (id === 'page-core' || id === 'page-tools' || id === 'page-proxies')
    && PAGE_RENDER[id] && !pageIsFresh(id);
  if (prebuild) {
    try {
      PAGE_RENDER[id](sec);
      landedRev[id] = uiRev();
      landedAt[id] = Date.now();
    } catch (e) {
      // 构建失败时仍让原有 deferred 路径重试，不阻断导航。
      console.warn('page prebuild failed', id, e);
    }
  }
  // 内容已经预热后再显隐，切页平移时第一帧就是完整页面；轻页仍先显示空壳再双 rAF 渲染。
  pages.forEach(p => { p.hidden = p.id !== id; });
  navScrollTo = Math.max(0, scrollMem[id] | 0);
  window.scrollTo({ top: navScrollTo });
  updateToTop();   // 位置没变则无滚动事件，切页落地时顺带刷一次按钮
  rerenderCurrentDeferred();
}

// ============================================================
// 手势返回接管（History API）：进入子页压一条历史，系统返回手势/返回键
// 会先弹回上一层页面，而不是直接退出 WebUI；主页面切换时把欠着的子页
// 历史条目异步清掉（history.go(-depth)），弹无可弹才交还宿主自然退出。
// 返回统一由 popstate 驱动，与屏上返回按钮共用同一条路，栈与历史不分叉。
// ============================================================
const HIST_OK = typeof history !== 'undefined' && typeof history.pushState === 'function';
let popSuppress = 0;   // 待吞掉的历史回退数（主页面切换清栈时用，累计计数）
let popSuppressUntil = 0;   // 计数只在这个短窗口内有效，过期作废——防止在途吞掉正常返回
function histPin(id) { if (HIST_OK) { try { history.replaceState({ mb: id }, ''); } catch (e) {} } }
function histPush(id) { if (HIST_OK) { try { history.pushState({ mb: id }, ''); } catch (e) {} } }
function histTrim(depth) {
  if (!HIST_OK) return;
  if (Date.now() >= popSuppressUntil) popSuppress = 0;   // 上一窗口的尾数过期作废
  popSuppress += depth;                                    // 连发清栈时累计，保证每笔回退都被吞
  popSuppressUntil = Date.now() + 600;
  if (depth > 0) { try { history.go(-depth); } catch (e) { popSuppress = 0; } }
}
function syncTabActive(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.page === id));
}
histPin(current);   // 钉底：首个条目永远携带页 id，重载/回退后状态可复原
window.addEventListener('popstate', (e) => {
  // 外部面板刷新流程里自己发起的那次 back() 本该只退回 iframe 的条目；若反而弹到了这里，
  // 说明已越过面板条目 —— 不是用户要关面板，交给守卫压回条目并改走兜底重载
  if (externalPanelRefreshPop()) return;
  // 外部面板内嵌层开着时：这次回退只用来关面板，页面栈与页面本身都不动
  // （面板打开时压了一条历史，所以返回键/手势先落到这里，不会把 WebUI 弹走）
  if (closeExternalPanel(true)) return;
  if (popSuppress > 0 && Date.now() < popSuppressUntil) {   // 我们自己发起的清栈回退：吞掉，不切页
    if (--popSuppress === 0) histPin(current);
    return;
  }
  popSuppress = 0;
  const t = e.state && e.state.mb;
  if (!t) { histPin(current); return; }          // 弹到底前夹生的 null 条目：补钉原地
  if (t === current) return;                     // 同页往返：无事发生
  const el = document.getElementById(t);
  if (!el) { histPin(current); return; }         // 未知 id（旧版本残留条目）：补钉忽略
  const i = pageStack.lastIndexOf(t);
  if (i >= 0) pageStack.length = i;              // 回到栈中层：截断上层
  else if (!el.dataset.parent) pageStack = [];   // 回到主页面：清栈
  if (!el.dataset.parent) syncTabActive(t);      // 落到主页面：tab 高亮跟着走，别留在旧页上
  navFlipBack = true;                            // 手势返回＝返回向：向右滑入
  showPage(t);
});

function navTo(id) {
  if (id === current && !navPending) return;
  const sec = document.getElementById(id);
  if (sec.dataset.parent) { pageStack.push(current); histPush(id); }   // 子页：压一条历史给手势返回用
  // 主页面则清空栈（并把欠着的子页历史条目一并清掉，回到主页面后返回应退出而非翻旧页）
  if (!sec.dataset.parent) {
    histTrim(pageStack.length);
    pageStack = [];
    histPin(id);   // 底条目跟着主页面走：子页往回弹时 popstate 才能报出正确的「上一层」
    syncTabActive(id);   // 先切高亮，视觉反馈不等待后续渲染
  }
  showPage(id);
}
window.navTo = navTo;

document.getElementById('backBtn').onclick = () => {
  navFlipBack = true;   // 屏上返回＝返回向：新页向右滑入
  // 与系统返回手势同路：历史条目在账上就交给 popstate 驱动切页，栈/历史不分叉
  if (HIST_OK && history.state && history.state.mb === current) { history.back(); return; }
  const back = pageStack.pop();
  if (back) {
    if (!document.getElementById(back).dataset.parent) syncTabActive(back);
    showPage(back);   // 兜底：无历史可弹（异常态）就地回父页
  }
};
// 正常点击切换：只挂 click。少掉 pointerdown 抢先触发，横向滑动掠过标签栏时不再误切页；
// click 在滑动结束抬起手指且未产生横向位移时才会派发，天然防误触。
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => navTo(t.dataset.page));
});

// ================= 主题 =================
const themeBtn = document.getElementById('themeBtn');
function applyTheme(t) {
  const v = t || localStorage.getItem('theme') || 'auto';
  const dark = v === 'dark' || (v === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  // 同步浏览器状态栏/地址栏底色。取 CSS 变量 --bg 的真实值，
  // 避免这里写死的颜色与主题表脱节。
  const mc = document.getElementById('themeColor');
  if (mc) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) mc.setAttribute('content', bg);
  }
}
themeBtn.onclick = () => {
  const cur = localStorage.getItem('theme') || 'auto';
  const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
  localStorage.setItem('theme', next);
  applyTheme(next);
  uiToast('主题：' + ({ auto: '跟随系统', light: '浅色', dark: '深色' }[next]));
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());

// ================= 模块设置（顶栏齿轮） =================
// TUN 热点共享状态短串 → 可读文本（scripts/mihomo.sh 的 tun_hotspot 字段）
// 格式: off | pending | on:iface=mihomo:v6=off:mode=proxy|direct
function tunHsStatusText() {
  const v = state.status && state.status.tun_hotspot;
  if (!v || v === 'off') return '当前状态：TUN 未启用，开关暂不生效';
  if (v === 'pending') return '当前状态：TUN 已开启，等待网卡就绪…';
  const m = /^on:iface=([^:]+):v6=(on|off):mode=(proxy|direct|fb)$/.exec(v);
  if (!m) return '当前状态：' + v;
  if (m[3] === 'fb') return '当前状态：⚠️ 直连未生效（已回退代理）——请到工具页执行 tun-hotspot-diag 排查';
  if (m[3] === 'direct') return `当前状态：TUN ${m[1]} 运行中，共享客户端 IPv4 直连（绕过内核；v6 已拦截）`;
  return `当前状态：TUN ${m[1]} 运行中，共享客户端流量走内核代理`;
}

// Tproxy 状态短串 → 可读文本（scripts/mihomo.sh 的 tproxy_state 字段）
// 格式: off | standby | pending | on:port=7894:v6=off:app=all
//       on:port=7894:v6=off:app=include:apps=3[:fb] | holding:port=7894:v6=off:2/6:app=exclude:apps=2[:fb]
// :app 段缺失视为 all（兼容旧版状态文件）；fb = 名单暂未生效、已按全部代理
function tproxyStatusText() {
  const v = state.status && state.status.tproxy_state;
  if (!v || v === 'off') return '当前状态：未开启，流量接管方式由配置决定（TUN / eBPF 等）';
  if (v === 'standby') return '当前状态：已开启，内核未运行——启动内核后自动安装转发规则';
  if (v === 'pending') return '当前状态：已开启，但规则未生效（内核未运行，或没识别到 TProxy 端口／端口未监听）——流量仍是直连。点「诊断 Tproxy」看具体原因';
  // 应用名单后缀 → 可读文本（app=期望名单，apps=包数，fb=名单暂未生效已按全部代理）
  const appText = (mode, n, fb) => {
    if (fb) return '（应用名单暂未生效：已按全部应用代理，名单就绪后自动切换；点「诊断 Tproxy」看详情）';
    if (mode === 'include') return `，仅代理名单内 ${n} 个应用（名单复用 TUN 页「仅代理以下应用」）`;
    if (mode === 'exclude') return `，名单内 ${n} 个应用直连、其余走代理（名单复用 TUN 页「排除以下应用」）`;
    return '';
  };
  const h = /^holding:port=(\d+):v6=(on|off):(\d+)\/(\d+)(?::app=(all|include|exclude)(?::apps=(\d+))?(:fb)?)?$/.exec(v);
  if (h) return `当前状态：TPROXY :${h[1]} 转发中${h[2] === 'on' ? '（含 IPv6）' : ''}（内核端口暂未响应 ${h[3]}/${h[4]}，规则保留中，代理不受影响）${appText(h[5] || 'all', h[6] || '0', h[7])}`;
  const m = /^on:port=(\d+):v6=(on|off)(?::app=(all|include|exclude)(?::apps=(\d+))?(:fb)?)?$/.exec(v);
  if (!m) return '当前状态：' + v;
  return `当前状态：TPROXY :${m[1]} 转发中${m[2] === 'on' ? '（含 IPv6）' : ''}，配置中的 TUN 已关闭${appText(m[3] || 'all', m[4] || '0', m[5])}`;
}

// TProxy 关闭后，TUN 与 eBPF 都是透明接管方式，不应让用户无提示地恢复成两者同时开启。
// 选择会更新当前配置并立即保存重启：TUN 选项开启 tun.enable 并把 eBPF 两个角色开关置 false，eBPF 选项反之。
function showTransparentModePicker() {
  let busy = false;
  const apply = async (mode, close) => {
    if (busy) return;
    if (mode === 'ebpf' && state.status && state.status.core === 'official') {
      uiToast('当前官方内核不支持 eBPF，请先切换到 liuran001 或 jieluojun 分支内核', 3600);
      return;
    }
    busy = true;
    setSaveBarSuppressed(true);
    try {
      // 先切 eBPF，再改 tun.enable：setEbpfEnabled() 可能重解析源码，顺序反过来会覆盖 tun 草稿。
      if (!setEbpfEnabled(mode === 'ebpf')) {
        uiToast('eBPF 配置未能切换，已保留当前配置', 3600);
        return;
      }
      const wantTun = mode === 'tun';
      if (!setTunListenerEnabled(wantTun)) {
        uiToast('TUN 监听器配置未能切换，已保留当前配置', 3600);
        return;
      }
      if (get(state.cfg, 'tun.enable') !== wantTun) set(state.cfg, 'tun.enable', wantTun);
      close();
      uiToast(mode === 'tun' ? '正在保存 TUN 配置并重启服务…' : '正在保存 eBPF 配置并重启服务…', 3000);
      const ok = await saveConfig({ silent: true, restart: true });
      if (ok) uiToast(mode === 'tun' ? '✅ TUN 已启用，服务已重启' : '✅ eBPF 已启用，服务已重启', 3200);
      else uiToast('配置未能保存，已保留草稿，请检查后重试', 4200);
    } finally {
      setSaveBarSuppressed(false);
      busy = false;
    }
  };
  const close = openSheet('选择透明代理方式',
    note('TProxy 已关闭。请选择接下来使用的透明接管方式；TUN 与 eBPF 不建议同时开启。选择后会立即保存配置并重启服务。'),
    h('div', { class: 'optlist', style: 'margin-top:10px' },
      (() => {
        const row = h('div', { class: 'opt', style: 'cursor:pointer' },
          h('span', { class: 'radio' }),
          h('div', { class: 'li-main' },
            h('div', { class: 'li-title', text: 'TUN 接管' }),
            h('div', { class: 'li-sub', text: '开启 tun.enable，把 eBPF 的 local/shared.enabled 置为 false（参数保留）' })));
        row.onclick = () => apply('tun', close);
        return row;
      })(),
      (() => {
        const row = h('div', { class: 'opt', style: 'cursor:pointer' },
          h('span', { class: 'radio' }),
          h('div', { class: 'li-main' },
            h('div', { class: 'li-title', text: 'eBPF 入站' }),
            h('div', { class: 'li-sub', text: '关闭 tun.enable，把 eBPF 的 local/shared.enabled 置为 true' })));
        row.onclick = () => apply('ebpf', close);
        return row;
      })(),
    ),
    h('button', { class: 'btn block', text: '稍后选择', style: 'margin-top:12px', onclick: () => close() }),
  );
  return close;
}

// ================= 顶栏「配置源码」按钮 =================
// 源码编辑器常驻在工具页之外（全局单例），这个按钮在任何页面都能把它拉起来。
const srcBtn = document.getElementById('srcBtn');
if (srcBtn) srcBtn.onclick = () => openSourceSheet();

const modSettingsBtn = document.getElementById('modSettingsBtn');
if (modSettingsBtn) modSettingsBtn.onclick = () => {
  const st = state.status || {};
  const asOn = st.autostart !== 'false';       // 默认开启（后端 get_setting autostart true）
  const hsOn = st.hotspot_proxy !== 'false';   // 默认开启
  const v6On = st.system_ipv6 === 'true';      // 默认关闭（后端 get_setting system_ipv6 false）
  const tpOn = st.tproxy === 'true';           // 默认关闭
  const hsStatus = h('div', { style: 'font-size:12.5px;color:var(--text-3);margin-top:10px;line-height:1.5', text: tunHsStatusText() });
  const tpStatus = h('div', { style: 'font-size:12.5px;color:var(--text-3);margin-top:10px;line-height:1.5', text: tproxyStatusText() });
  // Tproxy 不生效时靠人猜很慢：一键跑后端诊断，把端口识别 / 监听地址 / 策略路由 /
  // iptables 全部打出来，可直接复制给开发者。
  const tpDiagBtn = h('button', {
    class: 'btn', style: 'margin-top:8px;padding:6px 12px;font-size:13px;align-self:flex-start', text: '诊断 Tproxy',
    onclick: async () => {
      tpDiagBtn.disabled = true;
      tpDiagBtn.textContent = '诊断中…';
      try {
        const r = await cmdline('tproxy-diag');
        const text = ((r && r.stdout) || '') + ((r && r.stderr) ? '\n[stderr]\n' + r.stderr : '');
        const pre = h('pre', {
          class: 'logbox', style: 'max-height:52vh;white-space:pre-wrap;word-break:break-all;font-size:11.5px',
          text: text.trim() || '（无输出）',
        });
        // 复制即收起：这一步已经把内容带走，再留一个「知道了」纯属多余点击。
        // 复制失败时不收起——用户还得靠手动长按选择文本。
        const copyBtn = h('button', { class: 'btn block pri', text: '复制诊断结果', style: 'margin-top:10px' });
        copyBtn.onclick = async () => {
          try {
            await copyText(pre.textContent);
            uiToast('诊断结果已复制');
            closeSheet();
          } catch (e) {
            uiToast('复制失败，请长按选择文本');
          }
        };
        openSheet('Tproxy 诊断', pre, copyBtn);
      } finally {
        tpDiagBtn.disabled = false;
        tpDiagBtn.textContent = '诊断 Tproxy';
      }
    },
  });
  let busy = false;
  let tpBusy = false;
  let sheetClose = null;
  let tpSwInput = null;
  let tpPollTimer = null;
  const stopTpPoll = () => { if (tpPollTimer) { clearTimeout(tpPollTimer); tpPollTimer = null; } };
  // Tproxy 状态存在两种「读一次拿不到真值」的窗口：开启时后端先同步重启内核，
  // 之后规则由后台对账逐步安装（端口就绪 + iptables 装好可能要几百毫秒到几秒）；
  // 而 status 走 6 秒 TTL 的热缓存，改完开关后的旧值也可能被顶上几秒。之前 300ms
  // 后只补读一次，撞进这两个窗口里文案就停在 standby/pending 或旧状态，弹层此后
  // 再无人刷新 —— 只能取消重开。改为一小段轮询：读到目标终态才收手（弹层被换/
  // 关闭即停，最多约 14 秒，覆盖后端 12×0.5s 的对账重试 + 热缓存 TTL 余量）。
  const tproxyReached = (want) => {
    const stn = state.status || {};
    const s = String(stn.tproxy_state || '');
    if (want) return stn.tproxy === 'true' && (/^on:/.test(s) || /^holding:/.test(s));
    return stn.tproxy !== 'true' || s === 'off';
  };
  const pollTpStatus = (want, deadline) => {
    stopTpPoll();
    const step = async () => {
      if (sheetClose && !sheetClose.isCurrent()) return;   // 弹层已换/已关：停
      try { await refreshStatus(); } catch (e) { /* 状态刷新失败不影响开关 */ }
      if (sheetClose && !sheetClose.isCurrent()) return;   // 往返期间被关/被换：停
      if (!tpBusy && tpSwInput) tpSwInput.checked = !!(state.status && state.status.tproxy === 'true');
      if (!tpBusy) tpStatus.textContent = tproxyStatusText();
      if (tproxyReached(want) || Date.now() >= deadline) { tpPollTimer = null; return; }
      tpPollTimer = setTimeout(step, 900);
    };
    tpPollTimer = setTimeout(step, 350);
  };
  sheetClose = openSheet('模块设置',
    // 开机自启：从主页状态卡挪过来——它是「装完就定一次」的模块级选项，
    // 跟热点共享代理同属模块行为，放一起；状态卡只留运行态与总开关。
    h('div', { class: 'f-row', style: 'margin-top:6px' },
      h('div', { class: 'f-label' }, '开机自启', h('div', { class: 'f-desc', text: '系统启动完成后自动运行内核（关闭后每次开机需手动开启总开关）' })),
      h('div', { class: 'f-ctl' }, switchCtl(asOn, async (v) => {
        // 先提示，避免等待执行桥回包后才有反馈；写入仍按原流程确认。
        uiToast(v ? '正在开启开机自启…' : '正在关闭开机自启…', 1200);
        await cmdline(`set autostart ${v}`);
        // 同步本地状态：主页状态签名含 autostart，避免下次轮询把开关弹回旧值
        if (state.status) state.status.autostart = v ? 'true' : 'false';
        uiToast(v ? '开机自启已开启' : '开机自启已关闭');
      }))),
    h('div', { class: 'f-row', dataset: { androidOnly: '1' } },
      h('div', { class: 'f-label' }, '热点共享代理', h('div', { class: 'f-desc', text: 'TUN 模式下让热点 / USB 共享客户端的流量一并走内核代理；关闭后共享客户端直连上网，不经过内核（本机代理不受影响）' }), hsStatus),
      h('div', { class: 'f-ctl' }, switchCtl(hsOn, async v => {
        if (busy) return;
        busy = true;
        // 先反馈，热点规则对账已在后端后台执行；不等待 900ms 才刷新。
        uiToast(v ? '正在开启热点共享代理…' : '正在关闭热点共享代理…', 1400);
        try {
          await cmdline(`set hotspot_proxy ${v}`);
          uiToast(v ? '✅ 热点共享代理已开启' : '热点共享代理已关闭，共享客户端直连');
          // 仅短暂延后补一次最终状态，不阻塞点击反馈。
          setTimeout(async () => {
            try { await refreshStatus(); } catch (e) { /* 状态刷新失败不影响开关 */ }
            hsStatus.textContent = tunHsStatusText();
          }, 300);
        } finally { busy = false; }
      }))),
    // 系统 IPv6：模块级 sysctl 开关（disable_ipv6），与配置里内核自身的 ipv6: 字段是两回事
    h('div', { class: 'f-row', dataset: { androidOnly: '1' } },
      h('div', { class: 'f-label' }, '系统 IPv6', h('div', { class: 'f-desc', text: '开启＝系统 IPv6 保持可用；关闭（默认）＝在内核协议栈层面禁用各网卡 IPv6，防止 v6 流量绕过代理直连。与「配置 → 全局配置」里内核自身的 IPv6 总开关互不影响' })),
      h('div', { class: 'f-ctl' }, (() => {
        let sw;
        sw = switchCtl(v6On, async (v) => {
          if (busy) { sw.querySelector('input').checked = !v; return; }
          busy = true;
          uiToast(v ? '正在启用系统 IPv6…' : '正在关闭系统 IPv6…', 1400);
          try {
            await cmdline(`set system_ipv6 ${v}`);
            if (state.status) state.status.system_ipv6 = v ? 'true' : 'false';
            await refreshStatus();
            if (!v && Number(/** @type {any} */ (state.status?.ipv6_locked_by)) === 1) {
              uiToast('系统 IPv6 已关闭，但 eBPF 入站有角色 ipv6 开启（需其 v6 重定向路由），协议栈保持可用', 4500);
            } else {
              uiToast(v ? '系统 IPv6 已启用' : '系统 IPv6 已禁用');
            }
            if (typeof window !== 'undefined' && window.rerenderCurrent) window.rerenderCurrent();
          } finally { busy = false; }
        });
        return sw;
      })())),
    // Tproxy 代理：开启→识别端口+关 TUN+装 TPROXY 规则；关闭→拆规则+还原 TUN 配置
    h('div', { class: 'f-row', dataset: { androidOnly: '1' } },
      h('div', { class: 'f-label' }, 'Tproxy 代理', h('div', { class: 'f-desc', text: '开启后自动识别配置里的 TProxy 端口（tproxy-port 或 tproxy 监听器），关闭配置里的 TUN 并把 eBPF 入站的 local/shared.enabled 置为 false（参数原样保留），安装 TPROXY 转发规则接管系统流量（内核会重启）；关闭则拆除规则并还原本次自动修改的 TUN 配置。应用黑白名单直接复用 TUN 页「仅代理以下应用」／「排除以下应用」（前者优先），改完保存配置自动生效' }), tpStatus, tpDiagBtn),
      h('div', { class: 'f-ctl' }, (() => {
        let sw;
        sw = switchCtl(tpOn, async (v) => {
          if (tpBusy) { sw.querySelector('input').checked = !v; return; }
          tpBusy = true;
          const wasDirty = state.dirty;
          if (state.status) state.status.tproxy = v ? 'true' : 'false';
          tpStatus.textContent = v ? '当前状态：正在应用 Tproxy 规则并重启内核…' : '当前状态：正在关闭 Tproxy 规则…';
          uiToast(v ? '正在开启 Tproxy…' : '正在关闭 Tproxy…', 1600);
          try {
            // 关闭时先还原配置但暂不重启，等用户选择 TUN/eBPF 后由保存流程统一重启。
            const r = await cmdline(v ? 'tproxy-set true' : 'tproxy-set false defer');
            const out = ((r && r.stdout) || '').trim();
            const ok = !!r && r.errno === 0 && !/(^|\n)ERR/.test(out);
            if (ok) {
              if (state.status) state.status.tproxy = v ? 'true' : 'false';
              uiToast(v ? '✅ Tproxy 已开启' : '✅ 已还原默认状态');
              // 后端改过 config.yaml（TUN 开关/监听器注释）：重载草稿，
              // 避免旧草稿在下次保存时把手术结果覆盖回去
              let reloaded = false;
              try { await loadConfig(); rerenderCurrent(); reloaded = true; } catch (e) { /* 重载失败不影响开关 */ }
              if (wasDirty) uiToast('⚠️ 配置已由模块修改并重新载入，先前未保存的编辑已丢弃', 4200);
              // TProxy 关闭后不再静默恢复 TUN；让用户明确选择 TUN 或 eBPF，避免两种
              // 透明接管方式同时生效。选择结果作为普通配置草稿等待顶部保存。
              if (!v && reloaded) showTransparentModePicker();
            } else {
              if (state.status) state.status.tproxy = (!v) ? 'true' : 'false';
              sw.querySelector('input').checked = !v;   // 回弹开关显示
              uiToast('⚠️ ' + (out || (r && r.stderr) || '操作失败'), 5000);
            }
            try { await refreshStatus(); } catch (e) { /* 状态刷新失败不影响开关 */ }
            tpStatus.textContent = tproxyStatusText();
            // 规则安装由后台对账完成、且 status 走热缓存：单次补读会撞进中间态窗口，
            // 改为轮询直到读到目标终态（on/holding 或 off），弹层关闭/被换即停。
            if (ok) pollTpStatus(v, Date.now() + 14000);
          } finally { tpBusy = false; }
        });
        tpSwInput = sw.querySelector('input');
        return sw;
      })())),
  );
  // 路由器平台：摘掉安卓专有的三行（热点共享 / 系统 IPv6 / Tproxy），换成一句说明。
  // 这些功能的后端实现依赖 Android 的 iptables / sysctl / 共享网络，路由器上用不了，
  // 与其留着点了报错，不如如实说明。
  if (isOpenWrt()) {
    document.querySelectorAll('#sheetContent [data-android-only]').forEach(n => n.remove());
    document.getElementById('sheetContent')?.append(note('路由器平台：流量接管请在配置里使用 TUN（tun.enable，需 kmod-tun）或自行配置 TPROXY；热点共享 / 系统 IPv6 / Tproxy 一键接管 / 应用级代理为 Android 专有功能，此处不提供。'));
  }
  // 打开弹层时异步刷一次最新状态，确保 Tproxy 与热点对账状态实时呈现
  refreshStatus().then(() => {
    if (sheetClose && sheetClose.isCurrent()) {
      hsStatus.textContent = tunHsStatusText();
      if (!tpBusy) {
        tpStatus.textContent = tproxyStatusText();
        if (tpSwInput) tpSwInput.checked = !!(state.status && state.status.tproxy === 'true');
        if (state.status && state.status.tproxy === 'true' && !tproxyReached(true)) {
          pollTpStatus(true, Date.now() + 10000);
        }
      }
    }
  }).catch(() => {});
};

// ================= 状态 =================
// 导航副标题按平台据实呈现：路由器上内核页只有「更新 / 导入」，没有分支内核可切换。
// index.html 是静态文件，平台要等后端状态回来才知道，所以在首份状态落定后改一次文案。
let __platTextApplied = '';
function applyPlatformText() {
  const plat = state.platform || 'android';
  if (plat === __platTextApplied) return;
  __platTextApplied = plat;
  const sec = document.getElementById('page-core');
  if (!sec) return;
  sec.dataset.sub = (plat === 'openwrt') ? '内核更新与导入' : '内核下载与切换';
  const active = document.querySelector('.tab.active, .nav-item.active');
  if (active && active.dataset.page === 'page-core') {
    document.getElementById('pageSubtitle').textContent = sec.dataset.sub;
  }
}

window.shellCmd = async (cmd) => cmdline(cmd);

let statusTimer = null;
let lastStatusSig = '';
// 运行时长：设备侧同时给出「采样时刻的 epoch 秒」与「已运行秒数」，两者相减即
// 内核启动的绝对时刻。前端只用这个绝对起点 + 本地时钟显示，不再把设备采样值与
// 本地收包时刻配对，因此命令耗时、回包乱序、命令排队都不会让秒数忽快忽慢。
let upStartMs = null;   // 内核启动时刻（本地时钟毫秒）
let upPid = null;       // 该起点对应的 pid，用于识别内核重启
// 通过 API 切换的模式是「运行时」状态，不会写进 config.yaml；
// status 里的 mode 默认来自配置文件，若后端回读 API 失败就会把高亮拽回配置值。
// 这里记住本次切换（绑定 pid），直到状态回读确认、或内核重启（pid 变化）才清除。
let modeOverride = null;
let modeBusy = false;
let modeRequestId = 0;

function fmtDur(sec) {
  const p = n => String(n).padStart(2, '0');
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60), ss = Math.floor(sec % 60);
  return (d ? `${d}天${p(hh)}` : p(hh)) + `:${p(mm)}:${p(ss)}`;
}
function statusSig(st) {
  // 只把"会改变页面结构"的字段放进签名；uptime 每秒都在变，单独定点更新
  if (!st) return 'null';
  return [st.running, st.pid, st.mode, st.core, st.autostart, st.current_ver,
    st.liuran001_exists, st.jieluojun_exists, st.official_exists, st.liuran001_ver, st.jieluojun_ver, st.official_ver,
    st.controller, st.config_exists, st.tproxy, st.tproxy_state,
    (modeOverride ? modeOverride.pid + ':' + modeOverride.mode : '')].join('|');
}
let warnedJsonRepair = false;      // 同一会话只记一次「已自动修复」，避免刷屏

let lastStatusFetchTs = 0;   // 状态获取节流：5 秒心跳（仅概览页）与「落地补一次」共用
let idleStatusT = 0;           // 落地补刷的延后句柄（合并连发，突发期间不落桥）
function startDashLogLoop() {
  if (dashLogTimer) return;
  dashLogTimer = setInterval(() => {
    if (current !== 'page-dashboard' || document.visibilityState !== 'visible') return;   // 离开不烧桥，也不再自杀（落地复用 DOM 时环还在）
    if (panelForeground) return;   // 面板在前台：桥一次都不发（这是面板内卡顿最大的一路争抢）
    if (!dashLogsFn || dashLogBusy || logsPaused || userScrollingOrEditing()) return;   // 突发/拖动中直接跳过本轮：不吃退避额度，停手后 1 秒内恢复
    if (Date.now() < dashLogSkipUntil) return;
    dashLogBusy = true;
    Promise.resolve(dashLogsFn()).then((changed) => {
      if (changed) { dashLogStreak = 0; dashLogSkipUntil = 0; }
      else { dashLogStreak++; dashLogSkipUntil = Date.now() + Math.min(8000, 1000 << Math.min(3, dashLogStreak - 1)); }
    }).catch(() => { }).finally(() => { dashLogBusy = false; });
  }, 1000);
}

// prefetched：启停/重启命令（start-json / stop-json / restart-json）已经把状态 JSON
// 一并带回来了，直接用它，不再多发一次 status 往返（慢设备上省一两百毫秒）。
// 带回的 JSON 多两个字段：action_rc / action_msg —— 命令失败时把原因弹给用户
// （以前总开关启动失败只会默默弹回，用户什么都看不到）。
async function refreshStatus(showErr = false, background = false, prefetched = null) {
  if (panelForeground) return;
  if (panelForeground || (background && userScrollingOrEditing())) return;
  const requestedModeRev = modeRequestId;
  if (DEMO) {
    state.status = { running: 0, pid: '', core: 'liuran001', mode: 'rule', autostart: 'true', controller: '127.0.0.1:9090', config_exists: 1, liuran001_exists: 0, jieluojun_exists: 0, official_exists: 0, liuran001_ver: '', jieluojun_ver: '', official_ver: '', current_ver: '', uptime: '' };
    if (current === 'page-dashboard') rerenderCurrent();
    return;
  }
  lastStatusFetchTs = Date.now();
  const initialLogsP = !state.status && !state.statusErr ? readDashboardLogs() : null;
  let r = prefetched || await cmdline('status');
  if (prefetched && !parseJsonLoose(prefetched && prefetched.stdout)) {
    // 带回的输出不是合法 JSON（老脚本 / 输出被污染）：退回普通 status 读数
    r = await cmdline('status');
  }
  if (initialLogsP) await initialLogsP; // Commit initial status only after logs are cached.
  if (panelForeground || (background && userScrollingOrEditing())) return;
  let j = parseJsonLoose(r && r.stdout);
  // 解析靠修复才成功：状态能正常显示，但源头有问题，记一条 WARN 留痕（不打扰用户）
  if (j && lastJsonRepair() && !warnedJsonRepair) {
    warnedJsonRepair = true;
    uiLog('warn', `status 输出含非法字符，${lastJsonRepair()}`, execBrief('status', r, 400));
  }
  if (!j) {
    // 二次尝试：把 stderr 丢掉，并只截取以 { 开头到 } 结尾的那一段再交给前端。
    // 应对「管理器把 stderr 并进 stdout」「环境里有别的东西往 stdout 打字」这类脏输出。
    const r2 = await cmdline("status 2>/dev/null | sed -n '/^{/,/^}/p'");
    const j2 = parseJsonLoose(r2 && r2.stdout);
    if (j2) { uiLog('warn', 'status 首次输出被污染，已用净化模式取回状态', execBrief('status', r, 300)); r = r2; j = j2; }
  }
  if (panelForeground || (background && userScrollingOrEditing())) return;
  if (j) {
    // A status request started before the acknowledged PATCH cannot undo that write.
    if (requestedModeRev !== modeRequestId && modeOverride && String(j.pid || '') === modeOverride.pid) {
      j.mode = modeOverride.mode;
      j.mode_src = 'pending';
    }
    const previousMode = state.status?.mode;
    state.status = j;
    applyBackendInfo(j);
    applyPlatformText();
    // 轻量资源轮询（见 startResourceLoop）曾因后端命令缺席而停摆时，这里给一次重试机会：
    // 状态刷新成功说明后端可用，下一拍就恢复 CPU / 内存的 2 秒刷新。
    resFails = 0;
    maybeScheduleCpuFill(j);   // 见函数注释：尚无值 / 只有占位值时按 cpu_wait_ms 排一次补读
    if (previousMode !== j.mode && typeof window !== 'undefined') window.dispatchEvent(new window.Event('mihomo-mode-changed'));
    state.statusErr = null;
    syncUpStart(state.status);
    // 启停命令带回的结果：失败原因直接给用户看（成功时页面状态变化本身就是反馈）
    if (prefetched && j.action_rc != null && Number(j.action_rc) !== 0) {
      const msg = String(j.action_msg || '').trim();
      uiLog('warn', '启停命令返回失败', msg);
      uiToast('操作未成功：' + (msg.split('\n').filter(Boolean).slice(-2).join(' ') || '请查看运行日志'), 5000);
    }
  } else {
    state.status = null;
    // 这里以前只弹个 toast 就完事，用户什么证据都留不下。现在必定写一条日志：
    // 落盘失败也会进浏览器缓存，「工具 → 界面日志」一定拿得到。
    state.statusErr = execBrief('status', r, 600);
    uiLog('error', '状态获取失败（status 输出不是合法 JSON）', state.statusErr);
    if (showErr) uiToast('状态获取失败: ' + ((r && (r.stderr || r.stdout)) || '无输出'), 3000);
  }
  // 运行中的实时 mode 由 status 内部从 API 回读；回读成功（与覆盖值一致）即可丢弃覆盖
  if (modeOverride && state.status) {
    if (String(state.status.pid || '') !== String(modeOverride.pid)) modeOverride = null;   // 内核已重启
    else if (state.status.mode === modeOverride.mode) modeOverride = null;                  // 已同步
    else if (state.status.mode_src === 'live') modeOverride = null;                         // 实时回读与覆盖值不符，以内核为准
  }
  if (initialLogsP) bumpUiRev(); // Hidden dashboard skeleton must also be invalidated.
  // 签名比对与「落地缓存作废」必须和当前在哪一页无关：
  // 在内核页下载完内核时状态就变了（liuran001_exists 0→1），若因为不在概览页就提前
  // return，bumpUiRev() 不会执行，概览页的落地缓存仍被 pageIsFresh 判为新鲜 ——
  // 切回主页复用的是旧 DOM，显示「未安装」，只有重进面板才会刷新。
  const sig = statusSig(state.status);
  const sigChanged = sig !== lastStatusSig;
  if (sigChanged) {
    lastStatusSig = sig;
    bumpUiRev();            // 运行态变了：所有页面的落地缓存一并作废
  }
  // 概览页：仅当关键状态变化才整体重绘；运行秒数仅定点更新文本，杜绝周期性跳动
  if (document.visibilityState !== 'visible' || current !== 'page-dashboard') return;
  if (sigChanged) rerenderCurrent();
  else { paintUptime(); paintResources(); }
}

// 由「设备采样时刻 - 已运行秒数」得到内核启动的绝对时刻。
// date 与 ps etime 都是整秒截断，各自 ±1 秒，两次轮询的候选值差异最大接近 2 秒；
// 阈值必须严格大于该抖动上限（取 3 秒），否则截断噪声会周期性触发校正，
// 表现为运行时长秒数每隔几次轮询就停顿/回跳一下。真实漂移（换内核之外的异常）才会达到 3 秒。
function syncUpStart(st) {
  if (!st || !st.running) { upStartMs = null; upPid = null; return; }
  const pid = String(st.pid || '');
  const epoch = Number(st.epoch_sec);
  const dev = Number(st.uptime_sec);
  let start = null;
  if (Number.isFinite(epoch) && epoch > 0 && Number.isFinite(dev) && dev >= 0) {
    start = Math.round(epoch * 1000 - dev * 1000);
  } else if (Number.isFinite(dev) && dev >= 0) {
    start = Date.now() - dev * 1000;          // 无 epoch 时的粗略起点
  }
  if (start === null) return;
  if (upStartMs === null || pid !== upPid) { upStartMs = start; upPid = pid; return; }  // 首次 / 重启
  if (Math.abs(start - upStartMs) >= 3000) { upStartMs = start; upPid = pid; }          // 大幅漂移
}

// 运行时长 = 本地时钟 − 内核启动时刻：严格逐秒 +1，不做任何本地累加
function paintUptime() {
  const up = document.querySelector('#page-dashboard [data-uptime]');
  if (!up) return;
  const st = state.status;
  if (!st || !st.running) { up.textContent = '—'; return; }
  // 兜底：万一 uptime 里还夹着控制字符（老脚本/异常 ROM），显示前清一遍
  if (upStartMs === null) { up.textContent = String(st.uptime || '').replace(/[\x00-\x1f]/g, '').trim() || '—'; return; }
  up.textContent = fmtDur(Math.max(0, Math.floor((Date.now() - upStartMs) / 1000)));
}

// CPU / 内存占用：与 uptime 同款定点更新 —— 数值随心跳每次都在变，放进 statusSig
// 会周期性整页重绘，故只按 data-cpu / data-mem 定点换文本（心跳 5s 一拍）。
// cpu_pct 为跨读数差分：内核刚启动 / 刚刷入模块的第一拍没有基线（cpu_dbg=new/short）
// → 显示「CPU …」；若持续不是数值（后端读取失败），把 cpu_dbg 原因直接显示出来
// （如 CPU !stat12），截图即可定位，不用翻日志。
function resText(kind, st) {
  if (kind === 'cpu') {
    const v = st && st.cpu_pct;
    if (typeof v === 'number' && v >= 0) return 'CPU ' + v.toFixed(1) + '%';
    const dbg = st ? String(st.cpu_dbg || '') : '';
    if (!dbg || dbg === 'new' || dbg === 'short') return 'CPU …';
    return 'CPU !' + dbg;
  }
  const k = st && Number(st.mem_kib);
  if (!Number.isFinite(k) || k <= 0) return 'MEM —';
  return k >= 1024 ? 'MEM ' + (k / 1024).toFixed(1) + ' MiB' : 'MEM ' + Math.round(k) + ' KiB';
}
function resBadge(kind, st) {
  const title = kind === 'cpu'
    ? (st && st.cpu_dbg === 'avg'
      ? 'mihomo 进程 CPU 占用（当前为生命期均值，稍后换成实时值）'
      : 'mihomo 进程 CPU 占用（实时窗口差分，每 2 秒刷新）')
    : 'mihomo 进程常驻内存（RSS，每 2 秒刷新）';
  return h('span', { class: 'badge b', dataset: { [kind]: '1' }, text: resText(kind, st), title });
}
function paintResources() {
  const st = state.status;
  for (const kind of ['cpu', 'mem']) {
    const el = document.querySelector('#page-dashboard [data-' + kind + ']');
    if (el) {
      el.textContent = resText(kind, st);
      // 占位值（生命期均值）与实时值的说明不同，同时把 title 换掉，长按/悬停看到的一直是对的
      const title = kind === 'cpu'
        ? (st && st.cpu_dbg === 'avg'
          ? 'mihomo 进程 CPU 占用（当前为生命期均值，下一拍换成实时值）'
          : 'mihomo 进程 CPU 占用（实时窗口差分，每 2 秒刷新）')
        : 'mihomo 进程常驻内存（RSS，每 2 秒刷新）';
      if (el.title !== title) el.title = title;
    }
  }
}

// ---------------- CPU / 内存实时刷新（主页徽标） ----------------
// 状态心跳是 5 秒一拍，而且每次都要陪跑完整 status（API 回读 + 配置扫描）；CPU / 内存
// 若只靠它更新，最快也要等 5 秒才动一次。这里给主页单开一路轻量轮询：后端 `res` 命令
// 只读 /proc（pid 判活 + stat/statm/uptime），取回后只定点换两个徽标的文本 ——
// 不整页重绘、不进 statusSig。
// 节拍 2 秒：与 proc_res_usage 的 2 秒采样窗口对齐（更快只会读到同一个窗口值）。
// 与其它周期工作同一套让路规则：非主页 / 不可见 / 面板前台 / 正在滑动或切页 / 上一次还没回来
// 一律跳过本轮；后端命令不存在（老脚本）时连挂 3 次即自动停摆，等下一次状态刷新再恢复。
const RES_POLL_MS = 2000;
let resTimer = null, resBusy = false, resFails = 0;
// 取一次轻量资源读数并并入 state.status（返回取回的 JSON，失败为 null）。
// 单次只有一个在飞（resBusy 互斥）；内核换了（重启 / 停止）时这一拍作废，
// 等状态心跳把整页带成新的。
async function fetchResourcesOnce() {
  if (DEMO || resBusy) return null;
  resBusy = true;
  try {
    const r = await cmdline('res');
    const j = parseJsonLoose(r && r.stdout);
    if (!j) { resFails++; return null; }
    resFails = 0;
    const cur = state.status;
    if (!cur || !j.running || String(j.pid) !== String(cur.pid)) return null;
    if (typeof j.cpu_pct === 'number') cur.cpu_pct = j.cpu_pct;
    if (typeof j.cpu_dbg === 'string') cur.cpu_dbg = j.cpu_dbg;
    if (typeof j.mem_kib === 'number') cur.mem_kib = j.mem_kib;
    if (current === 'page-dashboard') paintResources();
    return j;
  } catch (e) {
    resFails++;
    return null;
  } finally {
    resBusy = false;
  }
}
function startResourceLoop() {
  clearInterval(resTimer);
  resTimer = setInterval(() => {
    if (DEMO) return;
    if (current !== 'page-dashboard' || document.visibilityState !== 'visible') return;
    if (panelForeground) return;
    if (resBusy || resFails >= 3) return;
    if (userScrollingOrEditing()) return;
    const st = state.status;
    if (!st || !st.running || !st.pid) return;   // 没在跑内核：没有可读的进程，等心跳带状态过来
    fetchResourcesOnce();
  }, RES_POLL_MS);
}

// 心跳对齐到秒的翻转点，让显示恰好在整秒处跳变（而非任意相位）
let upTimer = null;
function startUptimeTicker() {
  clearTimeout(upTimer);
  const tick = () => {
    if (document.visibilityState === 'visible' && current === 'page-dashboard' && !panelForeground) paintUptime();
    const delay = upStartMs === null ? 1000 : (1000 - ((Date.now() - upStartMs) % 1000));
    upTimer = setTimeout(tick, Math.min(1000, Math.max(120, delay)));
  };
  tick();
}
window.refreshStatus = refreshStatus;

// 上述「CPU 基线提速」的补读定时器：同一时刻最多一个，防止多路 status 并发时堆叠。
// delayMs = 后端给的剩余窗口（cpu_wait_ms）+ 一点余量；0 / 缺省 = 老后端，退回原来的 2.5 秒。
// 上限仍是 2.5s、下限 200ms：补读本身要过一次 exec 桥，排得比桥往返还密只会堆请求；
// 后端每次都回报新的 cpu_wait_ms，所以「短窗口 → 真值」是收敛的，不会越排越多。
// 主页 CPU 出值提速：① 无基线时后端先给「生命期均值」占位（cpu_dbg=avg），首帧即有数；
// ② 尚无值 / 只有占位值时补一次后台读数换成实时窗口值 —— 补读时机不再盲等 2.5s，
//    而是照后端给的 cpu_wait_ms（首次窗口 600ms、稳态 2s 的剩余量）来排；
// ③ 实时值落地后取消未触发的补读。
// 两个入口都要调：boot-data 首屏（进主页看到的第一份状态）与 status 心跳。
function maybeScheduleCpuFill(st) {
  if (!st || current !== 'page-dashboard') return;
  const hasCpu = typeof st.cpu_pct === 'number' && st.cpu_pct >= 0;
  if (hasCpu && st.cpu_dbg !== 'avg') {          // 真值在手：这一轮结束
    cpuFillTries = 0;
    if (cpuEarlyTimer) { clearTimeout(cpuEarlyTimer); cpuEarlyTimer = null; }
    return;
  }
  if (!hasCpu && !st.running) return;            // 没在跑内核：没有可读的进程
  cpuFillTries = 0;
  scheduleCpuEarlyFetch(Number(st.cpu_wait_ms) > 0 ? Number(st.cpu_wait_ms) + 150 : 0);
}

const CPU_FILL_MAX_TRIES = 5;    // 补读次数上限：防后端一直不给值时无休止排队
let cpuEarlyTimer = null, cpuFillTries = 0;
function scheduleCpuEarlyFetch(delayMs = 0) {
  if (cpuEarlyTimer || cpuFillTries >= CPU_FILL_MAX_TRIES) return;
  const delay = Math.min(2500, Math.max(150, Number(delayMs) || 2500));
  cpuEarlyTimer = setTimeout(async () => {
    cpuEarlyTimer = null;
    if (current !== 'page-dashboard') return;
    if (document.visibilityState !== 'visible' || panelForeground) return;
    // 走轻量 res（后端只读 /proc，零 fork，一次往返十几毫秒），而不是整条 status
    // （status 要回读控制器 API、扫配置、还等首屏日志 —— 慢设备上就是几百毫秒起）。
    // 只为把一个 CPU 数字填上，没必要付那份钱。
    const j = await fetchResourcesOnce();
    if (!j) { refreshStatus(false, true); return; }   // 取不到（老后端 / 异常）：退回完整刷新
    const hasCpu = typeof j.cpu_pct === 'number' && j.cpu_pct >= 0;
    if (hasCpu && j.cpu_dbg !== 'avg') return;        // 真值到手
    // 还没到窗口：按后端给的剩余量再排一次（每次都比上一次更接近出值，收敛）
    cpuFillTries++;
    if (cpuFillTries < CPU_FILL_MAX_TRIES) {
      scheduleCpuEarlyFetch(Number(j.cpu_wait_ms) > 0 ? Number(j.cpu_wait_ms) + 150 : 0);
    }
  }, delay);
}

// 用户正在滑动/编辑源码时暂停 5 秒状态心跳：大文本编辑器的滚动重排对周期性
// 轮询很敏感，滑动中每隔几秒一次的 shell 心跳会造成规律性顿挫。
let lastScrollTs = 0;
let lastNavTs = 0;   // 最近一次切页时刻：来回点导航栏时，0.5~1.5s 的间隙比 navPending 宽，轮询专挑缝里钻——
                     // 桥回调落地的那一帧就是「每隔几秒突然顿一下」。用突发冷却把缝也封上。
document.addEventListener('scroll', () => { lastScrollTs = Date.now(); updateToTop(); }, { capture: true, passive: true });

// 回到顶部：滚过约 0.55 屏后右下角浮现；显隐复用上面既有滚动监听顺带刷新，
// 不新增逐事件处理器（resize 罕见、单独挂一个）。点击平滑回顶，程序滚动同样
// 走这条监听，状态自洽。
const toTopBtn = document.getElementById('toTopBtn');
function updateToTop() {
  if (!toTopBtn) return;
  const vh = window.innerHeight || 800;
  const on = (window.scrollY || window.pageYOffset || 0) > Math.max(240, vh * 0.55);
  if (toTopBtn._on !== on) { toTopBtn._on = on; toTopBtn.classList.toggle('on', on); }
}
if (toTopBtn) {
  toTopBtn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  window.addEventListener('resize', updateToTop, { passive: true });
}
function userScrollingOrEditing() {
  // 外部面板在前台：WebUI 全域静默（见 panelForeground 顶部注释）。
  // 这一条同时罩住日志环、状态心跳、落地补刷与工具页扫描——它们都走这个闸门。
  if (panelForeground) return true;
  if (isInteracting()) return true;   // 拖动排序/长按（core 统一标记）：滚动期间插队的轮询就是「规律性顿一下」
  if (navPending) return true;        // 切页在途（骨架→重渲染→入场动画）：所有周期轮询给过渡让路
  if (Date.now() - lastNavTs < 1600) return true;   // 切页突发冷却：连续点按期间桥完全静默，停手 1.6s 后才恢复
  if (Date.now() - lastScrollTs < 1200) return true;
  const ae = document.activeElement;
  return !!(ae && ae.classList && ae.classList.contains('code-area'));
}

function startStatusLoop() {
  clearInterval(statusTimer);
  // 5 秒心跳只对概览页有意义：以前它在每个页面都跑，一次 status 往返撞上进场动画/切页重渲染，
  // 就是「来回切页每隔几秒顿一下」的主节拍。非概览页改为落地后按需补一次（见 rerenderCurrent）。
  statusTimer = setInterval(() => {
    if (current !== 'page-dashboard') return;
    if (panelForeground) return;   // 面板在前台：状态心跳停摆，配合桥/日志一起让路
    if (document.visibilityState === 'visible' && !userScrollingOrEditing()) refreshStatus(false, true);
  }, 5000);
  // 运行时长逐秒刷新并对齐到整秒翻转点（不发任何请求）
  startUptimeTicker();
}
// 回到前台时刷新一次状态（无守护进程，不做自动拉起）
// 面板在前台时跳过：从后台切回来不该顺手在面板背后跑一次桥 + 整页重绘
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!panelForeground) refreshStatus(false, true);
});

// 主页配置校验：先绘制反馈，再进入可能阻塞宿主绘制的原生执行桥。
let configTestBusy = false;
function syncConfigTestButtons() {
  document.querySelectorAll('[data-config-test]').forEach(button => {
    button.disabled = configTestBusy;
    button.textContent = configTestBusy ? '校验中…' : '校验配置';
    button.setAttribute('aria-busy', String(configTestBusy));
  });
}
function waitForConfigTestPaint() {
  return new Promise(resolve => {
    let done = false, frame = null, task = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      if (task !== null) clearTimeout(task);
      if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      resolve();
    };
    // 后台/旧 WebView 可能暂停 rAF；兜底只保证不挂起，不宣称后台也能绘制。
    const fallback = setTimeout(finish, 250);
    if (typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => {
        if (done) return;
        frame = requestAnimationFrame(() => {
          if (!done) task = setTimeout(finish, 0);
        });
      });
    } else task = setTimeout(finish, 32);
  });
}
function clearConfigTestToast() {
  const toast = document.getElementById('toast');
  // 不清除用户在等待期间触发的其他通知。
  if (toast?.textContent === '校验中…') toast.hidden = true;
}
async function checkDashboardConfig() {
  if (configTestBusy) return;
  if (state.dirty) { uiToast('请先保存配置'); return; }
  configTestBusy = true;
  syncConfigTestButtons();
  uiToast('校验中…');
  try {
    await waitForConfigTestPaint();
    // 让出绘制期间可能切到配置页产生编辑，不能校验旧的磁盘内容。
    if (state.dirty) { uiToast('请先保存配置'); return; }
    const r = await cmdline('test');
    // stderr 也要收：内核 -t 的报错常走 stderr。
    const out = [(r.stdout || '').trim(), (r.stderr || '').trim()].filter(Boolean).join('\n');
    clearConfigTestToast();
    showTestResult(out);
  } catch (e) {
    clearConfigTestToast();
    uiToast('校验执行失败：' + (e?.message || String(e)), 3200);
  } finally {
    configTestBusy = false;
    syncConfigTestButtons();
    clearConfigTestToast();
  }
}

// 主页重启完整模块服务：停止/启动及接管规则由模块脚本统一处理。
let serviceRestartBusy = false;
function syncServiceRestartButtons() {
  document.querySelectorAll('[data-service-restart]').forEach(button => {
    button.disabled = serviceRestartBusy;
    button.textContent = serviceRestartBusy ? '重启中…' : '重启服务';
    button.setAttribute('aria-busy', String(serviceRestartBusy));
  });
}
async function restartDashboardService() {
  if (serviceRestartBusy) return;
  if (!state.status?.running) { uiToast('服务未运行，请使用总开关启动'); return; }
  serviceRestartBusy = true;
  syncServiceRestartButtons();
  uiToast('正在重启服务…');
  let acknowledged = false;
  try {
    await waitForConfigTestPaint();
    const restarted = await restartService();
    acknowledged = true;
    emitCoreConfigApplied();
    // 后端 restart-json 已保证 external-controller 端口就绪（或 PID 存活）后才返回，且把
    // 现算的状态 JSON 一并带回 —— 第一轮直接用它，不再多发一次 status。
    // 仍保留重试：防御 lived 热缓存 stale（stop 后空窗采样到 running=0 恰在 restart 后被命中）的误报。
    // 最多 3 次、每次间隔 1s 区分真失败与缓存误报；若刷新本身抛异常也重试，最终仍抛则走“状态刷新失败”分支。
    let ok = false;
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        await refreshStatus(false, false, i === 0 ? restarted : null);
        if (state.status?.running) { ok = true; break; }
      } catch (e) {
        lastErr = e;
      }
      if (i < 2) await new Promise(r => setTimeout(r, 1000));
    }
    if (ok) {
      uiToast('服务已重启', 3200);
    } else {
      if (lastErr) throw lastErr;
      uiToast('重启脚本已执行，但未确认服务运行，请查看运行日志', 3200);
    }
  } catch (e) {
    uiToast((acknowledged ? '重启脚本已执行，但状态刷新失败：' : '服务重启未确认：') + (e?.message || String(e)) + '；请查看运行状态和日志，不会自动重发', 5000);
  } finally {
    serviceRestartBusy = false;
    syncServiceRestartButtons();
  }
}

// ================= 主页 =================
PAGE_RENDER['page-dashboard'] = renderDashboard;
let dashLogTimer = null;
let webAccessDispose = null;   // webAccessCard 上一实例的清理入口（全局监听 + 扫描定时器，dispose 里一起清）
let dashInteractCtl = null;   // 主页全局监听注销句柄：重绘前先 abort 旧的，防逐次叠加
const dashLogCache = { text: '', at: 0 };   // 切页保留已读结果；2.5 秒仅用于控制后台更新频率
let dashboardLogsPending = null;
function readDashboardLogs() {
  if (dashboardLogsPending) return dashboardLogsPending;
  dashboardLogsPending = Promise.resolve().then(() => cmdline('logs 120'))
    .catch(e => ({ errno: -1, stdout: '', stderr: String(e?.message || e) }))
    .then(r => {
      // tail 之类命令的报错末尾常带换行；不裁掉，空行会被逐行卡片画成一张空白卡
      const errText = String(r?.stderr || '').trim();
      const error = !r || Number(r.errno) !== 0
        ? '日志读取失败：' + (errText || '执行桥未返回有效结果') : '';
      dashLogCache.text = error || String(r.stdout || '').trim();
      dashLogCache.at = Date.now();
      return r;
    }).finally(() => { dashboardLogsPending = null; });
  return dashboardLogsPending;
}
let dashLogsFn = null;        // renderDashboard 装载的取日志闭包（模块级环复用，重绘不重建定时器）
let dashLogBusy = false;
let dashLogSkipUntil = 0;     // 自适应退避：连续无新行时 2s/4s/8s 再问，新行出现立刻回到 1s 节奏
let dashLogStreak = 0;
let logsPaused = false;   // 手动暂停日志自动刷新（复制/阅读长日志时用）

// ============================================================
// 外部面板：在 WebUI 内嵌打开，页面不导航 —— 返回时主页不必重新加载
// ------------------------------------------------------------
// 旧做法是 window.open(url, '_blank')：管理器 WebView 不支持多窗口时，这一下会把
// WebUI 整页顶掉，「返回」就变成整页重载（状态/日志重拉、滚动丢失、界面闪一下）。
// 现在改成 WebUI 自己的全屏内嵌层：关掉即回到原样，页面自始至终没离开过，
// 主页的定时器/日志/滚动位置全在原地继续跑。
// 面板自带顶栏，这里不再压一条 WebUI 的头部上去：整屏就是 iframe，只在角落留
// 两个悬浮圆钮（左下返回、右下刷新）。进层用与切页同款的右缘平移，观感一致。
//
// 「刷新」为什么不能简单地 frame.src = url：
//   面板（zashboard / metacubexd 等）都是 hash 路由，切 tab 只改 #/logs、#/connections
//   这类 fragment，服务器和父页面都看不见；而面板与 WebUI 跨域（不同端口），
//   父页面读 frame.contentWindow.location 会被同源策略拦下。于是重写 src 只能写
//   入口 URL，面板重载后自然落回默认 tab（zashboard 的 / 重定向到 proxies）。
//   出路是借浏览器的联合历史：iframe 内的 hash 切换会在同一个 session history
//   里追加条目，且条目里记着完整 URL（含 hash）。把 iframe 导到 about:blank 会追加
//   一条新条目，紧接着 history.back() 回到上一条 —— 正是「面板 + 当时的 hash」，
//   而且 blank↔面板是文档级跳转（不是 bfcache 命中，iframe 文档不会进 bfcache），
//   面板会重新执行并按 hash 落到刷新前的 tab。这一切全程不需要读跨域 location。
//   实测 Chromium / WebKit / Firefox（Android WebView 即 Chromium 内核）：切到任意 tab →
//   刷新后仍在该 tab；父页面收不到 popstate（那次 back 消费的是 iframe 的条目）；
//   「返回」按钮与系统返回键行为不变。Firefox 对「尚未 load 完的文档」发起的导航会记成
//   替换而非追加，此时由 popstate 守卫接住并退回整页重载（回到入口 tab，不会弄乱历史）。
// ============================================================
let pembedState = null;   // 当前内嵌层：{ layer, timer, pushedHist, refreshing, ... }
// ---- 面板前台 / WebUI 静默的切换（配 panelForeground 顶部注释一起看）----
// 进场：立刻停掉 WebUI 的周期工作；等面板自己的进场动画（.3s）跑完，再给背景页
// 挂 .panel-open —— 停绘制与常驻动画。之所以要等这 300ms：那正是面板平移进来的过场，
// 背景打底的是主页；一进场就抽掉，会看到面板「滑过一片空白」。
function suspendPanelWork() {
  clearTimeout(panelResumeT);
  clearTimeout(idleStatusT);
  panelForeground = true;
  setBackgroundWorkPaused(true);
}
function markPanelOpenClass(self) {
  clearTimeout(self.hideT);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const apply = () => { if (pembedState === self) document.documentElement.classList.add('panel-open'); };
  if (reduced) apply();
  else self.hideT = setTimeout(apply, 320);
}
// 退场：面板一收（点返回/手势返回/刷新兜底收尾）就恢复 WebUI。
// 背景页类当场摘掉（退场动画要重新露出主页），状态与日志延后到退场动画之后补一次：
// 同帧发桥 + 整页重绘会和动画抢帧，正是「返回时顿一下」的老来源。
function resumePanelWork() {
  panelForeground = false;
  setBackgroundWorkPaused(false);
  clearTimeout(panelResumeT);
  panelResumeT = 0;
  document.documentElement.classList.remove('panel-open');
  dashLogStreak = 0; dashLogSkipUntil = 0;   // 日志环复位：恢复后第一轮就来新内容，不退避
  if (current !== 'page-dashboard' || document.visibilityState !== 'visible') return;
  // 单次补齐（一次 HTTP 往返）：签名变了才整页重绘。延后 340ms 是为了让位给
  // 退场动画，不是轮询 —— 只发一次。
  panelResumeT = setTimeout(() => {
    panelResumeT = 0;
    if (panelForeground) return;             // 面板又被打开了：这次补齐作废
    paintUptime();                           // 先按本地时钟把秒数直接刷对（不等桥）
    refreshStatus();                         // 一次往返补齐：签名变了才整页重绘
  }, 340);
}
function externalPanelUrl(st) {
  const ctl = (st && st.controller) || (state.cfg && state.cfg['external-controller']) || '127.0.0.1:9090';
  let host = String(ctl).replace(/^0\.0\.0\.0/, '127.0.0.1').replace(/^\*/, '127.0.0.1');
  // 页面开在另一台机器（远程浏览器）时 127.0.0.1 会指到访问者自己，
  // 一律换成页面主机名（面板端口沿用 external-controller 的端口）。
  // 管理器跳转进来时主机名本来就是 127.0.0.1，替换是无操作。
  if (IS_REMOTE && location.hostname) host = host.replace(/^[^:]+/, location.hostname);
  const uiname = (state.cfg && state.cfg['external-ui-name']) || 'ui';
  return 'http://' + host + '/' + uiname;
}
// 只拆 DOM，不动历史：重复点「打开外部面板」时用它原地换层
function teardownExternalPanel() {
  if (!pembedState) return null;
  const s = pembedState; pembedState = null;
  clearTimeout(s.timer);
  clearTimeout(s.refreshTimer);
  clearTimeout(s.hideT);   // 进场动画后「背景页停绘制」的补挂：层都拆了就别再挂
  clearInterval(s.closeTimer);
  // 关闭时立即摘掉 iframe，停止面板脚本与在途导航，只让空壳完成退出动画。
  // 延后启动的加载也已取消，旧面板不能在退出后继续占用共享 WebView。
  if (s.frame) { try { s.frame.remove(); } catch (e) { } }
  // 添加退出动画：向右平移出去，动画完成后再移除 DOM
  const layer = s.layer;
  layer.classList.add('pembed-out');
  // 动画时长 300ms，等动画完成后移除
  setTimeout(() => { layer.remove(); }, 300);
  return s;
}
// 刷新流程的守卫：onBlankReady 判定 blank 可能被记成「替换」时才开启的短窗口。窗口内到达的 popstate
// 只可能是我们自己那次 back() 越过面板条目、退到了 WebUI 的条目上 —— 把面板条目压回去、改走兜底重载，
// 面板不关。窗口之外（含 blank 确定为新条目的情形）的 popstate 一律按用户回退处理。
function externalPanelRefreshPop() {
  const s = pembedState;
  if (!s || s.refreshing !== 2 || !s.guardUntil || Date.now() > s.guardUntil) return false;
  if (HIST_OK) { try { history.pushState({ mb: current, mbPanel: 1 }, ''); } catch (e) { } }
  s.fallback();
  return true;
}
// fromPop=true 表示这次关闭由历史回退（系统返回键/手势）触发，历史条目已经弹掉，别再 back()
function closeExternalPanel(fromPop = false) {
  const s = pembedState;
  if (!s) return false;
  // 面板一收就恢复 WebUI：视觉上立刻要露出主页，后台的周期工作也当场解冻
  // （补齐的状态/日志延后到退场动画之后，见 resumePanelWork）
  resumePanelWork();
  // 面板存续期间，它内部滚到边界时的过冲有可能串给背景文档（跨域拦不住），
  // 把位置原样摆回：返回时看到的仍是离开前那一屏，而不是被悄悄挪走一截
  if (panelScrollY0 >= 0 && Math.abs((window.scrollY || 0) - panelScrollY0) > 1) {
    try { window.scrollTo(0, panelScrollY0); } catch (e) { }
  }
  panelScrollY0 = -1;
  const finish = () => {
    teardownExternalPanel();
    if (s.pushedHist && !fromPop) { try { history.back(); } catch (e) { } }
  };
  // 刷新进行中且 iframe 还在 about:blank 上（在途或已落地，几十毫秒到一秒的窗口）：此刻 back() 会被
  // blank 条目吃掉，WebUI 仍停在面板条目上，之后就得多按一次返回。等 iframe 离开 blank（被退掉或被
  // 原地替换）再关；4 秒兜底，届时无论如何都关。刷新已结束（含面板载不出来的兜底收尾）就直接关；
  // 历史回退触发的关闭也没得等，条目已经弹掉了。
  const pending = () => s.refreshing === 1 || (s.refreshing !== 0 && s.atBlank());
  if (!fromPop && s.pushedHist && pending()) {
    if (s.closeTimer) return true;
    const until = Date.now() + 4000;
    s.closeTimer = setInterval(() => {
      if (pembedState !== s) { clearInterval(s.closeTimer); return; }
      if (pending() && Date.now() < until) return;
      clearInterval(s.closeTimer); s.closeTimer = 0;
      finish();
    }, 50);
    return true;
  }
  finish();
  return true;
}
function openExternalPanel(st) {
  // 已开着就只换内容、沿用原来那条历史：不能 back() 再 pushState ——
  // back() 是异步的，会在新层弹出之后才到，popstate 里把刚开的新层一起关掉。
  const prev = teardownExternalPanel();
  if (!prev) panelScrollY0 = window.scrollY || 0;   // 换层（prev 存在）时沿用最初那次的位置
  const url = externalPanelUrl(st);
  const frame = h('iframe', { class: 'pembed-frame', src: url, title: '外部面板' });
  // 内嵌被拦/面板没下载/内核没跑时 iframe 只会白着：8 秒没 load 就把出路说出来
  const hint = h('div', { class: 'pembed-hint', hidden: true },
    h('span', { text: '面板一直没出来？多半是内核未运行、外部面板尚未下载，或 WebView 拦了内嵌。' }),
    h('button', { class: 'btn xs', text: '新窗口打开', onclick: () => { window.open(url, '_blank'); } }));
  // refreshing：0 空闲 / 1 已导到 about:blank，等它落地 / 2 已 history.back()，等面板按原 hash 重新载入 / 3 兜底重载中
  const self = { layer: null, frame, timer: 0, pushedHist: false, refreshing: 0, refreshTimer: 0, lenBefore: 0, guardUntil: 0, fallback: null, atBlank: null, closeTimer: 0, panelSeen: false, hideT: 0 };
  const armHint = () => { self.timer = setTimeout(() => { if (pembedState === self) hint.hidden = false; }, 8000); };
  armHint();
  const refreshBtn = h('button', { class: 'pembed-tool refresh', title: '刷新面板（停留在当前页）', 'aria-label': '刷新面板',
    onclick: () => refresh() }, h('span', { class: 'ico', text: '↻' }));
  const setRefreshTimer = (fn, ms) => { clearTimeout(self.refreshTimer); self.refreshTimer = setTimeout(fn, ms); };
  // iframe 是否正停在我们导过去的 about:blank：它继承本页源，location 可读；面板文档跨域，读了会抛
  const atBlank = () => { try { return frame.contentWindow.location.href === 'about:blank'; } catch (e) { return false; } };
  self.atBlank = atBlank;
  const refreshDone = (toast) => {
    clearTimeout(self.refreshTimer); self.refreshTimer = 0;
    self.refreshing = 0; self.guardUntil = 0;
    refreshBtn.classList.remove('spin'); refreshBtn.removeAttribute('aria-busy');
    if (toast) uiToast('面板已刷新', 1400);
  };
  // 兜底：重载回到面板入口（旧行为的效果）。刷新本身不能失败，最坏只是回不到原 tab。
  // 用 location.replace 而不是重写 src：replace 对跨域 frame 也允许调用，且不追加历史条目 ——
  // 否则每刷新一次就多一条 iframe 历史，「返回」得先把这些条目退完才轮到关面板。
  const refreshFallback = () => {
    if (pembedState !== self) return;
    self.refreshing = 3; self.guardUntil = 0;
    setRefreshTimer(() => refreshDone(false), 3000);   // 内核没跑/面板没下载时 load 不会来：3 秒后复位按钮
    try { frame.contentWindow.location.replace(url); } catch (e) { frame.src = url; }
  };
  self.fallback = refreshFallback;
  // about:blank 已落地。back 一步就是「面板 + 刷新前的 hash」：面板文档在导向 blank 时已被卸载
  // （iframe 文档不进 bfcache），这一步会重新加载，并由面板自己的路由按 hash 落回原 tab。
  const onBlankReady = () => {
    if (pembedState !== self || self.refreshing !== 1) return;
    self.refreshing = 2;
    // 历史长度增长 ⇒ blank 确定是新追加的条目，back 恰好回到面板条目，不可能越界。
    // 没增长则二义：要么追加时顺带剪掉了同样多的前进条目（上一次刷新留下的 blank 就是一条），
    // 要么被当成了替换（Firefox 对尚未 load 完的文档会这样做）—— 后者 back 会越过面板条目
    // 落到 WebUI 自己的条目上。只在这种二义情形下开一个短窗口，让 popstate 守卫兜住。
    self.guardUntil = history.length > self.lenBefore ? 0 : Date.now() + 400;
    // 3 秒后还停在 blank：back 没动（条目被回收等）→ 兜底；已离开 blank 说明面板正在载入，
    // 只是慢（冷加载的大 bundle），再等最多 12 秒，到点只复位按钮不打扰它
    setRefreshTimer(() => { if (atBlank()) refreshFallback(); else setRefreshTimer(() => refreshDone(false), 12000); }, 3000);
    try { history.back(); } catch (e) { refreshFallback(); }
  };
  frame.addEventListener('load', () => {
    clearTimeout(self.timer); hint.hidden = true;
    if (pembedState !== self) return;                       // 层已关：别再碰历史
    if (self.refreshing === 1) onBlankReady();
    else if (self.refreshing === 2 || self.refreshing === 3) refreshDone(true);
    else if (atBlank()) {
      // 没在刷新却落到了 about:blank：只可能是有人沿「前进」方向（桌面浏览器的前进键/触控板手势）
      // 走进了上次刷新留在前面的 blank 条目。退一步回到面板，别让人对着白屏
      if (self.panelSeen) { try { history.back(); } catch (e) { } }
    } else self.panelSeen = true;
  });
  // 刷新：about:blank → 等它 load → history.back() 回到面板刷新前那条历史（见本节顶部注释）。
  // 不读跨域 location、不需要面板配合，任何 hash 路由的面板（zashboard / metacubexd / yacd）都适用。
  const refresh = () => {
    if (pembedState !== self || self.refreshing) return;   // 上一次还没落地：忽略连点
    clearTimeout(self.timer); hint.hidden = true; armHint();
    refreshBtn.classList.add('spin'); refreshBtn.setAttribute('aria-busy', 'true');
    if (!HIST_OK || !self.panelSeen) { refreshFallback(); return; }
    self.refreshing = 1;
    self.lenBefore = history.length;
    // about:blank 一般几毫秒内就 load；1 秒没动静时看它到底落没落地：落了就照走，没落就兜底
    setRefreshTimer(() => { if (atBlank()) onBlankReady(); else refreshFallback(); }, 1000);
    try { frame.src = 'about:blank'; } catch (e) { refreshFallback(); }
  };
  const layer = h('div', { class: 'pembed', role: 'dialog', 'aria-label': '外部面板' },
    frame,
    h('button', { class: 'pembed-tool back', text: '‹', title: '返回 WebUI（页面不重载）', 'aria-label': '返回 WebUI',
      onclick: () => closeExternalPanel() }),
    refreshBtn,
    hint);
  document.body.append(layer);
  self.layer = layer;
  // 压一条历史：系统返回键/手势先关面板，而不是把 WebUI 弹出栈。
  // 换层（prev 存在）时沿用旧条目，历史里始终只有一条面板记录。
  if (prev && prev.pushedHist) self.pushedHist = true;
  else if (HIST_OK) { try { history.pushState({ mb: current, mbPanel: 1 }, ''); self.pushedHist = true; } catch (e) { } }
  pembedState = self;
  // 面板进前台：WebUI 侧全部让路（周期工作当场停、背景页绘制等进场动画结束再停）
  suspendPanelWork();
  markPanelOpenClass(self);
}
// 总开关卡片显示的是「接管方式」，不是 mihomo 的 rule/global/direct 策略模式。
// 例如开启 TProxy 时显示 tproxy；关闭 TProxy 后按当前配置识别 tun / ebpf。
function proxyModeLabel(st) {
  const on = v => v === true || v === 'true' || v === 1 || v === '1';
  if (st && on(st.tproxy)) return 'tproxy';
  const cfg = state.cfg || {};
  const ls = Array.isArray(cfg.listeners) ? cfg.listeners : [];
  const hasTunListener = ls.some(x => x && x.type === 'tun');
  const tunOn = on(cfg.tun && cfg.tun.enable) || hasTunListener;
  // 代理模式检测 eBPF 入站：只检测 local 模式的 enabled 字段开关
  const ebpfOn = ls.some(x => {
    if (!x || x.type !== 'ebpf') return false;
    const r = ebpfRoles(x);
    return r.localOn;
  });
  if (tunOn && ebpfOn) return 'tun/ebpf';
  if (tunOn) return 'tun';
  if (ebpfOn) return 'ebpf';
  return '无';
}

// Dashboard shows only the build identifier; full diagnostics remain available on tap.
function compactCoreVersion(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:mihomo(?:\s+meta)?|clash(?:[ .-]meta)?)\s*/i, '')
    .replace(/^version[:=\s]+/i, '');
  const version = text.split(' ')[0] || '';
  if (/^(?:android|linux|darwin|windows|freebsd|with)$/i.test(version)) return '';
  return version.length > 48 ? version.slice(0, 45) + '…' : version;
}

function showFullCoreVersion(source, version) {
  const close = openSheet('内核版本', h('pre', {
    class: 'logbox', style: 'max-height:45vh;margin:0;white-space:pre-wrap',
    text: source + '\n' + version,
  }));
  setSheetFooter(h('button', { class: 'btn block', text: '关闭', onclick: close }));
}

function renderDashboard(el) {
  el.innerHTML = '';
  const st = state.status;

  if (!st && !state.statusErr) { el.innerHTML = initialDashboardMarkup; return; }
  if (!st) {
    // 多半不是「模块没装」，而是没连上设备上的面板服务（服务未起 / 令牌被拒），
    // 重刷模块之前先试试重载页面，服务看门狗通常已经把它拉起来了。
    el.append(note('无法与设备上的面板服务通信。请先点「重试」重载页面；若反复不行，在「工具 → 面板服务」里重启服务，或重刷一次模块。', 'danger'));
    // 诊断永远可取回：即使写不进 run/webui.log，这段文字也在界面上，可一键复制
    const diag = state.statusErr || '（本次没有捕获到命令输出，可能是执行桥完全不可用）';
    const diagBox = h('pre', { class: 'logbox', style: 'max-height:180px;margin-top:12px;white-space:pre-wrap;word-break:break-all',
      text: `环境: 面板 HTTP\n${diag}` });
    el.append(diagBox);
    el.append(h('div', { style: 'display:flex;gap:10px;margin-top:10px;flex-wrap:wrap' },
      h('button', { class: 'btn pri', style: 'flex:1 1 120px', text: '重试', onclick: async () => {
        window.location.reload();
      } }),
      h('button', { class: 'btn', style: 'flex:1 1 120px', text: '复制诊断', onclick: async () => {
        await flushUiLogNow();
        const buf = uiLogBuffer();
        await copyText(`【Mihomo Box 诊断】\n环境: 面板 HTTP\n模块: ${state.moduleVersion || '未知'}\nUA: ${navigator.userAgent}\n${diag}\n\n----- 界面日志 -----\n${buf || '(空)'}`);
        uiToast('诊断信息已复制，可直接粘贴反馈');
      } }),
      h('button', { class: 'btn', style: 'flex:1 1 120px', text: '查看界面日志', onclick: () => { navTo('page-tools'); } }),
    ));
    return;
  }

  const running = !!st.running;
  // 与脚本 core_path 同一套选择：official / jieluojun 之外（含空值）一律按 liuran001
  const coreKey = st.core === 'official' || st.core === 'jieluojun' ? st.core : 'liuran001';
  const coreName = { official: 'MetaCubeX 官方', jieluojun: 'jieluojun', liuran001: 'liuran001' }[coreKey];
  const curVer = st.current_ver || st[coreKey + '_ver'] || '';
  const coreInstalled = st[coreKey + '_exists'];

  // 代理模式统计值：显示当前接管方式（tproxy / tun / ebpf），
  // 不要与下方的 rule/global/direct 策略模式混淆。
  const modeStatVal = h('div', { class: 'v', text: proxyModeLabel(st) });

  // ------- 状态卡 -------
  const hero = h('div', { class: 'card hero' });
  hero.append(
    h('div', { class: 'hero-heading' },
      h('div', { class: 'hero-status-line' },
        h('span', { class: 'hero-status-label', text: running ? '运行中' : '已停止' }),
        h('span', { class: `dot ${running ? 'on' : 'off'}`, 'aria-hidden': 'true' }),
        running && st.pid ? badge('PID ' + st.pid, 'g') : null,
        running && st.pid ? resBadge('cpu', st) : null,
        running && st.pid ? resBadge('mem', st) : null),
      h('button', {
        type: 'button', class: 'hsub hero-version',
        text: curVer ? `${coreName} · ${compactCoreVersion(curVer) || '版本未知'}` : (coreInstalled ? coreName : '⚠ 尚未安装内核'),
        title: curVer ? coreName + ' · ' + curVer : '',
        disabled: !curVer,
        'aria-label': curVer ? '查看完整内核版本信息' : '内核版本信息不可用',
        onclick: () => { if (curVer) showFullCoreVersion(coreName, curVer); },
      })),

    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'k', text: '代理模式' }), modeStatVal),
      h('div', { class: 'stat' }, h('div', { class: 'k', text: '运行时长' }), h('div', { class: 'v', text: '—', dataset: { uptime: '1' } })),
      h('div', { class: 'stat' }, h('div', { class: 'k', text: '混合端口' }), h('div', { class: 'v', text: String(st.mixed_port || state.cfg['mixed-port'] || '—') }))),

    // 主开关：直接启停 mihomo 内核（无守护进程，不会自动拉起或停止）
    h('div', { class: 'big-toggle' },
      h('div', { class: 'lbl' }, '总开关', h('div', { style: 'font-size:12px;color:var(--text-3);font-weight:400', text: running ? '关闭停止代理与接管' : '开启启动 mihomo 内核' })),
      switchCtl(running, async (v) => {
        if (v && !coreInstalled) { uiToast('请先到「内核」页下载内核', 3000); renderDashboard(el); return; }
        // 先给出反馈；启停命令一次往返把状态 JSON 一并带回（start-json / stop-json），
        // 不再串行补发 status —— 总开关从按下到界面翻转只剩内核真正启停的时间。
        uiToast(v ? '正在启动内核…' : '正在停止内核…', 1800);
        const r = await cmdline(v ? 'start-json' : 'stop-json');
        await refreshStatus(false, false, r);
        renderDashboard(el);
      })), 
  );
  // 统计卡渲染完立即填一次运行时长与 CPU/内存（后续由 1 秒心跳 + 5 秒状态心跳接管）
  requestAnimationFrame(() => { paintUptime(); paintResources(); });

  // ------- 模式切换（仅通过外部面板控制 API，不写配置、不重载内核）-------
  const modeCard = card();
  modeCard.append(h('div', { class: 'card-head' }, h('h3', { text: '运行模式' })));
  const modes = [['rule', '规则'], ['global', '全局'], ['direct', '直连']];
  // 内核运行时 st.mode 是 status 从 API 回读的实时值；回读不可用时用本会话的切换记忆兜底
  let curMode = st.mode || state.cfg.mode || 'rule';
  if (running && modeOverride && String(modeOverride.pid) === String(st.pid)) curMode = modeOverride.mode;
  const doSwitchMode = async (v, b) => {
    if (modeBusy || v === curMode) return;
    modeBusy = true;
    let id = ++modeRequestId;
    b.setAttribute('aria-busy', 'true');
    try {
      // zashboard: PATCH /configs, acknowledge first, then refresh runtime config.
      await patchMode(v);
      id = ++modeRequestId;
      curMode = v;
      modeBtns.forEach((button, i) => button.classList.toggle('on', modes[i][0] === v));
      modeOverride = { pid: String(st.pid || ''), mode: v };
      if (state.status) state.status.mode = v;
      if (typeof window !== 'undefined') window.dispatchEvent(new window.Event('mihomo-mode-changed'));
      lastStatusSig = statusSig(state.status);
      cmdline('live-refresh').catch(() => {});   // B 方案：模式已变，热缓存先作废再重算（不等待）
      getConfigs().then(config => {
        if (id !== modeRequestId || !config?.mode || String(state.status?.pid || '') !== String(st.pid || '')) return;
        curMode = config.mode;
        modeOverride = { pid: String(st.pid || ''), mode: config.mode };
        const changedMode = state.status?.mode !== config.mode;
        if (state.status) state.status.mode = config.mode;
        if (changedMode && typeof window !== 'undefined') window.dispatchEvent(new window.Event('mihomo-mode-changed'));
        modeBtns.forEach((button, i) => button.classList.toggle('on', modes[i][0] === config.mode));
        lastStatusSig = statusSig(state.status);
      }).catch(e => { if (id === modeRequestId) uiToast('模式已提交，回读失败：' + e.message, 3000); });
    } catch (e) {
      uiToast('模式切换失败：' + e.message, 3000);
    } finally {
      b.removeAttribute('aria-busy');
      modeBusy = false;
    }
  };
  const modeBtns = modes.map(([v, l]) => {
    const b = h('button', { text: l, class: v === curMode ? 'on' : '', style: 'flex:1' });
    if (!running) { b.disabled = true; b.style.opacity = '.45'; return b; }
    // 正常点击切换：只挂 click，不再用 pointerdown 抢发——横向滑动扫过分段按钮时
    // pointerdown 会在手指落下的那一刻就触发切换，扫一眼就误改运行模式。
    b.addEventListener('click', () => doSwitchMode(v, b));
    return b;
  });
  modeCard.append(h('div', { class: 'seg', style: 'width:100%;display:flex' }, modeBtns));
  // 运行模式卡置顶：这是主页上最常按的控件（改模式），放在最上面不用滚；
  // 状态卡（运行态/版本/端口/总开关）退到第二张。两者都建好后一起挂载，
  // paintUptime 的 requestAnimationFrame 在挂载之后才跑，取不到元素的问题不存在。
  el.append(modeCard, hero);

  // ------- 快捷操作 -------
  el.append(groupTitle('快捷操作'));
  const act = card();
  const btn = (text, cls, fn) => h('button', { class: `btn ${cls || ''}`, text, onclick: fn });
  // keep2：窄屏下也保持两列（普通 btn-grid 在 <520px 会被降级为单列）。
  // 排列顺序即 DOM 顺序：重启+校验 一行，更新订阅+外部面板 一行。
  act.append(h('div', { class: 'btn-grid keep2' },
    h('button', {
      class: 'btn', 'data-service-restart': '1',
      text: serviceRestartBusy ? '重启中…' : '重启服务',
      disabled: serviceRestartBusy, 'aria-busy': String(serviceRestartBusy),
      onclick: restartDashboardService,
    }),
    h('button', {
      class: 'btn', 'data-config-test': '1',
      text: configTestBusy ? '校验中…' : '校验配置',
      disabled: configTestBusy, 'aria-busy': String(configTestBusy),
      onclick: checkDashboardConfig,
    }),
    btn('更新订阅', '', async () => {
      if (!running) { uiToast('内核未运行'); return; }
      showUpdateAllProviders();
    }),
    // 内嵌打开：WebUI 不导航，返回时主页原地还在（不再整页重载）。
    // 内核运行时外部面板会自动下载（metacubexd），层内另有「新窗口」可开真标签页。
    btn('外部面板', '', () => openExternalPanel(st)),
  ));
  el.append(act);

  // ------- 日志 -------
  el.append(groupTitle('运行日志'));
  const logCard = card();
  const logBox = h('pre', { class: 'logbox dashboard-logbox', text: '日志加载中…' });
  let lastLogText = '';       // 上次渲染的文本，用于跳过无变化的重绘
  let logInteracting = false; // 用户是否正在框选/长按（此时暂停刷新，避免选区被销毁）

  const markInteract = () => { logInteracting = true; };
  const endInteract = () => { setTimeout(() => { logInteracting = false; }, 1500); };
  logBox.addEventListener('pointerdown', markInteract);
  logBox.addEventListener('touchstart', markInteract, { passive: true });
  // 这三条挂在 document 上：不加清理，主页每重绘一次就多一套闭包（只增不减）
  if (dashInteractCtl) dashInteractCtl.abort();
  dashInteractCtl = new AbortController();
  document.addEventListener('pointerup', endInteract, { signal: dashInteractCtl.signal });
  document.addEventListener('touchend', endInteract, { passive: true, signal: dashInteractCtl.signal });
  document.addEventListener('touchcancel', endInteract, { passive: true, signal: dashInteractCtl.signal });

  const copyBtn = h('button', { class: 'btn sm', text: '复制', onclick: async () => {
    const txt = lastLogText || logBox.textContent || '';
    if (!txt) { uiToast('日志为空'); return; }
    const ok = await copyText(txt);
    uiToast(ok ? `已复制 ${txt.split('\n').length} 行日志` : '复制失败，请长按手动选择', 2200);
  } });
  const pauseBtn = h('button', { class: 'btn sm', onclick: () => {
    logsPaused = !logsPaused;
    syncPauseBtn();
    uiToast(logsPaused ? '已暂停自动刷新' : '已恢复自动刷新', 1500);
    if (!logsPaused) { dashLogStreak = 0; dashLogSkipUntil = 0; loadLogs(true); }      // 恢复时立刻补一次，省去等待轮询
  } });
  function syncPauseBtn() {
    pauseBtn.textContent = logsPaused ? '继续' : '暂停';
    pauseBtn.className = `btn sm ${logsPaused ? 'pri' : ''}`;
  }
  syncPauseBtn();                          // 暂停状态跨页面保留，重绘时按钮文案要跟着同步
  const segWrap = h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px' },
    h('span', { style: 'font-size:13px;color:var(--text-3);flex:1', text: 'mihomo 输出' }),
    copyBtn, pauseBtn,
    h('button', { class: 'btn sm', text: '清空', onclick: async () => {
      await cmdline('logs-clear');
      lastLogText = '';
      dashLogCache.text = ''; dashLogCache.at = 0;   // 缓存作废：否则切出去再进来会画回旧日志
      logBox.innerHTML = '';
      logBox.scrollTop = 0;
      uiToast('已清空运行日志');
      loadLogs(true);   // 立刻重拉，显示清空后状态（之后新日志照常流入）
    } }));
  logCard.append(segWrap, logBox);
  // 日志环常驻（模块级，幂等启动）；重绘只需换上新闭包并复位退避
  dashLogStreak = 0; dashLogSkipUntil = 0;
  // 日志框是每次重绘都新建的节点，lastLogText/logInteracting 要跟着重置；
  // 重进节流：缓存还新鲜就直接同步画出来（不空窗、不往返）；否则首帧强制拉一次
  const seedable = dashLogCache.at > 0;
  const logsFresh = seedable && Date.now() - dashLogCache.at < 2500;
  const cachedLogText = dashLogCache.text || (running ? '(暂无日志输出)' : '内核未运行');
  lastLogText = seedable ? cachedLogText : '';
  logInteracting = false;
  const logCls = (line) => {
    if (/\bwarning|WARN/i.test(line)) return 'lv-warn';
    if (/\berror|fatal|panic|ERR/i.test(line)) return 'lv-err';
    if (/\bdebug/i.test(line)) return 'lv-debug';
    return 'lv-info';
  };
  async function loadLogs(force = false) {
    if (panelForeground) return false;
    // 用户正在框选 / 长按复制 / 滚动或拖动本页，或手动暂停时，不碰 DOM ——
    // 否则选区被销毁、滚动帧被 120 行的样式重算抢走（日志流入时的「顿一下」）
    if (!force && (logsPaused || logInteracting || hasSelectionIn(logBox) || userScrollingOrEditing())) return false;
    const r = await readDashboardLogs();
    const errText = String(r?.stderr || '').trim();
    const text = !r || Number(r.errno) !== 0
      ? '日志读取失败：' + (errText || '执行桥未返回有效结果')
      : ((r.stdout || '').trim() || (running ? '(暂无日志输出)' : '内核未运行'));
    // readDashboardLogs 已保存结果，切页只影响 DOM 更新。
    if (panelForeground || !logBox.isConnected || (!force && (logsPaused || logInteracting || hasSelectionIn(logBox) || userScrollingOrEditing()))) return false;
    // 内容无变化则完全不动 DOM（连滚动位置都不用碰）
    if (!force && text === lastLogText) return false;
    lastLogText = text;
    paintLogs(text, force);
    return true;
  }
  const paintLogs = (text, follow) => {
    const lines = text.split('\n');
    // 末尾空行（报错文本带的换行）会裂出一张空白日志卡：丢弃
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    // 增量刷新：按行号复用节点，只改写真正变化的行。旧实现每次整盒重建，
    // 而日志几乎每秒都有新行 → 等于每秒一次全量重排，必吃滚动帧
    // 「日志加载中…」占位是纯文本节点，children 看不见它——不清掉会永远卡在首行
    while (logBox.firstChild && logBox.firstChild.nodeType === 3) logBox.removeChild(logBox.firstChild);
    for (let i = 0; i < lines.length; i++) {
      let row = logBox.children[i];
      if (!row) { row = h('div', {}); logBox.append(row); }
      if (row.textContent !== lines[i]) row.textContent = lines[i];
      const cl = logCls(lines[i]);
      if (row.className !== cl) row.className = cl;
    }
    while (logBox.children.length > lines.length) logBox.removeChild(logBox.lastChild);
    // 每次日志内容更新后始终跟随最新一行。
    logBox.scrollTop = logBox.scrollHeight;
  };
  // 先挂载再绘制：脱离 DOM 时 scrollHeight 为 0，无法定位到最新日志。
  el.append(logCard);
  if (seedable) paintLogs(cachedLogText, true);
  dashLogsFn = loadLogs;
  startDashLogLoop();
  if (!logsFresh) loadLogs(true); // 首次读取不能被连续切页饿死；普通日志环仍避让交互。

  // ------- 配置错误提示 -------
  if (state.cfgError) el.append(note('⚠ ' + state.cfgError, 'danger'));

  // ------- 版本自检（装机版本一目了然，防止刷错旧包） -------
  el.append(h('div', { style: 'text-align:center;font-size:11.5px;color:var(--text-3);padding:16px 0 6px;user-select:text',
    text: `Mihomo Box${state.moduleVersion ? ' · 模块 ' + state.moduleVersion : ' · 模块版本读取中…'}` }));
}

// ================= 工具页 =================
// 两张大卡的展开状态：默认收起 —— 锚点面板会按锚点数量摊很长、浏览器访问卡的地址列表 +
// 二维码占地也不小，默认收起工具页才一眼扫得完。存模块级变量而不是 DOM 上：工具页仍有
// 整页重建的路径（内容代数变化），状态挂 DOM 会被重建冲掉，用户展开一次就自己合上了。
let toolsAnchorOpen = false, toolsWebOpen = false, toolsNetMatchOpen = false;

// ================= 配置源码弹层（顶栏「配置源码」按钮） =================
// 源码编辑器从「工具页里的一张折叠卡」提为全局单例：DOM 只建一次，反复开关弹层不丢
// 输入中的内容、光标与滚动位置。锚点面板的「定位 / 引用行」也走同一个实例 —— 定位到
// 没挂进文档的文本域等于什么都没发生，所以定位前会先把弹层打开。
// 弹层复用全站同一套底部 sheet：遮罩点击关闭、底部固定操作条常驻「重新加载 / 保存」。
// 编辑器高度上下限（px）：下限保证输入法弹出时仍有可读的编辑区，上限免得宽屏上比整屏还高。
const SRC_MIN_H = 180, SRC_MAX_H = 520;
// 视口变化（输入法弹出/收起、旋转）后重新排一次编辑器高度。用 rAF 合并：安卓输入法动画期间
// 每帧都可能来一条 resize，逐条处理只会抖，合并后跟着弹层一起平滑变化。
let srcFitRaf = 0;
function scheduleSrcFit() {
  if (srcFitRaf || typeof requestAnimationFrame !== 'function') return;
  srcFitRaf = requestAnimationFrame(() => { srcFitRaf = 0; if (srcEditor && srcEditor.fit) srcEditor.fit(); });
}
if (typeof window !== 'undefined') {
  window.addEventListener('resize', scheduleSrcFit);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleSrcFit);
  // 抓条手势期间被跳过的重排，在这里补上（手势内不会改高度，松手那一刻才生效）
  document.addEventListener('pointerup', scheduleSrcFit, true);
  document.addEventListener('touchend', scheduleSrcFit, true);
  // core.js 的键盘兜底改写 --kb-h（浏览器模式输入法弹出/收起）后，编辑器高度跟着重排
  document.addEventListener('kb:h', scheduleSrcFit);
}
let srcEditor = null;

// textarea 按浏览器标准把 CRLF 归一为 LF；仅换行编码不同不算用户编辑。
const sourceAreaValue = () => String(state.raw || '').replace(/\r\n?/g, '\n');
// 编辑器没建过 = 还没打开过源码弹层：此时草稿 state.raw 就是唯一事实，没有「未提交的输入」。
const srcArea = () => (srcEditor ? srcEditor.area : null);
// 源码编辑器当前是否就「摆在最前层」：既要在 #sheetContent 里，弹层本身也得是打开的。
// 只判 contains 会踩坑：core 的 mountSheet 关闭时（无父层）只隐藏 mask/sheet、不清空内容，
// 编辑器节点会留在 #sheetContent 里 —— 于是「图标节点还在」被误判成已挂载，再次点顶栏
// 按钮就跳过了重挂，弹层再也不出来（关一次之后就打不开的根因）。
const srcSheetMounted = () => !!(srcEditor
  && !document.getElementById('sheet').hidden
  && document.getElementById('sheetContent').contains(srcEditor.editorBox));
const sheetBusy = () => { const m = document.getElementById('sheetMask'); return !!(m && !m.hidden); };
// 把文本域里还没进草稿的末尾输入补进草稿（锚点面板做手术式改写前必须先同步）。
function flushSrcEditor() {
  if (srcEditor && srcEditor.area.value !== sourceAreaValue()) editConfigSource(srcEditor.area.value);
}
// 草稿 → 编辑器（别处改动：锚点面板、恢复备份、放弃更改、保存后清理脏标记…）。
function syncSrcEditor() {
  if (!srcEditor) return;
  const { area, checkValid, syncGutter } = srcEditor;
  if (area.value !== sourceAreaValue()) {
    const top = area.scrollTop, left = area.scrollLeft;
    area.value = state.raw;
    area.scrollTop = top; area.scrollLeft = left;
  }
  checkValid(); syncGutter(true);
}

// 配置文件诊断：三方对比「①面板内存 ②桥接实时读取 ③设备端磁盘」，
// 一眼定位「面板显示旧值而文件是新值」卡在哪一层（内存滞后 / 桥接读取 / 看错文件 / 新面板未生效）。
// 只读操作，不改任何文件；结果可一键复制发给开发者。
async function runSrcDiagnostics() {
  if (DEMO) { uiToast('演示模式无设备文件，诊断不可用', 3000); return; }
  if (runSrcDiagnostics.busy) return;
  runSrcDiagnostics.busy = true;
  uiToast('正在诊断…', 1600);
  try {
    const norm = s => String(s == null ? '' : s);
    const byteLen = s => { try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; } };
    const lines = [];

    // —— 面板身份：刷入指纹 + 页面资源 URL（一眼判断新面板是否真的在跑）——
    let stamp = '';
    try { const rr = await fetch('install.stamp', { cache: 'no-store' }); if (rr.ok) stamp = (await rr.text()).trim(); } catch (e) { /* 离线等 */ }
    let asset = '';
    try { const el = document.querySelector('script[type="module"]'); asset = (el && el.src) || ''; } catch (e) { /* 未知 */ }
    lines.push('【面板身份】',
      `刷入指纹: ${stamp || '（读取失败）'}`,
      `页面资源: ${asset || '（未知）'}`,
      `未保存改动: ${state.dirty ? '有' : '无'}`, '');

    // —— ① 内存 ② 桥接 cat ——
    const memLen = byteLen(norm(state.raw));
    let catLen = null, catNote = '';
    try {
      const r = await readText(CONFIG_PATH);
      if (r.stdout.trim() === '__READ_FAIL__') catNote = '文件读取失败(__READ_FAIL__)';
      else catLen = byteLen(norm(r.stdout));
    } catch (e) { catNote = String((e && e.message) || e); }

    // —— ③ 设备端磁盘（shell 直读，绕过面板内容通道）——
    let sh = { stdout: '', stderr: '' };
    try {
      const cmd = 'P=' + shq(CONFIG_PATH) + '; B=' + shq(WORKDIR) + '; M=' + shq(MODDIR)
        + '; echo --ls--; ls -l "$P" 2>&1'
        + '; echo --link--; readlink -f "$P" 2>&1'
        + '; echo --size--; wc -c < "$P" 2>&1'
        + '; echo --hash--; sha256sum "$P" 2>/dev/null; md5sum "$P" 2>/dev/null'
        + '; echo --backups--; ls -lt "$B/backup" 2>/dev/null | head -6';
      sh = await shell(cmd);
    } catch (e) { sh.stderr = String((e && e.message) || e); }
    const diskSize = Number((/--size--\n(\d+)/.exec(sh.stdout) || [])[1]);

    const diskOk = diskSize > 0 && diskSize === catLen;
    const memOk = catLen != null && catLen === memLen;
    const allOk = memOk && diskOk;
    lines.push(`【三方对比】${allOk ? '✅ 正常' : '⚠️ 异常'}（①=②=③ 才正常）`,
      `① 面板内存草稿: ${memLen} 字节`,
      `② 桥接实时读取: ${catLen == null ? '失败（' + catNote + '）' : catLen + ' 字节'}`,
      `③ 磁盘真实大小: ${diskSize > 0 ? diskSize + ' 字节' : '未知'}`, '');
    if (catLen != null) {
      if (memOk) lines.push('① = ②：面板内存与文件内容一致。');
      else lines.push(`① ≠ ②（差 ${memLen - catLen} 字节）：面板内存里的配置不是文件内容 —— 读取/加载层问题。`);
      if (diskSize > 0) {
        if (diskOk) {
          lines.push('② = ③：桥接读取与磁盘完全一致。');
        } else {
          lines.push(`② ≠ ③（差 ${diskSize - catLen} 字节）：桥接读取可能被截断或变形。`);
        }
      }
      if (allOk) lines.push('✅ 结论：三方一致，配置已正确落盘，面板显示即文件内容。');
      lines.push('');
    }

    lines.push('【磁盘详情】', sh.stdout || '(无输出)');
    if (sh.stderr) lines.push('', '【错误输出】', sh.stderr);
    lines.push('', '【怎么读】',
      '· 刷入指纹 ≠ 你刚刷的版本 → 新面板没生效：重启手机后重试；',
      '· ①≠② → 面板拿到的不是文件内容（读取/加载层）；',
      '· ①=②=③ → 正常；',
      '· 三方一致但字段仍显示旧值 → 页面渲染层；',
      '· 文件管理器看到的 md5 与上面不同 → 看的是另一份文件（backup/ 里是每次保存前的自动备份）。');

    const text = lines.join('\n');
    const close = openChildSheet('配置文件诊断',
      note('对比「面板内存 / 桥接读取 / 磁盘」三方，定位参数值不一致发生在哪一层。'),
      h('pre', { class: 'logbox', style: 'max-height:46vh;overflow:auto;white-space:pre', text }),
    );
    setSheetFooter(
      h('button', { class: 'btn', style: 'flex:1', text: '复制结果', onclick: async () => {
        const ok = await copyText(text);
        uiToast(ok ? '已复制' : '复制失败，请长按内容手动复制');
      } }),
      h('button', { class: 'btn pri', style: 'flex:1', text: '关闭', onclick: close }),
    );
  } finally { runSrcDiagnostics.busy = false; }
}

function ensureSrcEditor() {
  if (srcEditor) return srcEditor;
  const gutter = h('div', { class: 'code-gutter', text: '1' });
  const area = h('textarea', { id: 'configSource', rows: 24, class: 'code-area', 'data-no-autogrow': '1', spellcheck: false,
    wrap: 'off', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off',
    style: 'flex:1 1 auto;width:auto;min-width:0;user-select:text' });
  // 行号列 + 文本区组成编辑器整体。尺寸由 fitSrcEditor() 按「可用空间 + 满宽正方形」算成像素值：
  // 之前写成 `aspect-ratio:1/1; max-height:min(56vh,520px)`，一旦输入法弹出把布局视口压矮，
  // 上限（56vh）小于宽度，aspect-ratio 会把**宽度也一起收**（转移尺寸），编辑器变成一个小方块
  // —— 字号没变，肉眼看着就是「内容框被缩放」。所以：宽度永远满宽，高度只向下收缩。
  const editorBox = h('div', { class: 'code-wrap src-editor' }, gutter, area);
  const validBadge = h('span', { class: 'badge', text: '加载中' });
  const checkValid = () => {
    validBadge.className = state.cfgError ? 'badge r' : 'badge g';
    validBadge.textContent = state.cfgError ? 'YAML 错误' : 'YAML 合法';
    validBadge.title = state.cfgError || '';
  };
  // 行号同步：行数只在内容变化时重算；滚动路径 O(1) 仅跟 scrollTop。
  // 旧实现在每次 scroll 事件里都全量 split('\n')——大文件高频滚动时正是编辑器卡顿的直接原因
  const syncGutter = (force) => {
    if (force) {
      const n = area.value.split('\n').length;
      if (syncGutter.n !== n) { syncGutter.n = n; gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); }
    }
    gutter.scrollTop = area.scrollTop;
  };
  // 可见时的滚动位置：弹层一隐藏，文本域的 scrollTop 会被浏览器钳成 0（display:none 后
  // 既读不回原值，也常在钳位时补发一个 scroll 事件），所以只在「确实还渲染着」的时候记一份，
  // 重挂后放回去 —— 关掉再打开仍停在刚才看的那一行。
  let lastTop = 0;
  // 全局草稿接口保留输入中的文本；160ms 合并校验，点别处/保存时同步完成校验。
  area.addEventListener('input', () => { editConfigSource(area.value); syncGutter(true); });
  area.addEventListener('change', () => { flushSrcEditor(); flushConfigSource(); });
  area.addEventListener('blur', () => { flushSrcEditor(); flushConfigSource(); });
  area.addEventListener('scroll', () => {
    gutter.scrollTop = area.scrollTop;
    if (area.scrollTop > 0 && area.getClientRects().length) lastTop = area.scrollTop;
  });
  area.value = state.raw || '';
  syncGutter(true);

  // 整理字段顺序 / 上传配置文件
  // Android 的 .yaml MIME 不统一，不给文件选择器加 accept 限制。
  const fileIn = h('input', { type: 'file', style: 'display:none' });

  // 整理字段顺序按钮：将所有配置字段顺序还原为 mihomo 官方配置顺序，格式保持原样（多行块式 / 单行流式）
  const tidyBtn = h('button', {
    class: 'btn sm circle', title: '整理配置字段顺序', 'aria-label': '整理配置字段顺序',
    html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h6"/></svg>',
    onclick: () => {
      flushSrcEditor();
      const curText = area.value || state.raw || '';
      const { err: parseErr } = parseConfigText(curText);
      if (parseErr) {
        uiToast('源码存在 YAML 语法错误，请先修正后再整理', 3800);
        return;
      }
      try {
        const tidied = tidyMihomoConfig(curText);
        if (tidied === curText) {
          uiToast('配置字段顺序已符合官方规范', 2200);
          return;
        }
        const { err: verifyErr } = parseConfigText(tidied);
        if (verifyErr) {
          uiToast('整理后验证失败：' + verifyErr, 4000);
          return;
        }
        area.value = tidied;
        editConfigSource(tidied);
        syncGutter(true);
        uiToast('✅ 已按官方规范整理配置字段顺序', 2600);
      } catch (e) {
        uiToast('整理配置字段失败：' + (e && e.message ? e.message : e), 4000);
      }
    }
  });

  const upBtn = h('button', {
    class: 'btn sm circle', title: '上传配置文件', 'aria-label': '上传配置文件',
    html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4"/><path d="M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    onclick: () => pickFileWithFeedback(fileIn, upBtn),
  });
  fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    fileIn.value = '';                 // 允许再次选择同一文件
    const rd = new FileReader();
    rd.onload = async () => {
      const txt = String(rd.result || '');
      const { obj, err } = parseConfigText(txt);
      if (err) { uiToast('上传未生效（' + f.name + '）：' + err, 4200); return; }   // 无效文件：保持现有配置不动
      if (!applyConfigDraft(txt)) return;
      uiToast(`✅ ${f.name} 已加入草稿，点「保存配置」写入文件`, 3400);
    };
    rd.onerror = () => uiToast('读取文件失败', 3000);
    rd.readAsText(f);
  });

  // 配置文件诊断按钮：见 runSrcDiagnostics。
  const diagBtn = h('button', {
    class: 'btn sm circle', title: '配置文件诊断', 'aria-label': '配置文件诊断',
    html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2 7 4-14 2 7h6"/></svg>',
    onclick: () => runSrcDiagnostics(),
  });

  // 弹层底部固定操作条：长源码滚动时「重新加载 / 保存配置」始终可见（保存条 z-index 低于
  // 弹层，弹层开着时够不到它，这两个按钮就是这一刻的保存入口）。
  const reloadBtn = h('button', { class: 'btn', text: '📥 重新加载', onclick: () => {
    const reload = async () => {
      await loadConfig();
      syncSrcEditor();
      // loadConfig 只更新配置模型；当前配置页的 DOM 需要就地重绘，否则仍显示旧值，
      // 直到用户切换页面触发重新渲染才会同步。
      rerenderCurrent();
      uiToast('已重新加载');
    };
    // 用「叠在源码弹层上的确认框」（openChildSheet）：无论确认还是取消，关闭后编辑器
    // 都在原位，不会因为一次确认把刚改的源码关掉。
    if (state.dirty) confirmOnTop('重新加载配置', '将放弃当前未保存的更改，并读取文件中的配置。', '重新加载', reload);
    else reload();
  } });
  const saveBtn = h('button', { class: 'btn pri', text: '💾 保存配置', onclick: async () => {
    flushSrcEditor(); flushConfigSource();
    await saveConfig();      // 与顶部保存共用：备份、写入失败保留草稿、热重载询问
    // 保存流程可能弹出「热重载」确认（别的弹层占着 sheet）；只有没被占时才把源码弹层放回去。
    if (!sheetBusy()) openSourceSheet();
  } });

  const tools = h('div', { class: 'src-tools' },
    h('code', { class: 'src-name', text: 'config.yaml' }), validBadge, tidyBtn, upBtn, diagBtn, fileIn);

  // 定位到行：给锚点面板的「定位 / 引用行」用（打开弹层 → 选中该行 → 滚到视口内）。
  const jumpToLine = (ln) => {
    const val = area.value;
    let pos = 0;
    for (let k = 1; k < ln && pos > -1; k++) pos = val.indexOf('\n', pos) + 1;
    if (pos < 0) pos = 0;
    const eol = val.indexOf('\n', pos);
    const end = eol < 0 ? val.length : eol;
    // 浏览器会把 textarea 的「活动选区端」滚进视口。默认正向选择时活动端在行尾，
    // 一条很长的流式锚点就会横向跳到最右边；反向选择把活动端留在行首。
    try { area.focus({ preventScroll: true }); } catch (_) { area.focus(); }
    area.setSelectionRange(pos, end, 'backward');
    const total = val.split('\n').length || 1;
    const placeAtStart = () => {
      area.scrollTop = Math.max(0, (ln - 4) * (area.scrollHeight / total));
      area.scrollLeft = 0;
      gutter.scrollTop = area.scrollTop;
    };
    placeAtStart();
    // Chromium 浏览器模式可能在 focus/选区原生菜单落位后再补一次滚动；连续两帧校正，
    // 管理器 WebView 也走同一路径，定位结果保持一致。
    requestAnimationFrame(() => requestAnimationFrame(placeAtStart));
  };

  // 编辑器高度：宽度始终满宽，高度 = clamp(180, min(满宽（正方形）, 520), 可用高度)。
  // 可用高度必须按「弹层能长到多高」算，不能量当前内容区高度 —— 弹层是内容撑开的，
  // 编辑器一矮，弹层跟着矮、内容区也跟着矮，下一帧量出来还是矮的，编辑器就再也长不回去
  // （输入法收起后卡在小尺寸）。所以按 .sheet 的 max-height（CSS 里是
  // min(96dvh, calc(100dvh - var(--kb-h)))）减掉横条/标题/工具行/底栏/内边距这些固定
  // 开销。dvh 的计算值没法可靠转成数字，这里按同一公式换算：管理器模式布局视口本身
  // 被键盘压矮、--kb-h 恒 0；浏览器模式（resizes-visual 兜底）布局视口不变，键盘高度
  // 由 core.js 写进 --kb-h。
  const fit = () => {
    const sheet = document.getElementById('sheet');
    const content = document.getElementById('sheetContent');
    if (!content || !content.contains(editorBox) || !sheet || sheet.hidden) return;
    if (sheet._grabActive) return;   // 手指正按着横条拖：这时改高度会让弹层在指下自己长高/变矮
    const cs = getComputedStyle(content);
    const footer = document.getElementById('sheetFooter');
    const grabber = sheet.querySelector('.sheet-grabber');
    const heading = content.querySelector('h3');
    const fixed = (grabber ? grabber.offsetHeight : 22)
      + (heading ? heading.offsetHeight + 12 : 0)
      + tools.offsetHeight + 10                                   // 文档名 + 校验徽标 + 上传那一行
      + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      + (footer && !footer.hidden ? footer.offsetHeight : 0);
    const vh = document.documentElement.clientHeight || window.innerHeight || 0;
    const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb-h')) || 0;
    const maxSheet = Math.min(vh * 0.96, vh - kb) || window.innerHeight;
    const avail = Math.max(0, maxSheet - fixed);
    const want = Math.max(SRC_MIN_H, Math.min(editorBox.clientWidth || SRC_MAX_H, SRC_MAX_H, avail));
    const px = Math.round(want) + 'px';
    if (editorBox.style.height !== px) { editorBox.style.height = px; syncGutter(false); }
  };

  srcEditor = { area, gutter, editorBox, tools, validBadge, tidyBtn, upBtn, fileIn, reloadBtn, saveBtn, checkValid, syncGutter, jumpToLine, fit, savedTop: () => lastTop };
  // 草稿被别处改写时同步编辑器；只在建实例时订阅一次（单例常驻，不必反复挂）。
  onConfigDraftChange(syncSrcEditor);
  return srcEditor;
}

// 弹层内的确认框：与 confirmSheet 同款外观，但走 openChildSheet —— 关闭后原样恢复父层。
function confirmOnTop(title, msg, okText, onOk, cancelText = '取消', danger = false) {
  const close = openChildSheet('',
    h('div', { style: 'text-align:center;padding:8px 0 4px;font-size:17px;font-weight:750', text: title }),
    h('div', { class: 'note', style: 'text-align:center;margin-top:8px', text: msg }),
  );
  setSheetFooter(
    h('button', { class: 'btn block', text: cancelText, onclick: () => close() }),
    h('button', { class: `btn block ${danger ? 'danger' : 'pri'}`, text: okText, onclick: () => { close(); onOk && onOk(); } }),
  );
  return close;
}

// 打开源码弹层。opts.line：打开后定位到该行（锚点面板的定位入口）。
function openSourceSheet(opts = {}) {
  const ed = ensureSrcEditor();
  let keepTop = null;
  if (!srcSheetMounted()) {
    // 弹层被别处占用 / 已关闭（内容节点可能还留在 #sheetContent 里）：重新挂载一层，
    // 由 openSheet 负责清内容、重挂节点并让 mask/sheet 显示出来。
    // 重挂会把文本域的滚动位置归零，稍后补回（关着的时候 scrollTop 已被浏览器钳成 0，
    // 所以取的是「可见时记下的那一份」）。
    keepTop = ed.savedTop() || ed.area.scrollTop || 0;
    openSheet('配置源码', ed.tools, ed.editorBox);
    setSheetFooter(ed.reloadBtn, ed.saveBtn);
  }
  syncSrcEditor();          // 关闭期间别处可能改过草稿（恢复备份 / 放弃更改 / 面板改写）
  if (opts.line) ed.jumpToLine(opts.line);
  // 挂进文档后 scrollHeight 才有值：行号列跟着内容对齐要等一帧。
  ed.fit();                                  // 先按当前可用高度排一次（避免用旧高度闪一下）
  requestAnimationFrame(() => {
    ed.fit();
    ed.syncGutter(true);
    if (opts.line) return;                                  // 定位行优先，别覆盖跳转后的位置
    if (keepTop) { ed.area.scrollTop = keepTop; ed.gutter.scrollTop = ed.area.scrollTop; }
  });
}

// 卡片折叠开关：文案/无障碍属性沿用锚点值展开器的「展开 ▾ / 收起 ▴」写法
function cardToggle(isOpen, onToggle) {
  return h('button', {
    class: 'btn sm', text: isOpen ? '收起 ▴' : '展开 ▾',
    'aria-expanded': isOpen ? 'true' : 'false', title: isOpen ? '收起' : '展开',
    onclick: (ev) => { ev.stopPropagation(); onToggle(); },
  });
}
const syncToggleBtn = (btn, isOpen) => {
  btn.textContent = isOpen ? '收起 ▴' : '展开 ▾';
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  btn.title = isOpen ? '收起' : '展开';
};

PAGE_RENDER['page-tools'] = renderTools;

function renderTools(el) {
  // 工具页缓存：首次构建后秒开，后续切回不再重建长列表/编辑器/二维码
  // raw 引用 + 版本 + 远程态 任一变化才重建
  const _sig = `${state.moduleVersion||''}|${IS_REMOTE?1:0}|${state.cfgError||''}`;
  // 源码编辑器已搬进顶栏弹层（全局单例），本页不再镜像 state.raw：草稿变化只需
  // syncToolsDraft 就地刷新锚点面板，不必整页重建（省掉每次改配置后的整页重排）。
  if (el._toolsSig === _sig && el.childElementCount > 0 && !el._toolsForce) {
    // 轻量刷新：面板服务卡片内容按需单次取回，切回时无需重建
    return;
  }
  if (el._toolsUnsub) el._toolsUnsub();
  el._toolsSig = _sig;
  el._toolsForce = false;
  el.innerHTML = '';


  // ---- 锚点可视化：只修改当前草稿，确认后面板与源码同步，保存负责落盘 ----
  // 面板里的定位/引用行走顶栏的配置源码弹层（openSourceSheet），编辑则改草稿后立即同步
  const anchorCard = card();
  // 锚点卡：卡头（h3 + 开关）只建一次、绝不重建。
  // 之前每次展开都 anchorCard.innerHTML='' 整卡重建，正被按着的按钮节点先摘除再插回，
  // .btn:active 的下缩/恢复动画当场截断 —— 真机表现就是「这按钮按下去没反馈」。
  // 展开/收起只切卡体显隐，锚点内容渲进稳定的 anchorBody；「＋ 新建锚点」放卡体顶部，
  // 收起时随卡体隐藏。
  const anchorBody = h('div', {});
  anchorBody.hidden = !toolsAnchorOpen;
  const anchorToggleBtn = cardToggle(toolsAnchorOpen, () => setAnchorOpen(!toolsAnchorOpen));
  // 「＋ 新建锚点」在稳定卡头上，但建表函数住在 renderAnchorBody 里（每次渲染一个新实例）：
  // 用 renderTools 作用域的间接引用接上，卡头不重建也能随时开表。
  let anchorCreateFn = null;
  const openCreateSheet = () => {
    if (!toolsAnchorOpen) setAnchorOpen(true);   // 收起时先展开：新锚点就出现在面板里
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (anchorCreateFn) anchorCreateFn();
      else ntoast('源码尚未通过 YAML 校验，先修复再新建锚点');
    }));
  };
  const anchorHead = h('div', { class: 'card-head' }, h('h3', { text: '锚点面板' }),
    h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto;justify-content:flex-end' },
      h('button', { class: 'btn sm pri', text: '＋ 新建锚点', onclick: () => openCreateSheet() }),
      anchorToggleBtn));
  anchorHead.style.marginBottom = toolsAnchorOpen ? '' : '0';
  anchorCard.append(anchorHead, anchorBody);
  const setAnchorOpen = (v) => {
    toolsAnchorOpen = !!v;
    syncToggleBtn(anchorToggleBtn, toolsAnchorOpen);   // 文案/aria 立即翻
    anchorBody.hidden = !toolsAnchorOpen;              // 卡体显隐瞬时生效，不碰按钮节点
    anchorHead.style.marginBottom = toolsAnchorOpen ? '' : '0';
    // 锚点扫描是重活：延后两帧等按压动画画出来再跑；只渲卡体
    if (toolsAnchorOpen) requestAnimationFrame(() => requestAnimationFrame(() => renderKeepScroll(renderAnchorBody)));
  };
  const renderAnchorBody = () => {
    anchorCreateFn = null;   // 校验失败/未渲染时，卡头「新建」按钮给出提示而非死点
    if (!toolsAnchorOpen) return;   // 收起不扫锚点（scanAnchorGraph 要整份解析 YAML）
    const body = anchorBody;
    body.innerHTML = '';
    if (state.cfgError) {
      body.append(note('源码尚未通过 YAML 校验。修复后面板自动同步，错误源码不会写入文件。', 'danger'));
      return;
    }
    const graph = scanAnchorGraph(state.raw);
    const jumpTo = (ln) => {
      // 源码已搬进顶栏的配置源码弹层：定位前先把它打开，否则光标设在没挂进文档的
      // 文本域里（display:none / 已关闭），用户点了「定位/引用行」什么都看不到。
      openSourceSheet({ line: ln });
    };
    const actBtn = (text, fn, title) => h('button', { class: 'btn sm', text, title: title || '', style: 'padding:3px 8px;font-size:12px', onclick: (ev) => { ev.stopPropagation(); fn(); } });
    // 只更新源码/锚点区域，不销毁 textarea 或整页 DOM，避免丢焦点/滚动位置。
    const afterOp = () => syncToolsDraft();
    // 取锚点定义所在的整块（定义行 + 所有缩进更深的子行；序列项从 '- ' 那行起算）
    const blockRange = (txt, ln, name = null) => {
      const ls = txt.split(/\r?\n/), offsets = [0];
      for (const m of txt.matchAll(/\r?\n/g)) offsets.push(m.index + m[0].length);
      const i = ln - 1;
      if (i < 0 || i >= ls.length) return null;
      const base = ls[i].match(/^[ \t]*/)[0].length;
      let end = i + 1;
      for (; end < ls.length; end++) {
        if (!ls[end].trim()) continue;
        if (ls[end].match(/^[ \t]*/)[0].length <= base) break;
      }
      // 跨行 flow 的闭括号可以与定义行同级；用解析器的真实值范围补足，
      // 不能把闭括号漏掉，或把后面的配置键吃进定义块。
      if (name) {
        const stack = [];
        try { jsyaml.load(txt, { listener(event, st) {
          if (event === 'open') stack.push(st.position);
          else {
            const from = stack.pop();
            if (st.anchor !== name || from < offsets[i] || from > offsets[i] + ls[i].length) return;
            let body = txt.slice(from, st.position), old;
            do { old = body; body = body.replace(/^\s+|^#[^\n]*(?:\n|$)|^&[^\s\[\]{},]+|^!<[^>]+>|^![^\s\[\]{},]+/, ''); } while (old !== body);
            if (/^[{\[]/.test(body)) end = Math.max(end, txt.slice(0, Math.min(st.position, txt.length)).split('\n').length);
          }
        } }); } catch (_) { /* 原文校验仍由共同草稿入口负责 */ }
      }
      while (end > i + 1 && !ls[end - 1].trim()) end--;
      const from = offsets[i], to = offsets[end - 1] + ls[end - 1].length;
      return { ls, i, end, base, from, to, text: txt.slice(from, to), eol: txt.includes('\r\n') ? '\r\n' : '\n' };
    };
    // 只替换目标块的字符范围；其余原文（包括 CRLF、空行、行尾空格）不经过 textarea。
    const applyBlockEdit = (ln, newBlock, name = null) => {
      flushSrcEditor();                 // 文本域里可能还有没进草稿的末尾输入
      if (!flushConfigSource()) return false;
      const r = blockRange(state.raw, ln, name);
      if (!r) { ntoast('定位不到该锚点所在行，请先重新加载'); return false; }
      let body = String(newBlock);
      if (!body.trim()) { ntoast('内容不能为空'); return false; }
      if (r.eol === '\r\n' && !body.includes('\r')) body = body.replace(/\n/g, '\r\n');
      return applyConfigDraft(state.raw.slice(0, r.from) + body + state.raw.slice(r.to));
    };
    const applyOpNow = (op) => {
      const a = srcArea();
      if (a && a.value !== state.raw && !applyConfigDraft(a.value)) return false;
      return commitConfigEdit(null, [op]);
    };
    // YAML 值 → 单行文本（可视化参数行的输入框内容）：null 留空，其余强制全 flow dump。
    // 注意 jsyaml 的 flowLevel 是「≥该层才用 flow」：0=全 flow（必须），99=全块式多行——
    // 多行进单行 input 后换行不可见（「enable: trueurl: …」），应用时解析报错或悄悄写坏。
    const yValText = v => (v === null || v === undefined) ? '' : jsyaml.dump(v, { lineWidth: -1, noRefs: true, flowLevel: 0 }).replace(/\n+$/, '').trim();
    // 多键值组合与非空序列才展开：映射给「键框 + 值框」成对行，序列给「每行一个值」。
    // 单值/纯文本/非法 YAML 没有结构可拆，值框内不再挂「展开」按钮（新建行的空值除外：
    // 那一行还不知道要填什么，留按钮让用户直接把首个键值对开在展开区里）。
    // 展开仍属本张表单；只回填参数框/预览，父层「加入待保存」才提交。
    let valueEditorId = 0;
    const valueKeyOrigins = new WeakMap();   // 键/列表项来源；null 表示明确新建，增删/改名仍保留对应原文
    // 展开只有一层：顶层值框可以展开成「键名 + 值」的行，展开区里的值框不再给「展开」——
    // 需要嵌套映射/列表就直接在那个值框里写 {…} / […]（YAML flow 语法，解析照旧）。
    // depth 语义：顶层参数行 = 0，展开区里的行 = 1，1 起一律不展开。
    const VALUE_DEPTH_MAX = 1;
    const attachValueExpander = (row, keyControl, input, removeButton, onInput, labelOf, depth = 0) => {
      const id = 'anc-values-' + (++valueEditorId);
      row.classList.add('anc-value-row');
      keyControl.classList.add('anc-value-key');
      input.classList.add('anc-value-input');
      if (removeButton) removeButton.classList.add('anc-value-remove');
      const caption = h('div', { class: 'anc-values-caption' });
      const addValueButton = h('button', { type: 'button', class: 'btn sm anc-values-new', text: '＋ 新建值', onclick: () => newValue() });
      const heading = h('div', { class: 'anc-values-head' }, caption);
      const actions = h('div', { class: 'anc-values-actions' }, addValueButton);
      const hint = h('div', { class: 'f-desc anc-values-hint' });
      const columns = h('div', { class: 'anc-map-columns', hidden: true, 'aria-hidden': 'true' },
        h('span', { text: '键名' }), h('span', { text: '值' }));
      const list = h('div', { class: 'anc-values-items' });
      const panel = h('div', { id, class: 'anc-values-panel', hidden: true, role: 'group' }, heading, hint, columns, list, actions);
      const error = h('div', { id: id + '-error', class: 'anc-values-error', hidden: true, role: 'status' });
      const toggle = h('button', { type: 'button', class: 'anc-values-toggle', 'aria-controls': id, 'aria-expanded': 'false', text: '展开 ▾', onclick: ev => toggleValues(ev) });
      row.append(panel, error);
      let seenRaw = null, parsed = null, encoded = '', parseError = '', children = null, childKind = '', opened = false, structureEdited = false, mapMode = false, childSerial = 0;
      const message = e => String((e && e.message) || e).split('\n')[0];
      const kindOf = value => Array.isArray(value) ? 'array'
        : Object.prototype.toString.call(value) === '[object Object]' ? 'map' : 'single';
      const entriesOf = value => Array.isArray(value) ? value.map((v, i) => [i, v])
        : kindOf(value) === 'map' ? Object.entries(value) : [];
      // 空集合/非法输入没有成对结构可拆；值框为空时的展开一律从「键框 + 值框」起步。
      const defaultKind = () => (!entriesOf(parsed).length && !parseError && canOpen()) ? 'map' : 'single';
      const viewKind = () => !parseError && entriesOf(parsed).length ? kindOf(parsed) : defaultKind();
      // 「多键值组合」= 真映射。单条目且值是空的映射不算：那是值框里敲了个冒号
      // （2000: → {2000: null}、timeout: → {timeout: null}），键还是数字，展开后只会给
      // 一行没法用的键名框。≥2 项（或单项已填值）才认为用户真的在写多键值。
      const isRealMap = value => {
        if (kindOf(value) !== 'map') return false;
        const keys = Object.keys(value);
        return keys.length >= 2 || (keys.length === 1 && keys[0] !== '__proto__' && value[keys[0]] != null);
      };
      // 序列（列表）一律可展开：展开区本来就支持「每行一个值」，元素是纯文本也行——
      // 模块配置里 &host 的 override-expr 就是一列 jq 表达式，之前按「元素须含映射」判定
      // 没有展开按钮，只能整行硬改。空序列不算可拆结构：跟 {a:} 一样在值框里直接补完。
      const isMultiKV = value => Array.isArray(value) ? value.length > 0 : isRealMap(value);
      // 展开只服务于能拆成结构化行的值：单值/纯文本/非法 YAML 没有键（行）可填，不给按钮，直接在值框里改。
      // 值框为空则恒给（哪怕只填了参数名、或填了半行键值对）——否则填完参数名就再也点不开展开区了。
      // 例外：展开区里的行（depth ≥ 1）一律不再往下套展开——每层新行都自带按钮的话，
      // 点一次生一层，会一路无限嵌下去。嵌套结构在值框里直接写 {…}（VALUE_DEPTH_MAX 封顶）。
      const blankNewPair = () => keyControl.tagName === 'INPUT'
        && !String(keyControl.value || '').trim() && !String(input.value || '').trim();
      const canOpen = () => {
        if (parseError || depth >= VALUE_DEPTH_MAX) return false;   // 只展开一层：更深的写在值框里
        if (isMultiKV(parsed)) return true;
        return keyControl.tagName === 'INPUT' && !String(input.value || '').trim()
          && !(depth > 0 && blankNewPair());
      };
      // 已经展开的行要留住按钮：展开区里刚填出「一项还没填值的键值对」（{onlykey: null}）
      // 按 canOpen 判定不算多键值组合，但此时把按钮和面板抽走会打断正在填的这一行。
      const canExpand = () => opened || canOpen();
      // 展开值与键名都用原生单行 input；不再量高或设置内滚动 textarea。
      const setError = msg => {
        error.textContent = msg || ''; error.hidden = !msg;
        input.setAttribute('aria-invalid', msg ? 'true' : 'false');
        input.setAttribute('aria-describedby', id + '-error');
      };
      const update = () => {
        const label = String(labelOf() || '参数'), expandable = canExpand();
        input.classList.toggle('anc-has-values', expandable);
        input.setAttribute('aria-label', label + ' 的 YAML 值');
        if (expandable) {
          if (toggle.parentNode !== row) row.insertBefore(toggle, removeButton || panel);
          toggle.textContent = opened ? '收起 ▴' : '展开 ▾';
          toggle.setAttribute('aria-expanded', opened ? 'true' : 'false');
          toggle.setAttribute('aria-label', (opened ? '收起' : '展开') + label + ' 的完整值');
          toggle.title = toggle.getAttribute('aria-label');
        } else {
          toggle.remove(); opened = false;
          // 到深度上限时不静默变哑：说清为什么没有按钮（值框本身仍可写完整 {…}）。
          if (depth >= VALUE_DEPTH_MAX && !parseError && (isMultiKV(parsed) || blankNewPair()))
            input.setAttribute('aria-label', label + ' 的 YAML 值（展开区里的值不再往下嵌套，需要键值组合/列表请直接写 {…} 或 […]）');
        }
        panel.hidden = !opened;
        // 展开后即使还没填出合法值，也保持「键框 + 值框」那套行（按钮/列名不来回跳）。
        const kind = children ? childKind : (opened && mapMode ? 'map' : viewKind()), count = children && kind !== 'single' ? children.length : entriesOf(parsed).length;
        columns.hidden = kind !== 'map';
        caption.textContent = label + ' · ' + (kind === 'map' ? count + ' 个键值对' : kind === 'array' ? count + ' 个值' : '完整值');
        addValueButton.textContent = kind === 'map' ? '＋ 新建键值对' : '＋ 新建值';
        addValueButton.setAttribute('aria-label', '在 ' + label + ' 中新建' + (kind === 'map' ? '键值对' : '值'));
        hint.textContent = kind === 'map' ? '左框填键名、右框填值；「新建键值对」再加一对。特殊文本保留引号，空的新行不提交。'
          : '每行一个值；「新建值」追加一项。空的新行不提交。空字符串写两个单引号，空值写 null。';
        if (children && !children.length) {
          mapMode = kind === 'map';
          caption.textContent = label + ' · ' + (kind === 'array' ? '0 个值' : '0 个键值对');
          hint.textContent = kind === 'array' ? '填好值即成为第一项（可先把该行删掉）。'
            : '填好键名与值即成为第一项；键名或值为空的行不提交（可先把该行删掉）。';
        }
        // 末行还空着时「新建」不再追加、改为跳回那一行：在提示里说清楚，别让人以为按钮坏了。
        if (children && children.length && emptyNewRow(children[children.length - 1]))
          hint.textContent += '最后一行还空着，「' + addValueButton.textContent.trim() + '」会先跳到那一行。';
        panel.setAttribute('aria-label', label + ' 的完整值');
      };
      const notify = () => { read(); onInput(); };
      const appendValueRow = (key, value, fresh = false, originKey = key) => {
        const pair = childKind === 'map', label = pair ? (fresh ? '新键' : String(key)) : childKind === 'single' ? '值' : '值 ' + (children.length + 1);
        const inputId = id + '-item-' + (childSerial++);
        const name = pair ? h('input', { type: 'text', class: 'anc-map-key-input', value: fresh ? '' : yValText(String(key)),
          placeholder: '键名（YAML 文本）', 'aria-label': '键名 ' + label })
          : h('label', { class: 'anc-multi-label', for: inputId, text: label });
        const valueInput = h('input', { type: 'text', id: inputId, class: 'anc-multi-input',
          value: fresh ? '' : childKind === 'single' ? input.value : value == null ? 'null' : yValText(value),
          placeholder: fresh ? '新值：空字符串写两个单引号，空值写 null' : 'YAML 值' });
        const remove = h('button', { type: 'button', class: 'mini-btn anc-value-delete', text: '×',
          title: pair ? '删除该键值对' : '删除该值', onclick: () => deleteValue(child) });
        const childRow = h('div', { class: 'anc-value-child' + (pair ? ' anc-map-pair' : '') }, name, valueInput, remove);
        const child = { key, label, name, valueInput, remove, row: childRow, fresh, originKey: fresh ? null : originKey };
        // 键值行仍挂一个编辑器，但只用于值校验/读写（depth + 1 已到上限，不再给「展开」按钮）；
        // 这一行要填键值组合或列表，直接在值框里写 {…} / […]。
        child.editor = attachValueExpander(childRow, name, valueInput, remove, notify,
          () => pair ? name.value : child.label, depth + 1);
        if (pair) {
          child.keyInput = name;
          child.keyError = h('div', { id: inputId + '-key-error', class: 'anc-values-error anc-key-error', hidden: true, role: 'status' });
          name.setAttribute('aria-describedby', inputId + '-key-error');
          name.addEventListener('input', notify); name.addEventListener('change', notify);
          childRow.append(child.keyError);
        }
        children.push(child); list.append(childRow); return child;
      };
      const createChildren = (kind = viewKind(), value = kind === 'map' && parsed && entriesOf(parsed).length === 0 ? {} : parsed) => {
        list.innerHTML = ''; children = []; childKind = kind; structureEdited = false;
        const entries = kind === 'single' ? [[0, value]] : entriesOf(value);
        const origins = kind === 'map' || kind === 'array' ? valueKeyOrigins.get(value) : null;
        for (const [key, item] of entries) appendValueRow(key, item, false, origins && origins.has(key) ? origins.get(key) : key);
      };
      // 仅新建且完全未填写的行可忽略；原有空值保留，半填键值/非法值不能当成空行。
      const emptyNewRow = child => child.fresh && !child.editor.hasInput()
        && (!child.keyInput || !child.keyInput.value.trim());
      const refresh = () => {
        const raw = String(input.value || '');
        if (raw === seenRaw) return;
        seenRaw = raw;
        children = null; childKind = ''; structureEdited = false; list.innerHTML = ''; parseError = ''; encoded = '';
        try { parsed = raw.trim() === '' ? null : jsyaml.load(raw); encoded = yValText(parsed); }
        catch (e) { parsed = null; parseError = message(e); }
        if (opened && canOpen()) {
          try { createChildren(); } catch (e) { opened = false; children = null; parseError = message(e); }
        }
        update(); setError(parseError);
      };
      const read = () => {
        refresh();
        if (children) {
          const active = children.filter(child => !emptyNewRow(child));
          const values = [], keys = [], counts = new Map(), keyErrors = [];
          if (childKind === 'map') {
            for (const child of children) {
              child.keyError.textContent = ''; child.keyError.hidden = true;
              child.keyInput.setAttribute('aria-invalid', 'false');
            }
            for (const child of active) {
              let key, err = '';
              try {
                if (!child.keyInput.value.trim()) throw new Error('键名不能为空');
                key = jsyaml.load(child.keyInput.value);
                if (typeof key !== 'string') throw new Error('键名必须是 YAML 文本，数字等名称请加引号');
              } catch (e) { err = message(e); }
              keys.push(key); keyErrors.push(err);
              if (!err) counts.set(key, (counts.get(key) || 0) + 1);
            }
            active.forEach((child, i) => {
              if (!keyErrors[i] && counts.get(keys[i]) > 1) keyErrors[i] = '键名「' + keys[i] + '」重复';
              child.keyError.textContent = keyErrors[i]; child.keyError.hidden = !keyErrors[i];
              child.keyInput.setAttribute('aria-invalid', keyErrors[i] ? 'true' : 'false');
            });
            const err = keyErrors.find(Boolean);
            if (err) { setError(err); return { err }; }
          }
          for (let i = 0; i < active.length; i++) {
            const child = active[i], r = child.editor.read();
            const raw = String(child.valueInput.value || '');
            const commentOnly = raw.trim() && !raw.replace(/^\s*#[^\r\n]*/gm, '').trim();
            const issue = r.err || (child.fresh && (r.value === undefined || commentOnly) ? '新建值不能只有注释，请填写 YAML 值' : '');
            if (issue) { const err = (childKind === 'map' ? keys[i] : child.label) + '：' + issue; setError(err); return { err }; }
            values.push([childKind === 'map' ? keys[i] : child.key, r.value]);
          }
          // 兜底：childKind 只会是 map/array；'single' 已不可达（非键值组合不给展开），
          // 仍留一支防止历史形态走进来被 Object.fromEntries 悄悄吞掉。
          const value = childKind === 'single' ? (values.length ? values[0][1] : null)
            : childKind === 'array' ? values.map(x => x[1]) : Object.fromEntries(values);
          try {
            const next = yValText(value);
            if (parseError || next !== encoded) {
              input.value = next; seenRaw = next; encoded = next; parsed = value; parseError = '';
            }
            if (childKind === 'map' || (childKind === 'array' && Array.isArray(parsed))) {
              valueKeyOrigins.set(parsed, new Map(values.map((x, i) =>
                [childKind === 'map' ? x[0] : i, active[i].originKey])));
            }
          } catch (e) { const err = message(e); setError(err); return { err }; }
        } else if (parseError) { setError(parseError); return { err: parseError }; }
        setError(''); update(); return { value: parsed };
      };
      const newValue = () => {
        const r = read();
        if (r.err) { onInput(); ntoast('请先修正当前输入再新建：' + r.err, 3800); return; }
        const kind = kindOf(r.value) === 'single' ? (canOpen() ? 'map' : 'single') : kindOf(r.value);
        // 只有映射/序列两种形态：单值不再伪装成「一项列表」，展开按钮本来也就不给它。
        if (!children || (childKind === 'single' && children.length) || childKind !== kind) createChildren(kind, r.value);
        // 末行还空着就不再生新行：连点「新建」会一路堆出没有尽头的空值框（空行本来也不提交，
        // 只会把展开区撑成一片空白输入框）。改为把光标送回那一行，先填完再谈下一行。
        const pending = children.length ? children[children.length - 1] : null;
        if (pending && emptyNewRow(pending)) {
          opened = true; update();
          focusTextInput(pending.keyInput || pending.valueInput, { reveal: true });
          ntoast('最后一行还没填，先填完再新建', 2200);
          return;
        }
        const child = appendValueRow(childKind === 'map' ? '' : children.length, null, true);
        opened = true; update(); notify();
        // 与「＋ 添加参数」共用原生同步聚焦；新增值/键在本次按钮手势内即可输入。
        focusTextInput(child.keyInput || child.valueInput, { reveal: true });
      };
      const deleteValue = child => {
        refresh();
        const index = children ? children.indexOf(child) : -1;
        if (index < 0) return;   // 主框已改写后，不误删新的同位置条目
        children.splice(index, 1); child.row.remove(); structureEdited = true;
        if (childKind !== 'map') children.forEach((item, i) => {
          item.key = i; item.label = childKind === 'single' ? '值' : '值 ' + (i + 1);
          item.name.textContent = item.label;
        });
        // 删除非法项也可修复表单；不重建其他控件，不先拿旧合法值覆盖当前草稿。
        notify(); update();
      };
      const changed = () => { refresh(); onInput(); };
      input.addEventListener('input', changed);
      input.addEventListener('change', changed);
      const toggleValues = ev => {
        ev.stopPropagation(); refresh();
        if (!canOpen()) return;
        if (!opened) {
          // 重开时只在完整值的类型已变且输入合法后切展示形态；非法草稿原样保留。
          const r = children ? read() : null;
          const keepRows = children && childKind !== 'single' && (structureEdited || children.some(x => x.fresh));
          if (!children || (!r.err && !keepRows && childKind !== viewKind())) {
            try { createChildren(); }
            catch (e) { children = null; list.innerHTML = ''; setError('无法展开：' + message(e)); return; }
            mapMode = childKind === 'map';
            // 空框展开就是来填第一对的：直接铺好一行「键框 + 值框」，不用再多点一次「新建」。
            if (!children.length) appendValueRow(childKind === 'map' ? '' : children.length, null, true);
          }
        }
        if (!opened) mapMode = false;
        opened = !opened; update();
      };
      const hasInput = () => {
        const raw = String(input.value || '');
        if (raw !== seenRaw) return !!raw.trim();  // 主框的末次输入优先，哪怕事件尚未派发
        return !!raw.trim() || !!(children && children.some(x => x.editor.hasInput() || (x.keyInput && x.keyInput.value.trim())));
      };
      // 参数名只影响按钮显隐（值框空 → 恒可展开），不碰输入与草稿，父层预览另行同步。
      const editor = { read, hasInput, recompute: () => { update(); } };
      row._valueEditor = editor;
      refresh(); return editor;
    };
    const readValueRow = row => row && row._valueEditor
      ? { ...row._valueEditor.read(), hasInput: row._valueEditor.hasInput() } : { value: null, hasInput: false };

    const anchorEditSheet = (a) => {
      const d = a.defs[0];
      if (!d) { ntoast('该锚点没有定义行'); return; }
      const r = blockRange(state.raw, d.line, a.name);
      if (!r) { ntoast('定位不到定义块，请先「重新加载」'); return; }
      // 可视化解析：定义行须为「键: &名 …」且块体可独立解析；
      // 块内含外部 *引用（unidentified alias）等非自包含形态 → 仅文本模式
      const initialBlock = r.text;
      let layoutBlock = initialBlock;
      const parseViz = (block) => {
        const dm = block.split(/\r?\n/)[0].match(/^(\s*)(?:- )?([^:#]+?)\s*:\s*&([A-Za-z_][A-Za-z0-9_.\-]*)\s*([\s\S]*)$/);
        if (!dm || dm[3] !== a.name) return null;
        try {
          const o = jsyaml.load(block);
          if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
          const ko = jsyaml.load(dm[2] + ': 1');
          if (!ko || typeof ko !== 'object' || Array.isArray(ko)) return null;
          const key = Object.keys(ko)[0];
          if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(o, key)) return null;
          return { ind: dm[1].length, key, value: o[key] };
        } catch (e) { return null; }
      };
      let viz = parseViz(layoutBlock);
      // ---- 可视化区：预览与提交复用同一原文补丁，不用新建块的自动排版 ----
      const rowsBox = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
      const vBox = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
      const syncVizRef = { fn: null };
      // 参数名、参数值及展开项都沿用 h()/document 的同一个同步输入入口。
      const addVRow = (kFixed, kVal, vVal, focusK = false) => {
        const kIn = h('input', { type: 'text', value: kVal, readonly: !!kFixed, placeholder: kFixed ? '' : '参数名',
          style: 'flex:1;min-width:0' + (kFixed ? ';opacity:.7' : ''), spellcheck: false,
          autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
        const vIn = h('input', { type: 'text', value: vVal, placeholder: 'YAML 值', style: 'flex:1.4;min-width:0',
          spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
        const row = h('div', { class: 'anc-value-row' }, kIn, vIn,
          h('button', { class: 'mini-btn', text: '×', title: '删除该参数', onclick: () => { row.remove(); syncVizRef.fn && syncVizRef.fn(); } }));
        kIn.addEventListener('input', () => { row._valueEditor && row._valueEditor.recompute(); syncVizRef.fn && syncVizRef.fn(); });
        attachValueExpander(row, kIn, vIn, row.children[2], () => syncVizRef.fn && syncVizRef.fn(), () => kIn.value);
        rowsBox.append(row);   // 行只进 rowsBox：必须插在「＋ 添加参数」按钮行上方（曾 append 到 vBox 末尾 → 新行掉到按钮/诊断文字下方、预览卡片上方的文字区里）
        // Android WebView：点完「＋ 添加参数」在按钮手势内直接聚焦新参数名
        if (focusK) focusTextInput(kIn, { reveal: true });
      };
      const readViz = () => {
        const rows = [...rowsBox.children];   // rowsBox 里只有参数行，不再需要过滤按钮行/诊断行
        if (viz && viz.value && typeof viz.value === 'object' && !Array.isArray(viz.value)) {
          const out = {};
          for (const row of rows) {
            const k = (row.children[0].value || '').trim();
            const r = readValueRow(row);
            if (!k && !r.hasInput && !r.err) continue;       // 展开项也完全没填才是空行
            if (!k) return { err: '有参数没填参数名（把这一行删掉或补上）' };
            if (/[:#]/.test(k)) return { err: `参数名「${k}」不能含 : 或 #` };
            if (Object.prototype.hasOwnProperty.call(out, k)) return { err: `参数「${k}」重复` };
            if (r.err) return { err: `参数「${k}」的值不是合法 YAML：${r.err}` };
            out[k] = r.value;
          }
          return { value: out };
        }
        if (viz && Array.isArray(viz.value)) {
          const arr = [];
          for (const row of rows) {
            const r = readValueRow(row);
            if (r.err) return { err: '列表项不是合法 YAML：' + r.err };
            arr.push(r.value);
          }
          return { value: arr };
        }
        const r = readValueRow(rows[0]);
        return r.err ? { err: '值不是合法 YAML：' + r.err } : { value: r.value };
      };
      const vPrev = h('pre', { class: 'logbox', style: 'max-height:160px;margin:0', text: '' });
      const visualBlock = () => {
        const { value, err } = readViz();
        if (err) throw new Error(err);
        return patchAnchorDefBlock(layoutBlock, viz.key, value, jsyaml, valueKeyOrigins);
      };
      const syncViz = () => {
        try { vPrev.textContent = visualBlock(); }
        catch (e) { vPrev.textContent = '⚠ ' + e.message; }
      };
      syncVizRef.fn = syncViz;
      const isMap = viz && viz.value && typeof viz.value === 'object' && !Array.isArray(viz.value);
      const isArr = viz && Array.isArray(viz.value);
      const seedRows = () => {
        rowsBox.innerHTML = '';
        if (viz && viz.value && typeof viz.value === 'object' && !Array.isArray(viz.value)) Object.entries(viz.value).forEach(([k, v]) => addVRow(false, k, yValText(v)));
        else if (viz && Array.isArray(viz.value)) viz.value.forEach((v, i) => addVRow(true, '#' + i, yValText(v)));
        else if (viz) addVRow(true, '(值)', yValText(viz.value));
      };
      seedRows();
      if (viz) {
        vBox.append(rowsBox);   // 参数行容器置顶：行始终在「＋ 添加参数」按钮行上方
        // 展开规则等长串说明已按需求撤掉：按钮语义自明，误输入由展开区内的行内报错兜底
        if (isMap) vBox.append(h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
          h('button', { class: 'btn sm', text: '＋ 添加参数', onclick: () => { addVRow(false, '', '', true); syncViz(); } })));
        syncViz();
      }
      const vWrap = h('div', { style: 'margin-top:12px' }, vBox, h('div', { class: 'f-desc', style: 'margin:4px 0' }, '生成的块（应用前预览）：'), vPrev);
      // ---- 文本区（原有行为：整块 YAML 直接编辑，含 &名 本身） ----
      // 高度随内容自适应（统一规则），不再固定 12 行 + 180px 起步；
      // 长行软换行（.wrap），像 &host 这种整块一行的流式写法不再向右无限延伸
      const ta = h('textarea', { class: 'code-area wrap', spellcheck: false,
        autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off',
        style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px;user-select:text' });
      ta.value = layoutBlock;
      const tBox = h('div', { style: 'margin-top:12px' }, ta);
      let mode = viz ? 'visual' : 'text';
      const textBlock = () => ta.value === layoutBlock.replace(/\r\n?/g, '\n') ? layoutBlock
        : (r.eol === '\r\n' ? ta.value.replace(/\n/g, '\r\n') : ta.value);
      const seg = viz ? segCtl([['visual', '可视化'], ['text', '文本']], 'visual', (v) => {
        if (v === mode) return;
        try {
          if (v === 'text') { layoutBlock = visualBlock(); ta.value = layoutBlock; }
          else {
            const block = textBlock(), next = parseViz(block);
            const shape = x => Array.isArray(x) ? 'seq' : x && typeof x === 'object' ? 'map' : 'scalar';
            if (!next || next.key !== viz.key || shape(next.value) !== shape(viz.value)) throw new Error('此文本无法转为当前可视化表单，请在文本模式提交；输入已保留');
            layoutBlock = block; viz = next; seedRows(); syncViz();
          }
          mode = v; vWrap.hidden = v !== 'visual'; tBox.hidden = v !== 'text';
        } catch (e) {
          ntoast(e.message, 4200);
          [...seg.children].forEach((b, i) => b.classList.toggle('on', i === (mode === 'visual' ? 0 : 1)));
        }
      }) : null;
      // 初始显示状态必须显式设定：可视化模式隐藏文本区、纯文本模式隐藏（空的）可视化区。
      // 此前漏设 → 弹层一打开文本框就裸露在可视化区下方，切到「文本」再切回才消失。
      if (seg) tBox.hidden = true; else vWrap.hidden = true;
      const close = openSheet(`编辑 &${a.name} 定义块`,
        h('div', { class: 'note', text: `${d.path} · 第 ${d.line} 行起共 ${r.end - r.i} 行。应用前做整份 YAML 校验，${a.refs.length} 处引用不受影响。${viz ? '' : '（该块含外部 *引用或形态无法自动解析，仅提供文本模式）'}` }),
        seg,
        vWrap, tBox,
        h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
          h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
          h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
            let nextBlock;
            try { nextBlock = viz && !vWrap.hidden ? visualBlock() : textBlock(); }
            catch (e) { ntoast(e.message, 4200); return; }
            // 页外草稿可能令行号移动。按原定义重新定位；目标已变则拒绝旧表单覆盖。
            if (!flushConfigSource()) return;
            const live = scanAnchorGraph(state.raw).anchors.find(x => x.name === a.name);
            const matches = (live ? live.defs : []).map(x => ({ line: x.line, range: blockRange(state.raw, x.line, a.name) }))
              .filter(x => x.range && x.range.text === initialBlock);
            if (matches.length !== 1) { ntoast('该定义块已发生变化，请重新打开编辑，避免覆盖新内容', 4200); return; }
            if (!applyBlockEdit(matches[0].line, nextBlock, a.name)) return;
            close();
            afterOp();
          } })));
    };
    // 编辑单个引用行：可视化（换绑锚点 / 清除继承）↔ 文本（整行 YAML）
    const refEditSheet = (a, r) => {
      flushSrcEditor();
      const ls = sourceAreaValue().split('\n');
      const cur = ls[r.line - 1];
      if (cur === undefined) { ntoast('定位不到该引用行'); return; }
      // 可视化解析：本行恰好只引用 a.name 一个锚点，且是 `<<: *x` / `键: *x` 直接形态
      const viz = (() => {
        const names = [...cur.matchAll(/\*[A-Za-z_][A-Za-z0-9_.\-]*/g)].map(m => m[0].slice(1));
        if (names.length !== 1 || names[0] !== a.name) return null;
        const mMerge = cur.match(/^(\s*)<<\s*:\s*\*[A-Za-z_][A-Za-z0-9_.\-]*\s*(#.*)?$/);
        if (mMerge) return { kind: 'merge', ind: mMerge[1], cmt: mMerge[2] || '' };
        const mVal = cur.match(/^(\s*)([^:\s#][^:]*?)\s*:\s*\*[A-Za-z_][A-Za-z0-9_.\-]*\s*(#.*)?$/);
        if (mVal) return { kind: 'val', ind: mVal[1], key: mVal[2], cmt: mVal[3] || '' };
        return null;
      })();
      const allNames = scanAnchorGraph(state.raw).anchors.map(x => x.name);
      const sel = selectCtl(
        [['', viz && viz.kind === 'merge' ? '(不继承)' : '(选择锚点)']].concat(allNames.map(n => [n, n])),
        allNames.includes(a.name) ? a.name : '', { title: '选择锚点' });
      const vBox = h('div', { style: 'margin-top:12px' },
        h('div', { class: 'f-row' },
          h('div', { class: 'f-label' }, viz ? (viz.kind === 'merge' ? '继承锚点 <<:' : `字段 ${viz.key} 引用 *`) : '锚点引用',
            h('div', { class: 'f-desc', text: viz ? (viz.kind === 'merge' ? '改绑到其它锚点；选「(不继承)」则删除这一行' : '把 *引用 改绑到其它锚点') : '本行形态较复杂，请切「文本」编辑' })),
          h('div', { class: 'f-ctl' }, sel)));
      const tTa = h('textarea', { class: 'code-area wrap', spellcheck: false,
        value: cur, style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px;user-select:text' });
      const tBox = h('div', { style: 'margin-top:12px' }, tTa);
      const seg = viz ? segCtl([['visual', '可视化'], ['text', '文本']], 'visual',
        (v) => { vBox.hidden = v !== 'visual'; tBox.hidden = v !== 'text'; }) : null;
      // 初始显示状态与定义块弹层同理：可视化模式隐藏文本区，纯文本模式隐藏可视化区
      if (seg) tBox.hidden = true; else vBox.hidden = true;
      const close = openSheet(`编辑引用行 L${r.line}`,
        h('div', { class: 'note', text: `${r.path} · ${r.merge ? '<<: 合并继承' : '值引用'} ${a.name}${allNames.includes(a.name) ? '' : '（当前悬空，选一个已有锚点即修复）'}。可视化只改这一行；要改定义内容请用锚点项的「编辑」。${viz ? '' : '（本行形态较复杂，仅提供文本模式）'}` }),
        seg, vBox, tBox,
        h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
          h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
          h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
            if (viz && !vBox.hidden) {
              const nm = sel.value;
              if (viz.kind === 'merge' && !nm) {
                // 清除继承 = 删除整行（applyBlockEdit 不接受空块，这里内联同款整份校验）
                const next = [...ls.slice(0, r.line - 1), ...ls.slice(r.line)].join('\n');
                if (!applyConfigDraft(next)) return;
                close();
                afterOp();
                return;
              }
              if (!nm) { ntoast('请先选择锚点'); return; }
              const cmt = viz.cmt ? ' ' + viz.cmt : '';
              const nextLine = viz.kind === 'merge' ? viz.ind + '<<: *' + nm + cmt
                : viz.ind + viz.key + ': *' + nm + cmt;
              if (!applyBlockEdit(r.line, nextLine)) return;
            } else {
              if (!applyBlockEdit(r.line, tTa.value)) return;
            }
            close();
            afterOp();
          } })));
    };
    const anchorCreateSheet = () => {
      // 新建顶层定义块（如 代理合集: &providers {…}）：
      // 顶层条目名 + 锚点名 + 内容参数（键值对逐行可视化编辑）。
      // 「挂到已有条目」已下线：锚点定义统一为顶层块，已有条目的复用走 <<: 继承。
      const NAME_OK = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

      // ---- 新建顶层定义块 ----
      const ntKeyIn = h('input', { type: 'text', placeholder: '顶层条目名，如 代理合集（配置里不能已有同名键）', style: 'width:100%', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
      const ntNameIn = h('input', { type: 'text', placeholder: '锚点名，如 providers（供 <<: *providers 继承）', style: 'width:100%', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
      const fieldsBox = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
      const ntPrev = h('pre', { class: 'logbox', style: 'max-height:170px;margin:0', text: '' });
      const ntReadFields = () => {
        const out = {};
        for (const row of fieldsBox.children) {
          const k = (row.children[0].value || '').trim();
          const r = readValueRow(row);
          if (!k && !r.hasInput && !r.err) continue;       // 不丢掉新参数展开中的未完成输入
          if (!k) return { err: '有参数没填参数名（把这一行删掉或补上）' };
          if (/[:#]/.test(k)) return { err: `参数名「${k}」不能含 : 或 #` };
          if (Object.prototype.hasOwnProperty.call(out, k)) return { err: `参数「${k}」重复` };
          if (r.err) return { err: `参数「${k}」的值不是合法 YAML：${r.err}` };
          out[k] = r.value;
        }
        return { obj: out };
      };
      const syncNewtopPreview = () => {
        const k = ntKeyIn.value.trim(), nm = ntNameIn.value.trim();
        const { obj, err } = ntReadFields();
        if (err) { ntPrev.textContent = '⚠ ' + err; return; }
        if (!k || !Object.keys(obj).length) { ntPrev.textContent = '（顶层条目名 + 至少一个内容参数后显示预览）'; return; }
        try {
          const dOpts = { lineWidth: -1, noRefs: true, sortKeys: false };
          const flow = jsyaml.dump({ [k]: obj }, { ...dOpts, flowLevel: 1 }).replace(/\n+$/, '');
          let d;
          if (!flow.includes('\n') && flow.length <= 160) {
            const m0 = flow.match(/^([^:]+):\s*/);
            d = m0 ? [m0[1] + ': &' + (nm || '…') + ' ' + flow.slice(m0[0].length)] : flow.split('\n');
          } else {
            const ds = jsyaml.dump({ [k]: obj }, dOpts).replace(/\n+$/, '').split('\n');
            const m0 = ds[0].match(/^([^:]+):(\s*)$/);
            d = m0 ? [m0[1] + ': &' + (nm || '…'), ...ds.slice(1)] : ds;
          }
          ntPrev.textContent = '# 点「加入待保存」后写入源码框（自动放文件头，供各处 <<: *引用）：\n' + d.join('\n');
        } catch (e) { ntPrev.textContent = '⚠ 预览失败：' + e.message; }
      };
      const addFieldRow = (key = '', value = '', focusK = false) => {
        const kIn = h('input', { type: 'text', value: key, placeholder: '参数名，如 interval', style: 'flex:1;min-width:0', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
        const vIn = h('input', { type: 'text', value: value, placeholder: 'YAML 值：3600 / 文本 / {…} / […]', style: 'flex:1.4;min-width:0', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
        const row = h('div', { class: 'anc-value-row' },
          kIn, vIn,
          h('button', { class: 'mini-btn', text: '×', title: '删除该参数', onclick: () => { row.remove(); syncNewtopPreview(); } }));
        kIn.addEventListener('input', () => { row._valueEditor && row._valueEditor.recompute(); syncNewtopPreview(); });
        attachValueExpander(row, kIn, vIn, row.children[2], syncNewtopPreview, () => kIn.value);
        fieldsBox.append(row);
        // 与定义块弹层同理：点完「＋ 添加参数」在按钮手势内直接聚焦新参数名
        if (focusK) focusTextInput(kIn, { reveal: true });
      };
      addFieldRow();
      ntKeyIn.addEventListener('input', syncNewtopPreview);
      ntNameIn.addEventListener('input', syncNewtopPreview);
      syncNewtopPreview();
      const newtopBox = h('div', {},
        h('div', { class: 'f-row' },
          h('div', { class: 'f-label' }, '顶层条目名', h('div', { class: 'f-desc', text: '配置顶层的一个新键（如 代理合集），确认后立即显示「条目名: &锚点名 …」' })),
          h('div', { class: 'f-ctl' }, ntKeyIn)),
        h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '锚点名'), h('div', { class: 'f-ctl' }, ntNameIn)),
        h('div', { class: 'f-row', style: 'align-items:flex-start' },
          h('div', { class: 'f-label' }, '内容参数', h('div', { class: 'f-desc', text: '锚点指向的键值对；值按 YAML 解析（数字/文本/{…}/[…]），含 : 的字符串请加引号。值为键值组合、列表或留空时值框带「展开」：映射逐对填「键名 + 值」，列表每行一个值；展开区里的值框不再往下展开，要嵌套就直接写 {…} 或 […]；单值直接在框里改' })),
          h('div', { class: 'f-ctl', style: 'width:100%' }, fieldsBox,
            h('div', { style: 'margin-top:8px' },
              h('button', { class: 'btn sm', text: '＋ 添加参数', onclick: () => { addFieldRow('', '', true); syncNewtopPreview(); } })))),
        h('div', {},
          h('div', { class: 'f-desc', style: 'margin:4px 0' }, '确认后显示的块：'),
          ntPrev));

      // ---- 弹层骨架 ----
      const close = openSheet('新建锚点',
        h('div', { class: 'note', text: '新建一个顶层定义块并逐项填参数。点「加入待保存」后立即显示在面板和源码，点顶部「保存」才写入文件。' }),
        newtopBox,
        h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
          h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
          h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
            // 所有配置确认统一提交草稿；不再保留「失败先排队，保存时再做」的分支。
            const a = srcArea();
            if (a && a.value !== state.raw && !applyConfigDraft(a.value)) return;
            const usedNames = scanAnchorGraph(state.raw).anchors.map(a => a.name);
            {
              const k = ntKeyIn.value.trim(), nm = ntNameIn.value.trim();
              if (!k) { ntoast('请填写顶层条目名'); return; }
              if (/[#:&*!|>%@\s`]/.test(k)) { ntoast('顶层条目名不能含空格或 : # & * 等 YAML 特殊符号'); return; }
              if (state.cfg && Object.prototype.hasOwnProperty.call(state.cfg, k)) { ntoast(`配置里已有顶层键「${k}」，请换个名`); return; }
              if (!NAME_OK.test(nm)) { ntoast('锚点名不合法：字母/下划线开头，可含 . - _'); return; }
              if (usedNames.includes(nm)) { ntoast(`&${nm} 已存在，请换个名（或用重命名）`); return; }
              const { obj, err } = ntReadFields();
              if (err) { ntoast(err, 3200); return; }
              if (!Object.keys(obj).length) { ntoast('至少填一个内容参数'); return; }
              // 源码文本级查重：同时拦截刚录入、尚未完成防抖校验的同名顶层键
              const kEsc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              if (sourceAreaValue().split('\n').some(l => new RegExp('^' + kEsc + '\\s*:(\\s|$|#)').test(l))) {
                ntoast(`配置源码里已有顶层键「${k}」（可能来自未保存的手工编辑），请换个名`); return;
              }
              if (!commitConfigEdit(cfg => { cfg[k] = deepClone(obj); },
                [{ kind: 'newtop', key: k, anchor: nm, value: obj }])) return;
              close();
              afterOp();
            }
          } })));
    };
    anchorCreateFn = anchorCreateSheet;   // 挂给稳定卡头的「＋ 新建锚点」
    if (!graph.anchors.length && !graph.danglers.length) {
      body.append(h('div', { class: 'empty', text: '配置里还没有 YAML 锚点；点「＋ 新建锚点」建顶层定义块，或去各面板编辑器的「YAML 锚点」区配继承/引用' }));
    }
    graph.anchors.forEach(a => {
      const refRows = a.refs.slice(0, 6).map(r => h('div', { class: 'anc-ref' },
        h('span', { class: 'anc-ref-kind', text: r.merge ? '继承' : '引用' }),
        h('span', { class: 'anc-ref-path', text: r.path, title: r.path, onclick: () => jumpTo(r.line) }),
        h('span', { class: 'anc-ln', text: 'L' + r.line, onclick: () => jumpTo(r.line) }),
        h('button', { class: 'anc-mini', text: '编辑', title: '编辑这一行引用（可视化/文本）', onclick: (ev) => { ev.stopPropagation(); refEditSheet(a, r); } })));
      if (a.refs.length > 6) refRows.push(h('div', { class: 'anc-more', text: `… 共 ${a.refs.length} 处引用` }));
      body.append(h('div', { class: 'anc-item' },
        h('div', { class: 'anc-head' },
          h('code', { class: 'anc-name', text: '&' + a.name, title: '&' + a.name }),
          badge(a.defs.length > 1 ? `定义×${a.defs.length}` : '定义', a.defs.length > 1 ? 'r' : 'b'),
          badge(`继承 ${a.mergeCnt} · 引用 ${a.aliasCnt}`, (a.mergeCnt + a.aliasCnt) ? 'g' : '')),
        a.defs[0] ? h('div', { class: 'anc-def', onclick: () => jumpTo(a.defs[0].line) },
          h('span', { class: 'anc-def-path', text: a.defs[0].path, title: a.defs[0].path }),
          h('span', { class: 'anc-ln', text: 'L' + a.defs[0].line })) : null,
        refRows.length ? h('div', { class: 'anc-refs' }, ...refRows) : null,
        h('div', { class: 'anc-acts' },
          actBtn('定位', () => a.defs[0] && jumpTo(a.defs[0].line), '跳到定义行'),
          actBtn('编辑', () => anchorEditSheet(a), '可视化编辑该锚点的定义块（可切换为文本编辑）'),
          actBtn('改名', () => {
            // 输入框必须带标签行（与「＋新建锚点」同款 f-row），否则裸输入框和下面的说明块
            // 长得一样，用户分不清哪个能打字
            const nameIn = h('input', { type: 'text', value: a.name, placeholder: '新锚点名', style: 'width:100%',
              spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
            // 条目名（顶层键）：从定义行解析 `key: &名` 的 key；解析不出则只允许改 &名
            const curKey = (() => {
              const d = a.defs[0];
              if (!d) return null;
              const l = String(state.raw).split('\n')[d.line - 1] || '';
              const m = l.match(/^\s*(?:- )?(.+?):\s*&/);
              return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
            })();
            const keyIn = h('input', { type: 'text', value: curKey || '',
              placeholder: curKey ? '不改则保持当前' : '未能从定义行解析，请在源码框改',
              style: 'width:100%', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
            const close = openSheet(`重命名锚点 &${a.name}`,
              h('div', { class: 'note', text: `改名立即在面板与源码框生效（${a.refs.length} 处引用（<<: 与 *值）一并级联更新；条目名只改定义行的键、不动引用）；点顶部「配置已更改」栏「保存」写入文件` }),
              h('div', { class: 'f-row' },
                h('div', { class: 'f-label' }, '新锚点名', h('div', { class: 'f-desc', text: `当前 &${a.name}` })),
                h('div', { class: 'f-ctl' }, nameIn)),
              h('div', { class: 'f-row' },
                h('div', { class: 'f-label' }, '条目名（顶层键）', h('div', { class: 'f-desc', text: curKey ? `当前 ${curKey}；留空或不变则不改` : '定义行形态无法解析，请在源码框直接改' })),
                h('div', { class: 'f-ctl' }, keyIn)),
              h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
                h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
                h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
                  const nm = nameIn.value.trim();
                  const nk = keyIn.value.trim();
                  if (nm === a.name && nk === (curKey || '')) { close(); return; }   // 什么都没改
                  if (nm !== a.name) {
                    if (!/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(nm)) { ntoast('锚点名不合法'); return; }
                    if (graph.anchors.some(x => x.name === nm)) { ntoast(`&${nm} 已被占用`); return; }
                  }
                  let keyRename = null;
                  if (curKey && nk && nk !== curKey) {
                    // 键合法性用 YAML 往返探测：解析后键不变形才收（中文键如「代理合集」也合法）
                    let probeKey = null;
                    try {
                      const probe = jsyaml.load(nk + ': 1');
                      probeKey = probe && typeof probe === 'object' && !Array.isArray(probe) ? Object.keys(probe)[0] : null;
                    } catch (e) {}
                    if (probeKey !== nk) { ntoast('条目名不合法（YAML 解析会变形），请换一个'); return; }
                    if (state.cfg && Object.prototype.hasOwnProperty.call(state.cfg, nk)) { ntoast(`顶层键「${nk}」已存在，改后会出现重复键`); return; }
                    keyRename = { anchor: nm !== a.name ? nm : a.name, from: curKey, to: nk };
                  }
                  const op = { kind: 'global' };
                  if (nm !== a.name) op.rename = [[a.name, nm]];
                  if (keyRename) op.keyRename = [keyRename];
                  if (!op.rename && !op.keyRename) { close(); return; }
                  if (!applyOpNow(op)) return;
                  close();
                  afterOp();
                } })));
          }),
          actBtn('删除', () => {
            if (a.refs.length) { ntoast(`&${a.name} 还有 ${a.refs.length} 处引用，先迁走再删（可点引用行定位）`); return; }
            confirmSheet('删除锚点定义', `移除 &${a.name} 及其所在的顶层定义块（整块删干净，不留「条目名: 值」残块），面板和源码立即更新；只有该条目是 mihomo 配置段（mixed-port / dns / proxies 等）时才保留块体、仅摘 &名。点顶部「保存」才写入文件。`, '加入待保存', () => {
              const op = { kind: 'global', drop: [a.name] };
              if (!applyOpNow(op)) return;
              afterOp();
            }, '取消', true);
          }))));
    });
    graph.danglers.forEach(d => {
      body.append(h('div', { class: 'anc-item' },
        h('div', { class: 'anc-head' },
          h('code', { class: 'anc-name', text: '*' + d.name, title: '*' + d.name }), badge('悬空引用', 'r')),
        h('div', { class: 'anc-def', style: 'cursor:default' },
          h('span', { class: 'anc-def-path', text: `${d.refs.length} 处引用没有对应 &${d.name} 定义` })),
        h('div', { class: 'anc-refs' },
          ...d.refs.slice(0, 6).map(r => h('div', { class: 'anc-ref' },
            h('span', { class: 'anc-ref-kind', text: r.merge ? '继承' : '引用' }),
            h('span', { class: 'anc-ref-path', text: r.path, title: r.path, onclick: () => jumpTo(r.line) }),
            h('span', { class: 'anc-ln', text: 'L' + r.line, onclick: () => jumpTo(r.line) }),
            h('button', { class: 'anc-mini', text: '改', title: '编辑这一行悬空引用（可视化/文本）', onclick: (ev) => { ev.stopPropagation(); refEditSheet(d, r); } }))))));
    });
  };
  const syncToolsDraft = () => {
    syncSrcEditor();                                          // 源码弹层（全局单例）跟草稿对齐
    if (toolsAnchorOpen) renderKeepScroll(renderAnchorBody);   // 收起时不白扫锚点
  };
  el.append(groupTitle('锚点可视化（YAML &定义 / *引用）'), anchorCard);
  el._toolsUnsub = onConfigDraftChange(syncToolsDraft);
  syncToolsDraft();

  // 浏览器 / 热点共享设备访问
  el.append(groupTitle('面板服务（本机 / 远程访问）'));
  el.append(webAccessCard());

  // 网络匹配（Android 专有：按 Wi-Fi/SSID 切换配置）
  if (!isOpenWrt()) {
    el.append(groupTitle('网络匹配'));
    el.append(netMatchCard());
  }

  // 备份恢复
  el.append(groupTitle('备份'));
  const bk = card();
  const bkListBox = h('div', { class: 'logbox', style: 'max-height:160px', text: '点击「加载列表」查看自动备份…' });
  const loadBkBtn = h('button', { class: 'btn sm', text: '加载列表', onclick: async () => {
    const r = await shell(`ls -1t ${WORKDIR}/backup/ 2>/dev/null | head -20`);
    bkListBox.textContent = r.stdout.trim() || '暂无备份（首次保存配置时会自动创建）';
  } });
  const bkRestore = h('button', { class: 'btn sm ok', text: '恢复最新备份', onclick: () => confirmSheet('恢复备份',
    '用最新备份替换当前草稿？面板和源码立即更新，点顶部「保存」才覆盖文件。', '恢复', async () => {
      const r = await shell(`f=$(ls -1t ${WORKDIR}/backup/config-*.yaml 2>/dev/null | head -1); [ -n "$f" ] && cat "$f"`);
      if (r.errno !== 0 || !(r.stdout || '').trim()) { uiToast('没有可恢复的备份', 3000); return; }
      if (applyConfigDraft(r.stdout)) uiToast('备份已加入草稿，点顶部「保存」写入文件');
    }) });
  const DEFAULT_CFG = `${MODDIR}/data/config.yaml`;
  const bkDefault = h('button', { class: 'btn sm', text: '恢复默认配置', onclick: () => confirmSheet('恢复默认配置',
    '用模块内置默认配置替换当前草稿？现有节点 / 规则 / 订阅将被替换。\n面板和源码立即更新，点顶部「保存」才覆盖文件；保存前可点「放弃」撤回。',
    '恢复默认', async () => {
      const r = await readText(DEFAULT_CFG);
      if (r.errno !== 0 || !(r.stdout || '').trim() || r.stdout.trim() === '__READ_FAIL__') {
        uiToast(`未找到默认配置：${DEFAULT_CFG}`, 3600); return;
      }
      if (applyConfigDraft(r.stdout)) uiToast('默认配置已加入草稿，点顶部「保存」写入文件');
    }, '取消', true) });
  bk.append(h('div', { style: 'display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap' }, loadBkBtn, bkRestore, bkDefault), bkListBox);
  el.append(bk);

  // 界面日志（排障用）：磁盘 run/webui.log 与浏览器缓存两处，任取其一都能看
  el.append(groupTitle('界面日志（普通信息 · 调试 · 警告 · 错误）'));
  const lg = card();
  const lgBox = h('pre', { class: 'logbox', style: 'max-height:220px;white-space:pre-wrap;word-break:break-all',
    text: '点击「查看日志」加载。普通操作提示、调试信息、警告与错误都会记录；日志有容量上限，敏感内容会尽力脱敏。执行通道异常时仍保留浏览器本地记录。' });
  const loadLog = async () => {
    await flushUiLogNow();
    let disk = '';
    if (!DEMO) {
      const rd = await readText(`${WORKDIR}/run/webui.log`);
      const t = (rd && rd.stdout) || '';
      disk = t.includes('__READ_FAIL__') ? '' : t;
    }
    const mem = uiLogBuffer();
    const fails = uiLogDiskFailed();
    const parts = [];
    if (fails > 0) parts.push(`⚠ 有 ${fails} 条日志写不进磁盘（执行通道异常），下面「浏览器本地」一段仍然完整。`);
    parts.push(`----- 磁盘 ${WORKDIR}/run/webui.log -----`, disk.trim() || '(空 / 尚未生成)');
    parts.push('', '----- 浏览器本地留存 -----', mem.trim() || '(空)');
    lgBox.textContent = parts.join('\n');
  };
  lg.append(h('div', { style: 'display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap' },
    h('button', { class: 'btn sm', text: '查看日志', onclick: loadLog }),
    h('button', { class: 'btn sm', text: '复制日志', onclick: async () => {
      await loadLog();
      await copyText(`【Mihomo Box 界面日志】\n模块: ${state.moduleVersion || '未知'}\nUA: ${navigator.userAgent}\n\n${lgBox.textContent}`);
      uiToast('已复制');
    } }),
    h('button', { class: 'btn sm danger', text: '清空日志', onclick: () => confirmSheet('清空界面日志', '将同时清除磁盘与浏览器本地留存的日志记录。', '清空', async () => {
      await clearUiLog();
      lgBox.textContent = '(已清空)';
      uiToast('已清空');
    }, '取消', true) }),
  ), lgBox);
  el.append(lg);

  // 关于
  el.append(groupTitle('关于'));
  const about = card();
  about.append(
    h('div', { class: 'card-head' }, h('h3', { text: 'Mihomo Box' }), badge(state.moduleVersion || '未知', 'b')),
    h('div', { class: 'kv' }, h('span', { class: 'k', text: 'mihomo 官方文档' }), h('span', { class: 'v', html: '<a href="https://wiki.metacubex.one/" target="_blank">wiki.metacubex.one</a>' })),
    h('div', { class: 'kv' }, h('span', { class: 'k', text: '官方内核' }), h('span', { class: 'v', html: '<a href="https://github.com/MetaCubeX/mihomo" target="_blank">MetaCubeX/mihomo</a>' })),
    // 分支内核（Smart+eBPF / 钉钉直连）不在路由器上提供，关于卡片里也不必列
    ...(isOpenWrt() ? [] : [
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Smart+eBPF 内核' }), h('span', { class: 'v', html: '<a href="https://github.com/liuran001/mihomo" target="_blank">liuran001/mihomo</a>' })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: '钉钉直连内核' }), h('span', { class: 'v', html: '<a href="https://github.com/jieluojun/mihomo" target="_blank">jieluojun/mihomo</a>' })),
    ]),
    h('div', { class: 'kv' }, h('span', { class: 'k', text: 'TG 频道' }), h('span', { class: 'v' }, h('a', { href: 'https://t.me/zxbjfsa', target: '_blank', rel: 'noopener noreferrer', text: '@zxbjfsa' }))),
    h('div', { class: 'kv' }, h('span', { class: 'k', text: '配置路径' }), h('span', { class: 'v', text: CONFIG_PATH })),
    h('div', { class: 'kv' }, h('span', { class: 'k', text: '工作目录' }), h('span', { class: 'v', text: WORKDIR })),
    h('div', { class: 'kv' }, h('span', { class: 'k', text: '模块目录' }), h('span', { class: 'v', text: MODDIR })),
  );
  el.append(about);
}


// ============================================================
// 面板服务卡片
// 面板本身就是一套常驻 HTTP 服务（管理器跳转 + 浏览器共用同一份页面）。
// 本卡管理：远程访问范围（局域网可见 / 仅本机）、监听端口、访问令牌、
// 访问地址与二维码。服务常驻运行，不提供“关闭服务”——管理器界面依赖它。
// ============================================================

// 网卡名 → 人话。判断顺序有讲究：ap/热点类要排在 wlan 前面，
// 否则 ap0 之类会被 wlan 前缀规则抢走，显示成「Wi-Fi」误导用户。
function ifaceLabel(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'lo' || n === 'lo0')          return { text: '本机浏览器', icon: '📲', hot: false, local: true };
  if (/^(ap|softap|swlan|wlan1)/.test(n)) return { text: '手机热点', icon: '📶', hot: true };
  if (/^(wlan|wifi|wl)/.test(n))          return { text: 'Wi-Fi', icon: '📡', hot: false };
  if (/^(rndis|usb|ncm)/.test(n))         return { text: 'USB 网络共享', icon: '🔌', hot: true };
  if (/^(bt-pan|bnep)/.test(n))           return { text: '蓝牙共享', icon: '🅱', hot: true };
  if (/^(eth|enp|en)/.test(n))            return { text: '以太网', icon: '🖧', hot: false };
  if (/^(rmnet|ccmni|v4-rmnet|ppp)/.test(n)) return { text: '移动数据', icon: '📱', hot: false };
  if (/^(tun|utun|clash|meta)/.test(n))   return { text: '虚拟网卡（VPN/TUN）', icon: '🌀', hot: false };
  return { text: name, icon: '🔗', hot: false };
}

// 地址排序：热点 / Wi-Fi 这类真正能用的排前面，虚拟网卡与移动数据沉底
function addrRank(name) {
  const l = ifaceLabel(name);
  if (l.hot) return 0;
  if (l.local) return 2.5;                 // 本机地址排在真实网卡之后、虚拟/移动数据之前
  if (l.text === 'Wi-Fi' || l.text === '以太网') return 1;
  if (l.text.startsWith('虚拟') || l.text.startsWith('移动')) return 3;
  return 2;
}

function webAccessCard() {
  // 就地清理上一实例（重渲染场景）。旧方案是在 document.body 上挂 subtree MutationObserver——
  // 切页/日志流的每个 DOM 变动都要跑一遍回调，本身就成了全局帧税。
  if (webAccessDispose) { try { webAccessDispose(); } catch (e) { } }
  const c = card();
  const st = badge('读取中…', 'b');
  // 说明行按状态显隐：运行态不显示（状态徽标 + 地址列表自解释），
  // 未开启/异常态才出现（那里是唯一的解释文案位置）
  const hint = h('div', { class: 'note', style: 'margin-top:0' });
  hint.hidden = true;
  const portInput = h('input', { type: 'number', value: '55555', style: 'width:96px', min: '1', max: '65535' });
  const remoteBox = h('div', {});
  const authBox = h('div', {});
  const addrBox = h('div', {});
  const qrBox = h('div', { class: 'qr-box', hidden: true });
  const actionRow = h('div', { style: 'display:flex;gap:10px;margin-top:12px' });
  const subRow = h('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap' });

  let cur = null;
  let busy = false;            // 用户操作进行中：事件刷新让位，避免与之争抢执行桥
  let lastSig = '';       // 地址签名：内容没变就不重绘，避免事件刷新时闪烁

  // 二维码：给一条地址，弹出大图，另一台设备扫码直接进
  const showQr = (url) => {
    const svg = qrSvg(url, { size: 260 });
    openSheet('扫码访问',
      h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:4px 0 2px' },
        svg ? h('div', { class: 'qr-pane', html: svg })
            : h('div', { class: 'note warn', text: '地址过长，无法生成二维码，请直接复制链接' }),
        h('div', { style: 'font-size:12.5px;color:var(--text-3);text-align:center;word-break:break-all;font-family:ui-monospace,monospace', text: url }),
        h('div', { class: 'note', style: 'text-align:center', text: '用另一台设备的相机 / 浏览器扫码即可打开。' })),
      h('div', { style: 'display:flex;gap:10px;margin-top:14px' },
        h('button', { class: 'btn block', text: '复制链接', onclick: () => copyAddr(url) }),
        h('button', { class: 'btn block pri', text: '完成', onclick: () => closeSheet() })));
  };

  // 复制地址：无论走 clipboard API 还是 execCommand 回退，都明确给出 toast 反馈
  const copyAddr = async (url) => {
    const ok = await copyText(url);
    if (ok) uiToast('✅ 地址已复制：' + url, 2600);
    else uiToast('复制失败，请长按地址手动复制', 3200);
  };

  const renderAddrs = (j) => {
    addrBox.innerHTML = '';
    qrBox.innerHTML = '';
    qrBox.hidden = true;
    if (!j.running) return;

    const list = (j.urls || []).slice().sort((a, b) => addrRank(a.iface) - addrRank(b.iface));
    // 标题行只有灯 + 文案：自动扫描（事件 + 2 秒轮询）已恢复，不再需要手点刷新
    addrBox.append(h('div', { class: 'sec-cap' }, '访问地址',
      h('span', { class: 'scan-dot' }),
      h('span', { class: 'scan-tip', text: '网络变化自动刷新' })));
    if (j.bind === 'local') {
      addrBox.append(note('远程访问已关闭：服务仅监听 127.0.0.1，管理器与本机浏览器可用，局域网其他设备连不上。', 'warn'));
    }
    if (!list.length) {
      addrBox.append(note('未检测到任何可用地址，请确认服务是否正常运行。', 'warn'));
      return;
    }

    list.forEach((u) => {
      const lb = ifaceLabel(u.iface);
      // 本机回环给「打开」而不是二维码 —— 扫 127.0.0.1 到别的设备上是打不开的
      const act = lb.local
        ? h('button', { class: 'btn xs pri', text: '打开', onclick: (e) => { e.stopPropagation(); window.open(u.url, '_blank'); } })
        : h('button', { class: 'btn xs pri', text: '二维码', onclick: (e) => { e.stopPropagation(); showQr(u.url); } });
      const row = h('div', { class: 'addr-row' },
        h('div', { class: 'addr-ic', text: lb.icon }),
        h('div', { class: 'addr-main' },
          h('div', { class: 'addr-name' }, lb.text,
            lb.hot ? badge('共享设备可用', 'g') : null,
            lb.local ? badge('仅本设备', 'b') : null,
            h('span', { class: 'addr-if', text: u.iface })),
          h('div', { class: 'addr-url', text: 'http://' + u.ip + ':' + j.port + '/' })),
        h('div', { class: 'addr-acts' },
          h('button', { class: 'btn xs', text: '复制', onclick: (e) => { e.stopPropagation(); copyAddr(u.url); } }),
          act));
      row.onclick = () => (lb.local ? window.open(u.url, '_blank') : showQr(u.url));
      addrBox.append(row);
    });

    // 首选地址的二维码直接摊开，最常见用法（拿另一台设备扫）零点击完成。
    // 本机回环地址排除在外：扫过去别的设备根本连不上。
    const first = list.find(u => !ifaceLabel(u.iface).local);
    if (!first) {
      addrBox.append(note('目前只有本机地址可用 —— 连接 Wi-Fi 或打开手机热点后，供其他设备访问的地址会自动出现。', 'warn'));
      return;
    }
    const svg = qrSvg(first.url, { size: 168 });
    if (svg) {
      qrBox.hidden = false;
      qrBox.append(
        h('div', { class: 'qr-pane sm', html: svg }),
        h('div', { class: 'qr-side' },
          h('div', { class: 'qr-title', text: '扫码即可打开' }),
          h('div', { class: 'qr-sub', text: ifaceLabel(first.iface).text + ' · ' + first.ip + ':' + j.port }),
          h('div', { class: 'qr-sub', text: j.auth ? '链接内含访问令牌，扫码后无需再输入。' : '当前未启用令牌，扫码直接进入。' })));
    }
  };

  // ---- 远程访问：开关决定监听范围（服务本身常驻，关掉的只是局域网可见性） ----
  const renderRemote = (j) => {
    remoteBox.innerHTML = '';
    const on = j.bind !== 'local';
    const sw = switchCtl(on, async (v) => {
      busy = true;
      try {
        await cmdline('webui-remote ' + (v ? 'true' : 'false'));
        uiToast(v ? '已开启远程访问（局域网可进）' : '已关闭远程访问（仅本机）', 2600);
      } finally { busy = false; }
      refresh();
    });
    remoteBox.append(h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, '远程访问',
        h('div', { class: 'f-desc', text: on
          ? '监听 0.0.0.0：同一 Wi-Fi / 热点下的设备可用浏览器远程管理。请只在可信网络下开启。'
          : '仅监听 127.0.0.1：管理器与本机浏览器可用，局域网其他设备连不上。' })),
      h('div', { class: 'f-ctl' }, sw)));
  };

  // ---- 访问令牌：开关 + 自定义（默认关闭） ----
  const editToken = () => {
    const inp = h('input', { type: 'text', value: cur ? cur.token : '', placeholder: '4 位以上，字母/数字/-_.~',
      style: 'width:100%', spellcheck: false, autocapitalize: 'off', autocomplete: 'off' });
    openSheet('自定义访问令牌',
      h('div', { class: 'note', text: '设置一个便于手输的口令（默认为 mihomo）。修改后，已授权的浏览器需要用新令牌重新进入。' }),
      inp,
      h('div', { style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap' },
        h('button', { class: 'btn sm', text: '随机生成', onclick: async () => {
          await cmdline('webui-token-random'); closeSheet(); uiToast('已生成随机令牌'); refresh();
        } })),
      h('div', { style: 'display:flex;gap:10px;margin-top:14px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => closeSheet() }),
        h('button', { class: 'btn block pri', text: '保存', onclick: async () => {
          const v = String(inp.value || '').trim();
          const r = await cmdline('webui-token-set ' + shq(v));
          const line = (r.stdout || r.stderr || '').split('\n').find(x => x.trim()) || '';
          if (/^ERR/.test(line)) { uiToast(line, 3600); return; }
          closeSheet(); uiToast('令牌已更新'); refresh();
        } })));
  };

  const renderAuth = (j) => {
    authBox.innerHTML = '';
    const sw = switchCtl(!!j.auth, async (v) => {
      await cmdline('webui-auth ' + (v ? 'true' : 'false'));
      uiToast(v ? '已启用访问令牌' : '已关闭访问令牌', 2600);
      refresh();
    });
    authBox.append(h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, '访问令牌',
        h('div', { class: 'f-desc', text: j.auth ? '需要令牌才能访问，链接与二维码已自动带上' : '默认关闭：同网段设备直接用 IP:端口 即可打开（开启后默认令牌 mihomo）' })),
      h('div', { class: 'f-ctl' }, sw)));
    if (j.auth) {
      authBox.append(h('div', { class: 'kv' },
        h('span', { class: 'k', text: '当前令牌' }),
        h('span', { class: 'v', style: 'display:flex;gap:8px;align-items:center;min-width:0' },
          h('span', { style: 'font-family:ui-monospace,monospace;word-break:break-all', text: j.token }),
          h('button', { class: 'btn xs', text: '修改', onclick: editToken }))));
    }
  };

  const render = (j) => {
    cur = j;
    actionRow.innerHTML = '';
    subRow.innerHTML = '';
    remoteBox.innerHTML = '';
    authBox.innerHTML = '';
    addrBox.innerHTML = '';
    qrBox.hidden = true;

    if (!j) {
      st.className = 'badge r'; st.textContent = '不可用';
      hint.hidden = false; hint.textContent = '无法读取服务状态，请稍后重试。';
      subRow.append(h('button', { class: 'btn sm', text: '重试', onclick: refresh }));
      return;
    }
    if (!j.httpd) {
      st.className = 'badge r'; st.textContent = '环境不支持';
      hint.hidden = false;
      hint.innerHTML = '未找到带 <b>httpd</b> 的 busybox。已自动查找 PATH、Magisk（/data/adb/magisk/busybox）、KernelSU、APatch 与 busybox-ndk 模块；都没有则请安装 Busybox 后重试。';
      subRow.append(h('button', { class: 'btn sm', text: '重新检测', onclick: refresh }));
      return;
    }

    renderRemote(j);
    renderAuth(j);

    if (j.running) {
      const localOnly = j.bind === 'local';
      st.className = 'badge g'; st.textContent = '运行中 · :' + j.port + (localOnly ? ' · 仅本机' : '');
      hint.hidden = true;   // 运行态说明已按需求去除：徽标（运行中·端口）+ 地址列表自解释
      // 重启：改端口/令牌后要生效，以及「更新模块后 httpd 还是旧进程」时手动重建。
      const restartBtn = h('button', { class: 'btn block', text: '⟳ 重启服务', onclick: async () => {
        restartBtn.disabled = true; restartBtn.textContent = '重启中…';
        busy = true;
        try {
          const r = await cmdline('webui-restart-json');
          const nj = parseJsonLoose(r && r.stdout);
          if (nj && nj.running) { uiToast('服务已重启'); lastSig = JSON.stringify(nj); render(nj); }
          else {
            const line = (r.stderr || r.stdout || '').split('\n').find(x => /^ERR/.test(x.trim())) || '';
            uiToast(line || '重启失败，请重试', 4000);
            await refresh();
          }
        } finally { busy = false; }
      } });
      actionRow.append(restartBtn);
      renderAddrs(j);
    } else {
      st.className = 'badge'; st.textContent = '未运行';
      hint.hidden = false;
      hint.textContent = '面板服务未在运行。管理器界面与浏览器访问都依赖它，点下面按钮拉起（开关监听通常也会自动拉起）。';
      const startBtn = h('button', { class: 'btn block pri', text: '▶ 启动面板服务', onclick: async () => {
        startBtn.disabled = true; startBtn.textContent = '正在启动…';
        busy = true;                       // 期间不让事件刷新插队
        try {
          // 用 -json 变体：启动 + 取状态一次往返完成，省掉一次执行桥调用。
          const r = await cmdline('webui-start-json');
          const j = parseJsonLoose(r && r.stdout);
          if (j && j.running) {
            uiToast('面板服务已启动');
            lastSig = JSON.stringify(j);
            if (j.port && document.activeElement !== portInput) portInput.value = j.port;
            render(j);                     // 直接用返回的状态渲染，无需再查一次
          } else {
            const line = (r.stderr || r.stdout || '').split('\n').find(x => /^ERR/.test(x.trim())) || '';
            uiToast(line || '启动失败，请重试', 4000);
            await refresh();
          }
        } finally { busy = false; }
      } });
      actionRow.append(startBtn);
    }
  };

  const refresh = async () => {
    const r = await cmdline('webui-status');
    const j = parseJsonLoose(r && r.stdout);
    if (j && j.port && document.activeElement !== portInput) portInput.value = j.port;
    lastSig = j ? JSON.stringify(j) : '';
    render(j);
  };

  // 状态刷新：打开卡片取一次；之后事件即时补取 + 可见时 2 秒轮询兜底，
  // 平时也可点「刷新」按钮。轮询只在盯着工具页看时才发桥调用（见下方守卫）。
  // 只有内容真的变了才重绘（否则二维码闪烁、按钮点不动）。
  const eventScan = async () => {
    if (document.visibilityState !== 'visible') return;
    if (!c.isConnected) return;
    if (document.getElementById('sheet') && !document.getElementById('sheet').hidden) return;
    if (document.getElementById('page-tools')?.hidden) return;   // 人不在工具页：事件压后
    if (userScrollingOrEditing()) return;   // 滚动/拖动/编辑中：让位给手势
    if (!cur || !cur.running) return;   // 服务未运行时没有任何可取
    if (busy) return;   // 用户正在执行操作时跳过本轮
    const r = await cmdline('webui-status');
    const j = parseJsonLoose(r && r.stdout);
    if (!j) return;
    const sig = JSON.stringify(j);
    if (sig === lastSig) return;
    lastSig = sig;
    if (j && j.port && document.activeElement !== portInput) portInput.value = j.port;
    render(j);
  };
  // 即时生效：热点开关、Wi-Fi 切换、页面回到前台时立即取一次，
  // 立即查一次 + 80/600ms 补两次（网卡 IP 刚分配时可能第一次还拿不到）。
  const triggerImmediateScan = () => {
    if (!c.isConnected || !cur || !cur.running) return;
    if (document.getElementById('page-tools')?.hidden) return;   // 人不在工具页：事件压后（回到页面时 onVis 会补取）
    if (busy) return;
    eventScan();
    setTimeout(eventScan, 80);
    setTimeout(eventScan, 600);
  };

  // 「应用」：先本地校验格式，再交给后端做占用检测（占用与否要看设备真实的 socket
  // 表，前端看不到），检测通过才落盘并重建服务。端口被占用时后端整段拒绝、设置
  // 保持不变，这里把输入框拨回当前端口，免得界面停在「看起来已经改好了」的假象。
  const portBtn = h('button', { class: 'btn xs', text: '应用', onclick: async () => {
    const v = String(portInput.value || '').trim();
    if (!/^\d{1,5}$/.test(v) || +v < 1 || +v > 65535) { uiToast('端口范围 1-65535，请填数字', 3200); return; }
    if (cur && String(cur.port) === v) { uiToast('端口未变更'); return; }
    if (busy) return;                     // 上一轮还没回来：不并发发同一条改端口命令
    busy = true;                          // 期间让位给本次操作（与事件刷新互斥）
    const btnText = portBtn.textContent;
    portBtn.disabled = true;
    portBtn.textContent = '检测中…';       // 后端要先看端口占用，慢设备上要等一下
    try {
      const r = await cmdline('webui-port ' + v);
      const line = (r.stdout || r.stderr || '').split('\n').find(x => x.trim()) || '';
      if (/^ERR/.test(line) || !line || (r.errno != null && r.errno !== 0 && !/^OK/.test(line))) {
        if (cur && cur.port) portInput.value = cur.port;   // 未生效：输入框回到真实值
        uiToast(/^ERR/.test(line) ? line : ('端口修改失败：' + (line || '无响应')), 4800);
        return;
      }
      const host = (typeof location !== 'undefined' && location.hostname) || '127.0.0.1';
      uiToast('端口已设为 ' + v + '，服务已重建。正在跳转…', 4000);
      // 端口换了 = 服务搬了家：当前页面还连着旧端口，后续请求会失败。
      // 延迟 1.2 秒让新 httpd 就绪后自动跳转到新端口，免得用户卡在旧端口的死页面上
      setTimeout(() => {
        try {
          if (typeof location !== 'undefined' && location.port && location.port !== v) {
            const newUrl = location.protocol + '//' + location.hostname + ':' + v + (location.pathname || '/') + location.search + location.hash;
            location.href = newUrl;
          }
        } catch (e) {}
      }, 1200);
    } finally {
      portBtn.disabled = false;
      portBtn.textContent = btnText;
      busy = false;
    }
  } });

  // 卡体收起时整体隐藏（与源码/锚点卡同构）；卡头常驻「标题 + 状态徽标 + 开关」，
  // 收起也始终看得到服务运行状态——内部刷新只动徽标与卡体内容，不碰卡头节点。
  const webBody = h('div', {},
    hint,
    h('div', { class: 'kv' }, h('span', { class: 'k', text: '监听端口' }),
      h('span', { class: 'v', style: 'display:flex;gap:8px;align-items:center' }, portInput, portBtn)),
    remoteBox,
    authBox,
    addrBox,
    qrBox,
    actionRow,
    subRow,
  );
  webBody.hidden = !toolsWebOpen;
  let webToggleBtn = null;
  const webHead = h('div', { class: 'card-head' }, h('h3', { text: '面板服务' }),
    h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto;justify-content:flex-end' }, st,
      (webToggleBtn = cardToggle(toolsWebOpen, () => setWebOpen(!toolsWebOpen)))));
  const setWebOpen = (v) => {
    toolsWebOpen = !!v;
    webBody.hidden = !toolsWebOpen;                 // [hidden] 在 style.css 里是 !important
    webHead.style.marginBottom = toolsWebOpen ? '' : '0';
    if (webToggleBtn) syncToggleBtn(webToggleBtn, toolsWebOpen);
  };
  setWebOpen(toolsWebOpen);
  c.append(webHead, webBody);
  refresh();
  // 自动扫描：事件（网络/可见性/切回前台）即时补取 + 可见时 2 秒轮询兜底。
  // 轮询是必需的：开/关热点这类网卡增减在 WebView 里不触发任何事件（不断网、
  // 不切连接类型），纯事件驱动等于没有自动刷新。eventScan 开头的守卫保证人
  // 不在工具页/滚屏/忙时一次桥调用都不发，只有盯着看时才每 2 秒查一次。
  const scanTimer = setInterval(() => { eventScan(); }, 2000);
  const onVis = () => { if (document.visibilityState === 'visible' && c.isConnected) triggerImmediateScan(); };
  const onNet = () => triggerImmediateScan();
  const onFocus = () => triggerImmediateScan();
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);
  window.addEventListener('focus', onFocus);
  window.addEventListener('pageshow', onNet);
  // 部分浏览器热点开启会触发 connection 变化
  try {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.addEventListener) conn.addEventListener('change', onNet);
  } catch (e) {}
  webAccessDispose = () => {
    try { clearInterval(scanTimer); } catch (e) {}
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('online', onNet);
    window.removeEventListener('offline', onNet);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('pageshow', onNet);
    try {
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn && conn.removeEventListener) conn.removeEventListener('change', onNet);
    } catch (e) {}
    webAccessDispose = null;
  };
  return c;
}

// ============================================================
// 网络匹配卡片（根据当前 Wi-Fi / 移动数据自动启停内核服务）
// ============================================================
function netMatchCard() {
  const c = card();
  const st = badge('读取中…', 'b');
  const body = h('div', {});
  let curCfg = { enabled: false, on_match: 'start', on_mismatch: 'stop', log: false, rules: [] };
  let netStatus = null;
  let logBoxEl = null;
  let noteEl = null;

  const updateStatusBadge = () => {
    st.className = `badge ${curCfg.enabled ? 'g' : ''}`;
    st.textContent = curCfg.enabled ? (netStatus && netStatus.matched ? '已启用 · 匹配中' : '已启用 · 未匹配') : '未启用';
    if (noteEl && netStatus) {
      const netDesc = [
        netStatus.wifi ? `Wi-Fi (${netStatus.ssid || '已连接'}${netStatus.bssid ? ' · ' + netStatus.bssid : ''})` : null,
        netStatus.cellular ? `蜂窝数据 (SIM ${netStatus.sim || 1}${netStatus.mcc_mnc ? ' · ' + netStatus.mcc_mnc : ''})` : null,
      ].filter(Boolean).join(' + ') || '无网络连接';
      noteEl.textContent = `当前网络: ${netDesc} | 匹配状态: ${netStatus.matched ? '已命中条件' : '未命中条件'}`;
    }
  };

  const pollStatusOnly = async () => {
    if (!c.isConnected || document.visibilityState !== 'visible') return;
    if (document.getElementById('page-tools')?.hidden) return;
    try {
      const rSt = await cmdline('netmatch-status');
      const jSt = parseJsonLoose(rSt && rSt.stdout);
      if (jSt) {
        netStatus = jSt;
        updateStatusBadge();
      }
      if (curCfg.log && logBoxEl) {
        const rLog = await cmdline('netmatch-log');
        if (logBoxEl) logBoxEl.textContent = (rLog && rLog.stdout) || '暂无日志';
      }
    } catch (e) {}
  };

  const loadData = async () => {
    try {
      const [rCfg, rSt] = await Promise.all([
        cmdline('netmatch-get'),
        cmdline('netmatch-status'),
      ]);
      const jCfg = parseJsonLoose(rCfg && rCfg.stdout);
      if (jCfg) curCfg = { ...curCfg, ...jCfg };
      netStatus = parseJsonLoose(rSt && rSt.stdout);
      render();
    } catch (e) {
      st.className = 'badge r'; st.textContent = '读取失败';
    }
  };

  const saveConfig = async () => {
    try {
      await cmdline(`netmatch-set ${shq(JSON.stringify(curCfg))}`);
      uiToast('网络匹配设置已更新');
      await loadData();
    } catch (e) {
      uiToast('保存失败: ' + (e?.message || e), 3000);
    }
  };

  const render = () => {
    body.innerHTML = '';
    updateStatusBadge();

    // 1. 启用网络匹配
    const enableSw = switchCtl(!!curCfg.enabled, async (v) => {
      curCfg.enabled = !!v;
      render();
      await saveConfig();
    });
    body.append(h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, '启用网络匹配',
        h('div', { class: 'f-desc', text: '开启后根据当前网络类型/SSID/运营商自动启停内核' })),
      h('div', { class: 'f-ctl' }, enableSw)));

    // 2. 网络匹配时
    const onMatchSel = selectCtl([['start', '启用服务'], ['stop', '停止服务']], curCfg.on_match || 'start', { title: '网络匹配时' });
    onMatchSel.addEventListener('change', async () => {
      curCfg.on_match = onMatchSel.value;
      await saveConfig();
    });
    body.append(h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, '网络匹配时'),
      h('div', { class: 'f-ctl' }, onMatchSel)));

    // 3. 网络未匹配时
    const onMismatchSel = selectCtl([['stop', '停止服务'], ['start', '启用服务'], ['none', '不执行操作']], curCfg.on_mismatch || 'stop', { title: '网络未匹配时' });
    onMismatchSel.addEventListener('change', async () => {
      curCfg.on_mismatch = onMismatchSel.value;
      await saveConfig();
    });
    body.append(h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, '网络未匹配时'),
      h('div', { class: 'f-ctl' }, onMismatchSel)));

    // 4. 启用网络控制日志
    const logSw = switchCtl(!!curCfg.log, async (v) => {
      curCfg.log = !!v;
      render();
      await saveConfig();
    });
    body.append(h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, '启用网络控制日志',
        h('div', { class: 'f-desc', text: '在状态变更及启停动作触发时记录运行日志' })),
      h('div', { class: 'f-ctl' }, logSw)));

    // 5. 当前网络状态摘要
    const netDesc = [
      netStatus?.wifi ? `Wi-Fi (${netStatus.ssid || '已连接'}${netStatus.bssid ? ' · ' + netStatus.bssid : ''})` : null,
      netStatus?.cellular ? `蜂窝数据 (SIM ${netStatus.sim || 1}${netStatus.mcc_mnc ? ' · ' + netStatus.mcc_mnc : ''})` : null,
    ].filter(Boolean).join(' + ') || '无网络连接';
    noteEl = h('div', { class: 'note', style: 'margin: 8px 0', text: `当前网络: ${netDesc} | 匹配状态: ${netStatus?.matched ? '已命中条件' : '未命中条件'}` });
    body.append(noteEl);

    // 6. 网络匹配条件列表
    body.append(h('div', { class: 'sec-cap', style: 'margin-top:12px' }, '网络匹配条件'));
    const ruleList = h('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:10px' });
    const RULE_LABELS = {
      wifi: 'Wi-Fi (任意)',
      wifi_ssid: 'Wi-Fi SSID',
      wifi_bssid: 'Wi-Fi BSSID',
      cellular: '蜂窝数据',
      mcc_mnc: 'MCC+MNC',
      sim1: '卡1 蜂窝数据',
      sim2: '卡2 蜂窝数据',
    };

    if (!curCfg.rules || !curCfg.rules.length) {
      ruleList.append(h('div', { class: 'empty', text: '暂无匹配条件，点下方按钮添加' }));
    } else {
      curCfg.rules.forEach((r, idx) => {
        const item = h('div', { class: 'kv', style: 'padding:8px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;align-items:center' },
          h('span', { class: 'k', style: 'font-weight:600', text: RULE_LABELS[r.type] || r.type }),
          h('span', { class: 'v', style: 'display:flex;align-items:center;gap:8px' },
            r.value ? h('span', { style: 'font-family:ui-monospace,monospace;color:var(--text-2)', text: r.value }) : null,
            h('button', { class: 'btn xs danger', text: '删除', onclick: async () => {
              curCfg.rules.splice(idx, 1);
              render();
              await saveConfig();
            } })
          ));
        ruleList.append(item);
      });
    }
    body.append(ruleList);

    // 7. 添加匹配条件按钮
    const addBtn = h('button', { class: 'btn block pri', text: '＋ 添加网络匹配条件', onclick: () => showAddSheet() });
    body.append(addBtn);

    // 8. 控制日志卡片
    if (curCfg.log) {
      const logCard = h('div', { style: 'margin-top:14px' });
      logBoxEl = h('pre', { class: 'logbox', style: 'max-height:140px', text: '加载中…' });
      const refreshLog = async () => {
        const res = await cmdline('netmatch-log');
        if (logBoxEl) logBoxEl.textContent = (res && res.stdout) || '暂无日志';
      };
      refreshLog();
      logCard.append(
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' },
          h('span', { style: 'font-size:13px;font-weight:600', text: '网络控制日志' }),
          h('div', { style: 'display:flex;gap:6px' },
            h('button', { class: 'btn sm', text: '刷新', onclick: refreshLog }),
            h('button', { class: 'btn sm', text: '清空', onclick: async () => {
              await cmdline('netmatch-clear-log');
              if (logBoxEl) logBoxEl.textContent = '暂无日志';
              uiToast('已清空控制日志');
            } })
          )
        ),
        logBoxEl
      );
      body.append(logCard);
    } else {
      logBoxEl = null;
    }
  };

  const showAddSheet = () => {
    const opts = [
      ['wifi', 'Wi-Fi (任意)'],
      ['wifi_ssid', 'Wi-Fi SSID'],
      ['wifi_bssid', 'Wi-Fi BSSID'],
      ['cellular', '蜂窝数据'],
      ['mcc_mnc', 'MCC+MNC'],
      ['sim1', '卡1 蜂窝数据'],
      ['sim2', '卡2 蜂窝数据'],
    ];

    const list = h('div', { class: 'optlist' });
    opts.forEach(([t, label]) => {
      const opt = h('div', { class: 'opt' },
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title', text: label })));
      opt.onclick = () => {
        closeSheet();
        if (t === 'wifi_ssid') {
          promptValue('输入 Wi-Fi SSID', netStatus?.ssid || '', async (val) => {
            if (!val) return;
            curCfg.rules = curCfg.rules || [];
            curCfg.rules.push({ type: t, value: val });
            render();
            await saveConfig();
          });
        } else if (t === 'wifi_bssid') {
          promptValue('输入 Wi-Fi BSSID (MAC)', netStatus?.bssid || '', async (val) => {
            if (!val) return;
            curCfg.rules = curCfg.rules || [];
            curCfg.rules.push({ type: t, value: val });
            render();
            await saveConfig();
          });
        } else if (t === 'mcc_mnc') {
          promptValue('输入 MCC+MNC (如 46000)', netStatus?.mcc_mnc || '', async (val) => {
            if (!val) return;
            curCfg.rules = curCfg.rules || [];
            curCfg.rules.push({ type: t, value: val });
            render();
            await saveConfig();
          });
        } else {
          curCfg.rules = curCfg.rules || [];
          curCfg.rules.push({ type: t, value: '' });
          render();
          saveConfig();
        }
      };
      list.append(opt);
    });

    openSheet('添加网络匹配条件', list);
  };

  const promptValue = (title, defaultVal, onConfirm) => {
    const input = h('input', { type: 'text', value: defaultVal, style: 'width:100%;margin-top:8px', placeholder: '请输入值' });
    const close = openSheet(title,
      input,
      h('div', { style: 'display:flex;gap:10px;margin-top:14px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
        h('button', { class: 'btn block pri', text: '确定', onclick: () => {
          const v = input.value.trim();
          close();
          onConfirm(v);
        } })
      )
    );
  };

  body.hidden = !toolsNetMatchOpen;
  let toggleBtn = null;
  const head = h('div', { class: 'card-head' }, h('h3', { text: '网络匹配' }),
    h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto;justify-content:flex-end' }, st,
      (toggleBtn = cardToggle(toolsNetMatchOpen, () => setOpen(!toolsNetMatchOpen)))));
  const setOpen = (v) => {
    toolsNetMatchOpen = !!v;
    body.hidden = !toolsNetMatchOpen;
    head.style.marginBottom = toolsNetMatchOpen ? '' : '0';
    if (toggleBtn) syncToggleBtn(toggleBtn, toolsNetMatchOpen);
  };
  setOpen(toolsNetMatchOpen);
  c.append(head, body);
  loadData();

  const timer = setInterval(() => { pollStatusOnly(); }, 2500);
  const onNet = () => { pollStatusOnly(); };
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);
  document.addEventListener('visibilitychange', onNet);

  return c;
}

// 注册配置各页（含原分流子页）
PAGE_RENDER['page-config'] = renderConfigHub;
PAGE_RENDER['page-proxies'] = renderProxyPage;
PAGE_RENDER['page-core'] = renderCore;
PAGE_RENDER['page-c-general'] = renderGeneral;
PAGE_RENDER['page-c-dns'] = renderDns;
PAGE_RENDER['page-c-inbound'] = renderInbound;
PAGE_RENDER['page-c-ruleproviders'] = renderRuleProviders;
PAGE_RENDER['page-c-subrules'] = renderSubRules;
PAGE_RENDER['page-c-tunnels'] = renderTunnels;
PAGE_RENDER['page-c-ntp'] = renderNtp;
PAGE_RENDER['page-c-experimental'] = renderExperimental;
PAGE_RENDER['page-c-sniff'] = renderSniff;
PAGE_RENDER['page-f-proxies'] = renderProxies;
PAGE_RENDER['page-f-subs'] = renderSubs;
PAGE_RENDER['page-f-groups'] = renderGroups;
PAGE_RENDER['page-f-rules'] = renderRules;

// ================= 启动 =================
// ============================================================
// 配置校验结果弹层
// 报错信息是要拿去搜索 / 贴给别人看的，所以：完整展示不截断、
// 可长按选中、并提供一键复制。
// ============================================================
function showTestResult(out) {
  const text = out || '无输出';
  const hasErr = /configuration file .* failed|ERR|error|panic/i.test(text);
  uiLog(hasErr ? 'error' : 'info', '配置校验结果', text);

  const box = h('div', { class: 'logbox dashboard-logbox config-test-logbox', style: 'margin-top:10px' });
  for (const line of text.split('\n')) {
    const level = /\bwarning|WARN/i.test(line) ? 'lv-warn'
      : /\berror|fatal|panic|ERR/i.test(line) ? 'lv-err'
      : /\bdebug/i.test(line) ? 'lv-debug' : 'lv-info';
    box.append(h('div', { class: level, text: line }));
  }
  const doCopy = async () => {
    const ok = await copyText(text);
    uiToast(ok ? '✅ 校验结果已复制' : '复制失败，请长按选中后手动复制', ok ? 2200 : 3200);
  };

  openSheet(hasErr ? '❌ 配置校验未通过' : '✅ 配置校验通过',
    h('div', { class: 'note', text: hasErr
      ? '内核拒绝了当前配置，可使用“复制结果”按钮复制完整输出。'
      : '内核已接受当前配置。' }),
    box,
    h('div', { style: 'display:flex;gap:10px;margin-top:14px' },
      h('button', { class: 'btn block', text: '📋 复制结果', onclick: doCopy }),
      h('button', { class: 'btn block pri', text: '知道了', onclick: () => closeSheet() })));
}

// ============================================================
// PWA：安装到桌面 / 主屏
//
// 注意 Service Worker 只在「安全上下文」可用：https 或 127.0.0.1/localhost。
// 用局域网 IP 走明文 http 打开时，浏览器不提供 SW，也就无法触发安装横幅
// （iOS Safari 例外，它靠「添加到主屏幕」手动完成，不依赖 SW）。
// 因此这里做能力检测，不能装时如实告诉用户原因，而不是给个点了没反应的按钮。
// ============================================================
let swReady = false;

function pwaSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext;
}

// ============================================================
// 刷入检测：每次刷入模块，customize.sh 都会重写 webroot/install.stamp
// （内容 = 本次模块版本戳）。本地记录的戳与它不一致，就说明模块被重刷过：
// 清掉 Cache Storage 里的旧壳/旧 JS，并重载一次，确保跑的是刚刷进去的那套面板。
// 全程不带版本号 —— URL 保持干净，判断只依赖「刷入动作」本身。
// 管理器 WebView 不注册 Service Worker，这条检测是那边的唯一兜底，
// 因此浏览器与 WebView 两种环境都要跑（boot 里无条件调用）。
// ============================================================
const INSTALL_STAMP_KEY = 'mihomo-install-stamp';

async function checkInstallStamp() {
  try {
    const r = await fetch('install.stamp', { cache: 'no-store' });
    if (!r.ok) return;                       // 包里没有指纹文件（老模块）→ 保持原行为
    const now = (await r.text()).trim();
    if (!now) return;
    let old = null;
    try { old = localStorage.getItem(INSTALL_STAMP_KEY); } catch (e) { /* 存储不可用则跳过 */ }
    if (old === now) return;                 // 同一份刷入，不做处理
    try { localStorage.setItem(INSTALL_STAMP_KEY, now); } catch (e) {}
    if (old === null) return;                // 首次记录：本来就在跑当前版本
    // 模块被重刷：旧缓存全部作废，SW 会在接管时按当前磁盘文件重建
    if ('caches' in window) {
      const ks = await caches.keys();
      await Promise.all(ks.map(k => caches.delete(k)));
    }
    try {
      if (sessionStorage.getItem('mihomo-stamp-reloaded')) return;   // 一次会话只重载一次，防循环
      sessionStorage.setItem('mihomo-stamp-reloaded', '1');
    } catch (e) { return; }
    setTimeout(() => window.location.reload(), 200);
  } catch (e) { /* 离线或拿不到指纹：什么都不做，不打断正常使用 */ }
}

async function initPWA() {
  if (!IS_REMOTE) return;        // 演示模式无后端，不注册 SW
  if (!pwaSupported()) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: '.' });
    swReady = true;
    // 新版本 SW 接管时自动刷新一次。
    // 更新模块后旧 SW 可能仍在控制页面（它手里是上一版的 HTML/JS 缓存），
    // 光等用户手动刷新往往要来回折腾 —— 这里检测到接管就重载，
    // 让新版资源立刻生效（activate 会顺带清掉旧缓存）。
    // sessionStorage 防循环：一次会话只自动重载一次。
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      try {
        if (sessionStorage.getItem('mihomo-sw-reloaded')) return;
        sessionStorage.setItem('mihomo-sw-reloaded', '1');
      } catch (e) { /* 存储不可用就跳过自动重载，交给用户手动刷新 */ return; }
      reloading = true;
      setTimeout(() => window.location.reload(), 300);
    });
    // 每次进页面都主动核对一次 SW 是否有新版（浏览器默认检查可能滞后）
    try { reg.update(); } catch (e) { /* 忽略：不影响主流程 */ }
  } catch (e) { swReady = false; }
}

// ============================================================
// 令牌输入页（浏览器远程访问）
// 设备端开启了令牌校验，而浏览器只输入了 IP:端口 时显示。
// 覆盖整屏，验证通过后即进入正常界面，不再走演示模式。
// ============================================================
function tokenGate(onPass) {
  let gate = document.getElementById('tokenGate');
  if (gate) { gate.hidden = false; return; }

  const inp = h('input', {
    type: 'password', placeholder: '请输入访问令牌', spellcheck: false,
    autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off',
    style: 'width:100%;text-align:center;font-family:ui-monospace,monospace;letter-spacing:1px',
  });
  const err = h('div', { class: 'note warn', hidden: true, style: 'margin-top:10px' });
  const btn = h('button', { class: 'btn block pri', style: 'margin-top:14px', text: '进入' });
  const eye = h('button', { class: 'btn xs', text: '👁 显示', onclick: () => {
    const on = inp.type === 'password';
    inp.type = on ? 'text' : 'password';
    eye.textContent = on ? '🙈 隐藏' : '👁 显示';
  } });

  const submit = async () => {
    const v = String(inp.value || '').trim();
    if (!v) { err.hidden = false; err.textContent = '请先输入令牌'; return; }
    btn.disabled = true; btn.textContent = '验证中…';
    setToken(v);
    const r = await probeAuth();
    btn.disabled = false; btn.textContent = '进入';
    if (r === 'ok') {
      gate.hidden = true;
      onPass && onPass();
      return;
    }
    setToken('');
    err.hidden = false;
    err.textContent = r === 'need-token' ? '令牌不正确，请检查后重试' : '无法连接到设备上的服务，请确认服务仍在运行';
    inp.select();
  };
  btn.onclick = submit;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  gate = h('div', { class: 'gate', id: 'tokenGate' },
    h('div', { class: 'gate-card' },
      h('div', { class: 'gate-ic', text: '🔐' }),
      h('div', { class: 'gate-title', text: 'Mihomo Box' }),
      h('div', { class: 'gate-sub', text: '此设备已启用访问令牌，请输入后继续' }),
      inp,
      h('div', { style: 'display:flex;justify-content:flex-end;margin-top:8px' }, eye),
      err,
      btn));
  document.body.append(gate);
  focusTextInput(inp, { reveal: true });   // 自动聚焦不设重试；实际点按仍走统一手势入口
}

async function boot() {
  mountSaveBar();
  installCloseOnEscape();   // 桌面端按 Esc 关掉最上面那层弹层
  applyTheme();
  checkInstallStamp();   // 不 await：后台比对刷入指纹，需重载时才动作，不拖慢首屏

  // 首屏同步：顶栏+底栏与骨架同帧出现，避免内容等待数据时的白屏
  try {
    document.getElementById('pageTitle').textContent = '主页';
    document.getElementById('pageSubtitle').textContent = '内核运行状态';
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.page === 'page-dashboard'));
    pages.forEach(p => { p.hidden = p.id !== 'page-dashboard'; });
    current = 'page-dashboard';
    const dashEl = document.getElementById('page-dashboard');
    // 首屏直铺骨架：设备数据回来后由 boot 末尾的 rerenderCurrent 正常渲染
    if (dashEl && !dashEl.firstChild) {
      dashEl.innerHTML = '<div class="card" style="padding:18px"><div style="height:16px;width:42%;background:var(--fill);border-radius:8px;margin-bottom:12px"></div><div style="height:12px;width:68%;background:var(--fill);border-radius:8px;margin-bottom:10px"></div><div style="display:flex;gap:8px"><div style="flex:1;height:56px;background:var(--fill);border-radius:14px"></div><div style="flex:1;height:56px;background:var(--fill);border-radius:14px"></div><div style="flex:1;height:56px;background:var(--fill);border-radius:14px"></div></div></div><div class="card" style="padding:18px"><div style="height:14px;width:28%;background:var(--fill);border-radius:8px;margin-bottom:10px"></div><div style="height:10px;width:100%;background:var(--fill);border-radius:8px;margin-bottom:8px"></div><div style="height:10px;width:84%;background:var(--fill);border-radius:8px"></div></div>';
    }
  } catch(e) {}

  if (IS_REMOTE) {
    // 桥随时可能因为「后来才开启令牌」而返回 401，届时再次弹出输入页
    setUnauthorizedHandler(() => tokenGate(() => window.location.reload()));
    initPWA();
  }
  // 不调用 fullScreen/enableEdgeToEdge —— 保留系统状态栏与导航栏，非全屏体验更自然

  // 单次高效聚合拉取 boot-data（聚合状态、配置、版本、日志，省去 4 次连续或并发 bridge/CGI 往返）
  if (DEMO) {
    state.status = { running: 0, pid: '', core: 'liuran001', mode: 'rule', autostart: 'true', controller: '127.0.0.1:9090', config_exists: 1, liuran001_exists: 0, jieluojun_exists: 0, official_exists: 0, liuran001_ver: '', jieluojun_ver: '', official_ver: '', current_ver: '', uptime: '' };
    await loadConfig();
  } else {
    try {
      const bootR = await cmdline('boot-data');
      let bootJ = parseJsonLoose(bootR && bootR.stdout);
      if (!bootJ) {
        const bootR2 = await cmdline("boot-data 2>/dev/null | sed -n '/^{/,/^}/p'");
        bootJ = parseJsonLoose(bootR2 && bootR2.stdout);
      }
      if (bootJ && bootJ.status) {
        if (bootJ.module_version) state.moduleVersion = bootJ.module_version;
        state.status = bootJ.status;
        applyBackendInfo(bootJ.status);
        applyPlatformText();
        state.running = !!Number(bootJ.status.running);
        syncUpStart(state.status);
        // 首屏这一份状态也走同一套「CPU 补读」排程：以前只有 status 心跳里有，
        // 而进主页看到的第一份状态几乎都来自 boot-data —— 于是刚启动的内核在
        // 主页上要干等 2 秒资源轮询那一拍才出数字（「过好几秒才显示」的真正来源）。
        maybeScheduleCpuFill(bootJ.status);
        if (bootJ.config_b64) {
          const cfgText = b64ToUtf8(bootJ.config_b64);
          if (cfgText) applyConfigText(cfgText);
        }
        if (bootJ.logs_b64) {
          const logText = b64ToUtf8(bootJ.logs_b64);
          if (logText) {
            dashLogCache.text = logText;
            dashLogCache.at = Date.now();
          }
        }
        if (current === 'page-dashboard') rerenderCurrent();
      } else {
        const versionP = shell(`grep '^version=' "${MODDIR}/module.prop" 2>/dev/null | head -1 | cut -d= -f2`).then(r => {
          state.moduleVersion = (r.stdout || '').trim() || null;
        }).catch(() => { state.moduleVersion = null; });
        const statusP = refreshStatus();
        const configP = loadConfig();
        await Promise.all([statusP, configP, versionP]);
      }
    } catch (e) {
      const versionP = shell(`grep '^version=' "${MODDIR}/module.prop" 2>/dev/null | head -1 | cut -d= -f2`).then(r => {
        state.moduleVersion = (r.stdout || '').trim() || null;
      }).catch(() => { state.moduleVersion = null; });
      const statusP = refreshStatus();
      const configP = loadConfig();
      await Promise.all([statusP, configP, versionP]);
    }
  }

  // Probe direct controller access once; failure retains the existing bridge path.
  controller.prepare().then(c => uiLog('info', '控制器 API 首次探测', c ? 'HTTP 直连' : '执行桥转发'))
    .catch(e => uiLog('warn', '控制器 API 探测失败', e.message));
  startStatusLoop();
  startResourceLoop();   // CPU / 内存徽标每 2 秒刷新（见 startResourceLoop 注释）
  navPending = false;
  if (current === 'page-dashboard') rerenderCurrent();
  else rerenderCurrentDeferred();

  // 主页渲染完成后，后台在空闲时预热构建内核页、工具页与代理页，
  // 用户切到对应 Tab 时直接呈现完整数据，无需等待重新加载！
  if (!DEMO) {
    const prewarmIdle = () => {
      for (const pid of ['page-core', 'page-tools', 'page-proxies']) {
        if (current !== 'page-dashboard') break;
        const sec = document.getElementById(pid);
        if (!sec || !PAGE_RENDER[pid] || pageIsFresh(pid)) continue;
        try {
          PAGE_RENDER[pid](sec);
          landedRev[pid] = uiRev();
          landedAt[pid] = Date.now();
        } catch (e) {
          console.warn('idle prewarm failed', pid, e);
        }
      }
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(prewarmIdle, { timeout: 800 });
    } else {
      setTimeout(prewarmIdle, 100);
    }
  }
}
