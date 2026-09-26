// ============================================================
// 内核管理：下载 / 切换 / 导入 / Geo 数据
// ============================================================
import { h, state, badge, note, groupTitle, card, ntoast, confirmSheet, openSheet, closeSheet, setSheetFooter, cmdline, switchCtl, shell, uiToast, parseJsonLoose, REMOTE, isOpenWrt } from './core.js';

let busyFlag = false;
function busy(v, msg) {
  busyFlag = v;
  document.querySelectorAll('[data-busy]').forEach(b => {
    b.disabled = v;
    if (v && msg && b.dataset.busytemp) b.textContent = msg;
  });
}

// ---------- 镜像配置 ----------
const MIRRORS = [
  ['direct',  '直连 GitHub',  '不经过镜像，直连 github.com（默认）'],
  ['auto',    '自动优选',     'v6.gh-proxy.org 优先，失败自动切换其他镜像'],
  ['v6proxy', 'v6.gh-proxy.org', 'https://v6.gh-proxy.org/'],
  ['ghfast',  'ghfast.top',   'https://ghfast.top/'],
  ['ghcom',   'gh-proxy.com', 'https://gh-proxy.com/'],
  ['ghproxy', 'ghproxy.net',  'https://ghproxy.net/'],
  ['moeyy',   'moeyy',        'https://github.moeyy.xyz/'],
  ['custom',  '自定义镜像',   '自定义加速前缀，如 https://gh.xxxx.com/'],
];

// 镜像选择会话级缓存：重进内核页直接渲染，避免「加载中…」占位引起的跳动
let mirrorCache = null; // { key, custom }

// ---------- 本地导入：目录清单会话级缓存（stale-while-revalidate） ----------
// exec 桥每执行一条命令都要 fork 一整串进程（POST → busybox httpd → base64 解码 → sh → ls → 回包），
// 慢设备 / 高负载下单次往返能到 1~2s。旧逻辑是「点开弹窗才发第一条 ls」：用户先看到弹层停在
// 「加载中…」卡住一两秒，列表回来后才渲染；而弹层高度由内容撑开（空列表时列表区高 0），
// 渲染瞬间弹层从小状态直接长到满高 —— 观感就是「卡一下然后完全展开」。
// 现在三管齐下：① 内核页渲染时后台预取默认目录，点开弹窗首帧直接命中缓存、零等待；
// ② 切换目录有缓存就立刻渲染，过期后后台静默复核、列表真有变化才换（TTL 内不复核）；
// ③ 列表区预留固定高度，加载 / 渲染全程弹层尺寸不变。
const dirListCache = new Map(); // path -> { lines: string[], ts: number }
const DIR_LIST_TTL = 5000;      // TTL 内视为新鲜：快捷入口来回切换不产生多余 exec
let dirPrefetchStarted = false;

function parseLsOut(r) {
  return ((r && r.stdout) || '').split('\n').map(s => s.trim()).filter(Boolean)
    .filter(l => !l.startsWith('ls:'));
}
async function fetchDirListing(path) {
  const r = await shell(`ls -1Ap -- ${shq(path)} 2>&1`);
  const out = (r && r.stdout) || '';
  return { r, lines: parseLsOut(r), raw: out + (r && r.stderr ? '\n' + r.stderr : '') };
}

const CHEV_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

function mirrorCard() {
  const c = card();
  c.append(h('div', { class: 'card-head' }, h('h3', { text: '下载加速镜像' }), badge('内核下载用', 'b')));

  // 会话级缓存：重进内核页直接渲染，避免「加载中…」占位引起的跳动
  let currentKey = (mirrorCache && mirrorCache.key) || 'direct';
  let currentCustom = (mirrorCache && mirrorCache.custom) || '';

  const nameOf = k => { const m = MIRRORS.find(x => x[0] === k); return m ? m[1] : '直连 GitHub'; };
  const subOf = k => {
    const m = MIRRORS.find(x => x[0] === k);
    if (!m) return '';
    if (k === 'custom') return currentCustom ? `自定义前缀：${currentCustom}` : '未填写，等同直连 GitHub';
    return m[2];
  };

  const titleEl = h('div', { class: 'li-title' });
  const subEl = h('div', { class: 'li-sub' });
  const syncRow = () => { titleEl.textContent = nameOf(currentKey); subEl.textContent = subOf(currentKey); };

  // 只显示当前选择，点击后弹窗挑选（不再把所有镜像平铺在页面上）
  const row = h('div', { class: 'opt', style: 'cursor:pointer' },
    h('div', { class: 'li-main' }, titleEl, subEl),
    h('span', { style: 'width:14px;height:14px;color:var(--text-3);flex:none;display:inline-flex', html: CHEV_SVG }));
  const rowWrap = h('div', { class: 'optlist' }, row);
  row.onclick = openMirrorPicker;
  c.append(rowWrap);
  syncRow();

  function openMirrorPicker() {
    const close = openSheet('', h('div', { class: 'empty', text: '加载中…' }));
    let picked = currentKey;
    const customInput = h('input', {
      type: 'text', placeholder: 'https://gh.xxxx.com/（以 / 结尾）',
      value: currentCustom, style: 'width:100%',
    });
    const customWrap = h('div', { style: 'margin-top:10px' },
      h('div', { class: 'f-desc', style: 'margin-bottom:6px', text: '自定义加速前缀，留空则等同直连 GitHub' }),
      customInput);
    const listBox = h('div', { class: 'optlist' });

    function renderList() {
      listBox.innerHTML = '';
      MIRRORS.forEach(([key, name, sub]) => {
        const r = h('div', { class: `opt ${key === picked ? 'on' : ''}` },
          h('span', { class: 'radio' }),
          h('div', { class: 'li-main' },
            h('div', { class: 'li-title', text: name }),
            h('div', { class: 'li-sub', text: sub })));
        r.onclick = () => { picked = key; customWrap.style.display = key === 'custom' ? '' : 'none'; renderList(); };
        listBox.append(r);
      });
    }
    renderList();
    customWrap.style.display = picked === 'custom' ? '' : 'none';

    document.getElementById('sheetContent').replaceChildren(
      h('h3', { text: '下载加速镜像' }),
      h('div', { class: 'f-desc', style: 'margin-bottom:10px', text: '加速 GitHub 内核下载；仅对 GitHub 域名资源生效。选定项优先，失败后自动回退直连与其余镜像，单个镜像不通不会拖垮整次下载' }),
      listBox,
      customWrap);
    // 取消 / 确定放固定底栏（镜像列表较长，滚动时保持可见）
    setSheetFooter(
      h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
      h('button', { class: 'btn block pri', text: '确定', onclick: async () => {
        const v = (customInput.value || '').trim();
        await cmdline(`set mirror ${picked}`);
        if (picked === 'custom') await cmdline(`set mirror_custom ${v}`);
        currentKey = picked;
        if (picked === 'custom') currentCustom = v;
        mirrorCache = { key: currentKey, custom: currentCustom };
        syncRow();
        close();
        uiToast('已选择：' + nameOf(picked));
      } }));
  }

  // 后台对齐设备上的真实值（首帧已用缓存画好，不会闪跳）
  (async () => {
    const r = await cmdline('get mirror direct');
    const key = (r.stdout || '').trim() || 'direct';
    const cr = await cmdline('get mirror_custom ""');
    const curCustom = (cr.stdout || '').trim().replace(/^"|"$/g, '');
    mirrorCache = { key, custom: curCustom };
    if (key !== currentKey || curCustom !== currentCustom) {
      currentKey = key; currentCustom = curCustom; syncRow();
    }
  })();

  return c;
}

// ---------- 下载进度 ----------
function fmtMB(b) {
  b = Number(b) || 0;
  if (b > 1048576 * 1024) return (b / 1073741824).toFixed(2) + ' GB';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

async function runTask(cmd, sheetOpts) {
  // 关键：先挂进度弹窗（首帧「正在启动下载…」），再发命令——点击瞬间即有反馈；
  // 后端现在立即返回 started/ALREADY_RUNNING，弹窗拿到结果前先按“启动中”轮询，
  // 不再提前读旧下载状态。
  const sheet = progressSheet(sheetOpts);
  const r = await cmdline(cmd);
  const out = (r.stdout || '') + (r.stderr || '');
  if (out.includes('ALREADY_RUNNING')) { uiToast('下载已在进行中'); sheet.attachStatus(); return; }
  if (out.includes('started')) { sheet.attachStatus(); return; }
  // 命令未能启动下载 → 关掉进度弹窗，展示错误
  sheet.close();
  const box = h('pre', { class: 'logbox', text: out || '启动下载失败' });
  openSheet('下载失败', box, h('button', { class: 'btn block pri', text: '关闭', style: 'margin-top:12px', onclick: () => closeSheet() }));
}

// 内核下载入口（默认弹窗配置即内核版）
function runDownload(args) { return runTask(`download-core ${args}`, { waitStarted: true }); }

// Geo 数据下载入口
function runGeoDownload() {
  return runTask('download-geo', {
    title: 'Geo 数据下载',
    statusCmd: 'download-geo-status',
    cancelCmd: 'download-geo-cancel',
    cancelText: '取消下载',
    infoLabel: '文件：',
    doneToast: '✅ Geo 数据更新完成',
    uptodateToast: '✅ Geo 数据已是最新，无需更新',
    refresh: false,
    waitStarted: true,
    stages: {
      downloading: '正在下载 Geo 数据…',
      done: '✅ Geo 数据更新完成',
      uptodate: '✅ Geo 数据已是最新，无需下载',
    },
  });
}

// ---------- 路由器平台的内核卡片 ----------
// 路由器上只有上游 mihomo 一个内核：不提供分支内核选择，也不走 Android 的下载器
// （那是按 android-<abi> 资产名抓 GitHub 的），改用 box.sh 的 update-core：
// 按本机 CPU 架构（uname -m）选 mihomo-linux-<arch> 资产。
function routerCoreCard() {
  const st = state.status || {};
  const c = card();
  c.append(h('div', { class: 'card-head' }, h('h3', { text: '上游 mihomo 内核' }), badge('OpenWrt', 'b')));

  const infoBox = h('div', { style: 'font-size:13px;color:var(--text-2);line-height:1.7;font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-all' });
  const setLines = (txt) => { infoBox.textContent = (txt || '').trim() || '(无输出)'; };

  const refreshBtn = h('button', { class: 'btn sm', text: '刷新信息', dataset: { busy: '1', busytemp: '读取中…' }, onclick: async () => {
    const r = await cmdline('core-info');
    setLines((r.stdout || '') + (r.stderr || ''));
  } });

  const updateBtn = h('button', { class: 'btn sm ok', text: '更新到最新版', dataset: { busy: '1', busytemp: '更新中…' }, onclick: () => {
    const box = h('pre', { class: 'logbox', style: 'max-height:220px', text: '正在按本机架构下载最新正式版内核…\n（替换前会先停内核，视网速可能十几秒）' });
    const close = openSheet('更新内核',
      h('div', { class: 'f-desc', style: 'margin-bottom:10px', text: '按 CPU 架构从 MetaCubeX/mihomo 官方 release 下载最新正式版；下载与校验通过后替换，失败不会动现有内核。' }),
      box,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
        h('button', { class: 'btn block', text: '关闭', onclick: () => close() })));
    cmdline('update-core').then(async r => {
      box.textContent = ((r.stdout || '') + (r.stderr || '')).trim() || '(无输出)';
      uiToast(r.errno === 0 ? '✅ 内核更新完成' : '❌ 更新失败：看弹窗输出', 3600);
      try { if (window.refreshStatus) await window.refreshStatus(); } catch (e) { /* 刷新失败不影响 */ }
      const ir = await cmdline('core-info');
      setLines((ir.stdout || '') + (ir.stderr || ''));
    });
  } });

  // 本地导入：复用内核页的目录选择器（走 ls，与 Android 同一套实现）
  const importBtn = h('button', { class: 'btn sm', text: '本地导入', dataset: { busy: '1' }, onclick: () => openKernelPicker('official') });

  c.append(
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' }, updateBtn, refreshBtn, importBtn),
    infoBox,
    h('div', { class: 'f-desc', style: 'margin-top:10px', text: '路由器平台只有一个上游内核；分支内核（Smart 策略组 / eBPF 入站）不对 x86/arm 路由器发布，故不提供。' }));

  // 首次渲染先拉一次信息（命令很轻：读版本缓存 + uname）
  cmdline('core-info').then(r => setLines((r.stdout || '') + (r.stderr || ''))).catch(() => setLines(''));
  // 状态里带了版本，先画出来避免空窗
  if (st.official_ver) setLines(`版本       ${st.official_ver}`);
  return c;
}

function progressSheet(opts) {
  const o = Object.assign({
    title: '内核下载',
    statusCmd: 'download-status',
    cancelCmd: 'download-cancel',
    infoLabel: '镜像：',
    doneToast: '✅ 内核安装完成',
    refresh: true,
    waitStarted: false,
    stages: {},
  }, opts);
  const stageText = Object.assign({
    downloading: '正在下载内核…',
    unpacking: '解压与安装…',
    done: '✅ 下载完成，内核已安装',
    uptodate: '✅ 内核已是最新版，无需下载',
    error: '❌ 下载失败',
    cancelled: '⏹ 已取消',
    idle: '空闲',
  }, o.stages);
  const stageEl = h('div', { style: 'font-size:15px;font-weight:700;margin-bottom:4px', text: '准备中…' });
  const subEl = h('div', { style: 'font-size:12.5px;color:var(--text-3);margin-bottom:14px', text: '' });
  const bar = h('div', { class: 'progress-line' }, h('i', { style: 'width:0%' }));
  const bytesEl = h('div', { style: 'display:flex;justify-content:space-between;margin-top:8px;font-size:12.5px;color:var(--text-2);font-family:ui-monospace,monospace' },
    h('span', { class: 'loaded', text: '0 KB' }), h('span', { class: 'pct', text: '0%' }));
  const infoEl = h('div', { style: 'margin-top:6px;font-size:12.5px;color:var(--text-3)', html: o.infoLabel + '—' });
  const logEl = h('pre', { class: 'logbox', style: 'max-height:120px;margin-top:10px;display:none' });
  const cancelBtn = h('button', { class: 'btn block danger', text: '取消下载', style: 'margin-top:14px', onclick: async () => {
    clearInterval(timer);
    cancelBtn.disabled = true;
    await cmdline(o.cancelCmd);
    if (!closeSheetFn.isCurrent()) return;
    uiToast('已取消下载');
    clearInterval(timer);
    closeSheet();
  } });
  // 必须「先取状态、再重绘」：refreshStatus 是异步的，不 await 就先重绘等于
  // 用旧状态又画一遍（下载完还显示未安装）。
  const closeBtn = h('button', { class: 'btn block pri', text: '关闭', style: 'margin-top:14px;display:none', onclick: async () => {
    clearInterval(timer);
    closeSheet();
    if (!o.refresh) return;
    if (window.refreshStatus) await window.refreshStatus();
    if (window.rerenderCurrent) window.rerenderCurrent();
  } });
  const closeSheetFn = openSheet(o.title, stageEl, subEl, bar, bytesEl, infoEl, logEl, cancelBtn, closeBtn);

  // 自动轮询进度：每 800ms 取一次状态，直到终态自动停。
  // waitStarted（内核/Geo 下载）＝轮询要等 runTask 收到后端的 started 回执才开始：
  // 后端启动下载有一小段固定开销，之前弹窗一开就轮询，正好读到上一次下载残留的
  // done/cancelled/error —— 界面「已取消 / 已完成 / 失败」乱闪，而真实任务还在后台跑。
  // attachStatus() 由 runTask 在 started / ALREADY_RUNNING 时调用。
  let started = !o.waitStarted;
  let startedAt = started ? Date.now() : 0;
  let polling = false;
  let sawRunning = false;   // 本弹窗是否已见过本次任务真的在跑（downloading/unpacking）
  const timer = setInterval(async () => {
    if (!closeSheetFn.isCurrent()) { clearInterval(timer); return; }
    if (!started || polling) return;
    polling = true;
    try {
    const r = await cmdline(o.statusCmd);
    if (!closeSheetFn.isCurrent()) { clearInterval(timer); return; }
    const j = parseJsonLoose(r && r.stdout);
    if (!j) return;
    const stage = j.stage || 'idle';
    // 终态防误报：启动后的宽限期（3.5s）内，没见到 downloading/unpacking 之前，
    // 遇到 done/uptodate/error/cancelled 一律当「还没启动完」处理——这是上一次
    // 下载残留终态 / 启动窗口竞态的兜底。过宽限期后照常显示，绝不把真实失败藏住。
    if (stage === 'downloading' || stage === 'unpacking') sawRunning = true;
    const residual = stage === 'done' || stage === 'uptodate' || stage === 'error' || stage === 'cancelled';
    if (residual && !sawRunning && Date.now() - startedAt < 3500) {
      stageEl.textContent = '正在启动下载…';
      return;
    }
    // idle 只出现在「状态文件刚被删、新任务还没写首帧」的毫秒级窗口，或任务从未真正
    // 拉起；没见到 running 证据前一律当启动中，别把「空闲」闪给用户。
    if (stage === 'idle' && !sawRunning) {
      stageEl.textContent = '正在启动下载…';
      return;
    }
    stageEl.textContent = stageText[stage] || stage;
    bytesEl.querySelector('.loaded').textContent = fmtMB(j.loaded) + (j.total ? ' / ' + fmtMB(j.total) : '');
    // Geo：total 未知但 percent 按文件数折算已知 → 显示确定进度；内核未知大小时 percent 为 0 → 不定条
    const unknownTotal = !j.total && stage === 'downloading' && !(j.percent > 0);
    bytesEl.querySelector('.pct').textContent = unknownTotal ? '···' : (j.percent || 0) + '%';
    bar.classList.toggle('indeterminate', unknownTotal);
    if (!unknownTotal && bar.firstElementChild) bar.firstElementChild.style.width = (j.percent || 0) + '%';
    // 镜像行：同时带上当前候选与百分比，避免旧逻辑只画名字、跨镜像回退时
    // 百分比归零但名字不变，看起来像「没用我选的镜像下载」。
    if (j.mirror && !residual) infoEl.replaceChildren(document.createTextNode(o.infoLabel), h('b', { text: String(j.mirror) }));
    if (j.err) {
      logEl.style.display = '';
      logEl.textContent = j.err;
    }
    if (stage === 'done') {
      bar.classList.remove('indeterminate');
      subEl.textContent = j.loaded ? '共 ' + fmtMB(j.loaded) : '';
      cancelBtn.style.display = 'none';
      closeBtn.style.display = '';
      clearInterval(timer);
      if (o.refresh) {
        if (window.refreshStatus) await window.refreshStatus();
        if (!closeSheetFn.isCurrent()) return;
        if (window.rerenderCurrent) window.rerenderCurrent();
      }
      uiToast(o.doneToast);
    } else if (stage === 'uptodate') {
      bar.classList.remove('indeterminate');
      cancelBtn.style.display = 'none';
      closeBtn.style.display = '';
      clearInterval(timer);
      uiToast(o.uptodateToast || '✅ 内核版本已是最新');
    } else if (stage === 'error' || stage === 'cancelled') {
      bar.classList.remove('indeterminate');
      cancelBtn.style.display = 'none';
      closeBtn.style.display = '';
      clearInterval(timer);
    } else if (stage === 'downloading') {
      subEl.textContent = '保持网络畅通…';
    }
    } catch (e) {
      console.warn('进度轮询失败', e);
    } finally { polling = false; }
  }, 800);
  return {
    close: () => { clearInterval(timer); closeSheetFn(); },
    // runTask 拿到 started / ALREADY_RUNNING 回执后接入轮询：置位后主循环
    // 下一拍（≤800ms）即开始取状态；期间新任务的首个 downloading 帧会置 sawRunning。
    attachStatus: () => {
      if (started) return;
      started = true;
      startedAt = Date.now();
      stageEl.textContent = '正在启动下载…';
    },
  };
}

export function renderCore(el) {
  el.innerHTML = '';
  const st = state.status || {};
  const cur = st.core || 'liuran001';

  if (isOpenWrt()) {
    // 路由器平台：单内核 + 简单更新流程（见 routerCoreCard）
    el.append(note('路由器平台使用 <b>MetaCubeX/mihomo 官方内核</b>，按本机 CPU 架构自动选择。更新内核用下面的按钮，或命令行 <code>mihomo-box update-core</code>。'));
    el.append(groupTitle('内核'));
    el.append(routerCoreCard());
  } else {
  // 当前内核调用提示
  el.append(note('内核三选一：<b>liuran001/mihomo</b>（Smart 策略组 + eBPF 入站）、<b>jieluojun/mihomo</b>（liuran001 分支 + 钉钉直连参数支持）或 <b>MetaCubeX/mihomo 官方</b>。切换内核会自动重启运行中的服务。下载需要网络。'));

  // ---------- 下载加速镜像 ----------
  el.append(groupTitle('下载加速'));
  el.append(mirrorCard());

  const coreChoices = [{
    // jieluojun/mihomo：fork 自 liuran001/mihomo，加入钉钉直连参数支持（上游称 With-At 补丁），
    // 自动同步上游 Alpha 后构建，滚动发布在 with-at-latest（资产名含 commit 号，只有 android-arm64-v8 / linux-arm64 两种）
    key: 'jieluojun',
    name: 'jieluojun/mihomo 分支内核',
    desc: '在 liuran001/mihomo 分支基础上加入钉钉直连参数支持(写法与神秘模块一致)，持续合并上游',
    features: [['Smart 策略组', 'p'], ['eBPF 入站', 'p'], ['钉钉直连', 'o']],
    exists: st.jieluojun_exists, ver: st.jieluojun_ver,
    current: cur === 'jieluojun',
    downloads: [['下载 / 更新最新版', 'jieluojun'], ['自定义链接…', 'custom-jieluojun']],
  }, {
    key: 'liuran001',
    name: 'liuran001/mihomo 分支内核',
    desc: '在官方基础上加入 Smart 策略组（智能权重）与 eBPF 透明代理入站，持续合并上游。',
    features: [['Smart 策略组', 'p'], ['eBPF 入站', 'p']],
    exists: st.liuran001_exists, ver: st.liuran001_ver,
    current: cur === 'liuran001',
    downloads: [['下载 / 更新最新版', 'liuran001'], ['自定义链接…', 'custom-liuran001']],
  }, {
    key: 'official',
    name: 'MetaCubeX 官方内核',
    desc: 'mihomo 官方发布，稳定可靠。不支持 Smart 策略组与 eBPF 入站。',
    features: [['官方维护', 'b']],
    exists: st.official_exists, ver: st.official_ver,
    current: cur === 'official',
    downloads: [['下载 / 更新最新版', 'official'], ['自定义链接…', 'custom-official']],
  }];
  el.append(coreCard(coreChoices.find(o => o.key === cur) || coreChoices[0]));
  }   // end !isOpenWrt

  // 后台预取「本地导入」选择器的默认目录（见文件头 dirListCache 注释）：
  // 用户从打开内核页到真正点「本地导入」通常要一两秒以上，等点的时候首帧直接命中缓存。
  const PICK_DEFAULT = isOpenWrt() ? '/tmp' : '/sdcard/Download';
  if (REMOTE && !dirPrefetchStarted) {
    dirPrefetchStarted = true;
    fetchDirListing(PICK_DEFAULT).then(({ r, lines }) => {
      if (r && r.errno === 0) dirListCache.set(PICK_DEFAULT, { lines, ts: Date.now() });
    }).catch(() => {});
  }

  async function openKernelPicker(which) {
    if (busyFlag) return;
    let selected = false, loadRev = 0;
    let cur = PICK_DEFAULT;
    const pathEl = h('div', { style: 'font-family:ui-monospace,monospace;font-size:13px;color:var(--text-2);word-break:break-all;margin-bottom:8px' });
    const shortRow = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px' });
    // 列表区预留固定高度（不认 dvh 的旧 WebView 回退 vh）：弹层高度由内容撑开，
    // 预留后「加载中」与「列表已渲染」两帧尺寸一致，消除渲染瞬间弹层从小状态
    // 直接长到满高的「完全展开」跳变。
    const listEl = h('div', { style: 'height:46vh;overflow:auto;border:1px solid var(--border);border-radius:10px;background:var(--card)' });
    listEl.style.height = '46dvh';
    const statusEl = h('div', { style: 'font-size:12px;color:var(--text-3);margin-top:8px;text-align:center;min-height:16px' });
    const box = h('div', {}, pathEl, shortRow, listEl, statusEl);
    const shortcuts = isOpenWrt()
      ? [['/tmp','/tmp'],['/etc/mihomo_box','安装目录'],['/root','/root'],['/mnt','/mnt'],['/','/']]
      : [['/sdcard/Download','Download'],['/sdcard','sdcard'],['/data/local/tmp','tmp'],['/data/adb/mihomo_box','工作目录'],['/','/']];
    shortcuts.forEach(([p,label]) => {
      const b = h('button', { class: 'btn sm', text: label, style: 'padding:6px 10px' });
      b.onclick = () => { cur = p; load(); };
      shortRow.append(b);
    });
    let close = null;
    const cancelBtn = h('button', { class: 'btn block', text: '取消', onclick: () => close && close() });
    box.prepend(note('支持二进制、.gz、.zip、.tar.gz。点击文件后直接导入本卡片；归档内须有唯一 ELF 二进制。文件及单个解压结果不超过 128 MiB，最多 128 个归档条目。'));
    close = openSheet('本地导入 · ' + ({ official: '官方内核', liuran001: 'liuran001 分支内核', jieluojun: 'jieluojun 分支内核' }[which] || '分支内核'), box);
    setSheetFooter(cancelBtn);

    async function selectFile(path) {
      if (selected || busyFlag || !close?.isCurrent()) return;
      selected = true;
      close();
      await runLong(`import-core ${shq(path)} ${which}`);
      if (el.isConnected) await refresh();
    }
    // 把一份目录清单渲染进列表区
    function renderListing(lines) {
      listEl.innerHTML = '';
      listEl.scrollTop = 0;
      const dirs = [];
      const files = [];
      for (const name of lines) {
        if (name.endsWith('/')) dirs.push(name.slice(0,-1));
        else files.push(name);
      }
      dirs.sort((a,b) => a.localeCompare(b));
      files.sort((a,b) => a.localeCompare(b));
      if (cur !== '/') {
        const row = h('div', { class: 'opt', style: 'cursor:pointer' },
          h('div', { class: 'li-main' }, h('div', { class: 'li-title', text: '⬆️ 上一级' }), h('div', { class: 'li-sub', text: parentOf(cur) })));
        row.onclick = () => { cur = parentOf(cur); load(); };
        listEl.append(row);
      }
      for (const d of dirs) {
        const full = joinPath(cur, d);
        const row = h('div', { class: 'opt', style: 'cursor:pointer' },
          h('span', { class: 'radio' }),
          h('div', { class: 'li-main' }, h('div', { class: 'li-title', text: '📁 ' + d }), h('div', { class: 'li-sub', text: full })));
        row.onclick = () => { cur = full; load(); };
        listEl.append(row);
      }
      for (const f of files) {
        const full = joinPath(cur, f);
        const isGz = /\.(gz|tgz|zip|tar)$/i.test(f);
        const isMihomo = /mihomo/i.test(f);
        const row = h('div', { class: 'opt', style: 'cursor:pointer' },
          h('span', { class: 'radio' }),
          h('div', { class: 'li-main' }, h('div', { class: 'li-title', text: (isGz ? '📦 ' : isMihomo ? '⚙️ ' : '📄 ') + f }), h('div', { class: 'li-sub', text: full })));
        row.onclick = () => selectFile(full);
        listEl.append(row);
      }
      statusEl.textContent = `${dirs.length} 个文件夹 · ${files.length} 个文件 · 点击文件选择，点击文件夹进入`;
    }
    // 目录为空或读不到（不存在 / 无权限）：在预留的列表区内如实呈现，弹层尺寸不变
    function renderEmpty(errText) {
      listEl.innerHTML = '';
      listEl.append(errText
        ? h('div', { style: 'padding:16px 14px;font-size:13px;line-height:1.6;color:var(--text-3);word-break:break-all', text: errText })
        : h('div', { class: 'empty', text: '空目录' }));
      if (cur !== '/') {
        const row = h('div', { class: 'opt', style: 'cursor:pointer' },
          h('div', { class: 'li-main' }, h('div', { class: 'li-title', text: '⬆️ 上一级' }), h('div', { class: 'li-sub', text: parentOf(cur) })));
        row.onclick = () => { cur = parentOf(cur); load(); };
        listEl.append(row);
      }
      statusEl.textContent = '';
    }
    async function load() {
      const rev = ++loadRev;
      pathEl.textContent = '📁 ' + cur;
      const hit = dirListCache.get(cur);
      if (hit) {
        // 缓存命中（页面预取 / 上次浏览留下）：首帧直接渲染，不等 exec 桥往返
        if (hit.lines.length) renderListing(hit.lines);
        else renderEmpty();
        // 超过 TTL 就后台静默复核：列表真有变化（如刚下载了新文件）才换
        if (Date.now() - hit.ts < DIR_LIST_TTL) return;
        const prevKey = hit.lines.join('\n');
        fetchDirListing(cur).then(({ r, lines }) => {
          if (rev !== loadRev || !close?.isCurrent()) return; // 已换目录 / 已关弹窗：丢弃迟到回包
          if (!r || r.errno !== 0) return;                   // 复核失败：保留旧列表（stale 比空白好）
          dirListCache.set(cur, { lines, ts: Date.now() });
          if (lines.join('\n') !== prevKey) {
            if (lines.length) renderListing(lines);
            else renderEmpty();
          }
        }).catch(() => {});
        return;
      }
      // 无缓存（首次进入该目录）：占位放进预留的列表区 —— 弹层不会因此变形，
      // 等待读起来是「列表区在加载」而不是「弹窗卡住」
      listEl.innerHTML = '';
      listEl.append(h('div', { class: 'empty', style: 'height:100%;display:flex;align-items:center;justify-content:center', text: '加载中…' }));
      statusEl.textContent = '';
      const { r, lines, raw } = await fetchDirListing(cur);
      if (rev !== loadRev || !close?.isCurrent()) return;
      // 也要处理错误时 r.stdout 为空但 raw 含错误
      if (!lines.length) {
        const isErr = /No such file|Permission denied|cannot access/i.test(raw);
        if (!isErr) dirListCache.set(cur, { lines, ts: Date.now() }); // 空目录可缓存，下次进入不再等
        renderEmpty(isErr ? (raw.trim().split('\n')[0] || '无法读取目录') : null);
        return;
      }
      dirListCache.set(cur, { lines, ts: Date.now() });
      renderListing(lines);
    }
    function parentOf(p) {
      if (p === '/') return '/';
      const t = p.replace(/\/$/, '');
      const idx = t.lastIndexOf('/');
      if (idx <= 0) return '/';
      return t.slice(0, idx);
    }
    function joinPath(a,b) {
      if (a === '/') return '/' + b;
      return a.replace(/\/$/, '') + '/' + b;
    }
    load();
  }

  // ---------- Geo 数据 ----------
  el.append(groupTitle('Geo 数据'));
  const geo = card();
  const geoBtn = h('button', { class: 'btn pri sm', text: '下载 / 更新 Geo 数据', dataset: { busy: '1', busytemp: '下载中…' }, onclick: () => runGeoDownload() });
  geo.append(
    h('div', { class: 'f-label' }, '预下载 geoip / geosite / mmdb', h('div', { class: 'f-desc', text: '启动时不会自动下载，需要 Geo 时在此手动获取；文件保存在工作目录' })),
    h('div', { style: 'margin-top:10px' }, geoBtn));
  el.append(geo);

  // ---------- 自检 ----------
  el.append(groupTitle('环境'));
  const env = card();
  const envBox = h('pre', { class: 'logbox', text: '点击「环境自检」查看设备内核与 cgroup 支持情况（用于 eBPF 入站判断）…' });
  const envBtn = h('button', { class: 'btn sm', text: '环境自检', dataset: { busy: '1', busytemp: '检测中…' }, onclick: async () => {
    busy(true);
    const r = await cmdline('check-env');
    envBox.textContent = (r.stdout || '').trim() || (r.stderr || '无输出');
    busy(false);
  } });
  env.append(envBox, h('div', { style: 'height:10px' }), envBtn);
  el.append(env);

  async function refresh() { if (window.refreshStatus) await window.refreshStatus(); renderCore(el); }

  function coreCard(o) {
    const c = card();
    c.dataset.core = o.key;
    c.append(h('div', { class: 'card-head' }, h('h3', { text: '内核' }), badge('当前选择', 'g')));
    const selector = h('button', { type: 'button', class: 'opt', dataset: { coreSelect: '1', busy: '1' },
      disabled: busyFlag, 'aria-haspopup': 'dialog', style: 'width:100%;text-align:left;color:inherit;background:transparent;border:0;font:inherit;cursor:pointer',
      onclick: openCoreSelector },
      h('div', { class: 'li-main' }, h('div', { class: 'li-title', text: o.name }), h('div', { class: 'li-sub', text: '点击选择分支内核或官方内核' })),
      h('span', { style: 'width:14px;height:14px;color:var(--text-3);flex:none;display:inline-flex', html: CHEV_SVG }));
    c.append(h('div', { class: 'optlist' }, selector));
    c.append(h('div', { style: 'display:flex;gap:6px;margin-top:10px;flex-wrap:wrap' }, o.features.map(([t, cls]) => badge(t, cls))));
    c.append(h('div', { style: 'font-size:13px;color:var(--text-2);margin:10px 0 4px;line-height:1.6', html: o.desc }));
    c.append(h('div', { class: 'kv' }, h('span', { class: 'k', text: '状态' }), h('span', { class: 'v', text: o.exists ? '✅ 已安装' : '未安装' })));
    if (o.ver) c.append(h('div', { class: 'kv' }, h('span', { class: 'k', text: '版本' }), h('span', { class: 'v', text: o.ver })));

    const btnRow = h('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' });
    o.downloads.forEach(([label, src]) => {
      if (src.startsWith('custom')) {
        const which = src.slice('custom-'.length);   // custom-liuran001 / custom-jieluojun / custom-official
        const localRow = h('div', { class: 'core-import-actions', style: 'display:flex;gap:8px;flex-wrap:nowrap;max-width:100%' },
          h('button', { class: 'btn sm', text: label, onclick: () => customDownload(which) }),
          h('button', { class: 'btn sm', text: '本地导入', disabled: busyFlag, dataset: { busy: '1', localImport: which }, onclick: () => openKernelPicker(which) }));
        btnRow.append(localRow);
      } else {
        btnRow.append(h('button', { class: 'btn sm ok', text: label, dataset: { busy: '1' }, onclick: () => runDownload(src) }));
      }
    });
    c.append(btnRow);
    return c;
  }

  function officialWarning(key) {
    if (key !== 'official') return '';
    const problems = [];
    if ((state.cfg['proxy-groups'] || []).some(g => g?.type === 'smart')) problems.push('配置含 Smart 策略组，官方内核不支持');
    if ((state.cfg.listeners || []).some(l => l?.type === 'ebpf')) problems.push('配置启用了 eBPF 入站，官方内核不支持');
    return problems.join('；');
  }

  function showCoreInstall(o) {
    const close = openSheet('安装 · ' + o.name,
      note('此内核尚未安装。请先下载或本地导入，完成后再选择切换；当前内核保持不变。'),
      h('div', { class: 'btn-grid keep2' },
        h('button', { class: 'btn pri', text: '下载 / 更新最新版', onclick: () => { close(); runDownload(o.key); } }),
        h('button', { class: 'btn', text: '自定义链接…', onclick: () => { close(); customDownload(o.key); } }),
        h('button', { class: 'btn', text: '本地导入', dataset: { localImport: o.key }, onclick: () => { close(); openKernelPicker(o.key); } })));
    setSheetFooter(h('button', { class: 'btn', text: '取消', onclick: close }));
  }

  function openCoreSelector() {
    if (busyFlag) return;
    let picked = cur, submitting = false;
    const list = h('div', { class: 'optlist' });
    const hint = h('div', { class: 'note', style: 'margin:12px 0 0;white-space:pre-wrap', role: 'status' });
    const apply = h('button', { class: 'btn pri', text: '确定' });
    const close = openSheet('选择内核', list, hint);
    const renderOptions = () => {
      list.replaceChildren();
      coreChoices.forEach(o => {
        const row = h('button', { type: 'button', class: `opt ${o.key === picked ? 'on' : ''}`, dataset: { coreChoice: o.key },
          style: 'width:100%;text-align:left;color:inherit;background:transparent;border:0;font:inherit', 'aria-pressed': String(o.key === picked),
          disabled: submitting, onclick: () => { if (submitting) return; picked = o.key; renderOptions(); } },
          h('span', { class: 'radio' }), h('div', { class: 'li-main' },
            h('div', { class: 'li-title', text: o.name }),
            h('div', { class: 'li-sub', text: `${o.key === cur ? '当前选择 · ' : ''}${o.exists ? '已安装' : '未安装'}${o.ver ? ' · ' + o.ver : ''}` })));
        list.append(row);
      });
      const o = coreChoices.find(x => x.key === picked);
      apply.textContent = !o.exists ? '下载安装' : picked === cur ? '确定' : '确认切换';
      hint.textContent = !o.exists ? '此内核尚未安装，请先下载或本地导入。' : picked === cur ? '当前已选择此内核，不会重复重启。' :
        ((state.status || {}).running ? '确认后切换实际使用的内核，并重启运行中的服务。' : '确认后切换内核选择，不启动当前已停止的服务。');
      const warning = officialWarning(picked);
      if (warning) hint.textContent += '\n注意：' + warning + '。';
    };
    apply.onclick = async () => {
      if (submitting || busyFlag || !close.isCurrent()) return;
      const o = coreChoices.find(x => x.key === picked);
      if (picked === cur && o.exists) { close(); return; }
      if (!o.exists) { close(); showCoreInstall(o); return; }
      submitting = true;
      close();
      // The card is never updated optimistically: refresh from actual status on
      // both success and failure so a rejected switch cannot display a fake choice.
      await runLong(`setcore ${o.key}`);
      if (el.isConnected) await refresh();
    };
    renderOptions();
    setSheetFooter(h('button', { class: 'btn', text: '取消', onclick: close }), apply);
  }

  function customDownload(which) {
    const url = h('input', { type: 'text', placeholder: 'https://…/mihomo-android-arm64-v8-alpha-smart-xxx.gz', style: 'width:100%' });
    const close = openSheet('自定义链接下载', url,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
        h('button', { class: 'btn block', text: '取消', onclick: () => close() }),
        h('button', { class: 'btn block pri', text: '下载', onclick: async () => {
          const u = url.value.trim();
          if (!/^https?:\/\//.test(u)) { ntoast('请输入 http(s) 链接'); return; }
          close();
          runDownload(shq(u) + ' ' + which);
        } })));
  }
}

function shq(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }

// 执行长耗时命令并以弹窗展示输出
async function runLong(args) {
  busy(true);
  const out = openLogSheet('执行中…');
  try {
    const r = await cmdline(args);
    out((r.stdout || '(无输出)') + (r.stderr ? '\n' + r.stderr : ''), r.errno === 0);
  } catch (e) {
    out('执行失败: ' + e, false);
  }
  busy(false);
  if (window.refreshStatus) window.refreshStatus();
}

function openLogSheet(title) {
  const box = h('pre', { class: 'logbox', style: 'max-height:50dvh', text: title });
  const close = openSheet('执行结果', box,
    h('button', { class: 'btn block pri', text: '关闭', style: 'margin-top:12px', onclick: () => close() }));
  return (text) => { box.textContent = text; };
}
