// ============================================================
// 声明式配置表单渲染引擎
// 所有「可视化字段 → config.yaml 键」的映射都在这里
// ============================================================
import { h, get, set, unset, state, markDirty, requestServiceRestartOnSave, note, groupTitle, badge, switchCtl, segCtl, selectCtl, openChildSheet, reorderConfigMap, setSheetFooter, shell, openPickPop, ntoast, copyText, enableDragSort, enableWrapDragSort, uiLog, focusTextInput, isOpenWrt } from './core.js';

// 布尔字段渲染成「选择式弹窗」（默认（不覆写）/ 开 / 关）而非滑动开关——
// 代理组、代理合集编辑器里的全部开关用它统一形态（配合 fieldRow 的 f.boolAs='pick'）。
// 「默认（不覆写）」= 从配置里删除该键，回到内核默认。
export const boolAsPick = (f) => (f && f.type === 'bool' ? { ...f, boolAs: 'pick' } : f);
import { getPackageLabelsAsync, getPackageIconsAsync, listPackagesAsync, appIconSource, lastPackageInfoError, lastPackageError } from './kernelsu.js';

// ---------- 通用字段行 ----------
export function fieldRow(f, target = state.cfg) {
  const val = get(target, f.path);
  const hasVal = val !== undefined && val !== null;

  // ---- 开关 ----
  if (f.type === 'bool') {
    // asSwitch：内核默认「开」这类布尔，用户指定直接用滑动开关。显示态跟随默认
    // （未写=开）；拨到与默认相反的一侧写显式值，拨回来时若配置里本没这个键则直接删键——
    // 来回拨不产生多余条目，「回默认」由开关本身承担，无需额外控件。
    if (f.asSwitch) {
      const v0 = get(target, f.path);
      const has = v0 !== undefined && v0 !== null;
      const dflt = f.def !== undefined ? !!f.def : false;
      return h('div', { class: 'f-row' },
        h('div', { class: 'f-label' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null),
        h('div', { class: 'f-ctl' }, switchCtl(has ? !!v0 : dflt, (v) => {
          if (v === dflt && !has) unset(target, f.path);
          else set(target, f.path, v);
          markDirty(target);
        })));
    }
    // 三态字段：声明了 def（内核有默认值），或显式标记 tri: true —— 一律用
    // 选择式弹窗（默认不覆写 / 开 / 关）。两态开关表达不了这三种状态：旧版把
    // 默认值顶到开关上再补「默认（不覆写）」角标，既看不出当前生效的是默认
    // 还是覆写，也无法从「覆写」撤回「默认」。
    // boolAs='pick'（代理组 / 代理合集编辑器的两态布尔字段）也走这套三态弹窗：
    // 「默认（不覆写）」= 从 config.yaml 删除该键；两态弹窗缺了它就没法从「覆写关」退回「不写」。
    if (f.def !== undefined || f.tri || f.boolAs === 'pick') {
      const sel = selectCtl([
        ['', '默认（不覆写）'],
        ['true', '开'],
        ['false', '关'],
      ], hasVal ? String(!!val) : '', { title: f.label });
      sel.addEventListener('change', () => {
        const v = sel.value;
        if (v === '') unset(target, f.path);          // 选「默认」= 从 config.yaml 删除该键
        else set(target, f.path, v === 'true');       // 显式覆写为 true / false
      });
      return h('div', { class: 'f-row' },
        h('div', { class: 'f-label' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null, f.tag ? (' ', badge(f.tag, f.tagCls || 'p')) : null),
        h('div', { class: 'f-ctl' }, sel));
    }
    // 两态字段（不写 = 关）：普通开关。
    // 关闭时写字段 false 而不是删键（仅当该字段本来就存在于配置中）——
    // 用户明确要求“关闭后保留字段”，免得保存一次文件就被掏空一截；
    // 原本就不存在的字段，开了再关则保持不存在，不产生多余条目。
    const shown = hasVal ? !!val : false;
    let accepted = shown, sw;
    sw = switchCtl(shown, (v) => {
      // 关联开关可在字段落盘前先处理互斥配置。例如开启 TUN 时先走与关闭
      // eBPF 完全相同的 setEbpfEnabled(false) 流程，再写 tun.enable，避免两种入站并存。
      if (typeof f.beforeChange === 'function' && f.beforeChange(v, target) === false) {
        const input = sw.querySelector('input');
        if (input) input.checked = accepted;       // 前置操作失败：开关退回最后一次成功状态
        return;
      }
      const ok = (!v && f.optional && !hasVal) ? unset(target, f.path) : set(target, f.path, v);
      if (ok === false) {
        const input = sw.querySelector('input');
        if (input) input.checked = accepted;
        return;
      }
      accepted = v;
      if ((f.restartOnSave || f.path === 'tun.enable') && target === state.cfg) requestServiceRestartOnSave();
    });
    return h('div', { class: 'f-row' },
      h('div', { class: 'f-label' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null, f.tag ? (' ', badge(f.tag, f.tagCls || 'p')) : null),
      h('div', { class: 'f-ctl' }, sw),
    );
  }

  // ---- 下拉（Miuix 风格控件，不弹系统选择器） ----
  if (f.type === 'select') {
    const sel = selectCtl(f.options, hasVal ? String(val) : '', { allowEmpty: f.allowEmpty, title: f.label, emptyLabel: f.emptyLabel });
    sel.addEventListener('change', () => {
      const v = sel.value;
      if ((f.optional || f.allowEmpty) && (!v)) unset(target, f.path);
      else if (f.num && v !== '') set(target, f.path, Number(v));
      else if (f.bool && v !== '') set(target, f.path, v === 'true');
      else set(target, f.path, v);
    });
    return h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null, f.tag ? (' ', badge(f.tag, f.tagCls || 'p')) : null), h('div', { class: 'f-ctl' }, sel));
  }

  // ---- 多行文本（PEM 证书 / 私钥 / 静态密钥等整块内容） ----
  // 高度随内容自适应（统一规则）：空/单行时与单行输入框同高，粘贴整块内容自动长高
  if (f.type === 'textarea') {
    const area = h('textarea', {
      class: 'code-area',
      spellcheck: false,
      wrap: 'off', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off',
      placeholder: f.placeholder || '',
      style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px;user-select:text',
    });
    area.value = hasVal ? String(val) : '';
    const commitFn = () => {
      // PEM 内容本身含换行，只能去首尾空白，不能整段 trim 掉内部换行
      const raw = area.value.replace(/^\s*\n/, '').replace(/\s+$/, '');
      if (raw === '') { if (f.optional) unset(target, f.path); else set(target, f.path, ''); return; }
      set(target, f.path, raw);
    };
    area.addEventListener('change', commitFn);
    area.addEventListener('blur', commitFn);
    return h('div', { class: 'f-row', style: 'align-items:flex-start' },
      h('div', { class: 'f-label' }, f.label,
        f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null,
        f.tag ? (' ', badge(f.tag, f.tagCls || 'p')) : null),
      h('div', { class: 'f-ctl', style: 'max-width:100%' }, area));
  }

  // ---- 列表（芯片编辑器） ----
  if (f.type === 'list' || f.type === 'numlist') {
    return listEditor(f, target);
  }

  // ---- fake-ip 规则列表（rule 模式可视化，安全版） ----
  if (f.type === 'fakeiprule') {
    return fakeIpRuleEditor(f, target);
  }





  // ---- 请求头（键 / 值分栏逐行编辑；arrayValues=true 时值写为数组，如 http-opts.headers）----
  if (f.type === 'headers') { return headerMapEditor(f, target); }

  // ---- 键值多行文本（arrayValues=true 时值写为数组）----
  if (f.type === 'maptext') {
    const asArray = !!f.arrayValues;
    const area = h('textarea', { placeholder: f.placeholder || (asArray ? '键: 值 每行一条，多个值用逗号分隔\n如 Host: example.com' : '键: 值 每行一条，如\n*.lan: 127.0.0.1') });
    area.value = hasVal ? Object.entries(val).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n') : '';
    const commit = () => {
      const lines = area.value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!lines.length) { unset(target, f.path); return; }
      const obj = {};
      for (const line of lines) {
        const m = line.match(/^(.+?):\s*(.*)$/);
        if (!m) continue;
        const v = m[2].trim();
        // mihomo 的 http-opts.headers 类型是 map[string][]string，标量会被内核判定为 "is not a slice"
        obj[m[1].trim()] = asArray ? v.split(',').map(s => s.trim()).filter(Boolean) : v;
      }
      set(target, f.path, obj);
    };
    area.addEventListener('change', commit);
    area.addEventListener('blur', commit);
    return h('div', { class: 'f-row', style: 'align-items:flex-start' }, h('div', { class: 'f-label' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null), h('div', { class: 'f-ctl', style: 'max-width:60%' }, area));
  }

  // ---- 入站用户列表（数组对象形式：vmess/vless/trojan/http/socks/mixed）----
  if (f.type === 'userlist') { return userListEditor(f, target); }

  // ---- 域名→服务器列表（nameserver-policy 等） ----
  if (f.type === 'maplist') { return mapListEditor(f, target); }

  // ---- DNS 服务器列表（行式 + 可视化构建器） ----
  if (f.type === 'dnslist') { return dnsListEditor(f, target); }

  // ---- 应用列表（Android 专有：需要 PackageManager 读已安装应用）----
  if (f.type === 'applist') {
    if (isOpenWrt()) {
      return note('应用级代理（' + f.label + '）是 Android 专有功能：路由器上不存在「已安装应用」的概念。macOS/Windows 客户端可按进程名分流，路由器按 IP / 域名分流。');
    }
    return appListField(f, target);
  }

  // ---- 规则集多选（从已有 rule-providers 中挑选）----
  if (f.type === 'rulesetpick') { return ruleSetPickField(f, target); }

  // ---- 文本/数字 ----
  const input = h('input', {
    type: f.type === 'number' ? 'number' : (f.type === 'password' ? 'password' : 'text'),
    class: 'input-sm',
    placeholder: f.optional ? (f.placeholder || '默认/自动') : '',
    value: hasVal ? String(val) : '',
    inputmode: f.type === 'number' ? 'numeric' : 'text',
  });
  const commitFn = () => {
    const raw = input.value.trim();
    if (f.optional && raw === '') { unset(target, f.path); return; }
    if (f.type === 'number') {
      const n = Number(raw);
      if (Number.isNaN(n)) { input.value = hasVal ? String(val) : ''; return; }
      set(target, f.path, n);
    } else set(target, f.path, raw);
  };
  input.addEventListener('change', commitFn);
  input.addEventListener('blur', commitFn);
  return h('div', { class: 'f-row' },
    h('div', { class: 'f-label' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null, f.tag ? (' ', badge(f.tag, f.tagCls || 'p')) : null),
    h('div', { class: 'f-ctl' }, input));
}

// ---------- 请求头编辑器（键 / 值分栏） ----------
// 出站传输层的 ws-opts / http-opts / xhttp-opts.headers：每行一个「请求头名」输入框 +
// 一个「值」输入框，取代原先「键: 值」挤在同一个多行文本框里的写法——值里带冒号、逗号
// （如 User-Agent、Accept）不再有歧义，也不用记分隔格式。
//   arrayValues = false（ws / xhttp）：内核类型 map[string]string。同名多行时后一行覆盖前一行，
//                        界面会标红并提示。
//   arrayValues = true （http-opts）：内核类型 map[string][]string，单个值也必须写成列表
//                        （标量会被内核判为 "is not a slice"）。同名多行合并为该请求头的候选值
//                        列表（内核每次请求随机取一个）；读取时列表里的每个值各占一行。
// 只有用户动手编辑后才写回配置：仅打开表单不会改动原有写法（数字等非字符串值原样保留）。
function headerMapEditor(f, target) {
  const asArray = !!f.arrayValues;
  const cur = get(target, f.path);
  const invalid = cur !== undefined && cur !== null && (typeof cur !== 'object' || Array.isArray(cur));
  const text = (x) => (x === undefined || x === null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
  const rows = [];
  if (!invalid && cur) {
    for (const [k, v] of Object.entries(cur)) {
      const list = Array.isArray(v) ? v : [v];
      if (!list.length) rows.push({ k, v: '' });
      list.forEach(x => rows.push({ k, v: text(x) }));
    }
  }

  const box = h('div', { class: 'hdr-list' });
  const warn = h('div', { class: 'f-desc hdr-warn', hidden: true });

  // 请求头名不区分大小写：按小写分组找重复
  const groups = () => {
    const m = new Map();
    rows.forEach((r, i) => {
      const k = r.k.trim();
      if (!k) return;
      const lk = k.toLowerCase();
      if (!m.has(lk)) m.set(lk, { name: k, idx: [], names: new Set() });
      const g = m.get(lk); g.idx.push(i); g.names.add(k);
    });
    return m;
  };
  const refreshWarn = () => {
    const bad = new Set(), msgs = [];
    for (const g of groups().values()) {
      if (!asArray && g.idx.length > 1) {
        g.idx.forEach(i => bad.add(i));
        msgs.push(`请求头「${g.name}」填了 ${g.idx.length} 行，只会保留最后一行的值，请删掉多余的行`);
      } else if (asArray && g.names.size > 1) {
        g.idx.forEach(i => bad.add(i));
        msgs.push(`「${[...g.names].join('」「')}」只是大小写不同，实际是同一个请求头，请统一写法（同名多行会合并为候选值）`);
      }
    }
    box.querySelectorAll('.hdr-row').forEach((row, i) => {
      const k = row.querySelector('.hdr-key');
      if (k) k.classList.toggle('hdr-dup', bad.has(i));
    });
    if (invalid && !rows.length) msgs.push('当前配置里的值不是「请求头名: 值」映射，添加请求头后会整体替换原值');
    warn.textContent = msgs.join('\n');
    warn.hidden = !msgs.length;
  };
  const commit = () => {
    const out = new Map();   // Map 保持首次出现的顺序；键名原样保留（不强行改大小写）
    for (const r of rows) {
      const k = r.k.trim();
      if (!k) continue;                    // 没填名字的行不写出
      const v = r.v.trim();
      if (asArray) {
        if (!v) continue;                  // 空值不进候选列表
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(v);
      } else {
        out.set(k, v);                     // 同名后行覆盖前行（与 YAML 映射语义一致）
      }
    }
    if (!out.size) unset(target, f.path);
    else set(target, f.path, Object.fromEntries(out));
    refreshWarn();
  };

  const render = (focusIdx = -1) => {
    box.innerHTML = '';
    if (!rows.length) {
      box.append(h('div', { class: 'hdr-empty', text: '未设置，点下方「＋ 添加请求头」新增' }));
    } else {
      box.append(h('div', { class: 'hdr-cols', 'aria-hidden': 'true' },
        h('span', { text: '请求头名' }), h('span', { text: asArray ? '值（同名多行 = 候选值）' : '值' })));
    }
    rows.forEach((r, i) => {
      const kIn = h('input', { type: 'text', class: 'hdr-key', value: r.k, placeholder: i ? '请求头名' : '如 Host', 'aria-label': '请求头名' });
      const vIn = h('input', { type: 'text', class: 'hdr-val', value: r.v, placeholder: i ? '值' : '如 example.com', 'aria-label': '请求头的值' });
      kIn.addEventListener('input', () => { r.k = kIn.value; commit(); });
      vIn.addEventListener('input', () => { r.v = vIn.value; commit(); });
      // 部分输入法组词期间不派发 input：change/blur 再兜一次
      kIn.addEventListener('change', () => { r.k = kIn.value; commit(); });
      vIn.addEventListener('change', () => { r.v = vIn.value; commit(); });
      const del = h('button', { type: 'button', class: 'mini-btn', text: '×', title: '删除该请求头', 'aria-label': '删除该请求头',
        onclick: () => { rows.splice(i, 1); commit(); render(); } });
      box.append(h('div', { class: 'hdr-row' }, kIn, vIn, del));
    });
    refreshWarn();
    // 点「＋ 添加」后在同一次点击回调里直接聚焦新行的请求头名（离开手势就唤不起键盘）
    if (focusIdx >= 0) {
      const inp = box.querySelectorAll('.hdr-key')[focusIdx];
      if (inp) focusTextInput(inp, { reveal: true });
    }
  };
  const addBtn = h('button', { type: 'button', class: 'btn sm', text: '＋ 添加请求头', onclick: () => {
    rows.push({ k: '', v: '' });
    render(rows.length - 1);
  } });

  render();
  return h('div', { class: 'f-row', style: 'align-items:flex-start;flex-direction:column;gap:8px' },
    h('div', { class: 'f-label', style: 'width:100%' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null),
    h('div', { style: 'width:100%;min-width:0' }, box, warn, h('div', { style: 'margin-top:8px' }, addBtn)));
}

// ---------- 芯片列表编辑器 ----------
// ---------- DNS 服务器可视化构建器 ----------
// mihomo 的 DNS 服务器字符串格式自由度很高：udp/tcp/tls/https/quic/dhcp/system/rcode
// 八种前缀 + `#` 附加参数（用 `&` 连接：h3 / skip-cert-verify / name-cert-verify /
// ecs / ecs-override / disable-ipv4 / disable-ipv6 / 代理名或网卡名或 RULES）。
// 手写最容易错（DoH 忘 /dns-query、tls:// 拼错、参数分隔符写反……），这里统一可视化拼装：
// 常用公共 DNS 预设一键填入；自定义按协议填表、实时预览生成串。
// onPick(生成的服务器串)；opts.ipOnly = true 用于 default-nameserver（内核要求纯 IP 引导）。
const DNS_PRESETS = [
  ['阿里 DoH', 'https://dns.alidns.com/dns-query'],
  ['阿里 DoT', 'tls://223.5.5.5'],
  ['阿里 DNS', '223.5.5.5'],
  ['腾讯 DoH', 'https://doh.pub/dns-query'],
  ['腾讯 DNSPod', '119.29.29.29'],
  ['114 DNS', '114.114.114.114'],
  ['Google DoH', 'https://dns.google/dns-query'],
  ['Google', '8.8.8.8'],
  ['Cloudflare DoH', 'https://cloudflare-dns.com/dns-query'],
  ['Cloudflare', '1.1.1.1'],
  ['Quad9 DoH', 'https://dns.quad9.net/dns-query'],
  ['AdGuard DoQ', 'quic://dns.adguard.com'],
  ['系统 DNS', 'system'],
];
const DNS_PROTOS = [
  ['udp', 'UDP（明文，默认 53）'],
  ['tcp', 'TCP（tcp://）'],
  ['tls', 'DoT（tls://，默认 853）'],
  ['https', 'DoH（https://，默认 443）'],
  ['quic', 'DoQ（quic://，默认 853）'],
  ['dhcp', 'DHCP（dhcp://网卡名）'],
  ['system', '系统 DNS（system）'],
  ['rcode', '固定回应（rcode://，屏蔽域名用）'],
];
const DNS_RCODES = [
  ['refused', 'refused（拒绝查询）'],
  ['name_error', 'name_error（域名不存在）'],
  ['success', 'success（空应答）'],
  ['server_failure', 'server_failure（服务器失败）'],
  ['format_error', 'format_error（格式错误）'],
  ['not_implemented', 'not_implemented（未实现）'],
];
const DNS_ADDR_PH = {
  udp: 'IP 或域名，如 223.5.5.5 / dns.alidns.com',
  tcp: 'IP 或域名，如 8.8.8.8',
  tls: 'IP 或域名，如 dns.alidns.com',
  https: 'IP 或域名，如 doh.pub',
  quic: 'IP 或域名，如 dns.adguard.com',
  dhcp: '网卡名，如 wlan0（留空 = dhcp://system）',
};
const DNS_PORT_PH = { udp: '53（默认）', tcp: '53（默认）', tls: '853（默认）', https: '443（默认，通常留空）', quic: '853（默认）' };
const DNS_NET_PROTOS = ['udp', 'tcp', 'tls', 'https', 'quic'];
const isIpLiteral = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || (/^[0-9a-fA-F:]+$/.test(s) && s.includes(':'));

// 解析既有服务器串回填表单（编辑用）；含无法识别的参数/写法时整串进 raw 直填框，保证原样往返
function splitHostPort(hp) {
  let m = hp.match(/^\[(.+)\](?::(\d+))?$/);
  if (m) return [m[1], m[2] || ''];
  m = hp.match(/^([^:]+):(\d+)$/);
  if (m) return [m[1], m[2]];
  return [hp, ''];
}
function parseDnsServer(s) {
  const out = { raw: '', extras: [], proto: 'https', addr: '', port: '', path: '/dns-query', rcode: 'refused', proxy: '', h3: false, skipCert: false, nameCert: '', ecs: '', ecsOverride: false, dis4: false, dis6: false };
  s = String(s || '').trim();
  if (!s) return out;
  const hash = s.indexOf('#');
  const base = hash >= 0 ? s.slice(0, hash) : s;
  const optStr = hash >= 0 ? s.slice(hash + 1) : '';
  for (const tok of optStr.split('&').filter(Boolean)) {
    const eq = tok.indexOf('=');
    const k = eq >= 0 ? tok.slice(0, eq) : tok;
    const v = eq >= 0 ? tok.slice(eq + 1) : '';
    if (eq < 0) { out.proxy = tok; continue; }
    if (k === 'h3') out.h3 = v === 'true';
    else if (k === 'skip-cert-verify') out.skipCert = v === 'true';
    else if (k === 'name-cert-verify') out.nameCert = v;
    else if (k === 'ecs') out.ecs = v;
    else if (k === 'ecs-override') out.ecsOverride = v === 'true';
    else if (k === 'disable-ipv4') out.dis4 = v === 'true';
    else if (k === 'disable-ipv6') out.dis6 = v === 'true';
    else out.extras.push(tok); // 未识别参数：原样保留，保存时按原序附加（无损往返）
  }
  let m;
  if (base === 'system' || base === 'system://') { out.proto = 'system'; return out; }
  if ((m = base.match(/^dhcp:\/\/(.*)$/))) { out.proto = 'dhcp'; out.addr = m[1]; return out; }
  if ((m = base.match(/^rcode:\/\/(.*)$/))) { out.proto = 'rcode'; out.rcode = m[1] || 'refused'; return out; }
  if ((m = base.match(/^https:\/\/(.+)$/))) {
    const slash = m[1].indexOf('/');
    const hp = slash >= 0 ? m[1].slice(0, slash) : m[1];
    out.path = slash >= 0 ? m[1].slice(slash) : '/dns-query';
    [out.addr, out.port] = splitHostPort(hp);
    out.proto = 'https';
    if (!out.addr) out.raw = s;
    return out;
  }
  if ((m = base.match(/^(tls|tcp|quic|udp):\/\/(.+)$/))) {
    [out.addr, out.port] = splitHostPort(m[2]);
    out.proto = m[1];
    if (!out.addr) out.raw = s;
    return out;
  }
  // 裸地址 = UDP
  [out.addr, out.port] = splitHostPort(base);
  out.proto = 'udp';
  if (!out.addr) out.raw = s;
  return out;
}
const fmtHostPort = (addr, port) => (addr.includes(':') ? `[${addr}]` : addr) + (port ? ':' + port : '');

export function openDnsServerSheet(onPick, opts = {}) {
  const ipOnly = !!opts.ipOnly;
  const init = opts.initial ? parseDnsServer(opts.initial) : null;
  const st = {
    proto: init && !init.raw ? init.proto : (ipOnly ? 'udp' : 'https'),
    h3: !!(init && init.h3), skipCert: !!(init && init.skipCert), ecsOverride: !!(init && init.ecsOverride),
    dis4: !!(init && init.dis4), dis6: !!(init && init.dis6),
    extras: init ? init.extras.slice() : [],
  };
  const protos = ipOnly ? DNS_PROTOS.filter(([v]) => DNS_NET_PROTOS.includes(v)) : DNS_PROTOS;

  const protoSel = selectCtl(protos, protos.some(([v]) => v === st.proto) ? st.proto : protos[0][0], { title: '协议' });
  st.proto = protoSel.value;
  const addrIn = h('input', { type: 'text', placeholder: DNS_ADDR_PH.https, style: 'width:100%', value: init && !init.raw ? init.addr : '' });
  const portIn = h('input', { type: 'number', placeholder: DNS_PORT_PH.https, style: 'width:100%', inputmode: 'numeric', value: init && !init.raw ? init.port : '' });
  const pathIn = h('input', { type: 'text', value: init && !init.raw && init.proto === 'https' ? init.path : '/dns-query', placeholder: '/dns-query', style: 'width:100%' });
  const rcodeSel = selectCtl(DNS_RCODES, init && !init.raw ? init.rcode : 'refused', { title: '回应类型' });
  const proxyIn = h('input', { type: 'text', placeholder: '代理名 / 网卡名 / RULES，留空直连', style: 'width:100%', value: init ? init.proxy : '' });
  const nameCertIn = h('input', { type: 'text', placeholder: '证书 DNSName，留空不修改', style: 'width:100%', value: init ? init.nameCert : '' });
  const ecsIn = h('input', { type: 'text', placeholder: '如 1.1.1.1/24，留空不携带', style: 'width:100%', value: init ? init.ecs : '' });
  const rawArea = h('textarea', { style: 'width:100%;font-family:ui-monospace,monospace;font-size:12px;display:none;margin-top:12px;background:var(--fill);border:none;border-radius:12px;padding:12px', spellcheck: false, placeholder: '一条完整服务器串，如 https://dns.google/dns-query#h3=true' });
  const h3Sw = switchCtl(st.h3, v => { st.h3 = v; sync(); });
  const skipSw = switchCtl(st.skipCert, v => { st.skipCert = v; sync(); });
  const ecsOvSw = switchCtl(st.ecsOverride, v => { st.ecsOverride = v; sync(); });
  const dis4Sw = switchCtl(st.dis4, v => { st.dis4 = v; sync(); });
  const dis6Sw = switchCtl(st.dis6, v => { st.dis6 = v; sync(); });
  const preview = h('code', { class: 'wrap', style: 'display:block;width:100%;background:var(--fill);border-radius:10px;padding:10px 12px;font-size:12.5px;font-family:ui-monospace,monospace;user-select:text;overflow-wrap:anywhere;word-break:break-all' });
  const extrasNote = h('div', { class: 'note', style: 'display:none;margin-top:8px' });

  const build = () => {
    const p = st.proto;
    const addr = addrIn.value.trim();
    const port = portIn.value.trim();
    const enc = p === 'tls' || p === 'https' || p === 'quic';
    const o = [];
    const proxy = proxyIn.value.trim();
    if (proxy && DNS_NET_PROTOS.includes(p)) o.push(proxy);
    if (p === 'https' && st.h3) o.push('h3=true');
    if (enc && st.skipCert) o.push('skip-cert-verify=true');
    if (enc && nameCertIn.value.trim()) o.push('name-cert-verify=' + nameCertIn.value.trim());
    const ecs = ecsIn.value.trim();
    if (ecs && DNS_NET_PROTOS.includes(p)) { o.push('ecs=' + ecs); if (st.ecsOverride) o.push('ecs-override=true'); }
    if (st.dis4 && DNS_NET_PROTOS.includes(p)) o.push('disable-ipv4=true');
    if (st.dis6 && DNS_NET_PROTOS.includes(p)) o.push('disable-ipv6=true');
    if (st.extras.length) o.push(...st.extras);
    let base;
    if (p === 'system') base = 'system';
    else if (p === 'dhcp') base = 'dhcp://' + (addr || 'system');
    else if (p === 'rcode') base = 'rcode://' + rcodeSel.value;
    else if (p === 'udp') base = port ? 'udp://' + fmtHostPort(addr, port) : addr;
    else {
      base = p + '://' + fmtHostPort(addr, port);
      if (p === 'https') { let pth = pathIn.value.trim() || '/dns-query'; if (!pth.startsWith('/')) pth = '/' + pth; base += pth; }
    }
    if (!base) return '';
    return o.length ? base + '#' + o.join('&') : base;
  };

  const fRow = (label, ctl, desc) => h('div', { class: 'f-row' },
    h('div', { class: 'f-label' }, label, desc ? h('div', { class: 'f-desc', text: desc }) : null),
    h('div', { class: 'f-ctl', style: 'max-width:60%' }, ctl));
  const protoRow = fRow('协议', protoSel, 'DNS 查询的传输协议');
  const addrRow = fRow(ipOnly ? '服务器 IP' : '服务器地址', addrIn);
  const portRow = fRow('端口', portIn, '留空使用该协议默认端口');
  const pathRow = fRow('DoH 路径', pathIn, '通常为 /dns-query');
  const rcodeRow = fRow('回应类型', rcodeSel, '匹配的查询直接返回该固定回应');
  const advTitle = groupTitle('附加参数（以 # 附加，可选）');
  const proxyRow = fRow('指定代理/接口', proxyIn, '优先按代理名匹配，无此代理则视为出网网卡名；RULES = 遵守路由规则。经代理查询需配好「代理服务器解析 DNS」防鸡蛋问题');
  const h3Row = fRow('强制 HTTP/3', h3Sw, '仅 DoH 生效，需服务器支持 H3');
  const skipRow = fRow('跳过证书校验', skipSw);
  const nameCertRow = fRow('证书 DNSName', nameCertIn, '仅修改证书 DNSName 校验目标，不修改 SNI');
  const ecsRow = fRow('ECS 子网', ecsIn, 'EDNS Client Subnet，指定查询携带的 subnet 地址');
  const ecsOvRow = fRow('强制覆盖 ECS', ecsOvSw);
  const dis4Row = fRow('丢弃 A 回应', dis4Sw, 'disable-ipv4：不采用该服务器的 IPv4 结果');
  const dis6Row = fRow('丢弃 AAAA 回应', dis6Sw, 'disable-ipv6：不采用该服务器的 IPv6 结果');
  const prevTitle = groupTitle('生成预览');

  function sync() {
    if (isRaw) return; // 文本编辑态：表单整组隐藏，可见性由 applyMode 统管
    const p = st.proto;
    const net = DNS_NET_PROTOS.includes(p);
    addrRow.style.display = (p === 'system' || p === 'rcode') ? 'none' : '';
    portRow.style.display = net ? '' : 'none';
    pathRow.style.display = p === 'https' ? '' : 'none';
    rcodeRow.style.display = p === 'rcode' ? '' : 'none';
    advTitle.style.display = net ? '' : 'none';
    proxyRow.style.display = h3Row.style.display = skipRow.style.display = nameCertRow.style.display = ecsRow.style.display = ecsOvRow.style.display = dis4Row.style.display = dis6Row.style.display = 'none';
    if (net) {
      proxyRow.style.display = ecsRow.style.display = dis4Row.style.display = dis6Row.style.display = '';
      if (p === 'https') h3Row.style.display = '';
      if (p === 'tls' || p === 'https' || p === 'quic') { skipRow.style.display = nameCertRow.style.display = ''; }
      if (ecsIn.value.trim()) ecsOvRow.style.display = '';
    }
    addrIn.placeholder = (ipOnly ? '必须为 IP，如 223.5.5.5' : DNS_ADDR_PH[p]) || '';
    portIn.placeholder = DNS_PORT_PH[p] || '';
    preview.textContent = build() || '（填写服务器地址后生成）';
    if (st.extras.length) { extrasNote.textContent = '未识别参数已原样保留，保存时附加：' + st.extras.join('&'); extrasNote.style.display = ''; }
    else extrasNote.style.display = 'none';
  }
  protoSel.addEventListener('change', () => { st.proto = protoSel.value; sync(); });
  [addrIn, portIn, pathIn, proxyIn, nameCertIn, ecsIn].forEach(inp => inp.addEventListener('input', sync));
  rcodeSel.addEventListener('change', sync);

  // 常用 DNS 预设：一点即用（ipOnly 场景只列纯 IP 主机的预设）
  const presets = ipOnly
    ? DNS_PRESETS.filter(([, v]) => { const host = v.replace(/^[a-z]+:\/\//, '').replace(/[:/#].*$/, ''); return isIpLiteral(host); })
    : DNS_PRESETS;
  const presetBox = h('div', { class: 'chips', style: 'padding:2px 0 6px' });
  // ---- 可视化 / 文本编辑切换（与路由规则添加弹层同款形态：底部按钮 + 隐藏等宽文本域，双向同步）----
  let isRaw = !!(init && init.raw); // 无法分解的旧串（主机非法等）：打开即文本编辑态，整串无损
  if (isRaw) rawArea.value = opts.initial;
  const presetTitle = groupTitle('常用 DNS 一键填入');
  const customTitle = groupTitle(ipOnly ? '自定义（引导 DNS 必须是 IP）' : '自定义拼装');
  const formEls = [presetTitle, presetBox, customTitle, protoRow, addrRow, portRow, pathRow, rcodeRow, advTitle, proxyRow, h3Row, skipRow, nameCertRow, ecsRow, ecsOvRow, dis4Row, dis6Row, extrasNote, prevTitle, preview];
  const setSw = (sw, v) => { sw.querySelector('input').checked = !!v; };
  function fillFromText(txt) {
    const p = parseDnsServer(String(txt || '').trim());
    if (p.raw) { ntoast('该串无法分解为可视化表单，请继续用文本编辑'); return false; }
    if (!protos.some(([v]) => v === p.proto)) { ntoast(ipOnly ? '引导 DNS 可视化仅支持 UDP/TCP 协议，其余请用文本编辑' : '该协议不在可选列表，请继续用文本编辑'); return false; }
    protoSel.value = p.proto; st.proto = p.proto;
    addrIn.value = p.addr || ''; portIn.value = p.port || '';
    pathIn.value = p.proto === 'https' ? (p.path || '/dns-query') : '/dns-query';
    rcodeSel.value = p.rcode || 'refused';
    proxyIn.value = p.proxy || ''; nameCertIn.value = p.nameCert || ''; ecsIn.value = p.ecs || '';
    st.h3 = !!p.h3; setSw(h3Sw, st.h3);
    st.skipCert = !!p.skipCert; setSw(skipSw, st.skipCert);
    st.ecsOverride = !!p.ecsOverride; setSw(ecsOvSw, st.ecsOverride);
    st.dis4 = !!p.dis4; setSw(dis4Sw, st.dis4);
    st.dis6 = !!p.dis6; setSw(dis6Sw, st.dis6);
    st.extras = p.extras.slice();
    return true;
  }
  const toggleBtn = h('button', { class: 'btn sm', style: 'margin-top:12px', text: '切换为文本编辑', onclick: () => {
    if (!isRaw) { rawArea.value = build(); isRaw = true; applyMode(); }
    else { if (!fillFromText(rawArea.value)) return; isRaw = false; applyMode(); sync(); }
  } });
  formEls.forEach(elx => { elx.dataset.dflt = elx.style.display || ''; }); // 记住各自初始 inline display（preview 为 block）
  function applyMode() {
    rawArea.style.display = isRaw ? '' : 'none';
    formEls.forEach(elx => { elx.style.display = isRaw ? 'none' : elx.dataset.dflt; });
    toggleBtn.textContent = isRaw ? '切换为可视化编辑' : '切换为文本编辑';
  }
  applyMode();
  const editing = !!opts.initial;
  const close = openChildSheet(editing ? '编辑 DNS 服务器' : (ipOnly ? '添加引导 DNS（纯 IP）' : '可视化添加 DNS 服务器'),
    presetTitle,
    presetBox,
    customTitle,
    protoRow, addrRow, portRow, pathRow, rcodeRow,
    advTitle, proxyRow, h3Row, skipRow, nameCertRow, ecsRow, ecsOvRow, dis4Row, dis6Row,
    extrasNote, prevTitle, preview,
    toggleBtn, rawArea,
    h('div', { style: 'display:flex;gap:10px;margin-top:14px' },
      h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
      h('button', { class: 'btn block pri', text: editing ? '保存' : '添加', onclick: () => {
        if (isRaw) {
          const raw = rawArea.value.trim();
          if (!raw) { ntoast('服务器串不能为空'); return; }
          if (/\s|[，]/.test(raw)) { ntoast('服务器串不能包含空格或中文逗号'); return; }
          if (ipOnly) {
            const host = raw.replace(/#.*$/, '').replace(/^[a-z]+:\/\//, '').replace(/[:/].*$/, '');
            if (!isIpLiteral(host)) { ntoast('default-nameserver 为引导 DNS，必须填纯 IP'); return; }
          }
          close();
          if (onPick) onPick(raw);
          return;
        }
        const p = st.proto;
        const addr = addrIn.value.trim();
        if (DNS_NET_PROTOS.includes(p)) {
          if (!addr) { ntoast('请填写服务器地址'); return; }
          if (/[\s,#&'"]|[，]/.test(addr)) { ntoast('地址不能包含空格或 , # & 等符号'); return; }
          if (ipOnly && !isIpLiteral(addr)) { ntoast('default-nameserver 为引导 DNS，必须填纯 IP'); return; }
          const port = portIn.value.trim();
          if (port && (!/^\d{1,5}$/.test(port) || +port > 65535)) { ntoast('端口不正确'); return; }
        }
        if (p === 'dhcp' && /[\s,#&]/.test(addr)) { ntoast('网卡名不正确'); return; }
        const s = build();
        if (!s) { ntoast('生成结果为空'); return; }
        close();
        if (onPick) onPick(s);
      } })));
  presets.forEach(([name, val]) => {
    presetBox.append(h('span', { class: 'chip', style: 'cursor:pointer', title: val, onclick: () => { close(); if (onPick) onPick(val); } },
      h('span', { text: name })));
  });
  sync();
  return close;
}

// ---------- DNS 服务器列表（行式编辑器：与 nameserver-policy「按域名分流」同款形态）----------
// 每行一条完整服务器串（code 全文不省略）+ 拖拽排序 + ✎ 编辑（打开可视化构建器并回填解析结果）
// + × 删除；添加统一走构建器（预设一键 / 表单拼装 / 文本编辑），不再用芯片胶囊挤长 URL。
function dnsListEditor(f, target) {
  const container = h('div', { style: 'width:100%' });
  const getItems = () => { const v = get(target, f.path); return Array.isArray(v) ? v.map(String) : []; };
  const commitItems = (arr) => { if (!arr.length && f.optional) unset(target, f.path); else set(target, f.path, arr); };
  const miniBtn = (t, fn) => h('button', { class: 'mini-btn', text: t, onclick: fn });
  function render() {
    container.innerHTML = '';
    const items = getItems();
    if (!items.length) container.append(h('div', { class: 'empty', text: '暂无服务器，点下方按钮添加' }));
    items.forEach((s, i) => {
      const line = h('div', { class: 'rule-item' });
      line.append(
        h('span', { class: 'drag-handle', title: '拖动排序', html: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="5" cy="3" r="1.4"/><circle cx="8" cy="3" r="1.4"/><circle cx="13" cy="3" r="1.4"/><circle cx="5" cy="8" r="1.4"/><circle cx="11" cy="8" r="1.4"/><circle cx="5" cy="13" r="1.4"/><circle cx="8" cy="13" r="1.4"/><circle cx="13" cy="13" r="1.4"/></svg>' }),
        h('code', { class: 'wrap', text: s }),
        miniBtn('✎', () => openDnsServerSheet((ns) => {
          const arr = getItems();
          if (ns !== arr[i] && arr.includes(ns)) { ntoast('该服务器已在列表中'); return; }
          arr[i] = ns; commitItems(arr); render();
        }, { ipOnly: f.dnsIpOnly, initial: s })),
        miniBtn('×', () => { const arr = getItems(); arr.splice(i, 1); commitItems(arr); render(); }),
      );
      container.append(line);
    });
    const addBtn = h('button', { class: 'btn sm pri', text: '＋ 添加服务器', onclick: () => {
      openDnsServerSheet((s) => {
        const arr = getItems();
        if (arr.includes(s)) { ntoast('该服务器已在列表中'); return; }
        arr.push(s); commitItems(arr); render();
      }, { ipOnly: f.dnsIpOnly });
    }});
    container.append(h('div', { style: 'margin-top:10px' }, addBtn));
    enableDragSort(container, '.rule-item', (from, to) => {
      const arr = getItems();
      const [m] = arr.splice(from, 1);
      arr.splice(to, 0, m);
      commitItems(arr); render();
    });
  }
  render();
  return h('div', { class: 'f-row', style: 'align-items:flex-start' },
    h('div', { class: 'f-label' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null, f.tag ? (' ', badge(f.tag, f.tagCls || 'p')) : null),
    h('div', { class: 'f-ctl', style: 'max-width:60%' }, container));
}

export function listEditor(f, target, opts = {}) {
  let items;
  if (f.join) {
    const raw0 = get(target, f.path);
    items = typeof raw0 === 'string' ? raw0.split(f.join).map(s => s.trim()).filter(Boolean) : (Array.isArray(raw0) ? raw0.map(String) : []);
  } else {
    items = Array.isArray(get(target, f.path)) ? [...get(target, f.path)] : [];
  }
  const wrap = h('div', {});
  const chips = h('div', { class: 'chips' });
  function commitItems() {
    if (!items.length && f.optional) unset(target, f.path);
    else if (f.join) set(target, f.path, items.join(f.join));
    else set(target, f.path, items);
  }
  function renderChips() {
    chips.innerHTML = '';
    items.forEach((it, i) => {
      const x = h('button', { class: 'x', text: '×', title: '删除' });
      x.onclick = () => { items.splice(i, 1); commitItems(); renderChips(); };
      const dragHandle = h('span', { class: 'drag-handle', title: '长按拖动排序', html: '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><circle cx="5" cy="3" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="5" cy="13" r="1.2"/><circle cx="11" cy="3" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="11" cy="13" r="1.2"/></svg>' });
      // 芯片整体可通过手柄拖动排序
      const chipEl = h('span', { class: 'chip', style: 'touch-action:none' }, dragHandle, h('span', { text: String(it), style: 'user-select:text' }));
      if (f.noX) chipEl.style.paddingRight = '12px'; else chipEl.append(x);
      chips.append(chipEl);
    });
    if (!items.length) chips.append(h('span', { style: 'color:var(--text-3);font-size:12.5px', text: f.emptyText || '未设置' }));
    else {
      // 自动换行芯片不再边拖边改 DOM：网格保持静止、浮层跟手，松手时只换位一次。
      // 这样目标不会在指尖下面连续搬家，避免误命中相邻芯片和来回跳动。
      enableWrapDragSort(chips, '.chip', (from, to) => {
        const [moved] = items.splice(from, 1);
        items.splice(to, 0, moved);
        commitItems();
        renderChips();
      });
    }
  }
  // 带选择弹窗（datalist）的列表：一律从清单挑选，不再提供手动输入 —— 手滑写错
  // 协议名/成员名会直接写进配置且内核静默忽略，挑选式从根上杜绝；重复挑选自动忽略。
  // 无弹窗的普通列表（DNS 服务器等自由文本）保留输入+添加不变。
  let input = null, addBtn = null, pickBtn = null;
  if (f.datalist) {
    pickBtn = h('button', { class: 'btn sm', text: '＋ 选择', onclick: () => {
      openPickPop(f.pickTitle || ('选择' + (f.label || '')), f.datalist() || [], (v) => {
        if (items.includes(v)) return;
        items.push(v);
        commitItems(); renderChips();
      });
    }});
  } else {
    input = h('input', { type: 'text', placeholder: f.hint || '输入后添加', style: 'flex:1' });
    const addItem = () => {
      const raw = input.value.trim();
      if (!raw) return;
      const v = f.type === 'numlist' ? Number(raw) : raw;
      if (f.type === 'numlist' && Number.isNaN(v)) { input.value = ''; return; }
      if (f.join) raw.split(f.join).map(s => s.trim()).filter(Boolean).forEach(s => items.push(s));
      else items.push(v);
      input.value = '';
      commitItems();
      renderChips();
    };
    addBtn = h('button', { class: 'btn sm', text: '添加', onclick: addItem });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
  }
  wrap.append(chips, h('div', { class: 'addline' }, input, pickBtn, addBtn));
  renderChips();
  return h('div', { class: 'f-row', style: 'align-items:flex-start' },
    h('div', { class: 'f-label' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null, f.tag ? (' ', badge(f.tag, f.tagCls || 'p')) : null),
    h('div', { class: 'f-ctl', style: 'max-width:60%' }, wrap));
}

// ---------- 键 → 服务器列表 编辑器 ----------
function mapListEditor(f, target) {
  const container = h('div', { style: 'width:100%' });
  const getObj = () => { const v = get(target, f.path); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  function render() {
    try {
      container.innerHTML = '';
      const obj = getObj();
      const entries = Object.entries(obj);
      if (!entries.length) container.append(h('div', { class: 'empty', text: '暂无条目' }));
      entries.forEach(([k, v], idx) => {
        const line = h('div', { class: 'rule-item' });
        const listStr = Array.isArray(v) ? v.join(',') : String(v);
        line.append(
          h('span', { class: 'drag-handle', title: '拖动排序', html: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="5" cy="3" r="1.4"/><circle cx="5" cy="8" r="1.4"/><circle cx="5" cy="13" r="1.4"/><circle cx="11" cy="3" r="1.4"/><circle cx="11" cy="8" r="1.4"/><circle cx="11" cy="13" r="1.4"/></svg>' }),
          h('code', { class: 'wrap', text: `${k} → ${listStr}` }),   // DNS 列表要看全，不省略
          miniBtn('✎', () => editEntry(k, Array.isArray(v) ? v : (f.lineValues ? [String(v ?? '')] : String(v ?? '').split(',').map(s => s.trim()).filter(Boolean)))),
          miniBtn('×', () => { const o = { ...getObj() }; delete o[k]; commitObj(o); render(); }),
        );
        container.append(line);
      });
      const addBtn = h('button', { class: 'btn sm pri', text: '＋ 添加条目', onclick: () => editEntry('', []) });   // pri：与 fake-ip 规则编辑器的添加按钮统一为主色
      // 按钮要和最后一行的分割线拉开距离，否则会紧贴在线上（其余列表编辑器都是 10px）
      container.append(h('div', { style: 'margin-top:10px' }, addBtn));
      enableDragSort(container, '.rule-item', reorder);
    } catch(e) {}
  }
  function commitObj(o) {
    if (!Object.keys(o).length && f.optional) return unset(target, f.path);
    return set(target, f.path, o);
  }
  function reorder(from, to) {
    const obj = getObj();
    const ks = Object.keys(obj);
    const [k] = ks.splice(from, 1);
    ks.splice(to, 0, k);
    reorderConfigMap(target, f.path, ks); render();
  }
  function editEntry(key, servers) {
    const kInput = h('input', { type: 'text', placeholder: f.keyPlaceholder || '键：如 geosite:cn 或 +.google.cn', value: key, style: 'width:100%' });
    const sInput = h(f.lineValues ? 'textarea' : 'input', { type: 'text', placeholder: f.lineValues ? '每行一条完整规则，条目内的逗号保持不变' : '服务器，多个用逗号分隔', value: servers.join(f.lineValues ? '\n' : ', '), style: 'width:100%' });
    // DNS 策略（nameserver-policy / proxy-server-nameserver-policy）的值同为服务器列表：
    // 提供可视化构建入口，拼好的串追加进值输入框，可连续添加多个，最后由「确定」统一提交
    const sRow = (f.dns && !f.lineValues)
      ? h('div', { class: 'addline' }, sInput, h('button', { class: 'btn sm', text: '可视化', onclick: () => {
          openDnsServerSheet((s) => {
            const cur = sInput.value.split(',').map(x => x.trim()).filter(Boolean);
            if (cur.includes(s)) { ntoast('该服务器已填入'); return; }
            cur.push(s);
            sInput.value = cur.join(', ');
          });
        }}))
      : sInput;
    const close = openChildSheet(key ? '编辑条目' : '添加条目',
      h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, kInput, sRow,
        h('div', { style: 'display:flex;gap:10px;margin-top:8px' },
          h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
          h('button', { class: 'btn block pri', text: '确定', onclick: () => {
            const k = kInput.value.trim();
            if (!k) { close(); return; }
            const servers2 = sInput.value.split(f.lineValues ? /\r?\n/ : ',').map(s => s.trim()).filter(Boolean);
            const o = { ...getObj() };
            if (k !== key && Object.prototype.hasOwnProperty.call(o, k)) { ntoast('键「' + k + '」已存在，请换一个名字'); return; }
            const arrayValue = f.lineValues || Array.isArray(o[key]) || servers2.length !== 1;
            if (key && key !== k) delete o[key];
            Object.defineProperty(o, k, { value: arrayValue ? servers2 : servers2[0], enumerable: true, configurable: true, writable: true });
            if (commitObj(o) === false) return;
            close(); render();
          } }),
        )));
  }
  function miniBtn(t, fn, disabled = false) { const b = h('button', { class: 'mini-btn', text: t, onclick: fn }); if (disabled) b.style.opacity = .35; return b; }
  render();
  return h('div', { class: 'f-row', style: 'align-items:flex-start' },
    h('div', { class: 'f-label' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null),
    h('div', { class: 'f-ctl', style: 'max-width:60%' }, container));
}

// ---------- 应用多选列表（可视化应用选择器） ----------
function appListField(f, target) {
  const wrap = h('div', {});
  const getItems = () => Array.isArray(get(target, f.path)) ? get(target, f.path) : [];
  function renderSummary() {
    wrap.innerHTML = '';
    const items = getItems();
    const txt = items.length ? `${items.length} 个应用` : '未选择（全部应用）';
    const btn = h('button', { class: 'btn sm', text: '选择应用', onclick: openPicker });
    wrap.append(h('div', { style: 'font-size:13.5px;color:var(--text-2);margin-bottom:8px', text: txt }), btn);
  }
  // 逐个数据源实测，明确指出卡在哪一步，避免反复猜测
  async function diagnosePkg() {
    const box = h('pre', { class: 'logbox', style: 'max-height:50dvh', text: '正在诊断…' });
    const close = openChildSheet('应用列表诊断', box);
    const steps = [
      ['whoami / id', 'id -u 2>&1'],
      ['模块脚本是否存在', 'ls -l /data/adb/modules/mihomo_box/scripts/mihomo.sh 2>&1'],
      ['packages.list 是否可读', 'ls -l /data/system/packages.list 2>&1'],
      ['packages.list 行数', 'wc -l < /data/system/packages.list 2>&1'],
      ['packages.list 首行', 'head -1 /data/system/packages.list 2>&1'],
      ['pkg-list 命令输出(前3行)', 'sh /data/adb/modules/mihomo_box/scripts/mihomo.sh pkg-list 2>&1 | head -3'],
      ['pkg-list 总条数', 'sh /data/adb/modules/mihomo_box/scripts/mihomo.sh pkg-list 2>/dev/null | wc -l'],
      ['pm 是否可用', 'pm list packages -3 2>&1 | head -2'],
      ['/data/data 可否枚举', 'ls /data/data 2>&1 | head -3'],
    ];
    let txt = '';
    for (const [name, cmd] of steps) {
      const r = await shell(cmd);
      if (!close.isCurrent()) return;
      const o = ((r && (r.stdout || r.stderr)) || '').trim() || '(空)';
      txt += `── ${name}\n$ ${cmd}\n${o}\n\n`;
      box.textContent = txt;
    }
    box.textContent = txt + '── 诊断结束';
    setSheetFooter(
      h('button', { class: 'btn block', text: '复制结果', onclick: async () => {
        const ok = await copyText(txt);
        ntoast(ok ? '已复制诊断结果' : '复制失败，请长按选中');
      } }),
      h('button', { class: 'btn block pri', text: '关闭', onclick: () => close() }));
  }

  // 包名含 . 等字符，放进属性选择器要转义
  const cssEsc = (v) => (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');

  // 取视口内最靠上的一行作为滚动锚点（排除刚被点击的那一行，
  // 因为它要换组、位置必然变化，拿它当锚点等于让视口追着它跑）
  function pickAnchorFactory(listBox) {
    return function pickAnchor(excludePkg) {
      const top = listBox.getBoundingClientRect().top;
      const rows = listBox.querySelectorAll('[data-pkg]');
      for (const el of rows) {
        if (el.dataset.pkg === excludePkg) continue;
        // 第一行底部越过容器顶边 = 在视口内可见
        if (el.getBoundingClientRect().bottom > top + 1) {
          return { el, pkg: el.dataset.pkg };
        }
      }
      return null;
    };
  }

  async function openPicker() {
    const close = openChildSheet(f.label + ' — 选择应用', h('div', { class: 'empty', text: '正在加载应用列表…' }));
    // 累计见过的包名：切换「显示系统应用」时已勾选项不会因列表重过滤而丢失
    const seenPkgs = new Set(getItems());
    // 手动填写的包名（可能不在已安装列表中），单独记一份以便渲染进列表
    const manualPkgs = [];
    let showSystem = false;
    let pkgs = [];
    const byPkg = {};
    let metadataEpoch = 0, pickerReady = false, metadataWarned = false;
    function applyMetadata(infos) {
      infos.forEach(i => { if (i?.packageName) byPkg[i.packageName] = i; });
      if (!pickerReady || !close.isCurrent()) return;
      // Patch existing rows only: no resort, checkbox replacement, or scroll reset.
      for (const info of infos) {
        const row = listBox.querySelector(`[data-pkg="${cssEsc(info.packageName)}"]`);
        if (!row) continue;
        const src = appIconSource(info.packageName, info);
        if (src && row.firstElementChild?.getAttribute('src') !== src) {
          row.firstElementChild.replaceWith(iconNode(info.packageName));
        }
      }
    }

    // 应用图标两种访问方式同源：模块组件产出的 PNG data URI（管理器自带的
    // ksu://icon 已停用——它只认管理器自己那份应用清单，清单外的包直接 404）。
    // 组件读不到图标 / 图解不出来时用首字母块补位，不留破图空位。
    let iconTileUsed = 0, iconTileNoteTimer = 0;
    // 图标是分批到达、陆续失败的，等这一波过去再汇总一行，不逐张写日志
    function noteIconTile() {
      if (iconTileNoteTimer) clearTimeout(iconTileNoteTimer);
      iconTileNoteTimer = setTimeout(() => {
        iconTileNoteTimer = 0;
        uiLog('info', '应用图标缺失', `${iconTileUsed} 个应用没有可用图标，已用首字母块显示`);
      }, 1500);
    }
    function iconNode(pkg) {
      const src = appIconSource(pkg, byPkg[pkg]);
      if (!src) return letterIcon(nameOf(pkg));
      const img = h('img', { src, alt: '', loading: 'lazy', decoding: 'async', width: 38, height: 38,
        style: 'width:38px;height:38px;border-radius:10px;flex:none;background:var(--fill)',
        dataset: { iconTile: '1' } });   // 有首字母块兜底，失败不写错误日志（core.js 据此跳过）
      img.onerror = () => {
        if (!img.parentNode) return;
        img.replaceWith(letterIcon(nameOf(pkg)));
        iconTileUsed++; noteIconTile();
      };
      return img;
    }

    async function loadPkgs() {
      const epoch = ++metadataEpoch;
      let list = [];
      try {
        list = showSystem ? (await listPackagesAsync('all') || []) : (await listPackagesAsync('user') || []);
      } catch (e) { list = []; }
      if (epoch !== metadataEpoch || !close.isCurrent()) return pkgs;
      pkgs = [...new Set(list.filter(Boolean))];
      pkgs.forEach(p => seenPkgs.add(p));
      // 管理器与浏览器同一套流程：名称一次批量读完先渲染，图标随后分批补上。
      const labels = await getPackageLabelsAsync(pkgs, () => close.isCurrent() && epoch === metadataEpoch);
      if (!close.isCurrent() || epoch !== metadataEpoch) return pkgs;
      labels.forEach(i => { if (i?.packageName) byPkg[i.packageName] = i; });
      // 组件读不到时界面只剩包名 + 首字母块，把真实原因写进日志便于排查
      //（面板内不放提示条：弹层顶部必须紧跟搜索框）。
      const why = lastPackageInfoError() || lastPackageError();
      if (why && !metadataWarned) {
        metadataWarned = true;
        uiLog('warn', '应用信息读取失败', why);
      }
      const wanted = [...pkgs];
      // Do not await metadata before rendering the picker.
      setTimeout(() => {
        if (!close.isCurrent() || epoch !== metadataEpoch) return;
        getPackageIconsAsync(wanted, infos => {
          if (close.isCurrent() && epoch === metadataEpoch) applyMetadata(infos);
        }, () => close.isCurrent() && epoch === metadataEpoch).catch(() => {
          // Icon errors retain placeholders; no banner above the search input.
        });
      }, 0);
      return pkgs;
    }

    await loadPkgs();
    if (!close.isCurrent()) return;
    // Empty lists still allow manual package entry; no pre-input notice panel.
    const loadFailed = !pkgs.length;
    const current = new Set(getItems());
    const search = h('input', { type: 'text', placeholder: '搜索，或输入完整包名后点添加',
      style: 'flex:1;min-width:0', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
    const listBox = h('div', { class: 'pick-list' });
    const pickAnchor = pickAnchorFactory(listBox);
    // 确定按钮计数实时刷新（此前只在弹层创建时渲染一次,恒为初值 0）
    const okBtn = h('button', { class: 'btn block pri', text: '', onclick: () => {
      // 以累计集合为基准提交，避免列表过滤时丢掉已勾选的包名（如系统应用）
      const arr = [...seenPkgs].filter(p => current.has(p));
      if (!arr.length && f.optional) unset(target, f.path);
      else set(target, f.path, arr);
      close(); renderSummary();
    } });
    const syncOkBtn = () => { okBtn.textContent = `确定 (${current.size})`; };
    const letterIcon = (nm) => h('div', { class: 'lead-icon', text: (nm[0] || '?').toUpperCase(), style: 'width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:var(--fill);font-weight:700;flex:none' });
    const nameOf = (pkg) => {
      const info = byPkg[pkg] || {};
      // KernelSU WebUI 真实字段是 appLabel（还有 versionName/uid 等）,不是 appName/label
      return info.appLabel || info.appName || info.label || pkg;
    };
    function rowFor(pkg) {
      const name = nameOf(pkg);
      const cb = h('input', { type: 'checkbox', checked: current.has(pkg) });
      const sw = h('label', { class: 'switch' }, cb, h('span', { class: 'tr' }), h('span', { class: 'th' }));
      cb.onchange = () => {
        if (cb.checked) current.add(pkg); else current.delete(pkg);
        syncOkBtn();
        // 立即重排到「已选择」分组。
        // 锚点必须选一个「不会换组」的邻居行——被点的这一行本身要移走，
        // 拿它当锚点会让视口跟着它跑到顶部（批量勾选时每点一次跳一次）。
        // 这里取当前视口内最靠上的其它行作锚，重排后把它拉回原位，
        // 于是手指周围的内容保持不动，可以连续勾选/取消。
        const anchor = pickAnchor(pkg);
        const before = anchor ? anchor.el.getBoundingClientRect().top : 0;
        repin();
        renderList();
        if (anchor) {
          const back = listBox.querySelector(`[data-pkg="${cssEsc(anchor.pkg)}"]`);
          if (back) listBox.scrollTop += (back.getBoundingClientRect().top - before);
        }
      };
      // 管理器用原生图标协议，读不到时回退到模块组件（见 iconNode）；
      // 浏览器模式直接用 Android helper 返回的 PNG data URI。
      const img = iconNode(pkg);
      const row = h('div', { class: 'app-row', dataset: { q: (name + ' ' + pkg).toLowerCase(), pkg } },
        img,
        h('div', { class: 'app-name' }, h('div', { class: 'n', text: name }), h('div', { class: 'p', text: pkg })),
        sw);
      // 开关节点让原生 label 行为切换（点击 label 会联动 input 并触发 change）；
      // 这里若再手动切换会与原生行为叠加 = 点了没反应,故只在开关之外的行体区域手动切换
      row.onclick = (e) => { if (!sw.contains(e.target)) { cb.checked = !cb.checked; cb.onchange(); } };
      return row;
    }
    // 置顶顺序快照：勾选状态一变就重排会让行在手指底下跳走，
    // 所以只在「打开弹层 / 搜索 / 切换系统应用」时重新计算，
    // 单纯勾选不触发重排。
    let pinned = new Set(current);
    const repin = () => { pinned = new Set(current); };

    function renderList() {
      const q = search.value.trim().toLowerCase();
      listBox.innerHTML = '';
      const match = (p) => !q || nameOf(p).toLowerCase().includes(q) || p.toLowerCase().includes(q);

      // 真实已安装列表计数不随勾选、置顶或手动添加变化。
      const installedCount = new Set(pkgs).size;
      listBox.append(h('div', { class: 'app-sec', text:
        `${showSystem ? '全部已安装应用' : '用户应用'} (${installedCount})`
        + (q ? ` · 搜索匹配 (${pkgs.filter(match).length})` : '') }));

      // 已选应用即使不在当前列表里（例如只显示用户应用、但选中过系统应用）
      // 也要列出来，否则用户看不到、也取消不掉
      const pool = [...new Set([...pinned, ...manualPkgs, ...pkgs])];
      const top = pool.filter(p => pinned.has(p) && match(p)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      const rest = pool.filter(p => !pinned.has(p) && match(p)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

      // 全量渲染，不做数量截断：系统应用打开后动辄几百个，
      // 截断会让用户以为列表不全，还得靠搜索才能找到目标。
      if (top.length) {
        listBox.append(h('div', { class: 'app-sec', text: `已选择 (${top.length})` }));
        top.forEach(p => listBox.append(rowFor(p)));
        if (rest.length) listBox.append(h('div', { class: 'app-sec', text: `其他应用 (${rest.length})` }));
      }
      rest.forEach(p => listBox.append(rowFor(p)));

      if (!top.length && !rest.length) {
        listBox.append(h('div', { class: 'empty',
          text: loadFailed ? '在上方输入完整包名并点「添加」' : '无匹配应用' }));
      }
    }
    // ---- 手动添加包名 ----
    // 应用列表拿不到时（pm 受限 / 冷门 ROM）也得能配置；
    // 另外有些包名压根不在已安装列表里（如尚未安装、或多用户下的其它 profile）。
    // 直接复用搜索框：输入的内容既是过滤条件，也可一键加为包名。
    // 允许无点的单段包名：系统里确实存在（如 "android"）。
    // 仍严格限定字符集，杜绝空格、分号等注入字符混进后续 shell 命令。
    const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
    const addBtn = h('button', { class: 'btn sm pri', style: 'flex:none', text: '添加', onclick: () => {
      const v = search.value.trim();
      if (!PKG_RE.test(v)) { ntoast('包名格式不对，只能用字母、数字、下划线和点', 2800); return; }
      if (current.has(v)) { ntoast('该包名已在已选列表中'); return; }
      current.add(v);
      seenPkgs.add(v);
      if (!manualPkgs.includes(v)) manualPkgs.push(v);   // 并入列表，保证可见可取消
      search.value = '';
      repin(); syncOkBtn(); renderList();
      ntoast('已添加 ' + v);
    } });
    const syncAddBtn = () => {
      const v = search.value.trim();
      // 已在列表里的包名不需要「添加」，避免与搜索行为混淆
      const known = pkgs.includes(v) || current.has(v);
      addBtn.disabled = !PKG_RE.test(v) || known;
    };
    const searchRow = h('div', { style: 'display:flex;gap:8px;margin-bottom:10px' }, search, addBtn);

    search.oninput = () => { syncAddBtn(); repin(); renderList(); };
    // 回车直接添加，省一次点击
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !addBtn.disabled) { e.preventDefault(); addBtn.click(); }
    });
    syncAddBtn();
    renderList();
    syncOkBtn();
    // 系统应用开关：默认只列用户应用，打开后包含系统应用（不会丢掉已勾选项）
    const sysRow = h('div', { class: 'f-row', style: 'margin:2px 0 10px' },
      h('div', { class: 'f-label' }, '显示系统应用'),
      h('div', { class: 'f-ctl' }, switchCtl(false, async (v) => {
        showSystem = !!v;
        listBox.innerHTML = '';
        listBox.append(h('div', { class: 'empty', text: '正在加载应用列表…' }));
        await loadPkgs();
        if (!close.isCurrent()) return;
        repin();
        renderList();
      })));
    document.getElementById('sheetContent').replaceChildren(
      ...[h('h3', { text: f.label }), searchRow,
          loadFailed ? null : sysRow, listBox].filter(Boolean));
    pickerReady = true;
    // 清空 / 确定放固定底栏：列表很长时滚动也能随时确认
    setSheetFooter(
      h('button', { class: 'btn block', text: '清空', onclick: () => { current.clear(); manualPkgs.length = 0; repin(); syncAddBtn(); syncOkBtn(); renderList(); } }),
      okBtn);
  }
  renderSummary();
  return h('div', { class: 'f-row', style: 'align-items:flex-start' },
    h('div', { class: 'f-label' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null),
    h('div', { class: 'f-ctl', style: 'max-width:60%' }, wrap));
}

// ---------- 规则集多选（eBPF bypass-rule-set 等）----------
// 已有规则集来自 config 的 rule-providers 键名；也支持手动输入引用尚未创建的规则集
export function ruleSetNames() {
  const rp = state.cfg && state.cfg['rule-providers'];
  if (!rp || typeof rp !== 'object' || Array.isArray(rp)) return [];
  return Object.keys(rp).filter(Boolean);
}

function ruleSetPickField(f, target) {
  const wrap = h('div', { style: 'width:100%' });
  const getItems = () => {
    const v = get(target, f.path);
    return Array.isArray(v) ? v.filter(x => x !== undefined && x !== null && x !== '') : [];
  };
  function commit(arr) {
    if (!arr.length && f.optional) unset(target, f.path);
    else set(target, f.path, arr);
    markDirty(target);
  }
  function render() {
    try {
      wrap.innerHTML = '';
      const items = getItems();
      const chips = h('div', { class: 'chips' });
      if (!items.length) {
        chips.append(h('span', { style: 'color:var(--text-3);font-size:12.5px', text: '未选择' }));
      } else {
        items.forEach((it, i) => {
          const chip = h('span', { class: 'chip' }, h('span', { text: String(it), style: 'user-select:text' }));
          const x = h('button', { class: 'x', text: '×', title: '删除' });
          x.onclick = () => { const a = getItems(); a.splice(i, 1); commit(a); render(); };
          chip.append(x);
          chips.append(chip);
        });
      }
      wrap.append(chips);

      const pickBtn = h('button', { class: 'btn sm', text: '选择规则集', onclick: openPicker });
      const manual = h('input', { type: 'text', placeholder: '手动输入规则集名', style: 'flex:1' });
      const addBtn = h('button', { class: 'btn sm', text: '添加', onclick: () => {
        const v = manual.value.trim();
        if (!v) return;
        const a = getItems();
        if (!a.includes(v)) { a.push(v); commit(a); }
        manual.value = '';
        render();
      } });
      manual.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.onclick(); } });
      wrap.append(h('div', { class: 'addline' }, pickBtn, manual, addBtn));

      const names = ruleSetNames();
      if (!names.length) {
        wrap.append(h('div', { class: 'f-desc', style: 'margin-top:6px', text: '当前尚未添加任何规则集，可在「分流 → 规则集」中添加后再选择' }));
      }
    } catch(e) {}
  }

  function openPicker() {
    const names = ruleSetNames();
    const close = openChildSheet(f.label + ' — 选择规则集', h('div', { class: 'empty', text: '加载中…' }));
    if (!names.length) {
      document.getElementById('sheetContent').replaceChildren(
        h('h3', { text: f.label }),
        h('div', { class: 'empty', html: '尚未添加规则集<br>请先到「分流 → 规则集」添加，或用上方输入框手动填写' }),
        h('button', { class: 'btn block', style: 'margin-top:14px', text: '关闭', onclick: () => close() }));
      return;
    }
    const current = new Set(getItems());
    const search = h('input', { type: 'text', placeholder: '🔍 搜索规则集名', style: 'width:100%;margin-bottom:10px' });
    const listBox = h('div', { class: 'pick-list' });
    const okBtn = h('button', { class: 'btn block pri', text: '', onclick: () => {
      // current 初始化时已含手写/未知条目；确认只采用最终选择，不把取消项并回来。
      commit([...current]);
      close(); render();
    } });
    const syncOkBtn = () => { okBtn.textContent = `确定 (${current.size})`; };
    function rowFor(name) {
      const cb = h('input', { type: 'checkbox', checked: current.has(name) });
      const sw = h('label', { class: 'switch' }, cb, h('span', { class: 'tr' }), h('span', { class: 'th' }));
      cb.onchange = () => { if (cb.checked) current.add(name); else current.delete(name); syncOkBtn(); };
      const row = h('div', { class: 'app-row', dataset: { q: name.toLowerCase() } },
        h('div', { class: 'app-name' }, h('div', { class: 'n', text: name }), h('div', { class: 'p', text: 'rule-provider' })),
        sw);
      row.onclick = (e) => { if (!sw.contains(e.target)) { cb.checked = !cb.checked; cb.onchange(); } };
      return row;
    }
    function renderList() {
      const q = search.value.trim().toLowerCase();
      listBox.innerHTML = '';
      const shown = names.filter(n => !q || n.toLowerCase().includes(q));
      shown.forEach(n => listBox.append(rowFor(n)));
      if (!shown.length) listBox.append(h('div', { class: 'empty', text: '无匹配规则集' }));
    }
    search.oninput = renderList;
    renderList();
    syncOkBtn();
    document.getElementById('sheetContent').replaceChildren(
      h('h3', { text: f.label }),
      search,
      listBox);
    // 清空 / 确定放固定底栏
    setSheetFooter(
      h('button', { class: 'btn block', text: '清空', onclick: () => { current.clear(); syncOkBtn(); renderList(); } }),
      okBtn);
  }

  render();
  return h('div', { class: 'f-row', style: 'align-items:flex-start' },
    h('div', { class: 'f-label' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null, f.tag ? (' ', badge(f.tag, f.tagCls || 'p')) : null),
    h('div', { class: 'f-ctl', style: 'max-width:60%' }, wrap));
}

// ---------- 页面渲染 ----------
export function renderSections(el, sections, target = state.cfg) {
  el.innerHTML = '';
  for (const s of sections) {
    if (s.hide) continue;
    if (s.note) el.append(note(s.note, s.noteCls));
    if (s.title) el.append(groupTitle(s.title));
    const fs = (s.fields || []).filter(Boolean);
    if (!fs.length) continue;          // 纯说明 note 项：不再产出空白卡片
    const c = h('div', { class: 'card' });
    fs.forEach(f => c.append(fieldRow(f, target)));
    el.append(c);
  }
}


// ============================================================
// 入站用户列表编辑器
// mihomo 的入站 users 有两种形态，写错内核会直接拒绝启动：
//   A. 数组对象 []User —— vmess/vless/trojan/http/socks/mixed
//      且这些协议的 users 标签没有 omitempty（vmess/vless/trojan），
//      缺失时报 "has unset fields: users"
//   B. 映射 map[string]string —— hysteria2/tuic/anytls
// 本编辑器负责 A：按协议给出正确的字段列（uuid / password / flow / alterId），
// 保证写出的 YAML 与内核结构体严格对应。
// ============================================================
function userListEditor(f, target) {
  const cols = f.columns || [];
  const rowsBox = h('div', { class: 'ulist' });

  const read = () => {
    const v = get(target, f.path);
    if (Array.isArray(v)) return v.filter(x => x && typeof x === 'object');
    // 兼容历史错误数据：曾经写成 {名字: 值} 映射，这里迁移成数组对象
    if (v && typeof v === 'object') {
      const keyCol = cols.find(c => c.key !== 'username');
      return Object.entries(v).map(([k, val]) => {
        const o = { username: k };
        if (keyCol) o[keyCol.key] = String(val);
        return o;
      });
    }
    return [];
  };

  let users = read();

  const commit = () => {
    // 主字段（uuid / password）为空的行直接丢弃，避免写出内核无法解析的空用户
    const main = cols.find(c => c.required) || cols[1] || cols[0];
    const out = users
      .filter(u => String(u[main.key] || '').trim())
      .map(u => {
        const o = {};
        cols.forEach(c => {
          const raw = u[c.key];
          if (raw === undefined || raw === null || String(raw).trim() === '') return;
          o[c.key] = c.num ? Number(raw) : String(raw).trim();
        });
        return o;
      });
    if (!out.length) unset(target, f.path);
    else set(target, f.path, out);
    markDirty(target);
  };

  const uuidV4 = () => {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    const b = new Uint8Array(16);
    (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); });
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  const render = () => {
    rowsBox.innerHTML = '';
    if (!users.length) {
      rowsBox.append(h('div', { class: 'empty', text: '尚未添加用户，点下方按钮新增' }));
    }
    users.forEach((u, i) => {
      const card = h('div', { class: 'ulist-item' });
      const head = h('div', { class: 'ulist-head' },
        h('span', { class: 'ulist-idx', text: '用户 ' + (i + 1) }),
        h('button', { class: 'mini-btn', text: '×', onclick: () => { users.splice(i, 1); commit(); render(); } }));
      card.append(head);
      cols.forEach(c => {
        const inp = h('input', {
          type: 'text', value: u[c.key] === undefined ? '' : String(u[c.key]),
          placeholder: c.placeholder || c.label,
          inputmode: c.num ? 'numeric' : 'text',
          spellcheck: false, autocapitalize: 'off', autocomplete: 'off',
          style: 'width:100%',
        });
        inp.addEventListener('input', () => { u[c.key] = inp.value; });
        inp.addEventListener('change', commit);
        inp.addEventListener('blur', commit);
        const genBtn = c.uuid
          ? h('button', { class: 'btn xs', text: '生成', onclick: () => { u[c.key] = uuidV4(); inp.value = u[c.key]; commit(); } })
          : null;
        card.append(h('div', { class: 'ulist-field' },
          h('div', { class: 'ulist-key' }, c.label, c.required ? h('span', { class: 'req', text: ' *' }) : null),
          h('div', { class: 'ulist-val' }, inp, genBtn)));
      });
      rowsBox.append(card);
    });
  };

  const addBtn = h('button', { class: 'btn sm pri', text: '＋ 添加用户', onclick: () => {
    const o = {};
    cols.forEach(c => { o[c.key] = c.uuid ? uuidV4() : (c.def !== undefined ? c.def : ''); });
    if (!o.username) o.username = 'user' + (users.length + 1);
    users.push(o);
    commit(); render();
  } });

  render();
  return h('div', { class: 'f-row', style: 'align-items:flex-start;flex-direction:column;gap:8px' },
    h('div', { class: 'f-label', style: 'width:100%' }, f.label,
      f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null),
    h('div', { style: 'width:100%' }, rowsBox, h('div', { style: 'margin-top:8px' }, addBtn)));
}

// ---------- fake-ip 规则可视化编辑器（安全版，无轮询） ----------
function fakeIpRuleEditor(f, target) {
  const container = h('div', { style: 'width:100%' });
  const getMode = () => {
    try { const v = get(state.cfg, 'dns.fake-ip-filter-mode'); return v ? String(v) : ''; } catch(e) { return ''; }
  };
  const read = () => {
    const v = get(target, f.path);
    return Array.isArray(v) ? [...v] : [];
  };
  const commit = (arr) => {
    if (!arr.length && f.optional) unset(target, f.path);
    else set(target, f.path, arr);
    try { markDirty(target); } catch(e) {}
  };
  const RULE_TYPES = ['DOMAIN','DOMAIN-SUFFIX','DOMAIN-KEYWORD','DOMAIN-REGEX','DOMAIN-WILDCARD','GEOSITE','GEOIP','RULE-SET','MATCH'];
  const parseRule = (s) => {
    const str = String(s || '').trim();
    if (!str) return { type: 'DOMAIN-SUFFIX', value: '', action: 'fake-ip' };
    const parts = str.split(',').map(x=>x.trim()).filter(Boolean);
    if (!parts.length) return { type: 'DOMAIN-SUFFIX', value: '', action: 'fake-ip' };
    const last = parts[parts.length-1].toLowerCase();
    let action = 'fake-ip';
    let body = parts;
    if (last === 'fake-ip' || last === 'real-ip') { action = last; body = parts.slice(0,-1); }
    if (!body.length) return { type: 'MATCH', value: '', action };
    const type = body[0].toUpperCase();
    if (type === 'MATCH') return { type: 'MATCH', value: '', action };
    const value = body.slice(1).join(',');
    return { type: type || 'DOMAIN-SUFFIX', value: value || '', action };
  };
  const stringifyRule = (o) => {
    const type = String(o.type || '').trim().toUpperCase();
    const action = String(o.action || 'fake-ip').toLowerCase() === 'real-ip' ? 'real-ip' : 'fake-ip';
    if (type === 'MATCH') return `MATCH,${action}`;
    const val = String(o.value || '').trim();
    if (!val) return `${type},${action}`;
    return `${type},${val},${action}`;
  };
  function miniBtn2(t, fn) { const b = h('button', { class: 'mini-btn', text: t, onclick: fn }); return b; }

  function render() {
    try {
      const mode = getMode();
      const isRule = mode === 'rule';
      container.innerHTML = '';
      const items = read();
      if (!items.length) {
        container.append(h('div', { class: 'empty', text: isRule ? '暂无规则，点下方按钮新增（逐条匹配 fake-ip/real-ip）' : '未设置，黑/白名单模式直接填域名' }));
      } else {
        items.forEach((raw, idx) => {
          const line = h('div', { class: 'rule-item' });
          if (isRule) {
            const parsed = parseRule(raw);
            const badgeAction = parsed.action === 'fake-ip' ? h('span', { class: 'badge g', text: 'fake-ip' }) : h('span', { class: 'badge o', text: 'real-ip' });
            const txt = parsed.type === 'MATCH' ? `MATCH → ${parsed.action}` : `${parsed.type}, ${parsed.value || '—'} → ${parsed.action}`;
            line.append(
              h('span', { class: 'drag-handle', title: '拖动排序', html: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="5" cy="3" r="1.4"/><circle cx="5" cy="8" r="1.4"/><circle cx="5" cy="13" r="1.4"/><circle cx="11" cy="3" r="1.4"/><circle cx="11" cy="8" r="1.4"/><circle cx="11" cy="13" r="1.4"/></svg>' }),
              h('code', { text: txt, style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }),
              badgeAction,
              miniBtn2('✎', () => editRule(idx, raw)),
              miniBtn2('×', () => { const a = read(); a.splice(idx,1); commit(a); render(); }),
            );
          } else {
            line.append(
              h('span', { class: 'drag-handle', title: '拖动排序', html: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="5" cy="3" r="1.4"/><circle cx="5" cy="8" r="1.4"/><circle cx="5" cy="13" r="1.4"/><circle cx="11" cy="3" r="1.4"/><circle cx="11" cy="8" r="1.4"/><circle cx="11" cy="13" r="1.4"/></svg>' }),
              h('code', { text: String(raw), style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }),
              miniBtn2('✎', () => editSimple(idx, raw)),
              miniBtn2('×', () => { const a = read(); a.splice(idx,1); commit(a); render(); }),
            );
          }
          container.append(line);
        });
        try { enableDragSort(container, '.rule-item', (from,to)=>{ const a=read(); const [m]=a.splice(from,1); a.splice(to,0,m); commit(a); render(); }); } catch(e) {}
      }
      const addBtn = h('button', { class: 'btn sm pri', text: isRule ? '＋ 添加规则' : '＋ 添加条目', onclick: () => { if (isRule) editRule(-1, ''); else editSimple(-1,''); } });
      const tip = isRule
        ? h('div', { class: 'f-desc', style: 'margin-top:8px', html: 'rule 模式按自上而下匹配，末条建议 <code>MATCH,fake-ip</code> 或 <code>MATCH,real-ip</code> 兜底；支持 DOMAIN / GEOSITE / RULE-SET 等' })
        : h('div', { class: 'f-desc', style: 'margin-top:8px', text: '黑名单=命中走 real-ip；白名单=仅命中走 fake-ip；支持 *.lan / +.lan / geosite:cn / rule-set:xxx' });
      const addRow = h('div', { style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap' }, addBtn);
      if (isRule) addRow.append(h('button', { class: 'btn sm', text: '添加 MATCH 兜底', onclick: ()=>{ const a=read(); a.push('MATCH,fake-ip'); commit(a); render(); } }));
      container.append(addRow, tip);
      if (isRule && items.length) {
        const ex = h('div', { class: 'f-desc', style: 'margin-top:6px', html: '示例：<code>GEOSITE,gfw,fake-ip</code> <code>DOMAIN,example.com,real-ip</code> <code>RULE-SET,cn,real-ip</code>' });
        container.append(ex);
      }
    } catch(e) {
      console.error('fakeIpRuleEditor render error', e);
      container.innerHTML='';
      container.append(h('div', {class:'note warn', text:'渲染失败：'+(e.message||e)}));
    }
  }

  function editSimple(idx, raw) {
    const input = h('input', { type: 'text', value: String(raw||''), placeholder: '*.lan / +.lan / geosite:cn / rule-set:xxx', style: 'width:100%' });
    const close = openChildSheet(idx>=0?'编辑条目':'添加条目', h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, input,
      h('div', { style: 'display:flex;gap:10px;margin-top:8px' },
        h('button', { class: 'btn block', text: '取消', onclick: ()=>close() }),
        h('button', { class: 'btn block pri', text: '确定', onclick: ()=>{
          const v = input.value.trim();
          if (!v) { close(); return; }
          const a = read();
          if (idx>=0) a[idx]=v; else a.push(v);
          commit(a); close(); render();
        }})
      )));
  }
  function editRule(idx, raw) {
    const cur = parseRule(raw);
    const typeSel = selectCtl(RULE_TYPES.map(v=>[v,v]), cur.type, { title: '规则类型' });
    const valInput = h('input', { type: 'text', value: cur.value, placeholder: '匹配值，如 example.com / gfw / my-rule-set', style: 'width:100%' });
    const actSel = selectCtl([['fake-ip','fake-ip（走虚拟 IP）'],['real-ip','real-ip（走真实解析）']], cur.action, { title: '动作' });
    const valRow = h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '匹配值', h('div', { class: 'f-desc', text: 'MATCH 类型无需填写' })), h('div', { class: 'f-ctl' }, valInput));
    const syncValRow = () => { try{ valRow.style.display = (typeSel.value === 'MATCH') ? 'none' : ''; }catch(e){} };
    try{ typeSel.addEventListener('change', syncValRow); }catch(e){}
    syncValRow();
    const close = openChildSheet(idx>=0?'编辑规则':'添加规则',
      h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
        h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '类型'), h('div', { class: 'f-ctl' }, typeSel)),
        valRow,
        h('div', { class: 'f-row' }, h('div', { class: 'f-label' }, '动作'), h('div', { class: 'f-ctl' }, actSel)),
        h('div', { class: 'f-desc', html: '保存后写入如 <code>GEOSITE,gfw,fake-ip</code>；拖动可排序，越上优先级越高' }),
        h('div', { style: 'display:flex;gap:10px;margin-top:8px' },
          h('button', { class: 'btn block', text: '取消', onclick: ()=>close() }),
          h('button', { class: 'btn block pri', text: '确定', onclick: ()=>{
            const t = typeSel.value;
            const v = valInput.value.trim();
            const a = actSel.value;
            if (t !== 'MATCH' && !v) { ntoast('请填写匹配值'); return; }
            const out = stringifyRule({type:t, value:v, action:a});
            const arr = read();
            if (idx>=0) arr[idx]=out; else arr.push(out);
            commit(arr); close(); render();
          }})
        )
      ));
  }

  render();
  // 即时响应：全局 cfg-change 事件来自 core.js set/unset，切换过滤模式后 0ms 重绘
  container._lastMode = getMode();
  const onCfgChange = (e)=>{
    try{
      const p = e.detail?.path || '';
      if(p === 'dns.fake-ip-filter-mode' || p === 'dns.fake-ip-filter'){
        const m=getMode();
        if(m!==container._lastMode){ container._lastMode=m; render(); }
      }
    }catch(err){}
  };
  try{ document.addEventListener('cfg-change', onCfgChange); }catch(e){}
  // 容器被重建后本监听即成孤儿：在 document 上自摘除，防多次重绘叠加成回调风暴（卡顿源之一）
  const heal = () => { try { if (!container.isConnected) { document.removeEventListener('cfg-change', onCfgChange); document.removeEventListener('cfg-change', heal); } } catch(e){} };
  try { document.addEventListener('cfg-change', heal, { once: false }); } catch(e){}
  // DOM 兜底：selectCtl 直接派发 change 时也能触发（无延迟）
  const attachDomListener = ()=>{
    try{
      const card = container.closest('.card');
      if(!card) return false;
      const sels = card.querySelectorAll('.selctl');
      for(const el of sels){
        const label = el.closest('.f-row')?.querySelector('.f-label');
        if(label && label.textContent.includes('过滤模式')){
          if(!el._fakeIpDomBound){
            el._fakeIpDomBound = true;
            el.addEventListener('change', ()=>{
              try{ const m=getMode(); if(m!==container._lastMode){ container._lastMode=m; render(); } }catch(ex){}
            });
          }
          return true;
        }
      }
      return false;
    }catch(ex){ return false; }
  };
  if(!attachDomListener()){
    setTimeout(attachDomListener, 30);
  }

  return h('div', { class: 'f-row', style: 'align-items:flex-start;flex-direction:column;gap:8px' },
    h('div', { class: 'f-label', style: 'width:100%' }, f.label, f.desc ? h('div', { class: 'f-desc', text: f.desc }) : null, f.tag ? (' ', badge(f.tag, f.tagCls||'p')) : null),
    h('div', { style: 'width:100%' }, container));
}
