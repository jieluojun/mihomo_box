#!/bin/sh
# Regression for Android TUN IPv6 packets explicitly bound to a cellular source.
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
cat > "$T/routes" <<'EOF'
default dev mihomo table 2022 metric 1024
EOF
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

# Source the production function bodies verbatim, with small config/log/tool shims.
sed -n '/^tun_app6_rule_cleanup() {/,/^}/p; /^tun_app6_rule_sync() {/,/^}/p' \
  "$REPO/scripts/mihomo.sh" > "$T/functions.sh"
cat > "$T/test.sh" <<'EOF'
#!/bin/sh
set -eu
[ "${DEBUG:-0}" = 1 ] && set -x
RUNDIR=$TEST_RUN
CONFIG=$TEST_CONFIG
TUNHS_LOG=$TEST_LOG
TUNHS_IP=$FAKE_IP
TUN_APP6_PREF_MIN=8980
TUN_APP6_PREF_MAX=8989
TUN_APP6_UID_MIN=10000
TUN_APP6_UID_MAX=4294967294
TUN_APP6_STATE=$RUNDIR/tun-app-ipv6.rule
_tunhs_bins() { TUNHS_IP=$FAKE_IP; }
tunhs_log() { printf '%s\n' "$*" >> "$TUNHS_LOG"; }
tunhs_cfg_ipv6() { awk '/^ipv6:/ {print $2; exit}' "$CONFIG"; }
tunhs_cfg_tun_field() {
  awk -v k="$1" '
    /^[^ \t#-]/ { inb = ($1 == "tun:") }
    inb && $1 == k ":" { print $2; exit }
  ' "$CONFIG"
}
. "$TEST_FUNCTIONS"

tun_app6_rule_sync 1 mihomo
 grep -q '^8989: to 2000::/3 iif lo uidrange 10000-4294967294 lookup 2022$' "$FAKE_RULES"
[ "$(wc -l < "$FAKE_RULES" | tr -d ' ')" = 1 ]
# Reconcile is idempotent.
tun_app6_rule_sync 1 mihomo
[ "$(wc -l < "$FAKE_RULES" | tr -d ' ')" = 1 ]
# IPv4-only runtime config removes only our rule, not another module's same-pref rule.
printf '8989: from 2001:db8::/32 lookup 999\n' >> "$FAKE_RULES"
sed -i 's/^ipv6: true$/ipv6: false/' "$TEST_CONFIG"
tun_app6_rule_sync 1 mihomo
grep -q '^8989: from 2001:db8::/32 lookup 999$' "$FAKE_RULES"
[ "$(wc -l < "$FAKE_RULES" | tr -d ' ')" = 1 ]
# A missing TUN route must never install a rule pointing at a dead table.
: > "$FAKE_RULES"
sed -i 's/^ipv6: false$/ipv6: true/' "$TEST_CONFIG"
printf 'default via fe80::1 dev rmnet_data3 table 2022\n' > "$FAKE_ROUTES"
tun_app6_rule_sync 1 mihomo
[ ! -s "$FAKE_RULES" ]
echo 'Android TUN IPv6 app-UID route regression: PASS'
EOF
chmod +x "$T/test.sh"
TEST_RUN="$T/run" TEST_CONFIG="$T/active-config.yaml" TEST_LOG="$T/test.log" \
FAKE_IP="$T/fake-ip" FAKE_RULES="$T/rules" FAKE_ROUTES="$T/routes" \
TEST_FUNCTIONS="$T/functions.sh" sh "$T/test.sh"
