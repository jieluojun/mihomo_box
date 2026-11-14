#!/bin/sh
# Regression for TProxy 的 IPv6 接管范围：
#   系统 IPv6 开着时，应用 IPv6 必须「送进内核按规则分流」——真 GUA（240e:/2408:/
#   2409:…）与 fake-ip6 段都要 TPROXY/MARK。只劫持 fake-ip6 会让国内域名（命中
#   dns.fake-ip-filter 走真解析，拿到的是真 GUA）的 v6 连接直连出物理网卡：既绕过了
#   内核的域名分流，也到不了国内出口的免流节点，免流时计成通用流量。
#   · tproxy_ipv6 缺省 / all  → 真 GUA 一并接管（prerouting 的 tproxy + output 的 mark）；
#   · tproxy_ipv6=fakeip      → 旧行为，只有 fake-ip6 段被接管。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/mihomo-tp6.XXXXXX")
trap 'rm -rf "$T"' EXIT HUP INT TERM

mkdir -p "$T/run"

# 只取被测的两个函数本体（nft ruleset 生成 + 接管范围判定）。
sed -n '/^tproxy_nft_write() {/,/^}/p; /^tproxy_ipv6_scope() {/,/^}/p' \
  "$REPO/scripts/mihomo.sh" > "$T/functions.sh"

cat "$T/functions.sh" | grep -q 'tproxy_nft_write()'

cat > "$T/test.sh" <<'EOF'
#!/bin/sh
set -eu
[ "${DEBUG:-0}" = 1 ] && set -x
RUNDIR=$TEST_RUN
. "$TEST_FUNCTIONS"

# —— 被测函数用到的全局量，全部给最小可用值 ——
TP_NFT_TABLE=mihomo_tp
TP_MARK_VALUE=0x10000
TP_MARK=0x10000/0x10000
TP_CORE_GID=3005
TP_APP_MAX=2048
TP_IP=""                 # 不给 ip 命令 → 本机 v6 地址列表为空（不引入外部依赖）
_tp_cap_sockt=0
_ti_port=7893
_ti_v6_ok=on
_ti_bp=gid
_ti_mode=all
_ti_uids=""
TP_STATE=$RUNDIR/tproxy.state
get_setting() { case "$1" in tproxy_ipv6) printf '%s\n' "$FAKE_SCOPE" ;; *) printf '%s\n' "$2" ;; esac; }

FAKE_SCOPE=all
[ "$(tproxy_ipv6_scope)" = all ]
tproxy_nft_write "$TEST_RUN/nft.all" "fd11:4455:fdea:4000::/64"
FAKE_SCOPE=fakeip
[ "$(tproxy_ipv6_scope)" = fakeip ]
tproxy_nft_write "$TEST_RUN/nft.fakeip" "fd11:4455:fdea:4000::/64"

# 两种范围都必须先接管 fake-ip6 段（且排在 fc00::/7 绕行之前）
for f in "$TEST_RUN/nft.all" "$TEST_RUN/nft.fakeip"; do
  grep -q "ip6 daddr fd11:4455:fdea:4000::/64 counter tproxy ip6 to :7893" "$f"
  awk '/tproxy ip6 to/ { t = 1 } /fc00::\/7/ && t { ok = 1 } END { exit !ok }' "$f"
done

# all：真 GUA 一并接管（不带 ip6 daddr 限定的 tproxy / mark 规则）
grep -q '  meta nfproto ipv6 meta l4proto tcp counter tproxy ip6 to :7893' "$TEST_RUN/nft.all"
grep -q '  meta nfproto ipv6 meta l4proto udp counter tproxy ip6 to :7893' "$TEST_RUN/nft.all"
grep -q '^  meta nfproto ipv6 meta l4proto { tcp, udp } counter meta mark set meta mark or ' "$TEST_RUN/nft.all"

# fakeip：真 GUA 放行（不得出现不带 daddr 的 v6 tproxy / v6 mark）
! grep -q 'meta nfproto ipv6 meta l4proto tcp counter tproxy ip6' "$TEST_RUN/nft.fakeip"
! grep -q '^  meta nfproto ipv6 meta l4proto { tcp, udp } counter meta mark' "$TEST_RUN/nft.fakeip"

echo 'TProxy IPv6 takeover scope regression: PASS'
EOF
chmod +x "$T/test.sh"
TEST_RUN="$T/run" TEST_FUNCTIONS="$T/functions.sh" sh "$T/test.sh"
