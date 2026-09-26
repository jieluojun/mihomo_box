// ============================================================
// Mihomo Box WebUI — HTTP 传输层（管理器 / 浏览器统一）
//
// 面板本身就是一套 HTTP 服务（见 scripts/mihomo.sh 的面板服务节）：
// 管理器 WebUI 只是一个跳转页，点开即跳到本机 http://127.0.0.1:<port>，
// 与浏览器远程访问的是同一份页面、同一个执行桥。
// 因此这里只有一条 I/O 路径 —— POST base64(命令) → cgi-bin/exec.sh，
// 不再有原生桥 / CGI 双通道，也不再有串行队列、后台点火与轮询取回：
// 每次 exec 都是一次独立的 HTTP 请求，发完即等回包，天然并发。
// ============================================================

// 兼容标记：原生 ksu 桥已彻底移除，恒为 false。
// 保留导出只是为了不炸掉历史引用，业务代码一律按 HTTP 路径走。
export const HAS_KSU = false;

const TOKEN_KEY = "mihomo-webui-token";
const MODDIR = "/data/adb/modules/mihomo_box";

function initToken() {
  try {
    const u = new URLSearchParams(window.location.search);
    const t = u.get("t");
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
      // 令牌从地址栏抹掉，避免被截图 / 浏览历史泄露
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      return t;
    }
  } catch (e) { /* ignore */ }
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
}

let token = (typeof window !== "undefined") ? initToken() : "";

export function getToken() { return token; }
export function setToken(t) {
  token = String(t || "").trim();
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* ignore */ }
}

// 面板模式 = 页面由 http(s) 提供（管理器跳转进来也是 http://127.0.0.1）。
// 本地文件预览（file://）时为 false，调用方据此进入只读演示模式。
export const REMOTE = (typeof window !== "undefined")
  && /^https?:$/.test(window.location.protocol);

// 令牌被拒时的回调，由 app.js 注册（弹出令牌输入页）
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

function b64decodeUtf8(b64) {
  if (!b64) return "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function remoteExec(command) {
  const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
  try {
    const res = await fetch("cgi-bin/exec.sh", {
      method: "POST",
      headers: { "X-Mihomo-Token": token, "Content-Type": "text/plain" },
      body: b64encodeUtf8(command),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (res.status === 401 || res.status === 403) {
      if (onUnauthorized) onUnauthorized();
      return { errno: -1, stdout: "", stderr: "NEED_TOKEN" };
    }
    if (!res.ok) return { errno: -1, stdout: "", stderr: "HTTP " + res.status };
    const j = await res.json();
    if (j.error) return { errno: -1, stdout: "", stderr: j.error };
    return { errno: j.errno, stdout: b64decodeUtf8(j.stdout_b64), stderr: b64decodeUtf8(j.stderr_b64) };
  } catch (e) {
    const msg = (e && e.name === "AbortError") ? "请求超时（15s），请重试" : String(e);
    return { errno: -1, stdout: "", stderr: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 面板自举：问出后端的安装目录与平台。
// Android 上面板 URL 自带模块路径，前端不需要问；路由器（busybox httpd）的
// 文档根就是 ui/，URL 里只有 /js/…，只能问这一条保留命令。
export async function panelInfo() {
  if (!REMOTE) return null;
  try {
    const res = await fetch("cgi-bin/exec.sh", {
      method: "POST",
      headers: { "X-Mihomo-Token": token, "Content-Type": "text/plain" },
      body: b64encodeUtf8("__panel_info__"),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || j.errno !== 0) return null;
    const txt = b64decodeUtf8(j.stdout_b64);
    const info = JSON.parse(txt);
    return (info && typeof info === "object") ? info : null;
  } catch (e) { return null; }
}

// 探测桥是否需要令牌（用于首屏决定是否弹输入页）
export async function probeAuth() {
  try {
    const res = await fetch("cgi-bin/exec.sh", {
      method: "POST",
      headers: { "X-Mihomo-Token": token, "Content-Type": "text/plain" },
      body: b64encodeUtf8("echo ok"),
    });
    if (res.status === 401 || res.status === 403) return "need-token";
    return res.ok ? "ok" : "error";
  } catch (e) { return "error"; }
}

// 统一执行入口：单次 HTTP 请求，无队列、无轮询。
// options 参数仅为兼容旧调用签名而保留（原生桥时代的 cwd 等已无意义）。
export function exec(command, options) {
  if (!REMOTE) return Promise.resolve({ errno: -1, stdout: "", stderr: "no bridge" });
  return remoteExec(command).catch(e => ({ errno: -1, stdout: "", stderr: String(e) }));
}

// 兼容桩：原生桥已移除，管理器相关的 UI 能力调用静默无操作。
// （界面 toast 一律走 core.js 的 uiToast，不依赖任何原生接口。）
export function fullScreen() {}
export function enableEdgeToEdge() {}
export function toast() {}
export function moduleInfo() { return {}; }

// ------------------------------------------------------------
// 应用列表：两种访问方式（管理器 / 浏览器）同一数据源 —— pkg-list 走 root
// 读主用户的真实 PackageManager 分类。不使用 packages.list / UID 范围推断，
// 也不使用管理器自带的 ksu.listPackages（那份清单受包可见性与自身过滤影响）。
// ------------------------------------------------------------

let _pkgCache = null;     // { list, ts }
let _pkgError = '';       // 最近一次失败原因，用于界面上如实呈现

export function lastPackageError() { return _pkgError; }

async function loadPackagesViaShell() {
  if (_pkgCache && Date.now() - _pkgCache.ts < 60000) return _pkgCache.list;
  _pkgError = '';

  const r = await exec(`sh ${MODDIR}/scripts/mihomo.sh pkg-list`);
  const txt = String((r && r.stdout) || '').trim();

  if (!r || r.errno !== 0 || !txt) {
    _pkgError = String((r && r.stderr) || '').trim() || '无法读取应用列表';
    return [];
  }

  const out = [];
  txt.split('\n').forEach(line => {
    const t = line.split('\t');
    if (t.length === 3 && /^\d+$/.test(t[1]) && /^[01]$/.test(t[2].trim())) {
      out.push({
        packageName: t[0].trim(),
        uid: Number(t[1]),
        system: t[2].trim() === '1',
      });
    }
  });
  if (!out.length) { _pkgError = '输出格式无法解析'; return []; }

  out.sort((a, b) => a.packageName.localeCompare(b.packageName));
  _pkgCache = { list: out, ts: Date.now() };
  return out;
}

export async function listPackagesAsync(type) {
  // 两种访问方式使用同一 root PackageManager 数据源及 user 0 范围。
  // 原生应用枚举可能有可见性/过滤差异，只用原生接口补充名称和图标。
  if (!HAS_KSU && !REMOTE) return [];
  const all = await loadPackagesViaShell();
  if (type === 'all') return all.map(p => p.packageName);
  if (type === 'system') return all.filter(p => p.system).map(p => p.packageName);
  return all.filter(p => !p.system).map(p => p.packageName);
}

let _appInfoError = '';
const _appInfoCache = new Map();
const APP_INFO_TTL = 10 * 60 * 1000;
const PKG_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
// 只接受组件产出的 PNG data URI：图标要当 <img src> 用，绝不允许外部 URL
const ICON_DATA_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
export function getCachedPackagesInfo(packages) {
  return packages.map(p => _appInfoCache.get(p)).filter(e => e && Date.now() - e.ts < APP_INFO_TTL).map(e => e.info);
}
let _appInfoPending = Promise.resolve();
export function lastPackageInfoError() { return _appInfoError; }

export async function getPackagesInfoAsync(packages, onBatch = () => {}, shouldContinue = () => true, mode = 'all') {
  // 两种访问方式同一数据源：一律用模块自带组件（root + 系统 PackageManager）
  // 读名称与图标。管理器自带的 ksu.getPackagesInfo 只覆盖它自己那份应用清单，
  // 清单外的系统应用连名字都拿不到（图标更是直接 404），故不再使用。
  if (!HAS_KSU && !REMOTE) return [];
  const names = [...new Set((Array.isArray(packages) ? packages : []).filter(p =>
    typeof p === 'string' && PKG_NAME_RE.test(p)))];
  // Serialize overlapping picker loads; share a short-lived, browser-memory cache.
  const job = _appInfoPending.then(async () => {
    _appInfoError = '';
    const now = Date.now();
    const missing = names.filter(p => {
      const entry = _appInfoCache.get(p);
      return !entry || now - entry.ts >= APP_INFO_TTL
        || (mode !== 'icons' && !entry.labelsLoaded) || (mode !== 'labels' && !entry.iconsLoaded);
    });
    // 名称一批读完（1024），图标 200 个一批、两路并发：批次越大往返越少，
    // 但单次响应是 base64 PNG，太大反而会拖住首屏，200 是折中值。
    const batchSize = mode === 'labels' ? 1024 : 200;
    const operation = mode === 'labels' ? 'app-info-labels' : mode === 'icons' ? 'app-info-icons' : 'app-info';
    try { onBatch(getCachedPackagesInfo(names)); } catch (_) {}
    let cursor = 0, failed = false;
    const worker = async () => {
    while (cursor < missing.length && !failed && shouldContinue()) {
      const batch = missing.slice(cursor, cursor + batchSize);
      cursor += batchSize;
      try {
        const result = await exec(`sh ${MODDIR}/scripts/mihomo.sh ${operation} ` + batch.map(p => "'" + p + "'").join(' '));
        if (!result || result.errno !== 0) throw new Error(result?.stderr || '应用名称与图标读取失败');
        const rows = JSON.parse(result.stdout);
        if (!Array.isArray(rows)) throw new Error('应用信息格式异常');
        const wanted = new Set(batch);
        for (const row of rows) {
          if (!row || !wanted.has(row.packageName)) continue;
          const icon = typeof row.icon === 'string' && row.icon.length <= 45000
            && ICON_DATA_RE.test(row.icon) ? row.icon : '';
          const old = _appInfoCache.get(row.packageName);
          const fresh = old && Date.now() - old.ts < APP_INFO_TTL ? old : null;
          _appInfoCache.set(row.packageName, {ts: Date.now(),
            labelsLoaded: mode !== 'icons' || !!fresh?.labelsLoaded,
            iconsLoaded: mode !== 'labels' || !!fresh?.iconsLoaded,
            info: {
              ...fresh?.info, packageName: row.packageName, uid: row.uid ?? fresh?.info.uid,
              appLabel: mode === 'icons' ? (fresh?.info.appLabel || row.packageName) : String(row.appLabel || row.packageName),
              icon: mode === 'labels' ? (fresh?.info.icon || '') : icon,
            },
          });
        }
        if (shouldContinue()) { try { onBatch(getCachedPackagesInfo(batch)); } catch (_) {} }
      } catch (e) {
        failed = true;
        _appInfoError = '部分应用名称或图标未能读取，已使用包名或占位图：' + e.message;
        break; // Do not repeatedly launch a broken helper for every remaining batch.
      }
    }
    };
    await Promise.all(Array.from({length: Math.min(2, Math.ceil(missing.length / batchSize))}, worker));
    for (const [p, entry] of _appInfoCache) if (Date.now() - entry.ts > APP_INFO_TTL) _appInfoCache.delete(p);
    return names.map(p => _appInfoCache.get(p)?.info || {packageName: p, appLabel: p});
  });
  _appInfoPending = job.catch(() => {});
  return job;
}

export function getPackageLabelsAsync(packages, shouldContinue = () => true) {
  return getPackagesInfoAsync(packages, () => {}, shouldContinue, 'labels');
}
export function getPackageIconsAsync(packages, onBatch, shouldContinue) {
  return getPackagesInfoAsync(packages, onBatch, shouldContinue, 'icons');
}

// 应用图标：两种访问方式统一使用模块组件产出的 PNG data URI。
// 不再使用管理器的 ksu://icon/<包名>——它只在管理器自己那份应用清单里查，
// 查不到直接回 404（无代码的资源包、清单外的系统应用都会中）。
export function appIconSource(packageName, info) {
  const icon = info && typeof info.icon === 'string' ? info.icon : '';
  return ICON_DATA_RE.test(icon) ? icon : '';
}

export function exit() {
  try { window.close(); } catch (e) {}
}
