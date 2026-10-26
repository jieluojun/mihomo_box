// Zashboard clash driver networkType = `${metadata.type} | ${getNetwork(c)}`.
// The dashboard 「代理模式」 statistic shows the effective takeover mode from status
// (the same source the mode buttons and the switch toast use). What this module
// observes — the inbound types actually carrying traffic in the current /connections
// snapshot — is only a note attached to that value (tooltip), never the mode itself:
// a freshly switched kernel has no connections yet, so a connection-derived value
// would read 「暂无连接」 right when the toast says the mode has changed.
export function summarizeConnectionTypes(data) {
  if (!data || !Array.isArray(data.connections)) throw new Error('连接列表无效');
  if (!data.connections.length) return { label: '暂无连接', types: [], count: 0 };
  const visible = data.connections.filter(c => String(c?.metadata?.type || '').trim().toLowerCase() !== 'inner');
  if (!visible.length) return { label: '暂无连接', types: [], count: 0 };
  const types = [...new Set(visible.map(c => c?.metadata?.type)
    .filter(type => typeof type === 'string' && type.trim()).map(type => type.trim()))]
    .sort((a, b) => a.localeCompare(b));
  return { label: types.length ? types.join(' / ') : '待识别', types, count: visible.length };
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
