#!/bin/sh
# ============================================================
# Mihomo Box · OpenWrt 卸载入口（等价于 install.sh --uninstall）
#   sh uninstall.sh            # 保留 config.yaml 与内核
#   sh uninstall.sh --purge    # 全部删除
# ============================================================
set -e
HERE=$(dirname "$0")
ETC=$HERE

case "$(id -u 2>/dev/null || echo 1)" in 0) : ;; *) echo "需要 root 权限运行" >&2; exit 1 ;; esac

PURGE=0
[ "$1" = "--purge" ] && PURGE=1

if [ -x /etc/init.d/mihomo_box ]; then
  /etc/init.d/mihomo_box stop  >/dev/null 2>&1 || true
  /etc/init.d/mihomo_box disable >/dev/null 2>&1 || true
fi
if [ -x "$ETC/scripts/box.sh" ]; then
  "$ETC/scripts/box.sh" stop >/dev/null 2>&1 || true
fi
sleep 1
for _pf in "$ETC/run/httpd.pid" "$ETC/run/core.pid"; do
  if [ -f "$_pf" ]; then
    _p=$(cat "$_pf" 2>/dev/null)
    case "$_p" in ''|*[!0-9]*) : ;; *) kill "$_p" 2>/dev/null || true ;; esac
  fi
done

rm -f /etc/init.d/mihomo_box /etc/config/mihomo_box /usr/bin/mihomo-box 2>/dev/null || true

if [ "$PURGE" = "1" ]; then
  rm -rf "$ETC"
  echo "已卸载并删除 $ETC"
else
  rm -rf "$ETC/scripts" "$ETC/webroot" "$ETC/run" "$ETC/platform" "$ETC/box.version" "$ETC/module.prop" "$ETC/README.md" 2>/dev/null || true
  echo "已卸载（保留 $ETC/config.yaml 与 $ETC/core/；彻底删除：sh uninstall.sh --purge）"
fi
