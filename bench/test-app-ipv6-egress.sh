#!/bin/sh
# Regression for the app-IPv6 egress steering:
#   · proxy side really carries IPv6 (TUN table has a v6 default route on the tun
#     iface) → app IPv6 is routed into the TUN table (mode=tun);
#   · otherwise (ipv6:false / no v6 route / Tproxy real-address-native) → app IPv6
#     is pointed at an unreachable table so it falls back to IPv4 (mode=block),
#     never leaving the device as通用流量;
#   · system IPv6 off / core stopped / app_ipv6=native → no rule at all.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/mihomo-app6.XXXXXX")
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
printf 'default dev mihomo table 2022 metric 1024\n' > "$T/routes.2022"
: > "$T/routes.2023"
: > "$T/rules"

# Fake `ip`: only the -6 rule/route surface the steering needs.
cat > "$T/fake-ip" <<'EOF'
#!/bin/sh
set -eu
[ "$1" = "-6" ] || exit 2
shift
case "$1 $2" in
  "rule show") cat "$FAKE_RULES" ;;
  "rule add")
    shift 2
    [ "$1" = "pref" ] || exit 2
    pref=$2; shift 2
    grep -q "^$pref:" "$FAKE_RULES" && exit 1
    [ "$1" = "to" ] && target=$2; shift 2
    [ "$1" = "iif" ] && iif=$2; shift 2
    [ "$1" = "uidrange" ] && uid=$2; shift 2
    [ "$1" = "lookup" ] || exit 2
    printf '%s: to %s iif %s uidrange %s lookup %s\n' "$pref" "$target" "$iif" "$uid" "$2" >> "$FAKE_RULES"
    ;;
  "rule del")
    shift 2
    [ "$1" = "pref" ] || exit 2
    pref=$2; shift 2
    [ "$1" = "to" ] && target=$2; shift 2
    [ "$1" = "iif" ] && iif=$2; shift 2
    [ "$1" = "uidrange" ] && uid=$2; shift 2
    [ "$1" = "lookup" ] || exit 2
    table=$2
    awk -v p="$pref:" -v d="$target" -v i="$iif" -v u="$uid" -v t="$table" \
      '$1 == p && index($0, "to " d) && index($0, "iif " i) && index($0, "uidrange " u) && index($0, "lookup " t) { next } { print }' \
      "$FAKE_RULES" > "$FAKE_RULES.tmp"
    mv "$FAKE_RULES.tmp" "$FAKE_RULES"
    ;;
  "route show")
    shift 2
    [ "$1" = "table" ] || exit 2
    f="$FAKE_ROUTES_DIR/routes.$2"
    [ -f "$f" ] && cat "$f"
    ;;
  "route add")
    shift 2
    # only `unreachable default table <n>` is exercised
    [ "$1" = "unreachable" ] || exit 2
    [ "$2" = "default" ] || exit 2
    [ "$3" = "table" ] || exit 2
    printf 'unreachable default dev lo table %s\n' "$4" > "$FAKE_ROUTES_DIR/routes.$4"
    ;;
  "route flush")
    shift 2
    [ "$1" = "table" ] || exit 2
    : > "$FAKE_ROUTES_DIR/routes.$2"
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$T/fake-ip"

# Source the production function bodies verbatim (the tested steering + the two
# tun_app6 helpers it delegates to).
sed -n '/^tun_app6_rule_cleanup() {/,/^}/p; /^tun_app6_rule_sync() {/,/^}/p;
        /^app6_android() {/,/^}/p; /^app6_tun_table() {/,/^}/p; /^app6_takeover_table() {/,/^}/p;
        /^app6_block_table_ensure() {/,/^}/p; /^app6_rule_find() {/,/^}/p;
        /^app6_rule_install() {/,/^}/p; /^app6_teardown() {/,/^}/p;
        /^app_ipv6_egress_sync() {/,/^}/p; /^app_ipv6_egress_state() {/,/^}/p' \
  "$REPO/scripts/mihomo.sh" > "$T/functions.sh"

cat > "$T/test.sh" <<'EOF'
#!/bin/sh
set -eu
[ "${DEBUG:-0}" = 1 ] && set -x
RUNDIR=$TEST_RUN
CONFIG=$TEST_CONFIG
TUNHS_LOG=$TEST_LOG
TUNHS_IP=$FAKE_IP
APP6_BLOCK_TABLE=2023
APP6_STATE=$RUNDIR/app-ipv6.rule
APP6_PREF_MIN=8980
APP6_PREF_MAX=8989
APP6_PLAT=""
TUN_APP6_PREF_MIN=8980
TUN_APP6_PREF_MAX=8989
TUN_APP6_UID_MIN=10000
TUN_APP6_UID_MAX=4294967294
TUN_APP6_STATE=$RUNDIR/tun-app-ipv6.rule
FAKE_SYSIPV6=true
FAKE_RUNNING=1
FAKE_APPIPV6=auto
FAKE_EBPF=0
FAKE_EBPF6=0
FAKE_TPROXY=false
_tunhs_bins() { TUNHS_IP=$FAKE_IP; }
tunhs_log() { printf '%s\n' "$*" >> "$TUNHS_LOG"; }
core_platform() { echo android; }
running() { [ "$FAKE_RUNNING" = 1 ]; }
ebpf_listener_active() { [ "${FAKE_EBPF:-0}" = 1 ]; }
ebpf_ipv6_redirect_cached() { [ "${FAKE_EBPF6:-0}" = 1 ]; }
get_setting() {
  case "$1" in
    system_ipv6) printf '%s\n' "$FAKE_SYSIPV6" ;;
    app_ipv6)    printf '%s\n' "$FAKE_APPIPV6" ;;
    tproxy)      printf '%s\n' "$FAKE_TPROXY" ;;
    *)           printf '%s\n' "$2" ;;
  esac
}
setting_v() { SV=$(get_setting "$1" "$2"); }
tunhs_cfg_ipv6() { awk '/^ipv6:/ {print $2; exit}' "$CONFIG"; }
tunhs_cfg_tun_field() {
  awk -v k="$1" '
    /^[^ \t#-]/ { inb = ($1 == "tun:") }
    inb && $1 == k ":" { print $2; exit }
  ' "$CONFIG"
}
. "$TEST_FUNCTIONS"

V6_UP='default dev mihomo table 2022 metric 1024'

# 1) proxy side carries v6 → app IPv6 goes into the TUN table
app_ipv6_egress_sync 1 mihomo
grep -q '^8989: to 2000::/3 iif lo uidrange 10000-4294967294 lookup 2022$' "$FAKE_RULES"
[ "$(app_ipv6_egress_state)" = tun ]
[ ! -s "$FAKE_ROUTES_DIR/routes.2023" ]

# 2) v6 route disappears (ipv6:false 回退 / TUN 没拉起 v6) → switch to block
: > "$FAKE_ROUTES_DIR/routes.2022"
app_ipv6_egress_sync 1 mihomo
grep -q '^8989: to 2000::/3 iif lo uidrange 10000-4294967294 lookup 2023$' "$FAKE_RULES"
[ "$(wc -l < "$FAKE_RULES" | tr -d ' ')" = 1 ]
grep -q '^unreachable default' "$FAKE_ROUTES_DIR/routes.2023"
[ "$(app_ipv6_egress_state)" = block ]

# 3) idempotent: reconciling again must not duplicate rules
app_ipv6_egress_sync 1 mihomo
[ "$(wc -l < "$FAKE_RULES" | tr -d ' ')" = 1 ]
[ "$(app_ipv6_egress_state)" = block ]

# 4) v6 comes back → back to takeover, block table emptied
printf '%s\n' "$V6_UP" > "$FAKE_ROUTES_DIR/routes.2022"
app_ipv6_egress_sync 1 mihomo
grep -q 'lookup 2022$' "$FAKE_RULES"
[ "$(wc -l < "$FAKE_RULES" | tr -d ' ')" = 1 ]
[ ! -s "$FAKE_ROUTES_DIR/routes.2023" ]
[ "$(app_ipv6_egress_state)" = tun ]

# 5) config ipv6:false (with the v6 route still lying around) → block, not takeover
sed -i 's/^ipv6: true$/ipv6: false/' "$TEST_CONFIG"
app_ipv6_egress_sync 1 mihomo
grep -q 'lookup 2023$' "$FAKE_RULES"
[ "$(app_ipv6_egress_state)" = block ]
sed -i 's/^ipv6: false$/ipv6: true/' "$TEST_CONFIG"

# 6) system IPv6 off → no rule at all (device has no v6 egress to leak)
FAKE_SYSIPV6=false
app_ipv6_egress_sync 1 mihomo
[ ! -s "$FAKE_RULES" ]
[ ! -f "$APP6_STATE" ]
[ "$(app_ipv6_egress_state)" = off ]

# 7) core stopped → no rule (never cut the user's only egress)
FAKE_SYSIPV6=true
FAKE_RUNNING=0
: > "$FAKE_ROUTES_DIR/routes.2022"
app_ipv6_egress_sync 1 mihomo
[ ! -s "$FAKE_RULES" ]
[ ! -f "$APP6_STATE" ]

# 8) app_ipv6=native → never intervene
FAKE_RUNNING=1
FAKE_APPIPV6=native
app_ipv6_egress_sync 1 mihomo
[ ! -s "$FAKE_RULES" ]
[ "$(app_ipv6_egress_state)" = off ]

# 9) app_ipv6=block → block even while the TUN does carry v6
FAKE_APPIPV6=block
printf '%s\n' "$V6_UP" > "$FAKE_ROUTES_DIR/routes.2022"
app_ipv6_egress_sync 1 mihomo
grep -q 'lookup 2023$' "$FAKE_RULES"
[ "$(app_ipv6_egress_state)" = block ]

# 10) eBPF listener is the one taking over v6 → nothing to install, mode=ebpf
FAKE_APPIPV6=auto
FAKE_EBPF=1
FAKE_EBPF6=1
app_ipv6_egress_sync 0 ""
[ ! -s "$FAKE_RULES" ]
[ "$(app_ipv6_egress_state)" = ebpf ]

# 11) eBPF active but no role carries v6 (ipv6:false) → block, same as an unhooked TUN
FAKE_EBPF6=0
app_ipv6_egress_sync 0 ""
grep -q 'lookup 2023$' "$FAKE_RULES"
[ "$(app_ipv6_egress_state)" = block ]

# 12) Tproxy mode (TUN off, tproxy on): real v6 is native → must be blocked
FAKE_EBPF=0
: > "$FAKE_ROUTES_DIR/routes.2022"
FAKE_TPROXY=true
app_ipv6_egress_sync 0 ""
grep -q 'lookup 2023$' "$FAKE_RULES"
[ "$(app_ipv6_egress_state)" = block ]

# 13) no takeover at all (plain manual proxy port) → never touch the device's v6
FAKE_TPROXY=false
app_ipv6_egress_sync 0 ""
[ ! -s "$FAKE_RULES" ]
[ ! -f "$APP6_STATE" ]
[ "$(app_ipv6_egress_state)" = off ]

# 14) tun.route-table 手写成与阻断表同号：宁可不阻断，也不能往内核自己的表里灌
#     unreachable（那会直接炸掉 TUN 的 v6 路由）
FAKE_TPROXY=true
sed -i 's/^  route-table: 2022$/  route-table: 2023/' "$TEST_CONFIG"
app_ipv6_egress_sync 1 mihomo || true
[ ! -s "$FAKE_RULES" ]
[ ! -f "$APP6_STATE" ]
sed -i 's/^  route-table: 2023$/  route-table: 2022/' "$TEST_CONFIG"

echo 'app IPv6 egress steering regression: PASS'
EOF
chmod +x "$T/test.sh"

TEST_RUN="$T/run" TEST_CONFIG="$T/active-config.yaml" TEST_LOG="$T/test.log" \
FAKE_IP="$T/fake-ip" FAKE_RULES="$T/rules" FAKE_ROUTES_DIR="$T" \
TEST_FUNCTIONS="$T/functions.sh" sh "$T/test.sh"
