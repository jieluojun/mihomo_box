#!/bin/sh
# Regression for handing the app-IPv6 DNS source back to the core:
#   · 真机上应用每发起一次 v6 连接，就先往 [::1]:53 发一条 AAAA 查询（出网网卡是 lo，
#     兜底拦截按「回环」放行了它）；应答它的并不是内核的 DNS，于是配置里的
#     dns.ipv6:false 管不到，应用拿得到 AAAA，白搭一次往返。这里把它 DNAT 到
#     内核自己的 DNS 端口，让「给不给 AAAA」回到配置手里。
#   · 安全边界（缺一不装，装不上就是维持现状，绝不能把 DNS 引到黑洞）：
#       1) ip6tables 的 nat 表得真的可用（不少安卓内核没编 IPv6 NAT）；
#       2) dns.listen 必须是双栈通配（:1053 / [::]:1053）—— 写 0.0.0.0:1053 时
#          ::1:1053 没人应答，接管过去等于断 DNS；
#       3) /proc/net/{udp,tcp}6 里确实有人在 :: 或 ::1 的那个端口上监听。
#   · 内核自身与系统服务（uid < 10000）不接管：内核自己的 DNS 出口不能被指回自己。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/mihomo-app6dns.XXXXXX")
trap 'rm -rf "$T"' EXIT HUP INT TERM

mkdir -p "$T/run" "$T/proc"
: > "$T/state"
: > "$T/chains"

# 内核 DNS 监听端口 1053 = 0x041D；::1 = …01000000，:: = 全 0
cat > "$T/proc/udp6" <<'EOF'
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
  1234: 00000000000000000000000000000000:041D 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 12345
EOF
cat > "$T/proc/tcp6" <<'EOF'
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
  1235: 00000000000000000000000001000000:041D 00000000000000000000000000000000:0000 0A 00000000:00000000 10:00000000 00000000     0        0 12346
EOF

cat > "$T/fake-ip6tables" <<'EOF'
#!/bin/sh
# 极简 ip6tables 替身：链名单 + "<表>|<链>|<规则>" 行式规则表
_tbl=filter
while [ $# -gt 0 ]; do
  case "$1" in
    -w) shift ;;
    -t) _tbl=$2; shift 2 ;;
    *) break ;;
  esac
done
cmd=$1; shift
have() { awk -F'|' -v t="$_tbl" -v c="$1" -v r="$2" '$1 == t && $2 == c && $3 == r { f = 1 } END { exit !f }' "$FAKE_IPT_STATE"; }
drop() { awk -F'|' -v t="$_tbl" -v c="$1" -v r="$2" '$1 == t && $2 == c && $3 == r { next } { print }' "$FAKE_IPT_STATE" > "$FAKE_IPT_STATE.tmp"; mv "$FAKE_IPT_STATE.tmp" "$FAKE_IPT_STATE"; }
case "$cmd" in
  # 「本机没有 IPv6 NAT」的真实表现：nat 表列不出来（探测这一步就失败），
  # 于是 hook 在 -N 之前就退出，链根本不会被建出来。
  -L) [ "${FAKE_IPT_NO_NAT:-0}" = 1 ] && [ "$_tbl" = nat ] && exit 1; exit 0 ;;
  -N)
    c=$1
    grep -qx "$c" "$FAKE_IPT_CHAINS" 2>/dev/null || echo "$c" >> "$FAKE_IPT_CHAINS"
    exit 0 ;;
  -F)
    awk -F'|' -v t="$_tbl" -v c="$1" '!($1 == t && $2 == c)' "$FAKE_IPT_STATE" > "$FAKE_IPT_STATE.tmp"
    mv "$FAKE_IPT_STATE.tmp" "$FAKE_IPT_STATE"
    exit 0 ;;
  -X)
    grep -vx "$1" "$FAKE_IPT_CHAINS" > "$FAKE_IPT_CHAINS.tmp" 2>/dev/null || :
    mv "$FAKE_IPT_CHAINS.tmp" "$FAKE_IPT_CHAINS"
    exit 0 ;;
  -A)
    c=$1; shift
    printf '%s|%s|%s\n' "$_tbl" "$c" "$*" >> "$FAKE_IPT_STATE"
    exit 0 ;;
  -C)
    c=$1; shift
    have "$c" "$*"; exit $? ;;
  -I)
    c=$1; shift
    have "$c" "$*" && exit 0
    printf '%s|%s|%s\n' "$_tbl" "$c" "$*" >> "$FAKE_IPT_STATE"
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
sed -n '/^app_ipv6_dns_have() {/,/^}/p; /^app_ipv6_dns_onoff() {/,/^}/p;
        /^app_ipv6_dns_nat_ok() {/,/^}/p; /^app_ipv6_dns_port() {/,/^}/p;
        /^app_ipv6_dns_listening() {/,/^}/p;
        /^app_ipv6_dns_want_line() {/,/^}/p; /^app_ipv6_dns_unhook() {/,/^}/p;
        /^app_ipv6_dns_hook() {/,/^}/p; /^app_ipv6_dns_sync() {/,/^}/p' \
  "$REPO/scripts/mihomo.sh" > "$T/functions.sh"

mkcfg() { printf 'ipv6: true\ndns:\n  enable: true\n  listen: %s\n' "$1" > "$T/run/active-config.yaml"; }
mkcfg ':1053'

cat > "$T/test.sh" <<'EOF'
#!/bin/sh
set -eu
[ "${DEBUG:-0}" = 1 ] && set -x
RUNDIR=$TEST_RUN
CONFIG=$TEST_CONFIG
TUNHS_LOG=$TEST_LOG
TUNHS_IP6T=$FAKE_IP6T
APP6_DNS_STATE=$RUNDIR/app-ipv6-dns.state
APP6_DNS_CHAIN=MIHOMO_DNS6_HIJACK
APP6_DNS_PROC=$TEST_PROC
APP6_DNS_NAT_CACHE=$RUNDIR/app-ipv6.dnsnat
TUN_APP6_UID_MIN=10000
_tunhs_bins() { TUNHS_IP6T=$FAKE_IP6T; }
tunhs_log() { printf '%s\n' "$*" >> "$TUNHS_LOG"; }
get_setting() { [ "$1" = system_ipv6 ] && echo "${ST_SYSIPV6:-true}"; return 0; }
running() { [ "${ST_RUNNING:-1}" = 1 ]; }
ebpf_ipv6_redirect_cached() { [ "${ST_EBPF:-0}" = 1 ]; }
. "$TEST_FUNCTIONS"

# 规则文本里带 []（[::1]:1053），grep BRE 会把 [] 当字符类 —— 一律用 awk 做整字段精确比较
chain_has() { awk -F'|' -v r="$1" '$1 == "nat" && $2 == "MIHOMO_DNS6_HIJACK" && $3 == r { f = 1 } END { exit !f }' "$FAKE_IPT_STATE"; }
chain_line() { awk -F'|' -v r="$1" '$1 == "nat" && $2 == "MIHOMO_DNS6_HIJACK" && $3 == r { print NR }' "$FAKE_IPT_STATE"; }
alive() { grep -qx MIHOMO_DNS6_HIJACK "$FAKE_IPT_CHAINS" && echo yes || echo no; }
rules() { wc -l < "$FAKE_IPT_STATE" | tr -d ' '; }
hooks() { awk -F'|' '$1 == "nat" && $2 == "OUTPUT" && $3 == "-d ::1 -p udp --dport 53 -j MIHOMO_DNS6_HIJACK" { n++ } END { print n + 0 }' "$FAKE_IPT_STATE"; }
mkcfg() { printf 'ipv6: true\ndns:\n  enable: true\n  listen: %s\n' "$1" > "$CONFIG"; }

# 1) dns.listen 的写法判定：只有双栈通配才可接管，v4 专用一律拒绝
mkcfg ':1053';         [ "$(app_ipv6_dns_port)" = 1053 ]
mkcfg '[::]:1053';     [ "$(app_ipv6_dns_port)" = 1053 ]
mkcfg '0.0.0.0:1053';  app_ipv6_dns_port && { echo "FAIL: 0.0.0.0:1053 被判为可接管" >&2; exit 1; }
mkcfg '127.0.0.1:1053'; app_ipv6_dns_port && { echo "FAIL: 127.0.0.1:1053 被判为可接管" >&2; exit 1; }
mkcfg '::1:1053';      app_ipv6_dns_port && { echo "FAIL: ::1:1053 被判为可接管" >&2; exit 1; }
printf 'ipv6: true\ndns:\n  enable: true\n' > "$CONFIG"
app_ipv6_dns_port && { echo "FAIL: 没写 listen 却被判为可接管" >&2; exit 1; }

# 2) 监听探测：端口上有人（udp6 的 :: / tcp6 的 ::1）→ 可接管；没人 → 不可接管
mkcfg ':1053'
app_ipv6_dns_listening 1053
app_ipv6_dns_listening 5353 && { echo "FAIL: 没人在听的端口被判为可接管" >&2; exit 1; }

# 3) 装上：uid<10000 放行在前，udp/tcp 的 ::1:53 全部 DNAT 到内核 DNS 端口
ST_SYSIPV6=true; ST_RUNNING=1; ST_EBPF=0
app_ipv6_dns_sync
[ "$(app_ipv6_dns_onoff)" = on ]
[ "$(app_ipv6_dns_have)" = "on port=1053" ]
[ "$(alive)" = yes ]
chain_has '-m owner --uid-owner 0-9999 -j RETURN'
chain_has '-p udp -d ::1 --dport 53 -j DNAT --to-destination [::1]:1053'
chain_has '-p tcp -d ::1 --dport 53 -j DNAT --to-destination [::1]:1053'
[ "$(hooks)" = 1 ]
[ "$(chain_line '-m owner --uid-owner 0-9999 -j RETURN')" -lt \
  "$(chain_line '-p udp -d ::1 --dport 53 -j DNAT --to-destination [::1]:1053')" ]

# 4) 幂等
_n=$(rules)
app_ipv6_dns_sync
[ "$(rules)" = "$_n" ]
[ "$(hooks)" = 1 ]

# 5) 三条安全边界任意一条不满足 → 不装（维持现状，绝不把 DNS 引到黑洞）
#    5a) 没有 IPv6 NAT
FAKE_IPT_NO_NAT=1; export FAKE_IPT_NO_NAT
# nat 能力探测是带缓存的（真机上不会中途变化），模拟能力翻转时先清缓存
rm -f "$APP6_DNS_NAT_CACHE" 2>/dev/null
app_ipv6_dns_sync
[ "$(app_ipv6_dns_onoff)" = off ]
[ "$(alive)" = no ]
unset FAKE_IPT_NO_NAT
rm -f "$APP6_DNS_NAT_CACHE" 2>/dev/null
#    5b) dns.listen 写成 v4 专用
app_ipv6_dns_sync
[ "$(app_ipv6_dns_onoff)" = on ]
mkcfg '0.0.0.0:1053'
app_ipv6_dns_sync
[ "$(app_ipv6_dns_onoff)" = off ]
[ "$(alive)" = no ]
mkcfg ':1053'
#    5c) 端口上没人监听
ST_NOPROC=$APP6_DNS_PROC
APP6_DNS_PROC=$TEST_PROC_EMPTY; export APP6_DNS_PROC
app_ipv6_dns_sync
[ "$(app_ipv6_dns_onoff)" = off ]
[ "$(alive)" = no ]
APP6_DNS_PROC=$ST_NOPROC; export APP6_DNS_PROC
app_ipv6_dns_sync
[ "$(app_ipv6_dns_onoff)" = on ]

# 6) 系统 IPv6 关 / 内核没在跑 / eBPF 在接管 → 不装
ST_SYSIPV6=false; export ST_SYSIPV6
app_ipv6_dns_sync
[ "$(app_ipv6_dns_onoff)" = off ]
[ "$(alive)" = no ]
ST_SYSIPV6=true; ST_RUNNING=0; export ST_SYSIPV6 ST_RUNNING
app_ipv6_dns_sync
[ "$(app_ipv6_dns_onoff)" = off ]
ST_RUNNING=1; ST_EBPF=1; export ST_RUNNING ST_EBPF
app_ipv6_dns_sync
[ "$(app_ipv6_dns_onoff)" = off ]
ST_EBPF=0; export ST_EBPF
app_ipv6_dns_sync
[ "$(app_ipv6_dns_onoff)" = on ]

# 7) 自愈：外部清表后重装
"$FAKE_IP6T" -w -t nat -D OUTPUT -d ::1 -p udp --dport 53 -j MIHOMO_DNS6_HIJACK
app_ipv6_dns_sync
[ "$(hooks)" = 1 ]
[ "$(app_ipv6_dns_onoff)" = on ]

echo 'app IPv6 DNS handover regression: PASS'
EOF
chmod +x "$T/test.sh"
mkdir -p "$T/proc-empty"
TEST_RUN="$T/run" TEST_CONFIG="$T/run/active-config.yaml" TEST_LOG="$T/test.log" \
FAKE_IP6T="$T/fake-ip6tables" FAKE_IPT_STATE="$T/state" FAKE_IPT_CHAINS="$T/chains" \
TEST_PROC="$T/proc" TEST_PROC_EMPTY="$T/proc-empty" \
TEST_FUNCTIONS="$T/functions.sh" sh "$T/test.sh"
