// ============================================================
// 统一执行层（HTTP 单通道版）
//
// 只有一条 I/O 路径：面板 httpd 的 CGI 执行桥（管理器跳转进来
// 也是同一个 http://127.0.0.1 页面）。每次请求都是一次独立的
// HTTP 往返，天然并发 —— 没有串行队列，没有后台点火，也不再有
// 任何为“等结果”而设的轮询。业务代码只声明意图（数据量大不大），
// 怎么跑由这里统一决定。
// ============================================================
import { shell, cmdline, DEMO, SH, shq, parseJsonLoose } from './core.js';
import { REMOTE } from './kernelsu.js';
import { controller } from './mihomo-api.js';

// ---------------- 环境画像 ----------------
export const ENV = {
  // panel = 面板（http 服务提供）；demo = 本地文件预览（无后端）
  kind: REMOTE ? 'panel' : 'demo',
  // 命令通道是否串行：HTTP 天生并发，恒为 false
  serialQueue: false,
  // 页面是否常驻：凡是“刷新后该保留的”一律落盘，与环境无关
  persistent: true,
  // 渲染能力偏弱：大列表要更小批量地插入，避免一次长任务卡住交互
  lightRenderer: false,
  demo: !!DEMO,
};

// ---------------- 由画像推导的调参 ----------------
export const POLICY = {
  // 一帧最多插入多少张节点卡（剩下的交给后续帧）
  cardChunk: 32,
  // 大响应（/proxies、/providers/proxies）的超时。
  // mihomo.sh 的 api 子命令默认 8 秒，订阅节点多时响应能到几 MB，
  // 还要多一层 base64 往返，8 秒不够 → 超时即退回配置预览。
  bigApiTimeout: 25,
};

// ---------------- 基础命令 ----------------
// 统一走这里，业务代码不再直接拼 sh 命令，超时等策略也只在这里调。
export async function run(cmd) {
  return shell(cmd);
}

// mihomo REST 请求。数据量大的调用显式声明 big:true 以放宽超时。
// trim:true 让服务端只保留每个节点最近 3 条延迟 history（几 MB → 几十 KB）。
// 响应要 base64 后过一层 CGI 桥，几 MB 的往返经常把通道压垮
// （空响应体 → 前端解析失败 → 订阅节点类型全未知），因此订阅类接口默认瘦身。
export async function apiGet(path, opts = {}) {
  if (!ENV.demo && await controller.prepare()) {
    return directRead(path, opts.big ? POLICY.bigApiTimeout * 1000 : (opts.timeout || 15) * 1000);
  }
  const tmo = opts.big ? POLICY.bigApiTimeout : (opts.timeout || 0);
  const pre = (opts.trim ? 'MH_API_TRIM=1 ' : '') + (tmo ? `MH_API_TIMEOUT=${tmo} ` : '');
  if (!tmo && !opts.trim) return cmdline(`api GET ${shq(path)}`);
  return shell(`${pre}${SH} api GET ${shq(path)}`);
}

export async function apiPut(path, body) {
  if (!ENV.demo && await controller.prepare()) {
    const data = await controller.request('PUT', path, body);
    return {errno: 0, stdout: data == null ? '' : JSON.stringify(data), stderr: ''};
  }
  return cmdline(`api PUT ${shq(path)} ${shq(JSON.stringify(body))}`);
}

// Preserve legacy read-result shape, including HTTP error JSON used by latency
// endpoint fallback. Never retry a failed direct request through the shell.
//
// 失败时把 HTTP 状态码一并带回（控制器客户端把非 2xx 抛成带 status 的错误）：
// 测速接口的「测过但不通」正是靠 503 / 504 与「名字不认识」的 404 区分的，
// 只看 message 文本没法稳定判定，旧代码在这里把 status 丢了。
async function directRead(path, timeout) {
  try {
    const data = await controller.request('GET', path, undefined, {timeout});
    return {errno: 0, stdout: data == null ? '' : JSON.stringify(data), stderr: ''};
  } catch (e) {
    const status = Number(e && e.status) || 0;
    return {errno: 1, stdout: JSON.stringify({message: e.message}), stderr: e.message, status};
  }
}

export { shq, parseJsonLoose };

// ---------------- 统一的持久状态 ----------------
// 凡是「刷新后应该还在的」一律落盘 —— 代价极小，换来行为一致。
// localStorage 不可用时静默降级为内存态。
const PERSIST_PREFIX = 'mihomo-state:';
const memFallback = new Map();

export function loadState(key, fallback) {
  try {
    const raw = localStorage.getItem(PERSIST_PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return memFallback.has(key) ? memFallback.get(key) : fallback;
  }
}

export function saveState(key, value) {
  memFallback.set(key, value);
  try {
    localStorage.setItem(PERSIST_PREFIX + key, JSON.stringify(value));
  } catch (e) { /* WebView 禁用 localStorage 时退化为内存态 */ }
}

// 节流落盘：批量测速这类高频写入不必每次都碰存储
export function makeThrottledSaver(key, ms = 1500) {
  let timer = 0;
  let pending = null;
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    if (pending === null) return;
    saveState(key, pending);
    pending = null;
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);
  return (value) => {
    pending = value;
    if (timer) return;
    timer = setTimeout(flush, ms);
  };
}
