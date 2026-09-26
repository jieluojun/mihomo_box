// Endpoint semantics follow zephyruso/zashboard: direct HTTP to the loopback
// controller when reachable, with the exec bridge as automatic fallback.
import { state, DEMO, REMOTE, shell, cmdline, SH, shq, parseJsonLoose, uiLog, setServiceRestartImpl } from './core.js';
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
  const cmd = `${trim ? 'MH_API_TRIM=1 ' : ''}MH_API_FAIL=1 MH_API_TIMEOUT=${timeout} ${SH} api ${method} ${shq(path)}`
    + (body !== undefined ? ' ' + shq(JSON.stringify(body)) : '');
  let timer;
  let r;
  try {
    r = await Promise.race([
      Promise.resolve().then(() => shell(cmd)),
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
export async function restartService() {
  if (lifecycleBusy) throw new Error('已有内核操作进行中，请等待完成');
  lifecycleBusy = true;
  try {
    const result = await cmdline('restart-json');
    const j = parseJsonLoose(result && result.stdout);
    const rc = j && j.action_rc != null ? Number(j.action_rc) : Number(result?.errno);
    if (!result || Number(result.errno) !== 0 || rc !== 0) {
      const detail = (j && String(j.action_msg || '').trim())
        || [result?.stdout, result?.stderr].filter(Boolean).join('\n').trim();
      throw new Error(detail || '模块服务重启未成功返回');
    }
    return result;
  } finally { lifecycleBusy = false; controller.reset(); }
}
// TUN/eBPF 等接管方式改动保存后的重启走这里：与主页「重启服务」按钮同一入口。
setServiceRestartImpl(restartService);


export const putProxy = (group, name) => controller.request('PUT', '/proxies/' + encodeURIComponent(group), { name });
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
