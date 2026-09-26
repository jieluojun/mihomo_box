// ============================================================
// 出站/集合/组/规则子页：出站代理 / 代理集合 / 代理组 / 路由规则 / 规则集合 / 子规则（入口已并入配置页）
// ============================================================
import { h, state, deepClone, get, set, unset, badge, note, groupTitle, card, chev, ntoast, confirmSheet, openSheet, openChildSheet, closeSheet, sheetGuard, markDirty, commitConfigEdit, commitNewOutboundProxies, cmdline, shell, readText, writeText, pickFileWithFeedback, writeB64, absPath, relPath, bufToB64, WORKDIR, selectCtl, segCtl, shq, subsSheet, enableDragSort, renderKeepScroll, entryAnchorInfo, entryFieldAnchors, entryHasLocalField, scanYamlAnchors, anchorDefValue } from './core.js';
import { fieldRow, listEditor, boolAsPick } from './fields.js';
import { openProxyUriImport } from './proxy-uri-sheet.js';
import { requestReferenceDelete } from './reference-delete.js';
import { policyNames, policyOptions, BUILTIN_POLICIES } from './pages-config.js';

// 小图标按钮
function miniBtn(t, fn, disabled = false) {
  const b = h('button', { class: 'mini-btn', text: t, onclick: fn });
  if (disabled) { b.style.opacity = .35; b.disabled = true; }
  return b;
}

// ============================================================
// 出站代理 proxies
// ============================================================
// OpenVPN 合法取值：内核 openvpn/config.go 的 ValidateInstallScriptSubset 强校验，
// 只接受下列枚举，填其他值节点会直接启动失败（normalizeCipher 还会把 AES-CBC 归一为 AES-128-CBC）
const OVPN_CIPHERS = [
  ['AES-128-GCM', 'AES-128-GCM（默认）'],
  ['AES-192-GCM', 'AES-192-GCM'],
  ['AES-256-GCM', 'AES-256-GCM'],
  ['CHACHA20-POLY1305', 'CHACHA20-POLY1305'],
  ['AES-128-CBC', 'AES-128-CBC'],
  ['AES-192-CBC', 'AES-192-CBC'],
  ['AES-256-CBC', 'AES-256-CBC'],
];
const OVPN_AUTHS = [
  ['SHA256', 'SHA256（默认）'],
  ['SHA1', 'SHA1'],
  ['SHA384', 'SHA384'],
  ['SHA512', 'SHA512'],
  ['MD5', 'MD5'],
];

// OpenVPN 保存前校验。内核侧规则（openvpn/config.go ValidateInstallScriptSubset）：
//  - ca 为必填（OpenVPNOption 的 tag 无 omitempty）
//  - 认证需「证书(cert+key)」或「用户名密码」至少一套完整
//  - cipher / auth 只接受固定枚举值
function validateOpenVPN(t) {
  const s = v => (v === undefined || v === null ? '' : String(v).trim());
  const ca = s(t.ca);
  if (!ca) return 'OpenVPN 缺少 CA 根证书（内核必填），请粘贴 CA 证书 PEM 内容';
  if (/请替换为 CA 根证书内容/.test(ca)) return 'CA 根证书还是占位内容，请替换为真实证书';
  if (!/BEGIN CERTIFICATE/.test(ca)) return 'CA 根证书格式不正确，应包含 -----BEGIN CERTIFICATE-----';

  const cert = s(t.cert), key = s(t.key);
  const user = s(t.username), pass = s(t.password);
  const byCert = cert || key;
  const byPass = user || pass;
  if (!byCert && !byPass) return 'OpenVPN 需要认证方式：填写「证书+私钥」或「用户名+密码」';
  if (byCert && (!cert || !key)) return '证书认证需同时填写「客户端证书」和「客户端私钥」';

  const ciphers = OVPN_CIPHERS.map(([v]) => v);
  if (t.cipher && !ciphers.includes(s(t.cipher))) return `cipher 取值不受支持：${t.cipher}（仅 ${ciphers.join(' / ')}）`;
  const auths = OVPN_AUTHS.map(([v]) => v);
  if (t.auth && !auths.includes(s(t.auth))) return `auth 取值不受支持：${t.auth}（仅 ${auths.join(' / ')}）`;
  return null;
}

const PROXY_TEMPLATES = {
  direct: { name: '新的直连', type: 'direct', udp: true },
  dns: { name: 'DNS 出站', type: 'dns' },
  reject: { name: '新的拒绝出站', type: 'reject' },
  rematch: { name: '新的REMATCH', type: 'rematch', 'target-rematch-name': 'mark1' },
  http: { name: '新的HTTP代理', type: 'http', server: '1.2.3.4', port: 8080 },
  socks5: { name: '新的Socks5', type: 'socks5', server: '1.2.3.4', port: 1080, udp: true },
  ss: { name: '新的SS节点', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: '密码', udp: true },
  ssr: { name: '新的SSR节点', type: 'ssr', server: '1.2.3.4', port: 8388, cipher: 'aes-256-cfb', password: '密码', protocol: 'origin', obfs: 'http_simple', udp: true },
  snell: { name: '新的Snell节点', type: 'snell', server: '1.2.3.4', port: 8388, psk: '密码', version: 4, udp: true },
  // 不预设 network：配置无该字段时编辑器显示「tcp（默认）」，保存才落显式字段；也不预设 ws
  vmess: { name: '新的VMess节点', type: 'vmess', server: '1.2.3.4', port: 443, uuid: 'uuid', alterId: 0, cipher: 'auto', udp: true },
  // 默认不启用 TLS、不配置 SNI/Reality——需要时在编辑器里手动开 TLS（开启会自动补默认 SNI）
  // network 不写即显示「tcp（默认）」；保存时落为显式 network: tcp
  vless: { name: '新的VLESS节点', type: 'vless', server: '1.2.3.4', port: 443, uuid: 'uuid', udp: true, 'client-fingerprint': 'chrome' },
  trojan: { name: '新的Trojan节点', type: 'trojan', server: '1.2.3.4', port: 443, password: '密码', sni: 'example.com', udp: true },
  anytls: { name: '新的AnyTLS节点', type: 'anytls', server: '1.2.3.4', port: 443, password: '密码', sni: 'example.com', 'skip-cert-verify': false, udp: true },
  mieru: { name: '新的Mieru节点', type: 'mieru', server: '1.2.3.4', port: 2999, username: 'user', password: '密码', transport: 'TCP' },
  sudoku: { name: '新的Sudoku节点', type: 'sudoku', server: '1.2.3.4', port: 8080, key: '密钥', aead: true },
  hysteria: { name: '新的Hy1节点', type: 'hysteria', server: '1.2.3.4', port: 443, 'auth-str': '密码', protocol: 'udp', up: 30, down: 100, sni: 'example.com' },
  hysteria2: { name: '新的Hy2节点', type: 'hysteria2', server: '1.2.3.4', port: 443, password: '密码', sni: 'example.com', 'skip-cert-verify': false },
  tuic: { name: '新的Tuic节点', type: 'tuic', server: '1.2.3.4', port: 443, uuid: 'uuid', password: '密码', 'congestion-controller': 'cubic', 'udp-relay-mode': 'native' },
  shadowquic: { name: '新的ShadowQUIC', type: 'shadowquic', server: 'www.example.com', port: 10443, username: 'user', password: 'pass' },
  wireguard: { name: '新的WireGuard', type: 'wireguard', server: '1.2.3.4', port: 51820, ip: '172.16.0.2/32', 'private-key': '本机私钥', 'public-key': '对端公钥', udp: true },
  tailscale: { name: '新的Tailscale', type: 'tailscale', hostname: 'mihomo', 'auth-key': 'tskey-auth-xxxx', udp: true, 'accept-routes': true },
  ssh: { name: '新的SSH节点', type: 'ssh', server: '1.2.3.4', port: 22, username: 'root', password: '密码' },
  masque: { name: '新的MASQUE', type: 'masque', server: 'server.com', port: 443, 'private-key': '', 'public-key': '', ip: '172.16.0.2/32', mtu: 1280, udp: true },
  trusttunnel: { name: '新的TrustTunnel', type: 'trusttunnel', server: '1.2.3.4', port: 443, username: 'user', password: 'pass', 'health-check': true, udp: true },
  zerotier: { name: '新的ZeroTier', type: 'zerotier', network: '0123456789abcdef', udp: true },
  // ca 是内核必填字段（tag 无 omitempty），给占位值避免新建后直接不可用
  openvpn: { name: '新的OpenVPN', type: 'openvpn', server: 'vpn.example.com', port: 1194, proto: 'udp', username: 'user', password: 'pass', ca: '-----BEGIN CERTIFICATE-----\n请替换为 CA 根证书内容\n-----END CERTIFICATE-----', udp: true },
};

export function renderProxies(el) { return renderKeepScroll(() => renderProxiesCore(el)); }
function renderProxiesCore(el) {
  el.innerHTML = '';
  const list = Array.isArray(state.cfg.proxies) && state.cfg.proxies ? state.cfg.proxies : [];
  el.append(note('单个出站代理（proxies 数组）。点击节点编辑/重命名，「＋ 新建」先填名称，再在表单内选择协议。'));

  const pCard = card();
  const addBtn = h('button', { class: 'btn sm pri', text: '＋ 新建节点', onclick: () => {
    const t = deepClone(PROXY_TEMPLATES[Object.keys(PROXY_TEMPLATES)[0]]);
    delete t.name;
    editProxySheet(list.length, t, true);
  } });
  const parseBtn = h('button', { class: 'btn sm', text: '解析', onclick: () => openProxyUriImport(() => renderProxies(el), BUILTIN_POLICIES.map(([name]) => name)) });
  pCard.append(h('div', { class: 'card-head' }, h('h3', { text: `${list.length} 个出站代理` }),
    h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, parseBtn, addBtn)));
  if (!list.length) { pCard.append(h('div', { class: 'empty', text: '暂无手动节点，可解析 URI、新建或使用订阅' })); }
  else {
    list.forEach((p, i) => {
      pCard.append(h('div', { class: 'rule-item ep-row' },
        h('div', { class: 'ep-main' },
          h('div', { class: 'ep-title' },
            h('span', { class: 'ep-name', text: p.name || '(未命名)' }), badge(p.type || '?', 'p')),
          h('div', { class: 'ep-url', text: `${p.server || ''}${p.port ? ':' + p.port : ''}` || '-' })),
        h('span', { class: 'ep-acts' },
          miniBtn('✎', () => editProxySheet(i, p, false)),
          miniBtn('×', () => requestReferenceDelete('proxies', p.name, () => renderProxies(el))))));
    });
  }
  el.append(pCard);

  // ---- 节点表单字段定义（官方出站全协议 + 传输层） ----
  const FP_OPTS = [['chrome','chrome'],['firefox','firefox'],['safari','safari'],['ios','ios'],['android','android'],['edge','edge'],['random','random'],['randomized','randomized']];
  const PER_TYPE = {
    ss: [
      { path: 'cipher', label: '加密方式 cipher', type: 'text', optional: true, placeholder: 'aes-256-gcm / 2022-blake3-aes-128-gcm' },
      { path: 'password', label: '密码', type: 'text', optional: true },
      { path: 'plugin', label: '插件 plugin', type: 'select', allowEmpty: true, options: [['obfs','obfs'],['v2ray-plugin','v2ray-plugin'],['shadow-tls','shadow-tls'],['restls','restls']] },
      { path: 'plugin-opts', label: '插件参数 plugin-opts', type: 'maptext', optional: true, desc: '如 mode: tls / host: bing.com / password: xxx' },
      { path: 'udp-over-tcp', label: 'UDP over TCP', type: 'bool', optional: true },
    ],
    ssr: [
      { path: 'cipher', label: '加密方式 cipher', type: 'text', optional: true },
      { path: 'password', label: '密码', type: 'text', optional: true },
      { path: 'protocol', label: '协议 protocol', type: 'text', optional: true, placeholder: 'origin / auth_aes128_md5' },
      { path: 'obfs', label: '混淆 obfs', type: 'text', optional: true, placeholder: 'plain / http_simple' },
      { path: 'protocol-param', label: '协议参数', type: 'text', optional: true },
      { path: 'obfs-param', label: '混淆参数', type: 'text', optional: true },
    ],
    vmess: [
      { path: 'uuid', label: 'UUID', type: 'text', optional: true },
      { path: 'alterId', label: 'alterId', type: 'number', optional: true },
      { path: 'cipher', label: '加密方式', type: 'select', allowEmpty: true, options: [['auto','auto'],['aes-128-gcm','aes-128-gcm'],['chacha20-poly1305','chacha20-poly1305'],['none','none']] },
      { path: 'xudp', label: 'XUDP', type: 'bool', optional: true },
    ],
    vless: [
      { path: 'uuid', label: 'UUID', type: 'text', optional: true },
      { path: 'flow', label: 'flow 流控', type: 'select', allowEmpty: true, options: [['xtls-rprx-vision','xtls-rprx-vision']] },
      { path: 'packet-encoding', label: '包编码', type: 'select', allowEmpty: true, options: [['packetaddr','packetaddr'],['xudp','xudp']] },
      { path: 'encryption', label: 'encryption（ML-KEM 等）', type: 'text', optional: true, placeholder: 'none / mlkem768x25519plus.…' , tag: '新版' },
    ],
    trojan: [{ path: 'password', label: '密码', type: 'text', optional: true }],
    hysteria2: [
      { path: 'password', label: '密码', type: 'text', optional: true },
      { path: 'up', label: '上行带宽', type: 'text', optional: true, placeholder: '30 Mbps / 数字' },
      { path: 'down', label: '下行带宽', type: 'text', optional: true, placeholder: '200 Mbps' },
      { path: 'obfs', label: '混淆 obfs', type: 'select', allowEmpty: true, options: [['salamander','salamander']] },
      { path: 'obfs-password', label: '混淆密码', type: 'text', optional: true },
      { path: 'ports', label: '端口跳跃 ports', type: 'text', optional: true, placeholder: '10000-20000', desc: '范围或逗号分隔多端口；留空=单端口' },
      { path: 'hop-interval', label: '跳跃间隔 hop-interval（秒）', type: 'number', optional: true },
    ],
    hysteria: [
      { path: 'auth-str', label: '认证串 auth-str', type: 'text', optional: true },
      { path: 'protocol', label: '协议', type: 'select', allowEmpty: true, options: [['udp','udp'],['wechat-video','wechat-video'],['faketcp','faketcp']] },
      { path: 'up', label: '上行带宽', type: 'text', optional: true },
      { path: 'down', label: '下行带宽', type: 'text', optional: true },
    ],
    tuic: [
      { path: 'uuid', label: 'UUID', type: 'text', optional: true },
      { path: 'password', label: '密码', type: 'text', optional: true },
      { path: 'congestion-controller', label: '拥塞控制', type: 'select', allowEmpty: true, options: [['cubic','cubic'],['bbr','bbr'],['new_reno','new_reno']] },
      { path: 'udp-relay-mode', label: 'UDP 中继模式', type: 'select', allowEmpty: true, options: [['native','native'],['quic','quic']] },
      { path: 'reduce-rtt', label: '0-RTT 握手', type: 'bool', optional: true },
      { path: 'heartbeat-interval', label: '心跳间隔(ms)', type: 'number', optional: true },
    ],
    anytls: [
      { path: 'password', label: '密码', type: 'text', optional: true },
      { path: 'idle-session-check-interval', label: '空闲检查间隔(秒)', type: 'number', optional: true },
      { path: 'idle-session-timeout', label: '空闲会话超时(秒)', type: 'number', optional: true },
      { path: 'min-idle-session', label: '最小空闲会话数', type: 'number', optional: true },
    ],
    socks5: [
      { path: 'username', label: '用户名', type: 'text', optional: true },
      { path: 'password', label: '密码', type: 'text', optional: true },
      { path: 'tls', label: 'TLS 加密', type: 'bool', optional: true },
    ],
    http: [
      { path: 'username', label: '用户名', type: 'text', optional: true },
      { path: 'password', label: '密码', type: 'text', optional: true },
      { path: 'tls', label: 'TLS (https)', type: 'bool', optional: true },
    ],
    snell: [
      { path: 'psk', label: 'PSK 密钥', type: 'text', optional: true },
      { path: 'version', label: '协议版本', type: 'select', allowEmpty: true, num: true, options: [['1', 'v1'], ['2', 'v2'], ['3', 'v3'], ['4', 'v4（推荐）'], ['5', 'v5（最新，需服务端支持）']] },
      { path: 'obfs-opts.mode', label: '混淆模式', type: 'select', allowEmpty: true, options: [['http', 'http'], ['tls', 'tls']] },
      { path: 'obfs-opts.host', label: '混淆 Host', type: 'text', optional: true, placeholder: '如 itunes.apple.com' },
    ],
    mieru: [
      { path: 'username', label: '用户名', type: 'text', optional: true },
      { path: 'password', label: '密码', type: 'text', optional: true },
      { path: 'transport', label: '传输 transport', type: 'select', allowEmpty: true, options: [['TCP', 'TCP']] },
      { path: 'multiplexing', label: '多路复用', type: 'select', allowEmpty: true, options: [['MULTIPLEXING_OFF', '关闭'], ['MULTIPLEXING_LOW', '低'], ['MULTIPLEXING_MIDDLE', '中'], ['MULTIPLEXING_HIGH', '高']] },
    ],
    sudoku: [
      { path: 'key', label: '密钥 key', type: 'text', optional: true },
      { path: 'aead', label: 'AEAD 加密', type: 'bool', optional: true },
      { path: 'table-type', label: '映射表类型', type: 'text', optional: true, placeholder: 'prefer_ascii / prefer_entropy' },
      { path: 'padding-min', label: '最小填充(%)', type: 'number', optional: true },
      { path: 'padding-max', label: '最大填充(%)', type: 'number', optional: true },
    ],
    ssh: [
      { path: 'username', label: '用户名', type: 'text', optional: true },
      { path: 'password', label: '密码（与私钥二选一）', type: 'text', optional: true },
      { path: 'private-key', label: '私钥（路径或内容）', type: 'text', optional: true },
      { path: 'host-key-algorithms', label: '主机公钥算法', type: 'list', optional: true },
      { path: 'host-key', label: '固定主机公钥', type: 'list', optional: true },
    ],
    wireguard: [
      { path: 'ip', label: '本机 IPv4（CIDR）', type: 'text', optional: true, placeholder: '172.16.0.2/32' },
      { path: 'ipv6', label: '本机 IPv6（CIDR）', type: 'text', optional: true },
      { path: 'private-key', label: '本机私钥', type: 'text', optional: true },
      { path: 'public-key', label: '对端公钥', type: 'text', optional: true },
      { path: 'pre-shared-key', label: '预共享密钥 PSK', type: 'text', optional: true },
      { path: 'allowed-ips', label: 'AllowedIPs', type: 'list', optional: true, hint: '0.0.0.0/0, ::/0' },
      { path: 'dns', label: 'DNS 服务器', type: 'list', optional: true },
      { path: 'mtu', label: 'MTU', type: 'number', optional: true },
      { path: 'remote-dns-resolve', label: '远端 DNS 解析', type: 'bool', optional: true },
      { path: 'fwmark', label: 'fwmark 路由标记', type: 'number', optional: true },
    ],
    direct: [
      { path: 'udp', label: 'UDP 支持', type: 'bool', optional: true },
      { path: 'ip-version', label: 'IP 版本', type: 'select', optional: true, allowEmpty: true, options: [['dual', 'dual(双栈)'], ['ipv4', 'ipv4'], ['ipv6', 'ipv6'], ['ipv4-prefer', 'ipv4 优先'], ['ipv6-prefer', 'ipv6 优先']] },
    ],
    dns: [],
    reject: [],
    rematch: [
      { path: 'target-rematch-name', label: '重匹配名称 REMATCH-NAME', type: 'text', optional: true },
      { path: 'target-sub-rule', label: '跳转子规则 sub-rule', type: 'text', optional: true },
    ],
    // 依据 MetaCubeX/mihomo adapter/outbound/openvpn.go 的 OpenVPNOption（v1.19.27）。
    // 内核会对 cipher / auth / dev / proto 做强校验，取值不对直接启动失败，
    // 所以这几项用下拉限定合法值，而非自由文本。
    openvpn: [
      { path: 'proto', label: '传输协议 proto', type: 'select', allowEmpty: true, options: [['udp', 'udp（默认）'], ['tcp', 'tcp']], desc: '仅支持 udp / tcp' },
      { path: 'dev', label: '虚拟网卡类型 dev', type: 'select', allowEmpty: true, options: [['tun', 'tun（默认·内核仅支持）']], desc: '内核校验：非 tun 直接报错' },
      // ---- 服务端校验：CA 必填（内核 tag 无 omitempty）----
      { path: 'ca', label: 'CA 根证书（PEM）', type: 'textarea', tag: '必填', tagCls: 'p',
        placeholder: '-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----',
        desc: '必填。用于校验服务端证书，缺失会导致节点不可用' },
      // ---- 客户端认证：证书 / 用户名密码 二选一 ----
      { path: 'cert', label: '客户端证书（PEM）', type: 'textarea', optional: true,
        placeholder: '-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----',
        desc: '证书认证时填；与下方用户名密码二选一' },
      { path: 'key', label: '客户端私钥（PEM）', type: 'textarea', optional: true,
        placeholder: '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----' },
      { path: 'username', label: '用户名', type: 'text', optional: true },
      { path: 'password', label: '密码', type: 'password', optional: true },
      { path: 'tls-crypt', label: 'tls-crypt 静态密钥', type: 'textarea', optional: true,
        placeholder: '-----BEGIN OpenVPN Static key V1-----\n…\n-----END OpenVPN Static key V1-----',
        desc: '控制通道加密密钥（可与服务端 tls-crypt 配套）' },
      // ---- 加密参数：内核强校验，限定取值 ----
      { path: 'cipher', label: '加密算法 cipher', type: 'select', allowEmpty: true, options: OVPN_CIPHERS, desc: '内核校验：仅接受列出的套件，留空= AES-128-GCM' },
      { path: 'auth', label: 'HMAC 校验 auth', type: 'select', allowEmpty: true, options: OVPN_AUTHS, desc: '留空= SHA256' },
      { path: 'comp-lzo', label: 'LZO 压缩 comp-lzo', type: 'select', allowEmpty: true, options: [['yes', 'yes'], ['adaptive', 'adaptive'], ['no', 'no']], desc: 'adaptive 等同 yes' },
      // ---- 连接参数 ----
      { path: 'mtu', label: 'MTU', type: 'number', optional: true },
      { path: 'ping', label: 'ping 间隔（秒）', type: 'number', optional: true },
      { path: 'ping-restart', label: 'ping-restart（秒）', type: 'number', optional: true },
      { path: 'udp', label: 'UDP 支持', type: 'bool', optional: true },
      { path: 'remote-dns-resolve', label: '远端 DNS 解析', type: 'bool', optional: true },
      { path: 'dns', label: '远端 DNS 服务器', type: 'list', optional: true },
    ],
    masque: [
      { path: 'private-key', label: '私钥 private-key (Base64)', type: 'text', optional: true },
      { path: 'public-key', label: '公钥 public-key (Base64)', type: 'text', optional: true },
      { path: 'ip', label: '本机 IPv4（CIDR）', type: 'text', optional: true, placeholder: '172.16.0.2/32' },
      { path: 'ipv6', label: '本机 IPv6（CIDR）', type: 'text', optional: true },
      { path: 'network', label: '工作模式 network', type: 'select', allowEmpty: true, options: [['', 'h3（默认·TUN 出站）'], ['h3-l4proxy', 'h3-l4proxy（L4 代理）'], ['h2', 'h2']] },
      { path: 'sni', label: 'SNI', type: 'text', optional: true },
      { path: 'mtu', label: 'MTU', type: 'number', optional: true },
      { path: 'udp', label: 'UDP 支持', type: 'bool', optional: true },
      { path: 'congestion-controller', label: '拥塞控制', type: 'select', allowEmpty: true, options: [['cubic', 'cubic'], ['bbr', 'bbr'], ['new_reno', 'new_reno']] },
      { path: 'bbr-profile', label: 'BBR 策略', type: 'select', allowEmpty: true, options: [['standard', 'standard'], ['conservative', 'conservative'], ['aggressive', 'aggressive']] },
      { path: 'handshake-timeout', label: '握手超时（秒）', type: 'number', optional: true },
    ],
    trusttunnel: [
      { path: 'username', label: '用户名', type: 'text', optional: true },
      { path: 'password', label: '密码', type: 'text', optional: true },
      { path: 'health-check', label: '健康检查', type: 'bool', optional: true },
      { path: 'udp', label: 'UDP 支持', type: 'bool', optional: true },
      { path: 'quic', label: 'QUIC 传输', type: 'bool', optional: true },
      { path: 'sni', label: 'SNI', type: 'text', optional: true },
      { path: 'alpn', label: 'ALPN', type: 'list', optional: true, hint: 'h2' },
      { path: 'client-fingerprint', label: 'TLS 指纹', type: 'select', allowEmpty: true, options: FP_OPTS },
      { path: 'congestion-controller', label: '拥塞控制', type: 'select', allowEmpty: true, options: [['cubic', 'cubic'], ['bbr', 'bbr'], ['new_reno', 'new_reno']] },
      { path: 'bbr-profile', label: 'BBR 策略', type: 'select', allowEmpty: true, options: [['standard', 'standard'], ['conservative', 'conservative'], ['aggressive', 'aggressive']] },
      { path: 'skip-cert-verify', label: '跳过证书校验', type: 'bool', optional: true },
      { path: 'max-connections', label: '最大连接数', type: 'number', optional: true },
      { path: 'min-streams', label: '最小复用流', type: 'number', optional: true },
      { path: 'max-streams', label: '最大复用流', type: 'number', optional: true },
    ],
    shadowquic: [
      { path: 'username', label: '用户名', type: 'text', optional: true },
      { path: 'password', label: '密码', type: 'text', optional: true },
      { path: 'sni', label: 'SNI', type: 'text', optional: true },
      { path: 'alpn', label: 'ALPN', type: 'list', optional: true, hint: 'h3' },
      { path: 'quic-versions', label: 'QUIC 版本', type: 'text', optional: true, placeholder: 'v1' },
      { path: 'udp-over-stream', label: 'UDP over Stream', type: 'bool', optional: true },
      { path: 'zero-rtt', label: '0-RTT', type: 'bool', optional: true },
      { path: 'keep-alive-interval', label: '保活间隔（ms）', type: 'number', optional: true },
      { path: 'congestion-controller', label: '拥塞控制', type: 'select', allowEmpty: true, options: [['cubic', 'cubic'], ['bbr', 'bbr'], ['new_reno', 'new_reno']] },
      { path: 'bbr-profile', label: 'BBR 策略', type: 'select', allowEmpty: true, options: [['standard', 'standard'], ['conservative', 'conservative'], ['aggressive', 'aggressive']] },
      { path: 'max-datagram-frame-size', label: '最大 Datagram 帧', type: 'number', optional: true },
    ],
    tailscale: [
      { path: 'hostname', label: '设备名 hostname', type: 'text', optional: true },
      { path: 'auth-key', label: '登录密钥 auth-key', type: 'text', optional: true, placeholder: 'tskey-auth-xxxx' },
      { path: 'control-url', label: '控制服务地址', type: 'text', optional: true, placeholder: 'https://controlplane.tailscale.com' },
      { path: 'state-dir', label: '状态目录 state-dir', type: 'text', optional: true },
      { path: 'ephemeral', label: '临时节点 ephemeral', type: 'bool', optional: true },
      { path: 'accept-routes', label: '接受路由 accept-routes', type: 'bool', optional: true },
      { path: 'exit-node', label: '出口节点 exit-node', type: 'text', optional: true, placeholder: '100.64.0.1' },
      { path: 'exit-node-allow-lan-access', label: '出口节点允许 LAN 访问', type: 'bool', optional: true },
      { path: 'udp', label: 'UDP 支持', type: 'bool', optional: true },
    ],
    zerotier: [
      { path: 'network', label: '网络 ID (16 位 hex)', type: 'text', optional: true, placeholder: '0123456789abcdef' },
      { path: 'state-dir', label: '状态目录', type: 'text', optional: true },
      { path: 'planet', label: '私有 Planet 文件', type: 'text', optional: true },
      { path: 'mtu', label: 'MTU', type: 'number', optional: true },
      { path: 'physical-mtu', label: '物理 MTU', type: 'number', optional: true },
      { path: 'primary-port', label: '主端口', type: 'number', optional: true },
      { path: 'secondary-port', label: '次端口', type: 'number', optional: true },
      { path: 'low-bandwidth', label: '低带宽模式', type: 'bool', optional: true },
      { path: 'encrypted-hello', label: '加密握手', type: 'bool', optional: true },
      { path: 'udp', label: 'UDP 支持', type: 'bool', optional: true },
    ],
  };
  // 无服务器地址的内置/虚拟出站：不显示 server/port 表单
  const NO_SERVER = new Set(['direct', 'dns', 'rematch', 'reject', 'tailscale', 'zerotier']);
  // 传输层可视化只给内核真正认 network/ws-opts… 的协议：ss/ssr 的“传输”走 plugin/obfs，
  // 显示 network 块是误导（选了保存还被 prune），已从名单移除
  const SHOW_NET = new Set(['vmess', 'vless', 'trojan']);
  const SHOW_SMUX = new Set(['vmess', 'vless', 'trojan', 'ss', 'ssr', 'anytls', 'hysteria', 'hysteria2', 'tuic']);
  const SHOW_TLS = new Set(['vmess', 'vless', 'trojan', 'anytls']);
  const SHOW_HYTLS = new Set(['hysteria2', 'hysteria', 'tuic', 'socks5', 'http']); // 强制/可选 TLS 但无 tls 键
  const NET_TYPES = [['tcp', 'tcp（默认）'], ['ws', 'ws · WebSocket'], ['h2', 'h2 · HTTP/2'], ['grpc', 'grpc'], ['http', 'http'], ['xhttp', 'xhttp · 新版']];
  const NET_FIELDS = {
    ws: [
      { path: 'ws-opts.path', label: 'WS 路径', type: 'text', optional: true, placeholder: '/' },
      { path: 'ws-opts.headers', label: 'WS 请求头', type: 'headers', optional: true, desc: '自定义 WebSocket 请求头：左边填请求头名，右边填值' },
      { path: 'ws-opts.max-early-data', label: 'max-early-data', type: 'number', optional: true },
      { path: 'ws-opts.early-data-header-name', label: 'early-data 头名', type: 'text', optional: true, placeholder: 'Sec-WebSocket-Protocol' },
      { path: 'ws-opts.v2ray-http-upgrade', label: 'HTTP Upgrade 模式', type: 'bool', optional: true },
      { path: 'ws-opts.v2ray-http-upgrade-fast-open', label: 'HTTP Upgrade Fast Open', type: 'bool', optional: true },
    ],
    http: [
      { path: 'http-opts.method', label: 'HTTP 方法', type: 'text', optional: true, placeholder: 'GET' },
      { path: 'http-opts.path', label: 'HTTP 路径列表', type: 'list', optional: true, hint: '如 /' },
      { path: 'http-opts.headers', label: 'HTTP 请求头', type: 'headers', optional: true, arrayValues: true, desc: '自定义 HTTP 请求头：左边填请求头名，右边填值；同一个请求头可添加多行作为候选值（每次请求随机取一个）' },
    ],
    h2: [
      { path: 'h2-opts.host', label: 'H2 Host 列表', type: 'list', optional: true },
      { path: 'h2-opts.path', label: 'H2 路径', type: 'text', optional: true, placeholder: '/' },
    ],
    grpc: [{ path: 'grpc-opts.grpc-service-name', label: 'gRPC ServiceName', type: 'text', optional: true }],
    xhttp: [
      { path: 'xhttp-opts.path', label: 'XHTTP 路径', type: 'text', optional: true, placeholder: '/' },
      { path: 'xhttp-opts.host', label: 'XHTTP Host', type: 'text', optional: true },
      { path: 'xhttp-opts.mode', label: 'XHTTP 模式', type: 'select', allowEmpty: true, options: [['auto','auto'],['packet-up','packet-up'],['stream-up','stream-up'],['stream-one','stream-one']] },
      { path: 'xhttp-opts.headers', label: 'XHTTP 请求头', type: 'headers', optional: true, desc: '自定义 XHTTP 请求头：左边填请求头名，右边填值' },
      { path: 'xhttp-opts.no-grpc-header', label: '禁用 gRPC 头', type: 'bool', optional: true },
    ],
  };
  const TLS_FIELDS = [
    { path: 'tls', label: '启用 TLS', type: 'bool', optional: true },
    { path: 'servername', label: 'SNI（servername）', type: 'text', optional: true, placeholder: '同义：sni' },
    { path: 'skip-cert-verify', label: '跳过证书校验', type: 'bool', optional: true },
    { path: 'alpn', label: 'ALPN', type: 'list', optional: true, hint: 'h2, http/1.1' },
    { path: 'client-fingerprint', label: 'uTLS 指纹', type: 'select', allowEmpty: true, options: FP_OPTS },
    { path: 'fingerprint', label: '证书指纹(HEX)', type: 'text', optional: true },
    { path: 'reality-opts.public-key', label: 'Reality public-key', type: 'text', optional: true },
    { path: 'reality-opts.short-id', label: 'Reality short-id', type: 'text', optional: true },
  ];
  const HY_TLS_FIELDS = TLS_FIELDS.filter(f => f.path !== 'tls');
  const SMUX_FIELDS = [
    { path: 'smux.enabled', label: '启用多路复用 smux', type: 'bool', optional: true },
    { path: 'smux.protocol', label: '复用协议', type: 'select', allowEmpty: true, options: [['smux','smux'],['yamux','yamux'],['h2mux','h2mux']] },
    { path: 'smux.max-connections', label: '最大连接数', type: 'number', optional: true },
    { path: 'smux.min-streams', label: '最小流数', type: 'number', optional: true },
    { path: 'smux.max-streams', label: '最大流数', type: 'number', optional: true },
    { path: 'smux.padding', label: '填充 padding', type: 'bool', optional: true },
  ];
  const TAIL_FIELDS = [
    { path: 'udp', label: 'UDP', type: 'bool', optional: true },
    { path: 'tfo', label: 'TFO (TCP Fast Open)', type: 'bool', optional: true },
    { path: 'mptcp', label: 'MPTCP', type: 'bool', optional: true },
    { path: 'dialer-proxy', label: '链式出口 dialer-proxy', type: 'select', allowEmpty: true, emptyLabel: '默认（不覆写）', options: [], desc: '本节点经此出口建立连接（代理名/代理组）' },
    { path: 'interface-name', label: '绑定出口网卡', type: 'text', optional: true },
    { path: 'routing-mark', label: '路由标记 routing-mark', type: 'number', optional: true },
    { path: 'ip-version', label: 'IP 版本偏好', type: 'select', allowEmpty: true, options: [['dual','dual'],['ipv4','ipv4'],['ipv6','ipv6'],['ipv4-prefer','ipv4-prefer'],['ipv6-prefer','ipv6-prefer']] },
  ];

  function editProxySheet(idx, proxy, isNew) {
    const target = deepClone(proxy);
    const oldName = isNew ? '' : proxy.name;
    const ptype = target.type;
    const known = !!PER_TYPE[ptype];
    const nameInput = h('input', { type: 'text', value: oldName || target.name || (isNew ? ptype + '-out' : ''), placeholder: '节点名（唯一），默认按协议生成，可修改', style: 'width:100%' });
    delete target.name;

    const perFields = known ? PER_TYPE[ptype] : [];
    const baseBox = h('div', {});
    if (!NO_SERVER.has(ptype)) {
      [
        { path: 'server', label: '服务器地址', type: 'text', optional: true },
        { path: 'port', label: '端口', type: 'number', optional: true },
      ].forEach(f => baseBox.append(fieldRow(boolAsPick(f), target)));
    }
    perFields.forEach(f => baseBox.append(fieldRow(boolAsPick(f), target)));

    // 传输层（按 network 条件显示）
    // tcp 是显式选项值：配置没写 network 时选择器显示「tcp（默认）」；一旦保存即写出
    // network: tcp 字段（此前 '' 语义会在保存时删字段，造成「默认 tcp 传输保存后没该字段」）。
    const normNet = v => (!v || String(v) === 'tcp' ? 'tcp' : String(v));
    const netSel = selectCtl(NET_TYPES, normNet(target.network), { title: '传输层 network' });
    const netBox = h('div', {});
    // 传输层(network)选项 —— 切换时清除其它传输层的旧 opts(ws-opts/h2-opts/... 否则保存后会残留)
    const NET_OPTS_KEYS = ['ws-opts', 'h2-opts', 'grpc-opts', 'http-opts', 'xhttp-opts'];
    const netOptsKey = val => ({ ws: 'ws-opts', h2: 'h2-opts', grpc: 'grpc-opts', http: 'http-opts', xhttp: 'xhttp-opts' })[val] || null;
    const pruneNetOpts = (curVal) => {
      const keep = netOptsKey(curVal);
      NET_OPTS_KEYS.forEach(k => { if (k !== keep) delete target[k]; });
    };
    const syncNet = () => {
      netBox.innerHTML = '';
      if (!netSel.value) { delete target.network; pruneNetOpts(''); return; }
      target.network = netSel.value;
      pruneNetOpts(target.network);
      // http 传输层默认方法：内核要求 method 有值，缺省补 GET，避免漏填连不上
      if (target.network === 'http') {
        target['http-opts'] = target['http-opts'] || {};
        if (!target['http-opts'].method) target['http-opts'].method = 'GET';
      }
      markDirty(target);
      (NET_FIELDS[netSel.value] || []).forEach(f => netBox.append(fieldRow(boolAsPick(f), target)));
    };
    netSel.addEventListener('change', syncNet);
    const netRow = h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '传输层 network', h('div', { class: 'f-desc', text: 'ws / h2 / grpc / http / xhttp' })), h('div', { class: 'f-ctl' }, netSel));
    if (SHOW_NET.has(ptype)) syncNet();

    // TLS 段
    const tlsBox = h('div', {});
    if (SHOW_TLS.has(ptype)) TLS_FIELDS.forEach(f => tlsBox.append(fieldRow(boolAsPick(f), target)));
    if (SHOW_HYTLS.has(ptype)) HY_TLS_FIELDS.forEach(f => tlsBox.append(fieldRow(boolAsPick(f), target)));
    // TLS 开关联动 SNI：开启→未填则补默认 example.com；关闭→删除 servername/sni
    if (SHOW_TLS.has(ptype) && tlsBox.children.length >= 2) {
      const tlsCtl0 = tlsBox.children[0].querySelector('.selctl') || tlsBox.children[0].querySelector('input');
      const sniIn = tlsBox.children[1].querySelector('input');
      const applyTlsLink = (on) => {
        if (on) {
          if (!target.servername && !target.sni) { target.servername = 'example.com'; if (sniIn) { sniIn.value = 'example.com'; } markDirty(target); }
        } else {
          delete target.servername; delete target.sni; if (sniIn) sniIn.value = ''; markDirty(target);
        }
      };
      if (tlsCtl0 && tlsCtl0.classList && tlsCtl0.classList.contains('selctl')) {
        tlsCtl0.addEventListener('change', () => applyTlsLink(tlsCtl0.value === 'true'));   // 弹窗选择形态
      } else if (tlsCtl0 && tlsCtl0.type === 'checkbox') {
        tlsCtl0.addEventListener('change', () => applyTlsLink(tlsCtl0.checked));           // 旧开关形态兜底
      }
    }

    // smux + 尾字段
    const smuxBox = h('div', {});
    if (SHOW_SMUX.has(ptype)) SMUX_FIELDS.forEach(f => smuxBox.append(fieldRow(boolAsPick(f), target)));
    const tailBox = h('div', {});
    // 链式出口：改用选择项弹窗（DIRECT + 代理组 + 手动节点），排除自身避免自环
    const selfName = (nameInput.value || oldName || '').trim();
    // 与 perFields（协议专属字段）撞 path 的尾字段只保留协议专属那份——
    // direct 的 udp / ip-version，以及 openvpn / masque / trusttunnel / tailscale / zerotier
    // 的 udp 都在 PER_TYPE 里重复定义过，不去重时表单会出现两行同名选项。
    const perPaths = new Set(perFields.map(f => f.path));
    const tailFields = TAIL_FIELDS.filter(f => !perPaths.has(f.path)).map(f => (f.path === 'dialer-proxy'
      ? Object.assign({}, f, { options: outboundOptions(target['dialer-proxy']).filter(([v]) => v !== selfName) })
      : f));
    tailFields.forEach(f => tailBox.append(fieldRow(boolAsPick(f), target)));

    // 高级兜底（表单覆盖之外的任意字段）
    const SUPPORT_NET = SHOW_NET.has(ptype);
    const rootKeys = new Set(['name', 'type', 'server', 'port',
      // network 与各传输 opts 只在协议显示传输层块时归表单管；否则留给 advArea 原样往返，
      // 避免 ss+plugin 等自带 *_opts 的节点在编辑器保存一轮后被清掉
      ...(SUPPORT_NET ? ['network', ...Object.values(NET_FIELDS).flat().map(f => f.path.split('.')[0])] : []),
      ...perFields.map(f => f.path.split('.')[0]),
      ...(SHOW_TLS.has(ptype) ? TLS_FIELDS : HY_TLS_FIELDS).map(f => f.path.split('.')[0]),
      'smux', ...TAIL_FIELDS.map(f => f.path)]);
    const advArea = h('textarea', { spellcheck: false, style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px', placeholder: '表单之外的字段，如\n  global-padding: true\n  authenticated-length: true' });
    const rest = {};
    Object.keys(target).forEach(k => { if (k !== 'type' && !rootKeys.has(k)) rest[k] = target[k]; });
    if (Object.keys(rest).length) advArea.value = jsyaml.dump(rest, { lineWidth: -1 });

    // 协议：新建 = 可选（切换后表单就地重建，已填名称保留）；编辑 = 只读
    let protoNode;
    if (isNew) {
      const pSel = selectCtl(Object.keys(PROXY_TEMPLATES).map(k => [k, k]), ptype, { title: '选择协议' });
      pSel.addEventListener('change', () => {
        const t = deepClone(PROXY_TEMPLATES[pSel.value] || PROXY_TEMPLATES[Object.keys(PROXY_TEMPLATES)[0]]);
        delete t.name;
        const nm = (nameInput.value || '').trim();
        // 名称仍是上一个协议的默认名（没改过）→ 跟随新协议更新；用户改过则保留
        if (nm && nm !== ptype + '-out') t.name = nm;
        editProxySheet(idx, t, true); // openSheet 会整层替换内容，原地重建
      });
      protoNode = h('div', { class: 'f-row', style: 'margin-bottom:6px' },
        h('div', { class: 'f-label' }, '协议', h('div', { class: 'f-desc', text: '切换协议会重建表单；未改名的跟随协议更新默认名' })),
        h('div', { class: 'f-ctl', style: 'max-width:60%' }, pSel));
    } else {
      protoNode = h('div', { class: 'kv', style: 'padding:2px 0 8px' }, h('span', { class: 'k', text: '协议' }), h('span', { class: 'v', text: ptype + (known ? '' : '（非常见协议，仅基础字段+高级参数）') }));
    }

    const close = openSheet(isNew ? '新建节点' : `编辑节点 — ${oldName}`,
      nameInput,
      protoNode,
      baseBox,
      SHOW_NET.has(ptype) ? h('div', { class: 'group-title', text: '传输层' }) : null,
      SHOW_NET.has(ptype) ? netRow : null,
      SHOW_NET.has(ptype) ? netBox : null,
      tlsBox.children.length ? h('div', { class: 'group-title', text: 'TLS / Reality' }) : null,
      tlsBox,
      smuxBox.children.length ? h('div', { class: 'group-title', text: '多路复用 smux' }) : null,
      smuxBox,
      h('div', { class: 'group-title', text: '通用链式 / 拨号' }),
      tailBox,
      h('div', { class: 'group-title', text: '其他参数（YAML，可选）' }),
      h('div', { class: 'f-desc', style: 'margin-bottom:6px', text: '表单未覆盖的官方字段在此补充，保存时并入' }),
      advArea,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px;position:sticky;bottom:8px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
        h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
          const n = nameInput.value.trim();
          if (!n) { ntoast('请填写节点名'); return; }
          const adv = advArea.value.trim();
          let extra = {};
          if (adv) {
            try { extra = jsyaml.load(adv) || {}; if (typeof extra !== 'object' || Array.isArray(extra)) throw new Error('需要是键值对象'); }
            catch (e) { ntoast('其他参数 YAML 错误: ' + e.message, 3000); return; }
          }
          Object.keys(target).forEach(k => { if (k !== 'type' && !rootKeys.has(k)) delete target[k]; });
          Object.assign(target, extra);
          if (SUPPORT_NET) {
            // 选择器停在默认「tcp（默认）」也显式落字段：没写过 network 的补 network: tcp
            if (target.network === undefined && netSel.value) target.network = netSel.value;
            // 保存兜底：只保留当前传输层对应的 opts,旧传输层键(http-opts/ws-opts 等)不留残
            pruneNetOpts(target.network || '');
          }
          target.type = ptype;
          if (ptype === 'openvpn') {
            const ovpnErr = validateOpenVPN(target);
            if (ovpnErr) { ntoast(ovpnErr, 3600); return; }
          }
          // SNI 与 TLS 联动（兜底）：tls 关 → 不留 servername；tls 开且未填 → 补默认。
          // anytls 内核默认 tls 即开（不写 tls 字段也启用），不能按「!== true」判关——只认显式 false
          if (ptype === 'anytls') {
            if (target.tls === false) delete target.servername;
            else if (!target.servername && !target.sni) target.servername = 'example.com';
          } else if (SHOW_TLS.has(ptype)) {
            if (target.tls !== true) delete target.servername;
            else if (!target.servername && !target.sni) target.servername = 'example.com';
          }
          const arr = (Array.isArray(state.cfg.proxies) && state.cfg.proxies) || [];
          if (arr.some((x, xi) => x && x.name === n && xi !== idx && !(isNew && xi === arr.length))) { ntoast('已存在同名节点'); return; }
          // 重命名：同步更新所有代理组 proxies 里的引用
          let renamed = 0;
          if (!isNew && n !== oldName) {
            const groups = state.cfg['proxy-groups'];
            if (Array.isArray(groups)) groups.forEach(g => {
              if (g && Array.isArray(g.proxies)) g.proxies = g.proxies.map(x => x === oldName ? (renamed++, n) : x);
            });
          }
          // 名称固定为 YAML 第一个键（此前排在末尾，源码阅读体验差）
          const out = { name: n, type: ptype };
          Object.keys(target).forEach(k => { if (k !== 'name' && k !== 'type' && target[k] !== undefined) out[k] = target[k]; });
          if (isNew) {
            if (!commitNewOutboundProxies([out])) return;
          } else {
            arr[idx] = out;
            if (!markDirty()) return;
          }
          close(); renderProxies(el);
          if (renamed) ntoast(`✅ 已重命名，并同步更新 ${renamed} 处代理组引用`);
        } })));
  }
}

// ============================================================
// 本地源文件操作（订阅 / 规则集 file 类型共用）
// o: { label, desc, getCfgPath(), setCfgPath(p), editTitle, importTitle, newFileText, onApplied(fileName), watch: [元素] }
// ============================================================
function fileOpsCtl(o) {
  const pathInfo = h('div', { class: 'f-desc', style: 'margin-top:6px;user-select:text;word-break:break-all' });
  const cfgPath = () => (o.getCfgPath() || '').trim();
  const ioPath = () => absPath(cfgPath());
  const refresh = () => {
    const p = cfgPath();
    pathInfo.textContent = p ? (p.startsWith('/') ? p : `${p}（实际写入: ${absPath(p)}）`) : '（未设置 path，将使用自动路径）';
  };
  const applied = (fileName) => {
    o.setCfgPath(cfgPath());     // 当前弹层局部路径，随「加入待保存」统一提交
    refresh();
    o.onApplied && o.onApplied(fileName);
  };
  refresh();
  // 名称 / 路径 / 格式改动后即时刷新说明行（默认路径随名称走、扩展名随 format 走）。
  // 选择控件派发的 change 不冒泡，用捕获阶段监听；延到下一轮再读，确保字段已写回 target。
  (o.watch || []).forEach(el => el && ['input', 'change'].forEach(ev => el.addEventListener(ev, () => setTimeout(refresh, 0), true)));
  // 上传（支持 .mrs 等二进制）
  const fileInput = h('input', { type: 'file', accept: '.yaml,.yml,.txt,.json,.list,.mrs,application/yaml,text/yaml,text/plain,application/octet-stream', style: 'display:none' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { ntoast('文件过大（>8MB）', 3000); return; }
    ntoast(`正在上传 ${file.name}（${(file.size / 1024).toFixed(1)} KB）…`);
    let buf;
    try { buf = await file.arrayBuffer(); } catch (e) { ntoast('读取文件失败: ' + e.message, 3000); return; }
    const w = await writeB64(ioPath(), bufToB64(buf));
    if (w.errno === 0) { applied(file.name); ntoast(`✅ 已上传 → ${ioPath()}`); }
    else ntoast('写入失败: ' + (w.stderr || '未知'), 3500);
  });
  const uploadBtn = h('button', { class: 'btn sm', text: '⬆ 上传文件', onclick: () => pickFileWithFeedback(fileInput, uploadBtn) });
  // 在线编辑内容（嵌套弹层；任何关闭路径都回到编辑器，表单内容不丢）
  const editBtn = h('button', { class: 'btn sm', text: '✎ 编辑内容', onclick: async () => {
    if (/\.mrs$/i.test(cfgPath())) { ntoast('mrs 是二进制格式，不支持在线编辑，请用「上传文件」替换', 3500); return; }
    const stillHere = sheetGuard();
    const p = ioPath();
    const r = await readText(p);
    if (!stillHere()) return;
    const existed = !((r.stdout || '').includes('__READ_FAIL__')) && (r.stdout || '') !== '';
    const area = h('textarea', { class: 'code-area', spellcheck: false, wrap: 'off', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px;user-select:text' });
    area.value = existed ? r.stdout : (o.newFileText || '');
    const info = h('div', { class: 'f-desc', style: 'margin:6px 0 10px;word-break:break-all;user-select:text', text: `${existed ? '当前文件' : '文件不存在/为空，保存将创建'}：${p}${existed ? ' · ' + (r.stdout.length / 1024).toFixed(1) + ' KB' : ''}` });
    const close = openChildSheet(o.editTitle, info, area,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
        h('button', { class: 'btn block pri', text: '保存文件', onclick: async () => {
          const w = await writeText(p, area.value);
          if (!close.isCurrent()) return;
          if (w.errno === 0) { applied(); close(); ntoast(`✅ 已保存（${(area.value.length / 1024).toFixed(1)} KB）`); }
          else ntoast('写入失败: ' + (w.stderr || '未知'), 3500);
        } })));
  } });
  // 从设备路径导入（文件选择器不可用时的兜底）
  const importBtn = h('button', { class: 'btn sm', text: '📋 从设备路径导入', onclick: () => {
    const srcIn = h('input', { type: 'text', placeholder: '/sdcard/Download/sub.yaml', style: 'width:100%' });
    const close = openChildSheet(o.importTitle, srcIn,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
        h('button', { class: 'btn block pri', text: '复制', onclick: async () => {
          const src = srcIn.value.trim();
          if (!src) { ntoast('请填写源文件路径'); return; }
          const p = ioPath();
          const dir = p.replace(/\/[^/]*$/, '');
          const r = await shell(`mkdir -p "${dir}" && cp "${src.replace(/"/g, '')}" "${p}" && echo OK`);
          if (!close.isCurrent()) return;
          if ((r.stdout || '').includes('OK')) {
            applied(src.split('/').pop());
            close(); ntoast('✅ 已导入 → ' + p);
          } else ntoast('复制失败：源文件不存在或无权限', 3000);
        } })));
  } });
  const row = h('div', { class: 'f-row', style: 'align-items:flex-start;display:none' },
    h('div', { class: 'f-label' }, o.label, h('div', { class: 'f-desc', text: o.desc }), pathInfo),
    h('div', { class: 'f-ctl', style: 'max-width:60%;flex-wrap:wrap' }, uploadBtn, editBtn, importBtn, fileInput));
  return { row, refresh };
}

// ============================================================
// 代理集合 proxy-providers
// ============================================================
// 出站选择池：DIRECT + 代理组 + 手动节点（下载出口 / 链式出口选择用）。
// 现值不在池中时也原样列出（标「当前值」），保证已有配置可见、可保留。
function outboundOptions(cur) {
  const seen = new Set(['']);
  const opts = [];
  const add = (v, label) => { const s = String(v); if (!s || seen.has(s)) return; seen.add(s); opts.push([s, label]); };
  add('DIRECT', 'DIRECT（直连）');
  (state.cfg['proxy-groups'] || []).forEach(g => g && g.name && add(g.name, g.name));
  (state.cfg.proxies || []).forEach(p => p && p.name && add(p.name, p.name));
  if (cur !== undefined && cur !== null) add(cur, String(cur) + '（当前值）');
  return opts;
}

// 合集保存前清理：file 类型在 UI 里隐藏的远程字段（订阅链接/更新间隔/下载出口等）不落盘，
// 空的 url / path 也不落盘 —— 否则新建 file 合集会写出 url: '' / path: '' 等无意义字段。
// （mihomo 对 file 类型本来就不读这些键；健康检查等仍有意义的字段保留）
const FILE_HIDDEN_KEYS = {
  sub: ['url', 'interval', 'size-limit', 'proxy', 'age-secret-key', 'header'],
  ep: ['url', 'interval', 'proxy'],
};
function cleanProviderFields(t, kind) {
  if (String(t.type || '') === 'file') FILE_HIDDEN_KEYS[kind].forEach(k => { delete t[k]; });
  if (typeof t.url === 'string' && !t.url.trim()) delete t.url;
  if (typeof t.path === 'string' && !t.path.trim()) delete t.path;
  return t;
}

// file 类型本地文件的 path 统一写成工作目录相对路径（代理集合 ./proxies/…、规则集合 ./rules/…）：
//   · 工作目录内的完整路径（/data/adb/mihomo_box/proxies/x.yaml）改写为 ./proxies/x.yaml ——
//     打开编辑页即显示新写法，点「加入待保存」时随提交落盘；工作目录外的路径原样保留；
//   · 未填 path 时补上与「源文件」操作一致的默认路径（没有 path 的 file 类型内核读不到文件）。
// mihomo 以 -d 工作目录启动，相对路径按工作目录解析，两种写法指向同一个文件。
function relFilePath(t) {
  if (String(t.type || '') === 'file' && typeof t.path === 'string' && t.path.trim()) t.path = relPath(t.path);
  return t;
}
function normalizeFilePath(t, defaultPath) {
  if (String(t.type || '') !== 'file') return t;
  if (typeof t.path === 'string' && t.path.trim()) t.path = relPath(t.path);
  else if (t.path == null && defaultPath) t.path = defaultPath;
  return t;
}
// 默认文件名：订阅 / 规则集名去掉路径与空白等不安全字符
const safeFileStem = (name, fallback) => (String(name || '').trim() || fallback).replace(/[\\/:*?"<>|\s]+/g, '_');

export function renderSubs(el) { return renderKeepScroll(() => renderSubsCore(el)); }
function renderSubsCore(el) {
  el.innerHTML = '';
  el.append(note('远程订阅（proxy-providers），保存后会自动下载/刷新。支持 mihomo/v2b、base64、yaml 格式（format: yaml / text）。'));
  const pp = state.cfg['proxy-providers'];

  // 统一为规则集合单卡样式：单张白卡 + 右上蓝色药丸按钮 + 列表行
  const cnt = pp && typeof pp === 'object' && !Array.isArray(pp) ? Object.keys(pp).length : 0;
  const subCard = card();
  const addBtn = h('button', { class: 'btn sm pri', text: '＋ 添加订阅', onclick: () => editSubSheet('', null) });
  subCard.append(h('div', { class: 'card-head' }, h('h3', { text: `${cnt} 个代理集合` }), addBtn));
  if (!pp || typeof pp !== 'object' || Array.isArray(pp) || cnt === 0) {
    subCard.append(h('div', { class: 'empty', text: '暂无订阅，可添加远程或本地订阅' }));
    el.append(subCard);
  } else {
    Object.entries(pp).forEach(([name, cfg]) => {
      const url = cfg && cfg.url ? String(cfg.url) : '';
      const stype = (cfg && cfg.type) ? String(cfg.type) : 'http';
      const filePath = String((cfg && cfg.path) || '');
      const subTitle = stype === 'file' ? (filePath || '未设置（默认 ./proxies/ 目录）') : (url || '-');
      const intervalText = stype === 'file' ? '不适用（本地文件）' : (cfg && cfg.interval ? cfg.interval + 's' : '默认');
      subCard.append(h('div', { class: 'rule-item ep-row' },
        h('div', { class: 'ep-main' },
          h('div', { class: 'ep-title' },
            h('span', { class: 'ep-name', text: name }), badge(stype, 'b')),
          h('div', { class: 'ep-url', text: subTitle }),
          h('div', { class: 'ep-url', style: 'margin-top:1px', text: `更新间隔: ${intervalText}` })),
        h('span', { class: 'ep-acts' },
          miniBtn('✎', () => editSubSheet(name, cfg)),
          miniBtn('×', () => requestReferenceDelete('proxy-providers', name, () => renderSubs(el))))));
    });
    el.append(subCard);
  }

  // 请求头编辑器：k: v 每行一条，保存为 {k:[v]}
  function headerEditor(target) {
    const cur = (target.header && typeof target.header === 'object' && !Array.isArray(target.header)) ? target.header : {};
    const area = h('textarea', { placeholder: 'User-Agent: mihomo/1.18.3\nAuthorization: token xxxx', style: 'width:100%' });
    area.value = Object.entries(cur).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
    const commit = () => {
      const lines = area.value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!lines.length) { delete target.header; markDirty(target); return; }
      const obj = {};
      for (const line of lines) {
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (m) obj[m[1].trim()] = m[2].trim().split(',').map(s => s.trim()).filter(Boolean);
      }
      target.header = obj; markDirty(target);
    };
    area.addEventListener('change', commit);
    area.addEventListener('blur', commit);
    return h('div', { class: 'f-row', style: 'align-items:flex-start' },
      h('div', { class: 'f-label' }, '请求头 header', h('div', { class: 'f-desc', text: '如 UA / Authorization，每行一条' })),
      h('div', { class: 'f-ctl', style: 'max-width:60%' }, area));
  }

  // proxy-name 批量重命名编辑器：[{pattern,target}]
  function proxyNameEditor(target) {
    const wrap = h('div', { style: 'width:100%' });
    const get = () => {
      const v = target.override?.['proxy-name'];
      if (!Array.isArray(v)) return [];
      return v.filter(it => it && typeof it === 'object').map(it => ({ pattern: String(it.pattern ?? ''), target: String(it.target ?? '') }));
    };
    const chips = h('div', { class: 'chips' });
    const pIn = h('input', { type: 'text', placeholder: 'pattern 正则，如 IPLC-(.*?)倍', style: 'flex:1' });
    const tIn = h('input', { type: 'text', placeholder: 'target，如 iplc x $1', style: 'flex:1' });
    function commit(arr) {
      target.override = target.override || {};
      if (!arr.length) delete target.override['proxy-name'];
      else target.override['proxy-name'] = arr;
      markDirty(target);
    }
    function render() {
      chips.innerHTML = '';
      const arr = get();
      arr.forEach((it, i) => {
        const x = h('button', { class: 'x', text: '×' });
        x.onclick = () => { const a = get().slice(); a.splice(i, 1); commit(a); render(); };
        chips.append(h('span', { class: 'chip' }, h('span', { text: `${it.pattern} → ${it.target}` }), x));
      });
      if (!arr.length) chips.append(h('span', { style: 'color:var(--text-3);font-size:12.5px', text: '未设置' }));
    }
    const addBtn = h('button', { class: 'btn sm', text: '添加', onclick: () => {
      const p = pIn.value.trim(), t = tIn.value;
      if (!p) return;
      const a = get().slice(); a.push({ pattern: p, target: t });
      commit(a); pIn.value = ''; tIn.value = ''; render();
    } });
    wrap.append(chips, h('div', { class: 'addline', style: 'flex-direction:column' }, pIn, h('div', { style: 'display:flex;gap:8px' }, tIn, addBtn)));
    render();
    return h('div', { class: 'f-row', style: 'align-items:flex-start' },
      h('div', { class: 'f-label' }, 'proxy-name 批量重命名', h('div', { class: 'f-desc', text: '正则 pattern→target，支持 $1 引用' })),
      h('div', { class: 'f-ctl', style: 'max-width:60%' }, wrap));
  }

  function editSubSheet(oldName, cfg) {
    const isNew = !oldName;
    // 新建订阅不预置 health-check：「启用健康检查」默认停在「默认（不覆写）」，
    // 配置里不写这一整块，交给内核默认；用户选「开/关」时才落键。
    const cur = cfg || { type: 'http', url: '', interval: 86400, path: '' };
    const target = relFilePath(deepClone(cur));       // file 类型：工作目录内完整路径 → ./proxies/…
    const nameInput = h('input', { type: 'text', value: oldName || '', placeholder: '订阅别名（在代理组 use 中引用）', style: 'width:100%' });
    // 官方默认：proxy-providers 的本地文件放在工作目录的 proxies/ 下，写成相对路径
    const defaultSubPath = () => `./proxies/${safeFileStem(isNew ? nameInput.value : oldName, 'subscription')}.yaml`;

    const secs = [];
    const sec = (title, ...nodes) => secs.push(h('div', { class: 'group-title', text: title }), h('div', {}, nodes.flat()));

    const basic = [
      { path: 'type', label: '类型', type: 'select', options: [['http','http 远程下载'],['file','file 本地文件'],['inline','inline 内联节点']] },
      { path: 'url', label: '订阅链接', type: 'text', desc: 'http 类型必填' },
      { path: 'path', label: '保存路径', type: 'text', optional: true, placeholder: '默认 ./proxies/ 目录' },
      { path: 'interval', label: '自动更新间隔(秒)', type: 'number', optional: true },
      { path: 'size-limit', label: '订阅大小限制(字节)', type: 'number', optional: true, desc: '0 为不限制' },
      { path: 'proxy', label: '下载出口', type: 'select', allowEmpty: true, emptyLabel: '默认（不覆写）', options: outboundOptions(cur.proxy), desc: '下载订阅使用的出口' },
      { path: 'age-secret-key', label: 'AGE 解密密钥', type: 'text', optional: true, desc: '加密订阅内容自动解密', tag: '新版', tagCls: 'b' },
    ];
    const basicBox = h('div', {});

    const payloadArea = h('textarea', { placeholder: '- name: 节点名\n  type: ss\n  server: 1.2.3.4\n  port: 8388\n  cipher: aes-256-gcm\n  password: xxx', style: 'width:100%' });
    if (Array.isArray(target.payload)) payloadArea.value = jsyaml.dump(target.payload, { lineWidth: -1 });
    payloadArea.onchange = () => {
      const v = payloadArea.value.trim();
      if (!v) { delete target.payload; markDirty(target); return; }
      try { target.payload = jsyaml.load(v) || []; markDirty(target); } catch (e) { ntoast('payload YAML 错误: ' + e.message, 3000); }
    };
    const payloadRow = h('div', { class: 'f-row', style: 'align-items:flex-start;display:none' },
      h('div', { class: 'f-label' }, '内联节点 payload', h('div', { class: 'f-desc', text: 'inline 类型使用，YAML 节点数组' })),
      h('div', { class: 'f-ctl', style: 'max-width:60%' }, payloadArea));
    basicBox.append(payloadRow);

    // ---- file 类型：上传 / 在线编辑 / 从设备路径导入订阅源文件 ----
    const fileOps = fileOpsCtl({
      label: '订阅源文件', desc: 'file 类型：上传/在线编辑本地节点文件',
      getCfgPath: () => relPath(String(target.path || '')) || defaultSubPath(),
      setCfgPath: (p) => {
        target.path = p;
        const pathIn = basicBox.children[2] && basicBox.children[2].querySelector('input');
        if (pathIn) pathIn.value = p;
      },
      watch: [nameInput, basicBox],
      editTitle: `编辑订阅文件 — ${oldName || '新订阅'}`,
      importTitle: '从设备路径复制为订阅文件',
      newFileText: '# 新建订阅文件（YAML 节点列表）\nproxies:\n  # - name: 节点1\n  #   type: ss\n  #   server: 1.2.3.4\n',
    });
    const fileOpsRow = fileOps.row;
    basicBox.append(fileOpsRow);

    // type 变化时显示/隐藏 payload / 文件操作。锚点替换值后行会重绘，
    // 控件引用一律现查（旧节点引用会失效）
    const hdrWrap = h('div', {});
    const httpOnlyIdx = [1, 3, 4, 5, 6]; // 订阅链接 / 自动更新 / 大小限制 / 下载出口 / AGE —— file 类型无意义，隐藏
    const syncPayload = () => {
      const ts = basicBox.querySelector('.selctl');
      const t = ts ? ts.value : String(target.type || '');
      payloadRow.style.display = t === 'inline' ? '' : 'none';
      fileOpsRow.style.display = t === 'file' ? '' : 'none';
      httpOnlyIdx.forEach(ci => { const r = basicBox.children[ci]; if (r) r.style.display = t === 'file' ? 'none' : ''; });
      hdrWrap.style.display = t === 'file' ? 'none' : '';
    };
    // 基础行可重绘：选中锚点替换值后按新 target 重建（payloadRow/fileOpsRow 位置与索引不变）
    const renderBasicRows = () => {
      while (basicBox.firstChild && basicBox.firstChild !== payloadRow) basicBox.firstChild.remove();
      basic.forEach(f => basicBox.insertBefore(fieldRow(boolAsPick(f), target), payloadRow));
      const ts = basicBox.querySelector('.selctl');
      if (ts) ts.addEventListener('change', syncPayload);
      syncPayload();
    };
    renderBasicRows();

    sec('基础', nameInput, basicBox);
    const reqBox = h('div', {});
    const renderReq = () => {
      reqBox.innerHTML = '';
      hdrWrap.innerHTML = ''; hdrWrap.append(headerEditor(target));
      reqBox.append(hdrWrap,
        fieldRow({ path: 'filter', label: '筛选节点 filter', type: 'text', optional: true, placeholder: '(?i)港|hk|hongkong', desc: '筛选满足关键词或正则表达式的节点' }, target),
        fieldRow({ path: 'exclude-filter', label: '排除节点 exclude-filter', type: 'text', optional: true, desc: '排除匹配的节点' }, target),
        fieldRow({ path: 'exclude-type', label: '排除协议类型', type: 'list', optional: true, join: '|', datalist: () => EXCLUDE_TYPE_OPTIONS, pickTitle: '选择协议类型', desc: '按类型排除节点；无视大小写' }, target));
      syncPayload();
    };
    renderReq();
    sec('请求 / 过滤', reqBox);
    // ---- 健康检查 ----
    // 「启用健康检查」选回「默认（不覆写）」= 整块 health-check 从配置里删掉
    //（连同 url / interval / timeout / lazy / expected-status），而不是只删 enable 一个键
    // 留下一堆孤儿子键；删完就地重绘，下面的子字段随之清空。
    const hcBox = h('div', {});
    // 开启健康检查时自动填入的官方默认值
    const HC_DEFAULTS = { url: 'https://cp.cloudflare.com/generate_204', interval: 300 };
    const HC_SUB = [
      { path: 'health-check.url', label: '测速 URL', type: 'text', optional: true },
      { path: 'health-check.interval', label: '测速间隔(秒)', type: 'number', optional: true },
      { path: 'health-check.timeout', label: '测速超时(ms)', type: 'number', optional: true },
      { path: 'health-check.lazy', label: '懒加载', type: 'bool', optional: true },
      { path: 'health-check.expected-status', label: '期望状态码', type: 'text', optional: true, placeholder: '204 或 2xx' },
    ];
    function renderHc() {
      hcBox.textContent = '';
      const hcv = get(target, 'health-check.enable');
      const enSel = selectCtl([['', '默认（不覆写）'], ['true', '开'], ['false', '关']],
        (hcv === undefined || hcv === null) ? '' : String(!!hcv), { title: '启用健康检查' });
      enSel.addEventListener('change', () => {
        const v = enSel.value;
        if (v === '') { unset(target, 'health-check'); markDirty(target); renderHc(); return; }
        const on = v === 'true';
        set(target, 'health-check.enable', on);
        // 开启时自动补官方默认值（仅补缺失项，已有值不动）：没有 url mihomo 不会真正测速
        // 静默填入，不弹提示：界面上子字段会直接显示出来
        if (on) {
          for (const [k, dv] of [['url', HC_DEFAULTS.url], ['interval', HC_DEFAULTS.interval]]) {
            const cv = get(target, 'health-check.' + k);
            if (cv === undefined || cv === null || cv === '') set(target, 'health-check.' + k, dv);
          }
        }
        renderHc();
      });
      hcBox.append(h('div', { class: 'f-row' },
        h('div', { class: 'f-label' }, '启用健康检查',
          h('div', { class: 'f-desc', text: '选「默认（不覆写）」将删除整个 health-check 配置块' })),
        h('div', { class: 'f-ctl' }, enSel)));
      HC_SUB.forEach(f => hcBox.append(fieldRow(boolAsPick(f), target)));
    }
    renderHc();
    sec('健康检查', hcBox);

    // ===== 覆写 override（官方全字段 + override-expr） =====
    const ovBox = h('div', {});
    // 可重绘：选中锚点替换值后按新 target 重建；dialer-proxy 选项按当前值现算
    const renderOv = () => {
      ovBox.innerHTML = '';
      [
        { path: 'override.additional-prefix', label: '节点名前缀', type: 'text', optional: true, placeholder: '[机场名] ' },
        { path: 'override.additional-suffix', label: '节点名后缀', type: 'text', optional: true },
        { path: 'override.tfo', label: 'TFO (TCP Fast Open)', type: 'bool', optional: true },
        { path: 'override.mptcp', label: 'MPTCP', type: 'bool', optional: true },
        { path: 'override.udp', label: 'UDP', type: 'bool', optional: true },
        { path: 'override.udp-over-tcp', label: 'UDP over TCP (UoT)', type: 'bool', optional: true },
        { path: 'override.up', label: '上行带宽', type: 'text', optional: true, placeholder: '10 Mbps' },
        { path: 'override.down', label: '下行带宽', type: 'text', optional: true, placeholder: '50 Mbps' },
        { path: 'override.skip-cert-verify', label: '跳过证书校验', type: 'bool', optional: true },
        { path: 'override.name-cert-verify', label: '证书 DNSName 校验目标', type: 'text', optional: true, desc: '不改 SNI，只改校验对象' },
        { path: 'override.dialer-proxy', label: '链式出口 dialer-proxy', type: 'select', allowEmpty: true, emptyLabel: '默认（不覆写）', options: outboundOptions(get(target, 'override.dialer-proxy')), desc: '订阅内全部节点经此出口建立连接' },
        { path: 'override.interface-name', label: '绑定出口网卡', type: 'text', optional: true },
        { path: 'override.routing-mark', label: '路由标记 routing-mark', type: 'number', optional: true },
        { path: 'override.ip-version', label: 'IP 版本偏好', type: 'select', allowEmpty: true, options: [['dual','dual'],['ipv4','ipv4'],['ipv6','ipv6'],['ipv4-prefer','ipv4-prefer'],['ipv6-prefer','ipv6-prefer']] },
      ].forEach(f => ovBox.append(fieldRow(boolAsPick(f), target)));
      ovBox.append(proxyNameEditor(target));
    };
    renderOv();
    sec('覆写 override（对该订阅全部节点生效）', ovBox);

    // override-expr 编辑器（可视化 ⇄ 文本；新建 = 点按钮开可视化弹层，无裸内容框）
    const exprBox = h('div', {});
    const exprHint = h('div', { class: 'note', style: 'margin-bottom:8px', html:
      `yq v4 风格子集，逐条顺序执行，作用于单个节点。<br>` +
      `可视化新建/编辑：赋值（可选 select 条件 + 字段路径 + 值）/ 删除字段；超出范围的形态自动降级文本模式。<br>` +
      `支持路径赋值 = / |= / del() / select 等。详见 <a href="https://wiki.metacubex.one/config/proxy-providers/#override" target="_blank">文档</a>` });
    const exprItems = () => {
      // 宽容读取：数组 / 单条标量 / 锚点引用的字符串（块标量 |）都规范化成字符串数组
      const v = target.override?.['override-expr'];
      if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : (x == null ? '' : String(x))).filter(s2 => s2 !== '');
      if (typeof v === 'string' && v.trim()) return [v];
      if (v != null && v !== '') return [String(v)];
      return [];
    };
    const exprWrap = h('div', { style: 'width:100%' });
    const commitExpr = (arr) => {
      target.override = target.override || {};
      if (!arr.length) delete target.override['override-expr'];
      else target.override['override-expr'] = arr;
      markDirty(target);
    };
    // ---- 表达式可视化解析/生成（只认两种形态：[select|]路径 操作符 值 / del(路径)，其余降级文本） ----
    const exprVizParse = (line) => {
      const s2 = String(line || '').trim();
      const dm = s2.match(/^del\(\s*(\.[\s\S]*?)\s*\)$/);
      if (dm) return { kind: 'del', path: dm[1].trim() };
      const am = s2.match(/^(\(select\(([\s\S]*)\) \| )?([^\s=(]+)\s*(\|=|=)\s*([\s\S]+)$/);
      if (am && am[3]) {
        // 路径字符集允许 ')'：select 形态下会把包裹括号的右括号吃进来，剥掉它
        let path = am[3];
        if (am[1] && path.endsWith(')')) path = path.slice(0, -1);
        return { kind: 'set', select: am[2] ? am[2].trim() : '', path, op: am[4], value: am[5].trim() };
      }
      return null;
    };
    const exprVizBuild = (f) => {
      const p2 = (f.path || '').trim();
      if (f.kind === 'del') return p2 ? `del(${p2})` : null;
      const v2 = (f.value || '').trim();
      if (!p2 || !v2) return null;
      const sel2 = (f.select || '').trim();
      return sel2 ? `(select(${sel2}) | ${p2}) ${f.op} ${v2}` : `${p2} ${f.op} ${v2}`;
    };
    const PATH_PH = '.name / .tls / .["ws-opts"].headers.Host';
    // ---- 单条表达式弹层：可视化（赋值/删除字段 + 实时预览）⇄ 文本；idx<0 = 新建 ----
    const exprSheet = (idx) => {
      const cur = idx >= 0 ? (exprItems()[idx] || '') : '';
      // 新建 = 空表单（默认可视化）；编辑既有 = 先解析，形态不符才降级纯文本
      const pv = idx < 0 ? { kind: 'set', select: '', path: '', op: '=', value: '' } : exprVizParse(cur);
      const ta = h('textarea', { style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
      ta.value = cur;
      let kind = pv ? pv.kind : 'set';
      const mkIn = (val, ph) => h('input', { type: 'text', value: val, placeholder: ph, style: 'width:100%', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
      const selIn = mkIn(pv && pv.kind === 'set' ? pv.select : '', '.port == 443（可选，留空 = 对全部节点）');
      const pathIn = mkIn(pv ? pv.path : '', (pv && pv.kind === 'del') ? '.skip-cert-verify' : PATH_PH);
      const opSel = selectCtl([['=', '= 赋值'], ['|=', '|= 追加/合并']], (pv && pv.kind === 'set' && pv.op) ? pv.op : '=', { title: '操作符' });
      const valIn = mkIn(pv && pv.kind === 'set' ? pv.value : '', 'true / "文本" / 443 / .name / "[前缀] " + .name');
      const selRow = h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '条件 select（可选）'), h('div', { class: 'f-ctl', style: 'width:100%' }, selIn));
      const pathRow = h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '字段路径'), h('div', { class: 'f-ctl', style: 'width:100%' }, pathIn));
      const opRow = h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '操作符'), h('div', { class: 'f-ctl' }, opSel));
      const valRow = h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '值'), h('div', { class: 'f-ctl', style: 'width:100%' }, valIn));
      const prev = h('pre', { class: 'logbox', style: 'max-height:150px;margin:0', text: '' });
      const readFields = () => ({ kind, select: selIn.value, path: pathIn.value, op: opSel.value, value: valIn.value });
      const syncPrev = () => {
        const f = readFields();
        const p3 = (f.path || '').trim();
        if (p3 && !/^\./.test(p3)) { prev.textContent = '⚠ 字段路径须以 . 开头'; return; }
        const built = exprVizBuild(f);
        prev.textContent = built || '⚠ 内容不完整：' + (f.kind === 'del' ? '请填写字段路径' : '请填写字段路径和值');
      };
      const applyKind = () => {
        const isDel = kind === 'del';
        selRow.hidden = isDel; opRow.hidden = isDel; valRow.hidden = isDel;
        pathIn.placeholder = isDel ? '.skip-cert-verify' : PATH_PH;
        syncPrev();
      };
      const kindSeg = segCtl([['set', '赋值'], ['del', '删除字段']], kind, (v) => { kind = v; applyKind(); });
      [selIn, pathIn, valIn].forEach(x => x.addEventListener('input', syncPrev));
      opSel.addEventListener('change', syncPrev);
      const vWrap = h('div', { style: 'margin-top:12px' },
        h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '操作类型'), h('div', { class: 'f-ctl' }, kindSeg)),
        selRow, pathRow, opRow, valRow,
        h('div', { class: 'f-desc', style: 'margin:4px 0' }, '生成的表达式：'), prev);
      applyKind();
      const tBox = h('div', { style: 'margin-top:12px' }, h('div', { class: 'f-desc', style: 'margin:0 0 4px' }, '表达式原文（高级形态直接改这里）：'), ta);
      let mode = 'visual';
      const setSegment = (ctl, index) => Array.from(ctl.children).forEach((b, i) => b.classList.toggle('on', i === index));
      const seg = pv ? segCtl([['visual', '可视化'], ['text', '文本']], 'visual', (v) => {
        if (v === mode) return;
        if (v === 'text') {
          ta.value = exprVizBuild(readFields());
        } else {
          const parsed = ta.value.trim() ? exprVizParse(ta.value.trim()) : { kind: 'set', path: '', select: '', value: '', op: '=' };
          if (!parsed) { setSegment(seg, 1); ntoast('当前文本超出可视化范围，请继续用文本编辑；内容未改动', 3600); return; }
          kind = parsed.kind;
          pathIn.value = parsed.path || ''; selIn.value = parsed.select || '';
          opSel.value = parsed.op || '='; valIn.value = parsed.value || '';
          setSegment(kindSeg, kind === 'del' ? 1 : 0); applyKind();
        }
        mode = v; vWrap.hidden = v !== 'visual'; tBox.hidden = v !== 'text';
      }) : null;
      // 初始显示状态：可视化模式隐藏文本区，纯文本模式隐藏可视化区（否则弹层打开时文本框裸露）
      if (seg) tBox.hidden = true; else { vWrap.hidden = true; tBox.hidden = false; }
      const close = openChildSheet(
        idx >= 0 ? `编辑表达式 #${idx + 1}` : '新建表达式',
        pv ? null : h('div', { class: 'note', style: 'margin-bottom:8px', text: '该表达式形态超出可视化范围（链式 // 等高级语法），请直接用文本编辑。' }),
        seg, vWrap, tBox,
        h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
          h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
          h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
            let v3;
            if (pv && !vWrap.hidden) {
              v3 = exprVizBuild(readFields());
              if (!v3) { ntoast(String(prev.textContent).replace(/^⚠\s*/, ''), 3200); return; }
            } else {
              v3 = ta.value.trim();
              if (!v3) { ntoast('表达式不能为空（可用 × 删除该条）'); return; }
            }
            const a = [...exprItems()]; if (idx < 0) a.push(v3); else a[idx] = v3;
            const candidate = deepClone(target);
            set(candidate, 'override.override-expr', a);
            // 与外层共用完整校验/提交；名字/URL/内联 YAML 无效时留在编辑器，不偷偷提交半成品。
            const n = commitSubEditor(candidate);
            if (!n) return;
            close(); editSubSheet(n, state.cfg['proxy-providers'][n]);
          } })));
    };
    const renderExpr = () => {
      exprWrap.innerHTML = '';
      const arr = exprItems();
      const miniBtn = (t, fn, disabled = false) => { const b = h('button', { class: 'mini-btn', text: t, onclick: fn }); if (disabled) b.style.opacity = .35; return b; };
      arr.forEach((ex, i) => {
        const code = h('code', { text: ex, style: 'font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;user-select:text;cursor:pointer' });
        code.title = '点击可视化编辑';
        code.onclick = () => exprSheet(i);
        exprWrap.append(h('div', { class: 'rule-item' },
          h('div', { style: 'flex:1;min-width:0' }, code),
          miniBtn('✎', () => exprSheet(i)),
          miniBtn('×', () => { const a = exprItems().slice(); a.splice(i, 1); commitExpr(a); renderExpr(); })));
      });
      if (!arr.length) exprWrap.append(h('div', { class: 'empty', text: '未设置表达式（点「＋ 添加表达式」可视化新建，或点上方快捷按钮填入）' }));
    };
    const exprAdd = h('button', { class: 'btn sm pri', text: '＋ 添加表达式', onclick: () => exprSheet(-1) });
    // 常用表达式快捷按钮：点击即填入（自动去重，不覆盖已有内容）
    const EXPR_PRESETS = [
      ['前缀改名', ['.name = "[机场] " + .name']],
      ['后缀改名', ['.name = .name + " | 专线"']],
      ['开启 UDP', ['.udp = true']],
      ['删除跳过证书校验', ['del(.skip-cert-verify)']],
      ['仅保留 TLS', ['(select(.port == 443) | .tls) = true']],
      ['混淆覆写', [
        '.servername = "填免流混淆"',
        '.sni = .servername',
        '(select(.network == "ws") | .["ws-opts"].headers.Host) = .servername',
        '(select(.network == "http") | .["http-opts"].headers.Host) = [.servername]',
        '(select(.network == "h2") | .["h2-opts"].headers.Host) = [.servername]',
        '(select(.network == "xhttp") | .["xhttp-opts"].headers.Host) = .servername',
      ]],
    ];
    const presetBox = h('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin:10px 0' });
    presetBox.append(h('div', { class: 'f-desc', style: 'width:100%', text: '常用表达式（点击填入，可继续编辑/删除）：' }));
    EXPR_PRESETS.forEach(([label, exprs]) => {
      presetBox.append(h('button', { class: 'btn sm', text: label, onclick: () => {
        const a = exprItems().slice();
        let added = 0;
        exprs.forEach(e => { if (!a.includes(e)) { a.push(e); added++; } });
        commitExpr(a); renderExpr();
        ntoast(added ? `已填入 ${added} 条表达式` : '这些表达式已在列表中');
      } }));
    });
    renderExpr(); // 初始渲染已有表达式（此前漏调用，导致配置里的 override-expr 显示不出来）
    exprBox.append(exprHint, presetBox, exprWrap, h('div', { style: 'margin-top:8px' }, exprAdd));
    sec('override-expr（按表达式批量修改节点 · 新版）', exprBox);
    // 选中继承/字段锚点后值框立即替换为锚点参数值：写进 target 再重绘各分区。
    // 替换后字段与锚点同值，保存时被收敛逻辑从源码删除；替换后再改动的字段为本地覆写。
    const refreshProviderForm = (changed) => {
      renderBasicRows();
      if (changed && Object.prototype.hasOwnProperty.call(changed, 'payload')) {
        payloadArea.value = Array.isArray(target.payload) ? jsyaml.dump(target.payload, { lineWidth: -1 }) : '';
      }
      renderReq();
      renderHc();
      renderOv();
      renderExpr();
      markDirty(target);
    };
    const anch = anchorSection('proxy-providers', oldName, 'map', {
      applyValues(vals) {
        Object.keys(vals).forEach(k => { target[k] = deepClone(vals[k]); });
        refreshProviderForm(vals);
      },
      applyFieldValue(key, val) {
        target[key] = deepClone(val);
        const changed = {}; changed[key] = val;
        refreshProviderForm(changed);
      },
    });
    sec('YAML 锚点', ...anch.nodes);

    function commitSubEditor(candidate = target) {
      candidate = deepClone(candidate);
      const n = nameInput.value.trim();
      if (!n) { ntoast('请填写订阅别名'); return; }
      if (candidate.type === 'inline') {
        try {
          const txt = payloadArea.value.trim();
          const parsed = txt ? jsyaml.load(txt) : [];
          if (!Array.isArray(parsed) || parsed.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new Error('需要节点对象数组（每个节点用 - 开头）');
          candidate.payload = parsed;
        } catch (e) { ntoast('内联节点 payload 有误，未加入待保存：' + ((e && e.message) || e), 4200); return null; }
      }
      const av = anch.validate(n, () => candidate); if (av.error) { ntoast(av.error); return; }
      if (candidate.type === 'http' && !String(candidate.url || '').trim()) { ntoast('http 类型需要订阅链接'); return; }
      cleanProviderFields(candidate, 'sub');
      normalizeFilePath(candidate, defaultSubPath());
      let renamed = 0;
      if (av.changed) av.op.expand = deepClone(candidate);
      if (!commitConfigEdit(cfg => {
        const pp2 = cfg['proxy-providers'] = (typeof cfg['proxy-providers'] === 'object' && cfg['proxy-providers'] && !Array.isArray(cfg['proxy-providers'])) ? cfg['proxy-providers'] : {};
        if ((isNew || n !== oldName) && pp2[n]) { ntoast('别名已存在'); return false; }
        if (!isNew && n !== oldName) {
          // 重命名：同步代理组 use 引用，并保持键在映射中的原位置
          const groups = cfg['proxy-groups'];
          if (Array.isArray(groups)) groups.forEach(g => {
            if (g && Array.isArray(g.use)) g.use = g.use.map(u => u === oldName ? (renamed++, n) : u);
          });
          const out = {};
          Object.keys(pp2).forEach(k => { out[k === oldName ? n : k] = (k === oldName ? candidate : pp2[k]); });
          cfg['proxy-providers'] = out;
        } else {
          pp2[n] = candidate;
        }
      }, av.changed ? [av.op] : [])) return;
      renderSubs(el);
      if (renamed) ntoast(`✅ 已重命名，并同步更新 ${renamed} 处代理组 use 引用`);
      return n;
    }

    const saveBtn = h('div', { style: 'display:flex;gap:10px;margin-top:16px;position:sticky;bottom:8px' },
      h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
      h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
        if (commitSubEditor()) close();
      } }));
    closeSheet();
    const close = openSheet(isNew ? '添加订阅（全字段）' : `编辑订阅 — ${oldName}`, ...secs, saveBtn);
  }
}

// ============================================================
// 代理组 proxy-groups
// ============================================================
// exclude-type 可选值（官方 constant/adapters.go，无视大小写）
const EXCLUDE_TYPE_OPTIONS = ['Shadowsocks', 'ShadowsocksR', 'Snell', 'Socks5', 'Http', 'Vmess', 'Vless', 'Trojan', 'Hysteria', 'Hysteria2', 'WireGuard', 'Tuic', 'Ssh', 'Mieru', 'AnyTLS', 'ShadowQuic', 'OpenVPN', 'Tailscale', 'ZeroTier', 'Sudoku', 'Masque', 'TrustTunnel', 'GostRelay'];

const GROUP_TYPES = [
  ['select', 'select 手动选择'],
  ['url-test', 'url-test 自动测速'],
  ['fallback', 'fallback 自动回退'],
  ['load-balance', 'load-balance 负载均衡'],
  ['smart', 'smart 智能(Smart内核)'],
  ['relay', 'relay 链式'],
];

// ---- YAML 锚点选择（订阅合集 / 代理组 / 规则集合编辑器共用） ----
// 一级=条目键行 <<: *name 合并继承；二级=条目内子字段的 <<: 合并 / *整体引用。
// &定义 动作已全部下线（一级、二级都不再新挂/改名）；各级的 &定义/改名/摘除
// 统一去「工具 → 锚点可视化」管理（新建锚点/改名级联/零引用删除/编辑定义块）。
// 锚点语法保留在 raw；「加入待保存」经 commitConfigEdit 立即手术并对齐模型/源码，
// 不再到保存时才处理继承或 *引用。
// formApi（可选）：{ applyValues(obj), applyFieldValue(key, val) } —— 选中锚点后
// 把锚点定义值立即替换进编辑器值框的回调，由各编辑器提供（替换后保存时这些
// 字段与锚点同值，会被 applyAnchorOps 的收敛逻辑从源码里删掉，避免冗余残留）。
function anchorSection(topKey, oldName, kind, formApi) {
  const info = entryAnchorInfo(state.raw, topKey, oldName || '', kind);
  const scan = scanYamlAnchors(state.raw);
  const anchorNames = [...new Set([...scan.defs.keys()].filter(n => n !== info.anchor))];
  const mergeSel = selectCtl(
    [['', '(不继承)']].concat(anchorNames.map(n => [n, n])),
    info.merges.length === 1 ? info.merges[0] : '',
    { title: '选择要继承的锚点' });
  if (info.merges.length > 1) mergeSel.disabled = true;
  // 选中继承锚点 → 值框立即替换为锚点里的参数值（映射锚点才有 << 合并意义；
  // seq 条目的 name 是身份键不替换）。替换后再手动改动的字段保存为本地覆写。
  mergeSel.addEventListener('change', () => {
    const v = mergeSel.value;
    if (!v || !formApi || typeof formApi.applyValues !== 'function') return;
    const aval = anchorDefValue(state.raw, v);
    if (!aval || typeof aval !== 'object' || Array.isArray(aval)) return;
    const skip = kind === 'seq' ? ['name'] : [];
    const vals = {};
    Object.keys(aval).forEach(k => { if (!skip.includes(k)) vals[k] = aval[k]; });
    formApi.applyValues(vals);
  });
  const nodes = [
    h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, '继承锚点 <<:',
        h('div', { class: 'f-desc', text: '选中后本条目合并该锚点字段作为默认，值框立即替换为锚点参数值；替换后再改动的字段保存为本地覆写' })),
      h('div', { class: 'f-ctl' }, mergeSel)),
  ];
  if (info.anchor) nodes.push(h('div', { class: 'note', style: 'margin-top:2px', text: `本条目已带 &${info.anchor} 定义；定义锚点动作已下线，改名/摘除请去「工具 → 锚点可视化」` }));
  if (info.merges.length > 1) nodes.push(h('div', { class: 'note', style: 'margin-top:2px', text: `本条目有 ${info.merges.length} 个合并来源（${info.merges.map(m => '*' + m).join('、')}），为不破坏原结构已锁定此处继承编辑；如需调整请在配置文本里改` }));
  // ---- 二级（字段级）：继承 << / 整体引用 *（&定义 已下线） ----
  const fieldStates = entryFieldAnchors(state.raw, topKey, oldName || '', kind);
  const knownFieldsByTop = {
    'proxy-providers': ['type', 'url', 'interval', 'proxy', 'path', 'header', 'format', 'health-check', 'override', 'filter', 'exclude-filter', 'exclude-type'],
    'proxy-groups': ['name', 'type', 'proxies', 'use', 'url', 'interval', 'timeout', 'tolerance', 'lazy', 'expected-status', 'max-failed-times', 'hidden', 'icon', 'filter', 'exclude-filter', 'exclude-type', 'strategy', 'disable-udp', 'interface-name', 'routing-mark'],
    'rule-providers': ['type', 'behavior', 'url', 'path', 'interval', 'proxy', 'header', 'format'],
  };
  const candidateKeys = knownFieldsByTop[topKey] || ['type', 'url', 'interval', 'proxy', 'path', 'health-check', 'override', 'filter'];
  candidateKeys.forEach(k => {
    if (!fieldStates.some(f => f.key === k)) {
      fieldStates.push({ key: k, anchor: null, aliasRef: null, merges: [], multi: false });
    }
  });
  const order = knownFieldsByTop[topKey] || [];
  fieldStates.sort((a, b) => {
    const ra = order.indexOf(a.key) >= 0 ? order.indexOf(a.key) : 999;
    const rb = order.indexOf(b.key) >= 0 ? order.indexOf(b.key) : 999;
    return ra - rb;
  });
  const rules = [];
  fieldStates.forEach(f => {
    if (f.multi) rules.push({ key: f.key, mode: 'merge', value: f.merges[0] || '', locked: true });
    else {
      if (f.anchor) rules.push({ key: f.key, mode: 'def', value: f.anchor, oldDef: f.anchor, fromText: true });
      if (f.merges.length === 1) rules.push({ key: f.key, mode: 'merge', value: f.merges[0], oldMerge: f.merges[0], fromText: true });
      if (f.aliasRef) rules.push({ key: f.key, mode: 'alias', value: f.aliasRef, oldAlias: f.aliasRef, fromText: true });
    }
  });
  const fKeySel = selectCtl(fieldStates.length
    ? [['', '(选择字段)']].concat(fieldStates.map(f => [f.key, f.key + (f.anchor ? ` &${f.anchor}` : '') + (f.merges.length ? ` «${f.merges.join('+')}»` : '') + (f.aliasRef ? ` *${f.aliasRef}` : '')]))
    : [['', '(条目内没有可操作的本地子字段)']], '', { title: '选择字段' });
  // 字段级 &定义 动作已下线：只保留 继承 <<: / 整体引用 *；存量 &定义 只能经 chip 的 × 摘除
  const fModeSel = selectCtl([['merge', '继承合并 <<:'], ['alias', '整体字段引用 *']], 'merge', { title: '选择动作' });
  const fMergeSel = selectCtl([['', '(不继承)']].concat(anchorNames.map(n => [n, n])), '', { title: '字段合并继承' });
  const fAliasSel = selectCtl([['', '(恢复为本地值)']].concat(anchorNames.map(n => [n, n])), '', { title: '字段整体引用' });
  const fValBox = h('div', {}, fMergeSel);
  const syncValCtl = () => { fValBox.innerHTML = ''; fValBox.append(fModeSel.value === 'alias' ? fAliasSel : fMergeSel); };
  const fChips = h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px' });
  const MODE_LAB = { def: '定义 &', merge: '继承 <<: *', alias: '引用 *' };
  const renderChips = () => {
    fChips.innerHTML = '';
    if (!rules.length) fChips.append(h('span', { style: 'color:var(--text-3);font-size:12px', text: '未设置字段级锚点' }));
    rules.forEach((r, ri) => {
      const valLab = r.value ? (r.mode === 'def' ? '&' + r.value : r.mode === 'merge' ? '*' + r.value : '*' + r.value) : (r.mode === 'merge' ? '(不继承)' : '(恢复本地值)');
      const kids = [h('span', { text: `${r.key} · ${MODE_LAB[r.mode]}${valLab}${r.locked ? '（多来源锁定）' : ''}` })];
      if (!r.locked) kids.push(h('button', { class: 'x', text: '×', onclick: () => {
        if (r.fromText) r.value = ''; else rules.splice(ri, 1);
        if (fKeySel.value === r.key) {
          if (r.mode === 'merge') fMergeSel.value = '';
          if (r.mode === 'alias') fAliasSel.value = '';
        }
        renderChips();
      } }));
      fChips.append(h('span', { class: 'chip' }, ...kids));
    });
  };
  renderChips();

  const syncCtlFromField = () => {
    const fk = fKeySel.value;
    if (!fk) {
      fMergeSel.value = '';
      fAliasSel.value = '';
      return;
    }
    const r = rules.find(x => x.key === fk && !x.locked);
    if (r) {
      if (r.mode === 'alias') {
        fModeSel.value = 'alias';
        syncValCtl();
        fAliasSel.value = r.value || '';
      } else {
        fModeSel.value = 'merge';
        syncValCtl();
        fMergeSel.value = r.value || '';
      }
    } else {
      fMergeSel.value = '';
      fAliasSel.value = '';
    }
  };

  const applyFieldRule = () => {
    const fk = fKeySel.value;
    const mode = fModeSel.value;
    const val = mode === 'alias' ? fAliasSel.value : fMergeSel.value;
    if (!fk) {
      if (val) {
        ntoast('请先选择要继承/引用的字段');
        if (mode === 'alias') fAliasSel.value = ''; else fMergeSel.value = '';
      }
      return;
    }
    const f0 = fieldStates.find(f => f.key === fk);
    const existingIdx = rules.findIndex(r => r.key === fk && !r.locked);
    if (val) {
      if (existingIdx >= 0) {
        rules[existingIdx].mode = mode;
        rules[existingIdx].value = val;
      } else {
        const rule = { key: fk, mode, value: val, fromText: false };
        if (mode === 'merge') rule.oldMerge = (f0 && f0.merges.length === 1 ? f0.merges[0] : '');
        if (mode === 'alias') rule.oldAlias = (f0 && f0.aliasRef) || '';
        rules.push(rule);
      }
    } else {
      if (existingIdx >= 0) {
        if (rules[existingIdx].fromText) {
          rules[existingIdx].value = '';
        } else {
          rules.splice(existingIdx, 1);
        }
      }
    }
    renderChips();
    // 选中字段级锚点后，该字段的值框立即替换为锚点内容：
    // merge（<<）要求锚点值是映射；整体引用（*）任意值都行（标量/数组/映射）
    if (val && formApi && typeof formApi.applyFieldValue === 'function') {
      const aval = anchorDefValue(state.raw, val);
      if (aval !== undefined && (mode === 'alias' || (aval && typeof aval === 'object' && !Array.isArray(aval)))) {
        formApi.applyFieldValue(fk, aval);
      }
    }
  };

  fKeySel.addEventListener('change', syncCtlFromField);
  fModeSel.addEventListener('change', () => {
    syncValCtl();
    const fk = fKeySel.value;
    if (fk) {
      const r = rules.find(x => x.key === fk && !x.locked);
      if (r && r.mode === fModeSel.value) {
        if (fModeSel.value === 'alias') fAliasSel.value = r.value || '';
        else fMergeSel.value = r.value || '';
      } else {
        if (fModeSel.value === 'alias') fAliasSel.value = '';
        else fMergeSel.value = '';
      }
    }
  });
  fMergeSel.addEventListener('change', applyFieldRule);
  fAliasSel.addEventListener('change', applyFieldRule);

  nodes.push(h('div', { class: 'f-row', style: 'align-items:flex-start' },
      h('div', { class: 'f-label' }, '二级锚点（字段级）',
        h('div', { class: 'f-desc', text: '选择字段与继承锚点后自动添加，该字段值框立即替换为锚点内容；支持 << 合并继承与 * 整体引用；字段级 &定义 已下线，存量定义点 × 摘除' })),
    h('div', { class: 'f-ctl', style: 'max-width:60%' }, fChips,
      h('div', { class: 'addline' }, fKeySel, fModeSel), fValBox)));

  return {
    nodes,
    validate(newName, getFinal) {
      // 一级 &定义 动作已下线：本编辑器只产出 继承换绑(merge) 与 字段级(fieldOps) 改动
      let mergeChg = false; let mergeVal;
      if (!mergeSel.disabled) {
        const want = mergeSel.value;
        const have = info.merges.length === 1 ? info.merges[0] : '';
        if (info.merges.length <= 1 && want !== have) { mergeChg = true; mergeVal = want || null; }
      }
      const fieldOps = [];
      const defUsed = new Set();
      for (const r of rules) {
        if (r.locked) continue;
        const v = String(r.value || '').trim();
        if (r.mode === 'def') {
          if (v && !/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(v)) return { error: `字段「${r.key}」锚点名不合法` };
          if (v && v !== r.oldDef && (scan.defs.has(v) || defUsed.has(v))) return { error: `字段锚点名 &${v} 已被占用` };
          if (!v && r.oldDef) { const rc = scan.refs.get(r.oldDef) || 0; if (rc > 0) return { error: `字段锚点 &${r.oldDef} 还被 ${rc} 处引用，无法直接清除` }; }
          if ((v || null) === (r.oldDef || null)) continue;
          if (v) defUsed.add(v);
          fieldOps.push({ key: r.key, defAnchor: v || null, oldDef: r.oldDef || null });
        } else if (r.mode === 'merge') {
          if (v === (r.oldMerge || '')) continue;
          const fo = { key: r.key, merge: v || null };
          if (getFinal) { try { const fv = getFinal()[r.key]; if (fv && typeof fv === 'object') fo.expand = JSON.parse(JSON.stringify(fv)); } catch (e) { /* 快照失败不物化，核心守卫兜底 */ } }
          fieldOps.push(fo);
        } else {
          if (v === (r.oldAlias || '')) continue;
          const fo = { key: r.key, aliasRef: v || null };
          if (getFinal) { try { const fv = getFinal()[r.key]; if (fv !== undefined) fo.expand = fv === null ? null : JSON.parse(JSON.stringify(fv)); } catch (e) { /* ignore */ } }
          fieldOps.push(fo);
        }
      }
      if (!mergeChg && !fieldOps.length) return { changed: false };
      const op = { top: topKey, kind, key: String(newName || '').trim() };
      if (mergeChg) op.merge = mergeVal;
      if (fieldOps.length) op.fieldOps = fieldOps;
      return { changed: true, op };
    },
  };
}

export function renderGroups(el) { return renderKeepScroll(() => renderGroupsCore(el)); }
function renderGroupsCore(el) {
  el.innerHTML = '';
  el.append(note('代理组决定流量去向。类型说明：<b>smart</b>＝Smart 内核专属智能权重选择；其余为标准类型。'));
  const groups = Array.isArray(state.cfg['proxy-groups']) && state.cfg['proxy-groups'] ? state.cfg['proxy-groups'] : [];

  const gCard = card();
  const quickBtn = h('button', { class: 'btn sm pri', text: '＋ 新建代理组', onclick: () => {
    const t = 'select';
    const g = {
      name: '手动选择',
      type: t,
      proxies: ['DIRECT'],
      use: [],
      url: 'https://cp.cloudflare.com/generate_204',
      interval: 300,
      timeout: 5000,
      lazy: true,
    };
    editGroupSheet(groups.length, g, true);
  } });
  gCard.append(h('div', { class: 'card-head' }, h('h3', { text: `${groups.length} 个代理组` }), quickBtn));
  if (!groups.length) { gCard.append(h('div', { class: 'empty', text: '暂无代理组' })); }
  else {
    groups.forEach((g, i) => {
      const memberCnt = (g.proxies || []).length + (g.use || []).length;
      gCard.append(h('div', { class: 'rule-item ep-row' },
        h('span', { class: 'drag-handle', title: '拖动排序', html: '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><circle cx="5" cy="3" r="1.25"/><circle cx="5" cy="8" r="1.25"/><circle cx="5" cy="13" r="1.25"/><circle cx="11" cy="3" r="1.25"/><circle cx="11" cy="8" r="1.25"/><circle cx="11" cy="13" r="1.25"/></svg>' }),
        h('div', { class: 'ep-main' },
          h('div', { class: 'ep-title' },
            h('span', { class: 'ep-name', text: g.name || '(未命名)' }), badge(g.type || '?', g.type === 'smart' ? 'p' : 'b')),
          h('div', { class: 'ep-url', text: `${memberCnt} 个成员${(g.use || []).length ? ' · 含订阅' : ''} · ${g.type || '?'}` })),
        h('span', { class: 'ep-acts' },
          miniBtn('✎', () => editGroupSheet(i, g, false)),
          miniBtn('×', () => requestReferenceDelete('proxy-groups', g.name, () => renderGroups(el))))));
    });
    if (groups.length > 1) enableDragSort(gCard, '.rule-item', (from, to) => {
      const [moved] = groups.splice(from, 1);
      groups.splice(to, 0, moved);
      markDirty();
      renderGroups(el);
    });
  }
  el.append(gCard);

  function editGroupSheet(idx, group, isNew) {
    const target = deepClone(group);
    const oldName = isNew ? '' : group.name;
    const nameInput = h('input', { type: 'text', value: oldName || target.name || '', placeholder: '代理组名（唯一）', style: 'width:100%' });
    target.name = undefined; // 名字单独处理

    // 类型支持「默认（不覆写）」：源码里没有本地 type 行（经 <<: *锚点 纯继承或未写入）时，
    // 选择器默认停在「不覆写」，保存保持现状——不把继承值固化成本地 type 字段；
    // 已有本地行时选「不覆写」＝撤销本地覆写（删行回落锚点继承/内核默认）。
    const inheritedType = isNew ? undefined : target.type;          // cfg 是展开视图：纯继承条目这里也有生效值
    const presetType = isNew ? (target.type || 'select') : undefined; // 快捷新建预置的类型
    const typeLocal = !isNew && entryHasLocalField(state.raw, 'proxy-groups', oldName, 'seq', 'type');
    const typeWrap = selectCtl([['', '默认（不覆写）']].concat(GROUP_TYPES),
      isNew || typeLocal ? (target.type || 'select') : '', { title: '代理组类型' });
    // 「不覆写」时的生效类型（继承值/预置值）：只用于按类型显隐字段与快照，不回写本地 type
    const effType = () => typeWrap.value || inheritedType || presetType || 'select';
    const smartBox = h('div', {});
    const buildSmartFields = (box) => {
      box.innerHTML = '';
      [
        { path: 'uselightgbm', label: '使用 LightGBM 预测权重', type: 'bool', optional: true },
        { path: 'collectdata', label: '采样数据统计', type: 'bool', optional: true },
        { path: 'sample-rate', label: '采样率 (0~1)', type: 'number', optional: true, placeholder: '默认 1' },
        { path: 'prefer-asn', label: 'ASN 粒度权重', type: 'bool', optional: true, desc: '按目标 ASN 训练/选择' },
        { path: 'tolerance', label: '切换容差(ms)', type: 'number', optional: true, desc: '延迟差小于该值不切换' },
      ].forEach(f => box.append(fieldRow(boolAsPick(f), target)));
      const ppf = fieldRow({ path: 'policy-priority', label: '节点权重策略', type: 'text', optional: true, placeholder: '如 Premium:0.9;SG:1.3', desc: '<1 降权 >1 加权，正则/串匹配' }, target);
      box.append(ppf);
    };
    const commonBox = h('div', {});
    const strategyBox = h('div', {});
    const strategyWrap = h('div', {}, h('div', { class: 'group-title', text: '负载均衡策略' }), strategyBox);
    const buildCommon = () => {
      commonBox.innerHTML = '';
      strategyBox.innerHTML = '';
      const t = effType();   // 「不覆写」时按继承/预置的生效类型显隐字段
      const isHealth = ['url-test','fallback','load-balance','smart'].includes(t);
      const isLoadBalance = t === 'load-balance';
      const isUrlTestLike = t === 'url-test' || t === 'smart';
      // 1) 自动包含与过滤（始终展示，select 也可用）
      [
        { path: 'include-all', label: '包含全部 (代理+订阅)', type: 'bool', optional: true, desc: '自动包含全部 proxies 和 providers（按名称排序）' },
        { path: 'include-all-proxies', label: '包含全部代理', type: 'bool', optional: true, desc: '仅包含全部 proxies' },
        { path: 'include-all-providers', label: '包含全部订阅', type: 'bool', optional: true, desc: '仅包含全部 providers' },
        { path: 'filter', label: '节点名称过滤(正则)', type: 'text', optional: true, placeholder: '如 (?i)港|hk|hongkong', desc: '仅对 include-all/use 引入的节点生效，多正则用 ` 分隔' },
        { path: 'exclude-filter', label: '排除节点(正则)', type: 'text', optional: true, desc: '排除匹配的节点' },
        { path: 'exclude-type', label: '排除节点类型', type: 'list', optional: true, join: '|', datalist: () => EXCLUDE_TYPE_OPTIONS, pickTitle: '选择节点类型', desc: '按类型排除，仅对 proxies 引入生效，无视大小写' },
      ].forEach(f => commonBox.append(fieldRow(boolAsPick(f), target)));
      // 2) 健康检查（url-test/fallback/load-balance/smart）
      if (isHealth) {
        const healthFields = [
          { path: 'url', label: '测速 URL', type: 'text', optional: true, placeholder: 'https://www.gstatic.com/generate_204', desc: 'url-test/fallback/load-balance 必填' },
          { path: 'interval', label: '测速间隔(秒)', type: 'number', optional: true, placeholder: '300' },
          { path: 'timeout', label: '测速超时(ms)', type: 'number', optional: true, placeholder: '5000' },
          { path: 'lazy', label: '懒加载', type: 'bool', optional: true, desc: '未被选中时不测速（默认 true）' },
          { path: 'max-failed-times', label: '最大失败次数', type: 'number', optional: true, placeholder: '5', desc: '超过则强制健康检查' },
          { path: 'expected-status', label: '期望状态码', type: 'text', optional: true, placeholder: '204 或 2xx 或 200/302/400-503', desc: '支持 / - 组合，默认 *' },
        ];
        // tolerance 仅 url-test/smart 有意义， fallback/load-balance 保留已存在的以便清理
        if (isUrlTestLike) {
          healthFields.splice(4, 0, { path: 'tolerance', label: '容差(ms)', type: 'number', optional: true, placeholder: '50', desc: '仅 url-test/smart：新节点快于当前多少才切换' });
        } else if (target.tolerance !== undefined) {
          healthFields.splice(4, 0, { path: 'tolerance', label: '容差(ms)', type: 'number', optional: true, desc: '当前类型一般不需要，可删除' });
        }
        healthFields.forEach(f => commonBox.append(fieldRow(boolAsPick(f), target)));
      }
      // 3) 负载均衡策略
      if (isLoadBalance) {
        strategyBox.append(fieldRow({ path: 'strategy', label: '负载策略', type: 'select', allowEmpty: true, options: [['consistent-hashing','consistent-hashing（一致性哈希）'],['round-robin','round-robin（轮询）'],['sticky-sessions','sticky-sessions（粘性会话）']], desc: 'load-balance 专属，默认 consistent-hashing' }, target));
      }
      strategyWrap.hidden = !isLoadBalance;
      // 4) 默认选择 / 空组回退（取值都是内置策略或组内成员，之前编辑器里完全没有，
      //    用户配置里写了 empty-fallback: PASS 也看不见、改不了）
      if (t === 'select') {
        const dsCur = target['default-selected'];
        const dsOpts = [];
        const dsSeen = new Set();
        [...(Array.isArray(target.proxies) ? target.proxies : []), ...(dsCur ? [dsCur] : [])]
          .forEach(v => { const k = String(v); if (k && !dsSeen.has(k)) { dsSeen.add(k); dsOpts.push([k, k]); } });
        commonBox.append(fieldRow({ path: 'default-selected', label: '默认选中', type: 'select', allowEmpty: true,
          options: dsOpts, desc: '组的默认选择项；留空或填了不存在的名字则用第一个成员' }, target));
      }
      {
        const efCur = target['empty-fallback'];
        const efOpts = BUILTIN_POLICIES.map(([v, d]) => [v, `${v}（${d}）`]);
        // 官方说明：empty-fallback 只接受 proxy 名称，不支持代理组；现值不在清单里也要列出来，免得一保存就丢
        if (efCur && !efOpts.some(([v]) => v === String(efCur))) efOpts.unshift([String(efCur), `${efCur}（当前值）`]);
        commonBox.append(fieldRow({ path: 'empty-fallback', label: '空组回退', type: 'select', allowEmpty: true,
          options: efOpts, desc: '组内一个可用节点都没有时走哪条内置策略，默认 COMPATIBLE' }, target));
      }
      // 5) 其他通用
      [
        { path: 'disable-udp', label: '禁用 UDP', type: 'bool', optional: true, desc: '该组禁用 UDP 转发' },
        { path: 'interface-name', label: '绑定出口网卡', type: 'text', optional: true, placeholder: '如 en0 / eth0', desc: '已废弃，建议在节点上配置；优先级 节点>组>全局' },
        { path: 'routing-mark', label: '路由标记', type: 'number', optional: true, desc: '已废弃，建议在节点上配置' },
        { path: 'hidden', label: '隐藏代理组', type: 'bool', optional: true, desc: '在仪表盘隐藏' },
        { path: 'icon', label: '图标 URL', type: 'text', optional: true, placeholder: 'https://...', desc: '仪表盘显示图标' },
      ].forEach(f => commonBox.append(fieldRow(boolAsPick(f), target)));
    };
    buildCommon();
    buildSmartFields(smartBox);
    const smartWrap = h('div', { style: 'border-top:.5px solid var(--sep)' }, h('div', { class: 'group-title', text: 'Smart 专属参数', id: 'smart-fields-title' }), smartBox);

    // 成员编辑器
    // 成员池 = 全部内置策略（DIRECT / REJECT / REJECT-DROP / PASS / PASS-RULE / COMPATIBLE）+ 代理组 + 节点。
    // 内置策略带说明，PASS 这类「看名字猜不出作用」的选项才不会没人敢用。
    // 排除自身：组把自己当成员会自环，内核直接报错。
    const poolForProxies = () => policyOptions({ exclude: [target.name || oldName] });
    const proxiesSpec = { path: 'proxies', label: '成员(顺序生效)', type: 'list', optional: true, datalist: poolForProxies, pickTitle: '选择成员', emptyText: '（空则不写入 proxies 字段）' };
    const useSpec = { path: 'use', label: '使用订阅(use)', type: 'list', optional: true, datalist: () => Object.keys(state.cfg['proxy-providers'] || {}), pickTitle: '选择订阅', emptyText: '（不使用订阅）' };
    // 列表控件包一层容器：锚点替换值后能按新 target 整只重绘
    const proxiesField = h('div', {}, listEditor(proxiesSpec, target));
    const useField = h('div', {}, listEditor(useSpec, target));
    const refreshLists = () => {
      proxiesField.innerHTML = ''; proxiesField.append(listEditor(proxiesSpec, target));
      useField.innerHTML = ''; useField.append(listEditor(useSpec, target));
    };

    typeWrap.addEventListener('change', () => { target.type = effType(); smartWrap.style.display = effType() === 'smart' ? '' : 'none'; buildCommon(); });
    smartWrap.style.display = (effType() === 'smart') ? '' : 'none';

    // 选中继承/字段锚点后值框立即替换为锚点参数值：写进 target 再就地重绘全部控件。
    // 替换后这些字段与锚点同值，保存时被 applyAnchorOps 收敛删除（不再残留冗余本地行）；
    // 替换后再手动改动的字段照常保存为本地覆写。
    const refreshAfterAnchor = () => {
      smartWrap.style.display = effType() === 'smart' ? '' : 'none';
      buildCommon();
      buildSmartFields(smartBox);
      refreshLists();
      markDirty(target);
    };
    const anchorSectionRef = anchorSection('proxy-groups', isNew ? '' : (group && group.name), 'seq', {
      applyValues(vals) {
        Object.keys(vals).forEach(k => { target[k] = deepClone(vals[k]); });
        if (Object.prototype.hasOwnProperty.call(vals, 'type')) typeWrap.value = String(vals.type);
        refreshAfterAnchor();
      },
      applyFieldValue(key, val) {
        target[key] = deepClone(val);
        if (key === 'type' && typeof val === 'string') typeWrap.value = val;
        refreshAfterAnchor();
      },
    });
    const close = openSheet(isNew ? '新建代理组' : `编辑代理组 — ${oldName}`,
      nameInput,
      h('div', { class: 'f-row' },
        h('div', { class: 'f-label' }, '类型',
          (!isNew && !typeLocal) ? h('div', { class: 'f-desc', text: inheritedType !== undefined
            ? `源码无本地 type 字段，生效值「${inheritedType}」来自锚点继承；保持「不覆写」保存后维持现状`
            : '源码无本地 type 字段；保持「不覆写」保存后不写入 type' }) : null),
        h('div', { class: 'f-ctl' }, typeWrap)),
      h('div', { class: 'group-title', text: '成员' }),
      proxiesField, useField,
      h('div', { class: 'group-title', text: '通用参数（按类型自动显示）' }), commonBox,
      strategyWrap,
      smartWrap,
      h('div', { style: 'border-top:.5px solid var(--sep)' }, h('div', { class: 'group-title', text: 'YAML 锚点' })),
      ...anchorSectionRef.nodes,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
        h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
          const n = nameInput.value.trim();
          if (!n) { ntoast('请填写代理组名'); return; }
          const av = anchorSectionRef.validate(n, () => target); if (av.error) { ntoast(av.error); return; } // out 由 target 重建；快照取 target 避开 TDZ
          let renamed = 0;
          if (!commitConfigEdit(cfg => {
            const arr = cfg['proxy-groups'] = (Array.isArray(cfg['proxy-groups']) && cfg['proxy-groups']) || [];
            if (arr.some((x, xi) => x && x.name === n && xi !== idx && !(isNew && xi === arr.length))) { ntoast('已存在同名代理组'); return false; }
            // 成员留空时删除 proxies 字段（空数组不落盘，保持 YAML 简洁）
            if (Array.isArray(target.proxies) && target.proxies.length === 0) delete target.proxies;
            if (Array.isArray(target.use) && target.use.length === 0) delete target.use;
            delete target['undefined'];
            // 重命名：同步其它代理组 proxies 引用 + rules/sub-rules 尾部策略
            if (!isNew && n !== oldName) {
              arr.forEach((g2, gi) => { if (gi !== idx && g2 && Array.isArray(g2.proxies)) g2.proxies = g2.proxies.map(x => x === oldName ? (renamed++, n) : x); });
              const fixRule = (r) => {
                const parts = String(r).split(',');
                if (parts.length < 2) return r;
                let pi = parts.length - 1;
                if (parts[pi].trim() === 'no-resolve') pi -= 1;
                if (pi >= 1 && parts[pi].trim() === oldName) { renamed++; parts[pi] = n; return parts.join(','); }
                return r;
              };
              if (Array.isArray(cfg.rules)) cfg.rules = cfg.rules.map(fixRule);
              const sr = cfg['sub-rules'];
              if (sr && typeof sr === 'object' && !Array.isArray(sr)) Object.keys(sr).forEach(k => { if (Array.isArray(sr[k])) sr[k] = sr[k].map(fixRule); });
            }
            // 名称固定为 YAML 第一个键；type 按「不覆写」语义写入：
            //   显式选了类型 → 写本地 type（对纯继承条目即本地覆写）；
            //   已有本地行且选「不覆写」→ 省略 type，由手术层删除本地行（回落锚点继承/内核默认）；
            //   从无本地行 → 保持现状：纯继承沿用展开值提交（语义零变更，源码不动），
            //   新组选「不覆写」则不写 type（交由 <<: *锚点 继承）。
            const out = { name: n };
            const tSel = typeWrap.value;
            if (tSel !== '') out.type = tSel;
            else if (!isNew && !typeLocal && inheritedType !== undefined) out.type = inheritedType;
            Object.keys(target).forEach(k => { if (k !== 'name' && k !== 'type' && target[k] !== undefined) out[k] = target[k]; });
            if (isNew) arr.push(out); else arr[idx] = out;
            if (av.changed) av.op.expand = deepClone(out);
          }, av.changed ? [av.op] : [])) return;
          close(); renderGroups(el);
          if (renamed) ntoast(`✅ 已重命名，并同步更新 ${renamed} 处引用（代理组/规则）`);
        } }),
      ));
  }
}

// ============================================================
// 分流规则 rules / rule-providers / sub-rules
// ============================================================
const RULE_TYPES = ['DOMAIN','DOMAIN-SUFFIX','DOMAIN-KEYWORD','DOMAIN-REGEX','DOMAIN-WILDCARD','GEOSITE','GEOIP','IP-CIDR','IP-CIDR6','IP-SUFFIX','IP-ASN','SRC-GEOIP','SRC-IP-ASN','SRC-IP-CIDR','SRC-IP-SUFFIX','DST-PORT','SRC-PORT','IN-PORT','IN-TYPE','IN-USER','IN-NAME','REMATCH-NAME','PROCESS-NAME','PROCESS-NAME-REGEX','PROCESS-NAME-WILDCARD','PROCESS-PATH','PROCESS-PATH-REGEX','PROCESS-PATH-WILDCARD','UID','NETWORK','DSCP','RULE-SET','AND','OR','NOT','SUB-RULE','MATCH'];

export function renderRules(el) { renderRulesPage(el); }
export function renderRulesPage(el) { return renderKeepScroll(() => renderRulesPageCore(el)); }
function renderRulesPageCore(el) {
  el.innerHTML = '';
  el.append(note('规则自上而下匹配，越靠上优先级越高，最后请放 MATCH 兜底。'));

  // ------- 规则列表（统一为规则集合单卡样式） -------
  const rules = Array.isArray(state.cfg.rules) && state.cfg.rules ? state.cfg.rules : [];
  const c = card();
  const addBtn = h('button', { class: 'btn sm pri', text: '＋ 添加规则', onclick: () => addRuleSheet() });
  c.append(h('div', { class: 'card-head' }, h('h3', { text: `${rules.length} 个路由规则` }), addBtn));
  if (!rules.length) { c.append(h('div', { class: 'empty', text: '暂无规则，点击右上角添加' })); }
  else {
    rules.forEach((r, i) => {
      c.append(h('div', { class: 'rule-item ep-row rule-row' },
        h('span', { class: 'drag-handle', title: '拖动排序', html: '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><circle cx="5" cy="3" r="1.25"/><circle cx="5" cy="8" r="1.25"/><circle cx="5" cy="13" r="1.25"/><circle cx="11" cy="3" r="1.25"/><circle cx="11" cy="8" r="1.25"/><circle cx="11" cy="13" r="1.25"/></svg>' }),
        h('span', { class: 'rule-no', text: String(i + 1) }),
        h('code', { text: String(r) }),
        h('span', { class: 'ep-acts' },
          miniBtn('✎', () => editRuleSheet(i, r)),
          miniBtn('×', () => { rules.splice(i, 1); setRules(rules); renderRulesPage(el); }))));
    });
    if (rules.length > 1) enableDragSort(c, '.rule-item', (from, to) => {
      const [moved] = rules.splice(from, 1);
      rules.splice(to, 0, moved);
      setRules(rules);
      renderRulesPage(el);
    });
  }
  el.append(c);
  function addRuleSheet() {
    // 复用可视化编辑器，新建一条空规则（类型默认选中列表第一项，与选择器初始高亮一致）
    const cur = { type: RULE_TYPES[0], value: '', policy: (policyNames()[0] || 'DIRECT'), noResolve: false };
    const typeSel = selectCtl(RULE_TYPES.map(v => [v, v]), cur.type, { title: '规则类型' });
    const isMultiAdd = ['AND','OR','NOT','SUB-RULE'].includes(cur.type);
    const valInput = isMultiAdd
      ? h('textarea', { style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px', spellcheck: false, placeholder: '多参数组合，如 (DOMAIN-REGEX,(whos.tv)|(shlii.io)),(DST-PORT,446)' })
      : h('input', { type: 'text', value: '', placeholder: '匹配值，如 example.com / 1.1.1.0/24 / cn', style: 'width:100%' });
    const valCtlHolder = h('div', { style: 'width:100%' }, valInput);
    const policySel = selectCtl(policyNames().map(v => [v, v]), cur.policy || 'DIRECT', { title: '目标策略' });
    const pols = policyNames(); if (cur.policy && !pols.includes(cur.policy)) pols.unshift(cur.policy);
    policySel.setOptions(pols.map(v => [v, v])); policySel.value = cur.policy || pols[0] || 'DIRECT';
    const nrCb = h('input', { type: 'checkbox', checked: false });
    const nrRow = h('div', { class: 'f-row', style: '' },
      h('div', { class: 'f-label' }, 'no-resolve', h('div', { class: 'f-desc', text: '仅 IP 类规则有效，跳过 DNS 解析' })),
      h('div', { class: 'f-ctl' }, h('label', { class: 'switch' }, nrCb, h('span', { class: 'tr' }), h('span', { class: 'th' }))));
    const valRow = h('div', { class: 'f-row', style: 'align-items:flex-start' },
      h('div', { class: 'f-label' }, '匹配值', h('div', { class: 'f-desc', text: 'MATCH 类型无需填写；AND/OR/NOT 支持多参数组合' })),
      h('div', { class: 'f-ctl', style: 'max-width:60%' }, valCtlHolder));
    const typeRow = h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '规则类型'), h('div', { class: 'f-ctl' }, typeSel));
    const policyRow = h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '目标策略', h('div', { class: 'f-desc', text: 'DIRECT / REJECT / 代理组' })), h('div', { class: 'f-ctl' }, policySel));
    const hintFor2 = (tp) => ({'DOMAIN':'完整域名，如 www.google.com','DOMAIN-SUFFIX':'域名后缀，如 google.com','DOMAIN-KEYWORD':'域名关键词','DOMAIN-REGEX':'正则','DOMAIN-WILDCARD':'通配','GEOSITE':'geosite 类别','GEOIP':'国家码','IP-CIDR':'IPv4 段','IP-CIDR6':'IPv6 段','IP-SUFFIX':'IP 后缀','IP-ASN':'ASN','SRC-GEOIP':'源 GeoIP','SRC-IP-ASN':'源 ASN','SRC-IP-CIDR':'源 IP 段','SRC-IP-SUFFIX':'源 IP 后缀','DST-PORT':'目标端口','SRC-PORT':'源端口','IN-PORT':'入站端口','IN-TYPE':'入站类型','IN-USER':'入站用户','IN-NAME':'入站名称','REMATCH-NAME':'Rematch','PROCESS-NAME':'进程名','PROCESS-NAME-REGEX':'进程名正则','PROCESS-NAME-WILDCARD':'进程名通配','PROCESS-PATH':'进程路径','PROCESS-PATH-REGEX':'路径正则','PROCESS-PATH-WILDCARD':'路径通配','UID':'用户 ID','NETWORK':'TCP / UDP','DSCP':'DSCP','RULE-SET':'规则集名称','SUB-RULE':'子规则','AND':'逻辑与','OR':'逻辑或','NOT':'逻辑非','MATCH':'兜底规则'}[tp]||'匹配值');
    const syncVis2 = () => {
      const tp=typeSel.value; const isMatch=tp==='MATCH'; valRow.style.display=isMatch?'none':''; 
      const curIn = valCtlHolder.firstChild;
      if (curIn) curIn.placeholder=hintFor2(tp);
      nrRow.style.display=isMatch?'none':''; if(isMatch && curIn) curIn.value='';
      const needMulti = ['AND','OR','NOT','SUB-RULE'].includes(tp);
      const isNowMulti = curIn && curIn.tagName === 'TEXTAREA';
      if (needMulti !== isNowMulti) {
        const newEl = needMulti
          ? h('textarea', { style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px', spellcheck: false, placeholder: hintFor2(tp) })
          : h('input', { type: 'text', placeholder: hintFor2(tp), style: 'width:100%' });
        newEl.value = curIn ? curIn.value : '';
        newEl.addEventListener('input', updatePreview2);
        valCtlHolder.innerHTML=''; valCtlHolder.append(newEl);
      }
    };
    typeSel.addEventListener('change', syncVis2); syncVis2();
    const preview2 = h('div', { class: 'note', style: 'margin-top:12px;word-break:break-all' });
    const updatePreview2 = () => { const tp=typeSel.value; const curIn = valCtlHolder.firstChild; const v=curIn ? curIn.value.trim() : ''; const p=policySel.value; let line=tp; if(tp!=='MATCH') line+=','+(v||'<值>'); line+=','+(p||'<策略>'); if(nrCb.checked && tp!=='MATCH') line+=',no-resolve'; preview2.textContent='预览：'+line; };
    valCtlHolder.firstChild.addEventListener('input', updatePreview2); policySel.addEventListener('change', updatePreview2); nrCb.addEventListener('change', updatePreview2); typeSel.addEventListener('change', updatePreview2); updatePreview2();
    const rawInput2 = h('textarea', { style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px;display:none;margin-top:12px;background:var(--fill);border:none;border-radius:12px;padding:12px', spellcheck: false });
    rawInput2.value = 'DOMAIN,example.com,DIRECT';
    const buildLine2 = () => { const tp = typeSel.value; const el2 = valCtlHolder.firstChild; const v = el2 ? el2.value.trim() : ''; const p = policySel.value; let line = tp; if (tp !== 'MATCH') line += ',' + v; if (p) line += ',' + p; if (nrCb.checked && tp !== 'MATCH') line += ',no-resolve'; return line; };
    let isRaw2=false;
    const toggleBtn2 = h('button', { class: 'btn sm', style: 'margin-top:12px', text: '切换为文本编辑', onclick: () => { isRaw2=!isRaw2;
      if (isRaw2) rawInput2.value = buildLine2(); else syncVisFromText(rawInput2.value, typeSel, valCtlHolder, policySel, nrCb, syncVis2, updatePreview2);
      rawInput2.style.display=isRaw2?'':'none'; [typeRow,valRow,policyRow,nrRow,preview2].forEach(el=> el.style.display=isRaw2?'none':(el===valRow && typeSel.value==='MATCH'?'none':(el===nrRow && typeSel.value==='MATCH'?'none':''))); toggleBtn2.textContent=isRaw2?'切换为可视化编辑':'切换为文本编辑'; }});
    const close2 = openSheet('添加规则 — 可视化', typeRow, valRow, policyRow, nrRow, preview2, toggleBtn2, rawInput2,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => close2() }),
        h('button', { class: 'btn block pri', text: '添加', onclick: () => {
          let line; if(isRaw2){ line=rawInput2.value.trim(); if(!line){ ntoast('规则不能为空'); return; } } else { const tp=typeSel.value; const curIn2 = valCtlHolder.firstChild; const v=curIn2 ? curIn2.value.trim() : ''; const p=policySel.value; if(tp!=='MATCH' && !v){ ntoast('请填写匹配值'); return; } if(!p){ ntoast('请选择目标策略'); return; } line=tp; if(tp!=='MATCH') line+=','+v; line+=','+p; if(nrCb.checked && tp!=='MATCH') line+=',no-resolve'; }
          rules.push(line); setRules(rules); close2(); renderRulesPage(el);
        } })));
  }

  function setRules(arr) {
    if (!arr.length && state.cfg.rules) unset(state.cfg, 'rules');
    else set(state.cfg, 'rules', arr);
  }
  // 文本态 → 可视化回填：解析规则行，写回类型/匹配值/策略/no-resolve，并刷新行内控件形态
  function syncVisFromText(rawText, typeSel, valCtlHolder, policySel, nrCb, syncFn, updateFn) {
    const txt = String(rawText || '').trim();
    if (!txt) { syncFn(); if (updateFn) updateFn(); return; }
    const c2 = parseRule(txt);
    if (RULE_TYPES.includes(c2.type)) typeSel.value = c2.type;
    const curIn = valCtlHolder.firstChild;
    if (curIn && c2.type !== 'MATCH') curIn.value = c2.value || '';
    if (c2.policy) {
      const pl = policyNames();
      if (!pl.includes(c2.policy)) pl.unshift(c2.policy);
      policySel.setOptions(pl.map(v => [v, v]));
      policySel.value = c2.policy;
    }
    nrCb.checked = !!c2.noResolve;
    syncFn(); // 单行/多行输入框形态、placeholder、MATCH 隐藏逻辑随新类型刷新（值由 curIn 已写入并随替换携带）
    if (updateFn) updateFn();
  }
  function parseRule(str) {
    const raw = String(str).trim();
    let s = raw;
    let noResolve = false;
    if (/,\s*no-resolve\s*$/i.test(s)) {
      noResolve = true;
      s = s.replace(/,\s*no-resolve\s*$/i, '');
    }
    const firstComma = s.indexOf(',');
    if (firstComma === -1) {
      const rt = s.trim().toUpperCase();
      return { type: RULE_TYPES.includes(rt) ? rt : s.trim() || 'DOMAIN-SUFFIX', value: '', policy: '', noResolve };
    }
    const rawType = s.slice(0, firstComma).trim().toUpperCase();
    const type = RULE_TYPES.includes(rawType) ? rawType : s.slice(0, firstComma).trim();
    const rest = s.slice(firstComma + 1);
    if (type === 'MATCH') {
      return { type: 'MATCH', value: '', policy: rest.trim(), noResolve: false };
    }
    const lastComma = rest.lastIndexOf(',');
    if (lastComma === -1) {
      return { type: type || 'DOMAIN-SUFFIX', value: rest.trim(), policy: '', noResolve };
    }
    const value = rest.slice(0, lastComma).trim();
    const policy = rest.slice(lastComma + 1).trim();
    return { type: type || 'DOMAIN-SUFFIX', value, policy, noResolve };
  }
  function isIpRule(type) { return type.startsWith('IP-') || type.startsWith('SRC-IP-') || ['GEOIP','SRC-GEOIP','IP-ASN','SRC-IP-ASN','RULE-SET'].includes(type); }
  function editRuleSheet(i, r) {
    const cur = parseRule(r);
    const typeSel = selectCtl(RULE_TYPES.map(v => [v, v]), cur.type, { title: '规则类型' });
    const isMulti = ['AND','OR','NOT','SUB-RULE'].includes(cur.type);
    const valInput = isMulti
      ? h('textarea', { style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px', spellcheck: false, placeholder: '多参数组合，如 (DOMAIN-REGEX,(whos.tv)|(shlii.io)),(DST-PORT,446) 或 ((NETWORK,UDP),(DST-PORT,443))' })
      : h('input', { type: 'text', value: cur.value, placeholder: '匹配值，如 example.com / 1.1.1.0/24 / cn', style: 'width:100%' });
    if (isMulti) valInput.value = cur.value;
    // 切换类型时动态替换输入框形态
    const valCtlHolder = h('div', { style: 'width:100%' }, valInput);
    const policySel = selectCtl(policyNames().map(v => [v, v]), cur.policy || 'DIRECT', { title: '目标策略' });
    // 刷新策略池，保留当前值
    const keepPol = cur.policy;
    const pols = policyNames();
    if (keepPol && !pols.includes(keepPol)) pols.unshift(keepPol);
    policySel.setOptions(pols.map(v => [v, v]));
    policySel.value = keepPol || pols[0] || 'DIRECT';

    const nrCb = h('input', { type: 'checkbox', checked: !!cur.noResolve });
    const nrRow = h('div', { class: 'f-row', style: cur.type === 'MATCH' ? 'display:none' : '' },
      h('div', { class: 'f-label' }, 'no-resolve', h('div', { class: 'f-desc', text: '仅 IP 类规则有效，跳过 DNS 解析' })),
      h('div', { class: 'f-ctl' }, h('label', { class: 'switch' }, nrCb, h('span', { class: 'tr' }), h('span', { class: 'th' }))));

    const valRow = h('div', { class: 'f-row', style: 'align-items:flex-start' },
      h('div', { class: 'f-label' }, '匹配值', h('div', { class: 'f-desc', text: 'MATCH 类型无需填写；AND/OR/NOT 支持多参数组合' })),
      h('div', { class: 'f-ctl', style: 'max-width:60%' }, valCtlHolder));

    const typeRow = h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, '规则类型'),
      h('div', { class: 'f-ctl' }, typeSel));
    const policyRow = h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, '目标策略', h('div', { class: 'f-desc', text: 'DIRECT / REJECT / 代理组' })),
      h('div', { class: 'f-ctl' }, policySel));

    const hintFor = (tp) => ({
      'DOMAIN': '完整域名，如 www.google.com',
      'DOMAIN-SUFFIX': '域名后缀，如 google.com / .google.com',
      'DOMAIN-KEYWORD': '域名关键词，如 google',
      'DOMAIN-REGEX': '正则，如 ^.*google.*',
      'DOMAIN-WILDCARD': '通配，如 *.google.com',
      'GEOSITE': 'geosite 类别，如 cn / google / category-ads-all',
      'GEOIP': '国家码，如 CN / 私有地址 private',
      'IP-CIDR': 'IPv4 段，如 91.108.4.0/22',
      'IP-CIDR6': 'IPv6 段，如 2001:db8::/32',
      'IP-SUFFIX': 'IP 后缀，如 8.8.8.8/24',
      'IP-ASN': 'ASN 号，如 13335',
      'SRC-GEOIP': '源 GeoIP，如 CN',
      'SRC-IP-ASN': '源 ASN，如 9808',
      'SRC-IP-CIDR': '源 IP 段，如 192.168.1.0/24',
      'SRC-IP-SUFFIX': '源 IP 后缀',
      'DST-PORT': '目标端口，如 443 / 80-443',
      'SRC-PORT': '源端口',
      'IN-PORT': '入站端口，如 7890',
      'IN-TYPE': '入站类型，如 SOCKS / HTTP',
      'IN-USER': '入站用户，如 mihomo',
      'IN-NAME': '入站名称，如 ss',
      'REMATCH-NAME': 'Rematch 名称',
      'PROCESS-NAME': '进程名，如 chrome.exe',
      'PROCESS-NAME-REGEX': '进程名正则',
      'PROCESS-NAME-WILDCARD': '进程名通配，如 *telegram*',
      'PROCESS-PATH': '进程路径，如 /usr/bin/curl',
      'PROCESS-PATH-REGEX': '路径正则',
      'PROCESS-PATH-WILDCARD': '路径通配',
      'UID': '用户 ID',
      'NETWORK': 'TCP / UDP',
      'DSCP': 'DSCP 值，如 4',
      'RULE-SET': '规则集名称（需在规则集页面创建）',
      'SUB-RULE': '子规则名称',
      'AND': '逻辑与，如 ((DOMAIN,example.com),(NETWORK,UDP))',
      'OR': '逻辑或',
      'NOT': '逻辑非，如 ((DOMAIN,example.com))',
      'MATCH': '兜底规则，无需匹配值',
    }[tp] || '匹配值');
    const syncVis = () => {
      const tp = typeSel.value;
      const isMatch = tp === 'MATCH';
      valRow.style.display = isMatch ? 'none' : '';
      const curInput = valCtlHolder.firstChild;
      if (curInput) curInput.placeholder = hintFor(tp);
      nrRow.style.display = isMatch ? 'none' : '';
      if (isMatch && curInput) curInput.value = '';
      // 动态切换单行/多行输入框
      const needMulti = ['AND','OR','NOT','SUB-RULE'].includes(tp);
      const isNowMulti = curInput && curInput.tagName === 'TEXTAREA';
      if (needMulti !== isNowMulti) {
        const newEl = needMulti
          ? h('textarea', { style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px', spellcheck: false, placeholder: hintFor(tp) })
          : h('input', { type: 'text', placeholder: hintFor(tp), style: 'width:100%' });
        newEl.value = curInput ? curInput.value : '';
        // 重新绑定预览更新
        newEl.addEventListener('input', updatePreview);
        valCtlHolder.innerHTML = '';
        valCtlHolder.append(newEl);
      }
    };
    typeSel.addEventListener('change', syncVis);
    syncVis();

    const preview = h('div', { class: 'note', style: 'margin-top:12px;word-break:break-all' });
    const updatePreview = () => {
      const tp = typeSel.value;
      const curIn = valCtlHolder.firstChild;
      const v = curIn ? curIn.value.trim() : '';
      const p = policySel.value;
      let line = tp;
      if (tp !== 'MATCH') line += ',' + (v || '<值>');
      line += ',' + (p || '<策略>');
      if (nrCb.checked && tp !== 'MATCH') line += ',no-resolve';
      preview.textContent = '预览：' + line;
    };
    valCtlHolder.firstChild.addEventListener('input', updatePreview);
    policySel.addEventListener('change', updatePreview);
    nrCb.addEventListener('change', updatePreview);
    typeSel.addEventListener('change', updatePreview);
    updatePreview();

    const rawInput = h('textarea', { style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px;display:none;margin-top:12px;background:var(--fill);border:none;border-radius:12px;padding:12px', spellcheck: false });
    rawInput.value = String(r);
    // 可视化态 → 规则行文本（进文本编辑前重建，避免「换了类型切文本还是旧类型」）
    const buildLine = () => {
      const tp = typeSel.value;
      const curIn = valCtlHolder.firstChild;
      const v = curIn ? curIn.value.trim() : '';
      const p = policySel.value;
      let line = tp;
      if (tp !== 'MATCH') line += ',' + v;
      if (p) line += ',' + p;
      if (nrCb.checked && tp !== 'MATCH') line += ',no-resolve';
      return line;
    };
    let isRaw = false;
    const toggleBtn = h('button', { class: 'btn sm', style: 'margin-top:12px', text: '切换为文本编辑', onclick: () => {
      isRaw = !isRaw;
      // 双向同步：进文本用当前可视化状态重建行；回文本态改动解析回填可视化（否则来回切一边改动会丢）
      if (isRaw) rawInput.value = buildLine(); else syncVisFromText(rawInput.value, typeSel, valCtlHolder, policySel, nrCb, syncVis, updatePreview);
      rawInput.style.display = isRaw ? '' : 'none';
      [typeRow, valRow, policyRow, nrRow, preview].forEach(el => el.style.display = isRaw ? 'none' : (el === valRow && typeSel.value === 'MATCH' ? 'none' : (el === nrRow && !isIpRule(typeSel.value) ? 'none' : '')));
      toggleBtn.textContent = isRaw ? '切换为可视化编辑' : '切换为文本编辑';
    }});

    const close = openSheet('编辑规则 — 可视化', typeRow, valRow, policyRow, nrRow, preview, toggleBtn, rawInput,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
        h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
          let line;
          if (isRaw) {
            line = rawInput.value.trim();
            if (!line) { ntoast('规则不能为空'); return; }
          } else {
            const tp = typeSel.value;
            const curIn2 = valCtlHolder.firstChild;
            const v = curIn2 ? curIn2.value.trim() : '';
            const p = policySel.value;
            if (tp !== 'MATCH' && !v) { ntoast('请填写匹配值'); return; }
            if (!p) { ntoast('请选择目标策略'); return; }
            line = tp;
            if (tp !== 'MATCH') line += ',' + v;
            line += ',' + p;
            if (nrCb.checked && tp !== 'MATCH') line += ',no-resolve';
          }
          rules[i] = line;
          setRules(rules);
          close();
          renderRulesPage(el);
        } })));
  }

}


export function renderRuleProviders(el) { renderRuleProvidersPage(el); }
function renderRuleProvidersPage(el) { return renderKeepScroll(() => renderRuleProvidersPageInner(el)); }
function renderRuleProvidersPageInner(el) {
  el.innerHTML = '';
  // ------- 规则集 -------
  const eps = state.cfg['rule-providers'];
  el.append(note('远程规则集：类型 / 行为 / 地址 / 更新策略。重命名规则集会自动同步 rules 中的 RULE-SET 引用。'));
  const epCard = card();
  const addEp = h('button', { class: 'btn sm pri', text: '＋ 添加规则集', onclick: () => editEpSheet('', null) });
  epCard.append(h('div', { class: 'card-head' }, h('h3', { text: `${eps && typeof eps === 'object' && !Array.isArray(eps) ? Object.keys(eps).length : 0} 个规则集合` }), addEp));
  if (eps && typeof eps === 'object' && !Array.isArray(eps)) {
    Object.entries(eps).forEach(([name, cfg]) => {
      epCard.append(h('div', { class: 'rule-item ep-row' },
        h('div', { class: 'ep-main' },
          h('div', { class: 'ep-title' },
            h('span', { class: 'ep-name', text: name }), badge(cfg.behavior || '?', 'o')),
          h('div', { class: 'ep-url', text: cfg.url || cfg.path || '-' })),
        h('span', { class: 'ep-acts' },
          miniBtn('✎', () => editEpSheet(name, cfg)),
          miniBtn('×', () => requestReferenceDelete('rule-providers', name, () => renderRuleProvidersPage(el))))));
    });
  }
  el.append(epCard);

  function editEpSheet(oldName, cfg) {
    const isNew = !oldName;
    const cur = cfg || { type: 'http', behavior: 'domain', format: 'yaml', url: '', interval: 86400 };
    const target = relFilePath(deepClone(cur));       // file 类型：工作目录内完整路径 → ./rules/…
    // 类型支持「默认（不覆写）」：源码里没有本地 type 行（经 <<: *域名集 等锚点纯继承）时，
    // 选择器默认停在「不覆写」，保存保持现状——不把继承值固化成本地 type 字段；
    // 已有本地行时选「不覆写」＝撤销本地覆写（删行回落锚点继承/内核默认）。
    const inheritedType = isNew ? undefined : target.type;          // cfg 是展开视图：纯继承条目这里也有生效值
    const typeLocal = !isNew && entryHasLocalField(state.raw, 'rule-providers', oldName, 'map', 'type');
    const nameInput = h('input', { type: 'text', value: oldName, placeholder: '规则集名（RULE-SET,名字 引用）', style: 'width:100%' });
    // 官方默认：rule-providers 的本地文件放在工作目录的 rules/ 下，写成相对路径；扩展名随 format
    const defaultEpPath = () => {
      const ext = target.format === 'mrs' ? 'mrs' : (target.format === 'text' ? 'txt' : 'yaml');
      return `./rules/${safeFileStem(isNew ? nameInput.value : oldName, 'ruleset')}.${ext}`;
    };
    const box = h('div', {});
    // 字段行规格：函数形式，重绘时 dialer/proxy 选项按当前值现算
    const epFieldSpecs = () => [
      { path: 'type', label: '类型', type: 'select', allowEmpty: true, emptyLabel: '默认（不覆写）', options: [['http','http'],['file','file'],['inline','inline']], desc: '「不覆写」不写本地 type 字段：纯继承保持现状；已有本地值则移除并回落继承/默认' },
      { path: 'behavior', label: '规则类型', type: 'select', options: [['domain','domain 域名'],['ipcidr','ipcidr IP段'],['classical','classical 经典']] },
      { path: 'format', label: '格式', type: 'select', allowEmpty: true, options: [['yaml','yaml'],['text','text'],['mrs','mrs(二进制)']] },
      { path: 'url', label: '下载链接', type: 'text', optional: true },
      { path: 'path', label: '本地路径', type: 'text', optional: true, placeholder: '默认 ./rules/ 目录' },
      { path: 'interval', label: '更新间隔(秒)', type: 'number', optional: true },
      { path: 'proxy', label: '下载出口', type: 'select', allowEmpty: true, emptyLabel: '默认（不覆写）', options: outboundOptions(target.proxy), desc: '下载规则集使用的出口' },
    ];
    // ---- file 类型：上传 / 在线编辑 / 设备路径导入本地规则集文件（支持 .mrs 二进制） ----
    const epFileOps = fileOpsCtl({
      label: '规则集源文件', desc: 'file 类型：上传/在线编辑本地规则集文件（支持 .mrs）',
      getCfgPath: () => relPath(String(target.path || '')) || defaultEpPath(),
      setCfgPath: (p) => {
        target.path = p;
        const pathIn = box.children[4] && box.children[4].querySelector('input');
        if (pathIn) pathIn.value = p;
      },
      onApplied: (fileName) => {
        if (fileName && /\.mrs$/i.test(fileName) && target.format !== 'mrs') {
          target.format = 'mrs';
          const fmtSel = box.children[2] && box.children[2].querySelector('.selctl');
          if (fmtSel) fmtSel.value = 'mrs';
          ntoast('已按文件名自动切换 format 为 mrs');
        }
      },
      watch: [nameInput, box],
      editTitle: `编辑规则集文件 — ${oldName || '新规则集'}`,
      importTitle: '从设备路径复制为规则集文件',
      newFileText: '# 新建规则集文件（内容取决于 behavior）\n# domain：每行一个域名/后缀\n#   .google.com\n# ipcidr：每行一个 CIDR\n#   91.108.56.0/22\n# classical：YAML payload 规则列表\npayload:\n  # - DOMAIN-SUFFIX,example.com\n',
    });
    box.append(epFileOps.row);   // 先占位：字段行重绘插在它前面，锚点区在它后面，索引不变
    const epHttpOnlyIdx = [3, 5, 6]; // 下载链接 / 更新间隔 / 下载出口 —— file 类型无意义，隐藏
    const syncEpFile = () => {
      // 「不覆写」时按生效类型决定显隐，避免继承 file 类型却看不到文件操作行
      const ts = box.children[0] && box.children[0].querySelector('.selctl');
      const t = (ts && ts.value) || target.type || inheritedType || 'http';
      epFileOps.row.style.display = t === 'file' ? '' : 'none';
      epHttpOnlyIdx.forEach(ci => { const r = box.children[ci]; if (r) r.style.display = t === 'file' ? 'none' : ''; });
    };
    let epTypeTouched = false;   // 锚点替换写过显式 type 后，重绘不再回落「不覆写」
    const renderEpRows = () => {
      while (box.firstChild && box.firstChild !== epFileOps.row) box.firstChild.remove();
      epFieldSpecs().forEach(f => box.insertBefore(fieldRow(f, target), epFileOps.row));
      const ts = box.children[0] && box.children[0].querySelector('.selctl');
      if (ts) {
        // 无本地 type 行（纯经 <<: *锚点 继承 / 未写入）：选择器停在「不覆写」。
        // 直接赋值不触发 change —— target 保留展开后的生效值，保存即维持现状（零变更）。
        if (!isNew && !typeLocal && !epTypeTouched) ts.value = '';
        ts.addEventListener('change', syncEpFile);
      }
      syncEpFile();
    };
    renderEpRows();
    // 选中继承/字段锚点后值框立即替换为锚点参数值：写进 target 再重绘字段行
    const anchEp = anchorSection('rule-providers', oldName, 'map', {
      applyValues(vals) {
        Object.keys(vals).forEach(k => { target[k] = deepClone(vals[k]); });
        if (Object.prototype.hasOwnProperty.call(vals, 'type')) epTypeTouched = true;
        renderEpRows();
        markDirty(target);
      },
      applyFieldValue(key, val) {
        target[key] = deepClone(val);
        if (key === 'type' && typeof val === 'string') epTypeTouched = true;
        renderEpRows();
        markDirty(target);
      },
    });
    box.append(h('div', { class: 'group-title', text: 'YAML 锚点' }), ...anchEp.nodes);
    const close = openSheet(isNew ? '添加规则集' : `编辑规则集 — ${oldName}`,
      nameInput, box,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
        h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
          const n = nameInput.value.trim();
          if (!n) { ntoast('请填写规则集名'); return; }
          // type「不覆写」提交语义：
          //   无本地行（纯继承 / 新建未写入）→ 保持现状：有继承值则把展开值放回（语义零变更，
          //   源码原样、锚点不动），没有则不写 type（交由 <<: *锚点 继承）；
          //   已有本地行 → 控件已随 change 移除 target.type，提交时手术层删除本地行（回落继承/默认）
          const tSelNow = box.children[0] && box.children[0].querySelector('.selctl');
          if (tSelNow && tSelNow.value === '' && !typeLocal) {
            if (inheritedType !== undefined) target.type = inheritedType;
            else delete target.type;
          }
          const av = anchEp.validate(n, () => target); if (av.error) { ntoast(av.error); return; }
          cleanProviderFields(target, 'ep');
          normalizeFilePath(target, defaultEpPath());
          let renamed = 0;
          if (av.changed) av.op.expand = deepClone(target);
          if (!commitConfigEdit(cfg => {
            const rp = cfg['rule-providers'] = (typeof cfg['rule-providers'] === 'object' && cfg['rule-providers'] && !Array.isArray(cfg['rule-providers'])) ? cfg['rule-providers'] : {};
            if ((isNew || n !== oldName) && rp[n]) { ntoast('规则集已存在'); return false; }
            if (!isNew && n !== oldName) {
              // 重命名：同步 RULE-SET,名字 规则引用，并保持键在映射中的原位置
              if (Array.isArray(cfg.rules)) cfg.rules = cfg.rules.map(r => {
                const parts = String(r).split(',');
                if (parts.length >= 3 && parts[0].trim() === 'RULE-SET' && parts[1].trim() === oldName) { renamed++; parts[1] = n; return parts.join(','); }
                return r;
              });
              const out2 = {};
              Object.keys(rp).forEach(k => { out2[k === oldName ? n : k] = (k === oldName ? target : rp[k]); });
              cfg['rule-providers'] = out2;
            } else {
              rp[n] = target;
            }
          }, av.changed ? [av.op] : [])) return;
          close(); renderRuleProvidersPage(el);
          if (renamed) ntoast(`✅ 已重命名，并同步更新 ${renamed} 处 RULE-SET 规则引用`);
        } })));
  }
}


export function renderSubRules(el) { renderSubRulesPage(el); }
function renderSubRulesPage(el) { return renderKeepScroll(() => renderSubRulesPageInner(el)); }
function renderSubRulesPageInner(el) {
  el.innerHTML = '';
  // ------- 子规则 -------
  el.append(note('子规则 sub-rules：键 = 名称，值 = 规则列表；需配合 SUB-RULE 在路由规则中引用。'));
  const srCard = card();
  srCard.append(fieldRow({ path: 'sub-rules', label: '子规则集合', type: 'maplist', lineValues: true, optional: true, keyPlaceholder: '子规则名称', desc: '键=sub-rule 名，值=规则列表（每行一条完整规则）' }, state.cfg));
  // 子规则值始终为数组；每条规则内部的逗号不是列表分隔符。
  el.append(srCard);
}
