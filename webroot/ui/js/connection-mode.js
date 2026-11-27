// Zashboard clash driver networkType = `${metadata.type} | ${getNetwork(c)}`.
// The dashboard mode statistic uses ONLY the first field, aggregated across the
// current /connections snapshot. Never infer a type from switches or config.
//
// 主页「代理模式」统计只回答一件事：**现在流量是从哪条透明接管通道进内核的**。
// 所以只认下面这几种入站类型（mihomo 内核 constant.Type 的字符串值，大小写不敏感）：
//   Tun    ← TUN 网卡（type: tun）
//   Redir  ← iptables REDIRECT（redir-port / tun.auto-redirect）—— 归到 TUN 一类：
//            它和 TUN 是同一套接管栈的两种入口（auto-redirect 就是给 TUN 装
//            REDIRECT 规则），界面上分开列只会让人以为多了个模式。
//   TProxy ← TPROXY 重定向（tproxy-port / type: tproxy）
//   EBPF   ← eBPF 入站（type: ebpf，jieluojun/liuran001 分支内核扩展的 EBPF 类型）
// lo/局域网回注进来的 Mixed / Socks / HTTP 连接、内核自己的 Inner 连接、DNS 内部
// 请求都不是「接管方式」，混进来只会让这一格读不出结论（出现过 Inner / Socks5
// 之类的噪音），因此一律不计。
//
// label 相同的多条（Tun 与 Redir → 都是 TUN）在输出时合并，只显示一次；
// types 仍保留命中的原始类型名，诊断/回归用。
export const TAKEOVER_TYPES = [
  { type: 'Tun', label: 'TUN' },
  { type: 'Redir', label: 'TUN' },
  { type: 'TPROXY', label: 'Tproxy' },
  { type: 'EBPF', label: 'eBPF' },
];

// 有连接、但没有任何一条走透明接管时的文案：把原因说清楚，别让人以为开关没生效。
const NO_TAKEOVER = '无接管';

function typeKeyOf(connection) {
  const raw = connection?.metadata?.type;
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export function summarizeConnectionTypes(data) {
  if (!data || !Array.isArray(data.connections)) throw new Error('连接列表无效');
  if (!data.connections.length) return { label: '暂无连接', types: [], count: 0 };
  // 按接管类型归组：先归成命中集合，再按 TAKEOVER_TYPES 的固定顺序输出，
  // 避免依赖 localeCompare（不同 ROM 的 JS 引擎对大小写/标点的排序不一致）。
  const seen = new Set();
  let takeover = 0;
  for (const c of data.connections) {
    const key = typeKeyOf(c);
    const hit = TAKEOVER_TYPES.find(t => t.type.toLowerCase() === key);
    if (!hit) continue;
    takeover += 1;
    seen.add(hit.type);
  }
  const matched = TAKEOVER_TYPES.filter(t => seen.has(t.type));
  if (!matched.length) return { label: NO_TAKEOVER, types: [], count: 0 };
  // Tun + Redir 都命中时合并成一个 "TUN"，而不是 "TUN / TUN"。
  const labels = [...new Set(matched.map(t => t.label))];
  return { label: labels.join(' / '), types: matched.map(t => t.type), count: takeover };
}

// Independent, bounded background sampler. Never await it in a lifecycle ACK
// chain. Bind samples to PID + lifecycle epoch + config generation; reject old
// replies, deduplicate each identity, bound obsolete/current reads to two slots, and update
// the statistic without rerender.
export function createConnectionModeTracker({ read, getContext, onChange = () => {}, now = Date.now, interval = 1000 }) {
  let generation = 0, snapshot = null;
  const pending = new Map();
  let lastKey = '', lastAt = -Infinity;
  const key = c => JSON.stringify([String(c.pid || ''), c.epoch || 0, generation]);
  const eligible = c => !!c.running && !c.paused && !c.busy;
  const getLabel = () => {
    const c = getContext();
    if (!c.running) return '暂无连接';
    return snapshot?.key === key(c) ? snapshot.label : '待识别';
  };
  const invalidate = () => { ++generation; snapshot = null; lastKey = ''; lastAt = -Infinity; };
  const refresh = ({ force = false } = {}) => {
    const c = getContext();
    if (!eligible(c)) return Promise.resolve();
    const requestedKey = key(c);
    if (pending.has(requestedKey)) return pending.get(requestedKey);
    // A slow pre-restart read must not hold the new kernel's first sample hostage.
    // At most one current + one obsolete request; further replacements wait for a slot.
    if (pending.size >= 2) return Promise.resolve();
    if (!force && lastKey === requestedKey && now() - lastAt < interval) return Promise.resolve();
    lastKey = requestedKey; lastAt = now();
    const stillCurrent = () => {
      const current = getContext();
      return eligible(current) && key(current) === requestedKey;
    };
    const publish = result => {
      if (!stillCurrent()) return;
      const changed = snapshot?.key !== requestedKey || snapshot?.label !== result.label;
      // Store only type strings and count: never retain hosts, IDs, IPs or process metadata.
      snapshot = { key: requestedKey, ...result };
      if (changed) onChange();
    };
    const task = Promise.resolve().then(read).then(data => {
      if (stillCurrent()) publish(summarizeConnectionTypes(data));
    }).catch(() => {
      publish({ label: '读取失败', types: [], count: 0 });
    }).finally(() => {
      pending.delete(requestedKey);
      // If a new kernel/config was acknowledged during the old read, sample its
      // connections as soon as a slot is available, never publishing the stale reply.
      const current = getContext();
      if (eligible(current) && key(current) !== requestedKey) void refresh();
    });
    pending.set(requestedKey, task);
    return task;
  };
  return { getLabel, refresh, invalidate };
}
