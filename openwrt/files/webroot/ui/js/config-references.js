// References in the current editable Mihomo configuration only; no network/file reads.
const arrayKinds = new Set(['proxies', 'proxy-groups']);
export const DELETE_LABELS = { proxies: '出站代理', 'proxy-providers': '代理集合', 'proxy-groups': '代理组', 'rule-providers': '规则集合' };
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
const at = (path, key) => path + '[' + JSON.stringify(key) + ']';
function tokens(value) {
  const out = [];let start = 0, depth = 0, quote = '', escape = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escape) { escape = false;continue; }
    if (ch === '\\') { escape = true;continue; }
    if (quote) { if (ch === quote) quote = '';continue; }
    if (ch === '"' || ch === "'") { quote = ch;continue; }
    if (ch === '(') depth++;
    if (ch === ')') { depth--;if (depth < 0) throw new Error('规则括号不匹配'); }
    if (ch === ',' && depth === 0) { out.push(value.slice(start, i).trim());start = i + 1; }
  }
  if (depth || quote) throw new Error('规则括号或引号不匹配');
  out.push(value.slice(start).trim());return out;
}
// Logical arguments may be ((A),(B)), (A),(B), or adjacent (A)(B).
// Split balanced outer groups only; regex parentheses inside each condition stay intact.
function conditionGroups(value) {
  const groups = [];let start = -1, depth = 0, quote = '', escape = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (start < 0) {
      if (/\s|,/.test(ch)) continue;
      if (ch !== '(') throw new Error('逻辑条件缺少括号');
      start = i;depth = 1;continue;
    }
    if (escape) { escape = false;continue; }
    if (ch === '\\') { escape = true;continue; }
    if (quote) { if (ch === quote) quote = '';continue; }
    if (ch === '"' || ch === "'") { quote = ch;continue; }
    if (ch === '(') depth++;
    if (ch === ')' && --depth === 0) { groups.push(value.slice(start + 1, i).trim());start = -1; }
  }
  if (start >= 0 || !groups.length) throw new Error('逻辑条件括号不完整');
  return groups;
}
function atom(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}
export function findConfigReferences(cfg, kind, name) {
  cfg = cfg || {};
  const refs = new Set(), issues = new Set();
  const policy = kind === 'proxies' || kind === 'proxy-groups';
  const ruleSet = kind === 'rule-providers';
  const add = (value, path) => { if (typeof value === 'string' && value === name) refs.add(path); };
  function rule(raw, path, condition = false, depth = 0) {
    if (typeof raw !== 'string') { issues.add(path + '：规则不是文本');return; }
    if (depth > 64) { issues.add(path + '：规则嵌套过深');return; }
    let fields;
    try { fields = tokens(raw); } catch (_) { issues.add(path + '：规则格式复杂或不完整，无法安全检查');return; }
    const type = fields[0]?.toUpperCase();
    if (ruleSet && type === 'RULE-SET' && fields[1]) add(atom(fields[1]), path + ' → RULE-SET');
    if (policy && !condition && type !== 'SUB-RULE') {
      const tail = fields.slice();while (tail.length > 1 && /^(no-resolve|src)$/i.test(tail.at(-1))) tail.pop();
      if ((type === 'MATCH' && tail.length >= 2) || (type !== 'MATCH' && tail.length >= 3)) add(atom(tail.at(-1)), path + ' → 出口策略');
    }
    if (['AND', 'OR', 'NOT', 'SUB-RULE'].includes(type)) {
      const parts = fields.slice(1);
      if (!condition) {
        while (parts.length && /^(no-resolve|src)$/i.test(parts.at(-1))) parts.pop();
        parts.pop(); // outer policy, or SUB-RULE destination; not a match condition
      }
      if (!parts.length) { issues.add(path + '：逻辑条件缺失');return; }
      conditions(parts.join(','), path, depth + 1);
    }
  }
  function conditions(raw, path, depth) {
    if (depth > 64) { issues.add(path + '：规则嵌套过深');return; }
    let groups;
    try { groups = conditionGroups(raw); } catch (_) { issues.add(path + '：逻辑条件无法安全检查');return; }
    groups.forEach((inner, i) => {
      const location = path + ` → 逻辑条件[${i}]`;
      if (inner.startsWith('(')) conditions(inner, location, depth + 1);
      else rule(inner, location, true, depth + 1);
    });
  }

  if (policy || ruleSet) {
    if (cfg.rules != null && !Array.isArray(cfg.rules)) issues.add('rules：规则列表类型不正确');
    if (Array.isArray(cfg.rules)) cfg.rules.forEach((r, i) => rule(r, `rules[${i}]`));
    if (cfg['sub-rules'] && typeof cfg['sub-rules'] === 'object') {
      for (const [group, rules] of Object.entries(cfg['sub-rules'])) if (Array.isArray(rules)) rules.forEach((r, i) => rule(r, at('sub-rules', group) + `[${i}]`));
    }
  }
  // DNS fake-IP filters reference rule providers too, independently of routing rules.
  // Accept both list-style rule-set: names and structured rule-mode conditions.
  if (ruleSet && cfg.dns && typeof cfg.dns === 'object') {
    const filters = cfg.dns['fake-ip-filter'];
    if (filters != null && !Array.isArray(filters)) issues.add('dns.fake-ip-filter：过滤列表类型不正确');
    if (Array.isArray(filters)) filters.forEach((entry, i) => {
      const path = `dns.fake-ip-filter[${i}]`;
      if (typeof entry !== 'string') { issues.add(path + '：过滤条目不是文本');return; }
      const text = entry.trim();
      if (/^rule-set:/i.test(text)) {
        text.slice(text.indexOf(':') + 1).split(',').map(v => v.trim()).filter(Boolean)
          .forEach(provider => add(provider, path + ' → RULE-SET'));
      } else if (cfg.dns['fake-ip-filter-mode'] === 'rule' || /^(RULE-SET|AND|OR|NOT),/i.test(text)) {
        // ruleSet implies policy === false, so real-ip/fake-ip are never mistaken
        // for proxy/group references. The existing recursive grammar handles conditions.
        rule(text, path);
      }
    });
  }
  // Recursion-stack protection, not a global visited set: YAML aliases can have
  // references at several independent locations which must all be inspected.
  const stack = new WeakSet();
  function walk(value, path, depth = 0) {
    if (!value || typeof value !== 'object') return;
    if (stack.has(value) || depth > 100) { issues.add(path + '：循环引用或嵌套过深');return; }
    stack.add(value);
    for (const [key, child] of Object.entries(value)) {
      const p = at(path, key);
      if (policy && ['dialer-proxy', 'proxy'].includes(key)) add(child, p);
      if (ruleSet && ['route-address-set', 'route-exclude-address-set', 'bypass-rule-set'].includes(key)) {
        if (Array.isArray(child)) child.forEach((v, i) => add(v, p + `[${i}]`));else add(child, p);
      }
      if (ruleSet && ['nameserver-policy', 'proxy-server-nameserver-policy'].includes(key) && child && typeof child === 'object') {
        for (const domain of Object.keys(child)) if (domain.startsWith('rule-set:')) domain.slice(9).split(',').map(v => v.trim()).forEach(v => add(v, at(p, domain)));
      }
      if (policy && path.startsWith('config["dns"]') && typeof child === 'string') {
        const strings = Array.isArray(child) ? child : [child];
        strings.forEach((v, i) => {
          if (typeof v !== 'string' || !v.includes('#')) return;
          for (const part of v.slice(v.indexOf('#') + 1).split('&')) {
            let decoded;try { decoded = decodeURIComponent(part); } catch (_) { decoded = part; }
            if (decoded !== 'RULES') add(decoded, p + (Array.isArray(child) ? `[${i}]` : '') + ' → DNS 出口');
          }
        });
      }
      walk(child, p, depth + 1);
    }
    stack.delete(value);
  }
  // Exclude only the definition being removed: its outgoing/self references vanish
  // with it. All other definitions, even those sharing a YAML alias, remain checked.
  for (const [section, value] of Object.entries(cfg || {})) {
    if (section === 'rules' || section === 'sub-rules') continue;
    if (section === 'proxy-groups' && Array.isArray(value)) {
      value.forEach((g, i) => {
        if (kind === section && g?.name === name) return;
        const p = `proxy-groups[${i}] (${g?.name || '未命名'})`;
        if (policy && g?.proxies != null && !Array.isArray(g.proxies)) issues.add(p + '.proxies：成员列表类型不正确');
        if (kind === 'proxy-providers' && g?.use != null && !Array.isArray(g.use)) issues.add(p + '.use：集合引用列表类型不正确');
        if (policy && Array.isArray(g?.proxies)) g.proxies.forEach((v, n) => add(v, p + `.proxies[${n}]`));
        if (kind === 'proxy-providers' && Array.isArray(g?.use)) g.use.forEach((v, n) => add(v, p + `.use[${n}]`));
        walk(g, at('config', section) + `[${i}]`);
      });
    } else if (section === kind && arrayKinds.has(kind) && Array.isArray(value)) {
      value.forEach((item, i) => { if (item?.name !== name) walk(item, at('config', section) + `[${i}]`); });
    } else if (section === kind && !arrayKinds.has(kind) && value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) if (key !== name) walk(item, at(at('config', section), key));
    } else walk(value, at('config', section));
    if (policy && section === 'tunnels' && Array.isArray(value)) value.forEach((v, i) => {
      if (typeof v === 'string') { try { const parts = tokens(v);if (parts.length >= 4) add(atom(parts[3]), `tunnels[${i}] → 出口策略`); } catch (_) { issues.add(`tunnels[${i}]：格式不完整`); } }
    });
  }
  return { references: [...refs], issues: [...issues] };
}
export function deletionState(cfg, kind, name) {
  if (!own(DELETE_LABELS, kind) || typeof name !== 'string' || !name) return { error: '条目类型或名称无效，请刷新页面检查配置' };
  const collection = cfg?.[kind];let item, index = -1;
  if (arrayKinds.has(kind)) {
    if (!Array.isArray(collection)) return { error: '条目已不存在或配置类型已改变，请刷新页面' };
    const matches = collection.map((item, i) => item?.name === name ? i : -1).filter(i => i >= 0);
    if (matches.length !== 1) return { error: matches.length ? '存在同名条目，无法安全确定删除对象，请先修正名称' : '条目已不存在或已重命名，请刷新页面' };
    index = matches[0];item = collection[index];
  } else {
    if (!collection || typeof collection !== 'object' || Array.isArray(collection) || !own(collection, name)) return { error: '条目已不存在或配置类型已改变，请刷新页面' };
    item = collection[name];
  }
  let fingerprint;
  try { fingerprint = JSON.stringify(item); } catch (_) { return { error: '条目包含循环引用，无法安全删除' }; }
  return { ...findConfigReferences(cfg, kind, name), fingerprint, index };
}
export function removeUnreferenced(cfg, kind, name, fingerprint) {
  const result = deletionState(cfg, kind, name);
  if (result.error || result.references.length || result.issues.length) return { removed: false, ...result };
  if (fingerprint !== result.fingerprint) return { removed: false, error: '条目在确认期间已被修改，请重新检查后删除' };
  if (arrayKinds.has(kind)) cfg[kind].splice(result.index, 1);else delete cfg[kind][name];
  return { removed: true };
}
