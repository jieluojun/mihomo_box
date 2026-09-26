// Minimal mihomo REST transport. No UI, shell parsing, or implicit write retries.
export function createControllerClient({ connection, bridge, fetcher = (...args) => fetch(...args), onEvent = () => {} }) {
  let probeKey = '', probePromise = null;
  let selected = 'bridge';
  const report = (level, ...args) => { try { onEvent(level, ...args); } catch (_) { /* diagnostics never fail requests */ } };
  const error = (message, status = 0) => Object.assign(new Error(message), { status });
  async function http(c, method, path, body, timeout) {
    const abort = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(Object.assign(new Error('request deadline'), { name: 'AbortError' }));
      }, timeout);
    });
    try {
      return await Promise.race([(async () => {
      const headers = { Authorization: `Bearer ${c.secret || ''}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetcher(c.url + path, {
        method, headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: abort.signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
      if (!response.ok) throw error((data && (data.message || data.error)) || `控制器 HTTP ${response.status}`, response.status);
      if (text && data === null) throw error('控制器返回的不是有效 JSON', response.status);
      return data;
      })(), deadline]);
    } catch (e) {
      if (e.name === 'AbortError') throw error(method === 'GET' ? '控制器请求超时' : '请求超时，操作可能已生效，请刷新确认');
      if (method !== 'GET' && !e.status) throw error('请求结果未知，操作可能已生效，请刷新确认：' + e.message);
      throw e;
    } finally { clearTimeout(timer); }
  }
  async function transport() {
    const c = connection();
    if (!c || typeof AbortController === 'undefined') { selected = 'bridge'; return null; }
    // The core-running flag (when the connection resolver provides it) is part of the
    // probe key. Manager WebViews never reload, so a probe that failed while the core
    // was stopped would otherwise pin node switching to the exec bridge for the whole
    // session; once the status poll reports the core running, the next request
    // re-probes the direct HTTP path exactly once. Where fetch is genuinely
    // unavailable the extra probe also runs at most once per core start.
    const key = JSON.stringify([c.url, c.secret, !!c.running]);
    if (key !== probeKey || !probePromise) {
      probeKey = key;
      // Only a read-only capability probe may trigger bridge fallback.
      probePromise = http(c, 'GET', '/version', undefined, 1500).then(data => {
        if (!data || typeof data.version !== 'string') return null;
        return c;
      }).catch(e => {
        if (e.status === 401 || e.status === 403) throw e;
        return null;
      });
    }
    const ready = await probePromise;
    selected = ready ? 'direct' : 'bridge';
    return ready;
  }
  return {
    async request(method, path, body, opts = {}) {
      const lifecycle = (method === 'POST' && path === '/restart')
        || (method === 'PUT' && path === '/configs?reload=true');
      const latency = method === 'GET' && /^\/(?:proxies\/[^/?#]+\/delay|group\/[^/?#]+\/delay|providers\/proxies\/[^/?#]+(?:\/[^/?#]+)?\/healthcheck)\?(?:[^#]*)$/.test(path);
      if (!lifecycle && !latency && (!['GET', 'PUT', 'PATCH'].includes(method) || !/^\/(configs|version|proxies(?:\/[^?#]*)?|providers\/(proxies|rules)(?:\/[^?#]*)?|rules)$/.test(path))) {
        throw error('不支持的控制器操作');
      }
      if (method !== 'GET') report('info', '控制器请求开始', method, path);
      try {
        const c = await transport();
        // No catch-and-retry: losing a write response does NOT mean it was not applied.
        const result = await (c ? http(c, method, path, body, opts.timeout || 15000)
          : bridge(method, path, body, opts));
        if (method !== 'GET') report('info', '控制器请求完成', method, path);
        return result;
      } catch (e) {
        report('error', '控制器请求失败', method, path, e.status ? `HTTP ${e.status}` : '状态未知', e.message);
        throw e;
      }
    },
    prepare: transport,
    reset() { probeKey = ''; probePromise = null; },
    get transport() { return selected; },
  };
}
