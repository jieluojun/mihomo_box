#!/bin/sh
# Regression for the "app IPv6 must never leak out" fail-closed guard:
#   · 判据是「这一刻包从哪块网卡出去」，不是「规则装没装 / 状态文件怎么写」：
#       放行 -o <TUN 网卡>（TUN 模式已进内核）与 -o lo（TProxy 的 local 回注），
#       其余从物理网卡出去的应用 v6（uid≥10000）一律 REJECT，App 立刻回退 IPv4。
#     真机上见过规则装得好好的（8988/8989 在位、状态 tun）v6 仍然直连出 rmnet ——
#     内核的 IPv6 策略路由未必认 uid 选择器，只看状态文件会被它骗过去。
#   · 内核自身与系统服务（uid < 10000）必须放行 —— 否则国外 IPv6 节点全断；
#   · 系统 IPv6 关 / 内核没在跑 / eBPF 入站在接管 v6 → 不装（这几种情况要么
#     没有 v6 出网，要么拦了就是断网或掐死 eBPF）；
#   · 幂等；TUN 网卡名变了要重装；内核没有 ip6t_REJECT 时退化为 DROP。
# 这一层刻意不依赖 ip 的 uidrange，也不依赖「规则装上了就一定生效」这个假设。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/mihomo-app6block.XXXXXX")
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

cat > "$T/fake-ip6tables" <<'EOF'
#!/bin/sh
# 极简 ip6tables 替身：链名单 + "<链>|<规则>" 行式规则表
set -eu
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
      *REJECT*) [ "${FAKE_IPT_NO_REJECT:-0}" = 1 ] && exit 1 ;;
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
chmod +x "$T/fake-ip6tables"

# Source the production function bodies verbatim
sed -n '/^app_ipv6_block_have() {/,/^}/p; /^app_ipv6_block_onoff() {/,/^}/p;
        /^app_ipv6_block_want() {/,/^}/p; /^app_ipv6_block_want_line() {/,/^}/p;
        /^app_ipv6_block_unhook() {/,/^}/p; /^app_ipv6_block_hook() {/,/^}/p;
        /^app_ipv6_block_sync() {/,/^}/p; /^app_ipv6_targets() {/,/^}/p;
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
APP6_BLOCK_STATE=$RUNDIR/app-ipv6-block.state
APP6_BLOCK_CHAIN=MIHOMO_APP6_BLOCK
TUN_APP6_UID_MIN=10000
TUN_APP6_UID_MAX=4294967294
_tunhs_bins() { TUNHS_IP6T=$FAKE_IP6T; }
tunhs_log() { printf '%s\n' "$*" >> "$TUNHS_LOG"; }
# 被替身驱动的输入：系统 IPv6 开关 / 内核是否在跑 / TUN 网卡 / eBPF 是否在接管 v6
get_setting() { [ "$1" = system_ipv6 ] && echo "${ST_SYSIPV6:-true}"; return 0; }
running() { [ "${ST_RUNNING:-1}" = 1 ]; }
# 注意：替身必须返回 0（测试脚本开了 set -e；真实的 tunhs_find_iface 找不到网卡时
# 返回 1，主脚本不靠 set -e，这里不能照搬）
tunhs_find_iface() { [ "${ST_IFACE:-mihomo}" = none ] || echo "${ST_IFACE:-mihomo}"; }
ebpf_ipv6_redirect_cached() { [ "${ST_EBPF:-0}" = 1 ]; }
. "$TEST_FUNCTIONS"

chain_has() { grep -q "^MIHOMO_APP6_BLOCK|$1\$" "$FAKE_IPT_STATE"; }
chain_line() { awk -F'|' -v r="$1" '$1 == "MIHOMO_APP6_BLOCK" && $2 == r { print NR }' "$FAKE_IPT_STATE"; }
rules() { wc -l < "$FAKE_IPT_STATE" | tr -d ' '; }
hooks() { grep -c '^OUTPUT|-j MIHOMO_APP6_BLOCK$' "$FAKE_IPT_STATE" || true; }
alive() { grep -qx MIHOMO_APP6_BLOCK "$FAKE_IPT_CHAINS" && echo yes || echo no; }

# 1) 装上：放行三条在前（-o TUN / -o lo / uid<10000），目标段被拒在后
ST_SYSIPV6=true; ST_RUNNING=1; ST_IFACE=mihomo; ST_EBPF=0
app_ipv6_block_sync
[ "$(app_ipv6_block_onoff)" = on ]
[ "$(app_ipv6_block_have)" = "on iface=mihomo" ]
[ "$(alive)" = yes ]
chain_has '-o mihomo -j RETURN'
chain_has '-o lo -j RETURN'
chain_has '-m owner --uid-owner 0-9999 -j RETURN'
chain_has '-d 2000::/3 -j REJECT --reject-with icmp6-adm-prohibited'
chain_has '-d fd11:4455:fdea:4000::/64 -j REJECT --reject-with icmp6-adm-prohibited'
[ "$(hooks)" = 1 ]
# 放行必须排在被拒之前（顺序反了就等于把进内核的流量也拦了）
[ "$(chain_line '-o mihomo -j RETURN')" -lt "$(chain_line '-d 2000::/3 -j REJECT --reject-with icmp6-adm-prohibited')" ]
[ "$(chain_line '-m owner --uid-owner 0-9999 -j RETURN')" -lt "$(chain_line '-d 2000::/3 -j REJECT --reject-with icmp6-adm-prohibited')" ]

# 2) 幂等：再对账一次不重复装（跳转仍只有一条）
_n=$(rules)
app_ipv6_block_sync
[ "$(rules)" = "$_n" ]
[ "$(hooks)" = 1 ]

# 3) ★关键回归：接管方状态不影响本链 —— 真机上规则装得好好的（状态 tun）v6 仍然
#    直连出物理网卡，就是因为状态文件说「已接管」而内核的 v6 策略路由根本没匹配上。
#    本链只看出网网卡，所以 tun/tproxy/ebpf(状态) 下也必须继续拦住裸奔的那一路。
for st in tun tproxy off wait fail; do
  ST_APP6=$st
  app_ipv6_block_sync
  [ "$(app_ipv6_block_onoff)" = on ] || { echo "FAIL: app_ipv6_state=$st 时拦截被摘掉了" >&2; exit 1; }
  chain_has '-o mihomo -j RETURN'
  chain_has '-d 2000::/3 -j REJECT --reject-with icmp6-adm-prohibited'
  [ "$(hooks)" = 1 ]
done

# 4) 系统 IPv6 关 → 不装（设备本来就没有 v6 出网）
ST_SYSIPV6=false
app_ipv6_block_sync
[ "$(app_ipv6_block_onoff)" = off ]
[ "$(alive)" = no ]

# 5) 内核没在跑 → 不装（不存在「绕过内核」，拦了只是让应用断网）
ST_SYSIPV6=true; ST_RUNNING=0
app_ipv6_block_sync
[ "$(app_ipv6_block_onoff)" = off ]
[ "$(alive)" = no ]

# 6) eBPF 入站在接管 v6 → 不装（它的重定向在 TC 层，出网网卡就是物理网卡）
ST_RUNNING=1; ST_EBPF=1
app_ipv6_block_sync
[ "$(app_ipv6_block_onoff)" = off ]
[ "$(alive)" = no ]

# 7) TUN 网卡名变了 → 重装放行规则（旧网卡名不能留在链上）
ST_EBPF=0
app_ipv6_block_sync
[ "$(app_ipv6_block_onoff)" = on ]
ST_IFACE=Meta0
app_ipv6_block_sync
[ "$(app_ipv6_block_have)" = "on iface=Meta0" ]
chain_has '-o Meta0 -j RETURN'
chain_has '-o mihomo -j RETURN' && { echo "FAIL: 旧网卡名 mihomo 仍留在放行规则里" >&2; exit 1; }
# 网卡还没建出来（none）：不写放行规则，v6 全部被拒（宁可回退 IPv4 也不能漏）
ST_IFACE=none
app_ipv6_block_sync
[ "$(app_ipv6_block_have)" = "on iface=none" ]
chain_has '-o Meta0 -j RETURN' && { echo "FAIL: 网卡已消失仍留放行规则" >&2; exit 1; }
chain_has '-d 2000::/3 -j REJECT --reject-with icmp6-adm-prohibited'
ST_IFACE=mihomo
app_ipv6_block_sync

# 8) 内核没有 ip6t_REJECT → 整链退化为 DROP（宁可让 App 等一个 SYN 超时回退，
#    也绝不放 v6 直连出去）。先摘一次：期望态没变时 sync 是幂等的（不会重装），
#    而 REJECT 能力在真机上不会中途变化，所以这里手动制造一次重装。
FAKE_IPT_NO_REJECT=1
export FAKE_IPT_NO_REJECT
app_ipv6_block_unhook
app_ipv6_block_sync
[ "$(app_ipv6_block_onoff)" = on ]
chain_has '-m owner --uid-owner 0-9999 -j RETURN'
chain_has '-d 2000::/3 -j DROP'
chain_has '-d fd11:4455:fdea:4000::/64 -j DROP'
[ "$(hooks)" = 1 ]
unset FAKE_IPT_NO_REJECT

echo 'app IPv6 fail-closed guard regression: PASS'
EOF
chmod +x "$T/test.sh"
TEST_RUN="$T/run" TEST_CONFIG="$T/active-config.yaml" TEST_LOG="$T/test.log" \
FAKE_IP6T="$T/fake-ip6tables" FAKE_IPT_STATE="$T/state" FAKE_IPT_CHAINS="$T/chains" \
TEST_FUNCTIONS="$T/functions.sh" sh "$T/test.sh"
