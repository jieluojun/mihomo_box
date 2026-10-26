// Endpoint semantics follow zephyruso/zashboard: direct HTTP to the loopback
// controller when reachable, with the exec bridge as automatic fallback.
import { state, DEMO, REMOTE, shell, cmdline, SH, shq, parseJsonLoose, uiLog, setServiceRestartImpl, captureServiceConfigToken, applyServiceConfigSnapshot } from './core.js';
import { createControllerClient } from './controller-client.js';

function connection() {
  // Never send the saved controller's secret to an unsaved draft address.
  if (DEMO || state.dirty) return null;
  const cfg = state.cfg || {};
  let address = String(cfg['external-controller'] || '').trim();
  if (!address || address.startsWith('/')) return null;
  if (address.startsWith(':')) address = '127.0.0.1' + address;
  try {
    const url = new URL(address.includes('://') ? address : 'http://' + address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    const local = ['0.0.0.0', '127.0.0.1', 'localhost', '[::]', '[::1]'].includes(url.hostname);
    if (local) url.hostname = REMOTE ? window.location.hostname : '127.0.0.1';
    // Loopback http is exempt from mixed-content blocking (Chromium treats
    // http://127.0.0.1 as a trustworthy origin), so the built-in proxies page
    // may take the direct REST path (PUT /proxies/:group) instead of the exec
    // bridge. mihomo's default CORS (allow-origins: "*", allow-private-
    // network: true) answers the cross-origin preflight. Non-loopback http from
    // an https page stays refused: that really is blocked mixed content (panel
    // behind an https reverse proxy).
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (window.location.protocol === 'https:' && url.protocol === 'http:' && !loopback) return null;
    // `running` feeds the controller client's probe key: a capability probe that
    // failed while the core was stopped must not pin the whole (persistent) manager
    // session to the shell bridge once the core has started.
    return { url: url.origin, secret: String(cfg.secret || ''), running: !!(state.status && state.status.running) };
  } catch (_) { return null; }
}

async function bridge(method, path, body, opts) {
  // 单次 shell 调用直达执行桥：HTTP 通道天然并发，不再需要后台点火 + 轮询取回。
  // 超时守卫只决定“不等了”，绝不重发（写操作重发等于执行两次）。
  const timeout = Math.max(1, Math.min(90, Math.ceil((opts.timeout || 15000) / 1000)));
  // Reuse the existing large-response protection on the new API bridge path.
  // Provider history can be megabytes and exhaust a native callback's payload budget.
  const trim = method === 'GET' && (path === '/proxies' || path === '/providers/proxies');
  // 切模式（PATCH /configs {mode}）顺带把「这次改的是运行模式」告诉脚本：它在
  // 同一次进程里发完 PATCH 就顺手作废过期的首屏快照（run/boot_data.json 内嵌整份
  // status，含旧 mode），前端不必再为这一条 rm 多拉一次 shell —— 慢设备上多一次
  // 就是多解析一遍 9000+ 行的脚本。
  const modeEnv = (method === 'PATCH' && path === '/configs' && body && typeof body.mode === 'string')
    ? `MH_API_MODE=${shq(body.mode)} ` : '';
  const cmd = `${trim ? 'MH_API_TRIM=1 ' : ''}${modeEnv}MH_API_FAIL=1 MH_API_TIMEOUT=${timeout} ${SH} api ${method} ${shq(path)}`
    + (body !== undefined ? ' ' + shq(JSON.stringify(body)) : '');
  let timer;
  let r;
  try {
    r = await Promise.race([
      // 通道层等待上限与本函数自己的竞速超时对齐：底层 fetch 原先固定 15s，
      // 大接口（MH_API_TIMEOUT=25s+）在慢链路上会先被通道掐断、误报超时。
      Promise.resolve().then(() => shell(cmd, { timeout: timeout * 1000 + 5000 })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(method === 'GET'
          ? `读取 ${path} 超时：执行桥未回包，请检查内核或面板服务日志`
          : '执行桥等待超时，操作可能已生效，请刷新确认；不会自动重发')), timeout * 1000 + 5000);
      }),
    ]);
  } finally { clearTimeout(timer); }
  const raw = String(r && r.stdout || '').trim();
  const data = raw ? parseJsonLoose(raw) : null;
  if (!r || Number(r.errno) !== 0 || (data && (data.error || data.message)) || (raw && !data)) {
    const stderr = String(r?.stderr || '').trim();
    const status = Number(stderr.match(/(?:^|\n)MH_API_HTTP_STATUS=(\d{3})(?:\n|$)/)?.[1] || 0);
    const detail = (data && (data.message || data.error)) || (raw && !data ? raw : '')
      || stderr.replace(/(?:^|\n)MH_API_HTTP_STATUS=\d{3}(?=\n|$)/g, '').trim()
      || (status ? `控制器 HTTP ${status}` : '控制器拒绝请求');
    throw Object.assign(new Error(String(detail)), { status });
  }
  if (method === 'GET' && !data) throw new Error(String(r?.stderr || '').trim() || '控制器未返回有效数据');
  return data;
}

export const controller = createControllerClient({ connection, bridge, onEvent: (level, ...args) => uiLog(level, ...args) });
export const getConfigs = () => controller.request('GET', '/configs');
export const getConnections = () => controller.request('GET', '/connections', undefined, { timeout: 4000 });
export const patchMode = mode => controller.request('PATCH', '/configs', { mode });

// zashboard src/api/clash.ts: exact endpoint and request-body semantics.
// Serialize lifecycle writes; never stop/start the module after a lost API response.
let lifecycleBusy = false;
async function lifecycleRequest(method, path, body, timeout) {
  if (lifecycleBusy) throw new Error('已有内核操作进行中，请等待完成');
  lifecycleBusy = true;
  try { return await controller.request(method, path, body, { timeout }); }
  finally { lifecycleBusy = false; controller.reset(); }
}
export const reloadConfigs = () => lifecycleRequest('PUT', '/configs?reload=true', { path: '', payload: '' }, 75000);
// Explicit module service restart, not an API fallback. Share the lifecycle lock
// with config reloads so the two operations cannot race each other.
// restart-json：重启并把现算的状态 JSON 一并带回（action_rc / action_msg 为重启命令
// 本身的退出码与输出），调用方可直接交给 refreshStatus(prefetched) 省一次 status 往返。
// 命令本身的 errno 恒为 0（状态 JSON 总要吐出来），成败看 action_rc。
export async function restartService({ transparentMode = null } = {}) {
  if (lifecycleBusy) throw new Error('已有内核操作进行中，请等待完成');
  if (transparentMode !== null && !['tun', 'ebpf', 'tproxy'].includes(transparentMode)) throw new Error('无效透明代理模式');
  lifecycleBusy = true;
  try {
    // UI 提示钩子（app.js 注入 cueServiceRestartUI）：所有重启入口（主页按钮 /
    // 保存配置后重启 / TUN·eBPF 选择弹窗）统一在按下瞬间时长归零起表、新 pid 快照
    // 补位，杜绝「重启完成后运行时长从几秒直接跳出来」。
    try { if (typeof window !== 'undefined' && typeof window.__restartUICue === 'function') window.__restartUICue(); } catch (e) { /* UI 提示失败不阻断重启 */ }
    const configToken = captureServiceConfigToken();
    const actionStarted = performance.now();
    // 75s 上限：慢设备上 restart-json 内含配置校验（mihomo -t，大 geodata +
    // memconservative 模式在路由器上可达数十秒），通道层默认 15s 会在校验
    // 还没跑完时就误报「重启未确认」。
    const result = await cmdline(transparentMode ? `restart-json ${transparentMode}` : 'restart-json', { timeout: 75000 });
    const j = parseJsonLoose(result && result.stdout);
    uiLog('debug', '服务重启耗时', { roundtrip_ms: Math.round(performance.now() - actionStarted), backend_ms: j?.action_elapsed_ms });
    const rc = j && j.action_rc != null ? Number(j.action_rc) : -1;
    if (!result || Number(result.errno) !== 0 || rc !== 0) {
      const detail = (j && String(j.action_msg || '').trim())
        || [result?.stdout, result?.stderr].filter(Boolean).join('\n').trim();
      const error = new Error(detail || '模块服务重启未成功返回');
      if (j && j.action_rc != null) error.actionResult = result;
      throw error;
    }
    applyServiceConfigSnapshot(j, configToken);
    return result;
  } finally { lifecycleBusy = false; controller.reset(); }
}
// TUN/eBPF 等接管方式改动保存后的重启走这里：与主页「重启服务」按钮同一入口。
setServiceRestartImpl(restartService);


export const putProxy = (group, name) => controller.request('PUT', '/proxies/' + encodeURIComponent(group), { name });

// 「切换节点断开连接」：只断开经该组建立的连接——/connections 里 chains 含组名的那些，
// 让它们立刻经新节点重建；直连/其他组的连接一概不动（全量 DELETE /connections 会把
// 直播等长连接一起杀掉，同类做法在 clash-party 侧引发过一批 bug 报告）。
export async function closeGroupConnections(group) {
  const data = await controller.request('GET', '/connections', undefined, { timeout: 25000 });
  const conns = (data && Array.isArray(data.connections)) ? data.connections : [];
  const hit = conns.filter(c => c && c.id && Array.isArray(c.chains) && c.chains.includes(group));
  let closed = 0;
  // 与批量测速同档并发：走执行桥时逐条 DELETE 不能串成一条长队。
  for (let i = 0; i < hit.length; i += 8) {
    const rs = await Promise.allSettled(hit.slice(i, i + 8).map(c =>
      controller.request('DELETE', '/connections/' + encodeURIComponent(String(c.id)))));
    closed += rs.filter(r => r.status === 'fulfilled').length;
  }
  return closed;
}

export const fetchProxySnapshot = async () => {
  const [p, providers] = await Promise.allSettled([
    controller.request('GET', '/proxies', undefined, { timeout: 25000 }),
    controller.request('GET', '/providers/proxies', undefined, { timeout: 25000 }),
  ]);
  if (p.status === 'rejected') throw p.reason;
  if (!p.value || !p.value.proxies) throw new Error('缺少代理快照');
  return { proxies: p.value, providers: providers.status === 'fulfilled' ? providers.value : null };
};

// This module's “all subscriptions” combines zashboard's proxy + rule update actions.
// Runtime provider lists are authoritative; one failed update must not hide other results.
export async function updateAllProviders(onProgress = () => {}) {
  const progress = { stage: 'listing', done: 0, total: 0, ok: 0, fail: 0, detail: [], listingDone: 0, listingTotal: 2, pendingKinds: ['代理订阅', '规则订阅'] };
  const emit = () => onProgress({ ...progress, detail: [...progress.detail], pendingKinds: [...progress.pendingKinds] });
  emit();
  const kinds = ['proxies', 'rules'];
  const labels = ['代理订阅', '规则订阅'];
  const jobs = [];
  // Publish each list independently. A slow rule list must not hide a completed proxy list.
  await Promise.allSettled(kinds.map(async (kind, i) => {
    try {
      const result = await controller.request('GET', '/providers/' + kind, undefined, { timeout: 25000 });
      if (!result?.providers || typeof result.providers !== 'object') throw new Error('响应格式错误');
      let count = 0;
      Object.entries(result.providers).forEach(([key, provider]) => {
        const name = String(provider?.name || key);
        if (kind === 'proxies' && (name === 'default' || provider?.vehicleType === 'Compatible')) return;
        jobs.push({ kind, name });
        count++;
      });
      progress.total = jobs.length;
      progress.detail.push(`✓ ${labels[i]}列表已读取：${count} 项`);
    } catch (e) {
      progress.fail++;
      progress.detail.push(`✗ ${labels[i]}列表读取失败：${e.message}`);
    } finally {
      progress.listingDone++;
      progress.pendingKinds = progress.pendingKinds.filter(label => label !== labels[i]);
      emit();
    }
  }));
  if (!jobs.length) {
    progress.stage = 'done';
    progress.detail.push(progress.fail ? '未取得可更新的订阅，请检查上方错误；本次未发起更新。' : '运行时列表中没有可更新的订阅。');
    emit();
    return progress;
  }
  progress.stage = 'updating';
  emit();
  await Promise.allSettled(jobs.map(async job => {
    try {
      await controller.request('PUT', `/providers/${job.kind}/${encodeURIComponent(job.name)}`, undefined, { timeout: 75000 });
      progress.ok++;
      progress.detail.push(`✓ ${job.kind}/${job.name}`);
    } catch (e) {
      progress.fail++;
      progress.detail.push(`✗ ${job.kind}/${job.name}：${e.message}`);
    } finally { progress.done++; emit(); }
  }));
  progress.stage = 'refreshing';
  emit();
  // Refresh once after the whole batch, including partial failures.
  const refreshed = await Promise.allSettled([
    fetchProxySnapshot(), controller.request('GET', '/rules', undefined, { timeout: 25000 }),
    controller.request('GET', '/providers/rules', undefined, { timeout: 25000 }),
  ]);
  if (refreshed[0].status === 'fulfilled') {
    window.dispatchEvent(new CustomEvent('mihomo-providers-updated', { detail: refreshed[0].value }));
  }
  refreshed.forEach((r, i) => { if (r.status === 'rejected') progress.detail.push(`⚠ ${['代理', '规则', '规则订阅'][i]}回读失败：${r.reason.message}`); });
  progress.stage = 'done';
  emit();
  return progress;
}
