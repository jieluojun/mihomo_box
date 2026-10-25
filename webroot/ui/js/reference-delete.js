import { h, state, note, openChildSheet, setSheetFooter, confirmSheet, flushConfigSource, commitConfigEdit, uiToast, uiLog } from './core.js';
import { DELETE_LABELS, deletionState, removeUnreferenced } from './config-references.js';

function showBlocked(kind, name, result) {
  const locations = [...(result.references || []), ...(result.issues || [])];
  const reason = result.error || (result.references?.length ? `仍有 ${result.references.length} 处引用，请先解除引用。` : '无法安全确认引用，请先修正配置。');
  uiLog('warn', '已阻止删除', DELETE_LABELS[kind], name, reason, locations.join('\n'));
  const close = openChildSheet('无法删除' + (DELETE_LABELS[kind] || '条目'),
    h('div', { class: 'reference-delete-body' },
    h('div', { class: 'note', text: `「${name || '未命名'}」：${reason}` }),
    h('pre', { class: 'logbox', style: 'max-height:320px', text: locations.slice(0, 100).join('\n') + (locations.length > 100 ? `\n…另有 ${locations.length - 100} 处，请修正后重新检查` : '') }),
    note('只检查当前配置草稿。不自动删除关联规则、成员或集合；外部订阅文件的内部内容、源码直接编辑不在此删除保护范围内。')),
  );
  setSheetFooter(h('button', { class: 'btn pri block', text: '知道了', onclick: close }));
}
export function requestReferenceDelete(kind, name, refresh) {
  if (!flushConfigSource()) { uiToast('配置源码有错误，请先修正后再删除');return; }
  const initial = deletionState(state.cfg, kind, name);
  if (initial.error || initial.references.length || initial.issues.length) { showBlocked(kind, name, initial);return; }
  confirmSheet('删除' + DELETE_LABELS[kind], `当前草稿未发现「${name}」的引用，确定删除？确认时将再次检查。`, '删除', () => {
    let blocked;
    const applied = commitConfigEdit(cfg => {
      const result = removeUnreferenced(cfg, kind, name, initial.fingerprint);
      if (!result.removed) { blocked = result;return false; }
    });
    if (blocked) { showBlocked(kind, name, blocked);return; }
    if (applied) { refresh?.();uiToast(`已删除${DELETE_LABELS[kind]}「${name}」，请保存配置`); }
  }, '取消', true);
}
