#!/system/bin/sh
# 卸载脚本（KernelSU/Magisk 在删除模块目录前以 root 执行一次）
#
# 说明：
# · 不动 data/：用户的配置、订阅、数据库都保留在 /data/adb/mihomo-box，
#   以便重装/回滚。不需要保留可手动删除。
# · 卸载前先还原被接管的 APN 协议（「系统 IPv6=关」时模块会把上网 APN 的
#   protocol/roaming_protocol 改成 IPv4 防蜂窝 v6 泄漏，详见 scripts/mihomo.sh
#   的 APN4 子系统）：否则卸载后用户上网 APN 会一直停在 IPv4。
#   按 run/apn4.state 恢复；状态文件里存着接管前的原值。

LOG() { echo "[mihomo-box] $*"; }

APN4_STATE=/data/adb/mihomo-box/run/apn4.state

if [ -f "$APN4_STATE" ]; then
  LOG "卸载还原 APN 协议（按 $APN4_STATE）"
  _changed=0
  while IFS='|' read -r _id _apn _p _r; do
    case "$_id" in ''|\#*) continue ;; esac
    [ -n "$_id" ] && [ -n "$_p" ] || continue
    _r=${_r:-$_p}
    if [ -n "$(command -v content 2>/dev/null)" ]; then
      content update --uri content://telephony/carriers --where "_id=$_id" \
        --bind protocol:s:"$_p" --bind roaming_protocol:s:"$_r" >/dev/null 2>&1 && _changed=1
      LOG "  APN id=$_id (${_apn:-?}) 协议还原为 $_p/$_r"
    else
      LOG "  无 content 命令，请手动把 APN 协议还原为 $_p（apn=${_apn:-?}）"
    fi
  done < "$APN4_STATE"
  rm -f "$APN4_STATE"
  # 有还原动作时让数据重附着一次，使协议当场生效
  if [ "$_changed" = "1" ] && [ -n "$(command -v svc 2>/dev/null)" ]; then
    svc data disable >/dev/null 2>&1
    sleep 2
    svc data enable >/dev/null 2>&1
  fi
fi

LOG "模块目录即将删除，保留 /data/adb/mihomo-box 数据目录"
exit 0
