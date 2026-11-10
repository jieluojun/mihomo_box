#!/bin/sh
# Regression for an explicit system-IPv6 enable after a cached proxy-IPv6 failure.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/mihomo-v6-retry.XXXXXX")
cleanup() { rm -rf "$T"; }
trap cleanup EXIT HUP INT TERM

MODDIR="$T/module"
WORKDIR="$T/work"
IPV6_CONF="$T/proc-ipv6/conf"
IPV6_ROUTE="$T/proc-ipv6/route"
mkdir -p "$MODDIR/scripts" "$WORKDIR/core" "$WORKDIR/run" \
  "$IPV6_CONF/all" "$IPV6_CONF/default" "$IPV6_CONF/lo"
cp "$REPO/scripts/mihomo.sh" "$MODDIR/scripts/mihomo.sh"

cat > "$WORKDIR/config.yaml" <<'EOF'
mode: rule
ipv6: false
dns:
  enable: true
  ipv6: false
listeners:
  - name: ebpf-in
    type: ebpf
    local:
      enable: false
      ipv6: false
    shared:
      enable: false
      ipv6: false
EOF
cat > "$WORKDIR/module-settings.conf" <<'EOF'
system_ipv6=false
core=jieluojun
EOF
: > "$IPV6_ROUTE"
for n in all default lo; do
  for k in disable_ipv6 accept_ra autoconf accept_ra_defrtr accept_ra_pinfo \
           accept_ra_rtr_pref disable_tempaddr router_solicitations; do
    echo 1 > "$IPV6_CONF/$n/$k"
  done
done

# Simulate a previous TUN/eBPF failure on the same kernel and core path.
printf '%s|%s\n' "$(uname -r)" "$WORKDIR/core/mihomo-jieluojun" \
  > "$WORKDIR/run/ipv6.proxyfail"

run_set() {
  MODDIR="$MODDIR" WORKDIR="$WORKDIR" IPV6_CONF="$IPV6_CONF" IPV6_ROUTE="$IPV6_ROUTE" \
    sh "$MODDIR/scripts/mihomo.sh" set system_ipv6 "$1"
}

_on=$(run_set true)
printf '%s\n' "$_on" | grep -q 'IPv6 相关开关已同步（4 项）'
test ! -e "$WORKDIR/run/ipv6.proxyfail"
[ "$(grep -c '^[[:space:]]*ipv6: true$' "$WORKDIR/config.yaml")" -eq 4 ]

_off=$(run_set false)
printf '%s\n' "$_off" | grep -q 'IPv6 相关开关已同步（4 项）'
[ "$(grep -c '^[[:space:]]*ipv6: false$' "$WORKDIR/config.yaml")" -eq 4 ]

echo "IPv6 explicit retry/config sync regression: PASS"
