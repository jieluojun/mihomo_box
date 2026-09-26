// Offline URI → Mihomo proxy mapping. No network, shell, eval or YAML parsing.
const MAX_TEXT = 1024 * 1024, MAX_NODES = 500;
const fail = message => { throw new Error(message); };
const text = value => value == null ? '' : String(value);
function unescape(value) {
  try { return decodeURIComponent(value); } catch { fail('URI 百分号编码不正确'); }
}
function base64(value) {
  const s = unescape(value).replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 === 1) fail('Base64 编码不正确');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0))); }
  catch { fail('Base64 或 UTF-8 内容不正确'); }
}
function integer(value, min, max, label) {
  if (!/^\d+$/.test(text(value)) || Number(value) < min || Number(value) > max) fail(label + '不正确');
  return Number(value);
}
function boolean(value) {
  if (/^(1|true)$/i.test(value)) return true;
  if (/^(0|false)$/i.test(value)) return false;
  fail('布尔参数应为 true/false 或 1/0');
}
function uuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(value))) fail('UUID 格式不正确，应为 8-4-4-4-12 位十六进制');
  return value;
}
function endpoint(server, port) {
  server = text(server).replace(/^\[|\]$/g, '');
  if (!server || /[\s\x00-\x1f\x7f/@?#]/.test(server)) fail('服务器地址不正确');
  return { server, port: integer(port, 1, 65535, '端口') };
}
function url(value) {
  try { return new URL(value); } catch { fail('URI 地址或端口格式不正确'); }
}
function transport(proxy, net, host, path, service) {
  net = net || 'tcp';
  if (!['tcp', 'ws', 'http', 'h2', 'grpc'].includes(net)) fail('暂不支持此传输方式，请手动新建节点');
  proxy.network = net;
  if (net === 'ws') proxy['ws-opts'] = { path: path || '/', ...(host ? { headers: { Host: host } } : {}) };
  if (net === 'http') proxy['http-opts'] = { path: (path || '/').split(','), ...(host ? { headers: { Host: host.split(',') } } : {}) };
  if (net === 'h2') proxy['h2-opts'] = { path: path || '/', ...(host ? { host: host.split(',') } : {}) };
  if (net === 'grpc') proxy['grpc-opts'] = { 'grpc-service-name': service || path || '' };
}
function tls(proxy, { enabled, sni, alpn, fp, insecure }) {
  if (enabled !== undefined) proxy.tls = enabled;
  if (sni) proxy[['vmess', 'vless'].includes(proxy.type) ? 'servername' : 'sni'] = sni;
  if (alpn) proxy.alpn = (Array.isArray(alpn) ? alpn : text(alpn).split(',')).map(text).filter(Boolean);
  if (fp) proxy['client-fingerprint'] = fp;
  if (insecure !== undefined && insecure !== '') proxy['skip-cert-verify'] = boolean(text(insecure));
}
function parseSS(body, warnings) {
  const hash = body.indexOf('#');
  const name = hash < 0 ? '' : unescape(body.slice(hash + 1));
  body = hash < 0 ? body : body.slice(0, hash);
  const q = body.indexOf('?');
  const params = new URLSearchParams(q < 0 ? '' : body.slice(q + 1));
  let main = q < 0 ? body : body.slice(0, q);
  if (!main.includes('@')) main = base64(main);
  const at = main.lastIndexOf('@');
  if (at < 0) fail('SS 缺少认证信息或服务器地址');
  let auth = unescape(main.slice(0, at));
  if (!auth.includes(':')) auth = base64(auth);
  const colon = auth.indexOf(':');
  if (colon <= 0 || colon === auth.length - 1) fail('SS 缺少加密方式或密码');
  const cipher = auth.slice(0, colon);
  if (!/^[a-zA-Z0-9-]+$/.test(cipher)) fail('SS 加密方式格式不正确');
  const address = url('ss://' + main.slice(at + 1));
  if (address.username || address.password || (address.pathname && address.pathname !== '/')) fail('SS 服务器地址格式不正确');
  const proxy = { type: 'ss', ...endpoint(address.hostname, address.port), cipher, password: auth.slice(colon + 1), udp: true };
  if (params.has('plugin')) {
    const [plugin, ...parts] = params.get('plugin').split(';');
    if (!['obfs-local', 'simple-obfs', 'obfs', 'v2ray-plugin'].includes(plugin)) fail('暂不支持此 SS 插件，请手动配置');
    const opts = Object.create(null);
    for (const part of parts) {
      const i = part.indexOf('=');const key = i < 0 ? part : part.slice(0, i);const value = i < 0 ? true : part.slice(i + 1);
      if (!key) continue;
      const mapped = { obfs: 'mode', 'obfs-host': 'host', 'obfs-uri': 'path' }[key] || key;
      if (!['mode', 'host', 'path', 'tls', 'mux', 'skip-cert-verify'].includes(mapped)) fail('暂不支持此 SS 插件参数，请手动配置');
      opts[mapped] = ['tls', 'mux', 'skip-cert-verify'].includes(mapped) ? boolean(text(value)) : value;
    }
    proxy.plugin = plugin === 'v2ray-plugin' ? plugin : 'obfs';
    if (proxy.plugin === 'obfs' && !['http', 'tls'].includes(opts.mode)) fail('SS obfs 插件缺少有效模式');
    if (proxy.plugin === 'v2ray-plugin') {
      if (opts.mode && opts.mode !== 'websocket') fail('暂不支持此 v2ray-plugin 模式');
      opts.mode = 'websocket';
    }
    proxy['plugin-opts'] = { ...opts };
  }
  if ([...params.keys()].some(k => !['plugin'].includes(k))) warnings.push('含未映射的 SS 参数，请在编辑器核对');
  return { name, proxy };
}
function parseVMess(body, warnings) {
  const hash = body.indexOf('#');
  const fragment = hash < 0 ? '' : unescape(body.slice(hash + 1));
  let o;
  try { o = JSON.parse(base64(hash < 0 ? body : body.slice(0, hash))); } catch { fail('VMess 需要 Base64 编码的 JSON 分享链接'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail('VMess JSON 应为对象');
  for (const key of ['ps','add','port','id','aid','scy','net','type','host','path','tls','sni','fp','allowInsecure','serviceName']) {
    if (o[key] != null && !['string','number','boolean'].includes(typeof o[key])) fail('VMess 字段类型不正确');
  }
  if (o.alpn != null && typeof o.alpn !== 'string' && !(Array.isArray(o.alpn) && o.alpn.every(v => typeof v === 'string'))) fail('VMess ALPN 字段类型不正确');
  const proxy = { type: 'vmess', ...endpoint(o.add, o.port), uuid: uuid(o.id), alterId: integer(o.aid ?? 0, 0, 65535, 'alterId'), cipher: o.scy || 'auto', udp: true };
  if (!['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'].includes(proxy.cipher)) fail('不支持此 VMess 加密方式');
  if (o.tls && !['tls', 'none'].includes(o.tls)) fail('不支持此 VMess TLS 类型');
  let net = o.net || 'tcp';
  if (net === 'tcp' && o.type === 'http') net = 'http';
  else if (o.type && !['none', 'gun'].includes(o.type)) fail('不支持此 VMess 传输伪装');
  transport(proxy, net, text(o.host), text(o.path), text(o.serviceName));
  tls(proxy, { enabled: o.tls === 'tls', sni: o.sni, alpn: o.alpn, fp: o.fp, insecure: o.allowInsecure });
  const known = ['v','ps','add','port','id','aid','scy','net','type','host','path','tls','sni','alpn','fp','allowInsecure','serviceName'];
  if (Object.keys(o).some(k => !known.includes(k))) warnings.push('含未映射的 VMess 字段，请在编辑器核对');
  return { name: fragment || text(o.ps), proxy };
}
function parseStandard(uri, type, warnings) {
  const u = url(uri), q = u.searchParams;
  const used = new Set();
  const param = (...names) => {names.forEach(n => used.add(n));return names.map(n => q.get(n)).find(v => v !== null && v !== '') || '';};
  const proxy = { type, ...endpoint(u.hostname, u.port || (['trojan','hysteria2','tuic'].includes(type) ? 443 : '')), udp: true };
  const username = unescape(u.username), password = unescape(u.password);
  if (type === 'vless') {
    if (u.password) fail('VLESS 认证部分应仅含 UUID');
    proxy.uuid = uuid(username);
    const encryption = param('encryption');if (encryption && encryption !== 'none') fail('暂不支持此 VLESS encryption');
    const flow = param('flow');
    if (flow && flow !== 'xtls-rprx-vision') fail('暂不支持此 VLESS flow');
    if (flow) proxy.flow = flow;
  } else if (type === 'tuic') {
    proxy.uuid = uuid(username);if (!password) fail('TUIC 缺少密码');proxy.password = password;
  } else {
    proxy.password = username + (u.password ? ':' + password : '');
    if (!proxy.password) fail('节点缺少密码');
  }
  if (u.pathname && u.pathname !== '/') fail('传输路径应放在 URI 的 path 参数中');
  const security = param('security');
  if (['hysteria2','tuic'].includes(type) && security && security !== 'tls') fail('此协议只支持 TLS');
  if (type === 'vless' || type === 'trojan') {
    if (security && !['none','tls','reality'].includes(security)) fail('不支持此 security 类型');
    if (type === 'trojan' && security === 'none') fail('Trojan 不支持关闭 TLS');
    transport(proxy, param('type', 'network') || 'tcp', param('host'), param('path'), param('serviceName'));
    if (proxy.network === 'grpc' && param('mode') && q.get('mode') !== 'gun') fail('暂不支持此 gRPC mode');
  }
  tls(proxy, { enabled: type === 'vless' ? ['tls','reality'].includes(security) : undefined,
    sni: param('sni','peer','servername'), alpn: param('alpn'), fp: param('fp'), insecure: param('allowInsecure','insecure','skip-cert-verify') });
  if (security === 'reality') {
    if (!['vless','trojan'].includes(type)) fail('此协议不支持 Reality');
    const key = param('pbk','public-key'), sid = param('sid','short-id');
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) fail('Reality 公钥缺失或格式不正确');
    if (!/^(?:[0-9a-fA-F]{2}){0,8}$/.test(sid)) fail('Reality short-id 格式不正确');
    proxy['reality-opts'] = { 'public-key': key, 'short-id': sid };
    proxy['client-fingerprint'] ||= 'chrome';
  }
  if (type === 'hysteria2') {
    const obfs = param('obfs'), obfsPassword = param('obfs-password');
    if (obfs) { if (obfs !== 'salamander' || !obfsPassword) fail('Hysteria2 混淆需要 salamander 和 obfs-password');proxy.obfs = obfs;proxy['obfs-password'] = obfsPassword; }
    if (param('mport')) fail('暂不支持端口跳跃链接，请手动配置 ports');
  }
  if (type === 'tuic') {
    const cc = param('congestion_control','congestion-controller');
    const relay = param('udp_relay_mode','udp-relay-mode');
    if (cc) { if (!['cubic','bbr','new_reno'].includes(cc)) fail('TUIC 拥塞控制参数不正确');proxy['congestion-controller'] = cc; }
    if (relay) { if (!['native','quic'].includes(relay)) fail('TUIC UDP 转发模式不正确');proxy['udp-relay-mode'] = relay; }
    const reduce = param('reduce_rtt','reduce-rtt');if (reduce) proxy['reduce-rtt'] = boolean(reduce);
    const disable = param('disable_sni','disable-sni');if (disable) proxy['disable-sni'] = boolean(disable);
  }
  if ([...q.keys()].some(k => !used.has(k))) warnings.push('含未映射的 URI 参数，请在编辑器核对');
  return { name: unescape(u.hash.slice(1)), proxy };
}
export function parseProxyURI(uri) {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(uri);
  if (!match) fail('不是有效的节点 URI');
  let type = match[1].toLowerCase();if (type === 'hy2') type = 'hysteria2';
  const warnings = [];
  let result;
  if (type === 'ss') result = parseSS(match[2], warnings);
  else if (type === 'vmess') result = parseVMess(match[2], warnings);
  else if (['vless','trojan','hysteria2','tuic'].includes(type)) result = parseStandard(uri, type, warnings);
  else fail('暂不支持此协议（支持 SS / VMess / VLESS / Trojan / Hysteria2 / TUIC）');
  const name = (result.name || `${type}-${result.proxy.server}:${result.proxy.port}`).replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (name.length > 200) fail('节点名称过长（最多 200 字符）');
  return { proxy: { name: name || type + '-out', ...result.proxy }, warnings };
}
export function parseProxyURIs(input, existingNames = []) {
  input = text(input);
  if (input.length > MAX_TEXT || new TextEncoder().encode(input).length > MAX_TEXT) fail('内容过大，请分批导入（每批最多 1 MiB 文本）');
  const entries = [];
  input.split(/\r?\n/).forEach((line, i) => line.trim().split(/\s+(?=[a-z][a-z0-9+.-]*:\/\/)/i).filter(Boolean).forEach(uri => entries.push({ uri, line: i + 1 })));
  if (!entries.length) fail('请先粘贴节点 URI');
  if (entries.length > MAX_NODES) fail('每批最多 500 个节点，请分批导入');
  const names = new Set(existingNames), seen = new Set();
  const result = { proxies: [], added: [], errors: [], skipped: 0, total: entries.length };
  for (const { uri, line } of entries) {
    if (seen.has(uri)) { result.skipped++;continue; }
    seen.add(uri);
    try {
      const { proxy, warnings } = parseProxyURI(uri);
      const original = proxy.name;let index = 2;
      while (names.has(proxy.name)) proxy.name = `${original} (${index++})`;
      names.add(proxy.name);result.proxies.push(proxy);
      result.added.push({ line, name: proxy.name, renamed: proxy.name !== original, warnings });
    } catch (e) { result.errors.push({ line, message: e.message, input: uri }); }
  }
  return result;
}
