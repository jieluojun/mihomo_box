#!/bin/sh
# Regression for the fwmark path that actually gets app IPv6 into the kernel:
#   · 判据不依赖「内核的 IPv6 策略路由认不认 uid 选择器」：
#       ip6tables -t mangle -A OUTPUT … -j MARK --set-xmark <mark>
#       ip -6 rule add pref 897x fwmark <mark> lookup <TUN 表>
#     真机上 8988/8989 那批 uidrange 规则装得好好的（状态 tun），应用的 v6 SYN 照样
#     从 rmnet 出去 —— fib6 未必按 uid 匹配，「装上了」≠「生效」。fwmark 是 fib6
#     一开始就有、且 ip6table_mangle 会在 mark 变化后强制重查路由（ip6_route_me_harder）
#     的选择器。
#   · 内核自身与系统服务（uid < 10000）绝不能打标：内核的 IPv6 节点出网必须走物理
#     网卡，标了就自己钻进 TUN 形成回环；
#   · 路由表里没有指向该 TUN 的 v6 默认路由时不装 —— 标进空表是黑洞，比直连更糟；
#   · 装链失败必须把 fwmark 规则一起撤掉，不留「没人打标的孤儿规则」。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/mihomo-app6route.XXXXXX")
trap 'rm -rf "$T"' EXIT HUP INT TERM

mkdir -p "$T/run"
cat > "$T/active-config.yaml" <<'EOF'
ipv6: true
tun:
  enable: true
  device: mihomo
  route-table: 2022
EOF
: > "$T/state"
: > "$T/chains"
: > "$T/rules"

cat > "$T/fake-ip6tables" <<'EOF'
#!/bin/sh
# 极简 ip6tables 替身：链名单 + "<链>|<规则>" 行式规则表（-t 忽略：本测只装一条链）
while [ $# -gt 0 ]; do
  case "$1" in
    -w) shift ;;
    -t) shift 2 ;;
    *) break ;;
  esac
done
cmd=$1; shift
have() { awk -F'|' -v c="$1" -v r="$2" '$1 == c && $2 == r { f = 1 } END { exit !f }' "$FAKE_IPT_STATE"; }
drop() { awk -F'|' -v c="$1" -v r="$2" '$1 == c && $2 == r { next } { print }' "$FAKE_IPT_STATE" > "$FAKE_IPT_STATE.tmp"; mv "$FAKE_IPT_STATE.tmp" "$FAKE_IPT_STATE"; }
case "$cmd" in
  -L) exit 0 ;;
  -N)
    c=$1
    grep -qx "$c" "$FAKE_IPT_CHAINS" 2>/dev/null || echo "$c" >> "$FAKE_IPT_CHAINS"
    exit 0 ;;
  -F)
    awk -F'|' -v c="$1" '$1 != c' "$FAKE_IPT_STATE" > "$FAKE_IPT_STATE.tmp"
    mv "$FAKE_IPT_STATE.tmp" "$FAKE_IPT_STATE"
    exit 0 ;;
  -X)
    grep -vx "$1" "$FAKE_IPT_CHAINS" > "$FAKE_IPT_CHAINS.tmp" 2>/dev/null || :
    mv "$FAKE_IPT_CHAINS.tmp" "$FAKE_IPT_CHAINS"
    exit 0 ;;
  -A)
    c=$1; shift
    case "$*" in
      *owner*) [ "${FAKE_IPT_NO_OWNER:-0}" = 1 ] && exit 1 ;;
    esac
    printf '%s|%s\n' "$c" "$*" >> "$FAKE_IPT_STATE"
    exit 0 ;;
  -C)
    c=$1; shift
    have "$c" "$*"; exit $? ;;
  -I)
    c=$1; shift
    have "$c" "$*" && exit 0
    printf '%s|%s\n' "$c" "$*" >> "$FAKE_IPT_STATE"
    exit 0 ;;
  -D)
    c=$1; shift
    have "$c" "$*" || exit 1
    drop "$c" "$*"
    exit 0 ;;
  *) exit 2 ;;
esac
EOF

cat > "$T/fake-ip" <<'EOF'
#!/bin/sh
# 极简 ip 替身：只实现 -6 rule add/del/show 与 -6 route show table <t>
if [ "$1" = -6 ]; then shift; fi
case "$1" in
  route)
    # route show table <t>：由 ST_ROUTE_READY 决定表里有没有指向 TUN 的默认路由
    if [ "${ST_ROUTE_READY:-1}" = 1 ]; then
      printf 'default dev %s proto static\n' "${ST_IFACE:-mihomo}"
    fi
    exit 0 ;;
  rule) shift ;;
  *) exit 2 ;;
esac
_pref() {
  _p=""; _prev=""
  for _w in "$@"; do
    case "$_prev" in pref) _p=$_w ;; esac
    _prev=$_w
  done
  printf '%s' "$_p"
}
case "$1" in
  add)
    shift
    _p=$(_pref "$@")
    [ -n "$_p" ] || exit 1
    awk -F'|' -v p="$_p" '$1 == p { f = 1 } END { exit !f }' "$FAKE_IP_STATE" && exit 1
    # 少数 ip（含部分 toybox）只吃单个数值，不认 mark/mask 写法
    case "$*" in
      */*) [ "${FAKE_IP_NOMASK:-0}" = 1 ] && exit 1 ;;
    esac
    printf '%s|%s\n' "$_p" "$*" >> "$FAKE_IP_STATE"
    exit 0 ;;
  del)
    shift
    _p=$(_pref "$@")
    [ -n "$_p" ] || exit 1
    awk -F'|' -v p="$_p" '$1 == p { f = 1 } END { exit !f }' "$FAKE_IP_STATE" || exit 1
    awk -F'|' -v p="$_p" '$1 != p' "$FAKE_IP_STATE" > "$FAKE_IP_STATE.tmp"
    mv "$FAKE_IP_STATE.tmp" "$FAKE_IP_STATE"
    exit 0 ;;
  show)
    awk -F'|' '{ print $1 ": " $2 }' "$FAKE_IP_STATE"
    exit 0 ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$T/fake-ip6tables" "$T/fake-ip"

# Source the production function bodies verbatim
sed -n '/^app_ipv6_route_have() {/,/^}/p; /^app_ipv6_route_onoff() {/,/^}/p;
        /^app_ipv6_route_field() {/,/^}/p; /^app_ipv6_route_table() {/,/^}/p;
        /^app_ipv6_route_want_line() {/,/^}/p; /^app_ipv6_route_rule_pref() {/,/^}/p;
        /^app_ipv6_route_unhook() {/,/^}/p; /^app_ipv6_route_hook() {/,/^}/p;
        /^app_ipv6_route_sync() {/,/^}/p; /^app_ipv6_targets() {/,/^}/p;
        /^tproxy_fakeip6_range() {/,/^}/p' \
  "$REPO/scripts/mihomo.sh" > "$T/functions.sh"

cat > "$T/test.sh" <<'EOF'
#!/bin/sh
set -eu
[ "${DEBUG:-0}" = 1 ] && set -x
RUNDIR=$TEST_RUN
CONFIG=$TEST_CONFIG
TUNHS_LOG=$TEST_LOG
TUNHS_IP6T=$FAKE_IP6T
TUNHS_IP=$FAKE_IP
APP6_ROUTE_MARK_VALUE=0x2000000
APP6_ROUTE_MARK="$APP6_ROUTE_MARK_VALUE/$APP6_ROUTE_MARK_VALUE"
APP6_ROUTE_MARK_SHORT=2000000
APP6_ROUTE_CHAIN=MIHOMO_APP6_ROUTE
APP6_ROUTE_STATE=$RUNDIR/app-ipv6-route.state
APP6_ROUTE_PREFS="8978 8977 8976 8975"
APP6_ROUTE_PREF_LO=8970
APP6_ROUTE_PREF_HI=8979
TUN_APP6_UID_MIN=10000
_tunhs_bins() { TUNHS_IP6T=$FAKE_IP6T; TUNHS_IP=$FAKE_IP; }
tunhs_log() { printf '%s\n' "$*" >> "$TUNHS_LOG"; }
get_setting() { [ "$1" = system_ipv6 ] && echo "${ST_SYSIPV6:-true}"; return 0; }
running() { [ "${ST_RUNNING:-1}" = 1 ]; }
tunhs_find_iface() { [ "${ST_IFACE:-mihomo}" = none ] || echo "${ST_IFACE:-mihomo}"; }
ebpf_ipv6_redirect_cached() { [ "${ST_EBPF:-0}" = 1 ]; }
tunhs_cfg_ipv6() { echo "${ST_CFGIPV6:-true}"; }
tunhs_cfg_tun_field() { case "$1" in route-table) echo "${ST_TABLE:-2022}" ;; esac; }
. "$TEST_FUNCTIONS"

chain_has() { grep -q "^MIHOMO_APP6_ROUTE|$1\$" "$FAKE_IPT_STATE"; }
chain_line() { awk -F'|' -v r="$1" '$1 == "MIHOMO_APP6_ROUTE" && $2 == r { print NR }' "$FAKE_IPT_STATE"; }
rules() { wc -l < "$FAKE_IPT_STATE" | tr -d ' '; }
hooks() { grep -c '^OUTPUT|-j MIHOMO_APP6_ROUTE$' "$FAKE_IPT_STATE" || true; }
alive() { grep -qx MIHOMO_APP6_ROUTE "$FAKE_IPT_CHAINS" && echo yes || echo no; }
fwmark_rules() { grep -c 'fwmark 0x2000000' "$FAKE_IP_STATE" || true; }
ip_rules() { wc -l < "$FAKE_IP_STATE" | tr -d ' '; }

# 1) 装上：fwmark 策略路由 + mangle 打标链，放行在前、打标在后
ST_SYSIPV6=true; ST_RUNNING=1; ST_IFACE=mihomo; ST_EBPF=0; ST_ROUTE_READY=1
app_ipv6_route_sync
[ "$(app_ipv6_route_onoff)" = on ]
[ "$(app_ipv6_route_have)" = "on iface=mihomo table=2022 pref=8978" ]
[ "$(alive)" = yes ]
[ "$(fwmark_rules)" = 1 ]
grep -q '^8978|.*fwmark 0x2000000/0x2000000 lookup 2022' "$FAKE_IP_STATE"
chain_has '-o mihomo -j RETURN'
chain_has '-o lo -j RETURN'
chain_has '-m owner --uid-owner 0-9999 -j RETURN'
chain_has '-d 2000::/3 -j MARK --set-xmark 0x2000000/0x2000000'
chain_has '-d fd11:4455:fdea:4000::/64 -j MARK --set-xmark 0x2000000/0x2000000'
[ "$(hooks)" = 1 ]
# 顺序：放行必须排在打标之前（反了就把内核自己的 v6 也送进 TUN，形成回环）
[ "$(chain_line '-o mihomo -j RETURN')" -lt "$(chain_line '-d 2000::/3 -j MARK --set-xmark 0x2000000/0x2000000')" ]
[ "$(chain_line '-m owner --uid-owner 0-9999 -j RETURN')" -lt "$(chain_line '-d 2000::/3 -j MARK --set-xmark 0x2000000/0x2000000')" ]

# 2) 幂等：再对账一次不重复装
_n=$(rules); _m=$(ip_rules)
app_ipv6_route_sync
[ "$(rules)" = "$_n" ]
[ "$(ip_rules)" = "$_m" ]
[ "$(hooks)" = 1 ]

# 3) ip 不认 mark/mask 写法 → 退回单数值写法，仍然装上
FAKE_IP_NOMASK=1; export FAKE_IP_NOMASK
app_ipv6_route_unhook
app_ipv6_route_sync
[ "$(app_ipv6_route_onoff)" = on ]
grep -q '^8978|.*fwmark 0x2000000 lookup 2022' "$FAKE_IP_STATE"
unset FAKE_IP_NOMASK
app_ipv6_route_unhook
app_ipv6_route_sync

# 4) ★关键回归：装链失败必须把 fwmark 规则一起撤掉 —— 光有规则没人打标，等于
#    埋一颗「哪天有人打了同样的 mark 就把应用 v6 送进 TUN 表」的雷。
FAKE_IPT_NO_OWNER=1; export FAKE_IPT_NO_OWNER
app_ipv6_route_unhook
app_ipv6_route_sync
[ "$(app_ipv6_route_onoff)" = off ] || { echo "FAIL: -m owner 不可用却报已装" >&2; exit 1; }
[ "$(ip_rules)" = 0 ] || { echo "FAIL: 装链失败但 fwmark 规则留在表上" >&2; exit 1; }
unset FAKE_IPT_NO_OWNER

# 5) 路由表里没有指向 TUN 的 v6 默认路由 → 不装（标进空表是黑洞，比直连更糟）
ST_ROUTE_READY=0; export ST_ROUTE_READY
app_ipv6_route_sync
[ "$(app_ipv6_route_onoff)" = off ]
[ "$(ip_rules)" = 0 ]
[ "$(alive)" = no ]
ST_ROUTE_READY=1; export ST_ROUTE_READY
app_ipv6_route_sync
[ "$(app_ipv6_route_onoff)" = on ]

# 6) TUN 网卡改名 → 重装放行规则，旧网卡名不能留在链上
ST_IFACE=Meta0; export ST_IFACE
app_ipv6_route_sync
[ "$(app_ipv6_route_have)" = "on iface=Meta0 table=2022 pref=8978" ]
chain_has '-o Meta0 -j RETURN'
chain_has '-o mihomo -j RETURN' && { echo "FAIL: 旧网卡名 mihomo 仍留在放行规则里" >&2; exit 1; }
[ "$(fwmark_rules)" = 1 ]
ST_IFACE=mihomo; export ST_IFACE
app_ipv6_route_sync

# 7) 配置里 TUN 没开 IPv6 → 不装（v6 都不接管，标了也没意义）
ST_CFGIPV6=false; export ST_CFGIPV6
app_ipv6_route_sync
[ "$(app_ipv6_route_onoff)" = off ]
[ "$(ip_rules)" = 0 ]
ST_CFGIPV6=true; export ST_CFGIPV6

# 8) 系统 IPv6 关 / 内核没在跑 / eBPF 在接管 v6 → 全部不装且把规则撤干净
ST_SYSIPV6=false; export ST_SYSIPV6
app_ipv6_route_sync
[ "$(app_ipv6_route_onoff)" = off ]
[ "$(ip_rules)" = 0 ]
[ "$(alive)" = no ]
ST_SYSIPV6=true; ST_RUNNING=0; export ST_SYSIPV6 ST_RUNNING
app_ipv6_route_sync
[ "$(app_ipv6_route_onoff)" = off ]
[ "$(ip_rules)" = 0 ]
ST_RUNNING=1; ST_EBPF=1; export ST_RUNNING ST_EBPF
app_ipv6_route_sync
[ "$(app_ipv6_route_onoff)" = off ]
[ "$(ip_rules)" = 0 ]
ST_EBPF=0; export ST_EBPF
app_ipv6_route_sync
[ "$(app_ipv6_route_onoff)" = on ]

# 9) 自愈：外部清表（fw4 reload / 别的模块 / 手滑 ip -6 rule del）拆过之后重装
"$FAKE_IP6T" -w -t mangle -D OUTPUT -j MIHOMO_APP6_ROUTE
app_ipv6_route_sync
[ "$(hooks)" = 1 ]
[ "$(app_ipv6_route_onoff)" = on ]
"$FAKE_IP" -6 rule del pref 8978
[ "$(ip_rules)" = 0 ]
app_ipv6_route_sync
[ "$(fwmark_rules)" = 1 ]
[ "$(app_ipv6_route_onoff)" = on ]
[ "$(hooks)" = 1 ]

echo 'app IPv6 fwmark route regression: PASS'
EOF
chmod +x "$T/test.sh"
TEST_RUN="$T/run" TEST_CONFIG="$T/active-config.yaml" TEST_LOG="$T/test.log" \
FAKE_IP6T="$T/fake-ip6tables" FAKE_IPT_STATE="$T/state" FAKE_IPT_CHAINS="$T/chains" \
FAKE_IP="$T/fake-ip" ST_IFACE=mihomo FAKE_IP_STATE="$T/rules" \
TEST_FUNCTIONS="$T/functions.sh" sh "$T/test.sh"
