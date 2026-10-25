#!/bin/sh
# ============================================================
# bench/bench-startup.sh —— 启停关键路径基准（脚本层）
#
# 干什么：把模块脚本摆进一个沙盒（临时 MODDIR/WORKDIR），换上
# bench/fake-core.c 编出来的假内核（可配置 -t 耗时与监听延迟），
# 逐个跑「启动 / 重载 / 停止 / 开机链」，打印每一段的真实耗时。
#
# 为什么需要它：内核重载与启动服务的耗时，大头都在脚本这一层的
# 固定开销（进程 fork、轮询粒度、校验策略），真机上很难一边点一边量。
# 这里把所有外部依赖换成可控时序，任何一次改动都能立刻看出是快了还是慢了。
#
# 用法：
#   sh bench/bench-startup.sh                # 基准本仓库的 scripts/mihomo.sh
#   sh bench/bench-startup.sh <另一份脚本>    # 对比另一份（例如 git show HEAD 出来的旧版）
#
# 环境变量：
#   FAKE_TEST_MS     假内核 `-t` 耗时（默认 1500，模拟大配置）
#   FAKE_LISTEN_MS   假内核从 exec 到端口 LISTEN 的耗时（默认 400）
#   FAKE_TEST_FAIL=1 让 `-t` 失败（测失败路径：是否快速失败、是否复用失败缓存）
#   ROUNDS           每个场景重复次数（默认 3，取中位数）
#   VERBOSE=1        打印每场景的 action trace 分段
#
# 注意：只在开发机（Linux）上跑，不参与模块打包（build.sh 已排除 bench/）。
# 真机上的等价物是：sh scripts/mihomo.sh action-trace（最近一次启停的分段耗时）。
# ============================================================
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
SCRIPT=${1:-$REPO/scripts/mihomo.sh}
[ -f "$SCRIPT" ] || { echo "找不到脚本: $SCRIPT" >&2; exit 1; }

FAKE_TEST_MS=${FAKE_TEST_MS:-1500}
FAKE_LISTEN_MS=${FAKE_LISTEN_MS:-400}
FAKE_TEST_FAIL=${FAKE_TEST_FAIL:-0}
ROUNDS=${ROUNDS:-3}
PORT=${BENCH_PORT:-}
WEB_OFFSET=${BENCH_WEB_OFFSET:-97}   # 面板端口 = 内核端口 + 97，两条独立的空闲端口
export FAKE_TEST_MS FAKE_LISTEN_MS FAKE_TEST_FAIL

TMP=${TMPDIR:-/tmp}/mb-bench.$$
MODDIR=$TMP/module
WORKDIR=$TMP/work
mkdir -p "$MODDIR/scripts" "$WORKDIR/core" "$WORKDIR/run" || exit 1

MH="sh $MODDIR/scripts/mihomo.sh"
export MODDIR WORKDIR

cleanup() {
  kill_cores
  kill_web
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# ---- 计时 ----
now_ms() { date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))'; }

port_busy_port() {
  # 端口是否已被监听（只读 /proc，与脚本里同款判定）
  _pb_hx=$(printf '%04X' "$1" 2>/dev/null) || return 1
  for _pb_n in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$_pb_n" ] || continue
    while read -r _pb_a _pb_b _pb_c _pb_st _pb_rest; do
      case "$_pb_a" in sl|Sl|Sl:) continue ;; esac
      case "$_pb_b" in *":$_pb_hx") ;; *) continue ;; esac
      case "$_pb_st" in *0A) return 0 ;; esac
    done < "$_pb_n"
  done
  return 1
}

port_busy() { port_busy_port "$PORT"; }

# 清掉沙盒里的假内核并等端口真正空出来：每个场景前必须做，
# 否则上一轮的内核还占着端口，新内核 bind 失败会被误记成「启动慢/启动失败」。
# 注意：这里不用 pkill -f —— 匹配串会连「命令行里带着该串」的调用者一起杀掉
#（在本仓库的 agent 沙盒里就吃过这个亏：pkill 把自己所在的那条命令也杀了）。
# 用 pgrep 拿到 pid 列表后逐个 kill，并把自身 pid 排除。
kill_by_pattern() {
  for _kp in $(pgrep -f "$1" 2>/dev/null); do
    [ "$_kp" = "$$" ] && continue
    kill "$_kp" 2>/dev/null
  done
}

kill_cores() {
  kill_by_pattern "$WORKDIR/core/mihomo-"
  _kc_i=0
  while port_busy && [ "$_kc_i" -lt 100 ]; do
    _kc_i=$((_kc_i + 1))
    sleep 0.1
  done
  return 0
}

# 面板 httpd 同样是 setsid 脱离的后台进程，沙盒删掉后 env 里看不到 pid 文件，
# 不显式清掉就会一直占着端口：下一轮的 web_start 撞上占用要重试 3 次（约 1s），
# 会把「开机链」场景的耗时长假性地拖慢一秒。按站点根路径精确匹配。
kill_web() {
  kill_by_pattern "httpd .*$TMP/module/webroot/ui"
  _kw_i=0
  while port_busy_port "$WEBPORT" && [ "$_kw_i" -lt 50 ]; do
    _kw_i=$((_kw_i + 1))
    sleep 0.1
  done
  return 0
}

# 选一个空闲端口：绝不能复用上一次跑残留的假内核所占的端口，
# 否则新内核 bind 失败会被误记成「启动慢/启动失败」。
pick_port() {
  _pp_base=${BENCH_PORT:-$((20000 + ($$ % 20000)))}
  _pp_try=0
  while [ "$_pp_try" -lt 60 ]; do
    _pp_p=$((_pp_base + _pp_try))
    [ "$_pp_p" -le 65000 ] || _pp_p=$((20000 + _pp_try))
    PORT=$_pp_p
    port_busy || return 0
    _pp_try=$((_pp_try + 1))
  done
  echo "找不到空闲端口，放弃" >&2
  exit 1
}

# ---- 沙盒：脚本 + 假内核 ----
pick_port
# 面板端口单独挑一个：沿用默认 55555 会撞上真机/别的基准跑残留的 httpd，
# web_start 撞占用要重试 3 次（约 1s），开机链耗时会被这种环境噪声污染。
WEBPORT=$((PORT + WEB_OFFSET))
[ "$WEBPORT" -le 65000 ] || WEBPORT=$((PORT - WEB_OFFSET))
while port_busy_port "$WEBPORT"; do
  WEB_OFFSET=$((WEB_OFFSET + 1))
  WEBPORT=$((PORT + WEB_OFFSET))
  [ "$WEB_OFFSET" -lt 300 ] || break
done
cp "$SCRIPT" "$MODDIR/scripts/mihomo.sh" || exit 1
cp "$REPO/module.prop" "$MODDIR/module.prop" 2>/dev/null
# 面板服务的最小骨架（web_start 会检查 exec.sh 是否存在）
mkdir -p "$MODDIR/webroot/ui/cgi-bin" "$MODDIR/webroot/ui/js" 2>/dev/null
printf '#!/system/bin/sh\nexit 0\n' > "$MODDIR/webroot/ui/cgi-bin/exec.sh" 2>/dev/null
chmod 755 "$MODDIR/webroot/ui/cgi-bin/exec.sh" 2>/dev/null
# 面板设置落盘：固定端口、只回环监听（沙盒里不需要外网可达）
cat > "$WORKDIR/module-settings.conf" <<EOF
webui_port=$WEBPORT
webui=false
autostart=true
EOF

cat > "$WORKDIR/config.yaml" <<EOF
mixed-port: 7890
external-controller: 127.0.0.1:$PORT
mode: rule
proxies: []
rules:
  - MATCH,DIRECT
EOF

CC=${CC:-cc}
command -v "$CC" >/dev/null 2>&1 || { echo "缺少 C 编译器（$CC），无法编译假内核" >&2; exit 1; }
"$CC" -O2 -o "$WORKDIR/core/mihomo-jieluojun" "$HERE/fake-core.c" || exit 1
chmod 755 "$WORKDIR/core/mihomo-jieluojun"
for n in mihomo-liuran001 mihomo-official; do cp "$WORKDIR/core/mihomo-jieluojun" "$WORKDIR/core/$n"; done

# ---- 场景 ----
# run_case <名字> <期望: up|down> <每轮准备命令|-> <命令...>
#   每轮都会：清掉上一轮的假内核 → 执行准备命令（清缓存/改配置）→ 计时跑一遍。
#   期望 up 的场景会在跑完后确认内核真的在运行，避免把「起不来」当成「很快」。
run_case() {
  _rc_name=$1; _rc_expect=$2; _rc_prep=$3; shift 3
  _rc_times=""
  _rc_trace=""
  _rc_i=0
  while [ "$_rc_i" -lt "$ROUNDS" ]; do
    kill_cores
    kill_web
    [ "$_rc_prep" = "-" ] || eval "$_rc_prep" >/dev/null 2>&1
    rm -f "$WORKDIR/run/bench.trace"
    _rc_t0=$(now_ms)
    MH_ACTION_TRACE="$WORKDIR/run/bench.trace" $MH "$@" >/dev/null 2>&1
    _rc_t1=$(now_ms)
    if [ "$_rc_expect" = "up" ] && ! $MH running >/dev/null 2>&1; then
      echo "  ✗ 场景「$_rc_name」本轮未能拉起内核 —— 环境问题（端口 $PORT 被占？），结果作废" >&2
      tail -3 "$WORKDIR/run/core.log" 2>/dev/null >&2
      exit 1
    fi
    _rc_times="$_rc_times $((_rc_t1 - _rc_t0))"
    [ "$_rc_i" -eq 0 ] && _rc_trace=$(tr '\n' ' ' 2>/dev/null < "$WORKDIR/run/bench.trace")
    _rc_i=$((_rc_i + 1))
  done
  _rc_sorted=$(printf '%s\n' $_rc_times | sort -n | tr '\n' ' ')
  _rc_n=$(printf '%s\n' $_rc_times | wc -l | tr -d ' ')
  _rc_med=$(printf '%s\n' $_rc_times | sort -n | sed -n "$(( (_rc_n + 1) / 2 ))p")
  printf '  %-20s 中位 %5sms   全部: %s\n' "$_rc_name" "$_rc_med" "$_rc_sorted"
  if [ -n "${VERBOSE:-}" ] && [ -n "$_rc_trace" ]; then
    printf '      trace: %s\n' "$_rc_trace"
  fi
  return 0
}

# 让配置指纹失效（模拟「面板刚保存过配置」）
touch_config() { printf '\n# bench touch %s\n' "$(now_ms)" >> "$WORKDIR/config.yaml"; }

# 让内核处于运行态（后续重载场景才有东西可停）
ensure_running() { $MH start >/dev/null 2>&1; kill_cores; $MH start >/dev/null 2>&1; }

echo "============================================================"
echo " 模块启停基准"
echo " 脚本: $SCRIPT"
echo " 假内核: -t=${FAKE_TEST_MS}ms  监听=${FAKE_LISTEN_MS}ms  每场景 ${ROUNDS} 轮取中位  端口: $PORT"
echo "============================================================"

echo " 面板: http://127.0.0.1:$WEBPORT/  沙盒: $TMP"
echo "------------------------------------------------------------"

# 预热一遍再计时：脚本里有些状态是「装机后第一次运行」才付的代价（系统 IPv6
# 首次接管、APN 协议改写等，真机上跑过一次就不再重付），混进基准会让人误以为
# 每次启动都这么慢。这里先空跑一次 start+stop，把这类一次性开销排除在计时外。
printf '预热（排除一次性状态初始化的开销）…'
$MH start >/dev/null 2>&1; $MH stop >/dev/null 2>&1
kill_cores; kill_web
echo ' 完成'
echo ""

echo "· 冷启动（每轮都清掉校验缓存，必须跑一次 -t）"
# 只清「配置校验」的两份缓存：那才是要测的重活。-t 成功/失败缓存清掉后每轮
# 都必须真跑一次 mihomo -t。run/nap.mode 这类「探测一次就一直用」的缓存不要清，
# 清掉等于把装机时的能力探测成本算进每次启动（真机上它跨重启保留）。
run_case "冷启动" up "rm -f \"$WORKDIR/run/tested.fp\" \"$WORKDIR/run/verify.fail\"; $MH stop" start

echo "· 重载：配置未变（应命中校验缓存）"
ensure_running
run_case "重载(配置未变)" up "ensure_running" restart

echo "· 重载：配置已改（需重新校验）"
run_case "重载(配置已改)" up "ensure_running; touch_config" restart

echo "· 启动服务：面板 + 内核（开机链）"
run_case "boot(面板+内核)" up "$MH stop" boot

echo "· 停止"
run_case "停止" down "ensure_running" stop

echo "· 失败路径：配置非法（应快速失败，并复用失败缓存）"
FAKE_TEST_FAIL=1; export FAKE_TEST_FAIL
run_case "启动(配置非法) 首次" down "touch_config; $MH stop" start
run_case "启动(配置非法) 复用缓存" down "$MH stop" start
FAKE_TEST_FAIL=0; export FAKE_TEST_FAIL
kill_cores
echo "============================================================"
