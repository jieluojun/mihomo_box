// Best-effort log redaction. Never deliberately log request bodies/config drafts.
const keyPattern = '(?:password|passwd|psk|secret|token|authorization|private[-_]key|auth[-_]key|access[-_]token|refresh[-_]token|uuid)';
const sensitiveKey = new RegExp('^' + keyPattern + '$', 'i');
export function logJson(value) {
  return JSON.stringify(value, (key, item) => sensitiveKey.test(key) ? '[REDACTED]' : item);
}
export function redactUiLog(value) {
  let text = String(value);
  text = text.replace(/\b(?:ss|ssr|vmess|vless|trojan|hy2|hysteria2?|tuic|wireguard|anytls):\/\/[^\s<>]+/gi, '[节点 URI 已隐藏]');
  text = text.replace(/\b(https?:\/\/)[^\s/?#]*@/gi, '$1[REDACTED]@');
  text = text.replace(/\b(Bearer|Basic)\s+[^\s,"';]+/gi, '$1 [REDACTED]');
  text = text.replace(/([?&](?:t|token|secret|password|key|access_token|auth)=)[^&#\s]*/gi, '$1[REDACTED]');
  text = text.replace(new RegExp('(["\']?' + keyPattern + '["\']?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|[^\\s,;}]+)', 'gi'), '$1[REDACTED]');
  return text.length > 8192 ? text.slice(0, 8192) + '\n[单条日志过长，已截断]' : text;
}
