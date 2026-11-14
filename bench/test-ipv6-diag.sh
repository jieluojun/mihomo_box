#!/bin/sh
# Regression for the one-shot `mihomo.sh ipv6-diag` snapshot:
#   · 真机上排查「应用 IPv6 到底进没进内核」要反复取计数器、反复贴截图，而每台机器
#     不认的命令参数还不一样（ip -6 rule 的 uidrange、legacy ip6tables 不接受
#     -L -n -v -Z、ip route get 的 uid 参数……）。这个命令的价值就在于「一次跑齐」，
#     所以它的第一要求是：**任何一条命令失败都不能让它自己挂掉** —— 工具缺失、权限
#     不足、表里没东西、内核没在跑，都得照样吐出一份完整快照（失败的那一节留个
#     退出码就行），绝不能半途断掉让人再跑一轮。
#   · 结果同时写进 $RUNDIR/ipv6-diag.txt，可以直接把文件拿出来，不必截图。
#   · -z 先把兜底拦截链计数归零（legacy ip6tables 的 -Z 必须单独调用）。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/mihomo-ipv6diag.XXXXXX")
trap 'rm -rf "$T"' EXIT HUP INT TERM

mkdir -p "$T/run"

# 一切外部命令都失败的替身：模拟「工具在、但全都跑不动」（权限不足 / 内核没编某模块）
cat > "$T/fail-bin" <<'EOF'
#!/bin/sh
echo "$(basename "$0"): simulated failure (${FAIL_MODE:-hard})" >&2
exit "${FAIL_RC:-3}"
EOF
chmod +x "$T/fail-bin"

# 全部成功的替身：-Z 归零那一支要能真的走通
cat > "$T/ok-bin" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$T/ok-bin"

# Source the production function bodies verbatim
sed -n '/^_id_sh() {/,/^}/p; /^ipv6_diag() {/,/^}/p' \
  "$REPO/scripts/mihomo.sh" > "$T/functions.sh"
[ -s "$T/functions.sh" ] || { echo "FAIL: 没抽到函数体" >&2; exit 1; }

cat > "$T/test.sh" <<'EOF'
#!/bin/sh
set -eu
[ "${DEBUG:-0}" = 1 ] && set -x
RUNDIR=$TEST_RUN
APP6_BLOCK_CHAIN=MIHOMO_APP6_BLOCK
APP6_ROUTE_CHAIN=MIHOMO_APP6_ROUTE
APP6_ROUTE_MARK=0x2000000/0x2000000
APP6_ROUTE_PREFS="8978 8977 8976 8975"
APP6_DNS_CHAIN=MIHOMO_DNS6_HIJACK
APP6_UIDR_CACHE=$RUNDIR/app-ipv6.uidrange
IPV6_DIAG_OUT=$RUNDIR/ipv6-diag.txt
# 被替身驱动的输入
_tunhs_bins() { TUNHS_IP=$FAIL_BIN; TUNHS_IP6T=${ST_IP6T:-$FAIL_BIN}; }
ipv6_status() { echo "（替身）ipv6_status 输出"; }
app_ipv6_route_have() { echo "${ST_ROUTE_HAVE:-off}"; }
app_ipv6_route_table() { echo 2022; }
app_ipv6_dns_have() { echo off; }
app_ipv6_dns_port() { [ "${ST_DNS_PORT:-0}" = 1 ] && echo 1053 || return 1; }
app_ipv6_dns_listening() { [ "${ST_DNS_LISTEN:-0}" = 1 ]; }
. "$TEST_FUNCTIONS"

sections() { grep -c '^############ ' "$IPV6_DIAG_OUT" || true; }
has() { grep -q -- "$1" "$IPV6_DIAG_OUT" || { echo "FAIL: 快照里缺：$1" >&2; exit 1; }; }

# 1) 全部外部命令都失败 → 照样吐出完整快照，退出码 0，文件落盘
ST_ROUTE_HAVE=off
ipv6_diag >/dev/null
[ -s "$IPV6_DIAG_OUT" ]
[ "$(sections)" -ge 8 ]
has '############ 现状摘要（ipv6-status） ############'
has '############ 工具链 ############'
has '############ 兜底拦截链'
has '############ 送进内核（fwmark 那一路，不依赖 uid 选择器） ############'
has '############ 路由判决（这一节决定 v6 到底从哪块网卡出去） ############'
has '############ 应用 IPv6 DNS 的源头 ############'
has '############ v6 socket 归属（谁在真的用 IPv6） ############'
# 光有「按 uid 计数」回答不了「有没有国内 v6 在跑」，必须把对端地址解出来
has 'tcp6：已建立连接的 uid → 对端'
has 'uid → 进程名对照'
has '############ 进程与网卡 ############'
has '############ 怎么读这份快照 ############'
# 失败的那一节要留下退出码，不能静默假装成功
has '(退出码 '
# 工具链的判定要能看出「不可用」
has 'mangle 表可用 : 否'
has 'nat 表可用    : 否'

# 2) 路由判决那一节必须真的去问一次「这个 uid 的包判给哪块网卡」——这是整套
#    诊断里唯一能证伪「规则装上了就等于生效」的一条
has 'route get 2400:3200::1 uid '
has '采样用的应用 uid：'

# 3) -z：归零分支要单独调一次 -Z（legacy ip6tables 不接受 -L -n -v -Z）
ST_IP6T=$OK_BIN; export ST_IP6T
ipv6_diag -z >/dev/null
has '（计数已归零）'
[ -s "$IPV6_DIAG_OUT" ]
has '归零后重采：1'
unset ST_IP6T

# 4) 接管态（送进内核 = on）也要能出快照，且把 mark / pref 段带上
ST_ROUTE_HAVE='on iface=mihomo table=2022 pref=8978'
ST_DNS_PORT=1; ST_DNS_LISTEN=1
ipv6_diag >/dev/null
has '状态文件：on iface=mihomo table=2022 pref=8978'
has '该端口在 ::1 上有人监听：是'
[ "$(sections)" -ge 8 ]

echo 'ipv6-diag snapshot regression: PASS'
EOF
chmod +x "$T/test.sh"
TEST_RUN="$T/run" FAIL_BIN="$T/fail-bin" OK_BIN="$T/ok-bin" \
TEST_FUNCTIONS="$T/functions.sh" sh "$T/test.sh"
