#!/bin/sh
# Regression for the「装了系统 IPv6 之后，配置里的 v6 开关自己变成 false」误判：
#
#   ipv6_proxy_guard 的判据是「配置要 TUN，内核却说 enable:false → TUN 没起来，
#   把 proxy 侧 4 个 v6 开关改回 false 再重启」。问题在**什么时候问这句话**：
#     · 控制器端口在 hub.applyRoute 里就监听，executor.ApplyConfig（TUN 在这里建）
#       要晚一些才跑完 —— 这段空窗里 /configs 报的是 LastTunConf 零值
#       （enable:false）；
#     · 模块开关在管理器里「关→开」走的正是 start_core，而 start_core 的就绪判据
#       恰好是「控制器端口监听」，于是后台守卫在 ApplyConfig 结束前就被 fork 出去。
#   两个条件相乘 ⇒ 每次关再开模块（或每次打开系统 IPv6）守卫都必然误判一次，
#   配置被刷成 v4-only，用户看到的就是「我明明开着 IPv6，配置里的 v6 开关全关了」。
#
# 本回归锁住三件事：
#   1) 窗口内出现 TUN 网卡 / 内核自报 enable:true → 一律不动配置（健康路径）；
#   2) 窗口耗尽 + 独立证据（自报 false 且没有网卡、或本轮日志里的 v6 错误）才回退；
#   3) 回退前落一份配置备份，用户能找回原来的 v6 开关。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/mihomo-v6guard.XXXXXX")
trap 'rm -rf "$T"' EXIT HUP INT TERM

mkdir -p "$T/run" "$T/net"

# 生产函数体原样抽出来（不 source 整个脚本：末尾是命令分发）
sed -n '/^cfg_top_ipv6() {/,/^}/p;
        /^ipv6_proxy_capable() {/,/^}/p;
        /^ipv6_guard_log_new() {/,/^}/p;
        /^ipv6_guard_evidence() {/,/^}/p;
        /^ipv6_proxy_guard() {/,/^}/p;
        /^_ipv6_proxy_guard_body() {/,/^}/p;
        /^cfg_ipv6_set_all() {/,/^}/p;
        /^ipv6_cfg_heal() {/,/^}/p' \
  "$REPO/scripts/mihomo.sh" > "$T/functions.sh"
[ -s "$T/functions.sh" ] || { echo "FAIL: 没抽到函数体" >&2; exit 1; }
for _f in cfg_top_ipv6 ipv6_proxy_capable ipv6_guard_log_new ipv6_guard_evidence \
          ipv6_proxy_guard _ipv6_proxy_guard_body cfg_ipv6_set_all ipv6_cfg_heal; do
  grep -q "^$_f() {" "$T/functions.sh" || { echo "FAIL: 缺函数 $_f" >&2; exit 1; }
done

mkcfg() {
  cat > "$1" <<'EOF'
mode: rule
log-level: silent
ipv6: true
dns:
  enable: true
  listen: 0.0.0.0:1053
  ipv6: true
listeners:
  - name: ebpf-in
    type: ebpf
    local:
      enable: false
      ipv6: true
    shared:
      enable: false
      ipv6: true
tun:
  enable: true
  device: mihomo
EOF
}

cat > "$T/harness.sh" <<'EOF'
#!/bin/sh
set -eu
[ "${DEBUG:-0}" = 1 ] && set -x

RUNDIR=$TEST_RUN
CONFIG=$TEST_WORKDIR/config.yaml
LOGFILE=$RUNDIR/core.log
LOGFILE_OFF=$LOGFILE.off
TESTED=$RUNDIR/tested.fp
IPV6_PFAIL=$RUNDIR/ipv6.proxyfail
IPV6_PFAIL_VER=v2
IPV6_HEAL_MARK=$RUNDIR/ipv6.heal.v
IPV6_PLOG=$RUNDIR/ipv6.proxy.log
IPV6_PBACKUP=$RUNDIR/config.yaml.ipv6bak
IPV6_GUARD_LOCK=$RUNDIR/ipv6.guard.lock
# 真实值是 12s / 4s，这里压到 3/2 让回归跑得快；语义完全一致（轮数即秒数）
IPV6_GUARD_WAIT=3
IPV6_GUARD_WAIT_EBPF=2

# —— 被替身驱动的外部输入 ——
get_setting() { [ "$1" = system_ipv6 ] && echo "${ST_SYSIPV6:-true}"; return 0; }
running() { [ "${ST_RUNNING:-1}" = 1 ]; }
sw_log() { :; }
live_invalidate() { :; }
nap() { :; }
core_path() { echo "$TEST_WORKDIR/core/mihomo-jieluojun"; }
config_fingerprint() { echo "fp"; }
# 期望态：TUN 或 eBPF 要不要接管（读的是「内核在用的快照」）
runtime_tun_enabled() { [ "${ST_TUN_EXPECT:-1}" = 1 ]; }
ebpf_listener_active() { [ "${ST_EBPF_ACTIVE:-0}" = 1 ]; }
# TUN 网卡何时出现：st_iface_after=N 表示第 N 次轮询起「网卡已建」
# 同理把调用次数落盘：> /dev/null 2>&1 里的调用不一定是子 shell，但落盘最稳
tunhs_find_iface() {
  _c=$(cat "$RUNDIR/iface.calls" 2>/dev/null || echo 0)
  _c=$((_c + 1))
  echo "$_c" > "$RUNDIR/iface.calls"
  [ "$_c" -ge "${ST_IFACE_AFTER:-1}" ] || return 1
  echo mihomo
}
# /configs 替身：前 ST_API_FALSE_CALLS 次报 enable:false（ApplyConfig 还没跑完），
# 之后报 enable:true（内核起来了）。ST_API_FALSE_CALLS=-1 表示永远 false。
# ⚠ api 是在 $(...) 里调的，子 shell 里的变量活不回来 —— 计数必须落盘。
api() {
  _n=$(cat "$RUNDIR/api.calls" 2>/dev/null || echo 0)
  _n=$((_n + 1))
  echo "$_n" > "$RUNDIR/api.calls"
  want=${ST_API_FALSE_CALLS:--1}
  if [ "$want" = "-1" ] || [ "$_n" -lt "$want" ]; then
    printf '{"port":7890,"tun":{"enable":false,"device":"mihomo"}}'
  else
    printf '{"port":7890,"tun":{"enable":true,"device":"mihomo"}}'
  fi
  return 0
}

. "$TEST_FUNCTIONS"

# `sh "$0" restart-json` 的收口：计数 + 记录，绝不真的拉起内核
restart_count() { [ -f "$RUNDIR/restart.calls" ] && cat "$RUNDIR/restart.calls" || echo 0; }

case "${1:-guard}" in
  guard) ipv6_proxy_guard ;;
  heal) ipv6_cfg_heal ;;
  *) : ;;
esac
EOF
chmod +x "$T/harness.sh"

run_case() {
  # $1=名字 其余=环境变量
  name=$1; shift
  work="$T/case-$name"
  mkdir -p "$work/run" "$work/core" "$work/net"
  : > "$work/run/core.log"
  printf '0' > "$work/run/core.log.off"
  mkcfg "$work/config.yaml"
  : > "$work/run/restart.calls"
  rm -f "$work/run/iface.calls" "$work/run/api.calls"
  # restart 替身：经由 $0（harness）分发，这里直接把调用记进文件
  cat > "$work/restart-stub.sh" <<'STUB'
#!/bin/sh
f="$TEST_RUN/restart.calls"
n=$(cat "$f" 2>/dev/null || echo 0)
echo $((n + 1)) > "$f"
exit 0
STUB
  chmod +x "$work/restart-stub.sh"
  echo "== $name"
}

ipv6_v6_line_count() {
  # 期望「所有 v6 开关还是 true」时用；返回非 true 的条数
  grep -cE '^[[:space:]]*ipv6: (true)?$' "$1" 2>/dev/null || true
}

echo "== 1) 窗口内 TUN 网卡建出来（健康路径，绝不能动配置）"
run_case healthy
env TEST_RUN="$T/case-healthy/run" TEST_WORKDIR="$T/case-healthy" \
    TEST_FUNCTIONS="$T/functions.sh" \
    ST_TUN_EXPECT=1 ST_IFACE_AFTER=2 ST_API_FALSE_CALLS=2 \
    sh "$T/harness.sh" guard
# 只要 v6 开关还全在 true 就算过（cfg_ipv6_set_all 只动这 4 处）
[ "$(grep -cE '^[[:space:]]*ipv6: true$' "$T/case-healthy/config.yaml")" -eq 4 ] || {
  echo "FAIL: 健康路径把配置里的 v6 开关改掉了" >&2
  grep -n 'ipv6:' "$T/case-healthy/config.yaml" >&2
  exit 1
}
test ! -e "$T/case-healthy/run/ipv6.proxyfail" || { echo "FAIL: 健康路径落了失败标记" >&2; exit 1; }
test ! -e "$T/case-healthy/run/config.yaml.ipv6bak" || { echo "FAIL: 健康路径也做了备份（说明动了配置）" >&2; exit 1; }

echo "== 2) 内核自报 enable:true 也算好信号（网卡还没建出来）"
run_case api_true
env TEST_RUN="$T/case-api_true/run" TEST_WORKDIR="$T/case-api_true" \
    TEST_FUNCTIONS="$T/functions.sh" \
    ST_TUN_EXPECT=1 ST_IFACE_AFTER=99 ST_API_FALSE_CALLS=2 \
    sh "$T/harness.sh" guard
[ "$(grep -cE '^[[:space:]]*ipv6: true$' "$T/case-api_true/config.yaml")" -eq 4 ] \
  || { echo "FAIL: 内核自报 TUN 已启用时仍把配置改了" >&2; exit 1; }
test ! -e "$T/case-api_true/run/ipv6.proxyfail" || { echo "FAIL: 落在失败标记" >&2; exit 1; }

echo "== 3) 真失败（自报 false + 无网卡 + 窗口耗尽 + TUN 错误日志）才回退"
run_case realfail
printf 'time="x" level=error msg="Start TUN listening error: add local route permission denied"\n' \
  > "$T/case-realfail/run/core.log"
env TEST_RUN="$T/case-realfail/run" TEST_WORKDIR="$T/case-realfail" \
    TEST_FUNCTIONS="$T/functions.sh" \
    ST_TUN_EXPECT=1 ST_IFACE_AFTER=99 ST_API_FALSE_CALLS=-1 \
    sh "$T/harness.sh" guard || true
[ "$(grep -cE '^[[:space:]]*ipv6: false$' "$T/case-realfail/config.yaml")" -eq 4 ] \
  || { echo "FAIL: 真失败时没有回退 4 个 v6 开关" >&2; grep -n 'ipv6:' "$T/case-realfail/config.yaml" >&2; exit 1; }
test -f "$T/case-realfail/run/ipv6.proxyfail" || { echo "FAIL: 没落失败标记" >&2; exit 1; }
test -f "$T/case-realfail/run/config.yaml.ipv6bak" || { echo "FAIL: 回退前没留备份" >&2; exit 1; }
[ "$(grep -cE '^[[:space:]]*ipv6: true$' "$T/case-realfail/run/config.yaml.ipv6bak")" -eq 4 ] \
  || { echo "FAIL: 备份里不是回退前的原始配置" >&2; exit 1; }

echo "== 4) 窗口内日志有错但内核随后起来了 → 不回退（孤证不改配置）"
run_case lateok
printf 'time="x" level=error msg="Start TUN listening error: eagain"\n' > "$T/case-lateok/run/core.log"
env TEST_RUN="$T/case-lateok/run" TEST_WORKDIR="$T/case-lateok" \
    TEST_FUNCTIONS="$T/functions.sh" \
    ST_TUN_EXPECT=1 ST_IFACE_AFTER=3 ST_API_FALSE_CALLS=3 \
    sh "$T/harness.sh" guard
[ "$(grep -cE '^[[:space:]]*ipv6: true$' "$T/case-lateok/config.yaml")" -eq 4 ] \
  || { echo "FAIL: 日志里的历史错误被当成失败，改掉了健康配置" >&2; exit 1; }

echo "== 5) 系统 IPv6 关 / 内核没跑 / 已有失败标记 → 一律不动"
run_case gates
printf '%s|%s|v2\n' "$(uname -r)" "$T/case-gates/core/mihomo-jieluojun" > "$T/case-gates/run/ipv6.proxyfail"
env TEST_RUN="$T/case-gates/run" TEST_WORKDIR="$T/case-gates" \
    TEST_FUNCTIONS="$T/functions.sh" \
    ST_TUN_EXPECT=1 ST_IFACE_AFTER=99 ST_API_FALSE_CALLS=-1 \
    sh "$T/harness.sh" guard
[ "$(grep -cE '^[[:space:]]*ipv6: true$' "$T/case-gates/config.yaml")" -eq 4 ] \
  || { echo "FAIL: 失败标记已存在时仍在动配置" >&2; exit 1; }

env TEST_RUN="$T/case-gates/run" TEST_WORKDIR="$T/case-gates" \
    TEST_FUNCTIONS="$T/functions.sh" ST_SYSIPV6=false \
    ST_TUN_EXPECT=1 ST_IFACE_AFTER=99 ST_API_FALSE_CALLS=-1 \
    sh "$T/harness.sh" guard
[ -f "$T/case-gates/run/iface.calls" ] && { echo "FAIL: 系统 IPv6 关时仍跑了判据" >&2; exit 1; }

echo "== 6) 并发守卫只有一个干活（单实例锁）"
run_case lock
mkdir -p "$T/case-lock/run/ipv6.guard.lock"
sleep 30 &
sleep_pid=$!
echo "$sleep_pid" > "$T/case-lock/run/ipv6.guard.lock/pid"
env TEST_RUN="$T/case-lock/run" TEST_WORKDIR="$T/case-lock" \
    TEST_FUNCTIONS="$T/functions.sh" \
    ST_TUN_EXPECT=1 ST_IFACE_AFTER=99 ST_API_FALSE_CALLS=-1 \
    sh "$T/harness.sh" guard
kill "$sleep_pid" 2>/dev/null || true
[ "$(grep -cE '^[[:space:]]*ipv6: true$' "$T/case-lock/config.yaml")" -eq 4 ] \
  || { echo "FAIL: 已有守卫持锁时第二个仍在改配置" >&2; exit 1; }

echo "== 7) 旧版标记（无版本后缀）不再锁死代理侧 IPv6"
run_case oldmarker
printf '%s|%s\n' "$(uname -r)" "$T/case-oldmarker/core/mihomo-jieluojun" \
  > "$T/case-oldmarker/run/ipv6.proxyfail"
env TEST_RUN="$T/case-oldmarker/run" TEST_WORKDIR="$T/case-oldmarker" \
    TEST_FUNCTIONS="$T/functions.sh" \
    ST_TUN_EXPECT=1 ST_IFACE_AFTER=1 ST_API_FALSE_CALLS=-1 \
    sh "$T/harness.sh" guard
[ -f "$T/case-oldmarker/run/iface.calls" ] \
  || { echo "FAIL: 旧格式标记仍被当成有效失败标记（守卫整段短路）" >&2; exit 1; }

echo "== 8) 配置自愈：系统 IPv6 开 + 顶层 ipv6:false + 只有旧格式标记 → 还原成 true"
run_case heal
sed -i 's/^\([[:space:]]*\)ipv6: true$/\1ipv6: false/' "$T/case-heal/config.yaml"
printf '%s|%s\n' "$(uname -r)" "$T/case-heal/core/mihomo-jieluojun" \
  > "$T/case-heal/run/ipv6.proxyfail"
env TEST_RUN="$T/case-heal/run" TEST_WORKDIR="$T/case-heal" \
    TEST_FUNCTIONS="$T/functions.sh" ST_SYSIPV6=true \
    sh "$T/harness.sh" heal
[ "$(grep -cE '^[[:space:]]*ipv6: true$' "$T/case-heal/config.yaml")" -eq 4 ] \
  || { echo "FAIL: 自愈没有把 4 个 v6 开关还原" >&2; grep -n 'ipv6:' "$T/case-heal/config.yaml" >&2; exit 1; }
test -f "$T/case-heal/run/ipv6.heal.v" || { echo "FAIL: 没落一次性标记（会反复跑）" >&2; exit 1; }

echo "== 9) 自愈不越界：新版标记在场（真失败过）就不还原"
run_case heal_skip
sed -i 's/^\([[:space:]]*\)ipv6: true$/\1ipv6: false/' "$T/case-heal_skip/config.yaml"
printf '%s|%s|v2\n' "$(uname -r)" "$T/case-heal_skip/core/mihomo-jieluojun" \
  > "$T/case-heal_skip/run/ipv6.proxyfail"
env TEST_RUN="$T/case-heal_skip/run" TEST_WORKDIR="$T/case-heal_skip" \
    TEST_FUNCTIONS="$T/functions.sh" ST_SYSIPV6=true \
    sh "$T/harness.sh" heal
[ "$(grep -cE '^[[:space:]]*ipv6: false$' "$T/case-heal_skip/config.yaml")" -eq 4 ] \
  || { echo "FAIL: 有新版失败标记时仍擅自还原配置" >&2; exit 1; }

echo "== 10) 自愈只跑一次"
run_case heal_once
sed -i 's/^\([[:space:]]*\)ipv6: true$/\1ipv6: false/' "$T/case-heal_once/config.yaml"
env TEST_RUN="$T/case-heal_once/run" TEST_WORKDIR="$T/case-heal_once" \
    TEST_FUNCTIONS="$T/functions.sh" ST_SYSIPV6=true \
    sh "$T/harness.sh" heal
sed -i 's/^\([[:space:]]*\)ipv6: true$/\1ipv6: false/' "$T/case-heal_once/config.yaml"
env TEST_RUN="$T/case-heal_once/run" TEST_WORKDIR="$T/case-heal_once" \
    TEST_FUNCTIONS="$T/functions.sh" ST_SYSIPV6=true \
    sh "$T/harness.sh" heal
[ "$(grep -cE '^[[:space:]]*ipv6: false$' "$T/case-heal_once/config.yaml")" -eq 4 ] \
  || { echo "FAIL: 自愈跑了第二次（用户手动关掉的 v6 又被打开）" >&2; exit 1; }

echo "== 11) 自愈的门禁顺序：系统 IPv6 还没开时不能先把一次性标记用掉"
run_case heal_order
sed -i 's/^\([[:space:]]*\)ipv6: true$/\1ipv6: false/' "$T/case-heal_order/config.yaml"
# 第一次：系统 IPv6 是关的（默认），不该还原、也不该落标记
env TEST_RUN="$T/case-heal_order/run" TEST_WORKDIR="$T/case-heal_order" \
    TEST_FUNCTIONS="$T/functions.sh" ST_SYSIPV6=false \
    sh "$T/harness.sh" heal
[ "$(grep -cE '^[[:space:]]*ipv6: false$' "$T/case-heal_order/config.yaml")" -eq 4 ] \
  || { echo "FAIL: 系统 IPv6 关着时擅自打开了配置里的 v6 开关" >&2; exit 1; }
test ! -e "$T/case-heal_order/run/ipv6.heal.v" \
  || { echo "FAIL: 门禁没过就把一次性标记用掉了（用户之后开 IPv6 永远等不到还原）" >&2; exit 1; }
# 第二次：用户打开了系统 IPv6，这一次才该还原
env TEST_RUN="$T/case-heal_order/run" TEST_WORKDIR="$T/case-heal_order" \
    TEST_FUNCTIONS="$T/functions.sh" ST_SYSIPV6=true \
    sh "$T/harness.sh" heal
[ "$(grep -cE '^[[:space:]]*ipv6: true$' "$T/case-heal_order/config.yaml")" -eq 4 ] \
  || { echo "FAIL: 用户之后打开系统 IPv6 时没有还原（门禁顺序错）" >&2; exit 1; }

echo "IPv6 guard observation-window regression: PASS"
