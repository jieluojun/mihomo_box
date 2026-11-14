#!/bin/sh
# Regression for Android TUN IPv6 packets explicitly bound to a cellular source
#   (sing-tun installs `from ::/1 iif lo goto 9010` / `from 8000::/1 …` at prio 9002,
#    which lets a socket already bound to a global IPv6 source skip the TUN table),
#   and for the target set that "sends app IPv6 into the core":
#   · 真 GUA 2000::/3 与 DNS fake-ip6 段各一条 8980-8989 规则 → 送进 TUN 路由表，
#     由内核按规则分流（国内 v6 → 国内出口，国外 v6 → 国外出口）；
#   · fake-ip6 段落在 2000::/3 之内时不重复装；
#   · 幂等；只拆自己的规则，不动同优先级的别人的规则；
#   · TUN 表里没有指向 tun 网卡的 v6 默认路由 → 不装（绝不指向半建/死表），状态 wait。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/mihomo-tun-app6.XXXXXX")
trap 'rm -rf "$T"' EXIT HUP INT TERM

mkdir -p "$T/run"
cat > "$T/active-config.yaml" <<'EOF'
ipv6: true
tun:
  enable: true
  device: mihomo
  auto-route: true
  route-table: 2022
EOF
printf 'default dev mihomo table 2022 metric 1024\n' > "$T/routes"
: > "$T/rules"

cat > "$T/fake-ip" <<'EOF'
#!/bin/sh
set -eu
[ "$1" = "-6" ] || exit 2
shift
case "$1 $2" in
  "route show")
    shift 2
    [ "$1" = "table" ] || exit 2
    table=$2
    [ "$table" = "2022" ] && cat "$FAKE_ROUTES" || exit 0
    ;;
  "rule show") cat "$FAKE_RULES" ;;
  "rule add")
    shift 2
    [ "$1" = "pref" ] || exit 2
    pref=$2; shift 2
    grep -q "^$pref:" "$FAKE_RULES" && exit 1
    [ "$1" = "to" ] && target=$2; shift 2
    [ "$1" = "iif" ] && iif=$2; shift 2
    [ "$1" = "uidrange" ] && uid=$2; shift 2
    [ "$1" = "lookup" ] && table=$2
    printf '%s: to %s iif %s uidrange %s lookup %s\n' "$pref" "$target" "$iif" "$uid" "$table" >> "$FAKE_RULES"
    ;;
  "rule del")
    shift 2
    [ "$1" = "pref" ] || exit 2
    pref=$2; shift 2
    [ "$1" = "to" ] && target=$2; shift 2
    [ "$1" = "iif" ] && iif=$2; shift 2
    [ "$1" = "uidrange" ] && uid=$2; shift 2
    [ "$1" = "lookup" ] && table=$2
    awk -v p="$pref:" -v d="$target" -v i="$iif" -v u="$uid" -v t="$table" \
      '$1 == p && index($0, "to " d) && index($0, "iif " i) && index($0, "uidrange " u) && index($0, "lookup " t) { next } { print }' \
      "$FAKE_RULES" > "$FAKE_RULES.tmp"
    mv "$FAKE_RULES.tmp" "$FAKE_RULES"
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$T/fake-ip"

# Source the production function bodies verbatim (the steering, its helpers and
# the fake-ip6 range reader it delegates to).
sed -n '/^tun_app6_rule_cleanup() {/,/^}/p; /^tun_app6_rule_sync() {/,/^}/p;
        /^app_ipv6_targets() {/,/^}/p; /^app_ipv6_state_set() {/,/^}/p;
        /^app_ipv6_state() {/,/^}/p; /^app_ipv6_uidrange_ok() {/,/^}/p;
        /^app_ipv6_route_have() {/,/^}/p; /^app_ipv6_route_field() {/,/^}/p;
        /^tproxy_fakeip6_range() {/,/^}/p' \
  "$REPO/scripts/mihomo.sh" > "$T/functions.sh"

cat > "$T/test.sh" <<'EOF'
#!/bin/sh
set -eu
[ "${DEBUG:-0}" = 1 ] && set -x
RUNDIR=$TEST_RUN
CONFIG=$TEST_CONFIG
TUNHS_LOG=$TEST_LOG
TUNHS_IP=$FAKE_IP
APP6_STATE=$RUNDIR/app-ipv6.state
TP_STATE=$RUNDIR/tproxy.state
TUN_APP6_PREF_MIN=8980
APP6_ROUTE_STATE=$RUNDIR/app-ipv6-route.state
TUN_APP6_PREF_MAX=8989
TUN_APP6_UID_MIN=10000
TUN_APP6_UID_MAX=4294967294
TUN_APP6_STATE=$RUNDIR/tun-app-ipv6.rule
APP6_UIDR_CACHE=$RUNDIR/app-ipv6.uidrange
_tunhs_bins() { TUNHS_IP=$FAKE_IP; }
tunhs_log() { printf '%s\n' "$*" >> "$TUNHS_LOG"; }
ebpf_ipv6_redirect_cached() { return 1; }
tunhs_cfg_ipv6() { awk '/^ipv6:/ {print $2; exit}' "$CONFIG"; }
tunhs_cfg_tun_field() {
  awk -v k="$1" '
    /^[^ \t#-]/ { inb = ($1 == "tun:") }
    inb && $1 == k ":" { print $2; exit }
  ' "$CONFIG"
}
. "$TEST_FUNCTIONS"

GUA='^8989: to 2000::/3 iif lo uidrange 10000-4294967294 lookup 2022$'
FIP6='^8988: to fd11:4455:fdea:4000::/64 iif lo uidrange 10000-4294967294 lookup 2022$'
lines() { wc -l < "$FAKE_RULES" | tr -d ' '; }

# 1) 真 GUA 与 fake-ip6 各一条 → 都送进 TUN 表，状态 tun
tun_app6_rule_sync 1 mihomo
grep -q "$GUA" "$FAKE_RULES"
grep -q "$FIP6" "$FAKE_RULES"
[ "$(lines)" = 2 ]
[ "$(app_ipv6_state)" = tun ]

# 2) 对账幂等：再跑一次不重复装
tun_app6_rule_sync 1 mihomo
[ "$(lines)" = 2 ]
[ "$(app_ipv6_state)" = tun ]

# 3) fake-ip6 段落在 2000::/3 之内时不重复装（只剩真 GUA 一条）
printf 'dns:\n  fake-ip-range6: 2001:db8::/48\n' >> "$TEST_CONFIG"
tun_app6_rule_sync 1 mihomo
grep -q "$GUA" "$FAKE_RULES"
[ "$(lines)" = 1 ]
[ "$(app_ipv6_state)" = tun ]
sed -i '/^dns:$/d; /fake-ip-range6:/d' "$TEST_CONFIG"
tun_app6_rule_sync 1 mihomo
[ "$(lines)" = 2 ]

# 4) 配置 ipv6:false（内核不接管 v6）→ 只拆自己的规则，别人的同优先级规则留着
printf '8989: from 2001:db8::/32 lookup 999\n' >> "$FAKE_RULES"
sed -i 's/^ipv6: true$/ipv6: false/' "$TEST_CONFIG"
tun_app6_rule_sync 1 mihomo
grep -q '^8989: from 2001:db8::/32 lookup 999$' "$FAKE_RULES"
[ "$(lines)" = 1 ]
[ "$(app_ipv6_state)" = off ]

# 5) TUN 表里没有指向 tun 网卡的 v6 默认路由 → 绝不装指向死表的规则，记 wait
: > "$FAKE_RULES"
sed -i 's/^ipv6: false$/ipv6: true/' "$TEST_CONFIG"
printf 'default via fe80::1 dev rmnet_data3 table 2022\n' > "$FAKE_ROUTES"
tun_app6_rule_sync 1 mihomo
[ ! -s "$FAKE_RULES" ]
[ "$(app_ipv6_state)" = wait ]

# 6) v6 路由回来 → 立刻接管
printf 'default dev mihomo table 2022 metric 1024\n' > "$FAKE_ROUTES"
tun_app6_rule_sync 1 mihomo
grep -q "$GUA" "$FAKE_RULES"
grep -q "$FIP6" "$FAKE_RULES"
[ "$(app_ipv6_state)" = tun ]

# 7) ★关键回归：fwmark 那一路（app_ipv6_route_*）在干活时，这批 uidrange 规则
#    必须让位 —— 真机上 8988/8989 装得好好的（状态 tun），应用的 v6 照样从物理
#    网卡出去（fib6 未必按 uid 选择器匹配），「规则在位」这个显示骗了我们一轮。
#    让位后状态里如实记 via=fwmark，且 8980-8989 一条都不留。
echo 'on iface=mihomo table=2022 pref=8978' > "$APP6_ROUTE_STATE"
tun_app6_rule_sync 1 mihomo
[ ! -s "$FAKE_RULES" ] || { echo "FAIL: fwmark 在位时仍装了 uidrange 规则" >&2; exit 1; }
[ "$(app_ipv6_state)" = tun ]
grep -q 'via=fwmark' "$APP6_STATE"
grep -q 'pref=8978' "$APP6_STATE"
# fwmark 那一路掉线 → 立刻退回 uidrange 老路
echo off > "$APP6_ROUTE_STATE"
tun_app6_rule_sync 1 mihomo
grep -q "$GUA" "$FAKE_RULES"
grep -q "$FIP6" "$FAKE_RULES"
[ "$(app_ipv6_state)" = tun ]
grep -q 'via=fwmark' "$APP6_STATE" && { echo "FAIL: 已退回 uidrange 但仍记 via=fwmark" >&2; exit 1; }

echo 'Android TUN IPv6 app-UID route regression: PASS'
EOF
chmod +x "$T/test.sh"
TEST_RUN="$T/run" TEST_CONFIG="$T/active-config.yaml" TEST_LOG="$T/test.log" \
FAKE_IP="$T/fake-ip" FAKE_RULES="$T/rules" FAKE_ROUTES="$T/routes" \
TEST_FUNCTIONS="$T/functions.sh" sh "$T/test.sh"
