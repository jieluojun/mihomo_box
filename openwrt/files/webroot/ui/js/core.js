// ============================================================
// Mihomo Box WebUI — 核心框架
// 状态 / Shell 桥接 / UI 组件库
// ============================================================
import { exec, REMOTE } from './kernelsu.js';
import { logJson, redactUiLog } from './log-redaction.js';

// 安装目录：面板由 <安装目录>/webroot/ui/ 提供，脚本地址上溯三级即得 —— 这样
// Android（/data/adb/modules/mihomo_box）与 OpenWrt（/etc/mihomo_box）共用一套代码，
// 换目录部署也不用改这里。非 http(s) 环境（如本地文件预览 / 测试）退回 Android 固定值。
const PANEL_ROOT = (() => {
  try {
    const m = new URL(import.meta.url).pathname.match(/^(.*)\/webroot\/ui\/js\/[^/]+$/);
    if (m && m[1]) return decodeURIComponent(m[1]);
  } catch (e) { /* 非浏览器环境：走下面的回退 */ }
  return '';
})();
// 模块目录：
//   Android —— 面板 URL 里就带模块路径（…/webroot/ui/js/core.js），能从 import.meta.url 解析出来
//   OpenWrt —— busybox httpd 直接把 ui/ 当根目录（URL 是 /js/core.js），解析不出来，
//              必须等后端 status 的 workdir 字段回来再落位（见 applyBackendInfo）
export let MODDIR = PANEL_ROOT || '/data/adb/modules/mihomo_box';
// 工作目录：Android 上与模块目录不同（/data/adb/mihomo_box），路由器上同一目录。
// 这里先给一个能用的初值，首份后端状态回来时由 applyBackendInfo() 对齐。
const ANDROID_WORKDIR = '/data/adb/mihomo_box';
export let WORKDIR = (MODDIR === '/data/adb/modules/mihomo_box') ? ANDROID_WORKDIR : MODDIR;
export let CONFIG_PATH = `${WORKDIR}/config.yaml`;
export let RUNDIR = `${WORKDIR}/run`;            // 运行期文件：pid / 日志 / 保存诊断
// 后端命令入口（面板前端所有命令都走它）。路由器上 scripts/mihomo.sh 是调度器，
// 会把 update-core / core-info 这类路由器命令接住。
export let SH = `sh ${MODDIR}/scripts/mihomo.sh`;

// 平台信息（Android / OpenWrt）：后端 status_json 会带 platform 与 workdir 两个字段，
// 拿到后把路径对齐、并记录平台，界面据此隐藏对端专有的功能。
export function applyBackendInfo(st) {
  if (!st || typeof st !== 'object') return;
  if (typeof st.workdir === 'string' && st.workdir && st.workdir !== WORKDIR) {
    WORKDIR = st.workdir;
    CONFIG_PATH = `${WORKDIR}/config.yaml`;
    RUNDIR = `${WORKDIR}/run`;
    UI_LOG = `${RUNDIR}/webui.log`;
  }
  if (typeof st.platform === 'string' && st.platform) state.platform = st.platform;
}
export function isOpenWrt() { return state.platform === 'openwrt'; }

// 后端信息自举（只做一次）：
//   Android —— PANEL_ROOT 已从 URL 解出模块目录，直接返回，不发多余请求（首屏时序不受影响）
//   OpenWrt —— 面板 URL 里没有模块路径，向执行桥问一次 __panel_info__，据此落位
//              MODDIR / SH / WORKDIR，之后所有命令才拼得出正确路径。
// 失败也记入结果，避免每次命令都再等一次超时。
let backendReady = null;
export function ensureBackendInfo() {
  if (backendReady) return backendReady;
  backendReady = (async () => {
    if (PANEL_ROOT || !REMOTE) return;
    try {
      const { panelInfo } = await import('./kernelsu.js');
      const info = await panelInfo();
      if (!info) return;
      // 安装目录必须由后端明说（module_dir），不能用 workdir 反推：
      // Android 上 workdir（/data/adb/mihomo_box）和模块目录（/data/adb/modules/mihomo_box）
      // 是两个地方，拿 workdir 当模块目录会把命令路径指错。
      const moddir = (typeof info.module_dir === 'string' && info.module_dir) ? info.module_dir : '';
      if (moddir && moddir !== MODDIR) { MODDIR = moddir; SH = `sh ${MODDIR}/scripts/mihomo.sh`; }
      if (typeof info.workdir === 'string' && info.workdir && info.workdir !== WORKDIR) {
        WORKDIR = info.workdir;
        CONFIG_PATH = `${WORKDIR}/config.yaml`;
        RUNDIR = `${WORKDIR}/run`;
        UI_LOG = `${RUNDIR}/webui.log`;
      }
      if (typeof info.platform === 'string' && info.platform) state.platform = info.platform;
    } catch (e) { /* 桥不可用：保持默认，后续命令各自报错 */ }
  })();
  return backendReady;
}

// 两种运行环境（只差有没有后端，没有 I/O 路径差异）：
//   面板（REMOTE）→ 页面由面板 httpd 提供，exec 经 CGI 执行桥直达 root shell
//   其余（本地开文件预览）→ 演示模式，只读不落盘
export { REMOTE } from './kernelsu.js';
export const DEMO = (!REMOTE);

// ---------------- 全局状态 ----------------
export const state = {
  cfg: {},            // 当前草稿的可视化模型
  raw: '',            // 当前草稿源码（修改立即同步，不等于已写入文件）
  dirty: false,       // 有未保存修改
  status: null,       // 内核运行状态 JSON
  cfgError: null,     // YAML 解析错误
  running: false,
  platform: 'android',   // android | openwrt（由 status 的 platform 字段刷新）
  saveBusy: false,
  // 仅由 TUN/eBPF 接管方式开关设置；保存后重启服务，普通字段仍走热重载询问。
  restartServiceAfterSave: false,
  suppressSaveBar: false,
  anchorOps: [],      // 兼容旧调用；markDirty 当场消费，新入口直接用 commitConfigEdit，绝不留到保存才显示
};

// ---------------- Shell 桥 ----------------
export async function shell(cmd, opts = {}) {
  // 所有命令的唯一入口：路由器首屏必须先问出安装目录，否则命令路径无从拼起。
  // （Android 上这是同步返回的，无网络往返，不影响 CPU 首值时序。）
  await ensureBackendInfo();
  try {
    const r = await exec(cmd, { cwd: '/' });
    return r;
  } catch (e) {
    return { errno: -1, stdout: '', stderr: String(e) };
  }
}

// 命令执行：单次 HTTP 请求直达执行桥，无队列、无后台点火、无轮询取回。
// （旧架构里管理器原生桥是串行的，读状态/日志才需要脱离队列走后台通道；
// 现在只有 HTTP 一条路，天生并发，一律一次请求拿结果。）
export async function cmdline(args) {
  return shell(`${SH} ${args}`);
}

// shell 单引号转义：任意字符串包成安全的单个 shell 参数
export function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// 订阅更新进度弹窗（主页/代理集合共用）：打开即取一次状态，之后点「刷新进度」
// 单次取回；关闭只关弹窗，任务有界自动结束。不用任何定时轮询。
export function subsSheet() {
  const stageEl = h('div', { style: 'font-size:15px;font-weight:700;margin-bottom:4px', text: '正在更新订阅…' });
  const subEl = h('div', { style: 'font-size:12.5px;color:var(--text-3);margin-bottom:14px', text: '' });
  const bar = h('div', { class: 'progress-line' }, h('i', { style: 'width:0%' }));
  const bytesEl = h('div', { style: 'display:flex;justify-content:space-between;margin-top:8px;font-size:12.5px;color:var(--text-2);font-family:ui-monospace,monospace' },
    h('span', { class: 'loaded', text: '0 / 0' }), h('span', { class: 'pct', text: '0%' }));
  const logEl = h('pre', { class: 'logbox', style: 'max-height:120px;margin-top:10px' });
  const refreshBtn = h('button', { class: 'btn block', text: '刷新进度', style: 'margin-top:14px', onclick: () => { fetchOnce(); } });
  const closeBtn = h('button', { class: 'btn block', text: '关闭', style: 'margin-top:8px', onclick: () => { closeSheet(); } });
  const closeSheetFn = openSheet('更新订阅', stageEl, subEl, bar, bytesEl, logEl, refreshBtn, closeBtn);
  let busy = false;
  let finished = false;
  async function fetchOnce() {
    // 单次取回：慢请求不重叠（busy 互斥），弹窗关了就丢弃迟到回包
    if (busy || finished || !closeSheetFn.isCurrent()) return;
    busy = true;
    refreshBtn.disabled = true;
    try {
      const r = await cmdline('update-subs-status');
      if (!closeSheetFn.isCurrent()) return;
      const j = parseJsonLoose(r && r.stdout);
      if (!j) return;
      const done = j.done || 0, total = j.total || 0, ok = j.ok || 0, fail = j.fail || 0;
      const skipped = j.skipped || 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      bytesEl.querySelector('.loaded').textContent = done + ' / ' + total;
      bytesEl.querySelector('.pct').textContent = pct + '%';
      if (bar.firstElementChild) bar.firstElementChild.style.width = pct + '%';
      subEl.textContent = '成功 ' + ok + ' · 失败 ' + fail + (skipped > 0 ? ' · 跳过 ' + skipped + ' 个本地文件' : '');
      logEl.textContent = (j.detail || []).join('\n');
      if (j.stage === 'done') {
        finished = true;
        stageEl.textContent = '✅ 订阅更新完成（成功 ' + ok + '，失败 ' + fail + '）' + (skipped > 0 ? '，跳过 ' + skipped + ' 个 file 订阅' : '');
        refreshBtn.textContent = '已完成';
        uiToast('订阅更新完成：成功 ' + ok + '，失败 ' + fail + (skipped > 0 ? '，跳过 ' + skipped : ''));
      }
    } catch (e) {
      console.warn('进度获取失败', e);
    } finally {
      busy = false;
      if (!finished && closeSheetFn.isCurrent()) refreshBtn.disabled = false;
    }
  }
  fetchOnce();
}


// 相对路径一律归一到 mihomo 工作目录（mihomo 以 -d WORKDIR 启动，相对路径相对它解析）；
// 否则 shell 的 cwd 可能是只读目录（/ 等），写入报 "Read-only file system"
export function absPath(p) {
  p = (p || '').trim();
  if (!p) return p;
  return p.startsWith('/') ? p : `${WORKDIR}/${p.replace(/^\.\//, '')}`;
}

// 反向：工作目录内的完整路径 → 「./」相对写法（mihomo 以 -d WORKDIR 启动，相对路径按工作目录
// 解析，两种写法指向同一个文件）。工作目录外的路径、已是相对写法的原样返回。
export function relPath(p) {
  p = (p || '').trim();
  const base = WORKDIR.replace(/\/+$/, '') + '/';
  if (!p.startsWith(base)) return p;
  const rest = p.slice(base.length).replace(/^\/+/, '');
  if (!rest || /(^|\/)\.\.(\/|$)/.test(rest)) return p;   // 含 .. 的不动（可能跳出工作目录）
  return './' + rest;
}

export function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

// 读取文本文件
export async function readText(path) {
  if (DEMO) {
    const v = localStorage.getItem('demo-file:' + path);
    return { errno: 0, stdout: (v && !v.startsWith('B64:')) ? v : '' };
  }
  return shell(`cat "${absPath(path)}" 2>/dev/null || echo __READ_FAIL__`);
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

// 写 base64（支持二进制；分块避免超长命令；自动创建父目录）
export async function writeB64(path, b64) {
  if (DEMO) { localStorage.setItem('demo-file:' + path, 'B64:' + b64); return { errno: 0 }; }
  path = absPath(path);
  const dir = path.replace(/\/[^/]*$/, '');
  const step = 40000;
  for (let i = 0; i < b64.length; i += step) {
    const part = b64.slice(i, i + step);
    const pre = i === 0 ? `mkdir -p "${dir}" && ` : '';
    const redir = i === 0 ? '>' : '>>';
    const r = await shell(`${pre}echo -n '${part}' | base64 -d ${redir} "${path}"`);
    if (r.errno !== 0) return r;
  }
  return { errno: 0 };
}

// 写文本文件（分块 base64，避免超长命令）
export async function writeText(path, text) {
  if (DEMO) { localStorage.setItem(path === CONFIG_PATH ? 'demo-config' : 'demo-file:' + path, text); return { errno: 0 }; }
  return writeB64(path, b64encode(text));
}

// 追加写（不覆盖）：同样走 base64，中文/引号/换行都不会被 shell 吃掉
export async function appendText(path, text) {
  if (DEMO) {
    const k = 'demo-file:' + path;
    localStorage.setItem(k, (localStorage.getItem(k) || '') + text);
    return { errno: 0 };
  }
  const p = absPath(path);
  const dir = p.replace(/\/[^/]*$/, '');
  const b64 = b64encode(text);
  const step = 40000;
  for (let i = 0; i < b64.length; i += step) {
    const pre = i === 0 ? `mkdir -p "${dir}" && ` : '';
    const r = await shell(`${pre}echo -n '${b64.slice(i, i + step)}' | base64 -d >> "${p}"`);
    if (r.errno !== 0) return r;
  }
  return { errno: 0 };
}

// ============================================================
// 前端日志落盘 —— run/webui.log
// ------------------------------------------------------------
// 管理器里的 WebUI 是 WebView 直接加载本地文件，JS 报错只进 logcat，
// 用户根本拿不到。这里把 window.onerror / Promise 未捕获拒绝 / console.error
// 统一收口，带时间戳与当前页面追加落盘，出问题直接把文件发出来即可定位。
//   · 队列 + 防抖：多条报错合并成一次 shell 调用，不拖慢界面；
//   · 自身写盘失败静默吞掉，绝不反向触发 console.error 造成递归；
//   · 超过 128 KB 自动截断到最后 64 KB，日志不会无限长大。
// ============================================================
export let UI_LOG = `${RUNDIR}/webui.log`;
const UI_LOG_MAX = 131072, UI_LOG_KEEP = 65536, UI_LOG_QUEUE_MAX = 200;
const rawConsole = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map(level => [level, (console[level] || console.log).bind(console)]));
let uiLogQ = [], uiLogTimer = null, uiLogBusy = false, uiLogDropped = 0, uiLogHeaded = false, uiLogFormatting = false;

const two = (n) => String(n).padStart(2, '0');
function logStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function curPageId() {
  try {
    const sec = document.querySelector('.page:not([hidden])');
    const t = document.getElementById('pageTitle');
    return (sec && sec.id ? sec.id.replace(/^page-/, '') : '?') + (t && t.textContent ? `/${t.textContent}` : '');
  } catch (e) { return '?'; }
}
// 任意值转成一行可读文本（Error 带栈；对象走 JSON；循环引用兜底 String）
function logFmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}` + (v.stack ? `\n${v.stack}` : '');
  if (v === null || v === undefined || typeof v !== 'object') return String(v);
  if (v instanceof Element) return `<${v.tagName.toLowerCase()}${v.id ? '#' + v.id : ''}>`;
  try { return logJson(v); } catch (e) { return String(v); }
}

export function uiLog(level, ...args) {
  if (uiLogFormatting) return; // 只阻止同步格式化递归，不丢弃等待磁盘写入期间的新日志
  if (uiLogQ.length >= UI_LOG_QUEUE_MAX) { uiLogDropped++; return; }
  if (!uiLogHeaded) {                                         // 每个会话开头留一行环境信息
    uiLogHeaded = true;
    uiLogQ.push(`\n===== WebUI 会话 ${logStamp()} | 模块 ${state.moduleVersion || '?'} | ${REMOTE ? '面板 HTTP' : '演示'} | UA ${navigator.userAgent} =====`);
  }
  let body;
  uiLogFormatting = true;
  try { body = redactUiLog(args.map(logFmt).join(' ')); }
  catch (_) { body = '[日志内容无法序列化]'; }
  finally { uiLogFormatting = false; }
  uiLogQ.push(`[${logStamp()}] [${String(level).toUpperCase()}] [${curPageId()}] ${body.replace(/\s+$/, '')}`);
  if (!uiLogTimer) uiLogTimer = setTimeout(flushUiLog, 2000);  // 空闲时合批，减少执行桥往返
}

// 浏览器侧留存（localStorage）：执行桥本身坏掉时，落盘必然失败——而那恰恰是最需要
// 日志的时刻。所以每条日志先进浏览器缓存，再尝试落盘；落盘成功不影响缓存，
// 「工具 → 界面日志」始终能看到、能复制、能发出来。
const UI_LOG_LS = 'mihomo-webui-log';
const UI_LOG_LS_MAX = 60000;                                  // localStorage 里最多留 60 KB
function lsAppend(text) {
  try {
    const cur = localStorage.getItem(UI_LOG_LS) || '';
    let next = cur + text;
    if (next.length > UI_LOG_LS_MAX) next = next.slice(next.length - Math.floor(UI_LOG_LS_MAX * 0.75));
    localStorage.setItem(UI_LOG_LS, next);
  } catch (e) { /* 隐私模式/配额满：忽略 */ }
}
// 界面日志（浏览器侧留存的全文）
export function uiLogBuffer() {
  let stored = '';
  try { stored = localStorage.getItem(UI_LOG_LS) || ''; } catch (e) { /* queue is still readable */ }
  return stored + (uiLogQ.length ? uiLogQ.join('\n') + '\n' : '');
}
// 落盘失败的条数：界面据此提示「日志只在浏览器里，磁盘写不进去」
let uiLogDiskFail = 0;
export function uiLogDiskFailed() { return uiLogDiskFail; }
// 落盘失败的原因也写进浏览器留存：直接 lsAppend，不进 uiLogQ、不再触发下一轮
// 冲刷，因此不会递归。同一种失败只在原因变化时记一条，不会刷爆 localStorage。
// 没有这条诊断时，「执行通道异常」只有结论没有细节 —— errno / stderr 到底是
// 什么（磁盘满？run 目录不可写？缺 base64？桥回调不完整？）全靠猜。
let uiLogFlushFailNote = '';
function noteFlushFailure(detail) {
  if (detail === uiLogFlushFailNote) return;
  uiLogFlushFailNote = detail;
  try { lsAppend(`[${logStamp()}] [WARN] [-] 界面日志落盘失败：${redactUiLog(String(detail)).replace(/\s+$/, '')}\n`); }
  catch (_) { /* localStorage 不可用：忽略，磁盘失败计数仍有效 */ }
}

async function flushUiLog(force = false) {
  uiLogTimer = null;
  if (uiLogBusy || !uiLogQ.length) return;
  if (!force && (isBackgroundWorkPaused() || isInteracting() || document.hidden)) {
    uiLogTimer = setTimeout(flushUiLog, 1000);
    return;
  }
  uiLogBusy = true;
  try {
    const lines = uiLogQ.splice(0, uiLogQ.length);
    if (uiLogDropped) { lines.push(`[${logStamp()}] [WARN] [-] 日志过多，已丢弃 ${uiLogDropped} 条`); uiLogDropped = 0; }
    const text = lines.join('\n') + '\n';
    lsAppend(text);                                           // 先进浏览器缓存，永远拿得到
    if (DEMO) return;
    const trim = `sz=$(wc -c < "${UI_LOG}" 2>/dev/null || echo 0); if [ "$sz" -gt ${UI_LOG_MAX} ]; then tail -c ${UI_LOG_KEEP} "${UI_LOG}" > "${UI_LOG}.tmp" 2>/dev/null && mv "${UI_LOG}.tmp" "${UI_LOG}"; fi; :`;
    const encoded = b64encode(text);
    let result;
    if (encoded.length <= 40000) {
      // Typical batches append and enforce the size cap in ONE bridge call.
      result = await shell(`mkdir -p "${RUNDIR}" && printf '%s' '${encoded}' | base64 -d >> "${UI_LOG}" && { ${trim}; }`);
    } else {
      result = await appendText(UI_LOG, text); // preserve bounded bridge payloads for large diagnostics
      if (result?.errno === 0) await shell(trim);
    }
    if (!result || result.errno !== 0) {
      uiLogDiskFail += lines.length;
      noteFlushFailure(result
        ? `errno=${result.errno} stderr=${String(result.stderr || '').trim().slice(0, 200)}`
        : '执行桥未返回结果（回调丢失或超时）');
    }
  } catch (e) {
    uiLogDiskFail++;
    noteFlushFailure((e && e.message) ? String(e.message) : '执行桥抛出异常');
    /* 日志落盘失败：静默，绝不影响界面 */
  } finally {
    uiLogBusy = false;
    if (uiLogQ.length && !uiLogTimer) uiLogTimer = setTimeout(flushUiLog, 2000);
  }
}

// 立即冲刷（界面要读日志前调用，保证队列里的内容已经进缓存/落盘）
export async function flushUiLogNow() {
  if (uiLogTimer) { clearTimeout(uiLogTimer); uiLogTimer = null; }
  await flushUiLog(true);
}

// 清空日志（磁盘 + 浏览器缓存）
export async function clearUiLog() {
  uiLogQ = []; uiLogHeaded = false; uiLogDiskFail = 0; uiLogFlushFailNote = '';
  try { localStorage.removeItem(UI_LOG_LS); } catch (e) { /* ignore */ }
  if (DEMO) { localStorage.removeItem('demo-file:' + UI_LOG); return { errno: 0 }; }
  return shell(`: > "${UI_LOG}" 2>/dev/null; :`);
}

function installUiLogHooks() {
  if (typeof window === 'undefined' || window.__uiLogHooked) return;
  window.__uiLogHooked = true;

  // 1) 脚本运行时错误
  window.addEventListener('error', (ev) => {
    if (ev && ev.target && ev.target !== window && ev.target.tagName) {
      // 2) 资源加载失败（<script> / <link> / <img>）—— 冒泡阶段收不到，靠捕获
      // 应用图标有首字母块兜底（组件没读到图标 / 图解不出来），属于预期内降级：
      // 逐张写 ERROR 会把真实故障淹在噪声里（见 fields.js 的 iconNode）。
      if (ev.target.dataset && ev.target.dataset.iconTile) return;
      uiLog('error', `资源加载失败 <${ev.target.tagName.toLowerCase()}>`, ev.target.src || ev.target.href || '');
      return;
    }
    const src = ev.filename ? `${String(ev.filename).replace(/^.*\//, '')}:${ev.lineno}:${ev.colno}` : '';
    uiLog('error', `未捕获异常 ${src}`, ev.error || ev.message);
  }, true);

  // 3) Promise 未捕获拒绝
  window.addEventListener('unhandledrejection', (ev) => {
    uiLog('error', '未处理的 Promise 拒绝', ev && ev.reason !== undefined ? ev.reason : '(无 reason)');
  });

  // 4) 记录所有常用 console 级别；保留原控制台输出与接收者绑定。
  for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    console[level] = (...args) => { rawConsole[level](...args); uiLog(level === 'log' ? 'info' : level, ...args); };
  }

  // 5) 离开页面时把队列冲干净
  window.addEventListener('pagehide', () => { if (uiLogQ.length) flushUiLog(true); });
}
installUiLogHooks();

// 宽容解析命令输出中的 JSON。
// 不同管理器（KernelSU / KernelSU Next / APatch / MMRL…）的执行桥行为不一致：有的把 stderr
// 并进 stdout；更阴险的是 shell 变量里混进了控制字符——实测某些 ROM 的 `ps -o etime=` 会先
// 输出一个空行，于是 "uptime": "<换行>00:11" 让整份状态 JSON 非法，界面显示「无法获取模块
// 状态」，可模块其实运行正常。脚本侧已经堵住源头，这里再兜一层：截取 + 修复后再解析。
let _jsonRepair = '';
export function lastJsonRepair() { return _jsonRepair; }

// 把字符串字面量内部的裸控制字符转义（JSON 规范不允许，但 shell 拼出来的经常有）。
// 字符串外部的换行/制表符本就是合法空白，不用动。
function repairCtlChars(t) {
  let out = '', inStr = false, esc = false, fixed = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { out += c; esc = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        fixed++;
        out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t'
             : '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
  }
  return { text: out, fixed };
}

export function parseJsonLoose(text) {
  _jsonRepair = '';
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;

  // 候选片段：① 原文 ② 首个 { 到末个 } ③ 从首个 { 起括号配对出的第一段完整对象 ④ 数组
  const cands = [t];
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) {
    if (i !== 0 || j !== t.length - 1) cands.push(t.slice(i, j + 1));
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k <= j; k++) {
      const c = t[k];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { cands.push(t.slice(i, k + 1)); break; }
    }
  }
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) cands.push(t.slice(a, b + 1));

  for (const c of cands) {
    try { return JSON.parse(c); } catch (e) { /* 试下一步 */ }
    const rep = repairCtlChars(c);                    // 再给一次机会：修掉字符串里的裸控制字符
    if (rep.fixed) {
      try {
        const v = JSON.parse(rep.text);
        _jsonRepair = `已自动修复 ${rep.fixed} 处字符串内非法控制字符`;
        return v;
      } catch (e) { /* 试下一步 */ }
    }
  }
  return null;
}

// 把一次命令执行的结果压成一行诊断文本（errno / stderr / stdout 摘要），日志与界面共用
export function execBrief(cmd, r, max = 400) {
  const cut = (s) => { const t = String(s || '').replace(/\s+$/, ''); return t.length > max ? t.slice(0, max) + `…(${t.length}B)` : t; };
  return `cmd=${cmd} errno=${r ? r.errno : 'n/a'} stderr=${JSON.stringify(cut(r && r.stderr))} stdout=${JSON.stringify(cut(r && r.stdout))}`;
}

export function ntoast(msg, ms = 2200) {
  // R27：不再经 root 管理器发系统通知（ksu.toast——用户在系统通知栏看到的
  // 「✅ …已加入待保存」正是这条路径）。应用内反馈统一走页面内 Toast。
  uiToast(msg, ms);
}

// UI 内 Toast（仿 MIUI）
let toastTimer = null;
export function uiToast(msg, ms = 2200) {
  // 捕获后已被 UI 消化的错误也需要记录，而非只依赖 unhandledrejection。
  const level = /失败|错误|异常|未确认|被拒绝/.test(String(msg)) ? 'error'
    : /请先|未运行|未保存|稍后|警告/.test(String(msg)) ? 'warn' : 'info';
  uiLog(level, '界面提示', msg);
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------------- 统一文本输入与首次点按 ----------------
const TEXT_INPUT_TYPES = /^(text|search|url|tel|email|password|number)$/i;
export function isEditableTextInput(el) {
  if (!el || (el.tagName !== 'TEXTAREA' && !(el.tagName === 'INPUT' && TEXT_INPUT_TYPES.test(el.type || 'text')))) return false;
  if (el.readOnly || el.disabled || el.isConnected === false || String(el.inputMode || el.getAttribute?.('inputmode') || '').toLowerCase() === 'none') return false;
  if (el.closest?.('[hidden], [inert]') || el.matches?.(':disabled')) return false;
  return true;
}
// focus 必须在当前点击/触摸回调内执行，且元素始终可编辑。不能先 readonly 聚焦、
// 等定时器解锁：那样首触只完成了只读聚焦，真正的编辑请求离开了用户手势。
// 只负责聚焦，不改 value / 选区、不 blur、不重建 DOM；光标由原生点按确定。
export function focusTextInput(el, { reveal = false } = {}) {
  if (!isEditableTextInput(el)) return false;
  const scrolls = [];
  const x = window.scrollX || window.pageXOffset || 0, y = window.scrollY || window.pageYOffset || 0;
  if (!reveal) for (let n = el; n && n.nodeType === 1; n = n.parentElement) scrolls.push([n, n.scrollLeft || 0, n.scrollTop || 0]);
  try {
    try { el.focus({ preventScroll: !reveal }); } catch (_) { el.focus(); }
  } finally {
    // 旧 WebView 可能忽略 preventScroll；同步恢复，不能延迟盖掉用户后续滚动/选区。
    // 含 textarea 自己的内层滚动，不让它因旧光标位置突然跳到文件末尾。
    if (!reveal) {
      for (const [n, left, top] of scrolls) { if (n.scrollLeft !== left) n.scrollLeft = left; if (n.scrollTop !== top) n.scrollTop = top; }
      if ((window.scrollX || window.pageXOffset || 0) !== x || (window.scrollY || window.pageYOffset || 0) !== y) window.scrollTo?.(x, y);
    }
  }
  return document.activeElement === el;
}
let textInputHandlingInstalled = false;
export function installTextInputHandling() {
  if (textInputHandlingInstalled) return;
  textInputHandlingInstalled = true;
  const android = () => /android/i.test(navigator.userAgent || '');
  const usePointer = typeof window.PointerEvent === 'function';
  let gesture = null, nextClick = null;
  const point = e => usePointer ? e : ((e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]));
  const eventTime = e => typeof e.timeStamp === 'number' ? e.timeStamp : Date.now();
  const multiple = e => usePointer ? e.isPrimary === false : !!(e.touches && e.touches.length > 1);
  const id = p => usePointer ? p.pointerId : p.identifier;
  const begin = e => {
    if (!android()) return;
    if (gesture && multiple(e)) { gesture.cancelled = true; return; }
    nextClick = null;
    const el = e.target, p = point(e);
    if (!isEditableTextInput(el) || !p || (usePointer && e.button !== 0)) { gesture = null; return; }
    gesture = { el, id: id(p), x: p.clientX, y: p.clientY, time: eventTime(e), cancelled: multiple(e) };
  };
  const move = e => {
    if (!gesture) return;
    const p = point(e);
    if (!p || id(p) !== gesture.id || multiple(e) || Math.abs(p.clientX - gesture.x) > 8 || Math.abs(p.clientY - gesture.y) > 8) gesture.cancelled = true;
  };
  const end = e => {
    if (!android() || !gesture) return;
    const g = gesture, p = point(e); gesture = null;
    // 同一次 pointerup/touchend 后的兼容 click 不重复聚焦；滑动/长按的 click 也不补刀。
    nextClick = { el: g.el, at: Date.now() };
    if (!p || id(p) !== g.id || e.target !== g.el || g.cancelled || multiple(e)
      || Math.abs(p.clientX - g.x) > 8 || Math.abs(p.clientY - g.y) > 8 || eventTime(e) - g.time > 550) return;
    focusTextInput(g.el);
  };
  const cancel = e => { nextClick = { el: gesture ? gesture.el : e.target, at: Date.now() }; gesture = null; };
  const passive = { capture: true, passive: true };
  // 不 preventDefault：保留首次点击的原生定位、源码框内滚动、长按选词和系统输入法链。
  document.addEventListener(usePointer ? 'pointerdown' : 'touchstart', begin, passive);
  document.addEventListener(usePointer ? 'pointermove' : 'touchmove', move, passive);
  document.addEventListener(usePointer ? 'pointerup' : 'touchend', end, passive);
  document.addEventListener(usePointer ? 'pointercancel' : 'touchcancel', cancel, passive);
  document.addEventListener('click', e => {
    if (!android() || !isEditableTextInput(e.target)) return;
    if (nextClick && nextClick.el === e.target && Date.now() - nextClick.at < 800) { nextClick = null; return; }
    gesture = null; nextClick = null;
    focusTextInput(e.target);  // 无 touch/pointer 的兼容或无障碍点击也走同一同步入口
  }, true);
}

// ---------------- 文本域高度随内容自适应 ----------------
// 统一规则：所有经 h() 创建的 textarea（显式标 data-no-autogrow 的除外：源码大编辑器
// 是固定视口 + 行号跟随的设计，剪贴板中转框不参与排版），高度默认与单行输入框同高
// （下限见 style.css 的 textarea.autogrow min-height ≈ 39px），内容变多自动长高，
// 不再按固定 rows 预留一大片空白。
// 触发时机统一收口，调用方不需要关心：重写实例的 value 属性（外部 area.value = …
// 也计入）+ input 事件；量高前先把高度归 auto。弹层里「先建后显示」的框（文本模式
// 处于 display:none 子树）量不出高度，用低频定时重试，可见的那帧自动补量。
export function textareaAutoGrow(ta) {
  if (ta._autogrow) return;
  ta._autogrow = true;
  ta.classList.add('autogrow');
  ta.rows = 1;   // height:auto 的兜底高度改为单行；真实高度一律由 fit() 内联给定
  let timer = 0;
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  // fit() 内部临时换入占位文本量高，必须走原生 setter：若走下面的实例 setter，
  // 每次赋值都会 queue() 出下一轮 fit；而「空框 + 有 placeholder」量完又恢复为空，
  // 下一轮再次命中同一分支 —— 形成 setTimeout(0) 的无限自激递归（实测每个空文本域
  // ≈450 次/秒的强制重排 + 样式失效），长表单弹层（新建入站/出站等，底部必有带占位
  // 示例的空 YAML 兜底框）一开就把主线程打满，滑动到底部时掉帧、钳位帧错拍 → 画面跳动。
  const rawSetValue = (x) => { if (desc && desc.set) desc.set.call(ta, x); else ta.value = x; };
  const fit = () => {
    timer = 0;
    if (!ta.isConnected) return;
    if (!ta.clientHeight) { timer = setTimeout(fit, 150); return; }   // 尚不可见：等可见再量
    const v = ta.value;
    const swapped = !v && !!ta.placeholder;
    if (swapped) rawSetValue(ta.placeholder);   // 空框按占位示例量高（多为多行格式示例）
    ta.style.height = 'auto';
    const sh = ta.scrollHeight;
    if (swapped) rawSetValue(v);
    if (ta.style.height !== sh + 'px') ta.style.height = sh + 'px';   // 高度没变就不写，避免无谓失效
  };
  const queue = () => { if (!timer) timer = setTimeout(fit, 0); };
  if (desc && desc.get && desc.set) {
    Object.defineProperty(ta, 'value', {
      configurable: true, enumerable: desc.enumerable,
      get: () => desc.get.call(ta),
      set: x => { desc.set.call(ta, x); queue(); },
    });
  }
  ta.addEventListener('input', queue);
  queue();
}

// ---------------- DOM 构建工具 ----------------
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  // 所有文本/数字/密码输入共用属性与手势入口，保留 type / inputmode 的原生键盘类型。
  // 调用方显式属性优先；只读、禁用以及日期/文件/开关等原生控件不强制唤键。
  if (tag === 'textarea' || (tag === 'input' && TEXT_INPUT_TYPES.test(attrs.type || 'text'))) {
    attrs = { spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', ...attrs };
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    // HTML 布尔属性按「是否存在」判真；setAttribute('readonly', false) 仍然只读。
    // h() 允许小写 DOM 属性名，但必须映射到真正的布尔 property。
    else if (k === 'readonly') el.readOnly = !!v;
    else if (k.startsWith('on') && typeof v === 'function') {
      // 部分 WebView 点击按钮时尚未派发输入框 change/blur；确认前在同一入口收齐末次输入。
      // 只派发 change，不 blur、不重建控件，系统输入法/焦点仍沿用 document 级统一处理。
      el.addEventListener(k.slice(2), k === 'onclick' && tag === 'button'
        ? ev => { flushActiveConfigInput(); v.call(el, ev); } : v);
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
    else el.setAttribute(k, v);
  }
  // 文本域高度统一随内容自适应；不想参与排版的（源码大编辑器/剪贴板中转）显式标 data-no-autogrow
  if (tag === 'textarea' && !el.hasAttribute('data-no-autogrow')) textareaAutoGrow(el);

  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return el;
}

export function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }

// 「用户正在交互」标记：滚动 / 拖动排序 / 长按期间，周期任务（状态心跳、日志刷新）
// 必须全部让位——它们在后台发请求 + 触发布局，正是「每隔几秒规律性顿一下」的直接来源。
// 拖动中每次 move 续期，松手再宽限一段，避免尾帧撞上下一轮轮询。
let _interactUntil = 0;
let backgroundWorkPaused = false;
// A cross-origin panel does not send its input events to the parent document.
// Use an explicit lifecycle signal rather than relying on the last parent tap.
export function setBackgroundWorkPaused(paused) { backgroundWorkPaused = !!paused; }
export function isBackgroundWorkPaused() { return backgroundWorkPaused; }
export function noteInteraction(ms = 400) { const t = Date.now() + ms; if (t > _interactUntil) _interactUntil = t; }
export function isInteracting() { return Date.now() < _interactUntil; }
// All gestures, not just drag-sort, reserve an idle window for background tasks.
// Passive capture never prevents defaults, changes focus, or delays the clicked action.
const interactionEvents = typeof window.PointerEvent === 'function'
  ? ['pointerdown', 'pointerup', 'pointercancel', 'keydown', 'input']
  : ['touchstart', 'touchend', 'touchcancel', 'mousedown', 'mouseup', 'keydown', 'input'];
for (const type of interactionEvents) document.addEventListener(type, () => noteInteraction(1000), { capture: true, passive: true });


// 按钮点开文件选择器：click 回调里同步弹系统选择页，会把「按下回馈」挤没——
// 选择页先出来、按钮回馈后出来（WebView 在 Activity 切换前不完成这一帧绘制）。
// 这里给按钮挂 .picking（与 :active 同款缩放+压暗），等两帧 + 90ms 让按下动作
// 真正画出来并进帧，再唤起选择页。按住时长 ≪ 浏览器用户手势有效期（~5s），
// input.click() 的授权不受影响。
export function pickFileWithFeedback(input, btn) {
  if (!input || input._picking) return;             // 连点吞掉：避免重复拉起选择页
  input._picking = true;
  const go = () => {
    input._picking = false;
    if (btn) btn.classList.remove('picking');
    input.click();
  };
  if (btn) btn.classList.add('picking');
  if (typeof requestAnimationFrame !== 'function') { go(); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(go, 90)));
}

// ---------------- 路径读写 ----------------
export function get(obj, path) {
  if (!obj) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function set(obj, path, value) {
  const live = isConfigTarget(obj);
  if (live && !canEditConfig()) return false;
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  const ok = markDirty(obj);
  if (!live || !ok) return ok;
  try {
    const CE = (typeof window !== 'undefined' && window.CustomEvent) ? window.CustomEvent : CustomEvent;
    if(typeof document !== 'undefined' && document.dispatchEvent) document.dispatchEvent(new CE('cfg-change', {detail:{path, value}}));
  } catch(e){}
  return ok;
}
export function unset(obj, path) {
  const live = isConfigTarget(obj);
  if (live && !canEditConfig()) return false;
  const keys = path.split('.');
  let cur = obj;
  const chain = [obj];
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) return;
    cur = cur[keys[i]];
    chain.push(cur);
  }
  if (!Object.prototype.hasOwnProperty.call(cur, keys[keys.length - 1])) return true;
  delete cur[keys[keys.length - 1]];
  // 清理空父级
  for (let i = chain.length - 1; i > 0; i--) {
    const node = chain[i];
    if (node && typeof node === 'object' && !Array.isArray(node) && Object.keys(node).length === 0) {
      const parent = chain[i - 1];
      for (const k of Object.keys(parent)) if (parent[k] === node) delete parent[k];
    }
  }
  const ok = markDirty(obj);
  if (!live || !ok) return ok;
  try {
    const CE = (typeof window !== 'undefined' && window.CustomEvent) ? window.CustomEvent : CustomEvent;
    if(typeof document !== 'undefined' && document.dispatchEvent) document.dispatchEvent(new CE('cfg-change', {detail:{path}}));
  } catch(e){}
  return ok;
}

// 内容代数：凡「页面可能因此过时」的写操作（脏标记翻转、保存后回读、状态变化）都自增。
// 切页落地时用它判定目标页能否直接复用已渲染 DOM，跳过整页重渲染（快速来回切页的卡顿主源）。
export function bumpUiRev() { try { window.__uiRev = (window.__uiRev | 0) + 1; } catch (e) { } }
export function uiRev() { try { return window.__uiRev | 0; } catch (e) { return 0; } }

// 就地重绘保滚动：列表页编辑/删除后习惯直接 render(el) 全量重绘——el.innerHTML=''
// 那一瞬内容高度塌成 0，浏览器把 scrollY 钳回顶；离开页面时「上次位置」记下的就是 0，
// 滚动记忆看似失灵。包装器在重绘后同帧+下一帧各补一次回位，调用方无感。
export function renderKeepScroll(fn) {
  let y = 0;
  try { y = window.scrollY || window.pageYOffset || 0; } catch (e) {}
  try { return fn(); } finally {
    try {
      const apply = () => { if ((window.scrollY || window.pageYOffset || 0) !== y) window.scrollTo(0, y); };
      apply();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
    } catch (e) {}
  }
}
// ---------------- 统一配置草稿 ----------------
// 所有入口只有两种提交：模型修改 → markDirty/commitConfigEdit；源码修改 → applyConfigDraft。
// 两者都当场同步 raw/cfg、刷新订阅视图、显示未保存栏；只有 saveConfig 能写 config.yaml。
let flushingConfigInput = false;
function flushActiveConfigInput() {
  if (flushingConfigInput) return;
  const el = document.activeElement;
  if (!el || el.disabled || typeof el.dispatchEvent !== 'function' || typeof window.Event !== 'function'
    || (el.tagName !== 'TEXTAREA' && !(el.tagName === 'INPUT'
    && !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden'].includes(el.type)))) return;
  flushingConfigInput = true;
  try { el.dispatchEvent(new window.Event('change', { bubbles: true })); }
  finally { flushingConfigInput = false; }
}
const draftListeners = new Set();
let draftVersion = 0;
let validDraftRaw = '';
let sourcePending = false, sourceTimer = null;
let draftLayer = 'surgical', draftDebug = null;

export function onConfigDraftChange(fn) {
  draftListeners.add(fn);
  return () => draftListeners.delete(fn);
}
// 内核配置生效通知：保存后重启 / 热重载 / 服务重启成功时触发。订阅方（如代理页）
// 据此丢弃按旧配置缓存的运行时数据。注意这不是草稿变更——草稿只改 state.cfg，
// 内核侧数据要等重启/重载真正成功后才变化，所以只有这三个生效点能 emit。
const coreAppliedListeners = new Set();
export function onCoreConfigApplied(fn) {
  coreAppliedListeners.add(fn);
  return () => coreAppliedListeners.delete(fn);
}
export function emitCoreConfigApplied() {
  for (const fn of [...coreAppliedListeners]) {
    try { fn(); } catch (e) { console.warn('内核配置生效通知失败', e); }
  }
}
function notifyConfigDraft() {
  draftVersion++;
  bumpUiRev();
  renderSaveBar();
  for (const fn of [...draftListeners]) {
    try { fn(); } catch (e) { console.warn('配置视图同步失败', e); }
  }
}
// 弹层里的 deepClone 是局部编辑稿，尚未点「加入待保存」不得污染全局草稿/脏标记。
function isConfigTarget(target) {
  if (target === state.cfg) return true;
  if (!target || typeof target !== 'object') return false;
  const seen = new WeakSet();
  const visit = x => {
    if (x === target) return true;
    if (!x || typeof x !== 'object' || seen.has(x)) return false;
    seen.add(x);
    return Object.values(x).some(visit);
  };
  return visit(state.cfg);
}
// 保留已有控件闭包持有的对象/数组身份，避免同步源码后第二次编辑写进失联旧对象；
// 同时按新解析结果重建别名共享关系（含环），不能把已经解除的 *引用重新绑回去。
function reconcileDraft(dst, src, seen = new WeakMap(), used = new WeakSet()) {
  if (!src || typeof src !== 'object' || src instanceof Date) return src;
  if (seen.has(src)) return seen.get(src);
  const reusable = dst && typeof dst === 'object' && !(dst instanceof Date)
    && Array.isArray(dst) === Array.isArray(src) && !used.has(dst);
  const out = reusable ? dst : (Array.isArray(src) ? [] : {});
  seen.set(src, out); used.add(out);
  for (const k of Object.keys(out)) if (!Object.prototype.hasOwnProperty.call(src, k)) delete out[k];
  for (const k of Object.keys(src)) {
    const value = reconcileDraft(out[k], src[k], seen, used);
    Object.defineProperty(out, k, { value, enumerable: true, configurable: true, writable: true });
  }
  if (Array.isArray(src)) out.length = src.length;
  else {
    const wanted = Object.keys(src), have = Object.keys(out);
    if (wanted.some((k, i) => k !== have[i])) {
      const desc = Object.getOwnPropertyDescriptors(out);
      have.forEach(k => { delete out[k]; });
      wanted.forEach(k => Object.defineProperty(out, k, desc[k]));
    }
  }
  return out;
}
function cancelSourceDraft() {
  clearTimeout(sourceTimer); sourceTimer = null; sourcePending = false;
}
function publishDraft(text, obj, error = null, force = false) {
  const changed = text !== state.raw || error !== state.cfgError;
  if (obj && obj !== state.cfg) state.cfg = reconcileDraft(state.cfg, obj);
  state.raw = text; state.cfgError = error;
  state.anchorOps.length = 0;
  if (!error) validDraftRaw = text;
  if (changed || force) { state.dirty = true; notifyConfigDraft(); }
  return !error;
}
export function applyConfigDraft(text, { allowInvalid = false, quiet = false } = {}) {
  const force = sourcePending;
  text = String(text);
  const { obj, err } = parseConfigText(text);
  if (err && !allowInvalid) {
    // 点源码保存会提前结束防抖：即使拒绝保存，也必须标记这份已记录的错误草稿，
    // 否则 pending 被清掉、cfgError 仍是空，下一次顶部保存会把旧模型覆盖回去。
    if (text === state.raw) { cancelSourceDraft(); publishDraft(text, null, err, force); }
    // 被拒绝的是另一份导入/恢复文本：保留当前文本及其尚未完成的校验，不污染草稿。
    if (!quiet) uiToast('未应用：' + err, 4200);
    return false;
  }
  cancelSourceDraft();
  // 非法手写源码也保留为草稿，但禁止落盘；面板保留上次合法模型，修复后再同步。
  return publishDraft(text, obj, err || null, force);
}
// 输入途中只记录文本和脏标记，整份 YAML 校验合并到 160ms；change/blur/保存会同步 flush，
// 不重建 textarea、不抢焦点，也不会在快速输入后立刻点保存时漏掉末尾字符。
export function editConfigSource(text) {
  text = String(text);
  if (text === state.raw && !sourcePending) return;
  clearTimeout(sourceTimer);
  state.raw = text; state.dirty = true; sourcePending = true;
  bumpUiRev(); renderSaveBar();
  sourceTimer = setTimeout(() => flushConfigSource(), 160);
}
export function flushConfigSource() {
  if (sourcePending) return applyConfigDraft(state.raw, { allowInvalid: true, quiet: true });
  return !state.cfgError;
}
function canEditConfig() {
  if (flushConfigSource()) return true;
  uiToast('源码尚有 YAML 错误，请先修复源码或放弃更改', 3600);
  return false;
}
function buildConfigDraft(cfg, ops) {
  normalizeHeaderSlices(cfg);
  for (const op of ops) {
    if (op && op.kind === 'newtop' && op.key && op.value && typeof op.value === 'object' && !Array.isArray(op.value)) {
      cfg[op.key] = deepClone(op.value);
    }
  }
  let text = dumpConfigKeepLayout(cfg, state.raw);
  const layer = lastSaveLayer, debug = lastPatchDebug;
  let notes = [];
  if (ops.length) {
    const r = applyAnchorOps(text, ops);
    notes = r.notes || [];
    // 合法的保守删除（键被按名使用/多定义）当场摘 &名并提示，不能因有 note 又退回队列。
    // 其它「未定位/跳过/引用不合法」一律拒收整次提交，不伪装成成功或留到保存时偷做。
    const safeDropNote = n => /已保留块体、仅移除 &|有多处顶层定义，仅移除 &/.test(n);
    if (r.text == null || notes.some(n => !safeDropNote(n))) throw new Error(notes.join('；') || '锚点操作失败');
    text = r.text;
  }
  const back = jsyaml.load(text);
  if (back == null) {
    // 删掉最后一个键后 YAML 是空文档；显示合法的空映射，不把成功删除变成校验失败。
    text = text.replace(/\n*$/, '') + (text.trim() ? '\n' : '') + '{}' + (/\n$/.test(state.raw) ? '\n' : '');
    cfg = {};
  } else if (Object.prototype.toString.call(back) !== '[object Object]') {
    throw new Error('配置顶层必须是 YAML 键值映射');
  } else if (ops.length) cfg = back;
  return { text, cfg, notes, layer, debug };
}
function acceptBuiltDraft(r) {
  const changed = r.text !== state.raw;
  if (changed && r.layer !== 'surgical' && (draftLayer !== 'full' || r.layer === 'full')) {
    draftLayer = r.layer; draftDebug = r.debug;
  }
  publishDraft(r.text, r.cfg);
  if (r.notes.length) uiToast('⚠️ ' + r.notes.join('；'), 5000);
  return true;
}
// 带锚点的整条编辑以事务提交：字段、改名级联、继承/*引用要么一起可见，要么原样保留。
export function commitConfigEdit(mutate, ops = []) {
  if (!canEditConfig()) return false;
  try {
    const cfg = deepClone(state.cfg);
    if (mutate && mutate(cfg) === false) return false;
    return acceptBuiltDraft(buildConfigDraft(cfg, ops));
  } catch (e) { uiToast('未应用：' + ((e && e.message) || e), 4200); return false; }
}
// 新建出站统一为每个节点一行；仅格式化本次追加的节点，不重排已有块式节点。
function formatNewOutboundFlow(text, cfg, start) {
  const tree = buildYamlTree(text);
  const seq = tree?.root.children.get('proxies');
  if (!seq || seq.kind !== 'seq' || seq.children.length !== cfg.proxies.length) throw new Error('无法安全定位新增节点，未修改草稿');
  const lines = tree.lines.slice();
  const previous = buildYamlTree(state.raw);
  const oldSeq = previous?.root.children.get('proxies');
  const flow = value => {
    const result = jsyaml.dump(value, { lineWidth: -1, noRefs: true, sortKeys: false, flowLevel: 0 }).replace(/\n+$/, '');
    if (result.includes('\n') || !result.startsWith('{')) throw new Error('节点无法序列化为单行流式');
    return result;
  };
  if (seq.childIndent < 0) {
    // 原 proxies: [] / [...] 容器展开成块序列；已有流式节点的原文、锚点和别名保留。
    if (seq.flowStartCol == null || seq.flowEndCol == null) throw new Error('无法安全定位 proxies 流式容器');
    const header = lines[seq.line].slice(0, seq.flowStartCol).trimEnd()
      + lines[seq.end].slice(seq.flowEndCol + 1);
    const items = seq.children.map((child, i) => {
      const value = i < start ? (oldSeq?.children?.[i]?.rawVal || child.rawVal) : flow(cfg.proxies[i]);
      if (!value) throw new Error('无法保留已有节点原文');
      return ' '.repeat(seq.indent + 2) + '- ' + value;
    });
    lines.splice(seq.line, seq.end - seq.line + 1, header, ...items);
  } else {
    for (let i = seq.children.length - 1; i >= 0; i--) {
      const original = i < start && oldSeq?.childIndent < 0 ? oldSeq.children?.[i]?.rawVal : null;
      if (i < start && !original) continue;
      const node = seq.children[i];
      lines.splice(node.line, node.end - node.line + 1, ' '.repeat(node.indent) + '- ' + (original || flow(cfg.proxies[i])));
    }
  }
  if (oldSeq?.anchorName && !seq.anchorName) lines[seq.line] = lines[seq.line].replace(/:(?=\s|$)/, ': &' + oldSeq.anchorName);
  if (oldSeq?.flowEndCol != null) {
    const comment = previous.lines[oldSeq.end].slice(oldSeq.flowEndCol + 1).trim();
    if (comment.startsWith('#') && !lines[seq.line].includes(comment)) lines[seq.line] = lines[seq.line].trimEnd() + ' ' + comment;
  }
  const formatted = lines.join('\n');
  if (!yamlEq(jsyaml.load(formatted), cfg)) throw new Error('单行格式转换校验失败，未修改草稿');
  return formatted;
}
export function commitNewOutboundProxies(nodes) {
  if (!Array.isArray(nodes) || !nodes.length || !canEditConfig()) return false;
  try {
    const originalTree = buildYamlTree(state.raw);
    const originalSeq = originalTree?.root.children.get('proxies');
    if (originalSeq?.anchorName && originalTree.aliasUsers.some(ref => ref.name === originalSeq.anchorName)) throw new Error('proxies 整个列表被 YAML 别名共用，请先解除该列表引用，再新增节点');
    const cfg = deepClone(state.cfg);
    if (cfg.proxies != null && !Array.isArray(cfg.proxies)) throw new Error('proxies 不是数组，请先修正配置');
    const list = cfg.proxies || [];
    const start = list.length, names = new Set(list.map(p => p?.name));
    for (const node of nodes) {
      if (!node || typeof node.name !== 'string' || !node.name.trim() || names.has(node.name)) throw new Error('节点名称为空或已存在同名节点，请重新检查');
      names.add(node.name);
    }
    cfg.proxies = [...list, ...deepClone(nodes)];
    const draft = buildConfigDraft(cfg, []);
    draft.text = formatNewOutboundFlow(draft.text, draft.cfg, start);
    return acceptBuiltDraft(draft);
  } catch (e) { uiToast('添加未应用：' + (e?.message || String(e)), 4200);return false; }
}

export function markDirty(target = state.cfg) {
  if (!isConfigTarget(target)) return true;
  const rollback = () => {
    const p = parseConfigText(state.cfgError ? validDraftRaw : state.raw);
    if (p.obj) state.cfg = reconcileDraft(state.cfg, p.obj);
  };
  if (!canEditConfig()) { rollback(); return false; }
  const ops = state.anchorOps.splice(0);    // 兼容旧入口，但必须现在应用，保存不再暗中做手术
  try { return acceptBuiltDraft(buildConfigDraft(state.cfg, ops)); }
  catch (e) { rollback(); uiToast('未应用：' + ((e && e.message) || e), 4200); return false; }
}
// 映射排序不是值修改，普通 YAML 语义 diff 会视为「无变化」。排序入口统一做块搬移，
// 仍经 applyConfigDraft 校验/发布，不引入隐藏队列或保存时才执行的操作。
export function reorderConfigMap(target, path, keys) {
  const map = get(target, path);
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  const old = Object.keys(map);
  if (keys.length !== old.length || new Set(keys).size !== old.length || keys.some(k => !old.includes(k))) {
    uiToast('排序未应用：条目已变化，请重新操作', 3200); return false;
  }
  if (keys.every((k, i) => k === old[i])) return true;
  const requested = Object.keys(Object.fromEntries(keys.map(k => [k, null])));
  if (keys.some((k, i) => requested[i] !== k)) {
    uiToast('排序未应用：纯数字键使用固定数字顺序，请改用非纯数字名称', 3800); return false;
  }
  if (!isConfigTarget(target)) {
    const sorted = {};
    keys.forEach(k => Object.defineProperty(sorted, k, { value: map[k], enumerable: true, configurable: true, writable: true }));
    return set(target, path, sorted);
  }
  if (!canEditConfig()) return false;
  try {
    const seen = new WeakSet();
    const find = (x, p) => {
      if (x === target) return p;
      if (!x || typeof x !== 'object' || seen.has(x)) return null;
      seen.add(x);
      for (const k of Object.keys(x)) { const r = find(x[k], p.concat(Array.isArray(x) ? Number(k) : k)); if (r) return r; }
      return null;
    };
    const prefix = find(state.cfg, []);
    const fullPath = prefix && prefix.concat(path.split('.'));
    const tree = buildYamlTree(state.raw);
    const resolved = tree && fullPath && resolvePath(tree, fullPath, true);
    const node = resolved && resolved.node;
    if (!node || node.kind !== 'map' || node.inFlow || node.merges.length
      || keys.length !== node.children.size || keys.some(k => !node.children.has(k))) {
      throw new Error('该映射含继承或复杂结构，无法无损排序，请在源码中调整');
    }
    const children = [...node.children.values()];
    const lines = tree.lines.slice();
    if (children.every(c => c.inFlow)) {
      if (node.flowStartCol == null || node.flowEndCol == null) throw new Error('未能定位流式映射');
      if (node.line !== node.end && lines.slice(node.line, node.end + 1).some(l => /(^|\s)#/.test(l))) {
        throw new Error('跨行流式映射含注释，请在源码中排序以保留注释');
      }
      const body = keys.map(k => {
        const c = node.children.get(k);
        if (c.rawVal == null) throw new Error('未能定位条目「' + k + '」的原始值');
        return c.rawKey + ': ' + c.rawVal;
      }).join(', ');
      const head = lines[node.line].slice(0, node.flowStartCol);
      const tail = lines[node.end].slice(node.flowEndCol + 1);
      lines.splice(node.line, node.end - node.line + 1, head + '{' + body + '}' + tail);
    } else {
      if (children.some(c => c.inFlow || c.inlineSeq)) throw new Error('条目不是独立文本块，无法无损排序');
      // 段前同级注释/空行随条目移动；不吞其它块或文件头说明。
      const starts = children.map((c, i) => {
        let start = c.line;
        const floor = i ? children[i - 1].end + 1 : node.line + 1;
        while (start > floor) {
          const prev = lines[start - 1];
          if (prev.trim() && (!prev.trim().startsWith('#') || prev.match(/^ */)[0].length < c.indent)) break;
          start--;
        }
        return start;
      });
      const end = children[children.length - 1].end + 1;
      const blocks = new Map(children.map((c, i) => [c.seg, lines.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : end)]));
      lines.splice(starts[0], end - starts[0], ...keys.flatMap(k => blocks.get(k)));
    }
    const text = lines.join(/\r\n/.test(state.raw) ? '\r\n' : '\n');
    let back;
    try { back = jsyaml.load(text); }
    catch (e) { throw new Error('新顺序会让引用先于锚点定义，或造成 YAML 错误；原顺序已保留'); }
    if (!yamlEq(back, state.cfg)) throw new Error('排序会改变配置值，原顺序已保留');
    return applyConfigDraft(text);
  } catch (e) { uiToast('排序未应用：' + ((e && e.message) || e), 4200); return false; }
}

// TUN/eBPF 接管方式开关改配置后，保存必须重启服务（接管方式的系统侧效果——TUN 网卡、
// eBPF 程序、tproxy 规则对账——随 start_core 重建，热重载不够）；其下方参数不调用此标记，仍走普通热重载。
export function requestServiceRestartOnSave() {
  state.restartServiceAfterSave = true;
  // 同时放到 window，避免旧页面被缓存时出现多个 core.js 模块实例，导致标记不同步。
  try { window.__mihomoRestartServiceAfterSave = true; } catch (e) { }
}

// 保存后的「重启」与主页「重启服务」共用同一实现：由 mihomo-api 注入 restartService
// （带生命周期锁与控制器复位），core 不反向依赖 mihomo-api；未注入时退化为 cmdline('restart')。
let serviceRestartImpl = null;
export function setServiceRestartImpl(fn) { serviceRestartImpl = fn; }

export function clearDirty() {
  state.dirty = false;
  state.restartServiceAfterSave = false;
  try { window.__mihomoRestartServiceAfterSave = false; } catch (e) { }
  draftLayer = 'surgical'; draftDebug = null;
  notifyConfigDraft();
}

// ---------------- 保存条 ----------------
const saveBar = h('div', { class: 'savebar', id: 'saveBar', hidden: true },
  h('span', { class: 'sb-dot' }),
  h('span', { class: 'sb-text', text: '配置已更改 · 未保存' }),
  h('button', { class: 'sb-btn sb-discard', text: '放弃' }),
  h('button', { class: 'sb-btn sb-save', text: '保存' }),
);
export function mountSaveBar() {
  document.body.appendChild(saveBar);
  saveBar.querySelector('.sb-save').onclick = () => saveConfig();
  saveBar.querySelector('.sb-discard').onclick = async () => {
    await loadConfig();
    if (typeof window.rerenderCurrent === 'function') window.rerenderCurrent();
    uiToast('已放弃更改');
  };
}
function renderSaveBar() { saveBar.hidden = state.suppressSaveBar || !state.dirty || !hasConfigLoaded(); }
export function setSaveBarSuppressed(v) {
  state.suppressSaveBar = !!v;
  renderSaveBar();
}
function hasConfigLoaded() { return state.raw !== '' || Object.keys(state.cfg).length > 0 || state.cfgError; }

// ---------------- 配置读写 ----------------
// 循环引用安全的深拷贝（锚点别名是共享引用；YAML 自引用锚点会让 JSON.parse(JSON.stringify) 直接崩溃）
export function deepClone(v) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v); } catch (e) { /* 走 fallback */ }
  }
  const seen = new WeakMap();
  const walk = (x) => {
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x)) return seen.get(x);
    const out = Array.isArray(x) ? [] : {};
    seen.set(x, out);
    for (const [k, val] of Object.entries(x)) out[k] = walk(val);
    return out;
  };
  return walk(v);
}

export function parseConfigText(txt) {
  let obj;
  try {
    obj = jsyaml.load(txt);
    if (Object.prototype.toString.call(obj) !== '[object Object]') throw new Error('内容必须是 YAML 键值对（配置文件顶层），不能是纯文本/列表/数字/日期');
  } catch (e) {
    // 精确指出错误位置：js-yaml 的 mark 为 0 基行号
    let msg = (e && e.message) || String(e);
    if (e && e.mark && typeof e.mark.line === 'number') {
      const lines = txt.split('\n');
      const isNoise = s => { const t = (s || '').trim(); return !t || t.startsWith('#'); };
      let ln = e.mark.line + 1;
      if (e.reason === 'end of the stream or a document separator is expected') {
        // 「纯标量行后跟映射」触发：检测点在新映射行，真正出错的
        // 是上方最近的非空非注释行（缺「: 值」的裸标量，如 tproxy-port）
        let p = ln - 1;
        while (p > 1 && isNoise(lines[p - 1])) p--;
        if (!isNoise(lines[p - 1])) ln = p;
      } else {
        // 流未闭合等错误指向末尾空行/注释行：回退到真正的出错内容
        while (ln > 1 && isNoise(lines[ln - 1])) ln--;
      }
      const lt = (lines[ln - 1] || '').trim();
      // 原因保留 js-yaml 英文原文（用户要求），仅定位部分（第 N 行 + 内容）为中文
      msg = '第 ' + ln + ' 行' + (lt ? '「' + lt + '」' : '') + '：' + (e.reason || e.message || '语法错误');
    }
    return { err: 'YAML 错误：' + msg };
  }
  return { obj };
}

// 把一份配置原文落成当前草稿：解析、对齐模型、记录错误、清脏标记。
export function applyConfigText(text) {
  cancelSourceDraft();
  state.anchorOps.length = 0;
  const { obj, err } = parseConfigText(text);
  state.raw = text;
  state.cfg = reconcileDraft(state.cfg, obj || {});
  state.cfgError = !text.trim()
    ? '配置文件为空或不存在，请先在「内核管理」下载内核，或手动编写配置。'
    : (err || null);
  validDraftRaw = obj ? text : '';
  clearDirty();
  return !state.cfgError;
}

export function b64ToUtf8(str) {
  if (!str) return '';
  try {
    const binStr = atob(str);
    const bytes = Uint8Array.from(binStr, m => m.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch (e) {
    try {
      return decodeURIComponent(escape(atob(str)));
    } catch (_) {
      return atob(str);
    }
  }
}

export async function loadConfig() {
  let text;
  if (DEMO) {
    text = localStorage.getItem('demo-config') || '';
    if (!text) { text = DEMO_CONFIG; }
  } else {
    const r = await readText(CONFIG_PATH);
    if (r.stdout.includes('__READ_FAIL__') && r.stdout.trim() === '__READ_FAIL__') { text = ''; }
    else text = r.stdout;
  }
  return applyConfigText(text);
}

// 保存兜底：mihomo 的 http-opts.headers 类型是 map[string][]string，
// 写成标量会被内核判定为 "'http-opts.headers[Host]' is not a slice"，这里统一转成数组
function normalizeHeaderSlices(cfg) {
  const list = cfg && Array.isArray(cfg.proxies) ? cfg.proxies : [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const opts = p['http-opts'];
    if (!opts || typeof opts !== 'object') continue;
    const hs = opts.headers;
    if (!hs || typeof hs !== 'object' || Array.isArray(hs)) continue;
    for (const [k, v] of Object.entries(hs)) {
      if (v === null || v === undefined) continue;
      hs[k] = Array.isArray(v) ? v.map(x => String(x)) : String(v).split(',').map(s => s.trim()).filter(Boolean);
    }
  }
}

// ---------------- 手术式文本补丁（锚点感知，第一层） ----------------
// 在块状合并之下先做更细的「手术」：把新旧配置做叶子级 diff，把每个改动直接
// 落回原文对应的位置——
//   · 值来自别名（*a）或合并键（<<: *a）时，改动写进锚点定义处（&a 所在块），
//     别名 / 合并关系原样保留，不再展开重建；其他引用者同步生效；
//   · 普通改动只替换 / 增删对应行，块内注释、空行全部保住；
//   · 行上自带的锚点（&a）在重写该行时一并保留；
//   · 任何定位失败（流式集合内部、怪异排版）或最终重新解析与当前配置不一致，
//     就退回块状合并 / 全量 dump，绝不破坏语义。

function unquoteKey(k) {
  if (/^"(.*)"$/.test(k)) return k.slice(1, -1).replace(/\\"/g, '"');
  if (/^'(.*)'$/.test(k)) return k.slice(1, -1).replace(/''/g, "'");
  return k;
}
function aliasNamesOf(v) {
  const s = (v || '').trim();
  const out = [];
  const m1 = s.match(/^\*([^\s,\[\]{}#]+)$/);
  if (m1) return [m1[1]];
  const m2 = s.match(/^\[(.*)\]$/);
  if (m2) for (const it of m2[1].split(',')) { const mm = it.trim().match(/^\*([^\s,\[\]{}#]+)$/); if (mm) out.push(mm[1]); }
  return out;
}

// ---- 文档树：把 YAML 原文按「键 / 列表项」切成带行号的节点树 ----
// 支持：块映射/序列任意嵌套、行内首键（- key: v）、别名、锚点、合并键、
// 块标量、跨行流式集合（整体当一个值，不深入内部）。切不动返回 null。
function buildYamlTree(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.some(l => /^\t/.test(l))) return null;             // YAML 禁止 tab 缩进
  const root = { kind: 'map', line: -1, end: -1, indent: 0, childIndent: 0, children: new Map(),
    merges: [], anchorName: null, aliasName: null, rawKey: null, isItem: false, inlineSeq: false, path: [], parent: null };
  const anchors = new Map();
  const mergeUsers = [];                                        // { node, name }：谁用 <<: 引用了谁
  const aliasUsers = [];                                        // { node, name }：谁用 *a 引用了谁
  const stack = [{ node: root, indent: 0 }];
  const N = lines.length;
  // 键行解析：找引号外第一个「后跟空格/制表符/行尾」的冒号作键值分隔符。
  // 冒号后不跟空格时属于键名本身（如 nameserver-policy 的 rule-set:谷歌FCM）。
  // 返回 [键文本, 值文本]；不是键行返回 null。
  const splitKeyLine = (s) => {
    let q = null;
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (q) { if (c === '\\' && q === '"') j++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '#' && j > 0 && (s[j - 1] === ' ' || s[j - 1] === '\t')) return null;  // 键里出现注释：不是键行
      if (c === ':') {
        const nx = s[j + 1];
        if (nx === undefined || nx === ' ' || nx === '\t') {
          const key = s.slice(0, j).replace(/\s+$/, '');
          if (!key || /[#\s:\[\{&\*!|>%@,`?]/.test(key[0])) return null;   // 指示符开头的键：交兜底
          return [key, nx === undefined ? '' : s.slice(j + 1)];
        }
      }
    }
    return null;
  };
  let i = 0;

  const mk = (parent, seg, line, indent) => {
    const n = { kind: 'val', parent, seg, line, end: line, indent, childIndent: -1, children: null,
      merges: [], anchorName: null, aliasName: null, rawKey: null, isItem: false, inlineSeq: false, inFlow: false, path: [...parent.path, seg] };
    if (parent.kind === 'map') parent.children.set(seg, n); else parent.children.push(n);
    return n;
  };
  const nextContent = (from) => {
    for (let j = from; j < N; j++) { const t = lines[j].trim(); if (t && !t.startsWith('#')) return j; }
    return -1;
  };
  const makeContainer = (node, j) => {                          // 依据下一内容行形态决定容器类型
    node.kind = /^-(\s|$)/.test(lines[j].trim()) ? 'seq' : 'map';
    node.children = node.kind === 'map' ? new Map() : [];
    node.childIndent = lines[j].match(/^[ ]*/)[0].length;
    stack.push({ node, indent: node.childIndent });
  };
  // 流式集合建树：只建结构（供路径解析穿透别名/合并键），不记录列位置。
  // 流式内部的节点标记 inFlow —— 定位到流式内部的行级编辑一律交兜底；但穿过
  // 流式的别名/合并跳转可以把改动落到块状锚点定义处。注册采用事务式：失败整体回滚。
  const parseFlowInto = (host, text) => {
    const regA = new Map();                                     // 待提交的锚点
    const regAlias = [];                                        // 待提交的别名引用者
    const regMerge = [];                                        // 待提交的合并使用者
    let p = 0;
    const M = text.length;
    const skipWS = () => {
      for (;;) {
        if (p >= M) return;
        const c = text[p];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { p++; continue; }
        if (c === '#' && (p === 0 || ' \t\n\r'.includes(text[p - 1]))) { while (p < M && text[p] !== '\n') p++; continue; }
        return;
      }
    };
    const mkFlow = (parent, seg) => ({
      kind: 'val', parent, seg, line: host.line, end: host.end, indent: host.indent, childIndent: -1,
      children: null, merges: [], anchorName: null, aliasName: null, rawKey: null,
      isItem: false, inlineSeq: false, inFlow: true, path: [...parent.path, seg],
    });
    // 外壳：记录该值在原文里的「生文本」（含引号/流式写法），重建流式行时未改动的
    // 键可以原样搬回去，不被 jsyaml.dump 重新决定引号风格。
    const parseValue = (parent, seg, noReg = false) => {
      skipWS();
      const vs = p;
      const n = parseValueRaw(parent, seg, noReg);
      if (n) n.rawVal = text.slice(vs, p).replace(/\s+$/, '');
      return n;
    };
    const parseValueRaw = (parent, seg, noReg = false) => {
      skipWS();
      if (p >= M) return null;
      const n = mkFlow(parent, seg);
      if (text[p] === '&') {                                    // 流内锚点（少见）
        const m = /^&([^\s,\[\]{}#]+)[ \t]*/.exec(text.slice(p));
        if (!m) return null;
        if (anchors.has(m[1]) || regA.has(m[1])) return null;    // 重名：整体退化
        n.anchorName = m[1];
        regA.set(m[1], n);
        p += m[0].length;
        skipWS();
      }
      if (p < M && text[p] === '*') {
        const m = /^\*([^\s,\[\]{}#]+)/.exec(text.slice(p));
        if (!m) return null;
        n.kind = 'alias';
        n.aliasName = m[1];
        if (!noReg) regAlias.push({ node: n, name: m[1] });
        p += m[0].length;
        return n;
      }
      if (p < M && (text[p] === '{' || text[p] === '[')) return parseColl(n, noReg);
      if (p < M && (text[p] === '"' || text[p] === "'")) {      // 引号标量
        const q = text[p]; p++;
        while (p < M && text[p] !== q) { if (q === '"' && text[p] === '\\') p++; p++; }
        if (p >= M) return null;
        p++;
        return n;
      }
      while (p < M) {                                           // 裸标量：读到顶层 , ] } 或注释
        const c = text[p];
        if (c === ',' || c === ']' || c === '}') break;
        if (c === '#' && ' \t\n\r'.includes(text[p - 1] === undefined ? ' ' : text[p - 1])) break;
        if (c === '\n') break;
        p++;
      }
      return n;
    };
    const parseColl = (n, noReg) => {
      const isMap = text[p] === '{';
      p++;
      n.kind = isMap ? 'map' : 'seq';
      n.children = isMap ? new Map() : [];
      for (;;) {
        skipWS();
        if (p >= M) return null;
        if (text[p] === (isMap ? '}' : ']')) { p++; return n; }
        if (isMap) {
          let key;                                              // 键：引号或裸文本
          if (text[p] === '"' || text[p] === "'") {
            const q = text[p]; const st = p; p++;
            while (p < M && text[p] !== q) { if (q === '"' && text[p] === '\\') p++; p++; }
            if (p >= M) return null;
            p++;
            key = text.slice(st, p);
          } else {
            const st = p;
            while (p < M) {
              const c = text[p];
              if (c === ':') {
                const nx = text[p + 1];
                if (nx === undefined || nx === ' ' || nx === '\t' || nx === '\n' || nx === '\r' || nx === ',' || nx === '}' || nx === ']') break;
              }
              if (c === ',' || c === '}' || c === ']' || c === '\n') return null;   // 无值键：退化
              p++;
            }
            if (p >= M || text[p] !== ':') return null;
            key = text.slice(st, p).trim();
            if (key === '') return null;
          }
          p++;                                                  // 吃掉 ':'
          const isMerge = unquoteKey(key) === '<<';
          const v = parseValue(n, isMerge ? '<<' : unquoteKey(key), isMerge);
          if (!v) return null;
          v.rawKey = key;
          if (isMerge) {                                        // <<: *a 或 <<: [*a, *b]
            if (v.kind === 'alias') {
              n.merges.push(v.aliasName); regMerge.push({ node: n, name: v.aliasName });
            } else if (v.kind === 'seq' && v.children.every(x => x && x.kind === 'alias')) {
              for (const it of v.children) { n.merges.push(it.aliasName); regMerge.push({ node: n, name: it.aliasName }); }
            } else return null;
          } else {
            if (n.children.has(v.seg)) return null;             // 重复键：退化
            n.children.set(v.seg, v);
          }
        } else {
          const v = parseValue(n, n.children.length, noReg);
          if (!v) return null;
          n.children.push(v);
        }
        skipWS();
        if (p < M && text[p] === ',') { p++; continue; }
        if (p < M && text[p] === (isMap ? '}' : ']')) { p++; return n; }
        return null;
      }
    };
    skipWS();
    if (p >= M || (text[p] !== '{' && text[p] !== '[')) return null;
    const rootFlow = mkFlow(host, null);
    rootFlow.path = [...host.path];                             // 顶层就是 host 自身
    if (!parseColl(rootFlow, false)) return null;
    skipWS();
    if (p < M && text[p] !== ',' && text[p] !== '}' && text[p] !== ']' && text[p] !== '#') return null;  // 尾部还有内容：退化
    // 成功：提交到 host + 全局注册表
    host.kind = rootFlow.kind;
    host.children = rootFlow.children;
    host.merges = rootFlow.merges;
    for (const [name, an] of regA) anchors.set(name, an);
    for (const e of regAlias) aliasUsers.push(e);
    for (const e of regMerge) mergeUsers.push(e);
    return true;
  };

  // 值部分：锚点 / 别名 / 块标量 / 跨行流式。返回 'ok' | 'sub'(值在子块) | false(切不动)
  const consumeVal = (node, rest, lineIndent) => {
    let s = (rest || '').trim();
    if (s.startsWith('&')) {
      const m = s.match(/^&([^\s,\[\]{}#]+)[ \t]*(.*)$/);
      if (!m) return false;
      if (anchors.has(m[1])) return false;                      // 重名锚点：交兜底
      node.anchorName = m[1];
      anchors.set(m[1], node);
      s = m[2].trim();
    }
    if (s === '') return 'sub';                                 // 值在子块（或 null），由调用方处理
    if (s.startsWith('*')) {
      // 锚点名允许非 ASCII（用户常用中文命名，如 &回退）；行尾注释不影响别名判定
      const m = s.match(/^\*([^\s,\[\]{}#]+)([ \t]*(#.*)?)?$/);
      if (!m) return false;
      node.aliasName = m[1];
      node.kind = 'alias';                                      // 别名节点：路径解析时跳到锚点处
      aliasUsers.push({ node, name: m[1] });
      return 'ok';
    }
    if (/^[|>]/.test(s)) {                                      // 块标量：吞更深缩进的行
      while (node.end + 1 < N) {
        const nl = lines[node.end + 1];
        if (!nl.trim()) { node.end++; continue; }
        if (nl.match(/^[ ]*/)[0].length > lineIndent) node.end++;
        else break;
      }
      while (node.end > node.line && !lines[node.end].trim()) node.end--;
      i = node.end;
      return 'ok';
    }
    if (s.startsWith('[') || s.startsWith('{')) {               // 流式（可跨行）：吞到括号配平
      let k = node.line, depth = 0, q = null, done = false, openCol = -1, closeCol = -1;
      for (; !done && k < N; k++) {
        const l = lines[k];
        for (let j = 0; j < l.length; j++) {
          const c = l[j];
          if (q) { if (c === '\\') j++; else if (c === q) q = null; continue; }
          if (c === '"' || c === "'") { q = c; continue; }
          if (c === '#' && (j === 0 || l[j - 1] === ' ' || l[j - 1] === '\t')) break;
          if (c === '[' || c === '{') { if (depth === 0) openCol = j; depth++; }
          else if (c === ']' || c === '}') { depth--; if (depth === 0) { closeCol = j; done = true; break; } }
        }
      }
      if (!done) return false;
      node.end = k - 1;
      node.flowStartCol = openCol; node.flowEndCol = closeCol;
      // 解析流式内部结构（嵌套/别名/合并键）：解析不动就退化为不透明值（与旧行为一致）
      const flowText = lines[node.line].slice(openCol)
        + (node.end > node.line ? '\n' + lines.slice(node.line + 1, node.end + 1).join('\n') : '');
      if (!parseFlowInto(node, flowText)) {
        node.kind = 'val'; node.children = null; node.merges = [];
      }
      i = node.end;
      return 'ok';
    }
    return 'ok';                                                // 普通标量（可带行尾注释）
  };

  while (i < N) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { i++; continue; }
    if (/^(---|\.\.\.)(\s|$)/.test(line)) return null;       // 文档分隔符：不处理
    if (/^\?(\s|$)/.test(line)) return null;                   // 显式键：不处理
    const indent = line.match(/^[ ]*/)[0].length;
    const isItem = /^-(\s|$)/.test(line.slice(indent));
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      if (top.indent > indent || (top.indent === indent &&
          ((isItem && top.node.kind !== 'seq') || (!isItem && top.node.kind !== 'map')))) stack.pop();
      else break;
    }
    const top = stack[stack.length - 1];

    if (isItem) {
      if (top.node.kind !== 'seq' || top.indent !== indent) return null;
      const afterRaw = line.slice(indent + 1);
      const lead = afterRaw.match(/^[ ]*/)[0].length;
      const after = afterRaw.slice(lead);
      const item = mk(top.node, top.node.children.length, i, indent);
      item.isItem = true;
      if (after === '') {                                       // 裸 "-"：子块在下面
        const j = nextContent(i + 1);
        if (j >= 0 && lines[j].match(/^[ ]*/)[0].length > indent) makeContainer(item, j);
        i++; continue;
      }
      if (/^-(\s|$)/.test(after)) return null;                  // 行内嵌套序列：交兜底
      const km = splitKeyLine(after);
      if (km) {                                                 // - key: v（行内首键）
        const keyCol = indent + 1 + lead;
        item.rawKey = km[0];
        item.kind = 'map'; item.children = new Map(); item.childIndent = keyCol;
        if (km[0] === '<<') {
          const names = aliasNamesOf(km[1]);
          item.merges.push(...names);
          for (const nm of names) mergeUsers.push({ node: item, name: nm });
        } else {
          const child = mk(item, unquoteKey(km[0]), i, keyCol);
          child.rawKey = km[0]; child.inlineSeq = true;
          const cv = consumeVal(child, km[1], keyCol);
          if (!cv) return null;
          if (cv === 'sub') {                                   // - key: 空值 → 子块在下面
            const j = nextContent(i + 1);
            if (j >= 0 && lines[j].match(/^[ ]*/)[0].length > keyCol) makeContainer(child, j);
          }
        }
        stack.push({ node: item, indent: keyCol });
        i++; continue;
      }
      const cvi = consumeVal(item, after, indent);              // 标量 / 别名 / 块标量 / 流式项
      if (!cvi) return null;
      if (cvi === 'sub') {                                      // "&a 单独成项：子块在下面
        const j = nextContent(i + 1);
        if (j >= 0 && lines[j].match(/^[ ]*/)[0].length > indent) makeContainer(item, j);
      }
      i++; continue;
    }

    const km = splitKeyLine(line.slice(indent));                // 映射键行
    if (!km) return null;
    // 容错：`<<:` 行缩进异常（如 proxy-providers 里 6 空格而不是 4）时按父容器 childIndent 归一化
    // 否则整棵树解析失败，手术层直接退化到块状重排，锚点丢失
    let effIndent = indent;
    if (km[0] === '<<' && top.node.kind === 'map' && top.indent !== indent) {
      if (indent > top.indent && indent <= top.indent + 6) {
        effIndent = top.childIndent > 0 ? top.childIndent : top.indent + 2;
      } else {
        return null;
      }
    }
    if (top.node.kind !== 'map' || top.indent !== effIndent) return null;
    if (km[0] === '<<') {
      const names = aliasNamesOf(km[1]);
      top.node.merges.push(...names);
      for (const nm of names) mergeUsers.push({ node: top.node, name: nm });
      i++; continue;
    }
    const node = mk(top.node, unquoteKey(km[0]), i, indent);
    node.rawKey = km[0];
    const cvk = consumeVal(node, km[1], indent);
    if (!cvk) return null;
    if (cvk === 'sub') {                                        // 空值或仅锚点(&a)：子块在下面
      const j = nextContent(i + 1);
      if (j >= 0 && lines[j].match(/^[ ]*/)[0].length > indent) makeContainer(node, j);
    }
    i++;
  }
  if (!root.children.size) return null;
  (function fixEnds(n) {                                        // 值域末行 = 自身与子节点的最大行
    let e = n.end;
    const kids = n.kind === 'map' ? [...n.children.values()] : (n.kind === 'seq' ? n.children : []);
    for (const c of kids) { fixEnds(c); if (c.end > e) e = c.end; }
    n.end = e;
  })(root);
  return { root, anchors, mergeUsers, aliasUsers, lines };
}

// ---- 叶子级 diff：新旧配置 → 增/删/改 操作列表 ----
function diffLeaves(a, b, path, ops) {
  if (a === b) return;
  const aLeaf = a === null || a === undefined || typeof a !== 'object';
  const bLeaf = b === null || b === undefined || typeof b !== 'object';
  if (aLeaf || bLeaf) {
    if (!yamlEq(a, b)) ops.push({ t: 'set', path, val: b });
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { ops.push({ t: 'set', path, val: b }); return; }
  if (Array.isArray(a)) {
    const n = Math.min(a.length, b.length);
    for (let k = 0; k < n; k++) diffLeaves(a[k], b[k], [...path, k], ops);
    for (let k = a.length - 1; k >= n; k--) ops.push({ t: 'del', path: [...path, k] });
    for (let k = n; k < b.length; k++) ops.push({ t: 'add', path: [...path, k], val: b[k] });
    return;
  }
  for (const k of Object.keys(a)) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || b[k] === undefined) ops.push({ t: 'del', path: [...path, k] });
    else diffLeaves(a[k], b[k], [...path, k], ops);
  }
  for (const k of Object.keys(b)) {
    if (!Object.prototype.hasOwnProperty.call(a, k) && b[k] !== undefined) ops.push({ t: 'add', path: [...path, k], val: b[k] });
  }
}

// ---- 路径解析：支持别名跳转与合并键溯源（merge 只跳一次，多层交兜底） ----
function lookupMerge(mapNode, seg, anchors, depth) {
  if (depth > 6) return null;
  for (const name of (mapNode.merges || [])) {
    let src = anchors.get(name);
    if (src && src.kind === 'alias') src = anchors.get(src.aliasName);
    if (!src || src.kind !== 'map') continue;
    const direct = src.children.get(seg);
    if (direct !== undefined) return { node: direct, anchorNode: src };
    const deeper = lookupMerge(src, seg, anchors, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}
function resolvePath(tree, path, derefLast = false) {
  const { root, anchors } = tree;
  let node = root;
  let via = null;                                               // { userNode, segIdx, anchorName }（merge 跳转）
  const aliasVia = [];                                          // { userNode, segIdx, anchorName }（别名跳转）
  for (let s = 0; s < path.length; s++) {
    const seg = path[s];
    if (node.kind === 'alias') {
      const an = anchors.get(node.aliasName);
      if (!an) return null;
      aliasVia.push({ userNode: node, segIdx: s, anchorName: node.aliasName });
      node = an;
    }
    if (node.kind === 'map') {
      let child = node.children.get(seg);
      if (child === undefined) {
        const found = lookupMerge(node, seg, anchors, 0);
        if (!found) return null;
        if (via) return null;                                   // 只支持一次 merge 跳转
        via = { userNode: node, segIdx: s, anchorName: found.anchorNode.anchorName };
        node = found.node;
      } else node = child;
    } else if (node.kind === 'seq') {
      const child = node.children[seg];
      if (child === undefined) return null;
      node = child;
    } else return null;
  }
  if (derefLast && node.kind === 'alias') {                     // 需要往里加东西：解到最后实体
    const an = anchors.get(node.aliasName);
    if (!an) return null;
    aliasVia.push({ userNode: node, segIdx: path.length, anchorName: node.aliasName });
    node = an;
  }
  return { node, via, aliasVia };
}

// 手术层内部用的深拷贝：YAML 别名可以造出环，必须能处理循环引用
// （不用外层 deepClone，是为了让这一整簇排版代码可以独立抽出来做测试）
function cloneDeepSafe(v, seen = new WeakMap()) {
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return seen.get(v);
  const out = Array.isArray(v) ? [] : {};
  seen.set(v, out);
  for (const k of Object.keys(v)) out[k] = cloneDeepSafe(v[k], seen);
  return out;
}

// ---- 数组路径版的读写（应用自带的 get/set 用点号路径，键里有点会出问题） ----
function getA(obj, path) {
  let c = obj;
  for (const k of path) { if (c == null || typeof c !== 'object') return undefined; c = c[k]; }
  return c;
}
function silentSetA(obj, path, v) {
  let c = obj;
  for (let k = 0; k < path.length - 1; k++) {
    const key = path[k];
    if (typeof c[key] !== 'object' || c[key] === null) c[key] = {};
    c = c[key];
  }
  c[path[path.length - 1]] = v;
}
function silentDelA(obj, path) {
  const chain = [obj];
  let c = obj;
  for (let k = 0; k < path.length - 1; k++) {
    const key = path[k];
    if (typeof c[key] !== 'object' || c[key] === null) return;
    c = c[key];
    chain.push(c);
  }
  const last = path[path.length - 1];
  if (Array.isArray(c) && Number.isInteger(last) && last >= 0 && last < c.length) c.splice(last, 1);  // 数组项：紧凑删除，不能留洞
  else delete c[last];
  for (let k = chain.length - 1; k > 0; k--) {                  // 清理空映射父级（数组元素不动）
    const n = chain[k];
    if (n && typeof n === 'object' && !Array.isArray(n) && Object.keys(n).length === 0) {
      const p = chain[k - 1];
      for (const key of Object.keys(p)) if (p[key] === n) delete p[key];
    }
  }
}

// ---- 数组换序 / 删条目（拖动排序、列表编辑器换序、删除代理组）：整块搬移 ----
// 语义 diff 是按下标逐项比较的：把一个数组项从第 1 位拖到末位（或删掉中间一项），
// 中间每一项都会被算成「值变了」，于是每个代理组/规则都在原地被重写一遍 ——
// 段前注释留在原位（注释与条目脱钩）、条目内键序被打乱；一旦某项命中不支持的
// 路径（条目里的 *别名、<<: 继承键、流式写法等），整段还会坠到块状兜底被整体
// 重排（锚点、<<: *合并键、注释、{} 流式写法全丢）。而这些操作并没有改条目本身。
// 这里先按条目做对齐（深度相等配对），把「换序 + 删除」折算成文本层的整块搬移/
// 删除：条目原文一字不改，注释与空行随条目走；搬完重新解析当作新的原文基线，
// 再算剩余的语义 diff。新增条目要凭空生成文本，不在此处理，仍走索引级 diff。

// 条目级配对：按新顺序给每个新条目找一个「深度相等的老条目」。
// 返回「保留下来的老下标，按新顺序」（未列出的老条目视为被删除）；
// 只要有新条目配不上对（真正的新增/内容被改）就返回 null，交回索引级 diff。
// 不用 LCS：换序本身就打乱了顺序（把第 1 项拖到末尾时 LCS 只有 n-1），
// 而块搬移并不要求保序，贪心一对一配对能同时覆盖「换序」「删除」「换序+删除」。
function seqKeepOrder(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  if (b.length > a.length) return null;                          // 变长＝有新增：交兜底
  const used = new Array(a.length).fill(false);
  const keep = [];
  for (let j = 0; j < b.length; j++) {
    let hit = -1;
    // 完全相同的条目可互换：取第一个没用过的即可，语义等价
    for (let i = 0; i < a.length; i++) if (!used[i] && yamlEq(a[i], b[j])) { hit = i; break; }
    if (hit < 0) return null;                                    // 新条目/改过的条目：交兜底
    used[hit] = true; keep.push(hit);
  }
  return keep;
}

// 序列条目整块搬移/删除：keep[i] = 新第 i 位放原来的第几项（未列出的项被删掉）。
// 失败返回 null（交兜底）。
function moveSeqBlocks(lines, node, order) {
  const children = node.children;
  if (!Array.isArray(children) || !children.length) return null;
  if (!order.length) return null;                                // 整段清空：交给 fullSeqDel 处理
  if (node.inFlow) return null;
  if (order.some(i => !Number.isInteger(i) || i < 0 || i >= children.length)) return null;
  if (new Set(order).size !== order.length) return null;          // 同一个老条目不能被用两次
  for (const c of children) {
    // 条目必须自成一块「- …」行：整块按行搬走，条目内部是块式还是流式（- { … }）都不影响。
    // 只有「整个序列写成流式 [ … ]」时才没有独立条目行可搬（条目自身 inFlow）。
    if (c.inFlow) return null;
    if (!/^[ ]*-(\s|$)/.test(lines[c.line] || '')) return null;
    if (c.end < c.line || c.end >= lines.length) return null;
  }
  // 段前同级注释/空行随条目移动（与 reorderConfigMap 的映射搬移同构）
  const starts = children.map((c, i) => {
    let start = c.line;
    const floor = i ? children[i - 1].end + 1 : node.line + 1;
    while (start > floor) {
      const prev = lines[start - 1];
      if (prev.trim() && (!prev.trim().startsWith('#') || prev.match(/^ */)[0].length < c.indent)) break;
      start--;
    }
    return start;
  });
  const end = children[children.length - 1].end + 1;
  if (starts.some((s, i) => s >= (i + 1 < starts.length ? starts[i + 1] : end))) return null;
  const blocks = children.map((c, i) => lines.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : end));
  const out = lines.slice();
  out.splice(starts[0], end - starts[0], ...order.flatMap(i => blocks[i]));
  return out;
}

// 找出 orig→cfg 之间「只是换序/删条目」的数组并在文本里搬好。
// 返回 { text, parsed }；没有可搬的、或搬不动（流式序列/别名/锚点次序会断）→ null。
function applySeqBlockMoves(rawText, orig, cfg) {
  const moves = [];
  const walk = (a, b, path) => {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return;
    if (Array.isArray(a) || Array.isArray(b)) {
      const keep = seqKeepOrder(a, b);
      // 有换序或有删除才需要动手；顺序与内容都没变就什么都不做
      if (keep && (keep.length !== a.length || keep.some((v, i) => v !== i))) moves.push({ path: [...path], order: keep });
      return;                                                    // 整块搬移，内部不再深入
    }
    for (const k of Object.keys(a)) {
      if (Object.prototype.hasOwnProperty.call(b, k)) walk(a[k], b[k], [...path, k]);
    }
  };
  walk(orig, cfg, []);
  if (!moves.length) return null;
  let lines = rawText.replace(/\r\n?/g, '\n').split('\n');
  const sep = /\r\n/.test(rawText) ? '\r\n' : '\n';
  for (const m of moves) {
    const tree = buildYamlTree(lines.join('\n'));                // 每次搬移后行号全变，重建树再定位
    if (!tree) return null;
    const r = resolvePath(tree, m.path);
    if (!r || !r.node || r.node.kind !== 'seq') return null;
    if (r.via || (r.aliasVia && r.aliasVia.length)) return null;  // 经合并键/别名进来的序列：交兜底
    const next = moveSeqBlocks(tree.lines, r.node, m.order);
    if (!next) return null;
    lines = next;
  }
  const text = lines.join(sep);
  let back;
  try { back = jsyaml.load(text); } catch (e) { return null; }    // 新顺序让引用先于锚点定义等：交兜底
  const left = [];
  diffLeaves(back == null ? {} : back, cfg, [], left);
  // 搬移后这些数组必须已经与目标一致；仍有 op 说明匹配错了条目，放弃
  if (left.some(op => moves.some(m => m.path.every((s, i) => op.path[i] === s) && op.path.length >= m.path.length))) return null;
  return { text, parsed: back == null ? {} : back };
}

// ---- 手术式补丁主入口：成功返回新文本，失败返回 null ----
function patchConfigText(cfg, rawText0, orig0) {
  const ops0 = [];
  diffLeaves(orig0, cfg, [], ops0);
  // 先判无改动：原文已校验且值一致时，不需要结构树支持这种排版。
  // 否则保守建树失败会误走块式兜底，连最终保存都重写 CRLF / 尾部空行。
  if (!ops0.length) return rawText0;
  // 数组重排先落地：搬移结果就是新的「原文基线」，后续所有路径解析、锚点传导、
  // 安全网都以它为基准。搬完若已无剩余改动，直接返回（排序不产生任何语义 op）。
  let rawText = rawText0, orig = orig0, ops = ops0;
  const mv = applySeqBlockMoves(rawText, orig, cfg);
  if (mv) {
    ops = [];
    diffLeaves(mv.parsed, cfg, [], ops);
    if (!ops.length) return mv.text;
    rawText = mv.text; orig = mv.parsed;
  }
  const dbg = { reasons: [], ops: ops.slice(0, 120) };
  const fail = (why) => { dbg.reasons.push(why); lastPatchDebug = dbg; return null; };
  const tree = buildYamlTree(rawText);
  // 以前这里是静默 return null：结构树切不动时（中文锚点名、别名行带注释、文档分隔符等）
  // 诊断日志只有 layer=blocks 一行、没有任何 reason，根因无法定位。
  if (!tree) return fail('unsupported layout：结构树切不动（中文锚点名 / 别名行带注释 / 文档分隔符等）');
  const { root, anchors, mergeUsers, aliasUsers, lines } = tree;
  let unit = 2;                                                 // 缩进单位：取首个缩进行
  for (const l of lines) { const m = l.match(/^[ ]+(?=\S)/); if (m) { unit = m[0].length; break; } }
  if (ops.length > 400) return fail('ops>400');
  // 别名共享引用：一处改动会在多条别名路径上产生重复操作（解析后指向同一物理节点）。
  // 只保留一个，避免重复重建/互相冲突；直接作用于本体的操作优先于经合并键的操作。
  const opsDedup = (() => {
    const seen = new Map();
    const out = [];
    for (const op of ops) {
      const r = op.t === 'add' ? resolvePath(tree, op.path.slice(0, -1), true) : resolvePath(tree, op.path);
      if (!r || !r.node) { out.push(op); continue; }
      // 「按使用者生效」的 op 不能跨使用者合并成一条（否则第二个使用者的效果被吞掉，
      // 安全网 probe 缺键 → safety-net mismatch）：
      //   · 经合并键删继承键（多使用者、非容器内）→ 每个使用者各自 restore 回原值；
      //   · 经别名进来（含落在别名上）→ 每个别名使用者各自把别名行实体化。
      // 其余（写穿锚点的 set/add/del、直接操作）作用在同一物理节点，照旧按节点去重。
      let perUserKey = '';
      if (r.aliasVia && r.aliasVia.length) {
        perUserKey = '|u:' + r.aliasVia[0].userNode.path.join('\u0000');
      } else if (op.t === 'del' && r.via) {
        const users = mergeUsers.filter(m => m.name === r.via.anchorName);
        const inContainer = r.via.segIdx < op.path.length - 1;
        const writeThru = users.length <= 1 || inContainer;
        if (!writeThru) perUserKey = '|u:' + r.via.userNode.path.join('\u0000');
      }
      const key = op.t + '@' + r.node.path.join('\u0000') + perUserKey + (op.t === 'add' ? '+' + op.path[op.path.length - 1] : '');
      if (!seen.has(key)) { seen.set(key, { i: out.length, via: !!r.via }); out.push(op); continue; }
      const rec = seen.get(key);
      if (rec.via && !r.via) { out[rec.i] = op; rec.via = false; }   // 直接操作顶替 via 操作
    }
    return out;
  })();
  // 预扫描：本批把某个块式序列的「所有项」都删掉时，裸 `key:` 会解析成 null，
  // 需要整体塌缩成 `key: []`（各删项 op 生成相同塌缩编辑，合并步骤自动去重）
  const fullSeqDel = new Set();
  {
    const delCnt = new Map();
    for (const op of opsDedup) {
      if (op.t !== 'del') continue;
      const rr = resolvePath(tree, op.path);
      if (!rr || !rr.node || !rr.node.parent || rr.node.parent.kind !== 'seq') continue;
      delCnt.set(rr.node.parent, (delCnt.get(rr.node.parent) || 0) + 1);
    }
    for (const [seqN, c] of delCnt) {
      if (c === seqN.children.length && !seqN.inFlow && !seqN.inlineSeq
          && seqN.parent && seqN.parent.kind === 'map' && seqN !== root) fullSeqDel.add(seqN);
    }
  }
  // 重命名检测：同父级「删一键 + 加一键」且新值深度等于被删键的原值 → 视为重命名，
  // 只在键行改键名，原块体 / 注释 / 锚点 / {} 流式逐字保留。
  // （按普通 del+add 处理会把条目重排到块尾并重 dump，<<: *x 与流式写法就没了）
  const renamePairs = [];
  {
    const dels = opsDedup.filter(o => o.t === 'del');
    const usedDels = new Set();
    for (const a of opsDedup) {
      if (a.t !== 'add') continue;
      const aParent = a.path.slice(0, -1).join('\u0000');
      const d = dels.find(x => !usedDels.has(x) && x.path.length === a.path.length
        && x.path.slice(0, -1).join('\u0000') === aParent && yamlEq(a.val, getA(orig, x.path)));
      if (d) { usedDels.add(d); renamePairs.push({ del: d, add: a }); }
    }
  }
  const renamedOps = new Set();
  renamePairs.forEach(p => { renamedOps.add(p.del); renamedOps.add(p.add); });
  const dumpOpts = { lineWidth: -1, noRefs: true, sortKeys: false, indent: unit };
  const edits = [];                                             // { from, to, lines }（替换原文 [from,to] 行）
  const props = [];                                             // cfg 侧同步：{ kind, path, val?, guard? }
  const seqAppends = new Map();                                 // 序列节点 → 本批已尾部追加的项数：
                                                                  // ops 逐条应用而树不随 op 变更，一次 UI 编辑
                                                                  // 往同一列表连加 N 项（如 override-expr 连加两条）
                                                                  // 若只比 children.length，第 2 条起必失败 → 整批
                                                                  // 坠到块状层重排。用该计数推进期望下标。
  const reindent = (arr, n) => arr.map(l => l === '' ? '' : ' '.repeat(n) + l);
  // 行尾注释（引号外、# 前有空白才算）：重写单行值时原样接回去。
  // 以前重写值域会把整行换掉，`exclude-type: "Hysteria2" # 说明…`、
  // `切换策略: &type fallback # 可选 fallback 和 smart` 这类行尾说明改一次就没了。
  const trailingComment = (line) => {
    if (line == null) return '';
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) { if (line[i + 1] === q) i++; else q = null; } continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(i);
    }
    return '';
  };
  // 流式宿主（`- { … }` / `key: [ … ]`）整行重建时接回原来最后一行的行尾注释：
  // 以前重建一次，`- { name: 香港01, … }  # 备注` 的备注就没了。
  const hostTail = (host) => {
    const c = trailingComment(lines[host.end]);
    return c ? ' ' + c : '';
  };
  const valueBlock = (node, val, flow = false) => {           // 节点值域整体重写
    const dOpts = flow ? { ...dumpOpts, flowLevel: 1 } : dumpOpts;
    // 单行值才接回注释：多行块的第一行接注释会改变语义边界，宁可丢掉
    const tailC = (node.line === node.end) ? trailingComment(lines[node.line]) : '';
    const tail = tailC ? ' ' + tailC : '';
    if (node.isItem) {
      const it = reindent(jsyaml.dump([val], dOpts).replace(/\n+$/, '').split('\n'), node.indent);
      if (it.length === 1) it[0] = it[0] + tail;
      return it;
    }
    const d = jsyaml.dump({ v: val }, dOpts).replace(/\n+$/, '').split('\n');
    let head = d[0].slice(2).replace(/^[ ]+/, '');
    if (node.anchorName) head = '&' + node.anchorName + ' ' + head;
    let prefix;
    if (node.inlineSeq) {
      // 行内首键（`- key: v`）：项缩进是「-」所在列而非键列，从原行取「空白 + - 」前缀，
      // 用键列缩进会把列表项整体顶歪（bad indentation）
      const m0 = (lines[node.line] || '').match(/^[ \t]*-(?:[ \t]+|$)/);
      prefix = (m0 ? m0[0] : ' '.repeat(Math.max(0, node.indent - 2)) + '- ') + (node.rawKey != null ? node.rawKey : String(node.seg)) + ':';
    } else {
      prefix = ' '.repeat(node.indent) + (node.rawKey != null ? node.rawKey : String(node.seg)) + ':';
    }
    if (d.length === 1) return [prefix + (head === '' ? '' : ' ' + head) + tail];
    return [prefix + (head === '' ? '' : ' ' + head), ...reindent(d.slice(1), node.indent)];
  };
  // 流式序列宿主整行重建（`key: [...]`）：流式序列没有逐项行可改，
  // 项的增删改一律按 cfg 最新值重建单行流式文本，保持 [...] 写法
  // 经合并键（<<: *a）写进锚点内部时，锚点宿主的「新值」不能只把当前这一个叶子改上去：
  // 同一批里针对同一宿主往往有多个 op（删数组中间项 = 兄弟项 set + 尾项 del），各自基于
  // 原值重建就会在同一行上产生两份不同文本 → same-pos conflict → 整段回退重排。
  // 这里一次性把「使用者侧（cfg 里的最终值）对继承内容的改动」全部折算到锚点副本上，
  // 于是同一宿主的每个 op 都算出同一行文本，天然去重。
  const viaHostVal = (host, via) => {
    if (!via) return undefined;
    const anchorNode = anchors.get(via.anchorName);
    if (!anchorNode) return undefined;
    const ap = anchorNode.path;
    if (host.path.length < ap.length || host.path.slice(0, ap.length).join('\u0000') !== ap.join('\u0000')) return undefined;
    const aOld = getA(orig, host.path);
    if (aOld === undefined || aOld === null || typeof aOld !== 'object') return undefined;
    const userHostPath = [...via.userNode.path, ...host.path.slice(ap.length)];
    const uOld = getA(orig, userHostPath), uNew = getA(cfg, userHostPath);
    if (uNew === undefined) return cloneDeepSafe(aOld);
    if (yamlEq(uOld, aOld)) return cloneDeepSafe(uNew);      // 宿主内容整体继承自锚点：直接用使用者的最终值
    const out = cloneDeepSafe(aOld);
    if (!Array.isArray(out) && uOld && typeof uOld === 'object' && uNew && typeof uNew === 'object' && !Array.isArray(uNew)) {
      for (const k of Object.keys(out)) {
        if (!(k in uNew) || !(k in uOld)) continue;
        if (!yamlEq(uOld[k], out[k])) continue;              // 使用者本地覆写过：不回写锚点
        if (!yamlEq(uNew[k], out[k])) out[k] = cloneDeepSafe(uNew[k]);
      }
    }
    return out;
  };

  const rebuildFlowHost = (host, via) => {
    let newVal = via ? viaHostVal(host, via) : undefined;
    const viaVal = newVal;
    if (newVal === undefined) newVal = getA(cfg, host.path);
    if (newVal === undefined) return false;
    const d = jsyaml.dump({ v: newVal }, { ...dumpOpts, flowLevel: 1 }).replace(/\n+$/, '').split('\n');
    if (d.length !== 1) return false;                          // 摊不成单行就交兜底
    let head = d[0].slice(2).replace(/^[ ]+/, '');
    if (host.anchorName) head = '&' + host.anchorName + ' ' + head;
    let prefix;
    if (host.inlineSeq) {
      const m0 = (lines[host.line] || '').match(/^[ \t]*-(?:[ \t]+|$)/);
      prefix = (m0 ? m0[0] : ' '.repeat(Math.max(0, host.indent - 2)) + '- ') + (host.rawKey != null ? host.rawKey : String(host.seg)) + ':';
    } else {
      prefix = ' '.repeat(host.indent) + (host.rawKey != null ? host.rawKey : String(host.seg)) + ':';
    }
    edits.push({ from: host.line, to: host.end, lines: [prefix + (head === '' ? '' : ' ' + head) + hostTail(host)] });
    // 写进的是锚点侧：cfg 里的锚点定义也要同步（其余合并使用者由末尾的传导循环处理）
    if (via && viaVal !== undefined) props.push({ kind: 'set', path: [...host.path], val: newVal });
    return true;
  };

  const otherMergeTargets = (via, opPath) => mergeUsers
    .filter(mu => mu.name === via.anchorName && mu.node !== via.userNode)
    .map(mu => [...mu.node.path, ...opPath.slice(via.segIdx)]);

  // 流式宿主整行重建的行首：键宿主是「key: { … }」，序列条目是「- { … }」。
  // 以前一律按 (rawKey||seg) + ':' 拼，流式条目（`- { name: …, type: *a }`）就写成
  // `4: { … }`——拿数组下标当键，安全网报 bad indentation，整段坠到块状兜底被重排。
  // 行内首键宿主（`- key: { … }`）要保留原行的「空白 + - 」前缀和键名，否则会被当成
  // 序列条目写成 `- { … }`，键丢失、缩进错位。
  const flowHostLine = (host, flowStr) => {
    const anchor = host.anchorName ? ' &' + host.anchorName : '';
    const key = host.rawKey != null && host.rawKey !== '' ? host.rawKey : String(host.seg);
    if (host.inlineSeq && !host.isItem) {
      const m0 = (lines[host.line] || '').match(/^[ \t]*-(?:[ \t]+|$)/);
      const lead = m0 ? m0[0] : ' '.repeat(Math.max(0, host.indent - 2)) + '- ';
      return lead + key + ':' + anchor + ' ' + flowStr + hostTail(host);
    }
    if (host.isItem || /^[ ]*-(\s|$)/.test(lines[host.line] || '')) {
      return ' '.repeat(host.indent) + '-' + anchor + ' ' + flowStr + hostTail(host);
    }
    return ' '.repeat(host.indent) + key + ':' + anchor + ' ' + flowStr + hostTail(host);
  };

  const applySet = (op) => {
    const r = resolvePath(tree, op.path);
    if (!r) return false;
    let node = r.node;
    // 注意：set 落在别名节点（或路径穿过别名）不再在此「写穿锚点定义」——
    // 那会把单个使用者的本地改动泄漏给同锚点的所有使用者。已由主循环的
    // materializeAliasUser 统一接管（把别名行实体化为显式值，锚点保持不动）。
    if (r.via && r.via.segIdx === op.path.length - 1) {
      const topKey = op.path[0];
      if (topKey === 'proxy-providers' || topKey === 'rule-providers') {
        // 代理合集/规则集：用户反馈「修改部分参数值(比如自动更新间隔)没有同步到锚点参数」
        // 这类集合常把公共字段抽成 &锚点，编辑单个集合的间隔时期望同步到锚点定义
        // （所有引用该锚点的集合一起更新），而不是只在当前条目写本地覆写
        // 若需本地覆写，用户可在界面上先取消继承再改值
      } else {
        // 键本身继承自 <<: 合并（如规则集条目里的 type/interval）：写穿锚点会波及所有使用者。
        // YAML 合并语义里显式键优先于合并键——在消费者条目内写本地覆盖键才是正解。
        // 插入路径与「新增键」完全同构，直接复用 applyAdd（条目本地无此键，必然插入成功）。
        return applyAdd({ t: 'add', path: [...op.path], val: op.val });
      }
    }
    if (node.inFlow){
      // 流式内部：保持原 { } 样式，重建整行 flow 字符串
      let host=node.parent;
      while(host && host.inFlow) host=host.parent;
      if(!host) return false;
      if (host.kind === 'seq') {
        if (host.seg === 'listeners') {
          let newVal = r.via ? viaHostVal(host, r.via) : getA(cfg, host.path);
          if (newVal === undefined) return false;
          const ins = reindent(jsyaml.dump(newVal, dumpOpts).replace(/\n+$/, '').split('\n'), host.indent + 2);
          edits.push({ from: host.line, to: host.end, lines: [' '.repeat(host.indent) + (host.rawKey != null ? host.rawKey : String(host.seg)) + ':', ...ins] });
          return true;
        }
        return rebuildFlowHost(host, r.via);   // 流式序列：整行重建 [...]
      }
      if (host.kind!=='map') return false;
      let newHostVal;
      if(r.via){
        // 经合并键进入锚点内部：先把使用者侧的全部改动折算进锚点副本，再落本 op 的叶子
        const base = viaHostVal(host, r.via);
        const anchorOld = (base !== undefined && base !== null && typeof base === 'object')
          ? base : cloneDeepSafe(getA(orig, host.path) || {});
        const rel=node.path.slice(host.path.length);
        let cur=anchorOld;
        for(let i=0;i<rel.length-1;i++){
          if(typeof cur[rel[i]]!=='object' || cur[rel[i]]===null) cur[rel[i]]={};
          cur=cur[rel[i]];
        }
        cur[rel[rel.length-1]]=op.val;
        newHostVal=anchorOld;
      }else{
        newHostVal=getA(cfg, host.path);
        // 若 newHostVal 仍包含合并后的键，需基于 host 自身的 newHostVal（cfg 中已更新）
        // 对于直接子键（如 additional-prefix），newHostVal 已是更新后的 override 对象
      }
      if (host.seg === 'local') {
        const ins = reindent(jsyaml.dump(newHostVal, dumpOpts).replace(/\n+$/, '').split('\n'), host.indent + 2);
        edits.push({ from: host.line, to: host.end, lines: [' '.repeat(host.indent) + (host.rawKey != null ? host.rawKey : String(host.seg)) + ':', ...ins] });
        return true;
      }
      const flowStr=buildFlowStringForHost(host, newHostVal, orig, anchors);
      const newLine=flowHostLine(host, flowStr);
      edits.push({from: host.line, to: host.end, lines: [newLine]});
      if(r.via){
        props.push({kind:'set', path:[...host.path], val:newHostVal});
        for(const t of otherMergeTargets(r.via, op.path)) props.push({kind:'setIfEq', path:t, val:op.val, guard:getA(orig, node.path)});
      }
      for(const av of r.aliasVia){
        for(const au of aliasUsers) if(au.name===av.anchorName && au.node!==av.userNode) props.push({kind:'setIfEq', path:[...au.node.path, ...op.path.slice(av.segIdx)], val:op.val, guard:getA(orig, node.path)});
      }
      if(node.anchorName){
        for(const au of aliasUsers) if(au.name===node.anchorName && au.node!==node) props.push({kind:'set', path:[...au.node.path], val:op.val});
      }
      return true;
    }
    // 原值是流式（[...] / {...}）时整值替换也用流式写回，
    // 避免把 `ports: [80, 8080-8880]` 这类写法摊成块列表
    let flowStyle = false;
    if ((node.kind === 'map' || node.kind === 'seq') && node.childIndent < 0) {
      if (node.seg !== 'local') {
        const kids = node.children ? [...(node.children instanceof Map ? node.children.values() : node.children)] : [];
        flowStyle = kids.length > 0 ? kids.every(c => c.inFlow) : /^[ \t]*(?:-[ \t]+)?[^:#\s][^:]*:[ \t]*[{\[]/.test(lines[node.line] || '');
      }
    }
    edits.push({ from: node.line, to: node.end, lines: valueBlock(node, op.val, flowStyle) });
    if (node.anchorName) {                                      // 改了锚点定义行：别名引用者同步
      for (const au of aliasUsers) if (au.name === node.anchorName && au.node !== node)
        props.push({ kind: 'set', path: [...au.node.path], val: op.val });
    }
    if (r.via) {                                                // 经由合并键改到锚点内：其他使用者同步
      const guard = getA(orig, node.path);
      props.push({ kind: 'set', path: [...node.path], val: op.val });
      for (const t of otherMergeTargets(r.via, op.path))
        props.push({ kind: 'setIfEq', path: t, val: op.val, guard });
    }
    for (const av of r.aliasVia) {                              // 经由别名跳进锚点内：引用者同步
      for (const au of aliasUsers) if (au.name === av.anchorName && au.node !== av.userNode)
        props.push({ kind: 'setIfEq', path: [...au.node.path, ...op.path.slice(av.segIdx)], val: op.val, guard: getA(orig, node.path) });
    }
    return true;
  };
  const applyDel = (op) => {
    const r = resolvePath(tree, op.path);
    if (!r) return false;
    // 【被继承键遮蔽的本地键】条目同时有 `<<: *anchor` 和本地同名行（如 rule-providers
    // 里 `<<: *domain` 之外又写了 `format: yaml`）。删掉本地那一行后，这个键并不会消失
    // ——它会退回锚点继承来的值。cfg 侧却以为整个键没了，安全网一比对必然 mismatch，
    // 整份配置被降级到块状层重排（用户表现：锚点被展开、`<<:` 全部铺平）。
    // 正确语义：本地覆写撤销 = 回落到继承值。文本删行照旧，cfg 侧按继承值放回。
    if (!r.via && r.node && r.node.parent && r.node.parent.kind === 'map'
        && r.node.parent.merges && r.node.parent.merges.length) {
      const seg = op.path[op.path.length - 1];
      const shadow = lookupMerge(r.node.parent, seg, tree.anchors, 0);
      if (shadow && shadow.node && shadow.node.path) {
        const inherited = getA(orig, shadow.node.path);
        if (inherited !== undefined) props.push({ kind: 'set', path: [...op.path], val: cloneDeepSafe(inherited) });
      }
    }
    if (r.via) {
      // 键/项只存在于 <<: 合并继承（本地没有对应行）。「写穿」进锚点删 还是 保持不动，
      // 取决于意图：
      //   · 删共享容器内部的项（如 override-expr 表达式）＝内容编辑：与 set/add 同语义
      //     （这两者对多使用者也是写穿锚点的），一律写穿——数组里删掉末项不产生兄弟项 set，
      //     若按「同批有无 set」判意图，会变成「删中间生效、删最后一条静默丢失」。
      //   · 其余是清理式删除（删继承键本身，如订阅切 file 时界面清掉从 <<: *providers 继承的
      //     interval/proxy）：共享锚点不能动，文本不动、安全网比对前按原值放回。
      const users = mergeUsers.filter(m => m.name === r.via.anchorName);
      const inContainer = r.via.segIdx < op.path.length - 1;    // 删的是共享容器内部项（如表达式）而非继承键本身
      const writeThru = users.length <= 1 || inContainer;       // 单使用者波及面为零，键级清理同样可直删
      if (!writeThru) {
        props.push({ kind: 'restore', path: [...op.path], val: getA(orig, op.path) });
        return true;
      }
      // 写穿：沿用下面的通用逻辑，直接删在锚点本体上（r.node 已在锚点侧），
      // cfg 同步由后续的 via props（del + delIfEq 传导）完成。
    }
    const n = r.node;
    if (n.inFlow){
      let host=n.parent;
      while(host && host.inFlow) host=host.parent;
      if(!host) return false;
      if (host.kind === 'seq') return rebuildFlowHost(host, r.via);   // 流式序列：整行重建 [...]
      if (host.kind!=='map') return false;
      // 流式宿主整行重建：值取 cfg（已含本次全部删除）。
      // 不能基于 orig 只删单键——同一 host 多键删除（如订阅切 file 类型删 url/interval/…）
      // 会生成互相冲突的同范围编辑，合并后语义不符被安全网拦下，最终回退整文件重排
      let hostVal;
      if (r.via) {
        // 锚点侧宿主：cfg 里的锚点还没被改（改的是使用者副本），必须自己折算
        hostVal = viaHostVal(host, r.via);
        if (hostVal && typeof hostVal === 'object') {
          const rel = n.path.slice(host.path.length);
          let cur = hostVal;
          for (let i = 0; i < rel.length - 1 && cur && typeof cur === 'object'; i++) cur = cur[rel[i]];
          if (rel.length && cur && typeof cur === 'object') {
            const last = rel[rel.length - 1];
            if (Array.isArray(cur)) { if (typeof last === 'number' && last < cur.length) cur.splice(last, 1); }
            else delete cur[last];
          }
        }
        if (hostVal === undefined) hostVal = getA(cfg, host.path);
      } else hostVal = getA(cfg, host.path);
      if(hostVal===undefined || hostVal===null || typeof hostVal!=='object') return false;
      const flowStr=buildFlowStringForHost(host, hostVal, orig, anchors);
      const newLine=flowHostLine(host, flowStr);
      edits.push({from: host.line, to: host.end, lines: [newLine]});
      if(r.via){
        props.push({kind:'del', path:[...n.path]});
        for(const t of otherMergeTargets(r.via, op.path)) props.push({kind:'delIfEq', path:t, guard:getA(orig, n.path)});
        // 删空后宿主变成 `&host {  }`：silentDelA 会把空父级一并摘掉，这里按文本放回空映射
        props.push({ kind: 'ensureEmpty', path: [...host.path] });
      }
      return true;
    }
    // 本批删空整个块式序列：塌缩成 `key: []`
    if (n.parent && n.parent.kind === 'seq' && fullSeqDel.has(n.parent)) {
      const seqN = n.parent;
      const line = ' '.repeat(seqN.indent) + (seqN.rawKey != null ? seqN.rawKey : String(seqN.seg)) + ':' + (seqN.anchorName ? ' &' + seqN.anchorName : '') + ' []';
      edits.push({ from: seqN.line, to: seqN.end, lines: [line] });
      if (r.via) {
        props.push({ kind: 'del', path: [...n.path] });
        for (const t of otherMergeTargets(r.via, op.path)) props.push({ kind: 'delIfEq', path: t, guard: getA(orig, n.path) });
      }
      return true;
    }
    // 被删的是父容器唯一子项/子键：删完只剩裸 `key:` 会被解析成 null，
    // 与 cfg 里的空 [] / {} 不符——父容器整段改写成单行 `key: []` / `key: {}`。
    // （锚点定义同理，否则 `k: &a` 悬空还会让 <<: *a 合并直接解析报错）
    if (n.parent && n.parent !== root && !n.parent.inFlow && !n.parent.inlineSeq
        && n.parent.parent && n.parent.parent.kind === 'map'
        && ((n.parent.kind === 'seq' && n.parent.children.length === 1)
            // map 带 <<: 合并时删掉唯一显式键并不变空（继承键仍在），不能塌缩
            || (n.parent.kind === 'map' && n.parent.children.size === 1 && !(n.parent.merges && n.parent.merges.length)))) {
      const hostN = n.parent;
      const empty = hostN.kind === 'seq' ? ' []' : ' {}';
      const line = ' '.repeat(hostN.indent) + (hostN.rawKey != null ? hostN.rawKey : String(hostN.seg)) + ':' + (hostN.anchorName ? ' &' + hostN.anchorName : '') + empty;
      edits.push({ from: hostN.line, to: hostN.end, lines: [line] });
      if (r.via) {
        props.push({ kind: 'del', path: [...n.path] });
        for (const t of otherMergeTargets(r.via, op.path)) props.push({ kind: 'delIfEq', path: t, guard: getA(orig, n.path) });
      }
      if (empty === ' {}') props.push({ kind: 'ensureEmpty', path: [...hostN.path] });
      return true;
    }
    let from = n.line, to = n.end, repl = [];
    if (n.kind === 'alias') { /* 删别名行本身：锚点定义不动 */ }
    else if (n.inlineSeq) {                                     // 删行内首键：下一个兄弟键提为项首
      const sibs = [...n.parent.children.values()].filter(c => c !== n);
      const next = sibs.filter(c => c.line > n.end).sort((a, b) => a.line - b.line)[0];
      if (next) {
        if (next.line !== n.end + 1) return false;
        to = next.line;
        repl = [' '.repeat(n.parent.indent) + '- ' + lines[next.line].slice(next.indent)];
      } else repl = [' '.repeat(n.parent.indent) + '- {}'];
    }
    if (n.parent === root) {                                    // 顶层键：连同上方空行/段头注释
      let j = from - 1;
      while (j >= 0 && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j--;
      if (j >= 0) from = j + 1;
    }
    edits.push({ from, to, lines: repl });
    if (r.via) {
      const guard = getA(orig, n.path);
      props.push({ kind: 'del', path: [...n.path] });
      for (const t of otherMergeTargets(r.via, op.path))
        props.push({ kind: 'delIfEq', path: t, guard });
    }
    return true;
  };
  const applyAdd = (op) => {
    const p = op.path.slice(0, -1);
    const seg = op.path[op.path.length - 1];
    const r = resolvePath(tree, p, true);
    if (!r) return false;
    const n = r.node;
    if (n.inFlow){
      // 容器是流式宿主，新增键时重建 flow
      let host=n;
      while(host && host.inFlow) host=host.parent;
      // n 本身可能就是流式宿主（如 override），也可能是其子为流式
      // 若 n.inFlow，则 host 为其父流式宿主；否则 n 即为宿主
      if(n.inFlow){
        host=n.parent;
        while(host && host.inFlow) host=host.parent;
      }else{
        host=n;
      }
      if(!host) return false;
      const viaBase = r.via ? viaHostVal(host, r.via) : undefined;
      const hostVal = (viaBase !== undefined && viaBase !== null && typeof viaBase === 'object')
        ? viaBase : cloneDeepSafe(getA(cfg, host.path) || getA(orig, host.path) || {});
      // 新增键沿「物理路径」（别名/合并解引用后的节点路径）安放，不能用 op 原路径——
      // 经合并键进来的原路径在使用者侧（如 proxy-providers.X.health-check），而 host 在
      // 锚点侧（如 代理合集），用原路径切片会把两个命名空间拼混，写出幽灵键。
      const rel=r.node.path.slice(host.path.length);
      let cur=hostVal;
      for(let i=0;i<rel.length;i++){
        if(typeof cur[rel[i]]!=='object' || cur[rel[i]]===null) cur[rel[i]]={};
        cur=cur[rel[i]];
      }
      cur[seg]=op.val;
      const flowStr=buildFlowStringForHost(host, hostVal, orig, anchors);
      const newLine=flowHostLine(host, flowStr);
      edits.push({from: host.line, to: host.end, lines: [newLine]});
      if(r && r.via){
        props.push({kind:'set', path:[...r.node.path, seg], val:op.val});
        for(const t of otherMergeTargets(r.via, op.path)) props.push({kind:'addIfAbsent', path:t, val:op.val});
      }
      return true;
    }
    if (n.kind === 'map') {
      if (n.children.has(seg)) return false;
      if (n.childIndent < 0) {
        // 流式宿主（`x: { ... }` / `x: [...]`）：无块缩进可依，不能按行插入——
        // 整行重建 flow 文本，保持 {} / [] 写法。值取自 cfg（已含本次所有新增），
        // 多个键同时新增时各 op 生成相同编辑，由合并步骤去重。
        // 仅含合并键的流式映射（`x: { <<: *a }`）children 为空（合并键不是子节点），
        // 须按 merges 判定为流式宿主，否则放弃整行插入、整段坠到块状层重排
        let isFlowHost = n.children.size > 0 || (n.merges && n.merges.length > 0);
        for (const c of n.children.values()) if (!c.inFlow) { isFlowHost = false; break; }
        // 空流式 `{}` 占位（如 `proxy-providers: {}`）也按流式宿主整行重建补键
        if (!isFlowHost && n.children.size === 0 && /\{\s*\}\s*(#.*)?$/.test(lines[n.line] || '')) isFlowHost = true;
        if (!isFlowHost) return false;
        if (n.kind === 'seq') return rebuildFlowHost(n, r.via);
        const hostVal = JSON.parse(JSON.stringify(getA(cfg, n.path) || getA(orig, n.path) || {}));
        if (n.seg === 'local') {
          const ins = reindent(jsyaml.dump(hostVal, dumpOpts).replace(/\n+$/, '').split('\n'), n.indent + 2);
          edits.push({ from: n.line, to: n.end, lines: [' '.repeat(n.indent) + (n.rawKey != null ? n.rawKey : String(n.seg)) + ':', ...ins] });
          return true;
        }
        const flowStr = buildFlowStringForHost(n, hostVal, orig, anchors);
        // 行首统一走 flowHostLine：流式序列条目（出站节点一行式 `- { name: …, … }`）以前在这里被
        // 按「键: 值」拼成 `0: { … }`（拿数组下标当键），安全网报 bad indentation —— 给一行式节点
        // 新增任何字段（打开 TLS、跳过证书验证、切换传输层补 ws-opts…）都会让整段节点被重排。
        // 同一宿主的其他 op（set/del）也走 flowHostLine，产出同一行文本，合并时自然去重。
        const newLine = flowHostLine(n, flowStr);
        edits.push({ from: n.line, to: n.end, lines: [newLine] });
        return true;
      }
      const ins = reindent(jsyaml.dump({ [seg]: op.val }, dumpOpts).replace(/\n+$/, '').split('\n'), n.childIndent);
      edits.push({ from: n.end + 1, to: n.end, lines: n === root ? [''].concat(ins) : ins });
      if (r.via) {
        props.push({ kind: 'set', path: [...n.path, seg], val: op.val });
        for (const t of otherMergeTargets(r.via, op.path))
          props.push({ kind: 'addIfAbsent', path: t, val: op.val });
      }
      return true;
    }
    if (n.kind === 'seq') {
      const base = seqAppends.get(n) ?? n.children.length;        // 期望下标：本批已顺延过则以其为准
      if (seg < (seqAppends.get(n) ?? 0)) return true;           // 本批已整块重建过：直接跳过
      if (seg !== base) return false;                            // 只允许尾部追加（同批连加多项按已追加数顺延）
      if (n.childIndent < 0) {
        // 空流式 `[]` 占位：如果是 listeners，展开为块式序列
        if (n.children.length === 0 && /\[\s*\]\s*(#.*)?$/.test(lines[n.line] || '')) {
          const preferBlock = n.seg === 'listeners';
          if (preferBlock) {
            const mLine = lines[n.line];
            const m = mLine.match(/^([ \t]*)([^:#\s][^:]*?)([ \t]*):[ \t]*\[\s*\](.*)$/);
            if (m) {
              const head = m[1] + m[2] + m[3] + ':' + (m[4] && m[4].trim() ? ' ' + m[4].trim() : '');
              const newVal = r.via ? viaHostVal(n, r.via) : (getA(cfg, n.path) || [op.val]);
              const itemIndent = n.indent + 2;
              const ins = reindent(jsyaml.dump(newVal, dumpOpts).replace(/\n+$/, '').split('\n'), itemIndent);
              edits.push({ from: n.line, to: n.line, lines: [head, ...ins] });
              seqAppends.set(n, (newVal && newVal.length) ? newVal.length : base + 1);
              if (r.via) {
                props.push({ kind: 'set', path: [...n.path, seg], val: op.val });
                for (const t of otherMergeTargets(r.via, op.path))
                  props.push({ kind: 'addIfAbsent', path: t, val: op.val });
              }
              return true;
            }
          }
          if (rebuildFlowHost(n, r.via)) { seqAppends.set(n, base + 1); return true; }
          return false;
        }
        // 流式序列宿主（`x: [...]`）：整行重建，保持 [] 写法
        if (n.children.length > 0 && n.children.every(c => c.inFlow)) {
          if (n.seg === 'listeners') {
            const newVal = r.via ? viaHostVal(n, r.via) : (getA(cfg, n.path) || [op.val]);
            const itemIndent = n.indent + 2;
            const ins = reindent(jsyaml.dump(newVal, dumpOpts).replace(/\n+$/, '').split('\n'), itemIndent);
            edits.push({ from: n.line, to: n.end, lines: [' '.repeat(n.indent) + (n.rawKey != null ? n.rawKey : String(n.seg)) + ':', ...ins] });
            seqAppends.set(n, (newVal && newVal.length) ? newVal.length : base + 1);
            return true;
          }
          if (rebuildFlowHost(n, r.via)) { seqAppends.set(n, base + 1); return true; }
          return false;
        }
        return false;
      }
      const ins = reindent(jsyaml.dump([op.val], dumpOpts).replace(/\n+$/, '').split('\n'), n.childIndent);
      edits.push({ from: n.end + 1, to: n.end, lines: ins });     // 同宿主多条追加落在同一插入点，按 ops 顺序拼接
      seqAppends.set(n, base + 1);
      if (r.via) {
        props.push({ kind: 'set', path: [...n.path, seg], val: op.val });
        for (const t of otherMergeTargets(r.via, op.path))
          props.push({ kind: 'addIfAbsent', path: t, val: op.val });
      }
      return true;
    }
    return false;
  };

  const applyRename = (pair) => {
    const r = resolvePath(tree, pair.del.path);
    if (!r) return false;
    // 经别名跳进锚点内部的改名：会改到共享锚点定义，波及所有使用者，交兜底
    if (r.aliasVia && r.aliasVia.length) return false;
    const n = r.node;
    if (n.inFlow || n.inlineSeq || n.kind === 'seq') return false;   // 流式内部 / 行内项 / 列表体：交兜底
    if (!n.parent || n.parent.kind !== 'map') return false;
    const line = lines[n.line];
    const m = line.match(/^([ \t]*)([^:#\s][^:]*?)([ \t]*:)/);
    if (!m) return false;
    const oldRepr = n.rawKey != null ? n.rawKey : String(n.seg);
    if (m[2].trim() !== oldRepr.trim()) return false;                // 键行形态与预期不符，不强改
    const nk = String(pair.add.path[pair.add.path.length - 1]);
    const newRepr = /^[A-Za-z0-9_.-]+$/.test(nk) ? nk : JSON.stringify(nk);
    edits.push({ from: n.line, to: n.line, lines: [m[1] + newRepr + m[3] + line.slice(m[0].length)] });
    return true;
  };

  for (const p of renamePairs) {
    if (!applyRename(p)) return fail('rename ' + JSON.stringify({ del: p.del.path, add: p.add.path }));
  }
  // ---- 别名使用者实体化（materialize）----
  // op 路径穿过别名（或 set 正好落在别名节点）时，旧逻辑会「写穿」到锚点定义处：
  // 把单个使用者的本地改动泄漏给同锚点的所有使用者；flow 场景下更隐蔽——按锚点侧
  // 旧值（不含用户改动）重建锚点行，等于静默 no-op，被安全网拦下报
  // 「safety-net mismatch」，整段坠到块状层重排（锚点被展开、排版丢失）。
  // 正确语义：把该使用者的别名行替换为显式 flow 值（取 cfg 最终状态，已含本批
  // 全部改动），锚点定义与其他使用者保持不动。同批经同一别名使用者的多条 op
  // 算出同一实体化行，由 materializedAliasUsers 保证只写一次。
  const materializedAliasUsers = new Set();
  const materializeAliasUser = (aliasNode, val) => {
    if (materializedAliasUsers.has(aliasNode)) return true;
    if (aliasNode.line !== aliasNode.end) return false;            // 跨行别名（块式）：交兜底
    if (aliasNode.anchorName) return false;                        // `key: &a *x` 罕见形态：交兜底
    const line = lines[aliasNode.line] || '';
    const m = line.match(/^([ \t]*)([^:#\s][^:]*?)([ \t]*):[ \t]*(\*[^\s,\[\]{}#]+)([ \t]*(#.*)?)?$/);
    if (!m) return false;                                          // 形态不符（flow 内部别名等）：交兜底
    const v = (val === undefined) ? null : val;
    let dumped;
    try { dumped = jsyaml.dump({ v }, { ...dumpOpts, flowLevel: 1 }).replace(/\n+$/, ''); }
    catch (e) { return false; }
    if (dumped.indexOf('\n') !== -1) return false;                 // 摊不成单行：交兜底
    const head = dumped.slice(2).replace(/^[ ]+/, '');             // 去掉 'v:' 前缀
    edits.push({ from: aliasNode.line, to: aliasNode.end, lines: [m[1] + m[2] + m[3] + ':' + (head === '' ? '' : ' ' + head) + (m[5] || '')] });
    materializedAliasUsers.add(aliasNode);
    return true;
  };
  for (const op of opsDedup) {
    if (renamedOps.has(op)) continue;
    const r = resolvePath(tree, op.t === 'add' ? op.path.slice(0, -1) : op.path, op.t === 'add');
    // 例外：键本身经 <<: 合并继承时（哪怕锚点内部又把它写成 *别名，如
    // `自动选择: &auto { type: *type, interval: *interval, … }`），正解是在使用者条目里
    // 写一个本地覆盖键（applySet 会转成 applyAdd），而不是去实体化锚点里的别名行：
    // 那会改到同锚点的所有使用者，且流式锚点行根本实体化不了 —— 直接坠到块状兜底，
    // 整段的 <<: *auto 被展开、段前注释与空行全部重排。
    const mergeLeaf = !!(r && r.via && op.t === 'set' && r.via.segIdx === op.path.length - 1);
    const aliasUser = mergeLeaf ? null
      : (r && r.aliasVia && r.aliasVia.length) ? r.aliasVia[0].userNode
      : (op.t === 'set' && r && r.node && r.node.kind === 'alias') ? r.node : null;
    if (aliasUser) {
      if (!materializeAliasUser(aliasUser, getA(cfg, aliasUser.path))) return fail('materialize alias ' + JSON.stringify(op.path));
      continue;
    }
    const okv = op.t === 'set' ? applySet(op) : op.t === 'del' ? applyDel(op) : applyAdd(op);
    if (!okv) return fail('apply ' + op.t + ' ' + JSON.stringify(op.path));
  }
  edits.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const e of edits) {
    const last = merged[merged.length - 1];
    if (last && last.from === e.from && last.to === e.to) {
      // 同一位置的多个「纯插入」（from = to + 1）：一次给同一映射新增多个键时
      // （如订阅 file→http 同时补 url/interval），按 ops 顺序拼接而非判冲突——
      // 否则手术层放弃、掉到块状兜底，会把该顶层块里的锚点（<<: *x）、
      // {} 流式写法与注释整体重排掉。
      // （纯插入路径互不相同；lines 完全相同视为重复编辑，跳过不重复拼）
      if (e.from === e.to + 1) {
        if (last.lines.join('\n') !== e.lines.join('\n')) last.lines = last.lines.concat(e.lines);
        continue;
      }
      if (last.lines.join('\n') !== e.lines.join('\n')) return fail('same-pos conflict @' + e.from);
      continue;
    }
    if (last && e.from <= last.to) return fail('edit overlap @' + e.from);   // 区域重叠：交兜底
    merged.push(e);
  }
  const out = lines.slice();
  for (let k = merged.length - 1; k >= 0; k--) {                // 自底向上套用
    const e = merged[k];
    out.splice(e.from, e.to - e.from + 1, ...e.lines);
  }
  // 修复：历史版本曾把 proxy-providers 条目里的 `<<: *host` 误写成 6 空格
  // （`interval: 3600` 下的 `  <<: *host`），导致 js-yaml 报 bad indentation
  // 安全网失败坠到块状层，锚点丢失。手术层在最终拼装后做一次归一化：
  // 若 `<<:` 行缩进为 6 且上一非空行缩进为 4 且处于 proxy-providers 块内，拉回到 4
  for (let i = 0; i < out.length; i++) {
    const l = out[i];
    if (!l) continue;
    const m = l.match(/^(\s*)<<\s*:/);
    if (!m) continue;
    const ind = m[1].length;
    if (ind !== 6) continue;
    // 往前找上一非空非注释行
    let j = i - 1;
    while (j >= 0 && (!out[j].trim() || out[j].trim().startsWith('#'))) j--;
    if (j < 0) continue;
    const prevInd = (out[j].match(/^(\s*)/) || ['', ''])[1].length;
    if (prevInd !== 4) continue;
    // 确认处于 proxy-providers 块内（往上找 2 空格的条目行和顶层 proxy-providers）
    let k = j;
    let inPP = false;
    while (k >= 0) {
      const ll = out[k];
      if (!ll.trim() || ll.trim().startsWith('#')) { k--; continue; }
      const ki = (ll.match(/^(\s*)/) || ['', ''])[1].length;
      if (ki === 0 && /^proxy-providers\s*:/.test(ll)) { inPP = true; break; }
      if (ki === 2 && /:\s*$/.test(ll)) { /* 可能是条目头，继续往上找顶层 */ }
      if (ki < 4) break;
      k--;
    }
    if (!inPP) {
      // 更宽松：只要上一行是 4 缩进的键值行，且更上一层能找到 proxy-providers，就修复
      let t = j;
      while (t >= 0) {
        const ll = out[t];
        if (!ll.trim() || ll.trim().startsWith('#')) { t--; continue; }
        if (/^proxy-providers\s*:/.test(ll)) { inPP = true; break; }
        if (/^\s{0,2}[^\s].*:\s*$/.test(ll) && (ll.match(/^(\s*)/)[1].length <= 2)) break;
        t--;
      }
    }
    if (inPP) {
      out[i] = ' '.repeat(4) + l.trimStart();
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const text = out.join('\n') + (/\n$/.test(rawText) ? '\n' : '');
  // cfg 侧同步（锚点语义传导）——先在副本上跑，安全网通过后才提交回真正的 cfg。
  // 【关键】以前直接改 cfg：手术层若在最后一步失败（安全网不过 / 抛异常），这些
  // 半成品改动会留在 cfg 里，块状层就会把「被传导过的锚点块」当成有改动而整块
  // 重排——于是 `混淆覆写: &host` 掉锚点、`<<: *providers` 被展开。必须隔离。
  const applyProps = (o) => {
    for (const p of props) {
      if (p.kind === 'set') silentSetA(o, p.path, p.val);
      else if (p.kind === 'setIfEq' && yamlEq(getA(o, p.path), p.guard)) silentSetA(o, p.path, p.val);
      else if (p.kind === 'del') silentDelA(o, p.path);
      else if (p.kind === 'delIfEq' && yamlEq(getA(o, p.path), p.guard)) silentDelA(o, p.path);
      else if (p.kind === 'restore') silentSetA(o, p.path, p.val);   // 继承键免删：按原值放回
      else if (p.kind === 'ensureEmpty' && getA(o, p.path) === undefined) silentSetA(o, p.path, {});  // 塌缩宿主被顺带摘除：放回空映射与文本对齐
      else if (p.kind === 'addIfAbsent' && getA(o, p.path) === undefined) silentSetA(o, p.path, p.val);
    }
    // 锚点定义处被改（含经由别名传导）后，合并使用者的继承副本同步。
    // 护栏：使用者当前值仍等于原继承值才跟随锚点新值（本地覆写不动）。
    for (const mu of mergeUsers) {
      const srcNode = anchors.get(mu.name);
      if (!srcNode || srcNode.kind !== 'map') continue;
      const cur = getA(o, srcNode.path);
      const old = getA(orig, srcNode.path);
      if (!cur || typeof cur !== 'object' || !old || typeof old !== 'object' || yamlEq(cur, old)) continue;
      const u = getA(o, mu.node.path);
      const uOld = getA(orig, mu.node.path);
      if (!u || typeof u !== 'object' || !uOld || typeof uOld !== 'object') continue;
      for (const k of Object.keys(cur)) {
        if (yamlEq(cur[k], old[k])) continue;                   // 锚点该键没变
        if (yamlEq(u[k], old[k])) silentSetA(o, [...mu.node.path, k], cur[k]);
      }
      for (const k of Object.keys(old)) {                       // 锚点里被删掉的键：使用者同步删
        if (k in cur) continue;
        if (yamlEq(u[k], old[k])) silentDelA(o, [...mu.node.path, k]);
      }
    }
  };
  const hasProps = props.length > 0 || mergeUsers.length > 0;
  const probe = hasProps ? cloneDeepSafe(cfg) : cfg;            // 无传导时无需克隆
  if (hasProps) applyProps(probe);
  try {                                                         // 安全网：必须能解析回当前配置
    const back = jsyaml.load(text);
    if (!yamlEq(back == null ? {} : back, probe)) return fail('safety-net mismatch');
  } catch (e) { return fail('safety-net throw: ' + e.message); }
  if (hasProps) applyProps(cfg);                                // 全部通过，才把传导落到界面状态上
  return text;
}

// ---------------- 保存时保留排版（块状合并：第二层兜底） ----------------
// jsyaml.dump 是整份重排：原文件里的空行、段前注释保存后全部丢失，保存几次
// 整个 config.yaml 就“紧贴”在一起。改为按顶层键做块状合并：
//   · 原文每个顶层键 = 段头（紧邻其上的空行/注释行）+ 块体（键行到下一键前）；
//   · 新旧值深度相等 → 块体原样保留（块内注释、空行一并保住）；
//   · 有改动 → 仅重排该键（单键 dump），段头空行/注释照旧保留；
//   · 新增键追加到末尾（彼此空一行），删除键整块连同段头移除；
//   · 键与键之间原有几个空行就保留几个，不增也不减；
//   · 最后把合并结果重新解析并与当前配置深度比对，不一致（锚点/别名等复杂
//     排版被扰动、或切块误判）就整体退回全量 dump —— 语义绝不跑偏。

// 循环引用安全的深度相等（YAML 别名可造出环）
function yamlEq(a, b, seen = new Map()) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  let s = seen.get(a);
  if (!s) { s = new Set(); seen.set(a, s); }
  if (s.has(b)) return true;          // 环：按共同前缀处理
  s.add(b);
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => yamlEq(x, b[i], seen));
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && yamlEq(a[k], b[k], seen));
}

// ---- 流式样式保留（修复 {} 被自动换行） ----
// 把流式宿主（`key: { … }` / `- { … }`）按原文结构逐层重建成单行文本：
//   · 未改动的值（任意深度）直接搬原文里的生文本 —— 保住 "引号"、内部写法、&锚点、原有间距；
//   · 原文是流式映射、新值仍是映射：逐键递归，只重写真正变动的那一支；
//   · 其余变动交给 jsyaml 按「单行流式」序列化（集合恒为 {…}/[…]，含换行的字符串走双引号转义）。
// 以前只手写了两层：第三层起（出站节点一行式 `- { …, http-opts: { headers: { Host: [...] } } }`、
// `ws-opts.headers.Host`、`smux.brutal-opts.up`）改动值被按块式 dump 后只取第一行，拼出
// `headers: Host:` 这类非法文本；安全网报 missed comma 拦下后，整段坠到块状层重排。
function buildFlowStringForHost(hostNode, newHostVal, orig, anchorsMap){
  const DUMP = { lineWidth: -1, noRefs: true, sortKeys: false };
  const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  // 任意值 → 单行流式文本。必须包在流式序列 [ … ] 里序列化：标量是按「所在集合」的语境决定
  // 要不要加引号的——放在块式映射 { v: … } 里，`v, w` 这类带逗号的值会裸写出来，
  // 落进 { … } 就被拆成两个键。流式语境下逗号、括号、# 等都会被正确加引号，
  // 含换行的字符串也走双引号转义，集合恒为单行 {…}/[…]。
  const flowVal = (v) => {
    const d = jsyaml.dump([v], { ...DUMP, flowLevel: 0 }).replace(/\n+$/, '');
    if (d[0] !== '[' || d[d.length - 1] !== ']' || d.includes('\n')) throw new Error('流式值无法序列化为单行');
    return d.slice(1, -1).trim();
  };
  // 新增键的键名：需要时加引号（true / 123 / 含冒号等），判定交给 jsyaml
  const flowKey = (k) => {
    const d = jsyaml.dump({ [k]: 0 }, { ...DUMP, flowLevel: 0 }).trim();   // → "{键: 0}"
    return d.slice(1, d.lastIndexOf(':')).trim();
  };
  const keepRaw = (child, val) => {
    if (child.rawVal == null || child.rawVal === '') return null;
    return yamlEq(getA(orig, child.path), val) ? child.rawVal : null;
  };
  // <<: 合并源提供的键：新值与继承值相同 = 合并来的（不展开）；不同 = 本地覆写、没有 = 新增
  const mergedOf = (node) => {
    const src = new Map();
    for (const mm of node.merges || []) {
      const an = anchorsMap ? anchorsMap.get(mm) : null;
      const av = an ? getA(orig, an.path) : null;
      if (isMap(av)) for (const k of Object.keys(av)) if (!src.has(k)) src.set(k, av[k]);
    }
    return src;
  };
  const mapFlow = (node, val) => {
    const parts = [];
    for (const m of node.merges || []) parts.push('<<: *' + m);
    for (const [k, child] of node.children) {
      // 新值来自最终配置：其中已不存在的键视为本次删除，跳过（不复活）
      if (isMap(val) && !(k in val)) continue;
      const key = child.rawKey != null ? child.rawKey : String(child.seg);
      if (child.kind === 'alias') { parts.push(key + ': *' + child.aliasName); continue; }
      const v = isMap(val) ? val[k] : getA(orig, child.path);
      if (v === undefined) continue;
      parts.push(key + ': ' + valueFlow(child, v));
    }
    if (isMap(val)) {
      const merged = mergedOf(node);
      for (const kk of Object.keys(val)) {
        if (node.children.has(kk) || val[kk] === undefined) continue;
        if (merged.has(kk) && yamlEq(val[kk], merged.get(kk))) continue;
        parts.push(flowKey(kk) + ': ' + flowVal(val[kk]));
      }
    }
    return '{ ' + parts.join(', ') + ' }';
  };
  const valueFlow = (child, v) => {
    const raw = keepRaw(child, v);
    if (raw != null) return raw;
    const anchor = child.anchorName ? '&' + child.anchorName + ' ' : '';   // 重写时把流内锚点带回去，别处 *引用不悬空
    if (child.kind === 'map' && child.children && isMap(v)) return anchor + mapFlow(child, v);
    return anchor + flowVal(v);
  };
  return mapFlow(hostNode, newHostVal);
}


// 一行里未处于引号/注释内的净括号数（识别跨行的流式结构 [ ] { }）
function flowDelta(line) {
  let d = 0, q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) break;
    if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return d;
}

// 行尾是否为块标量指示符（| > 及其参数），是则返回该行缩进，否则 -1
function scalarIndentOf(line) {
  const t = line.replace(/\s+#.*$/, '').replace(/\s+$/, '');
  return /[|>](?:\d+)?[+-]?$/.test(t) ? t.match(/^[ \t]*/)[0].length : -1;
}

// 把原文按顶层键切块。返回 { preamble, blocks:[{key,header,body}], trailer }
function splitTopBlocks(rawText) {
  const lines = rawText.replace(/\r\n?/g, '\n').split('\n');
  const KEY_RE = /^([^:#\s][^:\n]*?):(?:\s|$)/;
  const isBlank = l => !l.trim();
  const isComment = l => /^[ \t]*#/.test(l);
  const preamble = [], blocks = [], trailer = [];
  let pending = [];        // 悬空的空行/注释：跟到下一个键就成为其段头，否则并入当前块
  let cur = null, flow = 0, bsIndent = -1, seenKey = false;

  for (const line of lines) {
    if (bsIndent >= 0) {                    // 块标量内容：空行或缩进比指示符更深
      if (isBlank(line) || line.match(/^[ \t]*/)[0].length > bsIndent) {
        (cur ? cur.body : preamble).push(...pending.splice(0), line);
        continue;
      }
      bsIndent = -1;                        // 缩进回落：块标量结束，按普通行处理
    }
    if (isBlank(line) || isComment(line)) { pending.push(line); continue; }
    const m = !/^-(\s|$)/.test(line) && flow === 0 ? line.match(KEY_RE) : null;
    if (m) {
      let key = m[1].trim();
      if (/^"(.*)"$/.test(key)) key = key.slice(1, -1).replace(/\\"/g, '"');
      else if (/^'(.*)'$/.test(key)) key = key.slice(1, -1).replace(/''/g, "'");
      if (!seenKey) { preamble.push(...pending.splice(0)); seenKey = true; }  // 文件头注释留在文件头
      else if (cur) blocks.push(cur);
      cur = { key, header: pending.splice(0), body: [line] };
    } else {
      (cur ? cur.body : preamble).push(...pending.splice(0), line);
    }
    flow = Math.max(0, flow + flowDelta(line));
    const si = scalarIndentOf(line);
    if (si >= 0) bsIndent = si;
  }
  if (cur) blocks.push(cur);
  trailer.push(...pending.splice(0));
  return { preamble, blocks, trailer };
}

// 保留排版的序列化：cfg = 当前配置对象，rawText = 保存前的原文
// 所有草稿提交立即使用；保存只写已同步、已校验的草稿
export let lastSaveLayer = 'full';   // 最近一次保存走的层：'surgical'（手术式，锚点/排版全保留）| 'blocks'（块状合并）| 'full'（全量重排）
export let lastPatchDebug = null;    // 手术层未能接管时的诊断信息（失败原因 + 操作清单），便于定位格式被重排的根因

export function dumpConfigKeepLayout(cfg, rawText) {
  const opts = { lineWidth: -1, noRefs: true, sortKeys: false };
  // 每次保存重置诊断：否则上一次保存留下的 reason 会被写进这一次的 save-fallback.log，
  // 排查时被引到错误方向（结构树切不动的静默降级尤其会留下上一次的旧 reason）。
  lastPatchDebug = null;
  const fallback = () => { lastSaveLayer = 'full'; return jsyaml.dump(cfg, opts); };
  let orig = null;
  let rawForWork = rawText;
  if (rawText && rawText.trim()) {
    try { const o = jsyaml.load(rawText); if (o && typeof o === 'object' && !Array.isArray(o)) orig = o; } catch (e) { orig = null; }
    // 原文本身因历史缩进错误（如 `<<: *host` 6 空格）导致解析失败时，先尝试修复再解析
    if (!orig) {
      const tryFix = rawText.split('\n').map((l, idx, arr) => {
        const m = l.match(/^(\s*)<<\s*:/);
        if (!m) return l;
        const ind = m[1].length;
        if (ind !== 6) return l;
        let j = idx - 1;
        while (j >= 0 && (!arr[j].trim() || arr[j].trim().startsWith('#'))) j--;
        if (j < 0) return l;
        const prevInd = (arr[j].match(/^(\s*)/) || ['', ''])[1].length;
        if (prevInd === 4) return ' '.repeat(4) + l.trimStart();
        return l;
      }).join('\n');
      if (tryFix !== rawText) {
        try {
          const o2 = jsyaml.load(tryFix);
          if (o2 && typeof o2 === 'object' && !Array.isArray(o2)) {
            orig = o2;
            rawForWork = tryFix;
            lastPatchDebug = { reasons: ['auto-repaired bad merge indent in orig'], ops: null };
          }
        } catch (e2) { /* 修复后仍失败，交 full */ }
      }
    }
  }
  if (!orig) return fallback();                        // 原文缺失/不可解析：无可保留
  // 后续手术层/块状层一律基于修复后的原文工作，避免修复只用于解析却未用于编辑
  // 第一层：锚点感知的手术式补丁（锚点/别名/合并键原样保留）。
  // 手术层内部任何异常都必须降级到下一层，而不是把整个保存带崩（曾因此出现
  // 「点保存无任何反应」的静默失败：RangeError 从 applyAdd 一路上抛无人接）。
  let patched = null;
  try { patched = patchConfigText(cfg, rawForWork, orig); } catch (e) { lastPatchDebug = { reasons: ['patch exception: ' + e.message], ops: null }; patched = null; }
  if (patched !== null) { lastSaveLayer = 'surgical'; return patched; }
  // 若手术层因缩进错误失败（如历史文件里 `<<: *host` 被写成 6 空格），尝试修复原文缩进后重跑手术层
  // 避免直接坠到块状层把锚点展开丢失
  const badIndent = lastPatchDebug && lastPatchDebug.reasons && lastPatchDebug.reasons.some(r => /bad indentation/i.test(r));
  if (badIndent) {
    const fixedRaw = rawForWork.split('\n').map((l, idx, arr) => {
      const m = l.match(/^(\s*)<<\s*:/);
      if (!m) return l;
      const ind = m[1].length;
      if (ind !== 6) return l;
      let j = idx - 1;
      while (j >= 0 && (!arr[j].trim() || arr[j].trim().startsWith('#'))) j--;
      if (j < 0) return l;
      const prevInd = (arr[j].match(/^(\s*)/) || ['', ''])[1].length;
      if (prevInd === 4) return ' '.repeat(4) + l.trimStart();
      return l;
    }).join('\n');
    if (fixedRaw !== rawForWork) {
      try {
        const o2 = jsyaml.load(fixedRaw);
        if (o2 && typeof o2 === 'object' && !Array.isArray(o2)) {
          const patched2 = patchConfigText(cfg, fixedRaw, o2);
          if (patched2 !== null) { lastSaveLayer = 'surgical'; return patched2; }
        }
      } catch (e) { /* 修复后仍失败，继续走块状 */ }
    }
  }
  const sp = splitTopBlocks(rawForWork);
  if (!sp.blocks.length) return fallback();            // 切不出顶层块（流式整体等）：兜底
  lastSaveLayer = 'blocks';

  const out = [];
  sp.preamble.forEach(l => out.push(l));
  const emitted = new Set();
  for (const b of sp.blocks) {
    if (emitted.has(b.key)) continue;                  // 重复键：只认首次出现的位置
    if (!Object.prototype.hasOwnProperty.call(cfg, b.key) || cfg[b.key] === undefined) continue;  // 已删除
    emitted.add(b.key);
    b.header.forEach(l => out.push(l));                // 段头空行/注释：原样保留
    if (yamlEq(orig[b.key], cfg[b.key])) { b.body.forEach(l => out.push(l)); continue; }   // 未改动：整块原文
    const dumped = jsyaml.dump({ [b.key]: cfg[b.key] }, opts).replace(/\n+$/, '').split('\n');
    // 该顶层键原来带锚点（`混淆覆写: &host`）时，重排也要把锚点带回去：
    // 否则别处的 `<<: *host` / `*host` 变成悬空引用，整份文件直接退到全量重排。
    const am = (b.body[0] || '').match(/^([^:#]*):[ \t]+&([^\s{}[\],]+)/);
    if (am && dumped.length && !/:/.test(b.key)) {
      const km = dumped[0].match(/^([^:]*:)([ \t]*)(.*)$/);
      if (km) dumped[0] = km[1] + ' &' + am[2] + (km[3] ? ' ' + km[3] : '');
    }
    out.push(...dumped);
  }
  // 新增的顶层键：追加到末尾，彼此之间空一行
  Object.keys(cfg).filter(k => !emitted.has(k) && cfg[k] !== undefined).forEach(k => {
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push(...jsyaml.dump({ [k]: cfg[k] }, opts).replace(/\n+$/, '').split('\n'));
  });
  sp.trailer.forEach(l => out.push(l));
  while (out.length && out[out.length - 1] === '') out.pop();   // 结尾不留空行
  // 结尾换行跟原文保持一致：原文没有就不添（不改动 = 文件一字节都不动）
  const text = out.join('\n') + (/\n$/.test(rawForWork) ? '\n' : '');
  // 安全网：合并结果必须能解析回当前配置，否则退回全量 dump
  // （纯注释/空文件 parse 得 null/undefined，语义就是空映射，归一成 {} 再比）
  try {
    const back = jsyaml.load(text);
    if (!yamlEq(back == null ? {} : back, cfg)) return fallback();
  } catch (e) { return fallback(); }
  lastSaveLayer = 'blocks';
  return text;
}

// ---------------- YAML 锚点手术（一级条目 &/<<、二级字段 <</* 引用（&定义已下线）、
// 新建顶层定义块 newtop（键体随 cfg 由 dump 层写出，此处挂 &名 并移到文件头）、全局改名/摘定义） ----------------
// 约定：锚点语法只在 raw 中保存（jsyaml 会展开它）。commitConfigEdit 在用户确认时
// 立即做行级手术并回解析对齐 cfg，产物必须「可重解析 + 无悬空别名」，失败不提交。
const esc_ = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ANCHOR_NAME_OK = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

// mihomo 内核真正会读的顶层配置段。删锚点时这些块只摘 &名、保留块体（内核还在用）；
// 其余顶层键都是「为挂 &名 而存在」的自建容器（工具页新建的 代理合集/测试 之类），
// 删锚点就连整块删干净，不留 `键: 值` 残块。
const MIHOMO_TOP_KEYS = new Set([
  'port', 'socks-port', 'redir-port', 'tproxy-port', 'mixed-port', 'bind-address',
  'mode', 'log-level', 'ipv6', 'allow-lan', 'skip-auth-prefixes', 'authentication',
  'unified-delay', 'tcp-concurrent', 'interface-name', 'routing-mark', 'find-process-mode',
  'global-client-fingerprint', 'keep-alive-idle', 'keep-alive-interval',
  'external-controller', 'external-controller-cors', 'external-controller-pipe',
  'external-controller-unix', 'external-doh-server', 'external-ui', 'external-ui-url',
  'external-ui-name', 'secret', 'geox-url', 'geo-auto-update', 'geo-update-interval',
  'geodata-mode', 'geodata-loader', 'geo-auto-private-network',
  'tun', 'ebpf', 'dns', 'sniffer', 'hosts', 'ntp', 'profile', 'script', 'experimental', 'tls',
  'iptables', 'listeners', 'proxies', 'proxy-groups', 'rules', 'sub-rules',
  'rule-providers', 'proxy-providers',
]);

// 逐字符定位「非引号/注释」裸文本区间：&定义 与 *引用 只算裸文本
function bareMask(line) {
  const mask = new Array(line.length).fill(true);
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      mask[i] = false;
      if (c === q) { if (line[i + 1] === q) { mask[i + 1] = false; i++; } else q = null; }
    } else if (c === '"' || c === "'") { mask[i] = false; q = c; }
    else if (c === '#') { for (let j = i; j < line.length; j++) mask[j] = false; break; }
  }
  return mask;
}
function anchorsOnLine(line) {
  const mask = bareMask(line); const defs = []; const refs = [];
  for (const m of line.matchAll(/[&]([^\s,[\]{}#]+)/g)) if (mask[m.index]) defs.push(m[1]);
  for (const m of line.matchAll(/[*]([^\s,[\]{}#]+)/g)) if (mask[m.index]) refs.push(m[1]);
  return { defs, refs };
}
export function scanYamlAnchors(text) {
  const defs = new Map(); const refs = new Map();
  String(text || '').split('\n').forEach(l => {
    const a = anchorsOnLine(l);
    a.defs.forEach(n => defs.set(n, (defs.get(n) || 0) + 1));
    a.refs.forEach(n => refs.set(n, (refs.get(n) || 0) + 1));
  });
  return { defs, refs };
}
function replaceTokInLine(line, from, to, isDef) {
  const mask = bareMask(line);
  const re = new RegExp((isDef ? '[&]' : '[*]') + esc_(from) + '(?=$|[\\s,[\\]{}#])', 'g');
  return line.replace(re, (m, idx) => (mask[idx] ? (isDef ? '&' : '*') + to : m));
}
function topRange(lines, topKey) {
  const start = lines.findIndex(l => new RegExp('^' + esc_(topKey) + '\\s*:(\\s|$|#)').test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (!/^\s/.test(l) && !l.startsWith('#')) { end = i; break; }
  }
  return [start + 1, end];
}
// ============================================================
// 官方字段顺序规范（Mihomo / MetaCubeX）
// ============================================================
export const OFFICIAL_TOP_ORDER = [
  // 1. General & Ports & Inbound Access
  'mixed-port', 'port', 'socks-port', 'redir-port', 'tproxy-port', 'shadowsocks-port',
  'mode', 'log-level', 'ipv6', 'allow-lan', 'bind-address',
  'lan-allowed-ips', 'lan-disallowed-ips', 'authentication', 'skip-auth-prefixes',
  'unified-delay', 'tcp-concurrent', 'interface-name', 'routing-mark', 'inbound-tproxy-mark',
  'external-controller', 'external-ui', 'secret', 'external-controller-tls', 'external-controller-cors',
  'external-ui-url', 'external-ui-name',
  // 2. Geo & Models
  'geodata-mode', 'geodata-loader', 'geo-auto-update', 'geo-update-interval', 'geox-url', 'geo-custom-url',
  'lgbm-auto-update', 'lgbm-update-interval', 'lgbm-url',
  // 3. Profile & Global
  'find-process-mode', 'global-client-fingerprint', 'global-ua',
  'keep-alive-idle', 'keep-alive-interval', 'disable-keep-alive', 'profile',
  // 4. Sniffer
  'sniffer',
  // 5. Inbounds & Experimental
  'tun', 'ebpf', 'iptables', 'listeners', 'experimental',
  // 6. DNS & NTP
  'dns', 'ntp',
  // 7. Hosts & TLS
  'hosts', 'tls',
  // 8. Proxies, Groups & Providers
  'proxies', 'proxy-groups', 'proxy-providers',
  // 9. Rules & Providers
  'rule-providers', 'sub-rules', 'rules'
];

export const OFFICIAL_INNER_ORDER = {
  'dns': [
    'enable', 'prefer-h3', 'listen', 'ipv6', 'use-hosts', 'use-system-hosts',
    'respect-rules', 'enhanced-mode', 'fake-ip-range', 'fake-ip-filter',
    'fake-ip-filter-mode', 'default-nameserver', 'nameserver', 'fallback',
    'fallback-filter', 'nameserver-policy', 'proxy-server-nameserver',
    'direct-nameserver', 'direct-nameserver-follow-policy'
  ],
  'fallback-filter': [
    'geoip', 'geoip-code', 'geosite', 'ipcidr', 'domain'
  ],
  'tun': [
    'enable', 'stack', 'device', 'auto-route', 'auto-redirect',
    'auto-detect-interface', 'dns-hijack', 'strict-route', 'mtu', 'gso',
    'gso-max-size', 'endpoint-independent-nat', 'udp-timeout', 'file-descriptor'
  ],
  'sniffer': [
    'enable', 'force-dns-mapping', 'parse-pure-ip', 'override-destination',
    'sniff', 'force-domain', 'skip-domain', 'sniff-dns-mapping', 'port-whitelist'
  ],
  'ebpf': [
    'redirect-to-tun', 'auto-redir', 'local', 'shared'
  ],
  'ntp': [
    'enable', 'server', 'port', 'interval', 'lookup-interface'
  ],
  'experimental': [
    'clash-core', 'v2ray-api', 'quic-go-disable-ecn', 'quic-go-disable-gso'
  ],
  'profile': [
    'store-selected', 'store-fake-ip'
  ],
  'proxy-providers': [
    'type', 'url', 'interval', 'proxy', 'path', 'header', 'format',
    'health-check', 'override', 'filter', 'exclude-filter', 'exclude-type'
  ],
  'proxy-providers-item': [
    'type', 'url', 'interval', 'proxy', 'path', 'header', 'format',
    'health-check', 'override', 'filter', 'exclude-filter', 'exclude-type'
  ],
  'health-check': [
    'enable', 'url', 'interval', 'timeout', 'lazy', 'expected-status'
  ],
  'proxy-groups': [
    'name', 'type', 'proxies', 'use', 'url', 'interval', 'timeout', 'tolerance',
    'lazy', 'expected-status', 'max-failed-times', 'hidden', 'icon',
    'uselightgbm', 'prefer-asn', 'include-all-providers', 'include-all-proxies', 'empty-fallback',
    'filter', 'exclude-filter', 'exclude-type', 'strategy', 'disable-udp',
    'interface-name', 'routing-mark'
  ],
  'proxy-groups-item': [
    'name', 'type', 'proxies', 'use', 'url', 'interval', 'timeout', 'tolerance',
    'lazy', 'expected-status', 'max-failed-times', 'hidden', 'icon',
    'uselightgbm', 'prefer-asn', 'include-all-providers', 'include-all-proxies', 'empty-fallback',
    'filter', 'exclude-filter', 'exclude-type', 'strategy', 'disable-udp',
    'interface-name', 'routing-mark'
  ],
  'rule-providers': [
    'type', 'behavior', 'url', 'path', 'interval', 'proxy', 'header', 'format'
  ],
  'rule-providers-item': [
    'type', 'behavior', 'url', 'path', 'interval', 'proxy', 'header', 'format'
  ],
  'proxies': [
    'name', 'type', 'server', 'port', 'password', 'uuid', 'cipher', 'alterId',
    'udp', 'tls', 'skip-cert-verify', 'servername', 'network',
    'ws-opts', 'grpc-opts', 'h2-opts', 'http-opts', 'reality-opts'
  ],
  'proxies-item': [
    'name', 'type', 'server', 'port', 'password', 'uuid', 'cipher', 'alterId',
    'udp', 'tls', 'skip-cert-verify', 'servername', 'network',
    'ws-opts', 'grpc-opts', 'h2-opts', 'http-opts', 'reality-opts'
  ]
};

export const OFFICIAL_FIELD_ORDER = OFFICIAL_INNER_ORDER;

export function findFieldInsertPos(lines, loc, fieldKey, topKey) {
  const { childInd: ci, li, childEnd } = loc;
  const order = OFFICIAL_FIELD_ORDER[topKey] || [];
  const targetRank = order.indexOf(fieldKey) >= 0 ? order.indexOf(fieldKey) : 999;
  const keyRe = new RegExp('^ {' + ci + '}(?:"?([A-Za-z0-9_.\\-]+)"?)\\s*:');
  let insertPos = -1;

  for (let i = li + 1; i < childEnd; i++) {
    const l = lines[i];
    if (!l || !l.trim() || l.trim().startsWith('#')) continue;
    const m = l.match(keyRe);
    if (m) {
      const k = m[1];
      if (k === '<<') continue; // <<: 锚点合并行始终置顶
      const r = order.indexOf(k) >= 0 ? order.indexOf(k) : 999;
      if (r > targetRank) {
        let ins = i;
        while (ins - 1 > li && lines[ins - 1].trim().startsWith('#') && lines[ins - 1].match(/^\s*/)[0].length >= ci) {
          ins--;
        }
        insertPos = ins;
        break;
      }
    }
  }

  if (insertPos === -1) {
    let lastNonBlank = li;
    for (let i = childEnd - 1; i > li; i--) {
      if (lines[i] && lines[i].trim()) {
        lastNonBlank = i;
        break;
      }
    }
    insertPos = lastNonBlank + 1;
  }
  return insertPos;
}

function extractKeyFromLine(line) {
  const m = line.match(/^\s*(?:-\s+)?(?:(<<)|"([^"]+)"|'([^']+)'|([^:#\s]+))\s*:/);
  if (!m) return null;
  return m[1] || m[2] || m[3] || m[4] || null;
}

function trimLines(lines) {
  let s = 0;
  while (s < lines.length && !lines[s].trim()) s++;
  let e = lines.length - 1;
  while (e >= s && !lines[e].trim()) e--;
  return lines.slice(s, e + 1);
}

// 条目字段排序位次：官方顺序里有的按序，没有的靠后（999，彼此保持原相对顺序）。
// `<<`（锚点合并引用）默认置顶（-1）；proxy-groups 条目排在 name 正下方（0.5）——
// 官方字段顺序以 name 开头，置顶会把锚点引用压在 name 上面，排底部又与 name 隔太远，
// 代理组条目改为 name 领头、`<<` 紧随其下、其余字段按官方序（其余段维持置顶不变，仅改代理组）。
const MERGE_AFTER_NAME_RANK = 0.5;
const entryRankOf = (key, order, mergeAfterName) =>
  key === '<<' ? (mergeAfterName ? MERGE_AFTER_NAME_RANK : -1) : (order && order.indexOf(key) >= 0 ? order.indexOf(key) : 999);

function reorderFlowObject(flowStr, order, mergeAfterName) {
  const m = String(flowStr).match(/^(\s*(?:[^:#\r\n]+:\s*)?(?:-\s+)?(?:&[^\s]+\s+)?)\{(.*)\}(\s*(?:#.*)?)$/);
  if (!m) return flowStr;
  const prefix = m[1];
  const inner = m[2];
  const suffix = m[3];

  const segs = splitTopLevel(inner);
  const items = segs.map(seg => {
    const km = seg.match(/^\s*(<<|"?([A-Za-z0-9_.\-]+)"?)\s*:/);
    const key = km ? (km[1] === '<<' ? '<<' : (km[2] || km[1]).replace(/^"|"$/g, '')) : '';
    let rank = entryRankOf(key, order, mergeAfterName);

    let formattedSeg = seg;
    if (key && OFFICIAL_INNER_ORDER[key] && /:\s*\{.*\}$/.test(seg)) {
      formattedSeg = reorderFlowObject(seg, OFFICIAL_INNER_ORDER[key]);
    }
    return { key, seg: formattedSeg, rank };
  });

  items.sort((a, b) => a.rank - b.rank);
  const newInner = items.map(x => x.seg).join(', ');
  return prefix + '{' + (newInner ? ' ' + newInner + ' ' : '') + '}' + suffix;
}

function splitMappingEntries(lines, expectedIndent) {
  const entries = [];
  let curComments = [];
  let curKey = null;
  let curLines = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const trimmed = l.trim();
    if (!trimmed) {
      if (curKey) curLines.push(l);
      else curComments.push(l);
      continue;
    }

    const indent = l.match(/^(\s*)/)[1].length;
    if (trimmed.startsWith('#')) {
      if (curKey && indent > expectedIndent) {
        curLines.push(l);
      } else {
        curComments.push(l);
      }
      continue;
    }

    if (indent === expectedIndent) {
      const k = extractKeyFromLine(l);
      if (k !== null) {
        if (curKey) {
          entries.push({ key: curKey, lines: trimLines(curLines) });
        }
        curKey = k;
        curLines = [...curComments, l];
        curComments = [];
        continue;
      }
    }

    if (curKey) {
      curLines.push(l);
    } else {
      curComments.push(l);
    }
  }

  if (curKey) {
    entries.push({ key: curKey, lines: trimLines(curLines) });
  }

  return { entries, trailing: curComments };
}

function reorderSeqItem(lines, seqIndent, order, mergeAfterName) {
  let dashLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() && !lines[i].trim().startsWith('#')) {
      dashLineIdx = i;
      break;
    }
  }
  if (dashLineIdx === -1) return lines;

  const itemComments = lines.slice(0, dashLineIdx);
  const itemBodyLines = lines.slice(dashLineIdx);

  const firstNonComment = itemBodyLines[0];
  if (/^\s*-\s+(?:&[^\s]+\s+)?\{.*\}\s*(?:#.*)?$/.test(firstNonComment)) {
    return itemComments.concat(itemBodyLines.map(l => {
      if (/^\s*-\s+(?:&[^\s]+\s+)?\{.*\}\s*(?:#.*)?$/.test(l)) {
        return reorderFlowObject(l, order, mergeAfterName);
      }
      return l;
    }));
  }

  const dashMatch = firstNonComment.match(/^(\s*-\s*(?:&[^\s]+\s*)?)(.*)$/);
  if (!dashMatch) return lines;

  const dashPrefix = dashMatch[1];
  const dashRest = dashMatch[2].trim();

  if (!dashRest) {
    const headerLine = firstNonComment;
    const bodyLines = itemBodyLines.slice(1);
    const firstField = bodyLines.find(l => l.trim() && !l.trim().startsWith('#'));
    if (!firstField) return lines;
    const fieldIndent = firstField.match(/^(\s*)/)[1].length;
    const { entries, trailing } = splitMappingEntries(bodyLines, fieldIndent);
    entries.sort((a, b) => entryRankOf(a.key, order, mergeAfterName) - entryRankOf(b.key, order, mergeAfterName));
    const newBody = entries.flatMap(e => e.lines).concat(trailing);
    return itemComments.concat([headerLine], newBody);
  }

  let spacesIndent = dashPrefix.replace(/-/g, ' ').length;
  if (itemBodyLines.length > 1) {
    const secondLine = itemBodyLines.slice(1).find(l => l.trim() && !l.trim().startsWith('#'));
    if (secondLine) {
      spacesIndent = secondLine.match(/^(\s*)/)[1].length;
    }
  }
  const spacesPrefix = ' '.repeat(spacesIndent);

  const convertedLines = [spacesPrefix + dashRest].concat(itemBodyLines.slice(1));
  const { entries, trailing } = splitMappingEntries(convertedLines, spacesIndent);
  if (entries.length === 0) return lines;

  entries.sort((a, b) => entryRankOf(a.key, order, mergeAfterName) - entryRankOf(b.key, order, mergeAfterName));

  const result = [];
  let isFirstEntry = true;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (isFirstEntry) {
      let keyLineFound = false;
      for (let j = 0; j < entry.lines.length; j++) {
        const l = entry.lines[j];
        if (!keyLineFound && l.startsWith(spacesPrefix)) {
          result.push(dashPrefix + l.slice(spacesPrefix.length));
          keyLineFound = true;
        } else {
          result.push(l);
        }
      }
      isFirstEntry = false;
    } else {
      result.push(...entry.lines);
    }
  }
  result.push(...trailing);
  return itemComments.concat(result);
}

function splitSequenceItems(lines, seqIndent) {
  const items = [];
  let curComments = [];
  let curItemLines = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const trimmed = l.trim();
    if (!trimmed) {
      if (curItemLines) curItemLines.push(l);
      else curComments.push(l);
      continue;
    }

    const indent = l.match(/^(\s*)/)[1].length;
    if (trimmed.startsWith('#')) {
      if (curItemLines && indent > seqIndent) {
        curItemLines.push(l);
      } else {
        curComments.push(l);
      }
      continue;
    }

    const isSeqStart = (indent === seqIndent && /^-\s*(?:.*)?$/.test(l.slice(indent)));
    if (isSeqStart) {
      if (curItemLines) {
        items.push(trimLines(curItemLines));
      }
      curItemLines = [...curComments, l];
      curComments = [];
      continue;
    }

    if (curItemLines) {
      curItemLines.push(l);
    } else {
      curComments.push(l);
    }
  }

  if (curItemLines) {
    items.push(trimLines(curItemLines));
  }

  return { items, trailing: curComments };
}

function reorderMappingBlock(lines, expectedIndent, order) {
  const { entries, trailing } = splitMappingEntries(lines, expectedIndent);
  if (entries.length === 0) return lines;

  // 映射型条目（规则集/代理集等）：`<<` 维持置顶（仅 proxy-groups 序列条目排到 name 下方）
  entries.sort((a, b) => entryRankOf(a.key, order) - entryRankOf(b.key, order));

  entries.forEach(entry => {
    if (OFFICIAL_INNER_ORDER[entry.key]) {
      const subOrder = OFFICIAL_INNER_ORDER[entry.key];
      let klIdx = -1;
      for (let i = 0; i < entry.lines.length; i++) {
        if (!entry.lines[i].trim().startsWith('#') && extractKeyFromLine(entry.lines[i]) === entry.key) {
          klIdx = i;
          break;
        }
      }
      if (klIdx >= 0) {
        const kl = entry.lines[klIdx];
        if (/:\s*\{.*\}\s*(?:#.*)?$/.test(kl)) {
          entry.lines[klIdx] = reorderFlowObject(kl, subOrder);
        } else {
          const subLines = entry.lines.slice(klIdx + 1);
          const firstSub = subLines.find(l => l.trim() && !l.trim().startsWith('#'));
          if (firstSub) {
            const subIndent = firstSub.match(/^(\s*)/)[1].length;
            if (subIndent > expectedIndent) {
              const reorderedSub = reorderMappingBlock(subLines, subIndent, subOrder);
              entry.lines = entry.lines.slice(0, klIdx + 1).concat(reorderedSub);
            }
          }
        }
      }
    }
  });

  return entries.flatMap(e => e.lines).concat(trailing);
}

function reorderSectionLines(key, lines) {
  if (lines.length === 0) return lines;
  let klIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('#') && extractKeyFromLine(lines[i]) === key) {
      klIdx = i;
      break;
    }
  }
  if (klIdx === -1) return lines;

  const headerLines = lines.slice(0, klIdx + 1);
  const keyLine = lines[klIdx];

  if (/:\s*\{.*\}\s*(?:#.*)?$/.test(keyLine) && OFFICIAL_INNER_ORDER[key]) {
    headerLines[headerLines.length - 1] = reorderFlowObject(keyLine, OFFICIAL_INNER_ORDER[key]);
    return headerLines.concat(lines.slice(klIdx + 1));
  }

  const bodyLines = lines.slice(klIdx + 1);
  if (bodyLines.length === 0) return lines;

  const firstContent = bodyLines.find(l => l.trim() && !l.trim().startsWith('#'));
  if (!firstContent) return lines;
  const childIndent = firstContent.match(/^(\s*)/)[1].length;

  if (key === 'proxy-groups' || key === 'proxies') {
    const itemOrder = key === 'proxy-groups' ? OFFICIAL_INNER_ORDER['proxy-groups-item'] : OFFICIAL_INNER_ORDER['proxies-item'];
    const { items, trailing } = splitSequenceItems(bodyLines, childIndent);
    // 仅代理组：条目内 `<<: *锚点` 排在 name 正下方；proxies 等其他段维持置顶
    const mergeAfterName = key === 'proxy-groups';
    const reorderedItems = items.map(it => reorderSeqItem(it, childIndent, itemOrder, mergeAfterName));
    return headerLines.concat(reorderedItems.flatMap(it => it)).concat(trailing);
  }

  if (key === 'proxy-providers' || key === 'rule-providers') {
    const itemOrder = key === 'proxy-providers' ? OFFICIAL_INNER_ORDER['proxy-providers-item'] : OFFICIAL_INNER_ORDER['rule-providers-item'];
    const { entries, trailing } = splitMappingEntries(bodyLines, childIndent);
    entries.forEach(entry => {
      let eKlIdx = -1;
      for (let i = 0; i < entry.lines.length; i++) {
        if (!entry.lines[i].trim().startsWith('#') && extractKeyFromLine(entry.lines[i]) === entry.key) {
          eKlIdx = i;
          break;
        }
      }
      if (eKlIdx >= 0) {
        const kl = entry.lines[eKlIdx];
        if (/:\s*\{.*\}\s*(?:#.*)?$/.test(kl)) {
          entry.lines[eKlIdx] = reorderFlowObject(kl, itemOrder);
        } else {
          const subLines = entry.lines.slice(eKlIdx + 1);
          const firstSub = subLines.find(l => l.trim() && !l.trim().startsWith('#'));
          if (firstSub) {
            const subIndent = firstSub.match(/^(\s*)/)[1].length;
            const reorderedSub = reorderMappingBlock(subLines, subIndent, itemOrder);
            entry.lines = entry.lines.slice(0, eKlIdx + 1).concat(reorderedSub);
          }
        }
      }
    });
    return headerLines.concat(entries.flatMap(e => e.lines)).concat(trailing);
  }

  if (OFFICIAL_INNER_ORDER[key]) {
    const reorderedBody = reorderMappingBlock(bodyLines, childIndent, OFFICIAL_INNER_ORDER[key]);
    return headerLines.concat(reorderedBody);
  }

  return lines;
}

function splitLeadingComments(rawComments) {
  const comments = trimLines(rawComments);
  if (comments.length === 0) return { header: [], keyComments: [] };

  let splitIdx = -1;
  for (let i = 0; i < comments.length; i++) {
    if (!comments[i].trim()) splitIdx = i;
  }
  if (splitIdx >= 0) {
    const header = trimLines(comments.slice(0, splitIdx));
    const keyComments = trimLines(comments.slice(splitIdx + 1));
    if (header.length > 0 && keyComments.length > 0) {
      return { header, keyComments };
    }
  }
  return { header: [], keyComments: comments };
}

export function tidyMihomoConfig(text) {
  const lines = String(text || '').split('\n');
  const topBlocks = [];
  let fileHeader = [];
  let curComments = [];
  let curKey = null;
  let curLines = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const trimmed = l.trim();
    if (!trimmed) {
      if (curKey) curLines.push(l);
      else curComments.push(l);
      continue;
    }

    const indent = l.match(/^(\s*)/)[1].length;
    if (trimmed.startsWith('#')) {
      if (curKey && indent > 0) {
        curLines.push(l);
      } else {
        curComments.push(l);
      }
      continue;
    }

    if (indent === 0) {
      const k = extractKeyFromLine(l);
      if (k !== null) {
        if (curKey) {
          topBlocks.push({ key: curKey, lines: trimLines(curLines) });
          curLines = [...curComments, l];
          curComments = [];
        } else {
          const split = splitLeadingComments(curComments);
          fileHeader = split.header;
          curLines = [...split.keyComments, l];
          curComments = [];
        }
        curKey = k;
        continue;
      }
    }

    if (curKey) {
      curLines.push(l);
    } else {
      curComments.push(l);
    }
  }

  if (curKey) {
    topBlocks.push({ key: curKey, lines: trimLines(curLines) });
  }

  let fileFooter = trimLines(curComments);

  topBlocks.forEach(b => {
    b.lines = reorderSectionLines(b.key, b.lines);
  });

  // Sort topBlocks: anchors stay before usages or in place
  topBlocks.sort((a, b) => {
    const keyLineA = a.lines.find(l => !l.trim().startsWith('#') && extractKeyFromLine(l) === a.key) || a.lines[0];
    const keyLineB = b.lines.find(l => !l.trim().startsWith('#') && extractKeyFromLine(l) === b.key) || b.lines[0];

    const isAnchorA = /&[^\s]/.test(keyLineA) && OFFICIAL_TOP_ORDER.indexOf(a.key) === -1;
    const isAnchorB = /&[^\s]/.test(keyLineB) && OFFICIAL_TOP_ORDER.indexOf(b.key) === -1;
    if (isAnchorA && !isAnchorB) return -1;
    if (!isAnchorA && isAnchorB) return 1;

    let idxA = OFFICIAL_TOP_ORDER.indexOf(a.key);
    let idxB = OFFICIAL_TOP_ORDER.indexOf(b.key);
    let rankA = idxA >= 0 ? idxA : 999;
    let rankB = idxB >= 0 ? idxB : 999;
    return rankA - rankB;
  });

  const outLines = [];
  if (fileHeader.length > 0) {
    outLines.push(...fileHeader, '');
  }

  let prevWasMulti = false;
  for (let i = 0; i < topBlocks.length; i++) {
    const b = topBlocks[i];
    const isMulti = b.lines.length > 1;
    if (i > 0 && (isMulti || prevWasMulti)) {
      outLines.push('');
    }
    outLines.push(...b.lines);
    prevWasMulti = isMulti;
  }

  if (fileFooter.length > 0) {
    outLines.push('', ...fileFooter);
  }
  // 保留原文件是否有结尾换行的习惯，不额外多加空行（用户要求：整理后底部不加空行）
  const hasTrailingNl = /\n$/.test(text);
  return outLines.join('\n') + (hasTrailingNl ? '\n' : '');
}

// 条目定位：map 型（providers 的 2 空格键行）/ seq 型（proxy-groups 的 2 空格 - 项，name 匹配）
export function locateEntry(textOrLines, topKey, entryKey, kind) {
  const lines = Array.isArray(textOrLines) ? textOrLines : String(textOrLines).split('\n');
  const rg = topRange(lines, topKey);
  if (!rg || !entryKey) return null;
  const keyRe = new RegExp('^ {2}(?:"' + esc_(entryKey) + '"|\'' + esc_(entryKey) + '\'|' + esc_(entryKey) + ')\\s*:');
  if (kind === 'seq') {
    let li = -1;
    for (let i = rg[0]; i < rg[1]; i++) if (/^ {2}-( |$)/.test(lines[i])) {
      let j = i + 1; for (; j < rg[1]; j++) { if (/^ {2}-( |$)/.test(lines[j])) break; if (lines[j].trim() && !/^\s/.test(lines[j])) break; }
      const keyAlt = '(?:' + esc_(entryKey) + '|"' + esc_(entryKey) + '"|' + "'" + esc_(entryKey) + "'" + ')';
      const nameRe = new RegExp('^(?: {4}| {2}-(?: &\\S+)? )name\\s*:\\s*' + keyAlt + '\\s*(#.*)?$');
      const flowNameRe = new RegExp('[{,]\\s*name\\s*:\\s*' + keyAlt + '\\s*[,}]');
      if (flowNameRe.test(lines[i]) || nameRe.test(lines[i]) || lines.slice(i, j).some((l, k) => k > 0 && nameRe.test(l))) { li = i; rg[1] = j; break; }
      i = j - 1;
    }
    if (li === -1) return null;
    return { lines, li, childInd: 4, childEnd: rg[1], flow: /- (?:&\S+ )?\{/.test(lines[li]) };
  }
  let li = -1;
  for (let i = rg[0]; i < rg[1]; i++) if (keyRe.test(lines[i])) { li = i; break; }
  if (li === -1) return null;
  let end = rg[1]; let childInd = 0;
  for (let i = li + 1; i < rg[1]; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const ind = l.match(/^\s*/)[0].length;
    if (ind <= 2) { end = i; break; }
    if (!childInd) childInd = ind;
  }
  if (!childInd) childInd = 4;
  const mv = lines[li].match(/:\s*(.*)$/);
  return { lines, li, childInd, childEnd: end, flow: !!(mv && /^\{.*\}\s*(#.*)?$/.test(mv[1].trim())) };
}
function splitTopLevel(body) {
  const segs = []; let depth = 0; let q = null; let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === q) { if (body[i + 1] === q) { cur += body[++i]; } else q = null; } continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) segs.push(cur);
  return segs.map(s => s.trim()).filter(Boolean);
}
// 单行流式对象行重建（条目 `- {..}` 与字段 `k: {..}` 通用）
function rewriteFlowLine(line, { dropMerge, addMerge, expandObj, localKeys }, Y = jsyaml) {
  const mLine = String(line).match(/^(\s*(?:[^:#]+:\s*)?(?:- )?)\{(.*)\}(\s*(?:#.*)?)$/);
  if (!mLine) return null;
  const segs = splitTopLevel(mLine[2]).filter(s => !(dropMerge && /^<<\s*:/.test(s)));
  if (expandObj && typeof expandObj === 'object') {
    for (const [k, v] of Object.entries(expandObj)) {
      if (k === '<<' || (localKeys && localKeys.has(k))) continue;
      if (segs.some(s => new RegExp('^"?' + esc_(k) + '"?\\s*:').test(s))) continue;
      let repr;
      try { repr = Y.dump({ [k]: v }, { lineWidth: -1, flowLevel: 0, noRefs: true, sortKeys: false }).replace(/\n+$/, '').replace(/^\{\s*|\s*\}$/g, ''); } catch (e) { continue; }
      segs.push(repr.trim());
    }
  }
  if (addMerge) segs.unshift('<<: *' + addMerge);
  return mLine[1] + '{' + (segs.length ? ' ' + segs.join(', ') + ' ' : '') + '}' + mLine[3];
}
// 解除/换绑继承前把「cfg 视图有、文本行上没有」的字段物化，防纯继承字段随删行丢失
function materializeMergeFields(lines, li, childInd, childEnd, flow, expandObj, Y, dropMerge = false, addMerge = null) {
  if (!expandObj || typeof expandObj !== 'object') return { lines, childEnd };
  const keyRe = new RegExp('^ {' + childInd + '}"?([A-Za-z0-9_.\\-]+)"?\\s*:');
  const local = new Set();
  for (let i = li + 1; i < childEnd; i++) { const m = lines[i] && lines[i].match(keyRe); if (m) local.add(m[1]); }
  // seq 条目首字段可能直接写在 dash 行上（`- name: xxx`）：同样是本地字段，必须计入。
  // 漏掉它会把同名键再物化一行 → duplicated mapping key，重解析失败、整次提交被拒。
  if (!flow) {
    const dm = lines[li] && lines[li].match(/^\s*-(?:\s+&[^\s]+)?\s+(.*)$/);
    const km = dm && dm[1].trim().match(/^"?([A-Za-z0-9_.\-]+)"?\s*:/);
    if (km) local.add(km[1]);
  }
  if (flow) {
    const nl = rewriteFlowLine(lines[li], { dropMerge, addMerge, expandObj, localKeys: local }, Y);
    if (nl == null) return { lines, childEnd };
    return { lines: lines.slice(0, li).concat(nl, lines.slice(li + 1)), childEnd, flowRewrote: true };
  }
  const ins = [];
  for (const [k, v] of Object.entries(expandObj)) {
    if (k === '<<' || local.has(k)) continue;
    let dumped;
    try { dumped = jsyaml.dump({ [k]: v }, { lineWidth: -1, noRefs: true, sortKeys: false }).replace(/\n+$/, ''); } catch (e) { continue; }
    dumped.split('\n').forEach(l => ins.push(l.trim() ? ' '.repeat(childInd) + l : l));
  }
  if (!ins.length && !addMerge && !dropMerge) return { lines, childEnd };
  const mergeLine = addMerge ? ' '.repeat(childInd) + '<<: *' + addMerge : null;
  const block = mergeLine ? ins.concat([mergeLine]) : ins;
  if (block.length) { const out = lines.slice(0, li + 1).concat(block, lines.slice(li + 1)); return { lines: out, childEnd: childEnd + block.length }; }
  return { lines, childEnd };
}
function setKeyLineAnchor(line, name) {
  const m = line.match(/^(\s*[^:#]+:\s*)(?:&[^\s]+[ \t]*)?(.*)$/);
  if (!m) return null;
  const rest = (m[2] || '').trim();
  if (name) return m[1].replace(/\s+$/, '') + ' &' + name + (rest ? ' ' + rest : '');
  return m[1].replace(/\s+$/, '') + (rest ? ' ' + rest : '');
}
function setDashLineAnchor(dashLine, name, childPad, nextLine) {
  const m = dashLine.match(/^(\s*)-(\s+)?(.*)$/);
  if (!m) return null;
  const [, pad, , contentRaw] = m;
  const content = String(contentRaw || '').replace(/^&[^\s]+\s+/, '').trim();
  if (name) {
    if (!content) return [pad + '- &' + name];
    if (/^\{.*\}$/.test(content)) return [pad + '- &' + name + ' ' + content];
    return [pad + '- &' + name, childPad + content];
  }
  if (!content) {
    if (nextLine == null || !new RegExp('^' + childPad + '\\S').test(nextLine)) return null;
    return [pad + '- ' + nextLine.trim()];
  }
  return [pad + '- ' + content];
}
export function entryAnchorInfo(text, topKey, entryKey, kind) {
  const res = { anchor: null, merges: [], multi: false };
  const loc = entryKey ? locateEntry(text, topKey, entryKey, kind) : null;
  if (!loc) return res;
  const { lines, li, childInd, childEnd, flow } = loc;
  const head = lines[li].match(/&([^\s,[\]{}#]+)/);
  if (head) res.anchor = head[1];
  if (flow) { const fm = lines[li].match(/[#,]\s*<<\s*:\s*([^,}]+)/); if (fm) (fm[1].match(/\*([^\s,[\]{}#]+)/g) || []).forEach(x => res.merges.push(x.slice(1))); }
  const seeRe = new RegExp('^ {' + childInd + '}<<\\s*:\\s*(.*)$');
  let seen = 0;
  for (let i = li + 1; i < childEnd; i++) {
    const m = lines[i] && lines[i].match(seeRe);
    if (!m) continue;
    seen++;
    (m[1].match(/\*([^\s,[\]{}#]+)/g) || []).forEach(x => res.merges.push(x.slice(1)));
  }
  if (flow && lines[li].includes('<<:')) seen++;
  // 块式 seq 条目的 `<<` 可能直接写在 dash 行上（`- <<: *auto`，整理字段顺序前的常见形态）：
  // 不计入会让界面误显示「(不继承)」，取消继承/换绑也全部静默失效
  else if (kind === 'seq') {
    const dm = (lines[li] || '').match(/^\s*-(?:\s+&[^\s]+)?\s+<<\s*:\s*(.*)$/);
    if (dm) {
      seen++;
      (dm[1].match(/\*([^\s,[\]{}#]+)/g) || []).forEach(x => res.merges.push(x.slice(1)));
    }
  }
  res.multi = seen > 1 || res.merges.length > 1;
  return res;
}
// 条目内各「有本地行」字段的二级锚点现状（&def、<< 来源、* 值引用）
export function entryFieldAnchors(text, topKey, entryKey, kind) {
  const out = [];
  const loc = entryKey ? locateEntry(text, topKey, entryKey, kind) : null;
  if (!loc || loc.flow) return out;
  const { lines, li, childInd, childEnd } = loc;
  const keyRe = new RegExp('^ {' + childInd + '}(?:([A-Za-z0-9_.\\-]+)|"([A-Za-z0-9_.\\-]+)"|\'([A-Za-z0-9_.\\-]+)\')\\s*:\\s*(.*)$');
  for (let i = li + 1; i < childEnd; i++) {
    const m = lines[i] && lines[i].match(keyRe);
    if (!m) continue;
    const key = m[1] || m[2] || m[3];
    let rest = (m[4] || '').trim();
    const hash = rest.indexOf(' #');
    if (hash > -1) rest = rest.slice(0, hash).trim();
    const anchor = (rest.match(/^&([^\s,{[]+)/) || [])[1] || null;
    const aliasRef = (/^\*([^\s,[\]{}#]+)$/.exec(rest) || [])[1] || null;
    const merges = []; let mergeLines = 0;
    let flowField = false;
    if (/^\{.*\}$/.test(rest)) {
      flowField = true;
      const fm = rest.match(/[{,]\s*<<\s*:\s*([^,}]+)/);
      if (fm) { mergeLines = 1; (fm[1].match(/\*([^\s,[\]{}#]+)/g) || []).forEach(x => merges.push(x.slice(1))); }
    } else if (rest === '' || /^&[^\s]+$/.test(rest)) {
      let j = i + 1; let ci2 = 0;
      while (j < childEnd) {
        const l = lines[j];
        if (!l || !l.trim()) { j++; continue; }
        const ind = l.match(/^\s*/)[0].length;
        if (ind <= childInd) break;
        if (!ci2) ci2 = ind;
        if (ind === ci2) {
          const mm = l.match(new RegExp('^ {' + ci2 + '}<<\\s*:\\s*(.*)$'));
          if (mm) { mergeLines++; (mm[1].match(/\*([^\s,[\]{}#]+)/g) || []).forEach(x => merges.push(x.slice(1))); }
        }
        j++;
      }
    }
    out.push({ key, anchor, aliasRef, merges, multi: mergeLines > 1 || merges.length > 1, flowField });
  }
  return out;
}
// 条目在源码文本里是否带有某字段的「本地行」（区分 本地写入 vs 经 <<: *锚点 继承展开）。
// 编辑器据此决定类型选择器是否默认停在「默认（不覆写）」：
//   无本地行 → 默认不覆写，保存时保持现状（不把继承值固化成本地字段）。
// 定位不到（条目不存在 / 非标准缩进等）返回 false——编辑器随后走「保持现状」的
// 零变更路径（沿用 cfg 展开值提交，语义 diff 为空），不会误删或误写。
export function entryHasLocalField(text, topKey, entryKey, kind, fieldKey) {
  const loc = entryKey ? locateEntry(text, topKey, entryKey, kind) : null;
  if (!loc) return false;
  const { lines, li, childInd, childEnd, flow } = loc;
  const keyRe = new RegExp('^(?:' + esc_(fieldKey) + '|"' + esc_(fieldKey) + '"|\'' + esc_(fieldKey) + '\')\\s*:');
  if (flow) {
    const m = lines[li].match(/\{(.*)\}/);
    return !!m && splitTopLevel(m[1]).some(s => keyRe.test(s.trim()));
  }
  if (kind === 'seq') {
    // 行内条目第一个字段可能直接写在 dash 行上：`- type: select` / `- &锚 type: select`
    const dm = lines[li].match(/^\s*-(?:\s+&[^\s]+)?\s+(.*)$/);
    if (dm && keyRe.test(dm[1].trim())) return true;
  }
  const lineRe = new RegExp('^ {' + childInd + '}(?:' + esc_(fieldKey) + '|"' + esc_(fieldKey) + '"|\'' + esc_(fieldKey) + '\')\\s*:');
  for (let i = li + 1; i < childEnd; i++) if (lines[i] && lineRe.test(lines[i])) return true;
  return false;
}
// 全局锚点图景（工具页可视化）：每个 &定义 的路径与引用者清单
export function scanAnchorGraph(text) {
  const lines = String(text || '').split('\n');
  const ctxOf = (i) => {
    const stack = [];
    let want = lines[i].match(/^\s*/)[0].length;
    for (let j = i; j >= 0 && stack.length < 4; j--) {
      const l = lines[j];
      if (!l.trim() || l.trim().startsWith('#')) continue;
      const ind = l.match(/^\s*/)[0].length;
      const nm = l.match(/^\s*(?:-\s+)?(?:name|"name"|'name')\s*:\s*([^\s,}]+)/);
      if (ind >= want && j !== i && nm) { stack.unshift(nm[1].replace(/^["']|["'],?$/g, '')); want = ind; continue; }
      const km = l.match(/^\s*(?:-\s+)?(?:&\S+\s+)?([^:#]+?)\s*:(\s|$)/);
      if (km && (ind < want || j === i)) { stack.unshift(km[1].trim().replace(/^["']|["']$/g, '')); want = Math.min(want, ind); if (ind === 0 && j !== i) break; if (ind === 0 && j === i) break; }
    }
    return stack.join(' → ') || '(顶层)';
  };
  const defs = new Map(); const danglers = [];
  const refsBy = new Map();
  lines.forEach((l, i) => {
    const a = anchorsOnLine(l);
    a.defs.forEach(n => { if (!defs.has(n)) defs.set(n, []); defs.get(n).push({ line: i + 1, path: ctxOf(i) }); });
    const isMerge = /^\s*<<\s*:/.test(l);
    a.refs.forEach(n => {
      if (!refsBy.has(n)) refsBy.set(n, []);
      refsBy.get(n).push({ line: i + 1, path: ctxOf(i), merge: isMerge });
    });
  });
  const anchors = [...defs.keys()].map(n => {
    const rs = refsBy.get(n) || [];
    return { name: n, defs: defs.get(n), refs: rs, mergeCnt: rs.filter(r => r.merge).length, aliasCnt: rs.filter(r => !r.merge).length };
  });
  [...refsBy.keys()].filter(n => !defs.has(n)).forEach(n => danglers.push({ name: n, refs: refsBy.get(n) }));
  return { anchors, danglers };
}
// 已有定义块的可视化编辑：以原文为模板，不套用新建块的 160 字符排版规则。
// 利用已内置 js-yaml 的 parser listener 记录真实节点范围；未修改节点逐字搬回，
// 修改叶子仅替换值，增删项沿用容器的 flow/block、缩进、分隔符与保留项注释。
// 最终必须再次解析并与目标值一致；无法保真的形态拒绝，不退回整块/整份重排。
export function patchAnchorDefBlock(text, key, value, Y = jsyaml, keyOrigins = null) {
  text = String(text);
  const stack = []; let root;
  const original = Y.load(text, { listener(event, state) {
    if (event === 'open') {
      const n = { from: state.position, children: [] };
      if (stack.length) stack[stack.length - 1].children.push(n); else root = n;
      stack.push(n);
    } else {
      const n = stack.pop();
      Object.assign(n, { to: Math.min(text.length, state.position), kind: state.kind, value: state.result });
    }
  } });
  const same = (a, b, seen = new Map()) => {
    if (Object.is(a, b)) return true;
    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    if (seen.get(a) === b) return true; seen.set(a, b);
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k, i) => k === bk[i] && same(a[k], b[k], seen));
  };
  if (!root || !original || !Object.prototype.hasOwnProperty.call(original, key)) throw new Error('无法定位原定义块，请使用文本模式');
  if (same(original[key], value)) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const end = n => n.to - (text.slice(n.from, n.to).match(/\s*$/) || [''])[0].length;
  const start = n => {
    let p = n.from;
    for (;;) {
      while (/\s/.test(text[p] || '') && p < n.to) p++;
      if (text[p] === '#') { while (p < n.to && text[p] !== '\n') p++; continue; }
      const m = /^(?:&[^\s\[\]{},]+|!<[^>]+>|![^\s\[\]{},]+)/.exec(text.slice(p, n.to));
      if (m) { p += m[0].length; continue; }
      return p;
    }
  };
  const dump = v => Y.dump(v, { lineWidth: -1, noRefs: true, flowLevel: 0 }).replace(/\n+$/, '');
  const scalar = (old, v, flow) => {
    if (typeof v !== 'string') return dump(v);
    if (old[0] === "'" && !/[\r\n]/.test(v)) return "'" + v.replace(/'/g, "''") + "'";
    if (old[0] === '"') return JSON.stringify(v);
    if (old[0] !== "'" && !/^\s|\s$|[\r\n]/.test(v)) {
      try { if (same(Y.load(v), v) && (!flow || same(Y.load('[' + v + ']'), [v]))) return v; } catch (_) {}
    }
    return dump(v);
  };
  const splice = (n, edits) => {
    let out = '', pos = n.from;
    for (const x of edits.sort((a, b) => a.from - b.from)) {
      if (x.from < pos || x.to > n.to) throw new Error('节点范围重叠，请使用文本模式');
      out += text.slice(pos, x.from) + x.text; pos = x.to;
    }
    return out + text.slice(pos, n.to);
  };
  const comma = s => {
    for (let p = 0; p < s.length; p++) {
      if (s[p] === '#') { while (p < s.length && s[p] !== '\n') p++; }
      else if (s[p] === ',') return p;
    }
    return -1;
  };
  const render = (n, v, inFlow = false) => {
    if (same(n.value, v)) return text.slice(n.from, n.to);
    // js-yaml 的块标量/序列标量有单子节点包装；只改内层 token，外部空白/属性原样保留。
    if (n.children.length === 1 && n.kind === 'scalar' && same(n.children[0].value, n.value)) {
      const c = n.children[0]; return splice(n, [{ from: c.from, to: c.to, text: render(c, v, inFlow) }]);
    }
    const map = n.kind === 'mapping' && v && typeof v === 'object' && !Array.isArray(v);
    const seq = n.kind === 'sequence' && Array.isArray(v);
    const s = start(n), finish = end(n), flow = text[s] === '{' || text[s] === '[';
    if (!map && !seq) {
      let prefix = text.slice(n.from, s);
      if (n.value == null && s === finish && !/\s$/.test(prefix)) prefix += ' ';
      return prefix + scalar(text.slice(s, finish), v, inFlow) + text.slice(finish, n.to);
    }
    const entries = [];
    if (map) {
      if (n.children.length % 2) throw new Error('复杂映射请使用文本模式');
      for (let i = 0; i < n.children.length; i += 2) {
        const k = n.children[i], val = n.children[i + 1];
        if (String(k.value) === '<<') throw new Error('合并引用请使用文本模式，避免展开引用');
        entries.push({ key: String(k.value), k, n: val, from: k.from, to: end(val) });
      }
    } else {
      n.children.forEach((val, i) => {
        let from = val.from;
        if (!flow) {
          const ls = text.lastIndexOf('\n', from - 1) + 1;
          const m = /^[ \t]*-(?:[ \t]+|$)/.exec(text.slice(ls, from));
          if (!m) throw new Error('复杂序列项请使用文本模式');
          from = ls + m[0].indexOf('-');
        }
        entries.push({ key: i, n: val, from, to: end(val) });
      });
    }
    const keys = map ? Object.keys(v) : v.map((_, i) => i);
    const origins = keyOrigins ? keyOrigins.get(v) : null;
    if (entries.length === keys.length && entries.every((e, i) => e.key === keys[i]
      && (!origins || !origins.has(e.key) || origins.get(e.key) === e.key))) {
      return splice(n, entries.filter(e => !same(e.n.value, v[e.key])).map(e => ({ from: e.n.from, to: e.n.to, text: render(e.n, v[e.key], inFlow || flow) })));
    }
    const close = flow ? finish - 1 : finish;
    if (flow && text[close] !== (map ? '}' : ']')) throw new Error('流式范围无法保真，请使用文本模式');
    const first = entries.length ? entries[0].from : (flow ? s + 1 : s);
    const emptyTrivia = !entries.length && flow ? text.slice(s + 1, close) : '';
    let prefix = text.slice(n.from, first) + emptyTrivia;
    const suffix = text.slice(close, n.to);
    const padOf = p => (text.slice(text.lastIndexOf('\n', p - 1) + 1, p).match(/^[ \t]*/) || [''])[0];
    const pad = entries.length ? padOf(entries[entries.length - 1].from) : padOf(n.from) + '  ';
    const unit = Math.max(1, Math.min(8, pad.length - padOf(n.from).length || 2));
    if (!entries.length && flow && /\n$/.test(prefix)) prefix += pad;
    entries.forEach((e, i) => { e.after = text.slice(e.to, i + 1 < entries.length ? entries[i + 1].from : close); });
    const used = new Set(), matches = keys.map(k => {
      // 明确的键/列表项来源优先；null 是新建项，不挪用已删除项的注释或格式。
      const explicit = origins && origins.has(k), from = explicit ? origins.get(k) : k;
      const e = explicit ? (from === null ? null : entries.find(e => !used.has(e) && e.key === from))
        : map ? entries.find(e => !used.has(e) && e.key === k)
        : entries.find(e => !used.has(e) && same(e.n.value, v[k]));
      if (e) used.add(e); return e;
    });
    // 唯一对应的「删旧键 + 同值新键」只改键名，不能把没改过的长数组/注释重 dump。
    if (map) matches.forEach((e, i) => {
      if (e || (origins && origins.has(keys[i]))) return;
      const choices = entries.filter(x => !used.has(x) && !keys.includes(x.key) && same(x.n.value, v[keys[i]]));
      const peers = keys.filter((k, j) => !matches[j] && same(v[k], v[keys[i]]));
      if (choices.length === 1 && peers.length === 1) { matches[i] = choices[0]; used.add(choices[0]); }
    });
    // 数组插入/删除后优先复用未变项；变化项才按剩余位置配对。
    if (seq) matches.forEach((e, i) => { if (!e && !(origins && origins.has(keys[i]))) { const spare = entries.find(e => !used.has(e)); if (spare) { used.add(spare); matches[i] = spare; } } });
    const lastGap = entries.length ? entries[entries.length - 1].after : emptyTrivia;
    const multiline = entries.some(e => /\n/.test(e.after)) || /\n/.test(prefix);
    const newGap = flow ? (multiline ? ',' + eol + pad : ', ') : eol + pad;
    const newTail = flow ? (lastGap.includes('#') ? (lastGap.includes('\n') ? lastGap.slice(lastGap.lastIndexOf('\n')).replace(/^\n/, eol) : ' ') : lastGap) : '';
    let out = prefix;
    keys.forEach((k, i) => {
      const old = matches[i];
      if (old) {
        const replacement = render(old.n, v[k], inFlow || flow);
        let header = text.slice(old.from, old.n.from);
        if (map && old.key !== k) header = text.slice(old.from, start(old.k))
          + scalar(text.slice(start(old.k), end(old.k)), String(k), flow) + text.slice(end(old.k), old.n.from);
        out += header + replacement.slice(0, replacement.length - (old.n.to - old.to));
      } else if (flow) {
        out += (map ? dump(String(k)) + ': ' : '') + dump(v[k]);
      } else {
        out += Y.dump(map ? { [k]: v[k] } : [v[k]], { lineWidth: -1, noRefs: true, indent: unit }).replace(/\n+$/, '').replace(/\n/g, eol + pad);
      }
      const last = i === keys.length - 1;
      let gap = old ? old.after : (last ? newTail : newGap);
      if (flow && old) {
        const c = comma(gap);
        if (last && c >= 0) gap = gap.slice(0, c) + gap.slice(c + 1);
        else if (!last && c < 0) gap = ',' + (gap || (multiline ? eol + pad : ' '));
      } else if (!flow && old) {
        if (last) gap = gap.replace(/\r?\n[ \t]*$/, '');
        else if (!/\n[ \t]*$/.test(gap)) gap += eol + pad;
      }
      out += gap;
    });
    if (!keys.length && !flow) out += map ? '{}' : '[]';
    return out + suffix;
  };
  const idx = root.children.findIndex((n, i) => i % 2 === 0 && String(n.value) === String(key));
  if (idx < 0 || !root.children[idx + 1]) throw new Error('定义键无法定位，请使用文本模式');
  const n = root.children[idx + 1];
  const next = text.slice(0, n.from) + render(n, value) + text.slice(n.to);
  const back = Y.load(next);
  if (!back || !same(back[key], value) || Object.keys(back).length !== Object.keys(original).length) throw new Error('此改动无法保持原格式，请切换文本编辑（原内容未改动）');
  return next;
}

// 新建锚点定义块文本生成（仅在没有原文模板时选择初始排版）：
// 摊得开且 ≤160 字符 → flow 单行（与配置里 代理合集/混淆覆写 同款）；否则块式。
// ind = 定义行缩进（顶层为 0；字段级定义非 0）。产物 = 行数组，首行即 `键: &名 …`。
export function anchorDefBlock(key, name, value, ind = 0, Y = jsyaml) {
  const pad = ' '.repeat(Math.max(0, ind | 0));
  const dOpts = { lineWidth: -1, noRefs: true, sortKeys: false };
  let flow = null;
  try { flow = Y.dump({ [key]: value }, { ...dOpts, flowLevel: 1 }).replace(/\n+$/, ''); } catch (e) { flow = null; }
  if (flow && !flow.includes('\n') && flow.length <= 160) {
    const m0 = flow.match(/^([^:]+):\s*/);
    if (m0) return [pad + m0[1] + ': &' + name + ' ' + flow.slice(m0[0].length)];
  }
  const ds = Y.dump({ [key]: value }, dOpts).replace(/\n+$/, '').split('\n');
  if (ds.length === 1) {   // 长标量等单行值：&名 后必须留空格，防止与值粘连
    const m1 = ds[0].match(/^([^:]+):\s*/);
    if (m1) return [pad + m1[1] + ': &' + name + ' ' + ds[0].slice(m1[0].length)];
  }
  const m0 = ds[0].match(/^([^:]+):(\s*)$/);
  return [m0 ? pad + m0[1] + ': &' + name : pad + ds[0], ...ds.slice(1).map(l => pad + l)];
}

// 剥掉行尾裸注释（YAML 规则：# 前需空白才算注释；引号内不算）。供锚点定义值/flow 段解析用。
function stripBareComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) { if (q === "'" && s[i + 1] === "'") i++; else q = null; } continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

// 从文本行里提取 &name 锚点定义的值（任意类型：映射/序列/标量）。
// 支持三种形态：同行值（key: &a {…} / - &a {…} / &a 标量）、键行下方块式、
// dash 行下方块式（- &a）。找不到/别名（&a *b）/解析不了返回 undefined。
function anchorDefRawLines(lines, name, Y) {
  if (!name) return undefined;
  const defRe = new RegExp('&' + esc_(name) + '(?=$|[\\s,[\\]{}#])(.*)$');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] || '';
    if (!anchorsOnLine(l).defs.includes(name)) continue;
    const m = l.match(defRe);
    if (!m) continue;
    const rest = stripBareComment(m[1]).trim();
    if (rest !== '') {
      // 同行值：flow / 标量直接解析；`*别名` 片段内解析必抛 → 视为取不到
      try { return Y.load(rest); } catch (e) { return undefined; }
    }
    // 块式：收集比定义行缩进深的后续行，去公共缩进后整体解析
    const defIndent = (l.match(/^\s*/) || [''])[0].length;
    const sub = [];
    for (let j = i + 1; j < lines.length; j++) {
      const sj = lines[j] || '';
      if (!sj.trim()) { sub.push(''); continue; }
      if ((sj.match(/^\s*/) || [''])[0].length <= defIndent) break;
      sub.push(sj);
    }
    while (sub.length && !sub[sub.length - 1].trim()) sub.pop();
    if (!sub.length) return undefined;
    const minInd = Math.min(...sub.filter(s => s.trim()).map(s => (s.match(/^\s*/) || [''])[0].length));
    try { return Y.load(sub.map(s => s.trim() ? s.slice(minInd) : '').join('\n')); } catch (e) { return undefined; }
  }
  return undefined;
}

// UI 用：从源码文本按名字取 &name 的定义值（任意类型）；取不到返回 undefined。
// 编辑器里选择继承/引用锚点后，用它把锚点参数值立即填进值框。
export function anchorDefValue(text, name, Y = jsyaml) {
  try { return anchorDefRawLines(String(text || '').split('\n'), name, Y); }
  catch (e) { return undefined; }
}

// 锚点定义值（必须是映射才返回对象，否则 null）——<< 合并只对映射有意义，
// 收敛钩子用这个；标量/别名/解析不了 → null → 跳过收敛，保持现状。
function anchorMapValue(lines, name, Y) {
  const v = anchorDefRawLines(lines, name, Y);
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
}

// 块式条目的本地字段收敛：删除与锚点定义「同名且同值」的字段块（值将由 << 继承提供）。
// 不动：skipKeys 里的键（如 seq 条目的身份键 name）、带 &定义 的字段块、值含 *别名
// 或解析不了的形态——保守跳过，行为退回未收敛。字段上方同级注释保留。
function dedupeLocalFields(lines, from, to, indent, anchorVal, skipKeys, Y) {
  if (!anchorVal || !(to > from)) return { lines, to };
  const keyRe = new RegExp('^ {' + indent + '}(?:"([^"]+)"|\'([^\']+)\'|([A-Za-z0-9_.\\-]+))\\s*:(\\s.*)?$');
  const fields = [];
  for (let i = from; i < to; i++) {
    const l = lines[i] || '';
    const m = l.match(keyRe);
    if (!m) continue;
    const key = m[1] || m[2] || m[3];
    let last = i;                                      // 字段块结束：后续缩进更深的行（含深层注释/夹的空行）
    for (let j = i + 1; j < to; j++) {
      const lj = lines[j] || '';
      if (!lj.trim()) continue;
      if ((lj.match(/^\s*/) || [''])[0].length > indent) last = j;
      else break;
    }
    fields.push({ key, from: i, to: last + 1 });
    i = last;
  }
  const kills = [];
  for (const fd of fields) {
    if ((skipKeys || []).includes(fd.key)) continue;
    if (!Object.prototype.hasOwnProperty.call(anchorVal, fd.key)) continue;
    let hasDef = false;
    for (let i = fd.from; i < fd.to; i++) if (anchorsOnLine(lines[i] || '').defs.length) { hasDef = true; break; }
    if (hasDef) continue;                              // 字段块内有 &定义：删了会孤儿化别处引用
    let localVal, ok = true;
    try {
      const obj = Y.load(lines.slice(fd.from, fd.to).map(s => s.trim() ? s.slice(indent) : '').join('\n'));
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Object.prototype.hasOwnProperty.call(obj, fd.key)) ok = false;
      else localVal = obj[fd.key];
    } catch (e) { ok = false; }                        // 值含 *别名等：解析失败即跳过
    if (ok && yamlEq(localVal, anchorVal[fd.key])) kills.push(fd);
  }
  if (!kills.length) return { lines, to };
  const out = lines.slice();
  let removed = 0;
  kills.sort((a, b) => b.from - a.from);               // 自底向上删，行号不漂移
  for (const k of kills) { out.splice(k.from, k.to - k.from); removed += k.to - k.from; }
  return { lines: out, to: to - removed };
}

// flow 映射行收敛：`{a: 1, <<: *x}` 里删除与锚点定义同名同值的段（<< 段与含 &/* 的段不动）。
// 返回新行；无可收敛或形态不符返回 null（调用方保留原行）。
function dedupeFlowMapLine(line, anchorVal, skipKeys, Y) {
  if (!anchorVal) return null;
  const m = String(line).match(/^(\s*(?:[^:#\r\n]+:\s*)?(?:-\s+)?(?:&[^\s]+\s+)?)\{(.*)\}(\s*(?:#.*)?)$/);
  if (!m) return null;
  const segs = splitTopLevel(m[2]);
  const keep = [];
  let changed = false;
  for (const s of segs) {
    const km = s.trim().match(/^("([^"]+)"|'([^']+)'|([A-Za-z0-9_.\-]+))\s*:(.*)$/);
    const k = km && (km[2] || km[3] || km[4]);
    if (!km || !k || (skipKeys || []).includes(k) || /[&*]/.test(s)
        || !Object.prototype.hasOwnProperty.call(anchorVal, k)) { keep.push(s); continue; }
    const vText = stripBareComment(km[5]).trim();
    if (!vText) { keep.push(s); continue; }
    let v, ok = true;
    try { v = Y.load(vText); } catch (e) { ok = false; }
    if (ok && yamlEq(v, anchorVal[k])) { changed = true; continue; }
    keep.push(s);
  }
  if (!changed) return null;
  return m[1] + '{' + (keep.length ? ' ' + keep.join(', ') + ' ' : '') + '}' + m[3];
}

export function applyAnchorOps(text, ops, Y = jsyaml) {
  const notes = [];
  let lines = String(text).split('\n');
  // 0) 全局操作（工具页）：任意位置改名级联（含定义行）与零引用摘定义
  for (const o of ops) {
    if (!o || o.kind !== 'global') continue;
    for (const [from, to] of (o.rename || [])) {
      lines = lines.map(l => replaceTokInLine(replaceTokInLine(l, from, to, false), from, to, true));
    }
    // 条目名（顶层键）改名：&名 级联完成后，在 &kr.anchor 的定义行上替换行首键。
    // 只在「行首 键: &锚点名」形态下动手，匹配不到就记 note，绝不盲改。
    for (const kr of (o.keyRename || [])) {
      let done = false;
      for (let i = 0; i < lines.length && !done; i++) {
        const l = lines[i];
        if (!l || !/&[^\s]/.test(l)) continue;
        const am = anchorsOnLine(l);
        if (!am.defs.includes(kr.anchor)) continue;
        const km = l.match(/^(\s*)(- )?(.+?):\s*&([^\s,[\]{}#]+)/);
        if (!km || km[4] !== kr.anchor) continue;
        if (km[3].trim().replace(/^["']|["']$/g, '') !== kr.from) continue;
        const keyStart = km[1].length + (km[2] ? km[2].length : 0);
        lines[i] = l.slice(0, keyStart) + kr.to + l.slice(keyStart + km[3].length);
        done = true;
      }
      if (!done) notes.push(`条目名「${kr.from}」未定位到定义行，条目名未改`);
    }
    for (const name of (o.drop || [])) {
      const rs = scanYamlAnchors(lines.join('\n')).refs.get(name) || 0;
      if (rs > 0) { notes.push(`锚点 &${name} 仍被 ${rs} 处引用，未删除（先迁走引用）`); continue; }
      // R29：删除锚点 = 连同 &定义 所在的整个顶层块一起移除（「新建锚点」建的就是
      // 「顶层条目 + &锚点」整体，只摘 &名 会留下失效的顶层键残块）。但顶层键若是
      // mihomo 真正在用的配置段（mixed-port / dns / proxies…），或同名有多处顶层定义，
      // 保留块体、只摘 &名，避免删坏配置。
      const topDefs = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!l || /^\s/.test(l) || !/&[^\s]/.test(l)) continue;
        if (anchorsOnLine(l).defs.includes(name)) topDefs.push(i);
      }
      const stripTok = () => { lines = lines.map(l => {
        if (!/&[^\s]/.test(l)) return l;
        const m = anchorsOnLine(l);
        if (!m.defs.includes(name)) return l;
        const mask = bareMask(l);
        // 摘掉 &名 后行尾常留一个空格（`键: &a` → `键: `），一并收掉
        return l.replace(new RegExp('(\\s*)&' + esc_(name) + '(\\s*)', 'g'), (mm, s1, s2, idx) => (mask[idx] ? ((s1 || s2) ? ' ' : '') : mm)).replace(/^(\s*[^:#]+:)[ \t]+$/, '$1');
      }); };
      if (topDefs.length === 1) {
        const di = topDefs[0];
        const km = lines[di].match(/^([^:\s]+|"[^"]+"|'[^']+')\s*:/);
        const topKey = km ? km[1].replace(/^['"]|['"]$/g, '') : null;
        let end2 = lines.length;
        for (let i = di + 1; i < lines.length; i++) {
          const l = lines[i];
          if (!l.trim()) continue;
          // 顶层行即块尾：下一段的段头注释属于下一段，不能跟着块一起删掉
          if (!/^\s/.test(l)) { end2 = i; break; }
        }
        // 自建锚点容器一律整块删。旧实现拿 `lines.includes(topKey)` 全文搜子串，
        // 注释里出现一次、键名是别的词的子串（test ⊂ latest）、或别处有同名策略组，
        // 都会被误判成「被引用」而只摘 &名，删完留下 `键: 值` 残块。
        if (topKey && !MIHOMO_TOP_KEYS.has(topKey)) {
          // 删的是文件里第一块有内容的定义（前面只有空行）→ 连块后的空行一起收，文件头不留空白；
          // 否则块尾空行留在原地当段落间距，只处理块前多出来的那一行空行。
          const firstContent = di === 0 || lines.slice(0, di).every(l => !l.trim());
          let cut = end2;
          if (firstContent) { while (cut < lines.length && !lines[cut].trim()) cut++; }
          else { while (cut > di + 1 && !lines[cut - 1].trim()) cut--; }
          lines = lines.slice(0, di).concat(lines.slice(cut));
          if (firstContent) { while (lines.length && !lines[0].trim()) lines.shift(); }
          // 块前若是空行且删后出现双空行/结尾空行，收掉一行
          else if (di > 0 && !lines[di - 1].trim() && (di >= lines.length || !lines[di].trim())) lines.splice(di - 1, 1);
          continue;
        }
        if (topKey) notes.push(`顶层键「${topKey}」是 mihomo 配置段，已保留块体、仅移除 &${name}`);
      }
      if (topDefs.length > 1) notes.push(`锚点 &${name} 有多处顶层定义，仅移除 &${name}`);
      stripTok();
    }
  }
  // 1) 条目级改名级联：*old 引用先替换（定义行由手术重写）。
  // 注意：字段级（二级）&定义 改名级联已移除——字段级定义动作已下线，若先级联引用
  // 再拒定义，会留下一批悬空 *引用。
  for (const o of ops) {
    if (!o || o.kind === 'global') continue;
    const pairs = [];
    if (o.oldAnchor && o.anchor && o.anchor !== o.oldAnchor) pairs.push([o.oldAnchor, o.anchor]);
    for (const [from, to] of pairs) lines = lines.map(l => replaceTokInLine(l, from, to, false));
  }
  // 2) 逐 op 手术（newtop 由 2e 单独处理）
  for (const o of ops) {
    if (!o || o.kind === 'global' || o.kind === 'newtop') continue;
    const loc = locateEntry(lines, o.top, o.key, o.kind);
    if (!loc) { notes.push(`条目「${o.key}」未在当前源码中定位到，其锚点改动未应用`); continue; }
    let { li, childInd, childEnd, flow } = loc;
    const touchMerge = o.merge !== undefined;   // null=清除；string=换绑/新增；undefined=不动
    if (touchMerge) {
      // `<<` 写在 dash 行上的块式条目（`- <<: *auto`）：hadMerge 探测与摘除都要覆盖，
      // 否则取消继承静默无效、换绑会插出第二条 << 行
      const dashMergeRe = /^\s*-(?:\s+&[^\s]+)?\s+<<\s*:/;
      const hadMerge = (() => {
        const probe = new RegExp('^ {' + childInd + '}<<\\s*:');
        for (let i = li + 1; i < childEnd; i++) if (lines[i] && probe.test(lines[i])) return true;
        if (o.kind === 'seq' && !flow && dashMergeRe.test(lines[li] || '')) return true;
        return flow && /[,{]\s*<<\s*:/.test(lines[li]);
      })();
      if (flow) {
        const mat = materializeMergeFields(lines, li, childInd, childEnd, true, o.expand || {}, Y, true, o.merge || null);
        lines = mat.lines; childEnd = mat.childEnd;
        // 收敛：flow 条目里与锚点定义同名同值的段删掉（值已由 << 提供）；
        // name 是 seq 条目身份键不动；&/* 段、解析不了的段保守保留
        if (o.merge) {
          const aval = anchorMapValue(lines, o.merge, Y);
          if (aval) {
            const nl = dedupeFlowMapLine(lines[li], aval, o.kind === 'seq' ? ['name'] : [], Y);
            if (nl != null) lines[li] = nl;
          }
        }
      } else if (hadMerge) {
        const mat = materializeMergeFields(lines, li, childInd, childEnd, false, o.expand, Y, true);
        lines = mat.lines; childEnd = mat.childEnd;
        const seeRe = new RegExp('^ {' + childInd + '}<<\\s*:');
        for (let i = li + 1; i < childEnd; i++) {
          if (lines[i] && seeRe.test(lines[i])) { lines.splice(i, 1); i--; childEnd--; }
        }
        // 摘掉 dash 行上的合并段：`- <<: *a` → `-`（&定义保留）。物化字段已插在 li 之后，
        // 裸 `-` + 缩进字段行是等价的块序列写法，重解析安全
        if (o.kind === 'seq' && dashMergeRe.test(lines[li] || '')) {
          lines[li] = lines[li].replace(/^(\s*-(?:\s+&[^\s]+)?)\s+<<\s*:.*$/, '$1');
        }
      }
    }
    if (o.anchor !== undefined) {
      const cur = (lines[li].match(/[&]([^\s,{[]+)/) || [])[1] || null;
      const want = o.anchor || null;
      if (want !== cur) {
        if (o.kind === 'seq') {
          const next = lines[li + 1];
          const repl = setDashLineAnchor(lines[li], want, ' '.repeat(childInd), want ? undefined : next);
          if (!repl) notes.push(`条目「${o.key}」dash 行形态异常，锚点定义跳过`);
          else if (repl.length === 2) { lines.splice(li, 1, repl[0], repl[1]); childEnd += 1; }
          else if (!want && next && /^ {4}\S/.test(next)) { lines.splice(li, 2, repl[0]); childEnd -= 1; }
          else lines.splice(li, 1, repl[0]);
        } else {
          const nl = setKeyLineAnchor(lines[li], want);
          if (nl == null) notes.push(`条目「${o.key}」键行形态异常，锚点定义跳过`);
          else lines[li] = nl;
        }
      }
    }
    // 2c) 块式条目插 << 行（流式已段级重建）
    if (touchMerge && o.merge && !flow) {
      lines.splice(li + 1, 0, ' '.repeat(childInd) + '<<: *' + o.merge);
      childEnd += 1;
      // 2c+) 收敛：建立/换绑继承后，条目里与锚点定义「同名且同值」的本地字段删掉
      //（值已由 << 提供，留着是冗余）；不同值的字段保留为本地覆写；带 &定义 的字段块、
      // *别名值、解析不了的形态一律不动。<< 行本身不在 keyRe 匹配范围，天然保留。
      const aval = anchorMapValue(lines, o.merge, Y);
      if (aval) {
        const skip = o.kind === 'seq' ? ['name'] : [];
        const r = dedupeLocalFields(lines, li + 1, childEnd, childInd, aval, skip, Y);
        lines = r.lines; childEnd = r.to;
        // dash 行内联首字段（`- url: u1`）同样参与收敛：与锚点同值时剥成裸 `-`
        //（&定义保留）。<< 行刚插在 li+1，条目不会因此变空。name 是身份键不参与。
        const dm = (lines[li] || '').match(/^(\s*-(?:\s+&[^\s]+)?)\s+(.*)$/);
        if (dm) {
          const km = dm[2].match(/^("([^"]+)"|'([^']+)'|([A-Za-z0-9_.\-]+))\s*:(.*)$/);
          const k = km && (km[2] || km[3] || km[4]);
          const vText = km && stripBareComment(km[5]).trim();
          if (k && k !== 'name' && vText && !/[&*]/.test(vText) && Object.prototype.hasOwnProperty.call(aval, k)) {
            let fv = null, okP = true;
            try { fv = Y.load(vText); } catch (e) { okP = false; }
            if (okP && yamlEq(fv, aval[k])) lines[li] = dm[1];
          }
        }
      }
    }
    // 2d) 二级（字段级）：挂/摘 &def、<< 换绑/清除、整体 *值引用
    const order = OFFICIAL_FIELD_ORDER[o.top] || [];
    const sortedFieldOps = [...(o.fieldOps || [])].sort((a, b) => {
      const ra = order.indexOf(a.key) >= 0 ? order.indexOf(a.key) : 999;
      const rb = order.indexOf(b.key) >= 0 ? order.indexOf(b.key) : 999;
      return ra - rb;
    });

    for (const f of sortedFieldOps) {
      const loc2 = locateEntry(lines, o.top, o.key, o.kind);
      if (!loc2) { notes.push(`应用字段锚点时未找到条目「${o.key}」，其二级锚点跳过`); break; }
      const { childInd: ci, childEnd: ce } = loc2;
      if (loc2.flow) { notes.push(`条目「${o.key}」是单行流式，字段级锚点请改用一级或文本编辑`); break; }
      const flRe = new RegExp('^ {' + ci + '}(?:"?' + esc_(f.key) + '"?)\\s*:');
      let fl = -1;
      for (let i = loc2.li + 1; i < ce; i++) if (lines[i] && flRe.test(lines[i])) { fl = i; break; }
      if (fl === -1) {
        const insPos = findFieldInsertPos(lines, loc2, f.key, o.top);
        if (f.aliasRef) {
          lines.splice(insPos, 0, ' '.repeat(ci) + f.key + ': *' + f.aliasRef);
          continue;
        } else if (f.merge) {
          lines.splice(insPos, 0, ' '.repeat(ci) + f.key + ':', ' '.repeat(ci + 2) + '<<: *' + f.merge);
          continue;
        }
        notes.push(`字段「${f.key}」在条目「${o.key}」文本里没有本地行（可能来自继承），其锚点操作跳过；先在表单里改一次该字段值即可落本地行`);
        continue;
      }
      let fEnd = fl + 1; let fci2 = 0;
      for (let i = fl + 1; i < ce; i++) { const l = lines[i]; if (!l.trim()) continue; const ind = l.match(/^\s*/)[0].length; if (ind <= ci) break; if (!fci2) fci2 = ind; fEnd = i + 1; }
      if (!fci2) fci2 = ci + 2;
      const fRest0 = (lines[fl].match(/:\s*(.*)$/) || [, ''])[1].trim();
      const hash0 = fRest0.indexOf(' #');
      const fRest = hash0 > -1 ? fRest0.slice(0, hash0).trim() : fRest0;
      const fFlow = /^\{.*\}$/.test(fRest);
      if (f.defAnchor !== undefined) {
        const cur = (lines[fl].match(/:\s*&([^\s,{[]+)/) || [])[1] || null;
        const want = f.defAnchor || null;
        if (want && want !== cur) {
          // 字段级（二级）&定义 动作已下线：不新挂、不改名，文本保持不动。
          // （存量定义可摘除；改名请走「锚点可视化 → 改名」的全局级联。）
          notes.push(`字段「${f.key}」→ &${want} 未执行：字段级锚点定义已下线`);
        } else if (!want && cur) {
          const nl = setKeyLineAnchor(lines[fl], null);
          if (nl == null) notes.push(`字段「${f.key}」键行形态异常，摘除锚点跳过`);
          else lines[fl] = nl;
        }
      }
      if (f.aliasRef !== undefined) {
        // 字段整体引用 `k: *name`：块式子行删除、流式体删除；清除时按 expand 快照回填
        if (f.aliasRef) {
          const cm = lines[fl].match(/(\s+#.*)$/);
          lines.splice(fl + 1, fEnd - fl - 1);
          lines[fl] = ' '.repeat(ci) + f.key + ': *' + f.aliasRef + (cm ? ' ' + cm[1].trim() : '');
          fEnd = fl + 1;
        } else {
          // 清除引用：按 expand 快照把字段值回填为本地行（快照缺失=字段置空值）
          const snapshot = f.expand;
          const cm = lines[fl].match(/(\s+#.*)$/);
          const comment = cm ? ' ' + cm[1].trim() : '';
          let head = ' '.repeat(ci) + f.key + ':';
          let tail = [];
          if (snapshot !== null && snapshot !== undefined) {
            try {
              const dumped = jsyaml.dump({ [f.key]: snapshot }, { lineWidth: -1, noRefs: true, sortKeys: false }).replace(/\n+$/, '').split('\n');
              if (dumped.length === 1) head = ' '.repeat(ci) + dumped[0].replace(/\s+$/, '');
              else {
                head = ' '.repeat(ci) + dumped[0].replace(/:\s*$/, '') + ':';
                tail = dumped.slice(1).map(l2 => l2.trim() ? ' '.repeat(ci + 2) + l2.slice(2) : l2);
              }
            } catch (e) { notes.push(`字段「${f.key}」回填值序列化失败，引用保持不变`); continue; }
          }
          lines.splice(fl, fEnd - fl, head + comment, ...tail);
          fEnd = fl + 1 + tail.length;
        }
        continue;   // 值引用与 << 互斥处理（UI 保证同时只一种）；已重写整行
      }
      if (f.merge !== undefined) {
        if (fFlow || /^&[^\s]+ \{.*\}$/.test(fRest)) {
          const expandObj = f.expand && typeof f.expand === 'object' ? f.expand : null;
          const nl = rewriteFlowLine(lines[fl], { dropMerge: true, addMerge: f.merge || null, expandObj }, Y);
          if (nl == null) notes.push(`字段「${f.key}」流式行重建失败，继承操作跳过`);
          else {
            lines[fl] = nl;
            // 收敛：flow 字段行里与锚点定义同名同值的段删掉（<< 段与含 &/* 的段不动）
            if (f.merge) {
              const aval = anchorMapValue(lines, f.merge, Y);
              if (aval) { const nl2 = dedupeFlowMapLine(lines[fl], aval, [], Y); if (nl2 != null) lines[fl] = nl2; }
            }
          }
        } else {
          const seeRe = new RegExp('^ {' + fci2 + '}<<\\s*:');
          for (let i = fl + 1; i < fEnd; i++) if (lines[i] && seeRe.test(lines[i])) { lines.splice(i, 1); i--; fEnd--; }
          const ins = [];
          const expandObj = f.expand && typeof f.expand === 'object' ? f.expand : null;
          if (expandObj) {
            const kRe = new RegExp('^ {' + fci2 + '}"?([A-Za-z0-9_.\\-]+)"?\\s*:');
            const local = new Set();
            for (let i = fl + 1; i < fEnd; i++) { const mm = lines[i] && lines[i].match(kRe); if (mm) local.add(mm[1]); }
            for (const [k, v] of Object.entries(expandObj)) {
              if (k === '<<' || local.has(k)) continue;
              let dumped;
              try { dumped = jsyaml.dump({ [k]: v }, { lineWidth: -1, noRefs: true, sortKeys: false }).replace(/\n+$/, ''); } catch (e) { continue; }
              dumped.split('\n').forEach(l2 => ins.push(l2.trim() ? ' '.repeat(fci2) + l2 : l2));
            }
          }
          const mergeLine = f.merge ? ' '.repeat(fci2) + '<<: *' + f.merge : null;
          const block = mergeLine ? [mergeLine].concat(ins) : ins;
          if (block.length) lines.splice(fl + 1, 0, ...block);
          // 收敛：字段级继承建立/换绑后，子字段里与锚点定义同名同值的删掉（值已由
          // 字段内 << 提供）；不同值的子字段保留为覆写；带 &定义/*别名值的子字段跳过
          if (f.merge) {
            const aval = anchorMapValue(lines, f.merge, Y);
            if (aval) {
              const ce2 = ce + block.length;           // 刚插了行，字段块扫描界随之偏移
              let fEnd2 = fl + 1;
              for (let i = fl + 1; i < ce2; i++) { const l = lines[i]; if (!l || !l.trim()) continue; if ((l.match(/^\s*/) || [''])[0].length <= ci) break; fEnd2 = i + 1; }
              const r2 = dedupeLocalFields(lines, fl + 1, fEnd2, fci2, aval, [], Y);
              lines = r2.lines;
            }
          }
        }
      }
    }
  }
  // 2e) 新建顶层锚点定义块（工具页「新建锚点 → 新建顶层定义块」）：
  // 键体已随 state.cfg 由 dump 层写进文本（通常追加在文件尾），这里把整块移到文件头
  // ——YAML 锚点必须先于引用出现，新定义放文件头最稳——并在键行挂 &名。
  let movedNewtop = 0;
  for (const o of ops) {
    if (!o || o.kind !== 'newtop') continue;
    const key = String(o.key || '').trim();
    const anchor = String(o.anchor || '').trim();
    if (!key) { notes.push('新建锚点缺少顶层键名，已跳过'); continue; }
    if (!ANCHOR_NAME_OK.test(anchor)) { notes.push(`锚点名「${anchor}」不合法，&名未挂`); continue; }
    if (scanYamlAnchors(lines.join('\n')).defs.has(anchor)) { notes.push(`&${anchor} 已被定义，新块未挂名（请换个名或用改名）`); continue; }
    const qk = "'" + esc_(key) + "'";
    const keyRe = new RegExp('^(?:"' + esc_(key) + '"|' + qk + '|' + esc_(key) + ')\\s*:(\\s|$|#)');
    let ki = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s/.test(lines[i])) continue;
      if (keyRe.test(lines[i])) { ki = i; break; }
    }
    if (ki === -1) { notes.push(`顶层键「${key}」未在保存文本中找到，&${anchor} 未挂`); continue; }
    let ke = ki + 1;
    for (; ke < lines.length; ke++) {
      const l = lines[ke];
      if (!l.trim()) continue;
      if (!/^\s/.test(l)) break;                     // 下一个顶层行（键或段头注释）→ 块结束
    }
    while (ke > ki + 1 && !lines[ke - 1].trim()) ke--;   // 块尾空行随块搬走，不占新位置
    let block = lines.slice(ki, ke);
    // 风格统一：能摊成单行且不太长就写 flow 式（与配置里 代理合集/混淆覆写 同款）；摊不开保持块式
    try {
      const flow = Y.dump({ [key]: o.value }, { lineWidth: -1, noRefs: true, sortKeys: false, flowLevel: 1 }).replace(/\n+$/, '');
      if (!flow.includes('\n') && flow.length <= 160) {
        const m0 = flow.match(/^([^:]+):\s*/);
        // 注意 &名 与值之间必须留空格：setKeyLineAnchor 的 &[^\s]+ 会把无空格粘连当成锚点名的一部分
        if (m0) block = [m0[1] + ': &' + anchor + ' ' + flow.slice(m0[0].length)];
      }
    } catch (e) { /* 序列化异常保持块式 */ }
    lines.splice(ki, ke - ki);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();   // 原位置（文件尾）残留空行收掉
    const head = setKeyLineAnchor(block[0], anchor);
    if (head == null) {
      lines.splice(ki, 0, ...block);
      notes.push(`键行「${key}」形态异常，&${anchor} 未挂`);
      continue;
    }
    block[0] = head;
    let ins = lines.findIndex(l => {
      const t = l.trim();
      if (!t || t.startsWith('#')) return false;
      if (/^\s/.test(l) || /^-(\s|$)/.test(l)) return false;
      return /^[^:\s][^:]*:(\s|$|#)/.test(l);
    });
    if (ins === -1) ins = lines.length;
    // 首个顶层键上方紧贴着的注释是它的段头注释（`# HTTP(S)…` + `mixed-port:`）：
    // 新块要插到注释之前，否则会把注释和它说明的那个键劈成两半。
    while (ins > 0 && /^\s*#/.test(lines[ins - 1])) ins--;
    const pre = ins > 0 && lines[ins - 1].trim() ? [''] : [];
    const post = ins < lines.length ? [''] : [];
    lines = lines.slice(0, ins).concat(pre, block, post, lines.slice(ins));
    movedNewtop++;
  }
  if (movedNewtop) {
    // 块搬家动过文件尾：按原文习惯收尾（原文带结尾换行就留一个）
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (/\n$/.test(text)) lines.push('');
  }
  const out = lines.join('\n');
  try { Y.load(out); } catch (e) {
    const msg = /unidentified alias|bad indentation|unexpected/.test(e.message)
      ? '锚点改动破坏了文本（' + e.message + '），本次修改未应用，请修正后再确认'
      : '锚点改动后 YAML 解析失败（' + e.message + '），本次修改未应用，请修正后再确认';
    return { text: null, notes: notes.concat(msg) };
  }
  const sc = scanYamlAnchors(out);
  const dang = [...sc.refs.keys()].filter(n => !sc.defs.has(n));
  if (dang.length) return { text: null, notes: notes.concat('锚点改动产生悬空引用 *' + dang.join(' / *') + '，本次锚点操作已全部丢弃') };
  return { text: out, notes };
}

export async function saveConfig({ silent, restart = false } = {}) {
  if (state.saveBusy) return false;
  flushActiveConfigInput();
  state.saveBusy = true;
  // restart=true 供 TProxy 关闭后的模式选择使用；普通字段不传它，仍走热重载询问。
  const restartAfterSave = restart || state.restartServiceAfterSave
    || (typeof window !== 'undefined' && window.__mihomoRestartServiceAfterSave === true);
  try {
    if (!flushConfigSource() || !markDirty()) { uiToast('配置解析/同步失败，无法保存，请先修复源码', 3600); return false; }
    // 保存是唯一落盘边界：此时 raw 与面板已一致，不在这里才改锚点/生成另一份不可见配置。
    const text = state.raw, version = draftVersion;
    const layer = draftLayer, debug = draftDebug;
    if (!DEMO) {
      const ts = new Date();
      const stamp = `${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}-${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}`;
      await shell(`mkdir -p "${WORKDIR}/backup"; cp "${CONFIG_PATH}" "${WORKDIR}/backup/config-${stamp}.yaml" 2>/dev/null; ls -1t ${WORKDIR}/backup/config-*.yaml 2>/dev/null | tail -n +8 | xargs rm -f 2>/dev/null`);
    }
    const r = await writeText(CONFIG_PATH, text);
    if (r.errno !== 0) { uiToast('写入失败: ' + (r.stderr || '未知错误'), 3000); return false; }
    // 写入期间若用户又修改，不可用旧快照覆盖新草稿，也不可误清「未保存」。
    const sameDraft = version === draftVersion && state.raw === text && !sourcePending;
    if (sameDraft) clearDirty();
    // 配置已落盘：热缓存与首屏聚合缓存（boot_data，内含 config_b64）一并作废并重算，
    // 否则保存后重进面板会拿到旧 config_b64（# 真实根因）
    cmdline('live-refresh').catch(() => {});
    shell(`rm -f "${RUNDIR}/boot_data.json" 2>/dev/null; sh ${MODDIR}/scripts/mihomo.sh boot-data-sync >/dev/null 2>&1 &`).catch(() => {});
    if (layer !== 'surgical' && debug) {
      try {
        await shell(`mkdir -p "${RUNDIR}" 2>/dev/null`);
        await writeText(`${RUNDIR}/save-fallback.log`, JSON.stringify({ time: new Date().toLocaleString(), layer, ...debug }, null, 2));
      } catch (e) { /* 诊断失败不影响保存 */ }
    }
    if (!silent) uiToast((layer === 'surgical' ? '✅ 已保存（排版与锚点原样保留）'
      : layer === 'blocks' ? '⚠️ 已保存，但有段落被重排（诊断已写入 run/save-fallback.log，可发给开发者）'
      : '⚠️ 已保存，但配置被全量重排（诊断已写入 run/save-fallback.log，可发给开发者）')
      + (state.dirty ? '；另有新改动尚未保存' : ''), 4000);
    const draftIsClean = sameDraft;
    if (restartAfterSave && draftIsClean) {
      // TUN/eBPF 接管开关，以及 TProxy 关闭后模式选择：保存后直接重启服务（与主页
      // 「重启服务」同一入口），不弹热重载确认框。
      if (!DEMO) {
        let restarted = false;
        let restartResult = null;   // restart-json 带回的状态 JSON，交给 refreshStatus 省一次 status 往返
        try {
          if (serviceRestartImpl) restartResult = await serviceRestartImpl();
          else {
            const rr = await cmdline('restart');
            if (!rr || Number(rr.errno) !== 0) throw new Error(rr?.stderr || '未知错误');
          }
          restarted = true;
        } catch (e) {
          uiToast('配置已保存，但服务重启失败：' + ((e && e.message) || e) + '；请查看运行状态和日志', 4600);
        }
        if (restarted) {
          // 重启成功 = 内核已按新配置运行：代理页缓存的旧出站数据整体作废。
          emitCoreConfigApplied();
          if (window.refreshStatus) await window.refreshStatus(false, false, restartResult);
          if (!silent) uiToast('✅ 配置已保存，服务已重启', 3200);
        }
      }
    } else if (!restartAfterSave && draftIsClean) {
      await maybeReloadCore();
    } else if (restartAfterSave && !draftIsClean && !silent) {
      uiToast('配置已保存；检测到新的未保存修改，暂未重启服务', 3800);
    }
    return true;
  } catch (e) {
    uiToast('保存失败，草稿已保留：' + ((e && e.message) || e), 4000);
    return false;
  } finally { state.saveBusy = false; }
}

// 内核运行中 → 使用 zashboard 同款重载 API，不自动回退脚本重启。
function showReloadFailure(error) {
  const status = Number(error?.status || 0);
  const rejected = status >= 400 && status < 500;
  const detail = String(error?.message || error || '无错误详情');
  uiLog('error', '配置热重载', status ? `HTTP ${status}` : '结果未知', detail);
  const title = (rejected ? '配置重载被拒绝' : '配置重载未确认') + (status ? `（HTTP ${status}）` : '');
  uiToast(title, 2500);
  const close = openChildSheet(title,
    note(rejected
      ? '控制器返回了以下错误。请按具体原因修正配置、保存后再试；可先运行“校验配置”。'
      : '未能确认本次重载结果，请检查内核运行状态。不会自动重发，也不会自动重启。'),
    h('pre', { class: 'logbox', style: 'max-height:320px;margin-top:10px', text: detail }),
    note('配置文件已经保存；本次失败不会自动撤销保存，也不会改用其他重载参数。'),
  );
  setSheetFooter(
    h('button', { class: 'btn', style: 'flex:1', text: '复制错误', onclick: async () => {
      const copied = await copyText(title + '\n' + detail);
      uiToast(copied ? '错误详情已复制' : '复制失败，请长按错误内容复制');
    } }),
    h('button', { class: 'btn pri', style: 'flex:1', text: '关闭', onclick: close }),
  );
}
let reloadCoreBusy = false;
async function maybeReloadCore() {
  if (!state.status || !state.status.running || DEMO) return;
  confirmSheet('内核正在运行', '是否让内核重载已保存的配置？使用与 zashboard 相同的 API；不会应用未保存草稿。', '热重载', async () => {
    if (reloadCoreBusy) { uiToast('配置重载进行中，请稍候'); return; }
    if (state.dirty) { uiToast('有新的未保存修改，请先保存配置'); return; }
    reloadCoreBusy = true;
    uiToast('正在重载配置…');
    try {
      await new Promise(resolve => setTimeout(resolve, 32));
      if (state.dirty) { uiToast('有新的未保存修改，请先保存配置'); return; }
      // 延迟导入，避免 core.js 与 mihomo-api.js 初始化时形成循环依赖。
      const { reloadConfigs } = await import('./mihomo-api.js');
      if (state.dirty) { uiToast('有新的未保存修改，请先保存配置'); return; }
      await reloadConfigs();
      // 热重载成功 = 内核已按新配置运行：代理页缓存的旧出站数据整体作废。
      emitCoreConfigApplied();
      uiToast('内核已接受配置重载', 3200);
    } catch (e) {
      showReloadFailure(e);
    } finally { reloadCoreBusy = false; }
  }, '稍后');
}

// ---------------- 底部弹层 ----------------
let activeSheet = null;
// 异步操作开始时捕获归属；用户已关闭/换弹层，回包不可覆盖后来打开的界面。
export function sheetGuard() { const owner = activeSheet; return () => activeSheet === owner; }

// 底部固定操作条：把「取消 / 保存」这类按钮放进去，长表单滚动时始终可见。
// 用法：const close = openSheet(...); setSheetFooter(取消按钮, 保存按钮);
export function setSheetFooter(...btns) {
  const footer = document.getElementById('sheetFooter');
  if (!footer) return;
  clearEl(footer);
  const list = btns.flat().filter(c => c != null);
  if (!list.length) { footer.hidden = true; return; }
  footer.append(...list);
  footer.hidden = false;
}
export function clearSheetFooter() {
  const footer = document.getElementById('sheetFooter');
  if (footer) { clearEl(footer); footer.hidden = true; }
}

// 识别「操作行」：只含 2~3 个按钮、且按钮文案命中操作词的 flex 行。
// 命中即移入固定底栏，长表单滚动时按钮始终可见。
// 用「完全相等」而非「包含」，避免把「复制路径」这类普通按钮误判成保存行。
const ACTION_WORDS = ['取消', '保存', '确定', '下载', '复制', '添加', '应用', '删除', '保存文件', '保存源码'];
function isActionRow(node) {
  if (!node || node.tagName !== 'DIV') return false;
  const kids = Array.from(node.children);
  if (kids.length < 2 || kids.length > 3) return false;
  if (!kids.every(k => k.tagName === 'BUTTON')) return false;
  return kids.some(k => ACTION_WORDS.includes((k.textContent || '').trim()));
}
// 取末尾的操作行：直接是最后一个子元素，或最后一个子元素的最后一行（嵌套写法）
function takeActionRow(nodes) {
  const last = nodes[nodes.length - 1];
  if (isActionRow(last)) return { row: last, pop: true };
  if (last && last.tagName === 'DIV') {
    const inner = last.children[last.children.length - 1];
    if (isActionRow(inner)) return { row: inner, pop: false };
  }
  return null;
}

export function openSheet(title, ...children) {
  return mountSheet(null, title, children);
}
// 嵌套编辑保留父层的 DOM、输入值、锚点选择、按钮与滚动，不靠重建表单猜回原内容。
export function openChildSheet(title, ...children) {
  let parent = null;
  if (activeSheet && !document.getElementById('sheet').hidden) {
    const content = document.getElementById('sheetContent'), footer = document.getElementById('sheetFooter');
    parent = {
      owner: activeSheet,
      content: Array.from(content.childNodes || content.children),
      footer: Array.from(footer.childNodes || footer.children),
      footerHidden: footer.hidden, top: content.scrollTop || 0,
    };
  }
  return mountSheet(parent, title, children);
}
function mountSheet(parent, title, children) {
  const mask = document.getElementById('sheetMask');
  const sheet = document.getElementById('sheet');
  const content = document.getElementById('sheetContent');
  const footer = document.getElementById('sheetFooter');
  const owner = { parent };
  activeSheet = owner;
  clearEl(content);
  clearSheetFooter();
  if (title) content.append(h('h3', { text: title }));
  const nodes = children.flat().filter(c => c != null);
  const found = takeActionRow(nodes);
  if (found) {
    const row = found.row;
    row.style.position = ''; row.style.bottom = ''; row.style.marginTop = '';
    setSheetFooter(...Array.from(row.children));
    if (found.pop) nodes.pop(); else row.remove();
  }
  content.append(...nodes);
  // 抓条下滑关闭：回调里现取 activeSheet，保证换层/嵌套时关的都是当前那一层。
  enableSheetGrab(sheet, mask, () => { if (activeSheet && activeSheet.close) activeSheet.close(); });
  if (sheet._grabReset) sheet._grabReset(true);   // 新一轮打开：清残留位移，并允许入场动画重新播
  mask.hidden = false; sheet.hidden = false;
  // 滚动归零必须放在「显示之后」：弹层隐藏时是 display:none，.sheet-content 没有盒模型，
  // 此时给 scrollTop 赋值会被规范直接忽略（静默无效）。旧代码在隐藏状态下清零，等于没清 ——
  // 上一次打开时滚到的位置就留给了下一个弹层（出站代理划到底 → 打开代理组也在底部），
  // 因为 #sheetContent 是全场共用的同一个节点。子层打开时弹层本来就是可见的，这里同样安全。
  const resetTop = () => { if (content.scrollTop !== 0) content.scrollTop = 0; };
  resetTop();
  // 内容里的图片/长文本可能异步撑高，首帧高度不够时浏览器会把位置钳在半路，下一帧再补一次。
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resetTop);
  const close = () => {
    if (activeSheet !== owner) return;   // 旧按钮/旧异步回调不能关掉后来打开的弹层
    if (parent) {
      clearEl(content); content.append(...parent.content);
      clearSheetFooter(); footer.append(...parent.footer); footer.hidden = parent.footerHidden;
      content.scrollTop = parent.top;
      activeSheet = parent.owner; mask.onclick = parent.owner.close;
    } else {
      // 收起前清零（还在显示状态，赋值有效）：滚动位置属于本次弹层，不带给下一个弹层。
      resetTop();
      mask.hidden = true; sheet.hidden = true; clearSheetFooter(); activeSheet = null;
      if (sheet._grabReset) sheet._grabReset();
    }
  };
  close.isCurrent = () => activeSheet === owner;
  owner.close = close; mask.onclick = close;
  return close;
}
// ---------------- 桌面端：Esc 关闭最上面那层 ----------------
// 手机端的关闭手段是点遮罩 / 抓条下滑；桌面端键盘用户习惯按 Esc。
// 只关最上面一层（选择弹层优先于普通弹层），一层都没有时不拦截 ——
// 这样输入框里按 Esc 的默认行为（清空 datalist 之类）不受影响。
export function closeTopLayer() {
  const selPop = document.getElementById('selPop');
  if (selPop && !selPop.hidden) { closeSelPop(); return true; }
  const sheet = document.getElementById('sheet');
  if (sheet && !sheet.hidden) {
    // 嵌套编辑时关的是当前那一层，父层连同输入值一起回来（closeSheet 会中断整条链）
    if (activeSheet && activeSheet.close) activeSheet.close(); else closeSheet();
    return true;
  }
  return false;
}

// 装上一次即可（重复调用无副作用）。放在 app.js 的 boot 里调用，
// 与其它窗口级监听同一时机，避免模块被导入就抢先注册。
export function installCloseOnEscape() {
  if (typeof window === 'undefined' || window.__escCloseInstalled) return;
  window.__escCloseInstalled = true;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (closeTopLayer()) e.preventDefault();
  });
}

export function closeSheet() {
  activeSheet = null;                 // 程序关闭 = 中止整条嵌套链，不遗留返回回调
  const content = document.getElementById('sheetContent');
  if (content) content.scrollTop = 0;  // 隐藏前清零（见 mountSheet 注释：隐藏后赋值无效）
  document.getElementById('sheetMask').hidden = true;
  const sheet = document.getElementById('sheet');
  sheet.hidden = true;
  clearSheetFooter();
  // 与 close() 一致：清掉拖动残留与手势状态，否则拖到一半被程序关掉，下次打开抓条可能按不动
  if (sheet._grabReset) sheet._grabReset();
}

// ---------------- 键盘高度观察（浏览器访问模式：弹层贴着输入法往上排） ----------------
// 管理器 WebView 是 adjustResize：键盘弹出时布局视口整体被压矮，.sheet 的 96dvh 跟着
// 缩，底栏天然贴在键盘上沿。Chromium 系浏览器默认却是 resizes-visual：只缩 visual
// viewport，布局视口、dvh、fixed 定位的弹层全部原地不动 —— 底栏留在屏幕底被键盘盖住。
// index.html 的 viewport 里已写 interactive-widget=resizes-content，认它的浏览器直接
// 改布局视口（等价管理器行为）；不认这个声明的（旧内核 / iOS Safari）走这里的兜底：
// 量出「布局视口高 − visual viewport 高」当作键盘高度写进 --kb-h，CSS 用它把弹层从
// 屏幕底抬到键盘上沿。管理器/新浏览器模式下两者一起变矮、差值恒 0，兜底自动不生效。
const KB_TH = 120;   // 低于它不算键盘：地址栏收起/展开这类只有几十像素的抖动
function keyboardHeight() {
  const vv = window.visualViewport;
  if (!vv) return 0;
  if (Math.abs((vv.scale || 1) - 1) > 0.01) return -1;   // 双指缩放的高度差来自缩放，不是键盘
  const vh = document.documentElement.clientHeight || window.innerHeight || 0;
  const kb = vh - vv.height - (vv.offsetTop || 0);       // offsetTop：键盘弹出时浏览器平移 visual viewport 露出光标
  if (kb < KB_TH) return 0;
  return Math.min(kb, Math.round(vh * 0.7));
}
let kbCurrent = 0, kbTopCurrent = 0;
function applyKeyboard() {
  const kb = keyboardHeight();
  if (kb < 0) return;                     // 缩放中：既不新抬也不放下，保持现状
  // 兜底生效时浏览器可能把 visual viewport 往下平移（offsetTop）来露出光标：这段平移量单独
  // 写进 --kb-top，.sheet / .sel-pop 的高度上限再扣掉它，高弹层的顶边与抓条才留在可见区里。
  const vv = window.visualViewport;
  const kbTop = kb > 0 && vv ? Math.max(0, Math.round(vv.offsetTop || 0)) : 0;
  if (kbTop !== kbTopCurrent) {
    kbTopCurrent = kbTop;
    document.documentElement.style.setProperty('--kb-top', kbTop + 'px');
  }
  if (kb === kbCurrent) return;
  kbCurrent = kb;
  document.documentElement.style.setProperty('--kb-h', kb + 'px');
  // 键盘高度变了，按视口排高度的组件（源码编辑器）要跟着重排：app.js 监听这个事件
  document.dispatchEvent(new CustomEvent('kb:h', { detail: kb }));
}
if (typeof window !== 'undefined') {
  window.addEventListener('resize', applyKeyboard);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', applyKeyboard);
    window.visualViewport.addEventListener('scroll', applyKeyboard);
  }
}

// ---------------- 抓条下滑关闭（所有底部弹层） ----------------
// 按住弹层顶部的横条往下滑：弹层跟手位移、遮罩随进度变淡；松手时按「拖过阈值」或
// 「快速下滑（fling）」决定是继续滑走关闭，还是弹回原位。位移与过渡只在拖动/收尾这两段
// 存在，落位后立刻清干净 —— 常驻 transform 会让旧版 Android WebView 里弹层内的输入框
// 点不出软键盘（IME 拿到的是变换后的坐标，见 .sheet 用 margin 居中那段说明）。
const GRAB_ZONE = 30;      // 顶部热区高度：横条本体只有 4.5px，太细按不住，整条顶部都算抓手
const GRAB_HEAD_MAX = 120; // 标题行热区的下沿上限（相对面板顶）：防御异常高的标题把热区撑进内容
const GRAB_DIR = 6;        // 标题行起手：手指走出这么多像素才判定方向
const GRAB_MIN = 60;       // 至少要拖这么远才可能关闭（避免矮弹层一碰就没）
const GRAB_RATIO = 0.24;   // 或者拖过弹层高度的这个比例（高弹层够不着时才需要甩一下）
const GRAB_FLING = 0.6;    // px/ms（≈600px/s）：明确的一甩即便位移不大也直接关
const grabNow = () => (window.performance && window.performance.now ? window.performance.now() : Date.now());
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// panel：弹层面板；mask：配套遮罩（可为 null）；close：真正关闭它的函数。
// 同一个面板只绑一次（_grabReady），重复调用安全。
export function enableSheetGrab(panel, mask, close) {
  if (!panel || panel._grabReady) return;
  panel._grabReady = true;
  const maskOf = typeof mask === 'function' ? mask : () => mask;
  const closeOf = typeof close === 'function' ? close : () => {};
  const reduced = prefersReducedMotion();
  const hasPointer = typeof window.PointerEvent === 'function';
  let pid = null, touchId = null, active = false, moved = false, settling = false;
  let startY = 0, lastY = 0, lastT = 0, dy = 0, vel = 0, h0 = 1, timer = 0;
  // 标题行起手的「待定」手势：{ id: pointerId, touch: 触点 identifier, x, y, t, mouse }。
  // headGrab：当前拖动是从标题行接管来的（后续 touchmove 要一路拦住浏览器滚动）。
  let pend = null, headGrab = false;

  // fresh = true：弹层刚被打开，入场动画该重新播一次（摘掉 grab-intro-off）。
  // fresh 省略（收尾/关闭）：只清位移，**保留 grab-intro-off** —— 这是关键：
  // 拖动期间为了跟手写了 animation: none，一旦摘掉这个类，浏览器会把 .sheet 上那条
  // sheetUp 入场动画当成「重新开始」再播一遍（24px 上滑 + 透明度 0.6→1），
  // 真机观感就是「松手后弹窗自己微微上下抖一下」。
  const resetStyles = (fresh) => {
    panel.style.transition = ''; panel.style.transform = '';
    panel.classList.remove('grab-drag');
    if (fresh) panel.classList.remove('grab-intro-off');
    const m = maskOf();
    if (m) { m.style.transition = ''; m.style.opacity = ''; }
  };
  const resetState = () => {
    settling = false; active = false; moved = false; pid = null; touchId = null; dy = 0; vel = 0;
    pend = null; headGrab = false;
    panel._grabActive = false;
    clearTimeout(timer); timer = 0;
  };
  // 手势若被打断（切页、程序关闭、动画丢帧），残留的 transform 会让下次打开错位：
  // 每次开始与结束都清一遍，绝不留常驻位移。
  const cleanup = () => { resetState(); resetStyles(); };
  // 供开/关弹层时兜底清理。不只清样式，手势状态机也整个复位：
  // 上一层「滑走关闭」若还在收尾计时，新打开的弹层会被那个过期计时器当成当前层关掉；
  // 残留的 settling/active 还会让新弹层的抓条怎么按都不动。
  panel._grabReset = (fresh) => { resetState(); resetStyles(fresh); };

  const inGrabZone = (y, x) => {
    const r = panel.getBoundingClientRect();
    if (x !== undefined && (x < r.left - 2 || x > r.right + 2)) return false;
    return y >= r.top - 10 && y <= r.top + GRAB_ZONE;   // 圆角上沿也算：手指常按在边缘
  };
  // 标题行也算抓手：横条下面紧挨着的标题（#sheet 是内容区第一个 h3，#selPop 是面板直属 h3）。
  // 手指按横条时实际落点常偏下十几二十像素，正好落在标题上沿的留白里 —— 以前这里是死区，
  // 按住往下拉毫无反应，看起来就是「按住小白条拉不动」。
  const headOf = () => {
    const box = panel.querySelector(':scope > .sheet-content');
    const el = box ? box.firstElementChild : panel.firstElementChild;
    return el && el.tagName === 'H3' && !el.hidden ? el : null;
  };
  const inHeadZone = (y, x, target) => {
    const hd = headOf();
    if (!hd) return false;
    const box = hd.parentElement === panel ? null : hd.parentElement;
    if (box && box.scrollTop > 1) return false;   // 内容已往下滚：此时往下拖应先把内容滚回顶部
    const r = panel.getBoundingClientRect(), hr = hd.getBoundingClientRect();
    if (x < r.left || x > r.right) return false;
    if (y <= r.top + GRAB_ZONE || y > Math.min(hr.bottom + 6, r.top + GRAB_HEAD_MAX)) return false;
    // 只认标题文字与它周围的留白；任何可操作的控件都不抢
    if (target && target.closest && target.closest('button, a, input, select, textarea, label, [role="button"], [contenteditable]')) return false;
    return target === panel || target === hd || (box && target === box) || hd.contains(target);
  };
  const begin = (y, t, force) => {
    if (settling || active) return false;
    if (!force && !inGrabZone(y)) return false;
    const r = panel.getBoundingClientRect();
    h0 = panel.offsetHeight || r.height || 1;
    active = true; moved = false; dy = 0; vel = 0;
    panel._grabActive = true;    // 手势进行中标记：别的东西（如编辑器按视口重排高度）先避让
    startY = lastY = y; lastT = t;
    // 过渡先关（跟手），入场动画也停掉：正在播的 sheetUp 会盖过内联 transform。
    // grab-intro-off 一直留到下次打开为止（见 resetStyles 注释），否则收尾时会重播入场动画。
    panel.style.transition = 'none';
    panel.classList.add('grab-drag', 'grab-intro-off');
    noteInteraction(600);
    return true;
  };
  const move = (y, t) => {
    if (!active) return false;
    const dt = Math.max(1, t - lastT);
    vel = (y - lastY) / dt;
    lastY = y; lastT = t;
    dy = Math.max(0, y - startY);        // 只认往下：往上没有可露出的空间
    if (!moved && dy < 4) return false;  // 轻点不算拖
    moved = true;
    noteInteraction(600);
    panel.style.transform = 'translateY(' + dy + 'px)';
    const m = maskOf();
    if (m) m.style.opacity = String(clamp01(1 - dy / h0));
    return true;
  };
  const settle = (back, then) => {
    if (!active && !settling) return;
    settling = true; active = false; pend = null;
    const dur = reduced ? 0 : 240;
    const m = maskOf();
    panel.style.transition = 'transform ' + dur + 'ms cubic-bezier(.32,.72,.35,1)';
    if (m) m.style.transition = 'opacity ' + dur + 'ms ease';
    void panel.offsetWidth;              // 强制回流：让新过渡先落地再改目标值
    panel.style.transform = back ? '' : 'translateY(' + Math.max(h0, dy) + 'px)';
    if (m) m.style.opacity = back ? '' : '0';
    clearTimeout(timer);
    timer = setTimeout(() => {
      // 顺序要紧：先真正关闭（置 hidden），再清位移。反过来的话，移除内联 transform 会让
      // 弹层在那一帧闪回原位再消失。
      // finally：关闭回调万一抛错也必须复位，否则 settling 永远为真，此后抓条再也按不动。
      try { if (!back && then) then(); }
      finally { cleanup(); }
    }, dur + 40);
  };
  const end = () => {
    if (!active) return;
    const fling = vel > GRAB_FLING && dy > 12;   // 甩手：位移不大但明显往下带
    const far = dy >= Math.max(GRAB_MIN, h0 * GRAB_RATIO);
    if (moved && (far || fling)) settle(false, closeOf);
    else settle(true);
  };
  // 标题行起手：首段位移明确向下 → 接管成抓条拖动；向上/横向 → 放弃，照常交给浏览器滚动内容。
  // 返回接管成功的待定记录，否则 null。ev 为触发判定的 touchmove（鼠标路径为 null）。
  const resolvePend = (x, y, ev) => {
    const p = pend;
    if (!p) return null;
    const ddx = x - p.x, ddy = y - p.y;
    if (Math.abs(ddx) < GRAB_DIR && Math.abs(ddy) < GRAB_DIR) return null;   // 还没走出判定距离
    pend = null;
    if (!(ddy > 0 && ddy > Math.abs(ddx) * 1.2)) return null;
    if (ev && !ev.cancelable) return null;       // 浏览器已经开始滚动：拦不住就不抢
    if (!begin(p.y, p.t, true)) return null;
    if (ev) ev.preventDefault();                 // 拦下首个 touchmove：浏览器不会再把这一划当滚动
    headGrab = true;
    return p;
  };
  const findTouch = (list, id) => Array.from(list || []).find(t => t.identifier === id) || null;

  // 触摸路径先吞掉默认行为：不拦的话浏览器一接管（页面滚动/缩放/长按选字）就会发
  // pointercancel，拖动刚起步就被收掉。
  // #sheet 的抓条元素可以写 touch-action: none，但 #selPop 的横条是 ::before —— 父级
  // 设 none 会连带禁掉选项列表的滚动（touch-action 对后代取交集），所以这一条必须有，
  // 且必须是「非被动」监听，否则 preventDefault 不生效。
  // 标题行不在这里拦：点按、上滑滚内容都要照常，方向由下面的 touchmove 判定。
  panel.addEventListener('touchstart', (e) => {
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    if (inGrabZone(t.clientY, t.clientX)) { if (e.cancelable) e.preventDefault(); return; }
    if (active || settling) return;
    if (hasPointer) {
      // pointerdown 先于 touchstart 派发：待定记录已建好，这里补上触点编号供 touchmove 对号
      if (pend && pend.touch === null && !pend.mouse) pend.touch = t.identifier;
      return;
    }
    if (e.touches && e.touches.length > 1) { pend = null; return; }   // 多指：不是抓条手势
    pend = inHeadZone(t.clientY, t.clientX, e.target)
      ? { id: null, touch: t.identifier, x: t.clientX, y: t.clientY, t: grabNow(), mouse: false }
      : null;
  }, { passive: false });
  panel.addEventListener('touchmove', (e) => {
    if (active && headGrab) { if (e.cancelable) e.preventDefault(); return; }   // 已接管：一路拦住浏览器滚动
    if (!pend || pend.mouse || pend.touch === null) return;
    const t = findTouch(e.changedTouches, pend.touch);
    if (!t) return;
    const p = resolvePend(t.clientX, t.clientY, e);
    if (!p) return;
    if (hasPointer) { pid = p.id; try { panel.setPointerCapture(p.id); } catch (_) {} }
    else touchId = p.touch;
  }, { passive: false });
  // 待定记录的兜底清除：手指/鼠标在面板外抬起时面板收不到 up 事件
  const dropPend = () => { pend = null; };
  window.addEventListener(hasPointer ? 'pointerup' : 'touchend', dropPend, true);
  window.addEventListener(hasPointer ? 'pointercancel' : 'touchcancel', dropPend, true);

  if (hasPointer) {
    panel.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.isPrimary !== false) pend = null;    // 新一轮手势：之前没收尾的待定记录作废
      if (begin(e.clientY, grabNow())) {
        pid = e.pointerId;
        // 取消 pointerdown 的默认行为：不然这一按会被当成「点了输入框外面的空白」——
        // 安卓上正在编辑时点空白会收起输入法，键盘收起的瞬间布局视口长高、弹层跟着变高，
        // 松手后看着就是「弹窗自己上下跳一下」。抓条上没有任何可点内容，拦掉没有副作用。
        if (e.cancelable) e.preventDefault();
        try { panel.setPointerCapture(e.pointerId); } catch (_) {}
      } else if (!active && !settling && e.isPrimary !== false && inHeadZone(e.clientY, e.clientX, e.target)) {
        // 标题行：先不抢（不 preventDefault、不捕获），等首段位移定方向
        pend = { id: e.pointerId, touch: null, x: e.clientX, y: e.clientY, t: grabNow(), mouse: e.pointerType === 'mouse' };
      }
    });
    panel.addEventListener('pointermove', (e) => {
      if (pid === null) {
        // 鼠标没有触摸事件：标题行起手在这里定方向（鼠标拖动不会触发页面滚动，无需拦截）
        if (pend && pend.mouse && e.pointerId === pend.id) {
          const p = resolvePend(e.clientX, e.clientY, null);
          if (p) { pid = p.id; try { panel.setPointerCapture(p.id); } catch (_) {} move(e.clientY, grabNow()); }
        }
        return;
      }
      if (e.pointerId !== pid) return;
      if (move(e.clientY, grabNow()) && e.cancelable) e.preventDefault();
    });
    panel.addEventListener('pointerup', (e) => {
      if (pend && e.pointerId === pend.id) pend = null;
      if (pid !== null && e.pointerId === pid) end();
    });
    panel.addEventListener('pointercancel', (e) => {
      if (pend && e.pointerId === pend.id) pend = null;
      if (pid !== null && e.pointerId === pid) settle(true);
    });
    panel.addEventListener('lostpointercapture', (e) => {
      // 只认面板自己丢了捕获。触摸按下时浏览器会把指针隐式捕获到命中的子元素（抓条/标题），
      // 随后 setPointerCapture 把捕获换到面板 —— 部分内核会就此在子元素上补发一次
      // lostpointercapture 并冒泡到面板。那不是「手势被打断」，若按打断处理，拖动刚起步
      // 就被复位：表现正是「按住小白条往下拉，弹层不跟手」。
      if (e.target !== panel) return;
      if (pid !== null && e.pointerId === pid && active) settle(true);
    });
  } else {
    // 老 WebView 没有 PointerEvent：退回触摸事件（同样要非被动才能拦住页面滚动）
    panel.addEventListener('touchstart', (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      if (begin(t.clientY, grabNow())) { pend = null; touchId = t.identifier; if (e.cancelable) e.preventDefault(); }
    }, { passive: false });
    panel.addEventListener('touchmove', (e) => {
      const t = touchId === null ? null : findTouch(e.changedTouches, touchId);
      if (!t) return;
      if (move(t.clientY, grabNow()) && e.cancelable) e.preventDefault();
    }, { passive: false });
    panel.addEventListener('touchend', (e) => {
      if (pend && findTouch(e.changedTouches, pend.touch)) pend = null;
      if (touchId !== null && findTouch(e.changedTouches, touchId)) end();
    });
    panel.addEventListener('touchcancel', () => { pend = null; if (touchId !== null) settle(true); });
  }
}

export function confirmSheet(title, msg, okText, onOk, cancelText = '取消', danger = false) {
  const close = openSheet('',
    h('div', { style: 'text-align:center;padding:8px 0 4px;font-size:17px;font-weight:750', text: title }),
    h('div', { class: 'note', style: 'text-align:center;margin-top:8px', text: msg }),
    h('div', { style: 'display:flex;gap:10px;margin-top:16px' },
      h('button', { class: 'btn block', text: cancelText, onclick: () => close() }),
      h('button', { class: `btn block ${danger ? 'danger' : 'pri'}`, text: okText, onclick: () => { close(); onOk && onOk(); } }),
    ),
  );
  return close;
}

// ---------------- 级联选择弹层(不占 #sheet,sheet 内下拉不再销毁父 sheet) ----------------
let _selPopMask = null, _selPop = null;
function ensureSelPop() {
  if (_selPopMask) return;
  _selPopMask = h('div', { class: 'sel-pop-mask', id: 'selPopMask', hidden: true });
  _selPop = h('div', { class: 'sel-pop', id: 'selPop', hidden: true });
  _selPopMask.onclick = () => closeSelPop();
  // 与 #sheet 同款抓条：下拉关闭（这个弹层的横条是 ::before 画的，热区按坐标判定）
  enableSheetGrab(_selPop, _selPopMask, () => closeSelPop());
  document.body.append(_selPopMask, _selPop);
}
// 下拉弹层的滚动位置：与 #sheet 同一个坑（隐藏时 display:none，scrollTop 赋值被忽略，
// 上一轮的列表位置会留给下一个下拉），所以一律在「显示之后」清零。
function resetSelPopScroll() {
  const list = _selPop && _selPop.querySelector('.optlist');
  if (!list) return;
  if (list.scrollTop !== 0) list.scrollTop = 0;
}
export function closeSelPop() {
  ensureSelPop();
  resetSelPopScroll();                            // 隐藏前清零（此时赋值有效）
  _selPopMask.hidden = true; _selPop.hidden = true;
  if (_selPop._grabReset) _selPop._grabReset();   // 清掉拖动残留的位移
}
export function openSelPop(title, ...children) {
  ensureSelPop();
  _selPop.innerHTML = '';
  if (title) _selPop.append(h('h3', { text: title }));
  _selPop.append(...children.flat().filter(c => c != null));
  if (_selPop._grabReset) _selPop._grabReset(true);   // 同上：新打开的一轮，入场动画照常
  _selPopMask.hidden = false; _selPop.hidden = false;
  resetSelPopScroll();                                // 显示之后清零，保证每次下拉都从顶部开始
  if (typeof requestAnimationFrame === 'function') {
    const list = _selPop && _selPop.querySelector('.optlist');
    requestAnimationFrame(() => { if (list && list.isConnected && list.scrollTop !== 0) list.scrollTop = 0; });
  }
  return closeSelPop;
}

// 带搜索的 Miuix 选项弹层（替代原生 datalist/by 系统下拉）
// options 支持两种写法：'名称' 或 ['名称', '一行说明']。
// 带说明的用于内置策略（DIRECT/REJECT/PASS…），让人一眼看懂选的是什么。
export function openPickPop(title, options, onPick) {
  const list = (options || []).map(o => Array.isArray(o)
    ? { v: String(o[0]), s: o[1] == null ? '' : String(o[1]) }
    : { v: String(o), s: '' });
  const box = h('div', { class: 'optlist' });
  const search = h('input', { type: 'text', placeholder: '搜索', style: 'width:100%' });
  function renderRows() {
    box.innerHTML = '';
    const kw = search.value.trim().toLowerCase();
    const hits = kw ? list.filter(o => o.v.toLowerCase().includes(kw) || o.s.toLowerCase().includes(kw)) : list;
    if (!hits.length) box.append(h('div', { class: 'empty', text: '无匹配项' }));
    hits.forEach(o => {
      const row = h('div', { class: 'opt' },
        h('span', { class: 'radio' }),
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title', text: o.v }),
          o.s ? h('div', { class: 'li-sub', text: o.s }) : null));
      row.onclick = () => { closeSelPop(); onPick && onPick(o.v); };
      box.append(row);
    });
  }
  search.addEventListener('input', renderRows);
  renderRows();
  return openSelPop(title, h('div', { style: 'padding:0 16px;margin-bottom:8px' }, search), box);
}

// ---------------- 控件 ----------------
export function switchCtl(value, onChange, opts = {}) {
  const input = h('input', { type: 'checkbox', checked: !!value });
  const btn = h('label', { class: 'switch' }, input, h('span', { class: 'tr' }), h('span', { class: 'th' }));
  input.addEventListener('change', () => onChange(input.checked));
  if (opts.disabled) input.disabled = true;
  return btn;
}

export function segCtl(options, current, onChange) {
  const seg = h('div', { class: 'seg' });
  const btns = options.map(([val, label]) => {
    const b = h('button', { text: label, class: String(val) === String(current) ? 'on' : '' });
    b.onclick = () => {
      btns.forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      onChange(val);
    };
    seg.append(b);
    return b;
  });
  return seg;
}

// Miuix 风格下拉控件（替代原生 <select>，避免系统选择器破坏主题统一）
// API 与原生 select 对齐：.value 读写、.setOptions([[v,l]])、change 事件
export function selectCtl(options, current, opts = {}) {
  let opts2 = (options || []).map(([v, l]) => [String(v), l ?? String(v)]);
  let cur = current !== undefined && current !== null ? String(current) : (opts2.length && !opts.allowEmpty ? opts2[0][0] : '');
  if (opts.allowEmpty && !opts2.some(([v]) => v === '')) opts2 = [['', opts.emptyLabel || '默认（不覆写）'], ...opts2];
  const btn = h('button', { type: 'button', class: 'selctl' });
  const labelOf = () => {
    const hit = opts2.find(([v]) => v === cur);
    return hit ? hit[1] : (cur === '' ? (opts.emptyLabel || '默认（不覆写）') : cur);
  };
  function render() {
    btn.innerHTML = '';
    btn.append(
      h('span', { class: 'sv', text: labelOf() }),
      h('span', { class: 'sel-chev', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' }));
  }
  btn.onclick = () => {
    if (btn.disabled) return;
    const rows = opts2.map(([v, l]) => {
      const on = v === cur;
      const row = h('div', { class: `opt ${on ? 'on' : ''}` },
        h('span', { class: 'radio' }),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title', text: l })));
      row.onclick = () => {
        if (String(v) !== cur) {
          cur = String(v);
          render();
          btn.dispatchEvent(new window.Event('change'));
        }
        closeFn();
      };
      return row;
    });
    const closeFn = openSelPop(opts.title || '请选择', h('div', { class: 'optlist' }, ...rows));
  };
  Object.defineProperty(btn, 'value', {
    get: () => cur,
    set: (v) => { cur = v === undefined || v === null ? '' : String(v); render(); },
  });
  btn.setOptions = (list) => { opts2 = (list || []).map(([v, l]) => [String(v), l ?? String(v)]); render(); };
  render();
  return btn;
}

export function badge(text, cls = '') { return h('span', { class: `badge ${cls}`, text }); }

// ============================================================
// 长文本横向滚动（超出裁剪宽度时缓慢来回滚，用于列表里放不下的标题 / 副标题）
// ------------------------------------------------------------
// 结构：裁剪容器（.marquee，overflow:hidden + nowrap）> 内层 span.marquee-text（真实文字）。
//   · 只有真的溢出才挂 is-overflow，放得下就是普通文字（本来就不会溢出，连省略号都用不上）；
//   · 宽度是会变的：横屏后宽出一截、窗口拉伸、抽屉展开、栅格换列都会改宽度，
//     所以量一次不算数 —— ResizeObserver 盯住每个格子的宽度，变了就重量：
//     宽到放得下 → 撤掉滚动、文字回到原位；又窄了 → 再滚起来；
//   · 量不到宽度（页面没揭开、格子还没参与布局）时保持原样，交给
//     IntersectionObserver 等它进入视口后再量 —— 与代理页节点名同一套做法；
//   · 位移量走 --marquee-shift、速度走 --marquee-dur，变量名与 CSS 是同一个约定。
// 代理页的节点名有自己的实现（.proxy-node-name / --node-shift），这里不碰它。
// ============================================================
export function marqueeText(text, cls = '') {
  return h('span', { class: `marquee ${cls}`.trim() }, h('span', { class: 'marquee-text', text }));
}

// 登记过的裁剪容器：宽度一变就挨个重量（横屏后文字能不能放下，和竖屏完全是两个答案）
const marqueeClips = new Set();
let marqueeObserver = null;   // 进视口后补量第一次
let marqueeResizer = null;    // 宽度变化后接着量（横屏变宽 → 不再滚）
let marqueeTimer = 0;         // 兜底路径的防抖句柄
let marqueeWired = false;     // 兜底监听是否已挂上

// 兜底：没有 ResizeObserver 的环境（老 WebView）退回窗口 resize / orientationchange。
// 转屏时浏览器常连着触发好几次，这里并成一次量。
function scheduleMarqueeRemeasure() {
  if (marqueeTimer) return;
  marqueeTimer = setTimeout(() => { marqueeTimer = 0; remeasureMarquees(); }, 160);
}

// 按当前宽度把所有格子重新判一遍。顺手把已经不在文档里的摘掉（页面重建后不残留）。
export function remeasureMarquees() {
  marqueeClips.forEach(clip => {
    if (!clip.isConnected) {
      marqueeClips.delete(clip);
      if (marqueeResizer) marqueeResizer.unobserve(clip);
      return;
    }
    measureMarqueeText(clip);
  });
}

export function observeMarqueeText(clip) {
  if (!clip) return;
  marqueeClips.add(clip);
  if (typeof IntersectionObserver === 'undefined') measureMarqueeText(clip);
  else {
    if (!marqueeObserver) {
      marqueeObserver = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (!e.isIntersecting) return;
          marqueeObserver.unobserve(e.target);   // 量过一次就不再关注视口
          measureMarqueeText(e.target);
        });
      }, { rootMargin: '160px 0px' });
    }
    marqueeObserver.observe(clip);
  }
  // 盯住宽度：只量一次的话，横屏之后文字早就放得下了，动画还在那儿来回滚
  if (typeof ResizeObserver !== 'undefined') {
    if (!marqueeResizer) {
      marqueeResizer = new ResizeObserver(entries => {
        entries.forEach(e => measureMarqueeText(e.target));
      });
    }
    marqueeResizer.observe(clip);
  } else if (typeof window !== 'undefined' && !marqueeWired) {
    window.addEventListener('resize', scheduleMarqueeRemeasure);
    window.addEventListener('orientationchange', scheduleMarqueeRemeasure);
    marqueeWired = true;
  }
}

export function measureMarqueeText(clip) {
  const text = clip && clip.querySelector ? clip.querySelector('.marquee-text') : null;
  if (!text) return false;
  // 还没布局（页面没揭开、格子不在视口内）时宽度是 0，这时判不出「放不下」：
  // 保持现状，等 IntersectionObserver / ResizeObserver 换个时机再量。
  if (!clip.clientWidth) return false;
  // 文字宽 - 容器宽 = 需要滚动的距离；末尾多留 10px，滚到底不贴边
  const distance = Math.max(0, text.scrollWidth - clip.clientWidth);
  if (distance <= 2) {
    // 放得下（横屏最常见）：撤掉滚动与位移，文字回到常规排版
    clip.classList.remove('is-overflow');
    clip.style.removeProperty('--marquee-shift');
    clip.style.removeProperty('--marquee-dur');
    return false;
  }
  const shift = `${distance + 10}px`;
  // 速度大致恒定：位移越远滚得越久，免得长文本一闪而过、短文本半天不动
  const dur = `${Math.min(12, Math.max(3.5, distance / 28)).toFixed(1)}s`;
  // 值没变就一个属性都不碰：正在滚的动画被打断会从头跳一遍
  if (clip.style.getPropertyValue('--marquee-shift') !== shift) clip.style.setProperty('--marquee-shift', shift);
  if (clip.style.getPropertyValue('--marquee-dur') !== dur) clip.style.setProperty('--marquee-dur', dur);
  clip.classList.add('is-overflow');
  return true;
}

// 页面重建前调用：断开两个观察者、摘掉兜底监听，别让被替换掉的格子继续被持有
export function stopMarqueeObservation() {
  if (marqueeTimer) { clearTimeout(marqueeTimer); marqueeTimer = 0; }
  if (marqueeObserver) { marqueeObserver.disconnect(); marqueeObserver = null; }
  if (marqueeResizer) { marqueeResizer.disconnect(); marqueeResizer = null; }
  if (marqueeWired && typeof window !== 'undefined') {
    window.removeEventListener('resize', scheduleMarqueeRemeasure);
    window.removeEventListener('orientationchange', scheduleMarqueeRemeasure);
    marqueeWired = false;
  }
  marqueeClips.clear();
}

export function chev() {
  return h('span', { class: 'chev', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>' });
}

export function card(...children) { return h('div', { class: 'card' }, children); }
export function groupTitle(text) { return h('div', { class: 'group-title', text }); }
export function note(text, cls = '') { return h('div', { class: `note ${cls}`, html: text }); }

// ---------------- 剪贴板 ----------------
// KernelSU WebUI 走 http://，不是安全上下文，navigator.clipboard 常不可用，
// 必须回退到 textarea + execCommand。
export async function copyText(t) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (e) { /* 落到下面的回退 */ }
  try {
    const ta = h('textarea', { 'data-no-autogrow': '1', style: 'position:fixed;top:0;left:-9999px;opacity:0' });
    ta.value = t;
    document.body.append(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, t.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

// 用户是否正在该节点内选择文本（长按选词/拖选复制中）
export function hasSelectionIn(node) {
  const sel = (typeof window.getSelection === 'function') ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || !sel.toString()) return false;
  return node.contains(sel.anchorNode) || node.contains(sel.focusNode);
}

// ---------------- 演示模式配置 ----------------
const DEMO_CONFIG = `# 演示配置（浏览器预览模式）
mixed-port: 7890
allow-lan: false
mode: rule
log-level: warning
ipv6: true
unified-delay: true
tcp-concurrent: true
external-controller: 127.0.0.1:9090
secret: mihomo-ksu
dns:
  enable: true
  listen: 0.0.0.0:7874
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  default-nameserver:
    - 223.5.5.5
  nameserver:
    - https://223.5.5.5/dns-query
tun:
  enable: false
  stack: system
proxies: []
proxy-providers: {}
proxy-groups:
  - name: 节点选择
    type: select
    proxies:
      - Smart 自动选择
      - 自动测速
      - DIRECT
  - name: Smart 自动选择
    type: smart
    proxies:
      - DIRECT
    url: https://cp.cloudflare.com/generate_204
    interval: 300
rules:
  - GEOSITE,private,DIRECT
  - GEOSITE,cn,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,节点选择
`;

// 通用拖动排序：容器内通过 .drag-handle 拖动 selector 匹配的行
function prefersReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (e) { return false; }
}

export function enableDragSort(container, selector, onReorder) {
  if (!container || typeof onReorder !== 'function') return;
  // 复用同一容器多次调用：只绑一次事件，回调可更新
  container._dragSortCb = onReorder;
  container._dragSortSel = selector;
  if (container._dragSortBound) return;
  container._dragSortBound = true;
  let dragEl = null, dragIdx = -1, moveRaf = 0, pendX = 0, pendY = 0, capId = -1;
  const dropCap = () => {   // 释放捕获只认容器：捕获目标必须一直可命中，别去摸把手
    if (capId < 0) return;
    try { container.releasePointerCapture(capId); } catch (_) {}
    capId = -1;
  };
  // —— 拖到滚动区上/下沿自动翻滚（长列表够到首尾位置）——
  let scroller = null, scrollRaf = 0, dragMoved = false;
  const docScroller = () => document.scrollingElement || document.documentElement || document.body;
  const scrollable = (el) => {
    if (!el || el.scrollHeight == null || el.clientHeight == null) return false;
    if (el.scrollHeight <= el.clientHeight + 1) return false;
    if (el === docScroller() || el === document.documentElement || el === document.body)
      return true;   // 窗口滚动：html/body 的 overflowY 是 visible 也能滚——主页面列表全靠这条
    try {
      const cs = window.getComputedStyle && window.getComputedStyle(el);
      if (cs) return /auto|scroll/.test(cs.overflowY || '');
    } catch (_) {}
    return true;
  };
  const findScroller = (start) => {
    for (let el = start; el && el !== docScroller(); el = el.parentElement) if (scrollable(el)) return el;
    const ds = docScroller();
    return ds && ds.scrollHeight != null && ds.scrollHeight > ds.clientHeight + 1 ? ds : null;
  };
  const edgeScrollOnce = () => {   // 悬停近边缘则滚一帧；返回是否真的滚了
    const sc = scroller;
    if (!sc || !dragMoved) return false;   // 只按下未动不滚：光点把手绝不能把列表带着走
    let top = 0, bot = (window.innerHeight || 0);
    if (sc !== docScroller()) { const rr = sc.getBoundingClientRect(); top = rr.top; bot = rr.bottom; }
    const span = Math.max(120, bot - top);
    const E = Math.min(88, Math.max(44, span * 0.15));          // 越界越深滚越快：≈1~14px/帧
    const up = (top + E) - pendY, dn = pendY - (bot - E);
    if (up <= 0 && dn <= 0) return false;
    const depth = Math.min(E, Math.max(0, Math.max(up, dn)));
    const v = 1 + (depth / E) * 13;
    const before = sc.scrollTop;
    sc.scrollTop = before + (up > dn ? -v : v);
    if (sc.scrollTop === before) return false;                   // 已到尽头：不空转
    noteInteraction(140);                                         // 滚动期间同样冻结周期任务
    return true;
  };
  const scrollTick = () => {          // 只在拖拽期间存活的帧循环，松手即止，不留常驻定时器
    if (!dragEl) { scrollRaf = 0; return; }
    if (edgeScrollOnce()) step();     // 滚一帧=行在指下挪了，立刻补一轮命中判定
    scrollRaf = requestAnimationFrame(scrollTick);
  };
  const clearOver = () => {
    const sel = container._dragSortSel;
    container.querySelectorAll(sel + '.drag-over').forEach(el => el.classList.remove('drag-over'));
  };
  container.addEventListener('pointerdown', (e) => {
    const sel = container._dragSortSel;
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const item = handle.closest(sel);
    if (!item || !container.contains(item)) return;
    const items = Array.from(container.querySelectorAll(sel));
    dragIdx = items.indexOf(item);
    if (dragIdx === -1) return;
    // 残留救援：上一次拖拽若因事件丢失没走到收尾（卡住的 .dragging 虚线框 + pointer-events:none
    // 会永久留在列表里，还连带下一次拖拽一起乱），新按下先把旧状态就地收干净再开新拖
    if (dragEl && dragEl !== item) {
      clearOver();
      dragEl.classList.remove('dragging');
      dragEl.style.pointerEvents = '';
      dropCap();
      dragEl = null; dragIdx = -1;
    }
    dragEl = item;
    dragEl.classList.add('dragging');
    noteInteraction(600);
    // 让 elementFromPoint 透过被拖元素看到下方的目标，避免虚线不出现
    dragEl.style.pointerEvents = 'none';
    e.preventDefault();
    // 捕获挂容器而不是把手：把手身处刚被置 pointer-events:none 的拖行里，引擎会对
    // 「不再能命中事件的捕获目标」悄悄解除捕获——手指一滑出把手区域，move/up 全丢，
    // 表现为拖拽卡住、松手后虚线框残留
    capId = e.pointerId;
    try { container.setPointerCapture(capId); } catch (_) { capId = -1; }
    pendX = e.clientX; pendY = e.clientY;   // 播种真实指针位：否则边缘翻滚拿上一次拖拽（或 0）的陈旧 Y 立即开滚——「点一下把手页面就滚」
    dragMoved = false;
    scroller = container._dragSortScroller || findScroller(container);   // 就近找真在滚的容器
    if (scroller && !scrollRaf) scrollRaf = requestAnimationFrame(scrollTick);
  });
  const step = () => {                       // 命中检测 + 换行 + FLIP：每帧至多一次（合帧口径见 onMove）
    if (!dragEl) return;
    { // eslint-disable-line padded-blocks  —— 与文末 } 成对：rAF 回调体整体搬进 step 时的作用域块
      const sel = container._dragSortSel;
      const t = document.elementFromPoint(pendX, pendY);
      let over = t ? t.closest(sel) : null;
      if (over && !container.contains(over)) over = null;
      if (over === dragEl) return;
      if (!over) {
        // 留白投影命中：手指横向漂出行身（卡片内边距、页面左右留白、甚至屏幕边缘）时，
        // elementFromPoint 摸不到行 ≠ 用户不想换行——拇指拖拽天然偏左，必须按「手指 Y 与
        // 哪一行对齐」继续判定。行序垂直单调，只比对拖行当前位 ±2 行即可，不整表测 rect。
        const near = Array.from(container.querySelectorAll(sel));
        const cur = near.indexOf(dragEl);
        if (cur === -1) return;
        let best = null, bestD = Infinity;
        for (let i = Math.max(0, cur - 2); i <= Math.min(near.length - 1, cur + 2); i++) {
          if (near[i] === dragEl) continue;
          const nr = near[i].getBoundingClientRect();
          const d = Math.abs(pendY - (nr.top + nr.height / 2));
          if (d < bestD) { bestD = d; best = near[i]; }
        }
        if (!best) return;
        over = best;
      }
      const r = over.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      // FLIP 换行动画：只给「本轮真的会挪位置」的受影响行补一段缓动滑移——
      // 触摸手感保持原样（仍是列表内实时换位），变的只是换位不再瞬移
      const flipOn = !prefersReducedMotion();
      let first = null;
      if (flipOn) {
        const items = Array.from(container.querySelectorAll(sel));
        const at = items.indexOf(dragEl);
        const to = Math.min(items.length, Math.max(0, items.indexOf(over) + (pendY < mid ? 0 : 1)));
        if (at !== -1) {
          first = new Map();
          for (let i = Math.max(0, Math.min(at, to) - 1); i <= Math.min(items.length - 1, Math.max(at, to)); i++) {
            if (items[i] === dragEl) continue;   // 被拖行必须「即换即到位」：给它补滑移动画 = 不跟手
            first.set(items[i], items[i].getBoundingClientRect());
          }
        }
      }
      if (pendY < mid) container.insertBefore(dragEl, over);
      else container.insertBefore(dragEl, over.nextSibling);
      if (first) {
        for (const [el, r0] of first) {
          const r1 = el.getBoundingClientRect();
          const dx = (r0.left || 0) - (r1.left || 0), dy = (r0.top || 0) - (r1.top || 0);
          if (!dx && !dy) continue;
          el.style.transition = 'none';
          el.style.transform = `translate(${dx}px,${dy}px)`;
          void el.offsetWidth;                                  // 强制回流：把倒置位落进本帧
          el.style.transition = 'transform .26s cubic-bezier(.2, .8, .25, 1)';
          el.style.transform = '';
          // 令牌守卫：连续快速换位时，上一段动画的清理不能抹掉后一段的 transition
          const tok = (el._flipTok = (el._flipTok | 0) + 1);
          setTimeout(() => { if (el._flipTok === tok) { try { el.style.transition = ''; } catch (e) {} } }, 300);
        }
      }
    }
  };
  const onMove = (e) => {
    if (!dragEl) return;
    // 多指守卫：捕获在场时只认本指针的移动——第二根手指在列表里乱滑，
    // 不能把 pendX/Y 偷走、让被拖行跟着别的手势跑
    if (capId >= 0 && e.pointerId != null && e.pointerId !== capId) return;
    e.preventDefault();
    noteInteraction();                       // 拖动期间冻结一切周期任务
    pendX = e.clientX; pendY = e.clientY;    // 高刷触摸设备 pointermove 可达 120~240Hz：
    dragMoved = true;                          // 真拖起来了，才允许边缘自动翻滚
    if (moveRaf) return;                     // elementFromPoint+insertBefore 合帧到每帧一次，
    moveRaf = requestAnimationFrame(() => {  // 否则命中检测与重排直接吃掉全部帧预算（卡顿主因）
      moveRaf = 0; step();
    });
  };
  // move 双挂 container+window：就算捕获再被系统打断，手指滑到保存条/标签栏/列表外
  // 也照样收得到事件（同一事件冒泡两次无妨：move 已合帧，end 有 !dragEl 守卫）
  container.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointermove', onMove, { passive: false });
  const end = (e) => {
    if (!dragEl) return;
    if (capId >= 0 && e && e.pointerId != null && e.pointerId !== capId) return;   // 别的手指先抬不收尾
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    noteInteraction(700);                     // 松手后宽限片刻再放开轮询（惯性/回弹帧期间也别插队）
    clearOver();
    dragEl.classList.remove('dragging');
    dragEl.style.pointerEvents = '';
    dropCap();
    const sel = container._dragSortSel;
    const items = Array.from(container.querySelectorAll(sel));
    const newIdx = items.indexOf(dragEl);
    const from = dragIdx;
    const cb = container._dragSortCb;
    dragEl = null; dragIdx = -1; dragMoved = false;
    if (newIdx !== -1 && newIdx !== from && typeof cb === 'function') cb(from, newIdx);
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  // 兜底：任何原因导致的捕获提前释放（滚动手势劫持、WebView 怪癖）就地收尾——
  // 顺序早已在 DOM 里实时换好，end 照常提交一次，绝不让虚线框留场
  container.addEventListener('lostpointercapture', (e9) => {
    if (e9 && e9.pointerId != null && e9.pointerId !== capId) return;   // 别的手指的捕获释放不算数
    capId = -1;
    if (dragEl) end({});
  });
}

// ---------------- 自动换行芯片拖动排序 ----------------
// 与上面的单排 enableDragSort 分开实现：芯片在 flex-wrap 网格中若边拖边 insertBefore，
// 目标会立刻换位到手指下面，下一帧 elementFromPoint 又命中另一个芯片，造成连续误触和跳动。
// 这里让原网格在整次手势中保持静止，只移动一个浮层副本、标记稳定落点，松手时才换位一次。
export function enableWrapDragSort(container, selector, onReorder) {
  if (!container || typeof onReorder !== 'function') return;
  container._wrapDragCb = onReorder;
  container._wrapDragSel = selector;
  if (container._wrapDragBound) return;
  container._wrapDragBound = true;

  let dragEl = null, dragIdx = -1, pointerId = -1;
  let startX = 0, startY = 0, pendX = 0, pendY = 0, moved = false, rtl = false;
  let ghost = null, dropEl = null, dropAfter = false, raf = 0, scroller = null, ending = false;
  const docScroller = () => document.scrollingElement || document.documentElement || document.body;

  const itemList = () => Array.from(container.querySelectorAll(container._wrapDragSel));
  const clearDrop = () => {
    if (dropEl) dropEl.classList.remove('drag-over', 'drag-before', 'drag-after');
    dropEl = null; dropAfter = false;
  };
  const dropCapture = () => {
    if (pointerId < 0) return;
    try { container.releasePointerCapture(pointerId); } catch (_) {}
    pointerId = -1;
  };
  const removeGhost = () => {
    if (ghost) { try { ghost.remove(); } catch (_) {} }
    ghost = null;
  };
  const scrollable = (el) => {
    if (!el || el.scrollHeight == null || el.clientHeight == null || el.scrollHeight <= el.clientHeight + 1) return false;
    if (el === docScroller() || el === document.documentElement || el === document.body) return true;
    try { return /auto|scroll/.test((window.getComputedStyle(el).overflowY || '')); } catch (_) { return true; }
  };
  const findScroller = () => {
    for (let el = container.parentElement; el && el !== docScroller(); el = el.parentElement) if (scrollable(el)) return el;
    const ds = docScroller();
    return scrollable(ds) ? ds : null;
  };
  const edgeScroll = () => {
    if (!moved || !scroller) return false;
    let top = 0, bottom = window.innerHeight || 0;
    if (scroller !== docScroller()) {
      const r = scroller.getBoundingClientRect(); top = r.top; bottom = r.bottom;
    }
    const edge = Math.min(76, Math.max(44, (bottom - top) * 0.14));
    const up = top + edge - pendY, down = pendY - (bottom - edge);
    if (up <= 0 && down <= 0) return false;
    const depth = Math.min(edge, Math.max(up, down));
    const delta = (1 + 12 * depth / edge) * (up > down ? -1 : 1);
    const before = scroller.scrollTop;
    scroller.scrollTop = before + delta;
    if (scroller.scrollTop === before) return false;
    noteInteraction(140);
    return true;
  };

  const placeGhost = () => {
    if (!ghost) return;
    const dx = pendX - startX, dy = pendY - startY;
    ghost.style.transform = `translate3d(${ghost._dragLeft + dx}px,${ghost._dragTop + dy}px,0)`;
  };
  const chooseDrop = () => {
    const sel = container._wrapDragSel;
    let hit = document.elementFromPoint(pendX, pendY);
    let over = hit && hit.closest ? hit.closest(sel) : null;
    if (!over || over === dragEl || !container.contains(over)) over = null;

    // 原位置是一个明确的“取消换位”槽。拖回这里时不能因为原芯片 pointer-events:none
    // 而把旁边的芯片误判成目标。
    const home = dragEl.getBoundingClientRect();
    if (!over && pendX >= home.left && pendX <= home.right && pendY >= home.top && pendY <= home.bottom) {
      clearDrop(); return;
    }

    // gap/每排尾部留白：网格全程不换位，可安全按二维距离找一次最近项；纵向距离稍加权，
    // 避免宽度差很大的芯片把相邻行的目标抢走。
    if (!over) {
      let best = null, bestScore = Infinity;
      // 当前目标的外扩热区提供 10px 滞回；指尖在 gap 边缘轻微抖动时不来回切目标。
      if (dropEl && dropEl.isConnected) {
        const rr = dropEl.getBoundingClientRect();
        if (pendX >= rr.left - 10 && pendX <= rr.right + 10 && pendY >= rr.top - 10 && pendY <= rr.bottom + 10) best = dropEl;
      }
      if (!best) {
        for (const el of itemList()) {
          if (el === dragEl) continue;
          const r = el.getBoundingClientRect();
          const dx = pendX < r.left ? r.left - pendX : pendX > r.right ? pendX - r.right : 0;
          const dy = pendY < r.top ? r.top - pendY : pendY > r.bottom ? pendY - r.bottom : 0;
          const score = dx * dx + dy * dy * 1.6;
          if (score < bestScore) { bestScore = score; best = el; }
        }
      }
      over = best;
    }
    if (!over) { clearDrop(); return; }

    const r = over.getBoundingClientRect();
    let after;
    if (pendY < r.top) after = false;
    else if (pendY > r.bottom) after = true;
    else after = rtl ? pendX < r.left + r.width / 2 : pendX >= r.left + r.width / 2;
    if (dropEl === over && dropAfter === after) return;
    clearDrop();
    dropEl = over; dropAfter = after;
    // 只高亮当前目标；前插、后插都不再显示竖线位置标记。
    over.classList.add('drag-over');
  };

  const step = () => {
    raf = 0;
    if (!dragEl || !moved) return;
    placeGhost();
    chooseDrop();
    if (edgeScroll()) raf = requestAnimationFrame(step);
  };
  const queueStep = () => { if (!raf) raf = requestAnimationFrame(step); };

  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest && e.target.closest('.drag-handle');
    if (!handle) return;
    const item = handle.closest(container._wrapDragSel);
    if (!item || !container.contains(item)) return;
    const items = itemList();
    const idx = items.indexOf(item);
    if (idx < 0) return;
    // 异常中断残留先清掉；不让上一次的 ghost/描边污染新手势。
    if (dragEl) {
      clearDrop(); removeGhost();
      dragEl.classList.remove('dragging'); dragEl.style.pointerEvents = '';
      dropCapture();
    }
    dragEl = item; dragIdx = idx; pointerId = e.pointerId;
    startX = pendX = e.clientX; startY = pendY = e.clientY; moved = false;
    rtl = false;
    try { rtl = window.getComputedStyle(container).direction === 'rtl'; } catch (_) {}
    scroller = container._wrapDragScroller || findScroller();

    const r = item.getBoundingClientRect();
    ghost = item.cloneNode(true);
    ghost.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    ghost.removeAttribute('id');
    ghost.classList.remove('dragging', 'drag-over', 'drag-before', 'drag-after');
    ghost.classList.add('chip-drag-ghost');
    ghost.hidden = true;                    // 超过 6px 才算拖动，轻点手柄不闪双影
    ghost._dragLeft = r.left; ghost._dragTop = r.top;
    ghost.style.width = r.width + 'px'; ghost.style.height = r.height + 'px';
    ghost.style.transform = `translate3d(${r.left}px,${r.top}px,0)`;
    document.body.append(ghost);

    item.classList.add('dragging');
    item.style.pointerEvents = 'none';       // 命中穿透原芯片，且原位置始终占位不塌陷
    e.preventDefault(); noteInteraction(600);
    try { container.setPointerCapture(pointerId); } catch (_) { pointerId = -1; }
  });

  const onMove = (e) => {
    if (!dragEl) return;
    if (pointerId >= 0 && e.pointerId != null && e.pointerId !== pointerId) return;
    e.preventDefault(); noteInteraction();
    pendX = e.clientX; pendY = e.clientY;
    if (!moved) {
      const dx = pendX - startX, dy = pendY - startY;
      if (dx * dx + dy * dy < 36) return;
      moved = true;
      if (ghost) ghost.hidden = false;
    }
    queueStep();
  };
  container.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointermove', onMove, { passive: false });

  const end = (e, canceled = false) => {
    if (!dragEl || ending) return;
    if (pointerId >= 0 && e && e.pointerId != null && e.pointerId !== pointerId) return;
    ending = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (moved && !canceled) { placeGhost(); chooseDrop(); }
    const item = dragEl, from = dragIdx, target = canceled ? null : dropEl, after = dropAfter;
    const cb = container._wrapDragCb;
    clearDrop(); removeGhost(); dropCapture();
    item.classList.remove('dragging'); item.style.pointerEvents = '';
    if (moved && target && target.isConnected && target !== item) {
      if (after) container.insertBefore(item, target.nextSibling);
      else container.insertBefore(item, target);
    }
    const to = itemList().indexOf(item);
    dragEl = null; dragIdx = -1; moved = false; rtl = false; scroller = null; ending = false;
    noteInteraction(700);
    if (to >= 0 && to !== from && typeof cb === 'function') cb(from, to);
  };
  container.addEventListener('pointerup', e => end(e, false));
  container.addEventListener('pointercancel', e => end(e, true));
  window.addEventListener('pointerup', e => end(e, false));
  window.addEventListener('pointercancel', e => end(e, true));
  container.addEventListener('lostpointercapture', (e) => {
    if (ending) return;                       // 主动 releasePointerCapture 的收尾事件不递归 end
    if (e && e.pointerId != null && pointerId >= 0 && e.pointerId !== pointerId) return;
    pointerId = -1;
    if (dragEl) end({}, true);               // 系统抢走手势时宁可取消，也不提交可能错误的目标
  });
}
