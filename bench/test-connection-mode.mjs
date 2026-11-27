#!/usr/bin/env node
// Regression for the dashboard「代理模式」statistic (webroot/ui/js/connection-mode.js):
//
//   这一格回答的是「现在流量从哪条透明接管通道进内核」，所以只认这几种入站类型：
//   Tun / Redir / TProxy / EBPF（Redir 是 iptables REDIRECT 型接管，与 TUN 同一套
//   栈，界面上并入 TUN）。曾经的做法是「只过滤 Inner、其余全列」，于是 lo 或
//   局域网回注进来的 Mixed / Socks5 / HTTP 连接、以及内核自己的 Inner 连接
//   都会混进来，读起来是噪音而不是结论。现在的规则：
//     · Inner 与 Mixed / Socks / HTTP 等回注入站 → 一律不计；
//     · 大小写不敏感（内核输出 'Tun' / 'TProxy' / 'EBPF'，配置里写 'tun'）；
//     · 输出顺序固定 TUN → Tproxy → eBPF，不依赖 localeCompare；
//     · 有连接但没有一条走接管 → 「无接管」；完全没有连接 → 「暂无连接」；
//     · types 仍按内核原样字符串给出（诊断/测试用），count 只数接管连接。
//   ./bench/test-connection-mode.mjs        （或 node bench/test-connection-mode.mjs）
//   ⚠ 这是唯一的 .mjs 回归：前端模块是 ESM，用 node 直接 import 生产代码最省事，
//     不必在 shell 里手搓替身；其余 bench/test-*.sh 仍是纯 sh。
import assert from 'node:assert/strict';
import { summarizeConnectionTypes, TAKEOVER_TYPES } from '../webroot/ui/js/connection-mode.js';

const C = (type, extra = {}) => ({ metadata: { type, ...extra } });
const label = data => summarizeConnectionTypes(data).label;
let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('ok -', name); };

t('接管类型与界面文案：Redir 并入 TUN', () => {
  assert.deepEqual(TAKEOVER_TYPES.map(x => [x.type, x.label]),
    [['Tun', 'TUN'], ['Redir', 'TUN'], ['TPROXY', 'Tproxy'], ['EBPF', 'eBPF']]);
});

t('只有 Redir → 显示 TUN', () => {
  assert.equal(label({ connections: [C('Redir')] }), 'TUN');
});

t('Tun + Redir 同时在 → 合并成一个 TUN，不重复', () => {
  const r = summarizeConnectionTypes({ connections: [C('Tun'), C('Redir'), C('Redir')] });
  assert.equal(r.label, 'TUN');
  assert.deepEqual(r.types, ['Tun', 'Redir']);
  assert.equal(r.count, 3);
});

t('Redir（小写）也认', () => {
  assert.equal(label({ connections: [C('redir')] }), 'TUN');
});

t('Redir + Tproxy → TUN / Tproxy', () => {
  assert.equal(label({ connections: [C('Redir'), C('TPROXY')] }), 'TUN / Tproxy');
});

t('空列表 → 暂无连接', () => {
  assert.equal(label({ connections: [] }), '暂无连接');
});

t('只有 Inner → 无接管（Inner 不再参与，但也不算接管）', () => {
  assert.equal(label({ connections: [C('Inner'), C('Inner')] }), '无接管');
});

t('Mixed / Socks / HTTP 回注入站 → 无接管', () => {
  assert.equal(label({ connections: [C('Socks5'), C('HTTP'), C('Mixed')] }), '无接管');
});

t('Inner 与 Mixed 不再混进 TUN 的读数', () => {
  assert.equal(label({ connections: [C('Tun'), C('Inner'), C('Socks5')] }), 'TUN');
});

t('eBPF 大写/小写都认', () => {
  assert.equal(label({ connections: [C('EBPF')] }), 'eBPF');
  assert.equal(label({ connections: [C('ebpf')] }), 'eBPF');
});

t('TProxy 大写/小写都认，显示 Tproxy', () => {
  assert.equal(label({ connections: [C('TProxy')] }), 'Tproxy');
  assert.equal(label({ connections: [C('tproxy')] }), 'Tproxy');
});

t('全部同时出现：顺序固定 TUN → Tproxy → eBPF（Redir 并进 TUN）', () => {
  assert.equal(label({ connections: [C('EBPF'), C('Redir'), C('Tun'), C('TProxy')] }),
    'TUN / Tproxy / eBPF');
});

t('count 只数接管连接，且 types 保持内核原样字符串', () => {
  const r = summarizeConnectionTypes({ connections: [C('Tun'), C('Tun'), C('Inner'), C('Socks5')] });
  assert.deepEqual(r, { label: 'TUN', types: ['Tun'], count: 2 });
});

t('type 缺失 / 空串 / 非字符串 → 不计入', () => {
  assert.equal(label({ connections: [C(''), {}, { metadata: null }, C('   ')] }), '无接管');
});

t('未知/新增的入站类型不会漏进读数', () => {
  assert.equal(label({ connections: [C('Tailscale'), C('Cns'), C('Trojan')] }), '无接管');
});

t('大小写混写（含 Redir）', () => {
  assert.equal(label({ connections: [C('redir'), C('tproxy'), C('Ebpf')] }), 'TUN / Tproxy / eBPF');
});

t('无效响应仍然抛错（调用方据此显示「读取失败」）', () => {
  assert.throws(() => summarizeConnectionTypes(null), /连接列表无效/);
  assert.throws(() => summarizeConnectionTypes({}), /连接列表无效/);
});

console.log(`\nconnection-mode regression: PASS (${n} cases)`);
