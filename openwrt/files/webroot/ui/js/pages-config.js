// ============================================================
// 配置中心：13 个官方 Wiki 章节 + Smart / eBPF
// ============================================================
import { h, state, get, set, unset, badge, note, groupTitle, card, chev, switchCtl, ntoast, confirmSheet, openSheet, closeSheet, markDirty, requestServiceRestartOnSave, deepClone, selectCtl, parseJsonLoose, renderKeepScroll, applyConfigDraft, parseConfigText, marqueeText, observeMarqueeText, stopMarqueeObservation } from './core.js';
import { fieldRow, renderSections, listEditor } from './fields.js';

// ---------------- 常见选择池 ----------------
// mihomo 的全部内置策略（预置出站），依官方 Wiki「代理组 / 内置策略」列全。
// 代理组成员与规则目标都能用，但成员编辑器是「只能从清单挑选」的，清单里没有就等于
// 填不进去 —— 之前只列了 DIRECT/REJECT，导致配置里明明用着的 PASS 删掉后再也加不回来。
export const BUILTIN_POLICIES = [
  ['DIRECT', '直连，数据直接出站'],
  ['REJECT', '拒绝，拦截数据出站'],
  ['REJECT-DROP', '拒绝，静默抛弃请求，不像 REJECT 那样回应错误'],
  ['PASS', '绕过，跳过当前命中的规则分支继续匹配；在 SUB-RULE 中会跳出子规则回到主规则'],
  ['PASS-RULE', '绕过，同 PASS，但在 SUB-RULE 中不跳出，继续在子规则内向后匹配'],
  ['COMPATIBLE', '兼容，策略组筛选不出节点时出现，等效 DIRECT'],
];
const BUILTIN_DESC = Object.fromEntries(BUILTIN_POLICIES);

export function policyNames() {
  const pool = new Set(BUILTIN_POLICIES.map(([v]) => v));
  (state.cfg['proxy-groups'] || []).forEach(g => g && g.name && pool.add(g.name));
  (state.cfg.proxies || []).forEach(p => p && p.name && pool.add(p.name));
  pool.add('GLOBAL');
  return [...pool];
}

// 给「挑选式」控件用：内置策略带一行说明，代理组/节点标出来源，便于区分同名概念
export function policyOptions(extra = {}) {
  const groups = new Set((state.cfg['proxy-groups'] || []).map(g => g && g.name).filter(Boolean));
  const nodes = new Set((state.cfg.proxies || []).map(p => p && p.name).filter(Boolean));
  return policyNames()
    .filter(n => !(extra.exclude && extra.exclude.includes(n)))
    .map(n => [n, BUILTIN_DESC[n] || (groups.has(n) ? '代理组' : nodes.has(n) ? '节点' : n === 'GLOBAL' ? '内置的全局代理组' : '')]);
}

// 入站「转发到代理/代理组」选择池：策略名 + 现值（现值不在池中时也列出，保证可见可保留）
function proxyTargetOptions(cur) {
  const seen = new Set(['']);
  const opts = [];
  const add = (v, label) => { const s = String(v); if (!s || seen.has(s)) return; seen.add(s); opts.push([s, label ?? s]); };
  policyNames().forEach(n => add(n, BUILTIN_DESC[n] ? `${n}（${BUILTIN_DESC[n]}）` : n));
  if (cur !== undefined && cur !== null) add(cur, String(cur) + '（当前值）');
  return opts;
}

// ============================================================
// 配置中心主页面（导航）
// ============================================================
export function renderConfigHub(el) { return renderKeepScroll(() => renderConfigHubCore(el)); }
function renderConfigHubCore(el) {
  el.innerHTML = '';
  const dns = state.cfg.dns || {};
  const tun = state.cfg.tun || {};
  const sniffOn = !!(state.cfg.sniffer && state.cfg.sniffer.enable);
  const inCnt = Array.isArray(state.cfg.listeners) ? state.cfg.listeners.length : 0;
  const proxies = state.cfg.proxies || [];
  const subs = state.cfg['proxy-providers'] || {};
  const groups = state.cfg['proxy-groups'] || [];
  const rules = state.cfg.rules || [];
  const eps = state.cfg['rule-providers'] || {};
  const subrules = state.cfg['sub-rules'] || {};
  const tunnels = state.cfg.tunnels || [];
  const ntp = state.cfg.ntp || {};
  const portsOn = ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port'].filter(k => +state.cfg[k] > 0).length;
  const expCnt = state.cfg.experimental ? Object.values(state.cfg.experimental).filter(Boolean).length : 0;

  // 命名与排序完全对照官方 Wiki 配置章节（wiki.metacubex.one/config）；标题仅中文
  const rows = [
    { title: '全局配置', sub: '模式 / API / 日志 / Geo / Smart', page: 'page-c-general' },
    { title: 'DNS', sub: dns.enable ? '已启用 · ' + (dns['enhanced-mode'] || '默认') : '未启用', page: 'page-c-dns' },
    { title: '域名嗅探', sub: sniffOn ? '已启用' : 'TLS/HTTP/QUIC 域名恢复', page: 'page-c-sniff' },
    // 计数一律写成「N 个X」，与「N 个代理组」「N 条隧道」同一句式；为 0 时也读得通
    { title: '入站', sub: `${portsOn} 个端口 · TUN ${tun.enable ? '开' : '关'} · ${inCnt} 个监听器`, page: 'page-c-inbound' },
    { title: '出站代理', sub: `${proxies.length} 个节点`, page: 'page-f-proxies' },
    { title: '代理集合', sub: `${Object.keys(subs).length} 个订阅`, page: 'page-f-subs' },
    { title: '代理组', sub: `${groups.length} 个代理组`, page: 'page-f-groups' },
    { title: '路由规则', sub: `${rules.length} 条规则`, page: 'page-f-rules' },
    { title: '规则集合', sub: `${Object.keys(eps).length} 个规则集`, page: 'page-c-ruleproviders' },
    { title: '子规则', sub: `${Object.keys(subrules).length} 组子规则`, page: 'page-c-subrules' },
    { title: '流量隧道', sub: tunnels.length ? `${tunnels.length} 条隧道` : 'TCP/UDP 端口转发', page: 'page-c-tunnels' },
    { title: 'NTP', sub: ntp.enable ? '已启用' : '时间同步', page: 'page-c-ntp' },
    { title: '实验性配置', sub: expCnt ? `${expCnt} 项已开` : 'QUIC / 拨号器', page: 'page-c-experimental' },
  ];

  // 排布：功能相近的入口并排放，手机上一屏少滚一半。
  // 每行是一个数组——2 个 = 两列并排，3 个 = 三列并排，1 个 = 独占整行。
  // 只有「全局配置」（总入口）和「实验性配置」（兜底项）独占，其余都成对/成组。
  // 具体列宽由 CSS 的 6 列栅格换算（2 个 → 各 3 列，3 个 → 各 2 列），
  // 窄屏（≤340px）自动退回单列；格子数量变了也不用改脚本。
  const hubLayout = [
    ['全局配置'],
    ['DNS', '域名嗅探'],
    ['入站', '出站代理'],
    ['代理集合', '代理组'],
    ['路由规则', '规则集合', '子规则'],
    ['流量隧道', 'NTP'],
    ['实验性配置'],
  ];

  // 6 列栅格：独占整行 → 6 列；两列并排 → 各 3 列；三列并排 → 各 2 列
  const spanClass = (n) => n === 1 ? 'span-6' : n === 2 ? 'span-3' : 'span-2';
  const tiles = new Map(rows.map(r => [r.title, r]));
  // 不再用外层卡片包住所有格子：每格自己就是一张卡片（与代理页代理组卡片同款）
  const list = h('ul', { class: 'rows config-grid' });
  // 页面要重建：先断开上一轮的长文本观察，别让被替换掉的格子继续被持有
  stopMarqueeObservation();
  // 缺行的兜底：按 title 取不到就跳过（宁可少一格，也不留空位错位）
  hubLayout.forEach(group => {
    group.forEach(title => {
      const r = tiles.get(title);
      if (!r) return;
      // 格子里只有标题与副标题：不放右侧箭头（整格可点），左右边距靠 CSS 的对称 padding。
      // 两者都套上 .marquee：格子窄（三列并排 / 长状态串）放不下时缓慢来回滚，
      // 而不是截断成「3 个端口 · TUN 关 · 12 个…」。
      const titleText = h('span', { class: 'marquee-text' }, r.title);
      if (r.tagPrefix) { titleText.append(' '); titleText.append(badge('liuran001 专属', 'p')); }
      const li = h('li', { class: spanClass(group.length) },
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title marquee' }, titleText),
          marqueeText(r.sub, 'li-sub')));
      li.onclick = () => window.navTo(r.page);
      list.append(li);
    });
  });
  el.append(note('所有字段与 <a href="https://wiki.metacubex.one/" target="_blank">mihomo 官方文档</a> 1:1 对应。修改后点击底部「保存」生效。'), list);
  // 布局完成后再量（此时宽度才是真的）；量不到宽度的会在进入视口时补量
  list.querySelectorAll('.marquee').forEach(observeMarqueeText);
}

// ============================================================
// 全局配置
// ============================================================
const GENERAL_SECTIONS = [
  { title: '基础', fields: [
    { path: 'mode', label: '运行模式', type: 'select', optional: true, allowEmpty: true, options: [['rule','规则'],['global','全局'],['direct','直连']], desc: '内核启动时的默认模式；主页上的模式切换只走外部面板 API，不会改动这里' },
    { path: 'log-level', label: '日志等级', type: 'select', optional: true, allowEmpty: true, options: [['silent','silent'],['error','error'],['warning','warning'],['info','info'],['debug','debug']], desc: '内核默认 info' },
    { path: 'ipv6', label: 'IPv6 总开关', type: 'bool', optional: true, def: true, desc: '内核默认开启；关闭则阻断所有 IPv6 连接及 AAAA 记录' },
    { path: 'unified-delay', label: '统一延迟', type: 'bool', optional: true, desc: '去除握手等额外延迟，更换延迟计算方式' },
    { path: 'tcp-concurrent', label: 'TCP 并发', type: 'bool', optional: true, desc: '并发连接所有 IP，使用最快握手' },
    { path: 'allow-lan', label: '允许局域网连接', type: 'bool', optional: true },
    { path: 'bind-address', label: '绑定地址', type: 'text', optional: true, placeholder: '仅 allow-lan 为真时生效' },
    { path: 'interface-name', label: '出口网卡', type: 'text', optional: true, placeholder: '如 wlan0' },
    { path: 'global-client-fingerprint', label: '全局指纹(旧内核)', type: 'select', allowEmpty: true, tag: '新版本已移除', tagCls: 'o', options: [['chrome','chrome'],['firefox','firefox'],['safari','safari'],['ios','ios'],['android','android'],['edge','edge'],['random','random']] },
    { path: 'find-process-mode', label: '进程匹配模式', type: 'select', allowEmpty: true, options: [['always','always 总是匹配'],['strict','strict 自动判断'],['off','off 不匹配']] },
    { path: 'routing-mark', label: '路由标记 routing-mark', type: 'number', optional: true },
    { path: 'global-ua', label: '全局 User-Agent', type: 'text', optional: true, placeholder: '如 clash.meta' },
  ]},
  { title: '局域网访问控制', fields: [
    { path: 'authentication', label: '认证用户(用户:密码)', type: 'list', optional: true, hint: 'user:password' },
    { path: 'skip-auth-prefixes', label: '跳过认证的 IP 段', type: 'list', optional: true, hint: '如 127.0.0.1/8' },
    { path: 'lan-allowed-ips', label: '允许接入的 IP 段', type: 'list', optional: true, hint: '如 0.0.0.0/0' },
    { path: 'lan-disallowed-ips', label: '禁止接入的 IP 段', type: 'list', optional: true, hint: '黑名单优先于白名单' },
  ]},
  { title: '外部控制 / API', fields: [
    { path: 'external-controller', label: 'API 监听地址', type: 'text', optional: true, placeholder: '127.0.0.1:9090', desc: '改地址后需重启内核' },
    { path: 'secret', label: 'API 密钥', type: 'text', optional: true },
    { path: 'external-ui', label: '面板路径', type: 'text', optional: true, placeholder: '如 ui（相对=工作目录下）', desc: '外部面板静态文件目录' },
    { path: 'external-ui-name', label: '面板目录名（URL 路径）', type: 'text', optional: true, placeholder: 'ui', desc: '访问路径名，空则直接用 external-ui' },
    { path: 'external-ui-url', label: '面板下载地址', type: 'text', optional: true, desc: '无本地面板时自动下载。手机建议用无字体版（gh-pages-no-fonts.zip，1.4MB，走系统字体）：带字体版有 6MB+ 中文字形，首屏更慢、滚动更容易卡' },
    { path: 'external-controller-tls', label: 'API TLS 监听地址', type: 'text', optional: true, placeholder: '127.0.0.1:9443' },
    { path: 'external-controller-unix', label: 'API Unix Socket', type: 'text', optional: true, placeholder: '/tmp/mihomo.sock' },
    { path: 'external-controller-pipe', label: 'API 命名管道', type: 'text', optional: true, placeholder: '\\\\.\\pipe\\mihomo（Windows）' },
    { path: 'external-doh-server', label: 'DoH 服务路径', type: 'text', optional: true, placeholder: '如 /dns-query' },
    { path: 'external-controller-cors.allow-origins', label: 'CORS 允许来源', type: 'list', optional: true, hint: '如 * 或 http://127.0.0.1' },
    { path: 'external-controller-cors.allow-private-network', label: 'CORS 允许私有网络', type: 'bool', optional: true },
  ]},
  { title: 'Geo 数据', fields: [
    { path: 'geox-url.geoip', label: 'GeoIP 下载地址', type: 'text', optional: true },
    { path: 'geox-url.geosite', label: 'GeoSite 下载地址', type: 'text', optional: true },
    { path: 'geox-url.mmdb', label: 'GeoIP MMDB 下载地址', type: 'text', optional: true },
    { path: 'geox-url.asn', label: 'ASN 数据库地址', type: 'text', optional: true },
    { path: 'geo-auto-update', label: 'Geo 数据自动更新', type: 'bool', optional: true },
    { path: 'geo-update-interval', label: '更新间隔(小时)', type: 'number', optional: true },
    { path: 'geosite-matcher', label: 'GeoSite 匹配器', type: 'select', allowEmpty: true, options: [['succinct','succinct(默认)'],['mph','mph(hybrid)']] },
  ]},
  { title: '杂项', fields: [
    { path: 'profile.store-selected', label: '记住节点选择', type: 'bool', optional: true, def: true, asSwitch: true, desc: '内核默认开启' },
    { path: 'profile.store-fake-ip', label: '持久化 fake-ip', type: 'bool', optional: true },
    { path: 'keep-alive-interval', label: 'TCP 保活探测间隔(秒)', type: 'number', optional: true, placeholder: '15' },
    { path: 'keep-alive-idle', label: 'TCP 保活空闲时间(秒)', type: 'number', optional: true, placeholder: '600' },
    { path: 'disable-keep-alive', label: '禁用 TCP 保活', type: 'bool', optional: true },
  ]},
  { title: 'Smart 内核专属（LightGBM 模型）', fields: [
    { path: 'lgbm-auto-update', label: '模型自动更新', type: 'bool', optional: true, desc: '默认关闭' },
    { path: 'lgbm-update-interval', label: '更新间隔(小时)', type: 'number', optional: true, placeholder: '72' },
    { path: 'lgbm-url', label: '模型下载地址', type: 'text', optional: true, placeholder: '模型 bin 文件 URL' },
    { path: 'profile.smart-collector-size', label: '采样数据大小 (MB)', type: 'number', optional: true, placeholder: '100', desc: 'Smart 数据采集缓存大小' },
  ]},
];
export function renderGeneral(el) { return renderKeepScroll(() => renderSections(el, GENERAL_SECTIONS)); }
// ============================================================
const DNS_SECTIONS = [
  { title: '基础', fields: [
    { path: 'dns.enable', label: '启用内置 DNS', type: 'bool', optional: true },
    { path: 'dns.cache-algorithm', label: '缓存算法', type: 'select', allowEmpty: true, options: [['arc','arc'],['lru','lru']] },
    { path: 'dns.prefer-h3', label: '优先 HTTP/3 DoH', type: 'bool', optional: true },
    { path: 'dns.use-hosts', label: '使用 hosts', type: 'select', allowEmpty: true, optional: true, bool: true, options: [[true, '开启'], [false, '关闭']], desc: '回应配置中的 hosts 映射；内核默认开启' },
    { path: 'dns.use-system-hosts', label: '使用系统 hosts', type: 'select', allowEmpty: true, optional: true, bool: true, options: [[true, '开启'], [false, '关闭']], desc: '查询系统 hosts；内核默认开启' },
    { path: 'dns.respect-rules', label: '按规则分流解析', type: 'bool', optional: true, desc: '代理规则使用对应上游解析' },
    { path: 'dns.listen', label: '监听地址', type: 'text', optional: true, placeholder: '0.0.0.0:7874', desc: '内核 DNS 服务器监听' },
    { path: 'dns.ipv6', label: '解析 IPv6 (AAAA)', type: 'bool', optional: true },
  ]},
  { title: '增强模式 / fake-ip', fields: [
    { path: 'dns.enhanced-mode', label: '增强模式', type: 'select', allowEmpty: true, options: [['normal','normal'],['fake-ip','fake-ip'],['redir-host','redir-host']], desc: 'fake-ip=虚拟 IP，加速且便于按域名分流；redir-host=返回真实 IP 并记录域名映射' },
    { path: 'dns.fake-ip-range', label: 'fake-ip 地址池', type: 'text', optional: true, placeholder: '198.18.0.1/16', desc: 'fake-ip 模式的 IPv4 池，默认 198.18.0.1/16' },
    { path: 'dns.fake-ip-range6', label: 'fake-ip v6 地址池', type: 'text', optional: true, placeholder: 'fd00::/108', desc: '可选，未设则不分配 v6 fake-ip' },
    { path: 'dns.fake-ip-filter-mode', label: '过滤模式', type: 'select', allowEmpty: true, options: [['blacklist','blacklist 黑名单'],['whitelist','whitelist 白名单'],['rule','rule 规则']] , desc: 'blacklist=命中走 real-ip；whitelist=仅命中走 fake-ip；rule=按规则逐条匹配 fake-ip/real-ip（与路由规则一致）' },
    { path: 'dns.fake-ip-filter', label: 'fake-ip 过滤', type: 'fakeiprule', optional: true, desc: '按 fake-ip-filter-mode 自动切换：rule 时为结构化规则表（逐条 fake-ip/real-ip，拖动排序，自上而下匹配），blacklist/whitelist 时为域名列表（*.lan / geosite:cn 等）' },
    { path: 'dns.fake-ip-ttl', label: 'fake-ip TTL', type: 'number', optional: true, placeholder: '1', desc: 'fake-ip 响应的 TTL（秒），内核默认 1' },
  ]},
  { title: '上游服务器', fields: [
    { path: 'dns.default-nameserver', label: '默认 DNS(解析上游)', type: 'dnslist', optional: true, dnsIpOnly: true, desc: '引导 DNS：解析下方各服务器域名用，必须为 IP（可为加密 DNS）' },
    { path: 'dns.nameserver', label: '主 DNS 服务器', type: 'dnslist', optional: true },
    { path: 'dns.fallback', label: 'fallback（已弃用）', type: 'dnslist', optional: true, tag: '弃用', tagCls: 'o', desc: '旧版字段，Alpha 内核已弃用' },
    { path: 'dns.proxy-server-nameserver', label: '代理服务器解析 DNS', type: 'dnslist', optional: true, desc: '仅用于解析代理节点的域名，建议国内直连 DNS；不填则遵循 nameserver-policy/nameserver/fallback' },
    { path: 'dns.direct-nameserver', label: '直连规则 DNS', type: 'dnslist', optional: true, desc: 'direct 出口域名解析用，配合 respect-rules 使用' },
    { path: 'dns.direct-nameserver-follow-policy', label: '直连 DNS 遵循策略', type: 'bool', optional: true, desc: 'direct-nameserver 是否遵循 nameserver-policy，内核默认否；仅「直连规则 DNS」非空时生效' },
  ]},
  { title: '按域名分流解析', fields: [
    { path: 'dns.nameserver-policy', label: 'nameserver-policy', type: 'maplist', optional: true, dns: true, desc: '域名/geosite → 专用 DNS 列表' },
    { path: 'dns.proxy-server-nameserver-policy', label: 'proxy-server-nameserver-policy', type: 'maplist', optional: true, dns: true, keyPlaceholder: '节点域名，如 www.yournode.com 或 geosite:cn', desc: '格式同 nameserver-policy，仅用于代理节点的域名解析；当且仅当「代理服务器解析 DNS」非空时生效' },
  ]},
  { title: 'hosts 自定义', fields: [
    { path: 'hosts', label: 'hosts 自定义', type: 'maplist', optional: true, desc: '键=域名（支持 *. 通配），值=IP，多个逗号分隔；类似 /etc/hosts' },
  ]},
];
export function renderDns(el) { return renderKeepScroll(() => renderSections(el, DNS_SECTIONS)); }

const INBOUND_PORTS = [
  { title: '端口（0 或留空 = 禁用该项）', fields: [
    { path: 'port', label: 'HTTP 代理端口', type: 'number', optional: true },
    { path: 'socks-port', label: 'SOCKS5 代理端口', type: 'number', optional: true },
    { path: 'mixed-port', label: 'HTTP+SOCKS 混合端口', type: 'number', optional: true },
    { path: 'redir-port', label: 'Redir 透明代理端口', type: 'number', optional: true },
    { path: 'tproxy-port', label: 'TProxy 端口 (TCP/UDP)', type: 'number', optional: true },
  ]},
];

const NTP_SECTIONS = [
  { title: 'NTP 时间同步', fields: [
    { path: 'ntp.enable', label: '启用 NTP', type: 'bool', optional: true, boolAs: 'pick', desc: 'TLS 握手对时间敏感' },
    { path: 'ntp.server', label: 'NTP 服务器', type: 'text', optional: true, placeholder: 'time.apple.com' },
    { path: 'ntp.port', label: 'NTP 端口', type: 'number', optional: true, placeholder: '123' },
    { path: 'ntp.interval', label: '同步间隔(分钟)', type: 'number', optional: true },
    { path: 'ntp.write-to-system', label: '同步后写入系统时间', type: 'bool', optional: true, boolAs: 'pick', tag: '需 root', tagCls: 'o' },
    { path: 'ntp.dialer-proxy', label: 'NTP 出站代理 dialer-proxy', type: 'select', allowEmpty: true, options: [], desc: '默认 DIRECT；强制 NTP 走指定出站' },
  ]},
];
const NTP_DIALER_FIELD = NTP_SECTIONS[0].fields[NTP_SECTIONS[0].fields.length - 1];

const EXPERIMENTAL_SECTIONS = [
  { note: '实验性开关：前两项为「禁用」语义——打开表示关闭对应优化；默认全关即可。' },
  { title: 'QUIC / 拨号器', fields: [
    { path: 'experimental.quic-go-disable-gso', label: '禁用 QUIC GSO', type: 'bool', optional: true, tri: true, desc: '打开 = 关闭 GSO 分段卸载加速' },
    { path: 'experimental.quic-go-disable-ecn', label: '禁用 QUIC ECN', type: 'bool', optional: true, def: true, desc: '打开 = 关闭 QUIC 的 ECN 显式拥塞通知；部分网络设备会丢弃 ECN 标记包，QUIC 变慢/不通时可开启' },
    { path: 'experimental.dialer-ip4p-convert', label: 'IP4P 地址转换', type: 'bool', optional: true, tri: true, desc: '启用 IP4P 地址转换（natmap 域名访问）' },
  ]},
];

// ============================================================
// TUN
// ============================================================
// 卡体顶部原来那段黄色说明（TUN 接管方式 / 热点共享 / eBPF 互斥 / ipv6 拦截 / 二层桥接）
// 已按需求整段移除：展开后直接就是「基础」分组，卡片更干净。
const TUN_SECTIONS = [
  { title: '基础', fields: [
    { path: 'tun.enable', label: '启用 TUN', type: 'bool', optional: true, restartOnSave: true,
      desc: '开启时自动把 eBPF 入站的 local.enabled / shared.enabled 置为 false（参数原样保留，改回 true 即恢复）',
      // 必须先关 eBPF、再由 fieldRow 写 tun.enable。setEbpfEnabled(false) 与 eBPF 页面的
      // 角色开关走同一条路径：只改两个 enabled，不删除用户的 local/shared 等参数。
      beforeChange: (enabled, target) => {
        if (!enabled || target !== state.cfg) return true;
        const ok = setEbpfEnabled(false);
        if (!ok) ntoast('eBPF 入站未能关闭，TUN 未启用，请先检查配置源码', 3800);
        return ok;
      } },
    // stack 的取值随内核版本增加：mips 是 mihomo 自研的 IP 协议栈（内核 ≥ v1.19.31 才有），
    // 旧内核读到这个值会直接启动失败，所以标签里带上「新内核」的提示。
    { path: 'tun.stack', label: '协议栈', type: 'select', allowEmpty: true,
      options: [['system','system（系统栈·占用低）'],['gvisor','gvisor（默认）'],['mixed','mixed（官方建议）'],['mips','mips（自研栈·新内核）']],
      desc: '留空 = 内核默认 gvisor。system=系统协议栈，更稳定全面、占用相对更低；gvisor=用户态实现，隔离性更好；mixed=TCP 走 system、UDP 走 gvisor，无使用问题时官方建议用它；mips=mihomo 自研 IP 协议栈，需内核 ≥ v1.19.31，旧内核会启动失败' },
    { path: 'tun.device', label: '虚拟网卡名', type: 'text', optional: true, placeholder: '默认 Meta' },
    { path: 'tun.mtu', label: 'MTU', type: 'number', optional: true, placeholder: '9000' },
    { path: 'tun.gso', label: 'GSO 分段卸载', type: 'bool', optional: true },
    { path: 'tun.gso-max-size', label: 'GSO 最大包长', type: 'number', optional: true },
  ]},
  { title: '路由', fields: [
    { path: 'tun.auto-route', label: '自动配置路由表', type: 'bool', optional: true },
    { path: 'tun.auto-redirect', label: '自动配置 iptables 重定向', type: 'bool', optional: true, desc: '本机 TCP 快速重定向（Android 上 sing-tun 仅装 OUTPUT 链，不作用于转发流量）；热点共享的转发放行由模块自动完成，不依赖此项' },
    { path: 'tun.auto-detect-interface', label: '自动识别出口网卡', type: 'bool', optional: true },
    { path: 'tun.strict-route', label: '严格路由', type: 'bool', optional: true, desc: '防止泄漏，但局域网不可达' },
    { path: 'tun.disable-icmp-forwarding', label: '禁用 ICMP 转发', type: 'bool', optional: true },
    { path: 'tun.route-address', label: '自定义路由地址集', type: 'list', optional: true, hint: '如 0.0.0.0/1' },
    { path: 'tun.route-address-set', label: '路由规则集(包含)', type: 'list', optional: true, hint: 'rule-set 名称' },
    { path: 'tun.route-exclude-address-set', label: '路由规则集(排除)', type: 'list', optional: true },
    { path: 'tun.endpoint-independent-nat', label: '独立于端点的 NAT (EIM)', type: 'bool', optional: true },
    { path: 'tun.dns-hijack', label: 'DNS 劫持地址', type: 'list', optional: true, hint: '如 any:53' },
    { path: 'tun.udp-timeout', label: 'UDP NAT 超时(秒)', type: 'number', optional: true },
  ]},
  { title: '范围过滤（需 auto-route）', fields: [
    { path: 'tun.include-android-user', label: '包含的安卓用户 ID', type: 'numlist', optional: true, hint: '如 0、10' },
    { path: 'tun.include-package', label: '仅代理以下应用', type: 'applist', optional: true, desc: '留空 = 全部应用；Tproxy 开启时同样生效（白名单，优先于排除名单）' },
    { path: 'tun.exclude-package', label: '排除以下应用', type: 'applist', optional: true, desc: '被排除应用直连；Tproxy 开启时同样生效（黑名单）' },
    { path: 'tun.include-uid', label: '包含 UID', type: 'numlist', optional: true },
    { path: 'tun.exclude-uid', label: '排除 UID', type: 'numlist', optional: true },
    { path: 'tun.include-uid-range', label: '包含 UID 范围', type: 'list', optional: true, hint: 'start:end，如 10000:19999' },
    { path: 'tun.exclude-uid-range', label: '排除 UID 范围', type: 'list', optional: true },
    { path: 'tun.include-interface', label: '包含网卡', type: 'list', optional: true },
    { path: 'tun.exclude-interface', label: '排除网卡', type: 'list', optional: true },
    { path: 'tun.include-mac-address', label: '包含 MAC 地址', type: 'list', optional: true, hint: 'AA:BB:CC:DD:EE:FF' },
    { path: 'tun.exclude-mac-address', label: '排除 MAC 地址', type: 'list', optional: true },
  ]},
];

// ============================================================
// eBPF 透明入站（liuran001 内核专属）
// ============================================================
// 键序与 liuran001/mihomo Alpha docs/ebpf-inbound.md「Configuration」示例一致：
// name → type →（可选顶层键）→ local → shared。
// 角色启用一律写 local.enabled / shared.enabled，不再产出 mode：内核的
// normalizeModeWithEnabled 两者只能二选一，面板统一用 enabled 这一套。
const EBPF_TPL = () => ({
  name: 'ebpf-in',
  type: 'ebpf',
  // network / udp-timeout / tc-priority / bypass-rule-set / bypass-tun-direct / fakeip-icmp /
  // local·shared 的 dns-mode / ipv6 / bypass-private-address / bypass-port 均不预写：
  // 「默认（不覆写）」＝ 内核默认 tcp+udp / 300 秒 / 1 / 空 / 开启 / off / hijack / 开启 / 开启 / 空
  local: { enabled: true },             // 新建默认本机 + 热点共享同时接管（等价旧写法 mode: hybrid）
  shared: {
    enabled: true,
    interface: ['wlan2', 'br-lan'],     // 常见热点/桥接接口，可按需增删
  },
});

// 配置面字段表：顺序 1:1 对齐分支文档 docs/ebpf-inbound.md 的 YAML 示例，
// 便于「照着文档逐条对」；custom 项由 renderEbpfCore 里的专用行渲染（值不是简单标量）。
const EBPF_SECTIONS = [
  { title: '基础（listeners[].type=ebpf）', fields: [
    { custom: 'ebpf.master' },
    { path: 'name', label: '名称 name', type: 'text', optional: true },
    { custom: 'network' },
    { path: 'udp-timeout', label: 'UDP 超时(秒)', type: 'number', optional: true, placeholder: '内核默认 300，最小 5', desc: '可热更新：单独改它不重建入站，已建立的会话与热点客户端不会被打断' },
    { path: 'tc-priority', label: 'TC 优先级 tc-priority', type: 'number', optional: true, placeholder: '默认 1', desc: '默认 1：内核支持时经 TCX 挂载，否则 clsact；填其他值一律用 clsact 过滤器' },
    { path: 'bypass-rule-set', label: '绕行规则集', type: 'rulesetpick', optional: true, desc: '从已添加的规则集（rule-providers）中选择，命中的 CIDR 在内核里直接绕行。仅 behavior: ipcidr 的规则集会生效，其余被跳过；规则集内容自行更新无需重启内核' },
    { path: 'bypass-tun-direct', label: '绕过项直达(配合TUN)', type: 'bool', optional: true, boolAs: 'pick',
      desc: '内核默认开启。被 bypass 的目标仍走路由表、会被 TUN auto-route 声称：开启=命中绕行的流量到达时直接直连，不经 TUN 规则匹配；关闭=只报告与 TUN 的重叠、不做处理（进 TUN 后没有直连规则可能黑洞）。仅规则模式生效；bypass-private-address 的路由排除不受此开关影响' },
    { custom: 'fakeip-icmp' },
  ]},
  { title: 'local 模式（cgroup 本机应用）', fields: [
    { custom: 'local.enabled' },
    { path: 'local.data-plane', label: '数据面 data-plane', type: 'select', optional: true, allowEmpty: true,
      options: [['cgroup','cgroup 挂载（默认）'],['tc','tc egress + veth（内核 ≥5.7）']],
      desc: 'cgroup=接管本机套接字；tc=默认网卡 egress 抓包（内核运行时探测可用性）' },
    { path: 'local.cgroup-path', label: 'cgroup 路径', type: 'text', optional: true, placeholder: '留空自动探测，一般无需填写', desc: '仅 data-plane=cgroup 可填，且必须是 cgroup2 挂载内的绝对路径' },
    { path: 'local.dns-mode', label: 'DNS 处理 dns-mode', type: 'select', optional: true, allowEmpty: true,
      options: [['hijack','hijack 劫持（内核默认）'],['respect_policy','respect_policy 先按策略'],['off','off 不处理']],
      desc: 'hijack=接管所有 53 端口流量；respect_policy=先按 UID/来源策略；off=不处理' },
    { path: 'local.ipv6', label: '接管 IPv6', type: 'bool', optional: true, boolAs: 'pick', desc: '内核默认开启' },
    { path: 'local.bypass-private-address', label: '绕过私有地址', type: 'bool', optional: true, boolAs: 'pick', desc: '内核默认开启。开启=私有网段（10/8、172.16/12、192.168/16、100.64/10、169.254/16、fc00::/7、fe80::/10）不接管直连；网关想把 LAN 流量看进连接列表就选「关」' },
    { path: 'local.include-uid', label: '包含 UID', type: 'numlist', optional: true },
    { path: 'local.include-uid-range', label: '包含 UID 范围', type: 'list', optional: true, hint: 'start:end' },
    { path: 'local.exclude-uid', label: '排除 UID', type: 'numlist', optional: true },
    { path: 'local.exclude-uid-range', label: '排除 UID 范围', type: 'list', optional: true, hint: 'start:end' },
    { path: 'local.include-android-user', label: '包含安卓用户', type: 'numlist', optional: true, hint: '如 0、10（多开/工作资料）' },
    { path: 'local.include-package', label: '仅代理以下应用', type: 'applist', optional: true },
    { path: 'local.exclude-package', label: '排除以下应用', type: 'applist', optional: true },
    { path: 'local.bypass-port', label: '绕过目标端口', type: 'numlist', optional: true, hint: '如 22、3478', desc: '发往这些目标端口的流量一律不接管（DNS 劫持仍按 dns-mode 处理）' },
    { path: 'local.bypass-port-range', label: '绕过端口范围', type: 'list', optional: true, hint: 'start:end，如 27000:27100' },
  ]},
  { title: 'shared 模式（热点/共享网络 TC 转发）', fields: [
    { custom: 'shared.enabled' },
    { path: 'shared.data-plane', label: '数据面 data-plane', type: 'select', optional: true, allowEmpty: true,
      options: [['packet_rewrite','packet_rewrite 改写（默认）'],['socket_assign','socket_assign sk_assign（内核 ≥5.7）']],
      desc: 'packet_rewrite 需要以太网帧（MAC 名单也要）；raw-IP 链路（如部分 USB 网络共享）需 socket_assign' },
    { path: 'shared.dns-mode', label: 'DNS 处理 dns-mode', type: 'select', optional: true, allowEmpty: true,
      options: [['hijack','hijack 劫持（内核默认）'],['respect_policy','respect_policy 先按策略'],['off','off 不处理']],
      desc: 'hijack=接管所有 53 端口流量；respect_policy=先按 UID/来源策略；off=不处理' },
    { path: 'shared.interface', label: '下游接口', type: 'list', optional: true, hint: '如 wlan0、ap0、swlan0', desc: 'shared / hybrid 下必填且不能是 lo；正作为默认上游的接口会被暂时跳过，回到下游角色后自动接管' },
    { path: 'shared.ipv6', label: '接管 IPv6', type: 'bool', optional: true, boolAs: 'pick', desc: '内核默认开启' },
    { path: 'shared.bypass-private-address', label: '绕过私有地址', type: 'bool', optional: true, boolAs: 'pick', desc: '内核默认开启。开启=来自热点的私有网段目标不接管直连' },
    { path: 'shared.include-source-cidr', label: '包含来源 CIDR', type: 'list', optional: true, hint: '如 192.168.43.0/24' },
    { path: 'shared.exclude-source-cidr', label: '排除来源 CIDR', type: 'list', optional: true },
    { path: 'shared.include-mac-address', label: '包含 MAC', type: 'list', optional: true, hint: 'aa:bb:cc:dd:ee:ff' },
    { path: 'shared.exclude-mac-address', label: '排除 MAC', type: 'list', optional: true },
    { path: 'shared.bypass-port', label: '绕过目标端口', type: 'numlist', optional: true, hint: '如 22、3478', desc: '发往这些目标端口的下游流量一律不接管' },
    { path: 'shared.bypass-port-range', label: '绕过端口范围', type: 'list', optional: true, hint: 'start:end，如 27000:27100' },
  ]},
];

// 旧配置面 → 新配置面归一（对齐 liuran001/mihomo Alpha 文档 docs/ebpf-inbound.md）。
// 内核虽仍映射旧键，但死键会在启动日志里逐条报告，且旧键残留会让面板的
// 「默认（不覆写）」显示出与内核实际生效值不符的假象（如顶层 bypass-private-address: false）。
// 角色启用的两种等价写法（内核 normalizeModeWithEnabled）：
//   · local.enabled / shared.enabled：只要有一个「写了值」（true 或 false），就按它们判定；
//   · 否则看 mode（未写 == local）。
// 两者不能并存：写了 enabled 又写 mode，内核报 mode cannot be combined with ... 拒绝启动。
// 面板只产出 enabled 这一套写法；mode 仅在「读到旧配置」时参与判定，
// 随后由 normalizeEbpfLegacy 换算成 enabled 并删除，之后面板里不会再出现 mode。
// 面板所有「当前启用了哪些角色」的判断都走这里，避免各处各算一套。
export function ebpfRoles(eb) {
  const o = (eb && typeof eb === 'object' && !Array.isArray(eb)) ? eb : {};
  const blk = k => (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? o[k] : {});
  const le = blk('local').enabled, se = blk('shared').enabled;
  const usesEnabled = le !== undefined && le !== null || se !== undefined && se !== null;
  const hasMode = o.mode !== undefined && o.mode !== null && o.mode !== '';
  if (usesEnabled) {
    return { usesEnabled, hasMode, localOn: le === true, sharedOn: se === true, mode: null };
  }
  const mode = hasMode ? String(o.mode) : 'local';        // 未写 mode == local
  return { usesEnabled, hasMode, mode,
    localOn: mode === 'local' || mode === 'hybrid',
    sharedOn: mode === 'shared' || mode === 'hybrid' };
}

// 顶部总开关的副标题：写当前实际启用的角色（面板只用 enabled，旧配置里的 mode 会先被换算掉）
export function ebpfRoleSummary(eb) {
  const r = ebpfRoles(eb);
  const on = [r.localOn ? 'local' : null, r.sharedOn ? 'shared' : null].filter(Boolean).join(' + ');
  if (!on) return '两个模式都已关闭 · 不接管流量';     // 启用 TUN / TProxy 后就是这个状态
  return r.usesEnabled || !r.hasMode ? `enabled: ${on}` : `mode: ${r.mode}`;
}

// 纯函数：只改入参对象，返回是否有改动。
function normalizeEbpfLegacy(eb) {
  if (!eb || typeof eb !== 'object' || Array.isArray(eb)) return false;
  let changed = false;
  const ensure = r => (eb[r] && typeof eb[r] === 'object' && !Array.isArray(eb[r]) ? eb[r] : (eb[r] = {}));
  // enabled 在文档示例里是 local/shared 的首键：换算旧 mode 时按首位插入，
  // 直接赋值会追加到块末尾，和字段表（enabled 排第一）对不上。
  const setEnabledFirst = (r, v) => {
    const blk = ensure(r);
    if (blk.enabled === v) return;
    const rest = { ...blk };
    for (const k of Object.keys(blk)) delete blk[k];
    blk.enabled = v;
    for (const k of Object.keys(rest)) if (k !== 'enabled') blk[k] = rest[k];
  };
  // 角色判定先算出来：mode 换算要用它，顶层旧键往哪个角色折叠也要用它。
  const _r = ebpfRoles(eb);
  const roles = [];
  if (_r.localOn) roles.push('local');
  if (_r.sharedOn) roles.push('shared');
  // mode → local.enabled / shared.enabled。面板只产出 enabled 一种写法，
  // 读到的旧 mode 在这里一次性换算掉（两者并存内核直接拒绝启动，所以 mode 必须删）。
  // 已经写了 enabled 的配置不受影响：ebpfRoles 此时按 enabled 判定，删 mode 不改变语义。
  if (_r.hasMode) {
    if (!_r.usesEnabled) {                    // 纯 mode 写法：按 mode 推出的角色落成 enabled
      setEnabledFirst('local', _r.localOn);
      setEnabledFirst('shared', _r.sharedOn);
    }
    delete eb.mode; changed = true;
  }
  // 顶层 dns-mode / bypass-private-address → 各启用角色（与内核默认相同就只删，不留冗余）
  const TOP_DEFAULTS = { 'dns-mode': 'hijack', 'bypass-private-address': true };
  for (const key of Object.keys(TOP_DEFAULTS)) {
    if (eb[key] === undefined) continue;
    const v = eb[key];
    if (v !== TOP_DEFAULTS[key]) {
      for (const r of roles) {
        const blk = ensure(r);
        if (blk[key] === undefined) blk[key] = v;
      }
    }
    delete eb[key]; changed = true;
  }
  if ('tcp-splice' in eb) { delete eb['tcp-splice']; changed = true; }   // 死键：内核已停用
  for (const r of ['local', 'shared']) {
    const blk = eb[r];
    if (!blk || typeof blk !== 'object' || Array.isArray(blk)) continue;
    if ('state-capacity' in blk) { delete blk['state-capacity']; changed = true; } // 旧键：移除
    const im = blk['ipv6-mode'];
    if (im !== undefined) {                               // ipv6-mode(auto/always/off) → ipv6 布尔
      if (im === 'always' || im === 'auto' || im === true) blk['ipv6'] = true;
      else if (im === 'off' || im === false) blk['ipv6'] = false;
      delete blk['ipv6-mode']; changed = true;
    }
    if (blk['dns-mode'] === 'respect_bypass') { blk['dns-mode'] = 'respect_policy'; changed = true; }   // 旧别名
  }
  const sh = eb.shared;
  if (sh && typeof sh === 'object' && !Array.isArray(sh) && sh.advanced && typeof sh.advanced === 'object') {
    const adv = sh.advanced;
    if (adv['tc-priority'] !== undefined) { if (eb['tc-priority'] === undefined) eb['tc-priority'] = adv['tc-priority']; delete adv['tc-priority']; changed = true; }
    if (adv['data-plane'] !== undefined) { if (sh['data-plane'] === undefined) sh['data-plane'] = adv['data-plane']; delete adv['data-plane']; changed = true; }
    for (const k of ['routing-mark', 'routing-table']) {  // 死键：内核已停用
      if (k in adv) { delete adv[k]; changed = true; }
    }
    if (!Object.keys(adv).length) delete sh.advanced;
  }
  const cleanNulls = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      if (o[k] === null || o[k] === undefined) { delete o[k]; changed = true; }
      else if (typeof o[k] === 'object' && !Array.isArray(o[k])) cleanNulls(o[k]);
    }
  };
  cleanNulls(eb);
  return changed;
}

// 内核会当场拒绝启动的组合，提前在页面上说清楚（纯函数，供 node 端提取测试）。
// 只报「内核明确报错」的几条，不替内核猜运行时探测的结果（TCX / sk_assign 可用性等）。
export function ebpfConfigWarnings(eb, cfg) {
  const out = [];
  if (!eb || typeof eb !== 'object' || Array.isArray(eb)) return out;
  const roles = ebpfRoles(eb);
  const { localOn, sharedOn } = roles;
  const mode = roles.mode;
  const blk = k => (eb[k] && typeof eb[k] === 'object' && !Array.isArray(eb[k]) ? eb[k] : {});
  const local = blk('local'), shared = blk('shared');
  const arr = v => (Array.isArray(v) ? v.filter(x => x !== undefined && x !== null && x !== '') : []);

  // enabled 与 mode 并存 / 两个 enabled 都关：内核两条明确的报错。
  // 前者正常见不到——打开页面时 normalizeEbpfLegacy 已把 mode 换算掉；
  // 只有在源码编辑器里手写回 mode 才会命中，所以照样留着。
  if (roles.usesEnabled && roles.hasMode) {
    out.push('同时写了 <code>mode</code> 和 <code>local.enabled</code>/<code>shared.enabled</code>：内核会报「mode cannot be combined with local.enabled or shared.enabled」并拒绝启动。本面板只用 <code>enabled</code>，请删掉 <code>mode</code>。');
  }
  // 两个角色都不开 = eBPF 停用（启用 TUN / TProxy 时模块就是这么写的）。
  // 内核在 normalizeModeWithEnabled 这一步就返回错误并跳过该入站，后面的逐项校验根本
  // 走不到，所以这里只说这一条，不再把保留下来的策略键当成错误一并报出来。
  const bothOff = !localOn && !sharedOn;
  if (bothOff) {
    out.push('<code>local.enabled</code> 与 <code>shared.enabled</code> 都不是「开」：内核会报「local.enabled or shared.enabled must be enabled」并跳过该入站，eBPF 不接管任何流量。启用 TUN / TProxy 时这是正常状态；要恢复 eBPF，把 local 或 shared 的开关打开即可（其余参数都还在）。');
  }
  if (mode !== null && !['local', 'shared', 'hybrid'].includes(mode)) {
    out.push(`残留的旧键 <code>mode: ${mode}</code> 不是 local / shared / hybrid，内核会以「unknown eBPF mode」拒绝启动。`);
  }
  // shared 必填 interface；lo 被内核显式拒绝（都只在 shared 真正启用时才校验）
  if (sharedOn && !arr(shared.interface).length) {
    out.push('已启用 shared，但<b>下游接口为空</b>：内核要求 <code>shared.interface</code> 至少一个接口，否则拒绝启动。');
  }
  if (sharedOn && arr(shared.interface).some(x => String(x).trim() === 'lo')) {
    out.push('<code>shared.interface</code> 含 <code>lo</code>：内核不接受回环接口，会拒绝启动。');
  }
  // 关闭的角色不能带策略键（内核逐项报 “requires local or hybrid mode”）
  // 旧配置残留 mode 时按 mode 措辞，正常（enabled）写法直接说「未启用」
  const roleSrc = roles.usesEnabled || !roles.hasMode ? '' : `模式为 <code>${mode}</code> 时`;
  const LOCAL_KEYS = ['dns-mode', 'ipv6', 'bypass-private-address', 'include-uid', 'include-uid-range',
    'exclude-uid', 'exclude-uid-range', 'include-android-user', 'include-package', 'exclude-package'];
  const SHARED_KEYS = ['dns-mode', 'ipv6', 'bypass-private-address', 'interface',
    'include-source-cidr', 'exclude-source-cidr', 'include-mac-address', 'exclude-mac-address'];
  const stray = (blkObj, keys) => keys.filter(k => {
    const v = blkObj[k];
    if (v === undefined || v === null) return false;
    return Array.isArray(v) ? v.length > 0 : true;
  });
  if (!localOn && !bothOff) {
    const s = stray(local, LOCAL_KEYS);
    if (s.length) out.push(`${roleSrc}未启用 local，却填了 local 策略（${s.map(k => '<code>local.' + k + '</code>').join('、')}）：内核会报「requires local or hybrid mode」并拒绝启动，请启用 local 或清空这些项。`);
  }
  if (!sharedOn && !bothOff) {
    const s = stray(shared, SHARED_KEYS);
    if (s.length) out.push(`${roleSrc}未启用 shared，却填了 shared 策略（${s.map(k => '<code>shared.' + k + '</code>').join('、')}）：内核会报「requires shared or hybrid mode」并拒绝启动，请启用 shared 或清空这些项。`);
  }
  // cgroup-path 仅 data-plane=cgroup 可用，且必须绝对路径
  const cg = local['cgroup-path'];
  if (cg !== undefined && cg !== null && String(cg).trim() !== '') {
    if (local['data-plane'] && local['data-plane'] !== 'cgroup') {
      out.push('<code>local.cgroup-path</code> 只在 <code>local.data-plane: cgroup</code> 下可用，当前数据面是 <code>tc</code>，内核会拒绝启动。');
    }
    if (!String(cg).startsWith('/')) out.push('<code>local.cgroup-path</code> 必须是绝对路径（以 / 开头），内核会拒绝相对路径。');
  }
  // fakeip-icmp: reply 的两个前置条件
  if (eb['fakeip-icmp'] === 'reply') {
    const dns = (cfg && cfg.dns && typeof cfg.dns === 'object') ? cfg.dns : {};
    const hasFakeIp = !!(dns['fake-ip-range'] || dns['fake-ip-range6']);
    if (!hasFakeIp) out.push('<code>fakeip-icmp: reply</code> 需要已配置 fake-ip 范围（<code>dns.fake-ip-range</code>），否则内核拒绝启动。');
    const localTc = localOn && local['data-plane'] === 'tc';
    if (!localTc && !sharedOn) {
      out.push('<code>fakeip-icmp: reply</code> 的回应程序挂在 TC 钩子上：需要 <code>local.data-plane: tc</code> 或启用 shared。当前 local=cgroup 且没有 shared，内核会拒绝启动。');
    }
  }
  // 与 TUN 的已知冲突（文档「Coexisting with TUN」明确点名）
  const tun = (cfg && cfg.tun && typeof cfg.tun === 'object') ? cfg.tun : {};
  const tunListener = Array.isArray(cfg && cfg.listeners) ? cfg.listeners.find(x => x && x.type === 'tun') : null;
  const tunOn = !!tun.enable || !!tunListener;
  if (sharedOn && tunOn && (tun['auto-redirect'] || (tunListener && tunListener['auto-redirect']))) {
    out.push('shared 模式与 TUN <code>auto-redirect</code> 同时开启：TC ingress 会在 netfilter 之前改写目标，两者不要挂在同一接口上。');
  }
  if (tunOn && (tun['strict-route'] || (tunListener && tunListener['strict-route']))) {
    out.push('TUN <code>strict-route</code> 建议关闭：它会重排本入站重定向地址所依赖的策略路由。');
  }
  return out;
}

function ebpfObj() {
  const l = state.cfg.listeners;
  if (Array.isArray(l)) return l.find(x => x && x.type === 'ebpf') || null;
  return null;
}
function ensureEbpf() {
  let obj = ebpfObj();
  if (obj) return obj;
  if (!Array.isArray(state.cfg.listeners) || !state.cfg.listeners) state.cfg.listeners = [];
  obj = EBPF_TPL();
  state.cfg.listeners.push(obj);
  markDirty();
  return obj;
}
// #EBPF-KEEP-BEGIN 纯文本函数（供 node 端提取测试，勿依赖模块作用域变量）
// ——— 监听器纯文本定位与摘除 ———
// 用于「入站」列表中删除条目时的纯文本摘除（只摘掉该条目自己的行，块内其余注释与条目逐字不动），
// 以及 TUN 监听器的注释与反注释。
// eBPF 入站的启停已完全统一为 local.enabled / shared.enabled，不再使用 # 文本注释。
function ebpfIndentOf(l) { const m = String(l).match(/^[ \t]*/); return m[0].length; }
// 定位顶层 listeners: 块中特定类型（或全部）条目的行区间 [from,to)（0 基，含尾随空行/注释行）。
// commented=false 找活跃条目；=true 找已注释条目。返回 [{from,to}]。
// 条目分界按「破折号列位」且活跃/注释两类各自跟踪：统一注释风格下嵌套列表行
// （`  #       - wlan2`）的 # 后也有破折号，若按行首缩进会把条目从中切碎。
function listenersEntryRanges(raw, commented, typeName) {
  const lines = String(raw == null ? '' : raw).split('\n');
  // typeName=null：不做类型过滤（用于「删除任意入站」时按行定位条目）
  const isType = (l, cmt) => {
    if (!typeName) return true;
    const t = typeName;
    return cmt
      ? (new RegExp("^[ \\t]*#[ \\t]*type:[ \\t]*['\"]?" + t + "['\"]?").test(l) || new RegExp("^[ \\t]*#[ \\t]*-[ \\t]+type:[ \\t]*['\"]?" + t + "['\"]?").test(l))
      : (new RegExp("^[ \\t]*type:[ \\t]*['\"]?" + t + "['\"]?").test(l) || new RegExp("^[ \\t]*-[ \\t]+type:[ \\t]*['\"]?" + t + "['\"]?").test(l));
  };
  const out = [];
  let inLs = false, baseA = -1, baseC = -1, cur = null;
  const flush = () => {
    if (!cur) return;
    if (cur.cmt === !!commented && lines.slice(cur.from, cur.to).some(l => isType(l, cur.cmt))) {
      out.push({ from: cur.from, to: cur.to });
    }
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 顶格非空白非 # 行 = 顶层键/文档分隔符：结束 listeners 块
    if (l.length && !/^[ \t#]/.test(l)) { flush(); inLs = /^listeners:/.test(l); baseA = -1; baseC = -1; continue; }
    if (!inLs) continue;
    const d = l.replace(/\r$/, '');
    let col = -1, isCmt = false, m = d.match(/^([ \t]*)-(?:[ \t]|$)/);
    if (m) { col = m[1].length; }
    else if ((m = d.match(/^([ \t]*)#([ \t]*)-(?:[ \t]|$)/))) { col = m[1].length + 1 + m[2].length; isCmt = true; }
    if (col >= 0) {
      const base = isCmt ? baseC : baseA;
      if (base < 0 || col <= base) {
        flush();
        if (base < 0 || col < base) { if (isCmt) baseC = col; else baseA = col; }
        cur = { from: i, to: i + 1, cmt: isCmt };
        continue;
      }
    }
    if (cur) cur.to = i + 1;    // 续行：嵌套列表、块内注释、空行
  }
  flush();
  return out;
}
// 找到条目所属的顶层 `listeners:` 头行下标（向上跳过空行/注释/缩进行，撞到另一个顶格键就停）。
function ebpfHeaderIndex(lines, from) {
  for (let i = from - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim() || /^[ \t#]/.test(l)) continue;
    return /^listeners:/.test(l) ? i : -1;
  }
  return -1;
}
// 入站被删空时文本层会把该段塌缩成流式空列表（`listeners: []`，或旧格式 `listeners: null`），
// 注释保留段还在它下面。恢复时光去注释会得到「流式空列表下挂块式序列」的非法 YAML，
// 所以要把头行重新展开回块式 `listeners:`（行尾注释原样保留）。
function ebpfExpandEmptyHeader(lines, hi) {
  if (hi < 0) return;
  const m = /^listeners:[ \t]*(?:\[\]|null)[ \t]*(#.*)?$/.exec(lines[hi]);
  if (m) lines[hi] = 'listeners:' + (m[1] ? ' ' + m[1] : '');
}
// 删除一条入站的纯文本手术：只摘掉该条目自己的行，块内其余内容（注释、别的条目）逐字不动。
// 定位不可信（流式写法、条目数与模型对不上、缩进异常）时返回 null，由调用方退回模型路径。
function inboundRemoveText(raw, idx, expectCount) {
  const ranges = listenersEntryRanges(raw, false, null);
  if (!ranges.length || ranges.length !== expectCount) return null;
  const r = ranges[idx];
  if (!r) return null;
  const lines = String(raw == null ? '' : raw).split('\n');
  const hi = ebpfHeaderIndex(lines, r.from);
  let to = r.to;
  const entryIndent = ebpfIndentOf(lines[r.from]);
  while (to - 1 > r.from) {
    const l = lines[to - 1];
    if (!l.trim()) { to--; continue; }
    if (ebpfIndentOf(l) <= entryIndent && /^[ \t]*#/.test(l)) { to--; continue; }
    break;
  }
  lines.splice(r.from, to - r.from);
  if (hi >= 0 && hi < r.from && /^listeners:[ \t]*$/.test(lines[hi])) {
    let more = false;
    for (let i = hi + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim() || /^[ \t]*#/.test(l)) continue;
      more = /^[ \t]/.test(l);
      break;
    }
    if (!more) lines[hi] = 'listeners: []';
  }
  return { text: lines.join('\n'), count: 1 };
}
// #EBPF-KEEP-END

// 删除入站：先做纯文本手术（块内其它行逐字不动），模型只随重解析同步。
// 返回 false 表示这份文本形态不可信（流式写法等），调用方退回「改模型 + markDirty」路径。
function inboundRemoveKeepText(idx) {
  if (state.cfgError) return false;
  const r = inboundRemoveText(state.raw, idx, inArr().length);
  if (!r) return false;
  const p = parseConfigText(r.text);
  if (!p.obj || p.err) return false;      // 手术结果不自洽：宁可不改，也不留下半截文本
  const list = (p.obj.listeners || []);
  if (list.length !== Math.max(inArr().length - 1, 0)) return false;
  return applyConfigDraft(r.text);
}

// 供 eBPF 页总开关、「启用 TUN」与 TProxy 关闭后的「选择接管方式」使用。
// 启用：若无条目则模板新建；若角色全关则置 local.enabled: true + shared.enabled: true；
// 关闭：置 local.enabled: false + shared.enabled: false —— 内核在 normalizeModeWithEnabled
// 就会报 local.enabled or shared.enabled must be enabled 并跳过该入站，eBPF 完全不接管；
// 条目本身连同用户的全部参数原样留在文件里，重新启用只要把开关打回 true。
// 全程不使用 # 文本注释，配置文件整洁且与源码编辑器完全自洽。
export function setEbpfEnabled(enabled) {
  let eb = ebpfObj();
  if (enabled) {
    if (!eb) eb = ensureEbpf();
    if (!eb) return false;
    if (!ebpfRoles(eb).localOn && !ebpfRoles(eb).sharedOn) return ebpfSetRoles(eb, true, true);
    return true;
  }
  if (!eb) return true;                       // 没有条目＝已经是关闭
  return ebpfSetRoles(eb, false, false);
}

// 统一写入两个角色开关：mode 与 enabled 不能并存，写之前先摘掉残留的 mode。
function ebpfSetRoles(eb, localOn, sharedOn) {
  if (!eb || typeof eb !== 'object') return false;
  if (eb.mode !== undefined && unset(eb, 'mode') === false) return false;
  if (set(eb, 'local.enabled', !!localOn) === false) return false;
  if (set(eb, 'shared.enabled', !!sharedOn) === false) return false;
  return true;
}

// TUN 监听器也要和顶层 tun.enable 一起切换。TProxy 关闭时会先恢复它，
// 选择 eBPF 后若只改 tun.enable，listeners[].type=tun 仍可能继续抢占透明流量。
function tunEntryRanges(raw, commented) { return listenersEntryRanges(raw, commented, 'tun'); }
function tunCommentOutText(raw) {
  const ranges = tunEntryRanges(raw, false);
  if (!ranges.length) return null;
  const lines = String(raw == null ? '' : raw).split('\n');
  for (const r of ranges) {
    const ind = ebpfIndentOf(lines[r.from]);
    const to = ownedEntryTo(lines, r);
    for (let i = r.from; i < to; i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      const at = Math.min(ind, ebpfIndentOf(l));
      lines[i] = l.slice(0, at) + '# ' + l.slice(at);
    }
  }
  return { text: lines.join('\n'), count: ranges.length };
}
function tunUncommentText(raw) {
  const ranges = tunEntryRanges(raw, true);
  if (!ranges.length) return null;
  const lines = String(raw == null ? '' : raw).split('\n');
  for (const r of ranges) {
    const to = ownedEntryTo(lines, r);
    for (let i = r.from; i < to; i++) lines[i] = lines[i].replace(/^([ \\t]*)# ?/, '$1');
  }
  const heads = new Set(ranges.map(r => ebpfHeaderIndex(lines, r.from)).filter(i => i >= 0));
  heads.forEach(hi => ebpfExpandEmptyHeader(lines, hi));
  return { text: lines.join('\n'), count: ranges.length };
}

export function setTunListenerEnabled(enabled) {
  if (state.cfgError) return false;
  const r = enabled ? tunUncommentText(state.raw) : tunCommentOutText(state.raw);
  if (!r) return true;
  const p = parseConfigText(r.text);
  if (!p.obj || p.err) return false;
  return applyConfigDraft(r.text);
}

function renderEbpfFields(eb, onRefresh) {
  const box = h('div', {});
  const netVal = () => {
    const a = Array.isArray(eb.network) ? eb.network.map(String) : [];
    if (!a.length) return '';
    return a.includes('tcp') && a.includes('udp') ? 'tcp+udp' : (a.includes('tcp') ? 'tcp' : 'udp');
  };
  const renderNetworkRow = () => {
    const sel = selectCtl([
      ['', '默认（不覆写）'],
      ['tcp', '仅 TCP'],
      ['udp', '仅 UDP'],
      ['tcp+udp', 'TCP + UDP'],
    ], netVal(), { title: '监听协议' });
    sel.addEventListener('change', () => {
      const v = sel.value;
      if (v === '') unset(eb, 'network');
      else set(eb, 'network', v === 'tcp+udp' ? ['tcp', 'udp'] : [v]);
    });
    return h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, '监听协议 network', h('div', { class: 'f-desc', text: '不覆写时内核默认 tcp+udp' })),
      h('div', { class: 'f-ctl' }, sel));
  };

  const renderFakeIpIcmpRow = () => {
    const cur = eb['fakeip-icmp'];
    const sel = selectCtl([
      ['', '默认（不覆写）'],
      ['off', 'off 不处理（内核默认）'],
      ['reply', 'reply 内核直接回应 Echo'],
    ], cur === undefined || cur === null ? '' : String(cur), { title: 'FakeIP ICMP' });
    sel.addEventListener('change', () => {
      const v = sel.value;
      if (v === '') unset(eb, 'fakeip-icmp');
      else set(eb, 'fakeip-icmp', v);
      if (typeof onRefresh === 'function') onRefresh();
    });
    return h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, 'FakeIP ICMP fakeip-icmp',
        h('div', { class: 'f-desc', text: 'reply=在内核里把发往 fake-ip 的 ICMP Echo 请求直接回成应答，让 ping 通（只说明该地址是 fake-ip，不代表域名可达）。要求已配置 fake-ip 范围，且 local 数据面为 tc 或启用了 shared——local=cgroup 且无 shared 时内核会拒绝启动' })),
      h('div', { class: 'f-ctl' }, sel));
  };

  const renderMasterEnabledRow = () => {
    const roles = ebpfRoles(eb);
    // 如果两个模式中有任意一个模式关闭，总开关也同步关闭
    const masterOn = roles.localOn && roles.sharedOn;
    const desc = masterOn
      ? '同时接管本机应用（local）与热点/共享网络（shared）流量'
      : (!roles.localOn && !roles.sharedOn
        ? '两个模式都已关闭 · 不接管流量'
        : (roles.localOn
          ? '已开启 local 模式（任一模式关闭则总开关保持关闭）'
          : '已开启 shared 模式（任一模式关闭则总开关保持关闭）'));
    return h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, 'eBPF 入站总开关',
        h('div', { class: 'f-desc', text: desc })),
      h('div', { class: 'f-ctl' }, switchCtl(masterOn, (v) => {
        if (eb.mode !== undefined) unset(eb, 'mode');
        set(eb, 'local.enabled', v);
        set(eb, 'shared.enabled', v);
        requestServiceRestartOnSave();   // 接管方式变更：保存后重启服务
        rerender();
      })));
  };

  const renderEnabledRow = (role) => {
    const roles = ebpfRoles(eb);
    const on = role === 'local' ? roles.localOn : roles.sharedOn;
    const label = role === 'local' ? '启用 local（本机应用）' : '启用 shared（热点/共享网络）';
    const desc = role === 'local'
      ? '接管本机应用的流量（cgroup 或 tc 数据面）。对应 <code>local.enabled</code>'
      : '接管下游接口转发来的流量（TC 数据面），需要在下方填写下游接口。对应 <code>shared.enabled</code>';
    const other = role === 'local' ? roles.sharedOn : roles.localOn;
    const hint = !on && !other
      ? '　⚠️ 两个模式都已关闭 = eBPF 不接管任何流量（内核会跳过该入站）'
      : '';
    return h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, label,
        h('div', { class: 'f-desc', html: desc + hint })),
      h('div', { class: 'f-ctl' }, switchCtl(on, (v) => {
        if (eb.mode !== undefined) unset(eb, 'mode');
        set(eb, role + '.enabled', v);
        requestServiceRestartOnSave();   // 接管方式变更：保存后重启服务
        rerender();
      })));
  };

  const CUSTOM_ROWS = {
    'ebpf.master': renderMasterEnabledRow,
    network: renderNetworkRow,
    'fakeip-icmp': renderFakeIpIcmpRow,
    'local.enabled': () => renderEnabledRow('local'),
    'shared.enabled': () => renderEnabledRow('shared'),
  };

  function rerender() {
    box.innerHTML = '';
    renderContent();
    if (typeof onRefresh === 'function') onRefresh();
  }

  function renderContent() {
    for (const sec of EBPF_SECTIONS) {
      box.append(groupTitle(sec.title));
      const c = card();
      for (const f of sec.fields) {
        if (f.path === 'name') continue;
        c.append(f.custom ? CUSTOM_ROWS[f.custom]() : fieldRow(f, eb));
      }
      box.append(c);
    }

    // 环境自检
    const chk = card();
    const resBox = h('pre', { class: 'logbox', text: '点击右上角按钮检测当前内核是否支持 eBPF 入站…' });
    const btn = h('button', { class: 'btn pri sm', text: '开始自检' });
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '检测中…';
      const r = await window.shellCmd('check-env');
      let out = r.stdout || r.stderr;
      const j = parseJsonLoose(r && r.stdout);
      if (j) {
        const lines = [];
        const item = (ok, name, extra) => lines.push(`${ok === null ? '❔' : ok ? '✅' : '⚠️'} ${name}${extra ? '：' + extra : ''}`);
        item(true, '系统内核', `${j.kernel || '?'}（${j.arch || '?'}）`);
        item(j.cgroup_v2 === 1, 'cgroup v2 已挂载',
          j.cgroup_v2 === 1 ? `${j.cgroup_path || ''}（cgroup 路径留空即自动探测）` : 'eBPF 入站要求 cgroup v2，v1 会被直接拒绝');
        if (j.bpf_mount === 1) item(true, 'bpf 文件系统已挂载', j.bpf_mount_path || '');
        else item(j.bpf_fs === 1 ? null : false, 'bpf 文件系统已挂载',
          j.bpf_fs === 1 ? '类型已编译进内核但未见挂载点' : '内核未编译 bpf 文件系统');
        if (j.config_gz === 1) {
          item(j.k_bpf === 'y', 'CONFIG_BPF');
          item(j.k_bpf_syscall === 'y', 'CONFIG_BPF_SYSCALL', 'BPF 系统调用');
          item(j.k_cgroup_bpf === 'y', 'CONFIG_CGROUP_BPF', 'eBPF 入站必需');
          item(j.k_bpf_jit === 'y', 'CONFIG_BPF_JIT', '推荐，影响转发吞吐');
          item(j.k_net_cls_bpf === 'y', 'CONFIG_NET_CLS_BPF', 'shared 模式 TC 回落需要');
        } else item(null, '内核编译选项', '内核未提供 /proc/config.gz，无法核查');
        item(j.bpf_syscall === 1 ? true : j.bpf_syscall === 0 ? false : null, 'BPF 系统调用探测',
          j.bpf_syscall === 1 ? 'bpftool 运行时探测通过' : j.bpf_syscall === 0 ? 'bpftool 探测失败' : '未检测到 bpftool');
        item(j.bpftool === 1 ? true : null, 'bpftool 可用', j.bpftool === 1 ? '' : '未检测到（非必需）');
        item(j.tcx === 1 ? true : null, 'TCX 挂载', j.tcx === 1 ? '内核 ≥6.6，tc-priority=1 经 TCX 挂载' : '内核 <6.6，自动回落 clsact 过滤器（可正常用）');
        item(null, 'RLIMIT_MEMLOCK', `${j.memlock_kb || '未知'}${String(j.memlock_kb).toLowerCase() === 'unlimited' ? '' : ' KB'}（eBPF 地图占用，root 下通常不受限）`);
        if (j.advice && j.advice.length) {
          lines.push('', '💡 建议：');
          j.advice.forEach(a => lines.push('  · ' + a));
        }
        out = lines.join('\n');
      }
      resBox.textContent = out || '(无输出)';
      btn.disabled = false; btn.textContent = '重新自检';
    };
    // 按钮放卡片右上角（与「N 个监听器」等卡片同一形态），结果区占满卡体
    chk.append(h('div', { class: 'card-head' }, h('h3', { text: 'eBPF 环境自检' }), btn), resBox);
    box.append(chk);
  }

  renderContent();
  return box;
}

// ============================================================
// 域名嗅探
// ============================================================
const SNIFF_SECTIONS = [
  { note: '域名嗅探 sniffer：从 TLS/HTTP/QUIC 握手中恢复域名，增强规则匹配（尤其 fake-ip / 纯 IP 场景）。' },
  { title: '基础', fields: [
    { path: 'sniffer.enable', label: '启用嗅探', type: 'bool', optional: true },
    { path: 'sniffer.force-dns-mapping', label: '强制 DNS 映射', type: 'select', allowEmpty: true, optional: true, bool: true, options: [[true, '开启'], [false, '关闭']], desc: '内核默认开启；对解析后 IP 的连接映射回域名再匹配规则' },
    { path: 'sniffer.parse-pure-ip', label: '解析纯 IP 请求', type: 'select', allowEmpty: true, optional: true, bool: true, options: [[true, '开启'], [false, '关闭']], desc: '内核默认开启；目标是纯 IP 的连接也进行嗅探' },
    { path: 'sniffer.override-destination', label: '覆盖目标地址', type: 'select', allowEmpty: true, optional: true, bool: true, options: [[true, '开启'], [false, '关闭']], desc: '内核默认开启；用嗅探出的域名覆盖连接的目标 IP' },
  ]},
  { title: '协议端口与覆盖', fields: [
    { path: 'sniffer.sniff.HTTP.ports', label: 'HTTP 监听端口', type: 'numlist', optional: true, hint: '如 80, 8080' },
    { path: 'sniffer.sniff.HTTP.override-destination', label: 'HTTP 覆盖目标地址', type: 'bool', optional: true },
    { path: 'sniffer.sniff.TLS.ports', label: 'TLS 监听端口', type: 'numlist', optional: true, hint: '如 443, 8443' },
    { path: 'sniffer.sniff.TLS.override-destination', label: 'TLS 覆盖目标地址', type: 'bool', optional: true },
    { path: 'sniffer.sniff.QUIC.ports', label: 'QUIC 监听端口', type: 'numlist', optional: true, hint: '如 443' },
    { path: 'sniffer.sniff.QUIC.override-destination', label: 'QUIC 覆盖目标地址', type: 'bool', optional: true },
  ]},
  { title: '嗅探名单', fields: [
    { path: 'sniffer.force-domain', label: '强制嗅探的域名', type: 'list', optional: true, hint: '如 +.v2ex.com' },
    { path: 'sniffer.skip-domain', label: '跳过嗅探的域名', type: 'list', optional: true, hint: '如 Mijia Cloud / +.apple.com' },
    { path: 'sniffer.skip-src-address', label: '跳过来源地址段', type: 'list', optional: true, hint: 'CIDR' },
    { path: 'sniffer.skip-dst-address', label: '跳过目标地址段', type: 'list', optional: true, hint: 'CIDR' },
  ]},
];
export function renderSniff(el) { return renderKeepScroll(() => renderSections(el, SNIFF_SECTIONS)); }

// ============================================================
// 入站 listeners 编辑器
// ============================================================
const IN_TYPES = [
  ['http', 'http'],
  ['socks', 'socks'],
  ['mixed', 'mixed 混合'],
  ['redirect', 'redirect 透明'],
  ['tproxy', 'tproxy 透明'],
  ['tun', 'tun 接管（高级）'],
  ['ebpf', 'ebpf 透明（liuran001）'],
  ['shadowsocks', 'shadowsocks'],
  ['vmess', 'vmess'],
  ['vless', 'vless'],
  ['trojan', 'trojan'],
  ['anytls', 'anytls'],
  ['mieru', 'mieru'],
  ['sudoku', 'sudoku'],
  ['tuic', 'tuic（v4 token / v5 users）'],
  ['shadowquic', 'shadowquic'],
  ['hysteria2', 'hysteria2'],
  ['hysteria2-realm', 'hysteria2-realm'],
  ['trusttunnel', 'trusttunnel'],
  ['tunnel', 'tunnel 端口转发'],
  ['snell', 'snell'],
];
const IN_TEMPLATES = {
  mixed:       { name: 'mixed-in', type: 'mixed', port: 7890, listen: '0.0.0.0' },
  http:        { name: 'http-in', type: 'http', port: 7891, listen: '0.0.0.0' },
  socks:       { name: 'socks-in', type: 'socks', port: 7892, listen: '0.0.0.0' },
  redirect:    { name: 'redirect-in', type: 'redirect', port: 7893, listen: '0.0.0.0' },
  tproxy:      { name: 'tproxy-in', type: 'tproxy', port: 7894, listen: '0.0.0.0' },
  tunnel:      { name: 'tunnel-in', type: 'tunnel', port: 10090, listen: '0.0.0.0', network: ['tcp', 'udp'], target: 'www.example.com:80' },
  tun:         { name: 'tun-in', type: 'tun', stack: 'system', 'dns-hijack': ['0.0.0.0:53'], 'inet4-address': ['198.19.0.1/30'], mtu: 9000, 'auto-route': true, 'auto-detect-interface': true },
  ebpf:        EBPF_TPL(),
  shadowsocks: { name: 'ss-in', type: 'shadowsocks', port: 10000, listen: '0.0.0.0', cipher: 'aes-256-gcm', password: '密码' },
  vmess:       { name: 'vmess-in', type: 'vmess', port: 10001, listen: '0.0.0.0', users: [{ username: 'user1', uuid: '', alterId: 0 }] },
  vless:       { name: 'vless-in', type: 'vless', port: 10002, listen: '0.0.0.0', users: [{ username: 'user1', uuid: '' }] },
  trojan:      { name: 'trojan-in', type: 'trojan', port: 10003, listen: '0.0.0.0', users: [{ username: 'user1', password: '' }], certificate: './server.crt', 'private-key': './server.key' },
  snell:       { name: 'snell-in', type: 'snell', port: 10815, listen: '0.0.0.0', psk: 'snell-psk', version: 4 },
  anytls:      { name: 'anytls-in', type: 'anytls', port: 10018, listen: '0.0.0.0', users: { user1: 'password1' }, certificate: './server.crt', 'private-key': './server.key' },
  mieru:       { name: 'mieru-in', type: 'mieru', port: 10019, listen: '0.0.0.0', transport: 'TCP', users: { user1: 'password1' } },
  sudoku:      { name: 'sudoku-in', type: 'sudoku', port: 8443, listen: '0.0.0.0', key: 'server-public-key-or-uuid', 'aead-method': 'chacha20-poly1305' },
  trusttunnel: { name: 'trusttunnel-in', type: 'trusttunnel', port: 10021, listen: '0.0.0.0', users: [{ username: 'user1', password: 'pass1' }], certificate: './server.crt', 'private-key': './server.key', 'congestion-controller': 'bbr' },
  hysteria2:   { name: 'hy2-in', type: 'hysteria2', port: 10004, listen: '0.0.0.0', users: { user1: 'password1' }, certificate: './server.crt', 'private-key': './server.key' },
  'hysteria2-realm': { name: 'hy2realm-in', type: 'hysteria2-realm', port: 10820, listen: '0.0.0.0', token: 'public' },
  shadowquic:  { name: 'sq-in', type: 'shadowquic', port: 10822, listen: '0.0.0.0', users: [{ username: 'user', password: 'pass' }], 'jls-upstream': { addr: 'www.example.com:443' } },
  tuic:        { name: 'tuic-in', type: 'tuic', port: 10005, listen: '0.0.0.0', users: { '00000000-0000-0000-0000-000000000000': 'password1' }, certificate: './server.crt', 'private-key': './server.key' },
};
// 需要 TLS 证书字段的类型
const IN_TLS_TYPES = new Set(['vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'anytls', 'trusttunnel', 'hysteria2-realm']);
// 支持 REALITY / 传输层（ws、grpc）的类型
const IN_REALITY_TYPES = new Set(['vmess', 'vless', 'trojan']);
const IN_TRANSPORT_TYPES = new Set(['vmess', 'vless', 'trojan']);
// 支持 mux-option 的类型
const IN_MUX_TYPES = new Set(['vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'shadowsocks']);
// 支持 shadow-tls / res-tls / jls-config 伪装层的类型
const IN_DISGUISE_TYPES = new Set(['vmess', 'vless', 'trojan']);

// TLS 伪装层：shadow-tls / res-tls / jls-config
const IN_DISGUISE_FIELDS = [
  { path: 'shadow-tls.enable', label: '启用 ShadowTLS', type: 'bool', optional: true },
  { path: 'shadow-tls.version', label: 'ShadowTLS 版本', type: 'select', allowEmpty: true, num: true, options: [['1', 'v1'], ['2', 'v2'], ['3', 'v3']] },
  { path: 'shadow-tls.password', label: 'ShadowTLS 密码(v2)', type: 'text', optional: true },
  { path: 'shadow-tls.handshake.dest', label: 'ShadowTLS 握手目标', type: 'text', optional: true, placeholder: 'www.example.com:443' },
  { path: 'res-tls.enable', label: '启用 RestTLS', type: 'bool', optional: true },
  { path: 'res-tls.dest', label: 'RestTLS 目标', type: 'text', optional: true, placeholder: 'www.example.com:443' },
  { path: 'res-tls.password', label: 'RestTLS 密码', type: 'text', optional: true },
  { path: 'jls-config.enable', label: '启用 JLS', type: 'bool', optional: true },
  { path: 'jls-config.dest', label: 'JLS 回落目标', type: 'text', optional: true, placeholder: 'www.example.com:443' },
  { path: 'jls-config.sni', label: 'JLS SNI', type: 'text', optional: true, desc: '留空时从 dest 推导' },
];

// 无监听端口的类型（接管型）
const IN_NO_PORT = new Set(['tun', 'ebpf']);
const IN_COMMON = [
  { path: 'port', label: '监听端口', type: 'number' },
  { path: 'ports', label: '多端口/端口范围', type: 'text', optional: true, placeholder: '如 10001-10010（与端口二选一）', desc: '可选，段范围字符串' },
  { path: 'listen', label: '监听地址', type: 'text', optional: true, placeholder: '0.0.0.0' },
  { path: 'udp', label: '监听 UDP', type: 'bool', optional: true, def: true, desc: '内核默认开启' },
  { path: 'proxy', label: '转发到代理/代理组', type: 'select', allowEmpty: true, emptyLabel: '默认（走路由规则）', options: [], desc: '入站流量不走路由，直接交给指定代理' },
  { path: 'rule', label: '子规则 sub-rules', type: 'text', optional: true, desc: '指定 sub-rules 中的规则组名' },
  { path: 'routing-mark', label: 'routing-mark', type: 'number', optional: true, desc: '为监听 socket 设置 routing-mark，仅 Linux 有效' },
];
// users 为必填的入站协议 → 其「主字段」名。
// 依据内核结构体：vmess/vless/trojan 的 users 标签无 omitempty。
const IN_USERS_REQUIRED = { vmess: 'uuid', vless: 'uuid', trojan: 'password' };

const IN_EXTRA = {
  http:        [{ path: 'users', label: '用户认证', type: 'userlist', optional: true,
                desc: '留空则沿用全局 authentication；添加后仅对本入站生效',
                columns: [{ key: 'username', label: '用户名', required: true }, { key: 'password', label: '密码', required: true }] }],
  socks:       [{ path: 'users', label: '用户认证', type: 'userlist', optional: true,
                desc: '留空则沿用全局 authentication；添加后仅对本入站生效',
                columns: [{ key: 'username', label: '用户名', required: true }, { key: 'password', label: '密码', required: true }] }],
  mixed:       [{ path: 'users', label: '用户认证', type: 'userlist', optional: true,
                desc: '留空则沿用全局 authentication；添加后仅对本入站生效',
                columns: [{ key: 'username', label: '用户名', required: true }, { key: 'password', label: '密码', required: true }] }],
  shadowsocks: [{ path: 'cipher', label: '加密方式 cipher', type: 'text', optional: true, placeholder: 'aes-256-gcm / 2022-blake3-aes-256-gcm' },
                { path: 'password', label: '密码', type: 'text', optional: true, desc: '2022 系列加密要求 base64 形式的密钥' }],
  vmess:       [{ path: 'users', label: '用户', type: 'userlist',
                desc: '必填，至少一个用户。UUID 为标准 36 位格式，可点「生成」自动创建',
                columns: [{ key: 'username', label: '用户名', placeholder: '任意标识，如 user1' },
                          { key: 'uuid', label: 'UUID', required: true, uuid: true, placeholder: '9d0cb9d0-964f-4ef6-897d-6c6b3ccf9e68' },
                          { key: 'alterId', label: 'alterId', num: true, def: 0, placeholder: '0（新版填 0）' }] },
                { path: 'mkcp-config.enable', label: '启用 mKCP', type: 'bool', optional: true, desc: 'v2ray 兼容的 mKCP 传输层' },
                { path: 'mkcp-config.mtu', label: 'mKCP MTU', type: 'number', optional: true, placeholder: '1350' },
                { path: 'mkcp-config.tti', label: 'mKCP 传输间隔(ms)', type: 'number', optional: true, placeholder: '50' },
                { path: 'mkcp-config.uplink-capacity', label: 'mKCP 上行(MB/s)', type: 'number', optional: true, placeholder: '5' },
                { path: 'mkcp-config.downlink-capacity', label: 'mKCP 下行(MB/s)', type: 'number', optional: true, placeholder: '20' },
                { path: 'mkcp-config.congestion', label: 'mKCP 拥塞控制', type: 'bool', optional: true },
                { path: 'mkcp-config.seed', label: 'mKCP 混淆种子', type: 'text', optional: true },
                { path: 'mkcp-config.header', label: 'mKCP 伪装包头', type: 'select', allowEmpty: true,
                  options: [['none', 'none'], ['srtp', 'srtp'], ['utp', 'utp'], ['wechat-video', 'wechat-video'], ['dtls', 'dtls'], ['wireguard', 'wireguard']] }],
  vless:       [{ path: 'users', label: '用户', type: 'userlist',
                desc: '必填，至少一个用户。另需填 TLS 证书或 reality-config，否则内核拒绝启动',
                columns: [{ key: 'username', label: '用户名', placeholder: '任意标识，如 user1' },
                          { key: 'uuid', label: 'UUID', required: true, uuid: true, placeholder: '9d0cb9d0-964f-4ef6-897d-6c6b3ccf9e68' },
                          { key: 'flow', label: 'flow 流控', placeholder: '留空或 xtls-rprx-vision' }] },
                { path: 'decryption', label: 'VLESS encryption 服务端串', type: 'textarea', optional: true,
                  placeholder: 'mlkem768x25519plus.native/xorpub/random.600s/0s.(私钥)...',
                  desc: '填写后可免 TLS。由 mihomo generate vless-x25519 / vless-mlkem768 生成' },
                { path: 'allow-insecure', label: '允许不加密 allow-insecure', type: 'bool', optional: true,
                  desc: '仅用于前置 nginx/caddy 的场景；否则证书、REALITY、decryption 至少配一项' },
                { path: 'xhttp-config.path', label: 'XHTTP 路径', type: 'text', optional: true, placeholder: '/', desc: '填写后启用 XHTTP 传输层' },
                { path: 'xhttp-config.host', label: 'XHTTP Host', type: 'text', optional: true },
                { path: 'xhttp-config.mode', label: 'XHTTP 模式', type: 'select', allowEmpty: true,
                  options: [['auto', 'auto'], ['stream-one', 'stream-one'], ['stream-up', 'stream-up'], ['packet-up', 'packet-up']] }],
  trojan:      [{ path: 'users', label: '用户', type: 'userlist',
                desc: '必填，至少一个用户。另需填 TLS 证书 / reality-config / ss-option 之一',
                columns: [{ key: 'username', label: '用户名', placeholder: '任意标识，如 user1' },
                          { key: 'password', label: '密码', required: true, placeholder: '连接口令' }] },
                { path: 'ss-option.enabled', label: '启用 Shadowsocks 套壳', type: 'bool', optional: true, desc: '等价 trojan-go 的 shadowsocks 配置' },
                { path: 'ss-option.method', label: 'SS 加密方式', type: 'select', allowEmpty: true,
                  options: [['aes-128-gcm', 'aes-128-gcm'], ['aes-256-gcm', 'aes-256-gcm'], ['chacha20-ietf-poly1305', 'chacha20-ietf-poly1305']] },
                { path: 'ss-option.password', label: 'SS 密码', type: 'text', optional: true },
                { path: 'allow-insecure', label: '允许不加密 allow-insecure', type: 'bool', optional: true,
                  desc: '仅用于前置 nginx/caddy 的场景；否则证书、REALITY、ss-option 至少配一项' }],
  hysteria2:   [{ path: 'users', label: '用户（每行「用户名: 密码」）', type: 'maptext', optional: true,
                placeholder: 'user1: password1\nuser2: password2', desc: '映射形式；需同时配置 TLS 证书' },
                { path: 'masquerade', label: '伪装站点 masquerade', type: 'text', optional: true, placeholder: 'https://bing.com' },
                { path: 'obfs', label: '混淆 obfs', type: 'text', optional: true, placeholder: 'salamander' },
                { path: 'obfs-password', label: '混淆密码', type: 'text', optional: true },
                { path: 'up', label: '上行速率 up', type: 'text', optional: true, placeholder: '1000（默认 Mbps）' },
                { path: 'down', label: '下行速率 down', type: 'text', optional: true, placeholder: '1000（默认 Mbps）' },
                { path: 'ignore-client-bandwidth', label: '忽略客户端带宽', type: 'bool', optional: true, desc: '开启后固定使用 BBR' },
                { path: 'alpn', label: 'ALPN', type: 'list', optional: true, hint: 'h3' },
                { path: 'bbr-profile', label: 'BBR 策略', type: 'select', allowEmpty: true,
                  options: [['standard', 'standard'], ['conservative', 'conservative'], ['aggressive', 'aggressive']] },
                { path: 'max-idle-time', label: '最大空闲(ms)', type: 'number', optional: true },
                { path: 'cwnd', label: '拥塞窗口 cwnd', type: 'number', optional: true }],
  tuic:        [{ path: 'users', label: 'v5 用户（每行「UUID: 密码」）', type: 'maptext', optional: true,
                placeholder: '00000000-0000-0000-0000-000000000000: password1',
                desc: '键必须是 UUID、值是密码；与 token(v4) 至少填一项' },
                { path: 'token', label: 'token v4（与 users 二选一）', type: 'list', optional: true, hint: 'TOKEN' },
                { path: 'congestion-controller', label: '拥塞控制', type: 'select', allowEmpty: true, options: [['cubic','cubic'],['bbr','bbr'],['new_reno','new_reno']] },
                { path: 'max-idle-time', label: '最大空闲（ms）', type: 'number', optional: true },
                { path: 'max-udp-relay-packet-size', label: '最大 UDP 中继包', type: 'number', optional: true },
                { path: 'authentication-timeout', label: '认证超时(ms)', type: 'number', optional: true, placeholder: '1000' },
                { path: 'alpn', label: 'ALPN', type: 'list', optional: true, hint: 'h3' },
                { path: 'cwnd', label: '拥塞窗口 cwnd', type: 'number', optional: true }],
  anytls:      [{ path: 'users', label: '用户（每行「用户名: 密码」）', type: 'maptext', optional: true,
                placeholder: 'user1: password1', desc: '映射形式；certificate 与 private-key 必填' },
                { path: 'padding-scheme', label: '填充策略 padding-scheme', type: 'list', optional: true, hint: '如 stop=8' }],
  tunnel:      [{ path: 'target', label: '转发目标 target', type: 'text', optional: true, placeholder: 'www.example.com:80' },
                { path: 'network', label: '转发网络', type: 'list', optional: true, hint: 'tcp, udp' }],
  snell:       [{ path: 'psk', label: 'PSK 密钥', type: 'text', optional: true },
                { path: 'version', label: '版本 version', type: 'select', allowEmpty: true, options: [['1','v1'],['2','v2'],['3','v3'],['4','v4'],['5','v5']] },
                { path: 'obfs-opts.mode', label: '混淆模式', type: 'select', allowEmpty: true, options: [['http','http'],['tls','tls']] },
                { path: 'obfs-opts.host', label: '混淆 Host', type: 'text', optional: true }],
  mieru:       [{ path: 'transport', label: '传输 transport', type: 'select', allowEmpty: true, options: [['TCP','TCP'],['UDP','UDP']] },
                { path: 'users', label: '用户（每行「用户名: 密码」）', type: 'maptext', optional: true,
                  placeholder: 'user1: password1' },
                { path: 'traffic-pattern', label: '流量模式 traffic-pattern', type: 'text', optional: true },
                { path: 'user-hint-is-mandatory', label: '强制 user-hint', type: 'bool', optional: true }],
  sudoku:      [{ path: 'key', label: '密钥 key', type: 'text', optional: true },
                { path: 'aead-method', label: 'AEAD 算法', type: 'select', allowEmpty: true, options: [['chacha20-poly1305','chacha20-poly1305'],['aes-128-gcm','aes-128-gcm'],['none','none']] },
                { path: 'padding-min', label: '最小填充率', type: 'number', optional: true },
                { path: 'padding-max', label: '最大填充率', type: 'number', optional: true },
                { path: 'table-type', label: '表类型 table-type', type: 'select', allowEmpty: true, options: [['prefer_ascii','prefer_ascii'],['prefer_entropy','prefer_entropy'],['up_ascii_down_entropy','up_ascii_down_entropy'],['up_entropy_down_ascii','up_entropy_down_ascii']] },
                { path: 'enable-pure-downlink', label: '纯 Sudoku 下行', type: 'bool', optional: true },
                { path: 'handshake-timeout', label: '握手超时（秒）', type: 'number', optional: true },
                { path: 'httpmask.disable', label: '禁用 HTTP 伪装', type: 'bool', optional: true },
                { path: 'httpmask.mode', label: 'HTTP 伪装模式', type: 'select', allowEmpty: true, options: [['legacy','legacy'],['stream','stream'],['poll','poll'],['auto','auto'],['ws','ws']] },
                { path: 'httpmask.path-root', label: '伪装路径前缀', type: 'text', optional: true },
                { path: 'fallback', label: 'HTTP 回退地址', type: 'text', optional: true }],
  trusttunnel: [{ path: 'network', label: '网络（http2+http3）', type: 'list', optional: true, hint: 'tcp, udp' },
                { path: 'congestion-controller', label: '拥塞控制', type: 'select', allowEmpty: true, options: [['cubic','cubic'],['bbr','bbr'],['new_reno','new_reno']] },
                { path: 'bbr-profile', label: 'BBR 策略', type: 'select', allowEmpty: true, options: [['standard','standard'],['conservative','conservative'],['aggressive','aggressive']] }],
  'hysteria2-realm': [{ path: 'token', label: 'Bearer token', type: 'text', optional: true },
                { path: 'max-realms', label: '最大 realm 总数', type: 'number', optional: true },
                { path: 'max-realms-per-ip', label: '单 IP 最大 realm 数', type: 'number', optional: true },
                { path: 'trusted-proxy-header', label: '可信代理头', type: 'text', optional: true, placeholder: 'X-Forwarded-For' },
                { path: 'realm-name-pattern', label: 'realm 名称正则', type: 'text', optional: true },
                { path: 'alpn', label: 'ALPN', type: 'list', optional: true, hint: 'h2, http/1.1' }],
  shadowquic:  [{ path: 'jls-upstream.addr', label: 'JLS 上游 jls-upstream.addr', type: 'text', optional: true, placeholder: 'www.example.com:443' },
                { path: 'jls-upstream.sni', label: 'JLS 上游 SNI', type: 'text', optional: true },
                { path: 'alpn', label: 'ALPN', type: 'list', optional: true, hint: 'h3' },
                { path: 'quic-versions', label: 'QUIC 版本', type: 'text', optional: true, placeholder: 'v1' },
                { path: 'zero-rtt', label: '0-RTT', type: 'bool', optional: true },
                { path: 'congestion-controller', label: '拥塞控制', type: 'select', allowEmpty: true, options: [['cubic','cubic'],['bbr','bbr'],['new_reno','new_reno']] },
                { path: 'ignore-client-bandwidth', label: '忽略客户端带宽声明', type: 'bool', optional: true }],
  tun:         [{ path: 'stack', label: '协议栈 stack', type: 'select', allowEmpty: true, options: [['system','system'],['gvisor','gvisor'],['mixed','mixed'],['mips','mips']], desc: 'mips = mihomo 自研 IP 协议栈，需内核 ≥ v1.19.31' },
                { path: 'dns-hijack', label: 'DNS 劫持', type: 'list', optional: true, hint: '0.0.0.0:53' },
                { path: 'inet4-address', label: 'IPv4 地址', type: 'list', optional: true, hint: '198.19.0.1/30' },
                { path: 'inet6-address', label: 'IPv6 地址', type: 'list', optional: true },
                { path: 'mtu', label: 'MTU', type: 'number', optional: true },
                { path: 'auto-route', label: '自动路由', type: 'bool', optional: true },
                { path: 'auto-detect-interface', label: '自动探测出口网卡', type: 'bool', optional: true },
                { path: 'strict-route', label: '严格路由', type: 'bool', optional: true },
                { path: 'endpoint-independent-nat', label: '全锥形 NAT', type: 'bool', optional: true }],
};
const IN_TLS_FIELDS = [
  { path: 'certificate', label: '证书 certificate', type: 'text', optional: true, placeholder: './server.crt', desc: 'PEM 内容或证书路径' },
  { path: 'private-key', label: '私钥 private-key', type: 'text', optional: true, placeholder: './server.key', desc: 'PEM 内容或私钥路径，需与证书同时填写' },
  { path: 'client-auth-type', label: 'mTLS 客户端校验', type: 'select', allowEmpty: true, emptyLabel: '不校验（默认）',
    options: [['request', 'request'], ['require-any', 'require-any'], ['verify-if-given', 'verify-if-given'], ['require-and-verify', 'require-and-verify']],
    desc: '选 verify-if-given / require-and-verify 时，下方客户端证书必填' },
  { path: 'client-auth-cert', label: 'mTLS 客户端证书', type: 'text', optional: true, desc: 'PEM 内容或证书路径' },
  { path: 'ech-key', label: 'ECH 密钥 ech-key', type: 'textarea', optional: true,
    placeholder: '-----BEGIN ECH KEYS-----\n...\n-----END ECH KEYS-----', desc: '可由 mihomo generate ech-keypair <域名> 生成' },
];

// REALITY（vmess / vless / trojan 共用）
const IN_REALITY_FIELDS = [
  { path: 'reality-config.dest', label: 'REALITY 目标 dest', type: 'text', optional: true, placeholder: 'test.com:443', desc: '偷取证书的真实站点；填写后即启用 REALITY（不可与证书同时使用）' },
  { path: 'reality-config.private-key', label: 'REALITY 私钥', type: 'text', optional: true, desc: '由 mihomo generate reality-keypair 生成' },
  { path: 'reality-config.short-id', label: 'REALITY short-id', type: 'list', optional: true, hint: '0123456789abcdef' },
  { path: 'reality-config.server-names', label: 'REALITY server-names', type: 'list', optional: true, hint: 'test.com' },
  { path: 'reality-config.max-time-difference', label: '最大时间偏差(μs)', type: 'number', optional: true },
  { path: 'reality-config.proxy', label: 'REALITY 回落出口', type: 'text', optional: true },
];

// 传输层（vmess / vless / trojan 共用）
const IN_TRANSPORT_FIELDS = [
  { path: 'ws-path', label: 'WebSocket 路径 ws-path', type: 'text', optional: true, placeholder: '/', desc: '非空即开启 WebSocket 传输层' },
  { path: 'grpc-service-name', label: 'gRPC 服务名', type: 'text', optional: true, placeholder: 'GunService', desc: '非空即开启 gRPC 传输层' },
];

// Multiplex（多数协议共用）
const IN_MUX_FIELDS = [
  { path: 'mux-option.padding', label: 'Mux 填充', type: 'bool', optional: true },
  { path: 'mux-option.brutal.enabled', label: 'Brutal 拥塞控制', type: 'bool', optional: true },
  { path: 'mux-option.brutal.up', label: 'Brutal 上行(Mbps)', type: 'number', optional: true },
  { path: 'mux-option.brutal.down', label: 'Brutal 下行(Mbps)', type: 'number', optional: true },
];

function inArr() {
  return Array.isArray(state.cfg.listeners) ? state.cfg.listeners : [];
}

// 删除入站后的统一落点：列表空了也保留顶层 listeners 字段（文本层塌缩成 `listeners: []`）。
// 不能再 delete state.cfg.listeners：整块被删后，块内「注释保留」的 eBPF 段就丢了它所属的那行
// 顶格 `listeners:`（残注释被挂到上一个顶层键下面），而 ebpfEntryRanges 与后端 tproxy/tun 的
// 行式手术都以顶格 `listeners:` 定位该块，之后再开 eBPF 就找不回原设置。
function setInboundList(list) {
  state.cfg.listeners = Array.isArray(list) ? list : [];
}

function renderTunCard() {
  let open = false;
  const body = h('div', { class: 'tun-fold-body' });
  const toggle = h('button', {
    class: 'btn sm',
    type: 'button',
    text: '展开 ▾',
    'aria-expanded': 'false',
    'aria-label': '展开 TUN 配置',
  });
  const setOpen = (v) => {
    open = !!v;
    body.hidden = !open;
    // 收起时卡体不占高度：.card-head 的 10px 下间距会变成卡片下沿多出来的一条空白，
    // 「TUN」文字和「展开」按钮看着整体偏上、不居中（工具页的 config.yaml / 锚点面板
    // 两张折叠卡一直是这么处理的，这里对齐同样的做法）。
    head.style.marginBottom = open ? '' : '0';
    toggle.textContent = open ? '收起 ▴' : '展开 ▾';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', (open ? '收起' : '展开') + ' TUN 配置');
  };
  toggle.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
  const head = h('div', { class: 'card-head', style: 'cursor:pointer' },
    h('h3', { text: 'TUN' }), toggle);
  head.onclick = () => setOpen(!open);

  // 默认收起；展开后仍沿用原来的字段分组和配置编辑逻辑。
  TUN_SECTIONS.forEach(s => {
    if (s.note) body.append(note(s.note, s.noteCls));
    if (s.title) body.append(groupTitle(s.title));
    (s.fields || []).forEach(f => body.append(fieldRow(f, state.cfg)));
  });
  const c = card();
  c.append(head, body);
  // 明确初始化为收起；仅把按钮文案设为「展开」不会自动隐藏 body。
  setOpen(false);
  return c;
}

export function renderInbound(el) { return renderKeepScroll(() => renderInboundCore(el)); }
function renderInboundCore(el) {
  renderSections(el, INBOUND_PORTS);
  el.append(renderTunCard());
  el.prepend(note('入站三件套：<b>代理端口</b>（固定端口）/ <b>TUN</b>（系统级接管）/ <b>监听器</b>（追加入站，含 eBPF 与各类协议）。'));
  const list = inArr();

  // 统一为规则集合单卡样式
  const inCard = card();
  const addBtn = h('button', { class: 'btn sm pri', text: '＋ 添加监听器', onclick: () => {
    const t = deepClone(IN_TEMPLATES[IN_TYPES[0][0]]);
    delete t.name;
    editInSheet(list.length, t, true);
  } });
  inCard.append(h('div', { class: 'card-head' }, h('h3', { text: `${list.length} 个监听器` }), addBtn));
  if (!list.length) { inCard.append(h('div', { class: 'empty', text: '暂无监听器，点击右上角添加' })); }
  else {
    list.forEach((l, i) => {
      if (!l || typeof l !== 'object') return;
      const detail = l.type === 'ebpf'
        ? ebpfRoleSummary(l)
        : `${l.listen || '0.0.0.0'}:${l.port ?? (l.ports || '')}${l.proxy ? ' → ' + l.proxy : ''}`;
      inCard.append(h('div', { class: 'rule-item ep-row' },
        h('div', { class: 'ep-main' },
          h('div', { class: 'ep-title' },
            h('span', { class: 'ep-name', text: l.name || '(未命名)' }), badge(l.type || '?', l.type === 'ebpf' ? 'p' : 'b')),
          h('div', { class: 'ep-url', text: detail })),
        h('span', { class: 'ep-acts' },
          h('button', { class: 'mini-btn', text: '✎', onclick: () => editInSheet(i, l, false) }),
          h('button', { class: 'mini-btn', text: '×', onclick: () => {
            confirmSheet('删除监听器', `确定删除「${l.name || l.type || '监听器'}」？`, '删除', () => {
              if (!inboundRemoveKeepText(i)) { list.splice(i, 1); setInboundList(list); markDirty(); }
              requestServiceRestartOnSave();
              renderInbound(el);
            }, '取消', true);
          } }))));
    });
  }
  el.append(inCard);

  function editInSheet(idx, obj, isNew) {
    const target = deepClone(obj);
    const oldName = isNew ? '' : obj.name;
    if (target.type === 'ebpf') normalizeEbpfLegacy(target);

    const nameInput = h('input', { type: 'text', value: oldName || target.name || (isNew ? (target.type || '') + '-in' : ''), placeholder: '监听器名称（唯一），默认按协议生成，可修改', style: 'width:100%' });
    delete target.name;

    // 协议：新建 = 可选（切换后表单就地重建，已填名称保留）；编辑 = 只读
    let protoNode;
    if (isNew) {
      const pSel = selectCtl(IN_TYPES, target.type, { title: '选择监听器协议' });
      pSel.addEventListener('change', () => {
        const t = deepClone(IN_TEMPLATES[pSel.value] || IN_TEMPLATES[IN_TYPES[0][0]]);
        delete t.name;
        const nm = (nameInput.value || '').trim();
        // 名称仍是上一个协议的默认名（没改过）→ 跟随新协议更新；用户改过则保留
        if (nm && nm !== (target.type || '') + '-in') t.name = nm;
        editInSheet(idx, t, true); // openSheet 会整层替换内容，原地重建
      });
      protoNode = h('div', { class: 'f-row', style: 'margin-bottom:6px' },
        h('div', { class: 'f-label' }, '协议类型', h('div', { class: 'f-desc', text: '切换协议会重建表单；未改名的跟随协议更新默认名' })),
        h('div', { class: 'f-ctl', style: 'max-width:60%' }, pSel));
    } else {
      protoNode = h('div', { class: 'kv', style: 'padding:2px 0 8px' }, h('span', { class: 'k', text: '协议类型' }), h('span', { class: 'v', text: target.type }));
    }

    if (target.type === 'ebpf') {
      const isOfficialCore = !!state.status && state.status.core === 'official';
      const ebpfBox = h('div', {});
      const warnBox = h('div', {});
      const refreshWarns = () => {
        warnBox.innerHTML = '';
        const warns = ebpfConfigWarnings(target, state.cfg);
        warns.forEach(w => warnBox.append(note(w, 'warn')));
      };
      refreshWarns();

      const ebpfShown = new Set(['name', 'type', 'local', 'shared', 'network', 'udp-timeout', 'tc-priority', 'bypass-rule-set', 'bypass-tun-direct', 'fakeip-icmp']);
      const advArea = h('textarea', { style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px', placeholder: '其他参数（YAML）' });
      const rest = {};
      Object.keys(target).forEach(k => { if (k !== 'type' && !ebpfShown.has(k)) rest[k] = target[k]; });
      if (Object.keys(rest).length) advArea.value = jsyaml.dump(rest, { lineWidth: -1 });

      ebpfBox.append(
        note(`基于 <b>liuran001/mihomo</b> 分支的 eBPF 透明代理入站（cgroup v2 + TC）。可实现<b>免 TUN</b> 的透明代理：按 UID/应用/用户精准分流、DNS 劫持。详见 <a href="https://github.com/liuran001/mihomo/blob/Alpha/docs/ebpf-inbound.md" target="_blank">官方文档</a>。`)
      );
      if (isOfficialCore) {
        ebpfBox.append(note('⚠ 当前选择的是官方内核，不支持 eBPF 入站。请到「内核管理」切换到 liuran001 或 jieluojun 分支内核。', 'danger'));
      }
      ebpfBox.append(
        warnBox,
        renderEbpfFields(target, refreshWarns),
        h('div', { class: 'group-title', text: '其他参数（YAML，可选）' }),
        h('div', { class: 'f-desc', style: 'margin-bottom:6px', text: '表单未覆盖的字段在此补充，保存时并入' }),
        advArea
      );

      const close = openSheet(isNew ? '新建监听器' : `编辑监听器 — ${oldName}`,
        nameInput,
        protoNode,
        ebpfBox,
        h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
          h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
          h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
            const n = nameInput.value.trim();
            if (!n) { ntoast('请填写名称'); return; }
            const adv = advArea.value.trim();
            let extra = {};
            if (adv) {
              try { extra = jsyaml.load(adv) || {}; if (typeof extra !== 'object' || Array.isArray(extra)) throw new Error('需要是键值对象'); }
              catch (e) { ntoast('其他参数 YAML 错误: ' + e.message, 3000); return; }
            }
            Object.keys(target).forEach(k => { if (k !== 'type' && !ebpfShown.has(k)) delete target[k]; });
            Object.assign(target, extra);
            const cleanNulls = (o) => {
              if (!o || typeof o !== 'object' || Array.isArray(o)) return;
              for (const k of Object.keys(o)) {
                if (o[k] === null || o[k] === undefined) delete o[k];
                else if (typeof o[k] === 'object' && !Array.isArray(o[k])) cleanNulls(o[k]);
              }
            };
            cleanNulls(target);
            const arr = inArr();
            if (arr.some((x, xi) => x && x.name === n && xi !== idx && !(isNew && xi === arr.length))) { ntoast('已存在同名监听器'); return; }
            // 名称固定为 YAML 第一个键，按规范顺序排列键
            const out = { name: n, type: 'ebpf' };
            const order = ['network', 'udp-timeout', 'tc-priority', 'bypass-rule-set', 'bypass-tun-direct', 'fakeip-icmp', 'local', 'shared'];
            order.forEach(k => {
              if (target[k] !== undefined) out[k] = target[k];
            });
            Object.keys(target).forEach(k => {
              if (k !== 'name' && k !== 'type' && !order.includes(k) && target[k] !== undefined) {
                out[k] = target[k];
              }
            });
            if (isNew) arr.push(out); else arr[idx] = out;
            state.cfg.listeners = arr;
            markDirty();
            requestServiceRestartOnSave();
            close();
            renderInbound(el);
          } }))
      );
      return;
    }

    const box = h('div', {});
    // 转发目标：改用选择项弹窗（DIRECT/REJECT/GLOBAL + 代理组 + 节点）
    const inCommon = (IN_NO_PORT.has(target.type) ? IN_COMMON.filter(f => !['port', 'ports', 'listen', 'udp'].includes(f.path)) : IN_COMMON)
      .map(f => (f.path === 'proxy' ? Object.assign({}, f, { options: proxyTargetOptions(target.proxy) }) : f));
    inCommon.forEach(f => box.append(fieldRow(f, target)));
    (IN_EXTRA[target.type] || []).forEach(f => box.append(fieldRow(f, target)));
    const tlsBox = h('div', {});
    if (IN_TLS_TYPES.has(target.type)) IN_TLS_FIELDS.forEach(f => tlsBox.append(fieldRow(f, target)));
    // 传输层 / REALITY / 伪装层 / Mux：按协议能力分段渲染，折叠在各自标题下
    const trBox = h('div', {});
    if (IN_TRANSPORT_TYPES.has(target.type)) IN_TRANSPORT_FIELDS.forEach(f => trBox.append(fieldRow(f, target)));
    const realityBox = h('div', {});
    if (IN_REALITY_TYPES.has(target.type)) IN_REALITY_FIELDS.forEach(f => realityBox.append(fieldRow(f, target)));
    const disgBox = h('div', {});
    if (IN_DISGUISE_TYPES.has(target.type)) IN_DISGUISE_FIELDS.forEach(f => disgBox.append(fieldRow(f, target)));
    const muxBox = h('div', {});
    if (IN_MUX_TYPES.has(target.type)) IN_MUX_FIELDS.forEach(f => muxBox.append(fieldRow(f, target)));

    // 其他/高级参数兜底（表单覆盖之外的任意官方字段）
    const secFields = [
      ...(IN_TLS_TYPES.has(target.type) ? IN_TLS_FIELDS : []),
      ...(IN_TRANSPORT_TYPES.has(target.type) ? IN_TRANSPORT_FIELDS : []),
      ...(IN_REALITY_TYPES.has(target.type) ? IN_REALITY_FIELDS : []),
      ...(IN_DISGUISE_TYPES.has(target.type) ? IN_DISGUISE_FIELDS : []),
      ...(IN_MUX_TYPES.has(target.type) ? IN_MUX_FIELDS : []),
    ];
    // 只取路径首段：嵌套字段（如 reality-config.dest）整棵子树都由表单接管
    const shown = new Set(['name', 'type',
      ...IN_COMMON.map(f => f.path.split('.')[0]),
      ...(IN_EXTRA[target.type] || []).map(f => f.path.split('.')[0]),
      ...secFields.map(f => f.path.split('.')[0])]);
    const advArea = h('textarea', { style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px', placeholder: 'reality-config:\n  short-id: xxxx\n  dest: dl.google.com:443' });
    const rest = {};
    Object.keys(target).forEach(k => { if (k !== 'type' && !shown.has(k)) rest[k] = target[k]; });
    if (Object.keys(rest).length) advArea.value = jsyaml.dump(rest, { lineWidth: -1 });

    const close = openSheet(isNew ? '新建监听器' : `编辑监听器 — ${oldName}`,
      nameInput,
      protoNode,
      box,
      trBox.children.length ? h('div', { class: 'group-title', text: '传输层' }) : null,
      trBox,
      tlsBox.children.length ? h('div', { class: 'group-title', text: 'TLS 证书' }) : null,
      tlsBox,
      realityBox.children.length ? h('div', { class: 'group-title', text: 'REALITY' }) : null,
      realityBox,
      disgBox.children.length ? h('div', { class: 'group-title', text: 'TLS 伪装（ShadowTLS / RestTLS / JLS）' }) : null,
      disgBox,
      muxBox.children.length ? h('div', { class: 'group-title', text: 'Multiplex' }) : null,
      muxBox,
      h('div', { class: 'group-title', text: '其他参数（YAML，可选）' }),
      h('div', { class: 'f-desc', style: 'margin-bottom:6px', text: '表单未覆盖的字段在此补充，保存时并入' }),
      advArea,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
        h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
          const n = nameInput.value.trim();
          if (!n) { ntoast('请填写名称'); return; }
          const adv = advArea.value.trim();
          let extra = {};
          if (adv) {
            try { extra = jsyaml.load(adv) || {}; if (typeof extra !== 'object' || Array.isArray(extra)) throw new Error('需要是键值对象'); }
            catch (e) { ntoast('其他参数 YAML 错误: ' + e.message, 3000); return; }
          }
          // 表单未覆盖的旧键清掉，使用最新的兜底内容
          Object.keys(target).forEach(k => { if (k !== 'type' && !shown.has(k)) delete target[k]; });
          Object.assign(target, extra);
          const arr = inArr();
          if (arr.some((x, xi) => x && x.name === n && xi !== idx && !(isNew && xi === arr.length))) { ntoast('已存在同名监听器'); return; }
          // users 必填校验：这几个协议的 users 字段在内核里没有 omitempty，
          // 缺失或为空会直接报 "listener: has unset fields: users" 并拒绝启动，
          // 与其让用户启动后才发现，不如在保存这一步就拦下。
          const need = IN_USERS_REQUIRED[target.type];
          if (need) {
            const uv = target.users;
            const empty = !uv
              || (Array.isArray(uv) && uv.filter(x => x && typeof x === 'object' && String(x[need] || '').trim()).length === 0)
              || (!Array.isArray(uv) && typeof uv === 'object' && Object.keys(uv).length === 0);
            if (empty) { ntoast(`${target.type} 入站必须至少配置一个用户（${need} 不能为空）`, 3600); return; }
          }
          // 名称固定为 YAML 第一个键
          const out = { name: n, type: target.type };
          Object.keys(target).forEach(k => { if (k !== 'name' && k !== 'type' && target[k] !== undefined) out[k] = target[k]; });
          if (isNew) arr.push(out); else arr[idx] = out;
          state.cfg.listeners = arr;
          markDirty(); close(); renderInbound(el);
        } }),
      ));
  }
}

// ============================================================
// NTP / 流量隧道 / 实验性配置
// ============================================================
export function renderNtp(el) { return renderKeepScroll(() => renderNtpCore(el)); }
function renderNtpCore(el) {
  NTP_DIALER_FIELD.options = policyNames().map(p => [p, p]);
  renderSections(el, NTP_SECTIONS);
}

export function renderExperimental(el) { return renderKeepScroll(() => renderSections(el, EXPERIMENTAL_SECTIONS)); }

function miniBtn(t, fn, disabled = false) {
  const b = h('button', { class: 'mini-btn', text: t, onclick: fn });
  if (disabled) { b.style.opacity = .35; b.style.pointerEvents = 'none'; }
  return b;
}

export function renderTunnels(el) { return renderKeepScroll(() => renderTunnelsCore(el)); }
function renderTunnelsCore(el) {
  el.innerHTML = '';
  el.append(note('流量转发隧道：把本地端口流量转发到目标，可经过代理。单行与对象两种写法分开编辑，保存时合并为一个列表（顺序可能变化，语义不变）。'));
  const all = Array.isArray(state.cfg.tunnels) ? state.cfg.tunnels : [];
  const singles = all.filter(t => typeof t === 'string');
  const objs = all.filter(t => t && typeof t === 'object');
  function commit() {
    const merged = singles.concat(objs);
    if (!merged.length) unset(state.cfg, 'tunnels'); else set(state.cfg, 'tunnels', merged);
    markDirty(); renderTunnels(el);
  }

  // ---- 单行写法 ----
  el.append(groupTitle('单行写法（network,address,target,proxy）'));
  const sCard = card();
  const sInput = h('input', { type: 'text', placeholder: '如 tcp,0.0.0.0:8080,example.com:80,DIRECT', style: 'flex:1' });
  sCard.append(h('div', { style: 'display:flex;gap:8px;margin-bottom:10px' }, sInput,
    h('button', { class: 'btn sm pri', text: '添加', onclick: () => {
      const v = sInput.value.trim();
      if (!v) { ntoast('请填写隧道'); return; }
      if (v.split(',').length < 3) { ntoast('格式至少需要 network,address,target'); return; }
      singles.push(v); sInput.value = ''; commit();
    } })));
  if (!singles.length) sCard.append(h('div', { class: 'empty', text: '暂无单行隧道' }));
  singles.forEach((s, i) => {
    sCard.append(h('div', { class: 'rule-item' },
      h('div', { class: 'rule-line', text: s }),
      miniBtn('✎', () => {
        const input = h('input', { type: 'text', value: s, style: 'width:100%' });
        const close = openSheet('编辑隧道',
          input,
          h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
            h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
            h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
              const v = input.value.trim();
              if (!v) { ntoast('隧道不能为空'); return; }
              singles[i] = v; close(); commit();
            } })));
      }),
      miniBtn('×', () => { singles.splice(i, 1); commit(); })));
  });
  el.append(sCard);

  // ---- 对象写法 ----
  el.append(groupTitle('对象写法（network / address / target / proxy）'));
  const oCard = card();
  oCard.append(h('div', { style: 'margin-bottom:10px' },
    h('button', { class: 'btn sm pri', text: '＋ 添加', onclick: () => editTunSheet(-1, { network: 'tcp', address: '', target: '' }, true) })));
  if (!objs.length) oCard.append(h('div', { class: 'empty', text: '暂无对象隧道' }));
  objs.forEach((o, i) => {
    const net = Array.isArray(o.network) ? o.network.join('/') : (o.network || '?');
    oCard.append(h('div', { class: 'rule-item' },
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { style: 'font-weight:650;font-size:14px' }, h('span', { text: `${net}  ${o.address || ''} → ${o.target || ''}` })),
        h('div', { style: 'font-size:12px;color:var(--text-3);margin-top:2px', text: o.proxy ? '经由 ' + o.proxy : '直接转发' })),
      miniBtn('✎', () => editTunSheet(i, o, false)),
      miniBtn('×', () => confirmSheet('删除隧道', `删除「${net} ${o.address || ''}」？`, '删除', () => { objs.splice(i, 1); commit(); }, '取消', true))));
  });
  el.append(oCard);

  function editTunSheet(idx, obj, isNew) {
    const t = deepClone(obj);
    if (Array.isArray(t.network)) t.network = t.network.join('/');
    const box = h('div', {});
    [
      { path: 'network', label: '协议 network', type: 'select', options: [['tcp', 'tcp'], ['udp', 'udp'], ['tcp/udp', 'tcp + udp']] },
      { path: 'address', label: '监听地址 address', type: 'text', placeholder: '如 0.0.0.0:8080' },
      { path: 'target', label: '目标地址 target', type: 'text', placeholder: '如 example.com:80' },
      { path: 'proxy', label: '出口代理 proxy（留空直连）', type: 'select', allowEmpty: true, options: policyNames().map(p => [p, p]) },
    ].forEach(f => box.append(fieldRow(f, t)));
    const close = openSheet(isNew ? '添加对象隧道' : '编辑对象隧道', box,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
        h('button', { class: 'btn block pri', text: '加入待保存', onclick: () => {
          if (!t.address || !t.target) { ntoast('请填写监听地址与目标地址'); return; }
          if (isNew) objs.push(t); else objs[idx] = t;
          close(); commit();
        } })));
  }
}
