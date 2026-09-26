import { h, state, note, openSheet, setSheetFooter, commitNewOutboundProxies, uiToast, uiLog } from './core.js';
import { parseProxyURIs } from './proxy-uri.js';

export function openProxyUriImport(onImported, reservedNames = []) {
  let busy = false;
  const input = h('textarea', {
    // spellcheck 必须是布尔 false：h() 按 DOM 属性赋值，字符串 'false' 会被转成 true，
    // 等于开着拼写检查——整框 URI 满是红色波浪线，点到文字还会弹系统的拼写建议浮窗。
    rows: 8, spellcheck: false, autocomplete: 'off', autocapitalize: 'off',
    'aria-label': '节点 URI，每行一个', placeholder: '每行一个节点 URI，可混合多种协议\nss://…\nvmess://…\nvless://…',
    style: 'min-height:150px;max-height:240px',
  });
  const summary = h('div', { class: 'note', role: 'status', 'aria-live': 'polite', hidden: true });
  const details = h('pre', { class: 'logbox', hidden: true, style: 'max-height:200px' });
  const parse = h('button', { class: 'btn pri', text: '解析并添加', style: 'flex:1', disabled: true });
  const sync = () => {
    parse.disabled = busy || !input.value.trim();
    parse.textContent = busy ? '解析中…' : '解析并添加';
    parse.setAttribute('aria-busy', String(busy));
    input.readOnly = busy;
  };
  input.addEventListener('input', sync);
  const body = h('div', { class: 'proxy-uri-import-body' },
    note('支持 SS、VMess、VLESS、Trojan、Hysteria2（hy2）、TUIC。每行一个，最多 500 个；同名自动加序号，批内完全相同的链接只添加一次。'),
    input, summary, details,
    note('只添加到当前配置草稿，不覆盖已有节点、不自动加入代理组。完成后请保存配置，再校验配置。'),
  );
  const close = openSheet('解析节点 URI', body);
  setSheetFooter(h('button', { class: 'btn', text: '关闭', style: 'flex:1', onclick: close }), parse);
  parse.onclick = async () => {
    if (busy || !input.value.trim()) return;
    busy = true;sync();summary.hidden = false;summary.textContent = '正在解析节点…';details.hidden = true;
    const value = input.value;
    try {
      // 本地解析不调用管理器桥；先让按钮反馈有机会绘制。
      await new Promise(resolve => setTimeout(resolve, 32));
      if (!close.isCurrent()) return;
      const proxies = Array.isArray(state.cfg.proxies) ? state.cfg.proxies : [];
      const groups = Array.isArray(state.cfg['proxy-groups']) ? state.cfg['proxy-groups'] : [];
      const names = [...reservedNames, ...proxies.map(p => p?.name), ...groups.map(g => g?.name)].filter(Boolean);
      const result = parseProxyURIs(value, names);
      if (result.proxies.length) {
        const applied = commitNewOutboundProxies(result.proxies);
        if (!applied) { summary.textContent = '添加未应用，请先处理配置错误后重试；输入已保留。';return; }
        // 成功项移出输入框，重试失败项时不会再次追加已经导入的节点。
        input.value = result.errors.map(e => e.input).join('\n');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        onImported?.();
      }
      summary.textContent = `已添加 ${result.proxies.length} 个，失败 ${result.errors.length} 个，跳过重复 ${result.skipped} 个。` + (result.proxies.length ? ' 请保存配置。' : ' 未修改配置。');
      if (result.errors.length) uiLog('warn', '节点 URI 解析失败条目', result.errors.map(item => `第 ${item.line} 行：${item.message}`).join('\n'));
      details.textContent = [
        ...result.added.map(item => `第 ${item.line} 行：已添加「${item.name}」${item.renamed ? '（重名已加序号）' : ''}${item.warnings.length ? '\n  注意：' + item.warnings.join('；') : ''}`),
        ...result.errors.map(item => `第 ${item.line} 行：${item.message}`),
      ].join('\n');
      details.hidden = !details.textContent;
      if (result.proxies.length) uiToast(`已添加 ${result.proxies.length} 个出站节点，请保存配置`);
    } catch (e) {
      summary.textContent = e?.message || '解析失败，请检查输入';
      uiLog('error', '节点 URI 解析失败', summary.textContent);
    } finally {
      busy = false;
      if (close.isCurrent()) sync();
    }
  };
}
