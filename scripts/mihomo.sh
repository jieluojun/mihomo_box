#!/system/bin/sh
# ============================================================
# mihomo_box 主控制脚本
# 所有 WebUI 与启动脚本的操作都通过本脚本执行
# 用法: sh mihomo.sh <command> [args]
# ============================================================

# 安装目录：默认由脚本自身位置推断（scripts/ 的上一级）。Android 模块运行于
# /data/adb/modules/<id>，此时工作目录固定为 /data/adb/mihomo_box。
# 注意：不能用「/data/adb 是否存在」判断平台——部分路由器也有 /data 分区。
MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}
[ -n "$MODDIR" ] || MODDIR=/etc/mihomo_box
case "$MODDIR" in
  /data/adb/modules/*) WORKDIR=${WORKDIR:-/data/adb/mihomo_box} ;;
  *) WORKDIR=${WORKDIR:-$MODDIR} ;;
esac
RUNDIR=$WORKDIR/run
COREDIR=$WORKDIR/core
CONFIG=$WORKDIR/config.yaml
SETTINGS=$WORKDIR/module-settings.conf
PIDFILE=$RUNDIR/core.pid
LOGFILE=$RUNDIR/core.log
SAVE_FALLBACK_LOG=$RUNDIR/save-fallback.log   # 前端保存走全量重排时的诊断，由 WebUI 服务生命周期管理
TESTED=$RUNDIR/tested.fp     # 上次校验通过的配置指纹
VERIFY_PENDING=$RUNDIR/verify.pending   # 正在跑的配置校验：「<指纹> <pid>」；并发调用据此合并
VERIFY_FAIL=$RUNDIR/verify.fail         # 失败缓存：第一行指纹，其余是 -t 的输出摘要
VERCACHE=$RUNDIR/vercache    # 内核 `-v` 的结果缓存（路径+size+mtime 为 key）

CORE_LIURAN001=$COREDIR/mihomo-liuran001
CORE_JIELUOJUN=$COREDIR/mihomo-jieluojun   # jieluojun/mihomo：liuran001 分支 + 钉钉直连参数支持（With-At 补丁，自动构建）
CORE_OFFICIAL=$COREDIR/mihomo-official

# 环境里可能存在的下载工具路径
export PATH="/data/adb/ksu/bin:/data/adb/ap/bin:/data/adb/magisk:/data/adb/modules/busybox-ndk/system/xbin:$PATH:/sbin:/system/bin:/system/xbin:/product/bin:/odm/bin:/vendor/bin"

mkdir -p "$RUNDIR" "$COREDIR" 2>/dev/null

# ---------------- 高频轮询热路径（早退，不解析下文数千行） ----------------
# 面板开着时「运行日志」约每秒拉一次、「资源条」约每两秒拉一次，若每次都落到
# 文件末尾的主 case，整个几千行都要先被 shell 读一遍。shell 是边读边执行的：
# 这里把纯读命令在最前面直接做完并退出，后面的定义与分支根本不会被解析到，
# 慢设备上轮询开销立降一个量级，总开关这类命令不再被轮询挤到排队。
# 行为与主 case 同款（logs 的默认条数 / logs-clear 的输出 / res 的 JSON 字段）。
case "$1" in
  logs)
    _hd_n=$2
    case "$_hd_n" in ''|*[!0-9]*) _hd_n=100 ;; esac
    tail -n "$_hd_n" "$LOGFILE" 2>/dev/null
    exit 0 ;;
  logs-clear)
    [ -f "$LOGFILE" ] && : > "$LOGFILE" 2>/dev/null
    echo "OK: 运行日志已清空"
    exit 0 ;;
  res)
    # 主页 2s 资源条 + 网络匹配启停探测：只读 pid 文件和 /proc，零函数依赖。
    # Android arm64 CLK_TCK=100、页大小 4096，与 proc_res_usage 默认回落一致。
    _hr_pid=""
    [ -f "$PIDFILE" ] && IFS= read -r _hr_pid < "$PIDFILE" 2>/dev/null
    case "$_hr_pid" in ''|*[!0-9]*) _hr_pid="" ;; esac
    if [ -z "$_hr_pid" ] || ! kill -0 "$_hr_pid" 2>/dev/null; then
      # 网络匹配启动会先校验/对账再写 pid：这段窗口用 starting 标记让主页立刻切到「启动中」
      if [ -f "$RUNDIR/starting" ]; then
        printf '{"running":1,"pid":"","cpu_pct":null,"cpu_dbg":"starting","cpu_wait_ms":0,"mem_kib":0}\n'
        exit 0
      fi
      printf '{"running":0,"pid":"","cpu_pct":null,"cpu_dbg":"stopped","cpu_wait_ms":0,"mem_kib":0}\n'
      exit 0
    fi
    _hr_memk=0; _hr_cpu="null"; _hr_dbg="wait"; _hr_wait=0
    _hr_a=""; _hr_rest=""
    read -r _hr_a _hr_rest 2>/dev/null < "/proc/$_hr_pid/statm" || true
    _hr_rss=${_hr_rest%% *}
    case "$_hr_rss" in [0-9]*) _hr_memk=$(( _hr_rss * 4096 / 1024 )) ;; esac
    _hr_ut=""
    read -r _hr_ut _ 2>/dev/null < /proc/uptime || true
    _hr_st=""
    read -r _hr_st 2>/dev/null < "/proc/$_hr_pid/stat" || true
    _hr_st=${_hr_st##*) }
    _hr_i=0; _hr_f12=""; _hr_f13=""; _hr_ms=0; _hr_ticks=0
    for _hr_tok in $_hr_st; do
      _hr_i=$((_hr_i + 1))
      [ "$_hr_i" -eq 12 ] && _hr_f12=$_hr_tok
      [ "$_hr_i" -eq 13 ] && { _hr_f13=$_hr_tok; break; }
    done
    case "$_hr_ut" in
      [0-9]*|[0-9]*.[0-9]*)
        _hr_s=${_hr_ut%%.*}; _hr_f=${_hr_ut#*.}
        case "$_hr_ut" in *.*) ;; *) _hr_f=00 ;; esac
        case ${#_hr_f} in 1) _hr_f=${_hr_f}0 ;; 2) ;; *) _hr_f=${_hr_f%"${_hr_f#??}"} ;; esac
        case "$_hr_f" in 0*) _hr_f=${_hr_f#0} ;; esac
        [ -n "$_hr_f" ] || _hr_f=0
        case "$_hr_s" in [0-9]*) _hr_ms=$(( _hr_s * 1000 + _hr_f * 10 )) ;; esac
        ;;
    esac
    case "$_hr_f12" in [0-9]*) case "$_hr_f13" in [0-9]*) _hr_ticks=$(( _hr_f12 + _hr_f13 )) ;; esac ;; esac
    _hr_pp=""; _hr_pt=""; _hr_pms=""; _hr_pp10=-1; _hr_pfirst=0
    [ -f "$RUNDIR/cpu.sample" ] && read -r _hr_pp _hr_pt _hr_pms _hr_pp10 _hr_pfirst 2>/dev/null < "$RUNDIR/cpu.sample"
    case "$_hr_pms" in ''|*[!0-9]*) _hr_pms="" ;; esac
    case "$_hr_pp10" in ''|*[!0-9]*) _hr_pp10=-1 ;; esac
    case "$_hr_pfirst" in ''|*[!0-9]*) _hr_pfirst=0 ;; esac
    _hr_min=2000; [ "$_hr_pfirst" = "1" ] && _hr_min=600
    if [ "$_hr_pp" = "$_hr_pid" ] && [ -n "$_hr_pms" ] && [ "$_hr_ms" -gt 0 ] 2>/dev/null; then
      _hr_dt=$(( _hr_ms - _hr_pms ))
      if [ "$_hr_dt" -ge "$_hr_min" ] 2>/dev/null && [ "$_hr_ticks" -ge 0 ] 2>/dev/null; then
        _hr_dtk=$(( _hr_ticks - _hr_pt ))
        [ "$_hr_dtk" -lt 0 ] 2>/dev/null && _hr_dtk=0
        _hr_p10=$(( _hr_dtk * 1000000 / (100 * _hr_dt) ))
        [ "$_hr_p10" -lt 0 ] 2>/dev/null && _hr_p10=0
        [ "$_hr_p10" -gt 10000 ] 2>/dev/null && _hr_p10=10000
        _hr_cpu="$(( _hr_p10 / 10 )).$(( _hr_p10 % 10 ))"
        _hr_dbg="ok"
        printf '%s %s %s %s %s\n' "$_hr_pid" "$_hr_ticks" "$_hr_ms" "$_hr_p10" 0 > "$RUNDIR/cpu.sample.$$" 2>/dev/null \
          && mv -f "$RUNDIR/cpu.sample.$$" "$RUNDIR/cpu.sample" 2>/dev/null
      else
        _hr_dbg="short"
        _hr_wait=$(( _hr_min - _hr_dt ))
        [ "$_hr_wait" -lt 60 ] 2>/dev/null && _hr_wait=60
        if [ "$_hr_pp10" -ge 0 ] 2>/dev/null; then
          _hr_cpu="$(( _hr_pp10 / 10 )).$(( _hr_pp10 % 10 ))"
        fi
      fi
    else
      _hr_dbg="new"
      printf '%s %s %s %s %s\n' "$_hr_pid" "$_hr_ticks" "$_hr_ms" -1 1 > "$RUNDIR/cpu.sample.$$" 2>/dev/null \
        && mv -f "$RUNDIR/cpu.sample.$$" "$RUNDIR/cpu.sample" 2>/dev/null
      _hr_wait=600
    fi
    printf '{"running":1,"pid":"%s","cpu_pct":%s,"cpu_dbg":"%s","cpu_wait_ms":%s,"mem_kib":%s}\n' \
      "$_hr_pid" "$_hr_cpu" "$_hr_dbg" "$_hr_wait" "$_hr_memk"
    exit 0 ;;
esac

# ---------------- busybox 定位 ----------------
# Magisk 自带的 busybox 是单文件 /data/adb/magisk/busybox，不在 PATH 里，
# `command -v busybox` 找不到 —— 于是在纯 Magisk 环境下会误报「系统未提供 busybox httpd」。
# 这里按 PATH → Magisk → KernelSU → APatch → busybox-ndk 模块 依次找一个真正可执行的本体，
# 全局用 $BUSYBOX 调用（可能是绝对路径）。找不到则为空字符串。
BUSYBOX=""
for _bb in \
  "$(command -v busybox 2>/dev/null)" \
  /data/adb/magisk/busybox \
  /data/adb/ksu/bin/busybox \
  /data/adb/ap/bin/busybox \
  /data/adb/modules/busybox-ndk/system/xbin/busybox \
  /system/bin/busybox /system/xbin/busybox /sbin/busybox
do
  [ -n "$_bb" ] && [ -x "$_bb" ] && { BUSYBOX="$_bb"; break; }
done
unset _bb
have_busybox() { [ -n "$BUSYBOX" ]; }

# ---------------- 精简 busybox 兼容（模块层回退） ----------------
# 只在系统缺少对应工具时生效，系统有则原样使用；安装器不再生成垫片。
if ! command -v nohup >/dev/null 2>&1; then
  # 仅用于「nohup cmd … &」后台启动：忽略 SIGHUP 后 exec（忽略态经 exec 被子进程继承）。
  # exec 让 $! 即真实进程，停止服务时 kill 的就是它本身。
  nohup() { trap '' HUP; exec "$@"; }
fi

# 小数秒延时。三类环境，探测一次（按本次开机缓存）后按结果走：
#   frac  = sleep 支持小数（GNU / toybox / 完整 busybox）——直接睡；
#   read  = sleep 只认整数，但 busybox ash 的 read -t 支持小数——用 FIFO 超时计时；
#   ceil  = 两者都不行——小数请求向上取整为 1 秒（等待只会偏长，绝不偏短）。
# ⚠ 精简 busybox 的 sleep 会把「0.1」解析成 0 秒并返回成功（不是报错！），
#   旧实现据此以为小数 sleep 可用，实际每次 nap 都是 0 秒 —— run_timeout 的
#   「300 次 × 0.1s」轮询在 OpenWrt 上 0.3 秒就转完，把刚拉起的 mihomo -t 秒杀
#   并谎报「校验超时 30s」，主页重启/切代理模式全部 ERR_CONFIG（总开关因指纹
#   缓存跳过校验而幸免）。探测以 /proc/uptime 实测流逝时间为准，不信返回码。
NAP_MODE=""
nap_probe() {
  NAP_MODE=ceil
  now_cs || return 0
  _np_t0=$NOW_CS
  sleep 0.2 2>/dev/null || return 0
  now_cs || return 0
  if [ $((NOW_CS - _np_t0)) -ge 15 ]; then
    NAP_MODE=frac
    return 0
  fi
  # sleep 疑似整数版：再探 read -t 小数（ash 内建，无 fork）
  _np_f=/tmp/.mihomo-nap.fifo
  [ -p "$_np_f" ] || mkfifo "$_np_f" 2>/dev/null
  [ -p "$_np_f" ] || return 0
  _np_t0=$NOW_CS
  read -t 0.2 _np_x <> "$_np_f" 2>/dev/null
  now_cs || return 0
  [ $((NOW_CS - _np_t0)) -ge 15 ] && NAP_MODE=read
  return 0
}
# 探测结果按开机缓存（boot_id 变化即重探）：mihomo.sh 每条命令都是新 shell，
# 不缓存的话每次启停/重启都要多付一次探测等待。
nap_load_mode() {
  _nl_boot=""
  if [ -r /proc/sys/kernel/random/boot_id ]; then
    IFS= read -r _nl_boot _ < /proc/sys/kernel/random/boot_id 2>/dev/null
  fi
  [ -n "$_nl_boot" ] || { nap_probe; return 0; }
  _nl_cached=""
  if [ -r "$RUNDIR/nap.mode" ]; then
    # ⚠ 不能用 `IFS= read -r a b` 分两列：IFS 置空即禁用字段分割，
    # 整行会全落进第一个变量、第二个永远是空 —— 缓存因此从不命中，
    # 每条命令都要白付一次 nap_probe（sleep 0.2 + 建 FIFO，实测 200~250ms）。
    # 这是每个用 nap 的命令（启停/重启/面板/监听）都要付的固定开销。
    _nl_line=""
    IFS= read -r _nl_line < "$RUNDIR/nap.mode" 2>/dev/null
    _nl_cboot=${_nl_line%% *}
    _nl_cmode=${_nl_line##* }
    if [ -n "$_nl_cboot" ] && [ "$_nl_cboot" = "$_nl_boot" ]; then
      case "$_nl_cmode" in frac|read|ceil) NAP_MODE=$_nl_cmode; return 0 ;; esac
    fi
  fi
  nap_probe
  printf '%s %s\n' "$_nl_boot" "$NAP_MODE" > "$RUNDIR/nap.mode" 2>/dev/null
  return 0
}
nap() {
  [ -n "$NAP_MODE" ] || nap_load_mode
  case "$NAP_MODE" in
    frac)
      sleep "$1" 2>/dev/null; return 0 ;;
    read)
      _nap_f=/tmp/.mihomo-nap.fifo
      [ -p "$_nap_f" ] || mkfifo "$_nap_f" 2>/dev/null
      [ -p "$_nap_f" ] && read -t "$1" _nap_x <> "$_nap_f" 2>/dev/null
      return 0 ;;
    ceil)
      # 小数请求向上取整到整秒；限时循环的时长上限由 now_cs 的真实时钟保证
      case "$1" in
        *.*) sleep 1 2>/dev/null ;;
        *)   sleep "$1" 2>/dev/null ;;
      esac
      return 0 ;;
  esac
  return 0
}

# 单调时钟（厘秒）：读 /proc/uptime（零 fork，read 是内建）；不可读退 date +%s×100。
# 所有「最多等 N 秒」的循环一律用它算真实截止时间，不再按「轮询次数 × 假定间隔」
# 推算 —— nap 在 ceil 模式下每轮会睡 1 秒，按次数推算的等待会整体失真。
now_cs() {
  NOW_CS=0
  _nu=""
  IFS=' ' read -r _nu _ 2>/dev/null < /proc/uptime
  case "$_nu" in
    [0-9]*.[0-9]*)
      _nu_s=${_nu%.*}
      _nu_f=${_nu#*.}
      # 统一成两位小数（厘秒）：一位补 0，多位截断
      case "${#_nu_f}" in
        1) _nu_f="${_nu_f}0" ;;
        2) : ;;
        *) _nu_f=${_nu_f%"${_nu_f#??}"} ;;
      esac
      # 剥前导零：$((...)) 会把 08/09 当八进制报错
      case "$_nu_f" in 0*) _nu_f=${_nu_f#0} ;; esac
      case "$_nu_f" in '') _nu_f=0 ;; esac
      case "$_nu_s" in ''|*[!0-9]*) ;; *) NOW_CS=$(( _nu_s * 100 + _nu_f )) ;; esac
      ;;
  esac
  [ "$NOW_CS" -gt 0 ] && return 0
  _nu_d=$(date +%s 2>/dev/null)
  case "$_nu_d" in
    [0-9]*) NOW_CS=$(( _nu_d * 100 )); return 0 ;;
  esac
  return 1
}

# 取文件 $1 偏移 $3（默认 0）起的 $2 字节，输出小写十六进制、无分隔。
# 系统 od 优先；缺失时用 dd 逐字节回退（只用于魔数等极小读取）。
bytes_hex() {
  [ -r "$1" ] || return 1
  if command -v od >/dev/null 2>&1; then
    od -An -tx1 -j "${3:-0}" -N "$2" "$1" 2>/dev/null | tr -d ' \r\n'
    return 0
  fi
  _bh_i=0
  while [ "$_bh_i" -lt "$2" ]; do
    _bh_c=$(dd if="$1" bs=1 skip=$(( ${3:-0} + _bh_i )) count=1 2>/dev/null)
    if [ -n "$_bh_c" ]; then printf '%02x' "'$_bh_c"; else printf '00'; fi
    _bh_i=$((_bh_i + 1))
  done
}

# base64 编码（stdin → stdout）：系统 base64 → busybox base64 → awk 纯实现。
# 仅面向文本（配置 / 日志）。awk 版先把输入缓存到临时文件，检测末尾是否有换行，
# 以保证与 base64 输出逐字节一致（不因补换行多出字符）。
b64_encode() {
  if command -v base64 >/dev/null 2>&1; then base64
  elif have_busybox && applet_has "$BUSYBOX" base64; then "$BUSYBOX" base64
  else
    _b6_tmp="${TMPDIR:-/tmp}/b64enc.$$"
    cat > "$_b6_tmp" 2>/dev/null || { rm -f "$_b6_tmp"; return 1; }
    _b6_nl=0
    [ "$(tail -c1 "$_b6_tmp" 2>/dev/null | wc -l)" -gt 0 ] 2>/dev/null && _b6_nl=1
    LC_ALL=C awk -v tail_nl="$_b6_nl" '
BEGIN {
  B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  for (i = 0; i < 256; i++) ord[sprintf("%c", i)] = i
}
function q(v) { return substr(B, v + 1, 1) }
function enc(a, b, c) {
  return q(int(a / 4)) q((a % 4) * 16 + int(b / 16)) q((b % 16) * 4 + int(c / 64)) q(c % 64)
}
function feed(x,   s, n, full, i) {
  s = pend x; n = length(s); full = n - n % 3
  for (i = 1; i <= full; i += 3)
    printf "%s", enc(ord[substr(s, i, 1)], ord[substr(s, i + 1, 1)], ord[substr(s, i + 2, 1)])
  pend = substr(s, full + 1)
}
NR > 1 { feed(prev "\n") }
{ prev = $0 }
END {
  if (NR > 0) feed(prev (tail_nl == "1" ? "\n" : ""))
  n = length(pend)
  if (n == 1) printf "%s==", substr(enc(ord[pend], 0, 0), 1, 2)
  else if (n == 2) printf "%s=", substr(enc(ord[substr(pend, 1, 1)], ord[substr(pend, 2, 1)], 0), 1, 3)
  print ""
}' < "$_b6_tmp"
    rm -f "$_b6_tmp"
  fi
}

# ---------------- 基础工具 ----------------

# ---------------- JSON 安全输出 ----------------
# 血泪教训：任何塞进 JSON 的 shell 变量都可能带控制字符。
# 例如 `ps -o etime= -p <pid>` 在部分 ROM（实测 Android 14 / MIUI）上会先吐一个空行，
# 而 `tr -d ' '` 删不掉换行 —— 结果 "uptime": "<换行>00:11"，整份状态 JSON 直接非法，
# 前端只能显示「无法获取模块状态」，可模块明明跑得好好的。
# 所以：字符串一律走 json_str，数字一律走 json_num，不允许裸插值。
json_str() {
  # 快路径：不含控制字符 / 反斜杠 / 双引号（绝大多数字段）直接原样输出，零 fork。
  # status_json 有十几个字段，以前每个都要 tr+sed 两次 fork，慢设备上一次读数
  # 光这里就是几十次进程创建。判定用 case 模式（dash/mksh/busybox ash 均支持
  # [[:cntrl:]]）；判不准也只是多走一次慢路径，输出与原来完全一致。
  case "$1" in
    *[[:cntrl:]]*|*\\*|*\"*) ;;
    *) printf '%s' "$1"; return 0 ;;
  esac
  # 删掉所有 ASCII 控制字符（含 \n \r \t），再转义反斜杠与双引号（顺序不能反）
  printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# json_str 的变量版：结果放进 J，不打印，调用方免去 $(...) 子 shell
jv() {
  case "$1" in
    *[[:cntrl:]]*|*\\*|*\"*) J=$(json_str "$1") ;;
    *) J=$1 ;;
  esac
}

json_num() {
  # 纯数字直接输出（零 fork）；否则只保留数字，空则 0；杜绝 "uptime_sec": <换行>11 这种非法数值
  case "$1" in
    ''|*[!0-9]*) ;;
    *) printf '%s' "$1"; return 0 ;;
  esac
  _jn=$(printf '%s' "$1" | tr -cd '0-9')
  [ -n "$_jn" ] || _jn=0
  printf '%s' "$_jn"
}

# 多行文本版：换行保留为 JSON 的 \n（其余控制字符照删）。用于把启停命令的
# 人类可读输出（可能多行，如「配置校验通过 / OK: 已启动」）塞进状态 JSON 的 action_msg。
json_str_ml() {
  printf '%s' "$1" | tr -d '\000-\011\013-\037' | sed 's/\\/\\\\/g; s/"/\\"/g' \
    | awk 'NR>1{printf "\\n"} {printf "%s", $0}'
}

setting_v() {
  # 同 get_setting，但结果放进变量 SV 而不打印：调用方不必再包一层 $(...)，
  # 省一次子 shell fork（mksh 上每次 fork 约 1–3ms，status 一次要读 6 个设置）。
  SV=$2
  [ -r "$SETTINGS" ] || return 0
  while IFS= read -r _sv_line || [ -n "$_sv_line" ]; do
    case "$_sv_line" in
      "$1="*) _sv_value=${_sv_line#*=}; SV=${_sv_value:-$2}; return 0 ;;
    esac
  done < "$SETTINGS"
  return 0
}

get_setting() {
  # 固定键按字面匹配。避免每次读取设置都启动 grep/head/cut 三个进程。
  setting_v "$1" "$2"
  printf '%s\n' "$SV"
}

set_setting() {
  # 设置文件是一行一项；拒绝非法键与多行值，避免修改相邻配置。
  case "$1" in ''|*[!A-Za-z0-9_]*) echo "ERR: 非法设置键" >&2; return 1 ;; esac
  case "$2" in *'
'*|*"$(printf '\r')"*) echo "ERR: 设置值不能包含换行" >&2; return 1 ;; esac
  # $1 key, $2 value
  if [ ! -f "$SETTINGS" ]; then printf '%s=%s\n' "$1" "$2" > "$SETTINGS"; return; fi
  if grep -qE "^$1=" "$SETTINGS"; then
    _ss_value=$(printf '%s' "$2" | sed 's/[\\&|]/\\&/g')
    sed -i "s|^$1=.*|$1=$_ss_value|" "$SETTINGS"
  else
    printf '%s=%s\n' "$1" "$2" >> "$SETTINGS"
  fi
}

core_path() {
  case "$(get_setting core jieluojun)" in
    official)  echo "$CORE_OFFICIAL" ;;
    liuran001) echo "$CORE_LIURAN001" ;;
    *)         echo "$CORE_JIELUOJUN" ;;   # jieluojun 为默认分支；未知 / 空值同样回落到这里
  esac
}

# 内核显示名：liuran001 / official 之外的任何值（含空值、jieluojun 与手改过的设置）都按
# jieluojun（默认分支），与 core_path 的选择逻辑一致；给用户看的文字统一走这里
# （官方内核写成 MetaCubeX 官方）。_v 版把结果放进 CLV，调用方免 $(...) 子 shell。
core_label_v() {
  case "$1" in
    official)  CLV="MetaCubeX 官方" ;;
    liuran001) CLV="liuran001" ;;
    *)         CLV="jieluojun" ;;
  esac
}
core_label() { core_label_v "$1"; echo "$CLV"; }

# 判活 / 取 pid 全部用内建（read 重定向 + kill -0），零 fork。
# 这两个函数是全脚本调用最密集的（status / 各 sync / 启停 / 描述同步都在调），
# 以前每次 $(cat) 都要 fork 两次，慢设备上一次 status 光这里就白花几十毫秒。
pid_is_live() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$1" 2>/dev/null || return 1
  # kill -0 对僵尸也成功；退出等待不能因此白等到 TERM 预算上限。
  _pil_stat=""
  if IFS= read -r _pil_stat < "/proc/$1/stat" 2>/dev/null; then
    _pil_state=${_pil_stat##*) }; _pil_state=${_pil_state%% *}
    case "$_pil_state" in Z|X|x) return 1 ;; esac
  fi
  return 0
}
running() {
  _rn_pid=""
  [ -f "$PIDFILE" ] && IFS= read -r _rn_pid < "$PIDFILE" 2>/dev/null
  [ -n "$_rn_pid" ] && pid_is_live "$_rn_pid"
}

pid_of() {
  _po_pid=""
  [ -f "$PIDFILE" ] && IFS= read -r _po_pid < "$PIDFILE" 2>/dev/null
  [ -n "$_po_pid" ] && printf '%s\n' "$_po_pid"
  return 0
}

# 内核版本号。`-v` 每次要 fork 一次二进制，status 里每个内核槽位（liuran001/jieluojun/官方）各一次，当前内核复用其结果；
# 以「路径+size+mtime」为 key 缓存，文件没换就直接读缓存，状态刷新显著变快。
core_version() {
  # $1 core path；$2 可选：调用方已算好的缓存 key（见 core_version_v）
  core_version_v "$@"
  echo "$CVV"
}

core_version_v() {
  # 结果放进变量 CVV（不打印，调用方免 $(...)）。
  # $1 core path；$2 可选：调用方已算好的缓存 key（"路径|size|mtime"），
  # 传入即省一次 stat fork（status_json 一次 stat 同时拿全部内核槽位的 key）
  CVV=""
  [ -x "$1" ] || return 0
  if [ -n "$2" ]; then
    _cv_k=$2
  elif command -v stat >/dev/null 2>&1; then
    _cv_k=$(stat -c '%n|%s|%Y' "$1" 2>/dev/null)
  elif have_busybox; then
    _cv_k=$("$BUSYBOX" stat -c '%n|%s|%Y' "$1" 2>/dev/null)
  else
    _cv_k="$1|$(ls -l "$1" 2>/dev/null | awk '{print $5}')"
  fi
  [ -n "$_cv_k" ] || _cv_k="$1"
  # 拉长后的版本串（含 with_ebpf）不能复用旧 cut -c1-120 的缓存，否则面板仍显示 "with_gvisor,"
  _cv_k="${_cv_k}|v2"
  if [ -f "$VERCACHE" ]; then
    _cv_tab=$(printf '\t')
    while IFS="$_cv_tab" read -r _cv_ck _cv_cv; do
      if [ "$_cv_ck" = "$_cv_k" ]; then CVV=$_cv_cv; return 0; fi
    done < "$VERCACHE"
  fi
  # -v 两行拼一行后是 "… Use tags: with_gvisor, with_ebpf"。旧上限 120 正好切在
  # with_gvisor, 后面，面板看起来像多了个逗号。放宽并去掉截断残留的逗号。
  _cv_v=$("$1" -v 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g;s/^[[:space:]]*//;s/[[:space:]]*$//')
  _cv_v=$(printf '%s' "$_cv_v" | cut -c1-240)
  case "$_cv_v" in
    *',') _cv_v=${_cv_v%,} ;;
  esac
  if [ -n "$_cv_v" ]; then
    printf '%s\t%s\n' "$_cv_k" "$_cv_v" >> "$VERCACHE" 2>/dev/null
    # 只保留最近若干条，避免缓存文件无限增长
    [ "$(wc -l < "$VERCACHE" 2>/dev/null || echo 0)" -gt 12 ] &&
      tail -8 "$VERCACHE" > "$VERCACHE.tmp" 2>/dev/null && mv "$VERCACHE.tmp" "$VERCACHE" 2>/dev/null
  fi
  CVV=$_cv_v
}

# ---------------- 下载（镜像加速 + 进度上报） ----------------

DL_STATUS=$RUNDIR/download.status
DL_LOG=$RUNDIR/download.log
DL_PID=$RUNDIR/dl.pid
DL_FETCH_PID=$RUNDIR/dl.fetch.pid   # 当前下载器子进程（curl/wget）pid，供取消时精确杀掉
GEO_STATUS=$RUNDIR/geo.status
GEO_LOG=$RUNDIR/geo_download.log
GEO_PID=$RUNDIR/geo.pid
GEO_FETCH_PID=$RUNDIR/geo.fetch.pid
US_PID=$RUNDIR/us.pid
US_STATUS=$RUNDIR/update_subs.status
US_LOG=$RUNDIR/update_subs.log

# ---- 服务/任务启动前的日志复位 ----
# 约定：日志与所属服务同生命周期——服务重启即整份覆盖，不跨重启累积历史。
# 用 : > 截断而不是 rm：httpd / 后台下载这类进程可能仍握着上一个实例留下的 fd，
# rm 会让后续写入落进已 unlink 的孤儿 inode（界面上看是「日志不再更新」），
# 截断则新内容继续写进同一个 inode。先 mkdir + touch 兜住文件不存在的情况，
# 免得上层带 2>/dev/null 时把「创建失败」一起吞掉。
reset_log() {
  _rl_f=${1:-}
  [ -n "$_rl_f" ] && [ "$_rl_f" != "/dev/null" ] || return 0
  case "$_rl_f" in */*) mkdir -p "${_rl_f%/*}" 2>/dev/null ;; esac
  : > "$_rl_f" 2>/dev/null || { touch "$_rl_f" 2>/dev/null; : > "$_rl_f" 2>/dev/null; }
  return 0
}

# ---- 镜像定义 ----
# 候选行格式：`名称 前缀`，前缀为空写作 `-`（表示直连）。
# 用空格分隔而非 `|`：曾因部分 /system/bin/sh 对 ${var#*|} 处理异常，
# 前缀没被剥离，拼出 `ghfast.top|https://ghfast.top/https://...`，
# curl 报 (3) "Port number was not a decimal number" —— 所有镜像连带直连全部失败。
# 名称中不含空格，故可直接按词读取。
# v6.gh-proxy 殿后：实测它只做文件下载加速，对 github.com 网页一律回
# 「403 Web page content is not allowed」——resolve_direct 抓 expanded_assets
# 页面（网页）会被拒，排前面每次内核版本解析都先白吃一个 403。
# ghfast.top 打头：网页与文件都代理（2026-10 实测 releases 页 302→200）。
MIRROR_ALL='ghfast.top https://ghfast.top/
gh-proxy.com https://gh-proxy.com/
ghproxy.net https://ghproxy.net/
moeyy https://github.moeyy.xyz/
v6.gh-proxy https://v6.gh-proxy.org/'

# 输出候选：显式指定某镜像时，该镜像优先、随后直连、再其余镜像；
# 自动优选时，镜像按推荐序（ghfast.top 为首选：网页与文件都代理），直连殿后只作保底。
# 单条链路不通时自动回退下一个，不会拖垮整次下载。
mirror_candidates() {
  _mc_key=$(get_setting mirror direct)
  case "$_mc_key" in
    direct|auto|custom|v6proxy|ghfast|ghproxy|ghcom|moeyy) : ;;
    *) _mc_key="auto" ;;   # 未知值按自动优选处理
  esac
  case "$_mc_key" in
    direct) echo "直连GitHub -"; return 0 ;;
    auto)
      # 镜像按推荐序打头，直连殿后只作保底。
      # 直连在国内通常最慢，若放第一则每次都"优选"成直连（旧 bug）。
      printf '%s\n' "$MIRROR_ALL" | while read -r _mc_n _mc_u; do
        [ -n "$_mc_n" ] || continue
        echo "$_mc_n $_mc_u"
      done
      echo "直连GitHub -"
      return 0 ;;
    custom)
      _mc_p=$(get_setting mirror_custom "")
      case "$_mc_p" in
        http://*|https://*)
          echo "自定义镜像 $_mc_p"; echo "直连GitHub -"
          printf '%s\n' "$MIRROR_ALL" | while read -r _mc_n _mc_u; do
            [ "$_mc_n" = custom ] && continue
            echo "$_mc_n $_mc_u"
          done
          return 0 ;;
      esac ;;
  esac
  # 显式指定的镜像排第一
  case "$_mc_key" in
    v6proxy) echo "v6.gh-proxy https://v6.gh-proxy.org/" ;;
    ghfast)  echo "ghfast.top https://ghfast.top/" ;;
    ghproxy) echo "ghproxy.net https://ghproxy.net/" ;;
    ghcom)   echo "gh-proxy.com https://gh-proxy.com/" ;;
    moeyy)   echo "moeyy https://github.moeyy.xyz/" ;;
    *) [ "$_mc_key" = auto ] || _mc_key="" ;;
  esac
  # 其余镜像（跳过已输出的那个），用 - 占位避免空行。直连殿后：选定镜像一旦失效，
  # 先试其余镜像、再试直连——直连在国内通常不通，排第二会让「下载开始前」白等它一轮。
  printf '%s\n' "$MIRROR_ALL" | while read -r _mc_n _mc_u; do
    [ -n "$_mc_n" ] || continue
    case "$_mc_key$_mc_n" in
      v6proxyv6.gh-proxy|ghfastghfast.top|ghproxyghproxy.net|ghcomgh-proxy.com|moeyymoeyy) continue ;;
    esac
    echo "$_mc_n $_mc_u"
  done
  echo "直连GitHub -"
}

# 从候选行取出 URL 前缀；非法格式返回 1（调用方跳过该候选）
cand_prefix() {
  # $1 = "名称 前缀"
  _cp_p=""
  case "$1" in
    *" "*) _cp_p=${1##* } ;;
    *) _cp_p="-" ;;
  esac
  [ "$_cp_p" = "-" ] && { echo ""; return 0; }
  case "$_cp_p" in
    http://*|https://*) echo "$_cp_p"; return 0 ;;
  esac
  return 1
}

is_github_url() {
  case "$1" in
    https://github.com/*|https://raw.githubusercontent.com/*|http://github.com/*|https://api.github.com/*) return 0 ;;
    *) return 1 ;;
  esac
}

# 带镜像回退的文本抓取（API / 网页等小文本）。
# 按镜像候选依次尝试，且总以直连兜底：裸连 api.github.com 不受镜像保护，
# 还会撞未认证 60 次/小时的限流。
# 候选列表用 fd 3 读取：循环体内任何命令都不会误吞后续候选行。
fetch_text() {
  _ft_url="$1"; _ft_out="$2"
  rm -f "$_ft_out"
  _ft_list="$RUNDIR/_cands.txt"
  if is_github_url "$_ft_url"; then
    mirror_candidates > "$_ft_list" 2>/dev/null
  else
    echo "直连GitHub -" > "$_ft_list"
  fi
  # 兜底：确保最后一定试一次直连（直连不跳，仅作保底）
  grep -q "直连GitHub" "$_ft_list" 2>/dev/null || echo "直连GitHub -" >> "$_ft_list"
  _ft_ok=0
  while read -r _ft_entry <&3; do
    [ -n "$_ft_entry" ] || continue
    _ft_prefix=$(cand_prefix "$_ft_entry") || {
      echo "跳过非法候选 [$_ft_entry]" >> "$DL_LOG"; continue; }
    rm -f "$_ft_out"
    if fetch "${_ft_prefix}${_ft_url}" "$_ft_out" && [ -s "$_ft_out" ]; then
      echo "抓取成功 [$_ft_entry] ${_ft_prefix}${_ft_url}" >> "$DL_LOG"
      _ft_ok=1
      break
    fi
    echo "抓取失败 [$_ft_entry] 完整URL=${_ft_prefix}${_ft_url}" >> "$DL_LOG"
  done 3< "$_ft_list"
  rm -f "$_ft_list"
  [ "$_ft_ok" = "1" ] && return 0
  rm -f "$_ft_out"
  return 1
}

# 单次抓取到 stdout（fetch 的无文件版，仅输出正文，日志走 DL_LOG/stderr）
fetch_one_stdout() {
  _fo_url="$1"
  case "$_fo_url" in
    http://*|https://*) : ;;
    *) echo "拒绝非法 URL: [$_fo_url]" >> "${DL_LOG:-/dev/null}"; return 1 ;;
  esac
  detect_http || { http_missing_msg >&2; return 1; }
  # 元数据抓取（releases/latest 页 / assets 页），内容极小、必须快：
  # 之前 connect-timeout 20 + max-time 600 + retry 2，选中的镜像一旦不通，
  # 单候选干等 20s×3，再叠加 6 个候选，「点下载 → 界面开始动 / 显示已是最新」
  # 之前要白白挨几十秒。收紧到连不通就快速换下一个候选。
  case "$HTTP_CLIENT" in
    curl)    curl -fsSL --connect-timeout 5 --max-time 12 --retry 1 -A "mihomo-ksu" "$_fo_url" ;;
    wget)    wget -q --timeout=8 -O- "$_fo_url" ;;
    toybox)  toybox wget -q --timeout=8 -O- "$_fo_url" ;;
    busybox) "$BUSYBOX" wget -q --timeout=8 -O- "$_fo_url" ;;
  esac
}

# 流式抓取+解析（无文件、无 heredoc、无大变量传参）：
# 对候选逐个抓取，抓取输出经管道直连解析函数，只捕获解析结果（tag/路径，均 <200 字节）。
# 注意：页面正文本身绝不能作为命令参数传递（mksh 的 printf 系外部命令，
# 27 万字节页面会触发 Argument list too long）——必须全程走管道。
fetch_parse() {
  # $1=url $2=解析函数名 $3/$4=解析函数参数
  _fp_url="$1"; _fp_parser="$2"; _fp_a1="$3"; _fp_a2="$4"
  detect_http || { echo "无可用 HTTP 客户端，无法下载" >> "$DL_LOG"; return 1; }
  if is_github_url "$_fp_url"; then
    _fp_entries=$(mirror_candidates 2>/dev/null)
  else
    _fp_entries="直连GitHub -"
  fi
  # 兜底：确保最后一定试一次直连（直连不跳，仅作保底）
  case "$_fp_entries" in
    *"直连GitHub"*) : ;;
    *) _fp_entries="$_fp_entries
直连GitHub -" ;;
  esac
  _fp_ifs=$IFS; IFS='
'
  case $- in *f*) _fp_noglob=1 ;; *) _fp_noglob=0; set -f ;; esac
  _fp_ok=0; _fp_out=""
  for _fp_entry in $_fp_entries; do
    [ -n "$_fp_entry" ] || continue
    _fp_prefix=$(cand_prefix "$_fp_entry") || {
      echo "跳过非法候选 [$_fp_entry]" >> "$DL_LOG"; continue; }
    _fp_out=$(fetch_one_stdout "${_fp_prefix}${_fp_url}" | "$_fp_parser" "$_fp_a1" "$_fp_a2") && [ -n "$_fp_out" ] && { _fp_ok=1; break; }
    echo "抓取/解析失败 [$_fp_entry] 完整URL=${_fp_prefix}${_fp_url}" >> "$DL_LOG"
  done
  [ "$_fp_noglob" = "1" ] || set +f; IFS=$_fp_ifs
  [ "$_fp_ok" = "1" ] || return 1
  printf '%s' "$_fp_out"
  return 0
}

# stdin: /releases/latest 页 → stdout: tag（如 v1.19.30）；$1=repo
parse_release_tag() {
  tr '>' '\n' | grep -o "/$1/releases/tag/[^\"']*" | sed "s|.*/tag/||" | grep -E '^v[0-9]' | head -1
}

# stdin: expanded_assets 页 → stdout: 首个匹配的下载路径；$1=「repo/releases/download/<滚动 tag>」前缀 $2=架构 token
parse_alpha_asset() {
  tr '"' '\n' | grep -o "/$1/[^'\"]*\.gz" | grep -E "$2-alpha" | grep -v "go1" | head -1
}

# 远程文件大小（尽力而为，取不到返回 0，仅影响进度百分比）
download_size() {
  command -v curl >/dev/null 2>&1 || { echo 0; return 0; }
  _ds_hdrs=$(curl -fsSIL --connect-timeout 15 --max-time 40 -A "mihomo-ksu" "$1" 2>/dev/null)
  # HEAD 失败时(-f 非 0 退出)错误页头仍会输出：必须判退出码，否则错误页的 Content-Length 会污染总量
  if [ $? -eq 0 ]; then
    _ds_cl=$(printf '%s\n' "$_ds_hdrs" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength:[[:space:]]*//p' | tail -1)
  else _ds_cl=0; fi
  case "$_ds_cl" in ''|*[!0-9]*) _ds_cl=0 ;; esac
  echo "$_ds_cl"
}

# 总量探测：按镜像候选序逐个 HEAD，首个有效 Content-Length 即用。
# 逐个候选探测：直连不通（如关总开关后裸连）时仍能拿到 total，
# 否则百分比永远 0%，进度条一格不长。
# 这里只求「尽快拿到一个体积」：最多试 3 个候选、单候选超时 5s 封顶。
# 拿不到就回 0（界面改不确定态动画兜底），绝不为此把下载启动拖慢：
# 之前逐个试完全部 6 个候选、每候选最坏 8s，全灭要干等近 50s 才开始下。
probe_size() {
  _pz_url=$1
  command -v curl >/dev/null 2>&1 || { echo 0; return 0; }
  if ! is_github_url "$_pz_url"; then download_size "$_pz_url"; return 0; fi
  _pz_list=$RUNDIR/_cands_sz.txt
  mirror_candidates > "$_pz_list" 2>/dev/null
  grep -q "直连GitHub" "$_pz_list" 2>/dev/null || echo "直连GitHub -" >> "$_pz_list"
  _pz_sz=0; _pz_n=0
  while read -r _pz_entry <&3; do
    [ -n "$_pz_entry" ] || continue
    _pz_n=$((_pz_n + 1))
    [ "$_pz_n" -gt 3 ] && break
    _pz_prefix=$(cand_prefix "$_pz_entry") || continue
    _pz_hdrs=$(curl -fsSIL --connect-timeout 3 --max-time 5 -A "mihomo-ksu" "${_pz_prefix}${_pz_url}" 2>/dev/null)
    # HEAD 失败时(-f 非 0 退出)错误页头仍会输出：必须判退出码，否则错误页的 Content-Length 会污染总量
    if [ $? -eq 0 ]; then
      _pz_sz=$(printf '%s\n' "$_pz_hdrs" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength:[[:space:]]*//p' | tail -1)
    else _pz_sz=0; fi
    case "$_pz_sz" in ''|*[!0-9]*) _pz_sz=0 ;; esac
    if [ "$_pz_sz" -gt 0 ] 2>/dev/null; then break; fi
  done 3< "$_pz_list"
  rm -f "$_pz_list"
  echo "$_pz_sz"
}

# ---- 进度上报 ----
dl_emit() {
  # dl_emit <stage> <percent> <loaded> <total> <mirror> <err>
  printf '{"stage":"%s","percent":%s,"loaded":%s,"total":%s,"mirror":"%s","err":"%s"}\n' \
    "$(json_str "$1")" "$(json_num "$2")" "$(json_num "$3")" "$(json_num "$4")" "$(json_str "$5")" "$(json_str "$6")" > "$DL_STATUS.tmp" 2>/dev/null
  mv "$DL_STATUS.tmp" "$DL_STATUS" 2>/dev/null
}

dl_pid_of() { cat $DL_PID 2>/dev/null; }
geo_emit() {
  # geo_emit <stage> <percent> <loaded> <total> <label> <err>（total 恒 0：按文件数折算 percent；label 复用 mirror 键）
  printf '{"stage":"%s","percent":%s,"loaded":%s,"total":%s,"mirror":"%s","err":"%s"}\n' \
    "$(json_str "$1")" "$(json_num "$2")" "$(json_num "$3")" "$(json_num "$4")" "$(json_str "$5")" "$(json_str "$6")" > "$GEO_STATUS.tmp" 2>/dev/null
  mv "$GEO_STATUS.tmp" "$GEO_STATUS" 2>/dev/null
}
geo_pid_of() { cat $GEO_PID 2>/dev/null; }

# 限时执行：$1=秒数，其余为命令。超时返回 124。
# 内核 `-t` 校验偶发卡在网络初始化，卡住会让上层一直等下去，必须兜住。
run_timeout() {
  _rt_s=${1:-60}; shift
  "$@" & _rt_p=$!
  # 按真实时钟（/proc/uptime）判定截止，不再按「300 次 × 0.1s」推算：
  # nap 在只支持整数 sleep 的精简 busybox 上每轮实际为 0s（空转）或 1s（取整），
  # 按次数推算会把 30s 超时跑成 0.3s（秒杀进程）或 300s（干等十倍）。
  if now_cs; then
    _rt_dl=$((NOW_CS + _rt_s * 100))
    while kill -0 "$_rt_p" 2>/dev/null; do
      now_cs
      [ "$NOW_CS" -ge "$_rt_dl" ] && break
      nap 0.1
    done
  else
    # 极端环境无时钟：退回按整秒睡的保守等待
    _rt_i=0
    while [ "$_rt_i" -lt "$_rt_s" ] && kill -0 "$_rt_p" 2>/dev/null; do
      sleep 1
      _rt_i=$((_rt_i + 1))
    done
  fi
  if kill -0 "$_rt_p" 2>/dev/null; then
    kill -9 "$_rt_p" 2>/dev/null
    wait "$_rt_p" 2>/dev/null
    echo "（校验超时 ${_rt_s}s，已中止）"
    return 124
  fi
  wait "$_rt_p"
  return $?
}

# 对「当前选定的内核」校验配置；通过则写入指纹缓存，失败输出错误原因。
# 切换内核时先跑这一步：能在停掉正在跑的内核之前就发现不兼容，
# 避免「停了 → 起不来 → 干等一轮启动超时」这种最耗时的失败路径。
#
# mihomo -t 是整条启停链上唯一的重活（大配置 + 远程 provider 1~3 秒起步），
# 所以这里照 Mishka 启动链的思路给它加了三道闸，绝不让同一个成本重复支付：
#   1) 成功缓存：指纹命中 tested.fp → 秒过（原有逻辑）；
#   2) 失败缓存：同一份配置刚校验失败过 → 直接回放错误，不再白跑（原来每次重试
#      都要重付一遍 -t，开机保障那边最多要重试 4 轮 = 4 次完整校验）；
#   3) 并发合并（single-flight）：同一指纹已有校验在跑时（面板保存后立刻重载、
#      后台预热、开机重试撞在一起），后来者等结论而不重复跑第二遍。
# 真正的预热入口见 verify-prewarm（配置落盘后在后台跑，把 -t 挪出关键路径）。
verify_fail_cached() {
  # $1=指纹；命中失败缓存则回放原因并返回 0
  _vfc_fp=""
  [ -r "$VERIFY_FAIL" ] && IFS= read -r _vfc_fp < "$VERIFY_FAIL" 2>/dev/null
  [ -n "$_vfc_fp" ] && [ "$_vfc_fp" = "$1" ] || return 1
  echo "ERR_CONFIG: 配置校验失败（该内核无法使用当前配置；结果来自最近一次校验）:"
  sed -n '2,6p' "$VERIFY_FAIL" 2>/dev/null
  return 0
}

# 等同一指纹的在跑校验结束（最多约 30s）。0=等到了结论（看 tested.fp / verify.fail），
# 1=没人可等或持锁者已死（调用方自己跑）。
verify_join() {
  _vj_fp=$1
  [ -r "$VERIFY_PENDING" ] || return 1
  _vj_seen=0; _vj_rounds=0
  while :; do
    _vj_f=""; _vj_pid=""
    if [ -r "$VERIFY_PENDING" ]; then
      IFS=' ' read -r _vj_f _vj_pid _ 2>/dev/null < "$VERIFY_PENDING"
    fi
    [ -n "$_vj_f" ] || break                 # 文件已清：校验跑完了
    [ "$_vj_f" = "$_vj_fp" ] || return 1     # 别人在验别的配置：自己跑
    pid_is_live "$_vj_pid" || break          # 持有者已死：残留文件，自己跑
    _vj_seen=1
    _vj_rounds=$((_vj_rounds + 1))
    [ "$_vj_rounds" -ge 600 ] && break       # 兜底上限（0.05s × 600 ≈ 30s）
    nap 0.05
  done
  [ "$_vj_seen" = "1" ] || return 1
  return 0
}

verify_config() {
  _vc_core=$(core_path)
  if [ ! -x "$_vc_core" ]; then
    echo "ERR: 内核文件不存在: $_vc_core"
    return 1
  fi
  _vc_fp=$(config_fingerprint)
  _vc_waited=0
  _vc_claimed=0
  while :; do
    if [ "$_vc_fp" = "$(cat "$TESTED" 2>/dev/null)" ]; then
      echo "配置未变更，跳过校验"
      return 0
    fi
    if verify_fail_cached "$_vc_fp"; then return 1; fi
    # 原子抢占「正在校验」标记：`set -C`（noclobber）让「确认不存在 + 创建」变成
    # 一次 O_EXCL 打开。保存后的后台预热与紧随其后的重载/重启几乎同时进来，
    # 若两边都只看到「还没人校验」就各跑一遍 mihomo -t，两份 -t 抢 CPU，
    # 实测比单独跑一遍更慢 —— 单飞（single-flight）必须真的只有一份。
    if ( set -C; printf '%s %s\n' "$_vc_fp" "$$" > "$VERIFY_PENDING" ) 2>/dev/null; then
      _vc_claimed=1
      break
    fi
    [ "$_vc_waited" = "1" ] && break         # 合并过一次仍无结论：自己跑
    _vc_waited=1
    verify_join "$_vc_fp" || break           # 等持有者的结论；持有者已死则自己跑
  done
  # 没抢到标记（残留文件 / 等不到结论）也要把自己的 pid 写上，让后来者能 join 我们。
  [ "$_vc_claimed" = "1" ] || printf '%s %s\n' "$_vc_fp" "$$" > "$VERIFY_PENDING" 2>/dev/null
  if ! run_timeout "${MH_VERIFY_TIMEOUT:-30}" "$_vc_core" -t -d "$WORKDIR" -f "$CONFIG" > "$RUNDIR/test.log" 2>&1; then
    rm -f "$VERIFY_PENDING" 2>/dev/null
    { printf '%s\n' "$_vc_fp"; tail -6 "$RUNDIR/test.log" 2>/dev/null; } > "$VERIFY_FAIL" 2>/dev/null
    echo "ERR_CONFIG: 配置校验失败（该内核无法使用当前配置）:"
    tail -5 "$RUNDIR/test.log" 2>/dev/null
    return 1
  fi
  rm -f "$VERIFY_PENDING" "$VERIFY_FAIL" 2>/dev/null
  echo "$_vc_fp" > "$TESTED"
  echo "配置校验通过"
  return 0
}

# 预热：配置一落盘就在后台把 mihomo -t 跑掉，用户随后点「重载/启动」时命中缓存。
# 不取生命周期锁——它不启停任何进程，只是算一个缓存；占着锁反而会让紧随其后的
# 重载命令撞 ERR_BUSY。并发由 verify_join 的 single-flight 保证只跑一份。
verify_prewarm() {
  mkdir -p "$RUNDIR" 2>/dev/null
  [ -x "$(core_path)" ] || return 0
  verify_config >/dev/null 2>&1
  return 0
}

# 后台预热（脱离调用方会话，不阻塞返回）
verify_prewarm_async() {
  [ "${MH_NO_PREWARM:-0}" = "1" ] && return 0
  if command -v setsid >/dev/null 2>&1; then
    setsid sh "$0" verify-prewarm </dev/null >/dev/null 2>&1 &
  else
    nohup sh "$0" verify-prewarm </dev/null >/dev/null 2>&1 &
  fi
  return 0
}

# 是否已存在可用的 HTTP 客户端（统一使用系统自带工具，模块不内置下载器）
# 注意：toybox / busybox 本体存在 ≠ 内含 wget applet，必须实际确认，
# 否则会出现「检测通过、实际全挂」，还报出误导性的「无 HTTP 客户端」。
HTTP_CLIENT=""
applet_has() {
  # $1=工具名或绝对路径(toybox/busybox/$BUSYBOX) $2=applet 名
  case "$1" in
    /*) [ -x "$1" ] || return 1 ;;
    *)  command -v "$1" >/dev/null 2>&1 || return 1 ;;
  esac
  "$1" 2>/dev/null | grep -qw "$2" && return 0
  "$1" --list 2>/dev/null | grep -qx "$2" && return 0
  return 1
}
# ---------------------------------------------------------------
# HTTP 客户端：以「真的能跑」为准，而不是「文件存在」
#
# 坑：/system/bin/wget 在不少 ROM 上是指向 toybox 的软链接，而那份 toybox
# 未必编译了 wget applet —— `command -v wget` 照样找得到，一执行却只吐
#   toybox: Unknown command wget
# 然后返回非零、输出为空。旧代码把「找得到」当成「能用」，一命中就 return，
# 后面真正可用的 busybox wget 永远轮不到；内核明明在跑，/proxies 与
# /providers/proxies 却双双拿不到内容，前端只能退回配置预览 ——
# 表现就是「代理页加载不出代理组、节点类型全未知」，而管理器里同一次调用
# 却可能是好的（那边常常因为 curl 存在而走了另一条分支）。
#
# 所以：候选按可靠度排队，逐个实测，第一个真跑通的胜出并缓存。
# ---------------------------------------------------------------

# 能不能跑：执行一次 --version，输出里出现「没这个命令」的口吻即判不可用。
# 不看 $? —— 管道后面拿到的是 head 的退出码；而且 toybox 有 wget 时
# 跑 --version 也会返回非零（打印 usage），那不属于不可用。
_http_client_usable() {
  _pu_cmd=$1
  _pu_out=$($_pu_cmd --version 2>&1 | head -1)
  case "$_pu_out" in
    *"Unknown command"*|*"not found"*|*"No such"*|*"not recognized"*) return 1 ;;
  esac
  return 0
}

# 独立的 wget 是否真能执行：多调用软链接要连本体一起验
_wget_usable() {
  _wu_bin=$(command -v "$1" 2>/dev/null) || return 1
  [ -n "$_wu_bin" ] || return 1
  _wu_real=$(readlink -f "$_wu_bin" 2>/dev/null)
  case "$_wu_real" in
    *toybox*)  applet_has toybox wget      && return 0; return 1 ;;
    *busybox*) applet_has "$_wu_real" wget && return 0; return 1 ;;
  esac
  _http_client_usable "$1"
}

# 候选列表：每行一个「命令前缀」，可直接 `_hc -q ... ` 调用
_http_client_list() {
  command -v curl >/dev/null 2>&1 && echo curl
  # busybox 排在 toybox 前：Root 环境自带的那份 wget 选项最全，
  # toybox 的 wget 在部分 ROM 上连 --header 都不支持
  if have_busybox && applet_has "$BUSYBOX" wget; then echo "$BUSYBOX wget"; fi
  for _hb in /data/adb/ksu/bin/busybox /data/adb/magisk/busybox /data/adb/ap/bin/busybox \
             /data/adb/modules/busybox-ndk/system/xbin/busybox; do
    [ -x "$_hb" ] || continue
    [ "$_hb" = "$BUSYBOX" ] && continue
    applet_has "$_hb" wget && echo "$_hb wget"
  done
  applet_has toybox wget && echo "toybox wget"
  _wget_usable wget && echo wget
}

# 挑一个可用客户端并缓存到 $RUNDIR/api.httpclient；echo 出「命令前缀」。
# 命中缓存时只做 command -v（内建，不 fork），所以每次 api 调用都能安全经过这里。
_http_client_pick() {
  _hcf=$RUNDIR/api.httpclient
  if [ -s "$_hcf" ]; then
    read -r _c < "$_hcf" 2>/dev/null
    if [ -n "$_c" ]; then
      _hcb=${_c%% *}
      case "$_hcb" in
        /*) [ -x "$_hcb" ] && { echo "$_c"; return 0; } ;;
        *)  command -v "$_hcb" >/dev/null 2>&1 && { echo "$_c"; return 0; } ;;
      esac
    fi
  fi
  # 候选只有数行，保存在当前 shell 中；执行中断也不会遗留 api.clients.<pid>。
  _hcl=$(_http_client_list 2>/dev/null)
  mkdir -p "$RUNDIR" 2>/dev/null
  while IFS= read -r _c; do
    [ -n "$_c" ] || continue
    if _http_client_usable "$_c"; then
      printf '%s\n' "$_c" > "$_hcf" 2>/dev/null
      echo "$_c"
      return 0
    fi
  done <<MH_HTTP_CLIENT_CANDIDATES
$_hcl
MH_HTTP_CLIENT_CANDIDATES
  return 1
}

# 真正的 GET。$1=客户端前缀 $2=url $3=header $4=超时秒
# toybox 的 wget 不认 --timeout（只认 -T），GNU/busybox 两者都认，分开写。
_http_do_get() {
  case "$1" in
    curl)        curl -sS --max-time "$4" -H "$3" "$2" ;;
    toybox\ wget) toybox wget -q -T "$4" --header="$3" -O - "$2" ;;
    *)           $1 -q --timeout="$4" --header="$3" -O - "$2" ;;
  esac
}

# ---------------------------------------------------------------
# 写请求兜底：没有 curl 时用 nc 手写一个最小 HTTP/1.1 请求
#
# 为什么需要：切换节点（PUT /proxies/{name}）、切模式（PATCH /configs）、
# 断开连接（DELETE /connections）这些「带 body 或非 GET 方法」的调用，
# 只有 curl 支持 —— 不少 ROM 根本没有 curl，而 wget/busybox wget 只会发
# GET/POST，不能用它们发 PUT/PATCH/DELETE。结果就是这类设备上
# 「代理列表读得到、一点切换就失败」，很容易被误判成面板的 bug。
# nc 在 toybox / busybox 里基本都有，手写请求行 + 头即可；这些接口成功时
# 返回 204，无需解析响应体，只要看状态行是不是 2xx。
# ---------------------------------------------------------------
_nc_bin() {
  if have_busybox && applet_has "$BUSYBOX" nc; then echo "$BUSYBOX nc"; return 0; fi
  for _nb in /data/adb/ksu/bin/busybox /data/adb/magisk/busybox /data/adb/ap/bin/busybox; do
    [ -x "$_nb" ] && applet_has "$_nb" nc && { echo "$_nb nc"; return 0; }
  done
  if applet_has toybox nc; then echo "toybox nc"; return 0; fi
  if command -v nc >/dev/null 2>&1; then
    # 同样的坑：nc 也可能是缺 applet 的软链接
    _nb_real=$(readlink -f "$(command -v nc 2>/dev/null)" 2>/dev/null)
    case "$_nb_real" in
      *toybox*)  applet_has toybox nc      && { echo nc; return 0; }; return 1 ;;
      *busybox*) applet_has "$_nb_real" nc && { echo nc; return 0; }; return 1 ;;
    esac
    echo nc; return 0
  fi
  return 1
}

# $1=方法 $2=路径 $3=body $4=超时秒；成功返回 0，失败把状态行打到 stderr
_api_nc() {
  _an_nb=$(_nc_bin) || return 1
  _an_host=${API_HOST%:*}; _an_port=${API_HOST##*:}
  case "$_an_port" in ''|*[!0-9]*) return 1 ;; esac
  _an_len=0
  # 字节数而非字符数：节点名常带中文，UTF-8 下一个字 3 字节
  [ -n "$3" ] && _an_len=$(printf '%s' "$3" | wc -c | tr -d ' ')
  _an_out=$(
    {
      printf '%s %s HTTP/1.1\r\n' "$1" "$2"
      printf 'Host: %s\r\n' "$API_HOST"
      [ -n "$API_SEC" ] && printf 'Authorization: Bearer %s\r\n' "$API_SEC"
      [ -n "$3" ] && printf 'Content-Type: application/json\r\n'
      printf 'Content-Length: %s\r\n' "$_an_len"
      printf 'Connection: close\r\n\r\n'
      [ -n "$3" ] && printf '%s' "$3"
    } | if command -v timeout >/dev/null 2>&1; then
          # 双重保险：timeout 从外部兜住，nc 自己的 -w 负责正常退出
          timeout $(($4 + 2)) $_an_nb -w "$4" "$_an_host" "$_an_port"
        else
          $_an_nb -w "$4" "$_an_host" "$_an_port"
        fi 2>/dev/null
  )
  case "$_an_out" in
    HTTP/*) : ;;
    *) return 1 ;;          # 连状态行都没有：nc 不可用或被拒
  esac
  # 只判定第一行状态码，错误响应正文中的 " 200" 不能误报成功。
  _an_status=$(printf '%s\n' "$_an_out" | head -1 | tr -d '\r')
  case "$_an_status" in
    HTTP/*" 2"[0-9][0-9]" "*|HTTP/*" 2"[0-9][0-9]) return 0 ;;
    *) printf '%s\n' "$_an_out" | head -1 >&2; return 1 ;;
  esac
}

detect_http() {
  [ -n "$HTTP_CLIENT" ] && return 0
  if command -v curl >/dev/null 2>&1; then HTTP_CLIENT=curl; return 0; fi
  if have_busybox && applet_has "$BUSYBOX" wget; then HTTP_CLIENT=busybox; return 0; fi
  if applet_has toybox wget;  then HTTP_CLIENT=toybox; return 0; fi
  # 裸 wget 放最后且必须验过：它常常是缺 applet 的 toybox 软链接
  if _wget_usable wget; then HTTP_CLIENT=wget; return 0; fi
  HTTP_CLIENT=""
  return 1
}
have_http() { detect_http; }
http_missing_msg() {
  echo "ERR: 当前系统无可用 HTTP 客户端（curl / wget / toybox wget / $BUSYBOX wget）。" \
       "模块不内置下载器，请安装 Busybox（Magisk 自带的 busybox 会被自动识别）后重试。"
}

# 简单直取（API / 网页等小文本）
# 变量一律加 _f 前缀：POSIX sh 的函数与调用方共用变量作用域，
# 用 url/out 这类通用名会覆盖 fetch_text 的同名变量，
# 导致第二轮起拼出 "直连|v6.gh-proxy|https://..." 这类畸形 URL。
fetch() {
  _f_url="$1"; _f_out="$2"
  rm -f "$_f_out"
  # 最后一道防线：URL 必须是干净的 http(s)。
  # 曾因前缀未被剥离而传入 `name|https://...`，curl 报 (3) 端口非法，
  # 且会伪装成「所有镜像+直连全部不通」，极难排查。宁可跳过并留痕。
  case "$_f_url" in
    http://*|https://*) : ;;
    *) echo "拒绝非法 URL: [$_f_url]" >> "${DL_LOG:-/dev/null}"; return 1 ;;
  esac
  detect_http || { http_missing_msg >&2; return 1; }
  case "$HTTP_CLIENT" in
    curl)    curl -fsSL --connect-timeout 20 --max-time 600 --retry 2 -A "mihomo-ksu" -o "$_f_out" "$_f_url" && [ -s "$_f_out" ] && return 0 ;;
    wget)    wget -q --timeout=40 -O "$_f_out" "$_f_url" && [ -s "$_f_out" ] && return 0 ;;
    toybox)  toybox wget -q --timeout=40 -O "$_f_out" "$_f_url" && [ -s "$_f_out" ] && return 0 ;;
    busybox) "$BUSYBOX" wget -q --timeout=40 -O "$_f_out" "$_f_url" && [ -s "$_f_out" ] && return 0 ;;
  esac
  rm -f "$_f_out"
  return 1
}

# 在当前进程内启动后台下载（避免命令替换导致 wait 失效）
FETCH_PID=""
start_fetcher() {
  # $1 url $2 out → 设置 FETCH_PID
  detect_http
  # connect-timeout 收紧、去掉 retry：镜像回退循环本身就是重试机制，坏候选要
  # 快速跳过去试下一个——一个挂掉的镜像再 retry 一次等于白等双倍时间，
  # 「点下载 → 真正开始动」之前干等几十秒多半就是它。max-time 保持宽松，
  # 内核/Geo 大数据文件在慢网下可能要下几分钟。
  case "$HTTP_CLIENT" in
    curl)    curl -fsSL --connect-timeout 8 --max-time 900 -A "mihomo-ksu" -o "$2" "$1" & ;;
    wget)    wget -q --timeout=60 -O "$2" "$1" & ;;
    toybox)  toybox wget -q --timeout=60 -O "$2" "$1" & ;;
    busybox) "$BUSYBOX" wget -q --timeout=60 -O "$2" "$1" & ;;
    *)       "$BUSYBOX" wget -q --timeout=60 -O "$2" "$1" & ;;
  esac
  FETCH_PID=$!
}

# 完整流式解压兼容检查：不假定 PATH 中的 gzip 支持 -t。
# 每个实现都必须读取完整文件并成功退出；不使用 -f、不忽略 CRC/截断错误。
# $1 gzip 文件，$2 输出文件（校验时为 /dev/null）。重试会截断输出，不拼接残片。
gzip_decode_checked() {
  _gd_src="$1"; _gd_dst="$2"
  _gd_magic=$(bytes_hex "$_gd_src" 3)
  if [ "$_gd_magic" != "1f8b08" ]; then
    echo "gzip 文件头无效（需要 1f8b08，实际 ${_gd_magic:-无法读取}）" >&2
    return 1
  fi
  _gd_available=0
  if command -v gzip >/dev/null 2>&1; then
    _gd_available=1
    if gzip -dc "$_gd_src" > "$_gd_dst"; then
      GZIP_DECODER="gzip ($(command -v gzip))"; return 0
    else _gd_rc=$?; fi
    echo "系统 gzip -dc 解压失败(rc=$_gd_rc)，尝试兼容实现" >&2
  fi
  if have_busybox; then
    _gd_available=1
    if "$BUSYBOX" gzip -dc "$_gd_src" > "$_gd_dst"; then
      GZIP_DECODER="$BUSYBOX gzip"; return 0
    else _gd_rc=$?; fi
    echo "BusyBox gzip -dc 解压失败(rc=$_gd_rc)" >&2
  fi
  if command -v gunzip >/dev/null 2>&1; then
    _gd_available=1
    if gunzip -c "$_gd_src" > "$_gd_dst"; then
      GZIP_DECODER="gunzip ($(command -v gunzip))"; return 0
    else _gd_rc=$?; fi
    echo "gunzip -c 解压失败(rc=$_gd_rc)" >&2
  fi
  [ "$_gd_available" = 1 ] || echo "没有可用的 gzip/gunzip 解压工具" >&2
  return 1
}

# 带进度与镜像回退下载: fetch_mirrored <url> <out> <total> -> 0 ok
# 变量同样加 _fm 前缀，避免与调用方（_dl_run 用 url/total/gz）互相覆盖。
fetch_mirrored() {
  _fm_url="$1"; _fm_out="$2"; _fm_total="${3:-0}"
  case "$_fm_total" in ''|*[!0-9]*) _fm_total=0 ;; esac
  # 候选列表只放变量、不落文件（取消/被杀也不残留）
  if is_github_url "$_fm_url"; then
    _fm_entries=$(mirror_candidates 2>/dev/null)
  else
    _fm_entries="直连GitHub -"
  fi
  # 兜底：确保最后一定试一次直连（直连不跳，仅作保底）
  case "$_fm_entries" in
    *"直连GitHub"*) : ;;
    *) _fm_entries="$_fm_entries
直连GitHub -" ;;
  esac
  _fm_ok=0
  echo "--- 待试镜像 ---" >> "$DL_LOG"
  printf '%s\n' "$_fm_entries" >> "$DL_LOG"
  _fm_ifs=$IFS; IFS='
'
  case $- in *f*) _fm_noglob=1 ;; *) _fm_noglob=0; set -f ;; esac
  for _fm_entry in $_fm_entries; do
    [ -n "$_fm_entry" ] || continue
    _fm_mname=${_fm_entry%% *}
    _fm_prefix=$(cand_prefix "$_fm_entry") || {
      echo "跳过非法候选 [$_fm_entry]" >> "$DL_LOG"; continue; }
    _fm_full="${_fm_prefix}${_fm_url}"
    echo "尝试 [$_fm_mname] $_fm_full" >> "$DL_LOG"
    rm -f "$_fm_out"
    start_fetcher "$_fm_full" "$_fm_out"
    _fm_p=$FETCH_PID
    echo "$_fm_p" > "$DL_FETCH_PID" 2>/dev/null   # 记下下载器 pid，供取消时精确杀掉
    # 起手立即报一次「用哪个镜像」：进度轮询要隔 800ms 才读第一次，这里先落一帧
    # 让界面上的镜像名即时出现（此前要等首轮 1 秒 sleep 过后才看得到候选名）。
    dl_emit "downloading" 0 0 "$_fm_total" "$_fm_mname" ""
    while kill -0 "$_fm_p" 2>/dev/null; do
      _fm_loaded=0
      [ -f "$_fm_out" ] && _fm_loaded=$(wc -c < "$_fm_out" 2>/dev/null || echo 0)
      case "$_fm_loaded" in *[!0-9]*) _fm_loaded=0 ;; esac
      if [ "$_fm_total" -gt 0 ] 2>/dev/null; then
        _fm_pct=$((_fm_loaded * 100 / _fm_total))
        [ "$_fm_pct" -gt 99 ] && _fm_pct=99
      else
        _fm_pct=0
      fi
      dl_emit "downloading" "$_fm_pct" "$_fm_loaded" "$_fm_total" "$_fm_mname" ""
      sleep 1
    done
    wait "$_fm_p" && _fm_rc=0 || _fm_rc=$?
    rm -f "$DL_FETCH_PID"
    _fm_loaded=0
    [ -f "$_fm_out" ] && _fm_loaded=$(wc -c < "$_fm_out" 2>/dev/null || echo 0)
    case "$_fm_loaded" in *[!0-9]*) _fm_loaded=0 ;; esac
    _fm_good=0
    if [ "${_fm_rc:-1}" = "0" ] && [ "$_fm_loaded" -gt 0 ]; then
      _fm_good=1
      # 已知大小时必须完全相等——chunked 提前断流也能 rc=0，半截文件不能放过
      if [ "$_fm_total" -gt 0 ] 2>/dev/null && [ "$_fm_loaded" -ne "$_fm_total" ]; then
        _fm_good=0; echo "[$_fm_mname] 文件不完整($_fm_loaded/$_fm_total 字节)" >> "$DL_LOG"
      else
        echo "[$_fm_mname] 下载完成($_fm_loaded 字节)，开始完整 gzip 解压校验" >> "$DL_LOG"
        if gzip_decode_checked "$_fm_out" /dev/null 2>> "$DL_LOG"; then
          echo "[$_fm_mname] gzip 校验通过：$GZIP_DECODER" >> "$DL_LOG"
        else
          _fm_good=0
          echo "[$_fm_mname] gzip 校验失败：文件损坏或解压工具不可用，具体错误见上方" >> "$DL_LOG"
        fi
      fi
    fi
    if [ "$_fm_good" = "1" ]; then _fm_ok=1; echo "[$_fm_mname] 下载成功（已校验 $_fm_loaded 字节）" >> "$DL_LOG"; break; fi
    echo "[$_fm_mname] 失败(rc=${_fm_rc:-?})" >> "$DL_LOG"
  done
  [ "$_fm_noglob" = "1" ] || set +f; IFS=$_fm_ifs
  [ "$_fm_ok" = "1" ]
}

# ---- 内核架构适配（Android / OpenWrt·Linux 双平台） ----
# 资产命名与上游 liuran001/mihomo 的 build.yml 矩阵一致（输出名 = 资产名中「平台-」之后的部分）：
#   MetaCubeX 正式版：mihomo-<token>-<tag>.gz           （token 即下面输出的值）
#   liuran001 / jieluojun 滚动版：mihomo-<token>-alpha-…（resolve_direct 用 grep "<token>-alpha" 匹配）
# 本段只负责「选出 token」，资产是否存在由 resolve_direct 拿到发布页后再确认。

# 读取 CPU 标志行（x86 的 flags、arm 的 Features 等）；测试可用 MIHOMO_CPUINFO 指向假文件。
core_cpu_flags() {
  _cf=$(sed -n 's/^\(flags\|Features\)[[:space:]]*:[[:space:]]*//p' "${MIHOMO_CPUINFO:-/proc/cpuinfo}" 2>/dev/null | head -n1)
  printf ' %s ' "$_cf"
}

# 判断 CPU 是否具备某个标志：core_cpu_has <flags串> <名称>
core_cpu_has() {
  case "$1" in *" $2 "*) return 0 ;; *) return 1 ;; esac
}

# 平台：存在 getprop 即按 Android 处理（与旧逻辑一致），否则视为 Linux（OpenWrt 等）。
core_platform() {
  if command -v getprop >/dev/null 2>&1; then echo android; else echo linux; fi
}

# 字节序：读 /bin/sh 的 ELF 头 EI_DATA（偏移 5：1=小端 2=大端）；读不到则看 /etc/openwrt_release 的 DISTRIB_ARCH。
core_endian() {
  case "$(bytes_hex /bin/sh 1 5)" in
    01) echo le; return 0 ;;
    02) echo be; return 0 ;;
  esac
  case "$(sed -n 's/^DISTRIB_ARCH=.\(mipsel\)_.*/\1/p; s/^DISTRIB_ARCH=.\(mips\)_.*/\1/p' /etc/openwrt_release 2>/dev/null | head -1)" in
    mipsel) echo le ;;
    mips)   echo be ;;
    *)      echo "" ;;
  esac
}

# x86_64 微架构等级（与上游 GOAMD64 一致）：取当前 CPU 支持的最高等级；
# 取不到 flags 或不满足 v2 时用 v1（任何 x86_64 都能跑）。
#   v2：cx16 lahf_lm popcnt sse3(pni) sse4_1 sse4_2 ssse3
#   v3：v2 + avx avx2 bmi1 bmi2 f16c fma movbe xsave 以及 lzcnt(abm)
# 注意上游矩阵里不带版本号的 amd64 其实是 v3（需要 AVX2），这里不会误选它。
core_amd64_level() {
  _fl=$(core_cpu_flags)
  [ -n "$(printf %s "$_fl" | tr -d " ")" ] || { echo v1; return 0; }
  if core_cpu_has "$_fl" cx16 && core_cpu_has "$_fl" lahf_lm && core_cpu_has "$_fl" popcnt \
     && core_cpu_has "$_fl" pni && core_cpu_has "$_fl" sse4_1 && core_cpu_has "$_fl" sse4_2 \
     && core_cpu_has "$_fl" ssse3; then
    if core_cpu_has "$_fl" avx && core_cpu_has "$_fl" avx2 && core_cpu_has "$_fl" bmi1 \
       && core_cpu_has "$_fl" bmi2 && core_cpu_has "$_fl" f16c && core_cpu_has "$_fl" fma \
       && core_cpu_has "$_fl" movbe && core_cpu_has "$_fl" xsave \
       && { core_cpu_has "$_fl" abm || core_cpu_has "$_fl" lzcnt; }; then
      echo v3; return 0
    fi
    echo v2; return 0
  fi
  echo v1
}

# 输出本机内核资产的「平台-架构」token，无法识别时输出空串。
#   Android（有 getprop）：按 ro.product.cpu.abi
#   Linux（OpenWrt 等）  ：按 uname -m；x86 按 CPU 标志选 sse2 / 微架构等级，mips 按字节序选 softfloat
core_arch_token() {
  if [ "$(core_platform)" = android ]; then
    case "$(getprop ro.product.cpu.abi 2>/dev/null)" in
      x86_64)                 echo "android-amd64" ;;
      x86)                    echo "android-386" ;;
      armeabi-v7a|armeabi)    echo "android-armv7" ;;
      *)                      echo "android-arm64-v8" ;;
    esac
    return 0
  fi
  case "$(uname -m 2>/dev/null)" in
    aarch64|arm64)          echo "linux-arm64" ;;
    x86_64|amd64)           echo "linux-amd64-$(core_amd64_level)" ;;
    i[3-6]86)
      if core_cpu_has "$(core_cpu_flags)" sse2; then echo "linux-386"; else echo "linux-386-softfloat"; fi ;;
    armv8l|armv7*)          echo "linux-armv7" ;;
    armv6*)                 echo "linux-armv6" ;;
    armv5*)                 echo "linux-armv5" ;;
    riscv64)                echo "linux-riscv64" ;;
    ppc64le)                echo "linux-ppc64le" ;;
    s390x)                  echo "linux-s390x" ;;
    loongarch64|loong64)    echo "linux-loong64-abi1" ;;
    mips|mipsel|mipsle)
      case "$(core_endian)" in
        le) echo "linux-mipsle-softfloat" ;;
        be) echo "linux-mips-softfloat" ;;
        *)  echo "" ;;
      esac ;;
    mips64|mips64el|mips64le)
      case "$(core_endian)" in
        le) echo "linux-mips64le" ;;
        be) echo "linux-mips64" ;;
        *)  echo "" ;;
      esac ;;
    *) echo "" ;;
  esac
}

# jieluojun/mihomo 分支的架构覆盖：与上游 liuran001/mihomo 矩阵对齐，列表即 core_arch_token 能输出的全部 token。
# 注意：这是 fork 侧的构建范围；发布页（Prerelease-Alpha）未上传的构建，下载时会报「分支未提供该构建」。
core_jieluojun_supported() {
  case "$(core_arch_token)" in
    android-386|android-amd64|android-arm64-v8|android-armv7) return 0 ;;
    linux-386|linux-386-softfloat|linux-amd64-v1|linux-amd64-v2|linux-amd64-v3) return 0 ;;
    linux-arm64|linux-armv5|linux-armv6|linux-armv7) return 0 ;;
    linux-mips-softfloat|linux-mipsle-softfloat|linux-mips64|linux-mips64le) return 0 ;;
    linux-loong64-abi1|linux-riscv64|linux-s390x|linux-ppc64le) return 0 ;;
    *) return 1 ;;
  esac
}

# 最新版直链（无版本列表、无 API、不做版本解析）。
# 上游仓库都用固定滚动 tag 发布最新构建：
# - Alpha：tag 恒为 Prerelease-Alpha（只保留最新构建），抓一次固定 assets 页取确切文件名
#   （文件名含构建 hash 后缀，如 mihomo-android-arm64-v8-alpha-fd74ecb.gz / -alpha-smart-60558cf.gz，
#   这一次抓取是唯一必需的请求，无法再省）；
#   jieluojun/mihomo 同样是滚动发布：2026-10-15 起 tag 与上游一致（Prerelease-Alpha，
#   不再是早期的 with-at-latest），文件名形如 mihomo-android-arm64-v8-alpha-smart-08d28bed-zero.gz
#   （版本后缀早期为 -with-at，现为 -zero）；
# - 正式版：抓一次 /releases/latest 页取其 tag，文件名恒为 mihomo-<arch>-<tag>.gz，直接拼出直链。
# 尺寸探测（HEAD）已从这里拆走：它只影响进度百分比，放到确认需要下载之后再做，
# 不能拖累「已是最新」这类压根不会下载的路径。
# 输出: <url> <name>（一行）
resolve_direct() {
  repo="$1"; line="$2"; rtag="${3:-Prerelease-Alpha}"   # line: alpha | stable；rtag: alpha 线的滚动 tag
  token=$(core_arch_token)
  [ -n "$token" ] || return 1   # 无法识别当前架构：不猜测，直接失败（调用方给出提示）
  if [ "$line" = "stable" ]; then
    # 首个 tag 链接即最新正式版（形如 v1.19.30）；latest 页是单 release 页，不存在旧 tag 干扰
    tag=$(fetch_parse "https://github.com/$repo/releases/latest" parse_release_tag "$repo" "") || return 1
    [ -n "$tag" ] || return 1
    echo "最新正式版 tag: ${tag:-<空>}" >> "$DL_LOG"
    [ -n "$tag" ] || return 1
    name="mihomo-$token-$tag.gz"
    url="https://github.com/$repo/releases/download/$tag/$name"
  else
    u=$(fetch_parse "https://github.com/$repo/releases/expanded_assets/$rtag" parse_alpha_asset "$repo/releases/download/$rtag" "$token") || return 1
    [ -n "$u" ] || return 1
    url="https://github.com$u"
    name="${u##*/}"
  fi
  echo "直链命中: $name $url" >> "$DL_LOG"
  echo "$url $name"
  return 0
}

gunzip_to() {
  dst="$2"
  rm -f "$dst.tmp"
  gzip_decode_checked "$1" "$dst.tmp" || { rm -f "$dst.tmp"; return 1; }
  # 校验 ELF (魔数 0x7F 'E' 'L' 'F')
  if [ -s "$dst.tmp" ] && [ "$(bytes_hex "$dst.tmp" 4)" = "7f454c46" ]; then
    chmod 755 "$dst.tmp" 2>/dev/null
    if mv -f "$dst.tmp" "$dst" 2>/dev/null; then
      return 0
    fi
    # Text file busy 时先删再移
    rm -f "$dst" 2>/dev/null
    if mv -f "$dst.tmp" "$dst" 2>/dev/null; then
      return 0
    fi
    rm -f "$dst.tmp"
    echo "无法覆盖目标文件 (Text file busy)" >&2
    return 1
  fi
  rm -f "$dst.tmp"
  echo "解压结果不是有效的 ELF 可执行文件" >&2
  return 1
}

# 杀掉所有残留的下载器进程：cmdline 里含 run/ 工作目录的抓取进程（curl/wget/toybox）。
# - 取消下载时兜底：pkill -P 在部分 toybox 上不可用，曾导致 curl 失亲（PPid=1）后继续跑满超时；
#   这里直接扫 /proc，不依赖 pkill，孤儿进程一并收走；
# - 新下载开始前调用：清理上次遗留的孤儿，避免空耗流量。
# 自身与其它 mihomo.sh 调用（status/logs/download-status）的 cmdline 不含该路径，不会误杀。
# 精确复核单个 pid：祖先链跳过 + cmdline 还原分隔 + 含 run 目录且带 -o/-O 才杀。
# 调用前须算好 $_anc（空格包围的祖先 pid 表）。
_fetcher_maybe_kill() {
  _mpn=$1
  case "$_anc" in *" $_mpn "*) return 0 ;; esac
  [ -r "/proc/$_mpn/cmdline" ] || return 0
  _mcl="$(tr '\0' ' ' < "/proc/$_mpn/cmdline" 2>/dev/null)"
  case "$_mcl" in
    *"$RUNDIR"*)
      case "$_mcl" in
        *" -o "*|*" -O "*) kill -9 "$_mpn" 2>/dev/null ;;
      esac ;;
  esac
}

kill_stale_fetchers() {
  # 先算祖先链（自己 + 所有父进程）：横扫时一律跳过，绝不自杀。
  # （调用者的 cmdline 里可能恰好含有工作目录字串，如 sh -c 包裹调用时整个命令文本都在里面）
  _anc=" $$ "
  _a=$$
  while :; do
    _st=$(cat "/proc/$_a/stat" 2>/dev/null) || break
    _st=${_st##*) }   # 去掉 "PID (comm) "（comm 可能含空格括号，用 ##*) 贪婪切到最后一个右括号）
    _st=${_st#* }     # 去掉 STATE，剩 "PPID ..."
    _a=${_st%% *}     # 取 PPID
    case "$_a" in ''|*[!0-9]*|0|1) break ;; esac
    case "$_anc" in *" $_a "*) break ;; esac   # 防环
    _anc="$_anc$_a "
  done
  # 快路：一次 grep 找出 cmdline 含 run 目录的候选（平时 0 个），只复核这几个；
  # 不再逐进程 fork tr——手机上几百个进程，逐个 fork 是秒级延迟，下载/取消按钮点着慢。
  # grep 出错（rc=2）或缺 grep 时才回落全量扫描，保证不漏杀。
  _fast=0
  if command -v grep >/dev/null 2>&1; then
    _cands=$(grep -lF -e "$RUNDIR" /proc/[0-9]*/cmdline 2>/dev/null)
    _grc=$?
    if [ "$_grc" -eq 0 ]; then
      for _cf in $_cands; do
        _cpn=${_cf#/proc/}; _cpn=${_cpn%/cmdline}
        _fetcher_maybe_kill "$_cpn"
      done
      _fast=1
    elif [ "$_grc" -eq 1 ]; then
      _fast=1
    fi
  fi
  if [ "$_fast" -eq 0 ]; then
    for _p in /proc/[0-9]*; do _fetcher_maybe_kill "${_p#/proc/}"; done
  fi
  rm -f "$DL_FETCH_PID" "$RUNDIR"/core_download.*.gz
}

# 远端文件名 vs 本地 -v：末段（stable 的 tag / alpha 的短 hash）出现在本地版本串里即最新。
# 末段不含数字时（jieluojun 的 …-08d28bed-zero.gz，早期为 …-425f12ad-with-at.gz，末段是 zero/at）
# 不能只比末段——旧版本串里同样有该后缀，会被误判成「已是最新」永远不更新；改比去掉
# 「mihomo-<平台>-<架构>-」前缀后的完整版本串（该分支 -v 输出的就是它，如 alpha-smart-08d28bed-zero）。
is_latest_core() {
  # $1=远端文件名 $2=本地 -v → 0=已是最新
  [ -n "$1" ] && [ -n "$2" ] || return 1
  _il_t=${1%.gz}; _il_t=${_il_t##*-}
  case "$1" in
    # alpha 线（含 liuran001 / jieluojun 滚动版）：取 "alpha-" 起的部分比对。
    # 资产名的「平台-架构段」可能含版本（linux-amd64-v3-alpha-…），不能再靠逐个去前缀，
    # 否则与 -v 输出对不上，导致每次都误判为「有更新」而重复下载。
    *-alpha-*) _il_t=${1%.gz}; _il_t=alpha-${_il_t#*-alpha-} ;;
    *)
      case "$_il_t" in
        *[0-9]*) : ;;
        *)
          _il_t=${1%.gz}; _il_t=${_il_t#mihomo-}; _il_t=${_il_t#android-}; _il_t=${_il_t#linux-}
          _il_t=${_il_t#arm64-v8-}; _il_t=${_il_t#arm64-}; _il_t=${_il_t#amd64-} ;;
      esac ;;
  esac
  [ -n "$_il_t" ] || return 1
  case "$2" in *"$_il_t"*) return 0 ;; *) return 1 ;; esac
}

# ---- 后台下载入口（立即返回，进度写入状态文件） ----
download_core() {
  case "$1" in liuran001|jieluojun|official|http*) : ;;
    *) echo "ERR: 未知内核来源: $1"; return 1 ;; esac
  if [ -f "$DL_PID" ] && kill -0 "$(dl_pid_of)" 2>/dev/null; then
    echo "ALREADY_RUNNING"
    return 1
  fi
  rm -f "$DL_PID"   # 清理上一次的死 pid 文件
  # 孤儿下载器清扫移到 _dl_run（后台任务里）执行，本命令立即返回 started：
  # 之前这里同步跑 /proc 扫描要一两秒甚至更久，前端进度弹窗早早开始轮询，
  # 就在这段窗口里读到上一次下载残留的 done/cancelled/error —— 「下载中闪现
  # 已取消/已完成/失败」、"下载完了却还显示失败/已取消" 的直接成因。
  rm -f "$DL_STATUS"; reset_log "$DL_LOG"
  nohup sh "$0" _dl-run "$@" >> "$DL_LOG" 2>&1 &
  echo $! > "$DL_PID"
  echo "started $(dl_pid_of)"
  return 0
}

# ---- 下载任务本体（内部命令） ----
_dl_run() {
  which="$1"
  dl_emit "downloading" 0 0 0 "" ""
  if ! have_http; then
    dl_emit "error" 0 0 0 "" "$(http_missing_msg)"
    rm -f "$DL_PID"
    exit 1
  fi
  dest=""
  case "$which" in
    liuran001)       dest="$CORE_LIURAN001";;
    jieluojun)       dest="$CORE_JIELUOJUN";;
    official)        dest="$CORE_OFFICIAL";;
    http*)
      dest="$CORE_LIURAN001"
      case "$2" in official) dest="$CORE_OFFICIAL";; jieluojun) dest="$CORE_JIELUOJUN";; liuran001) dest="$CORE_LIURAN001";; esac ;;
    *) dl_emit "error" 0 0 0 "" "未知来源"; exit 1 ;;
  esac
  # 架构识别失败（非 Android 且 uname 不在已知列表）：直接报清楚原因，不去拼资产名。
  case "$which" in
    http*) : ;;
    *)
      if [ -z "$(core_arch_token)" ]; then
        dl_emit "error" 0 0 0 "" "无法识别当前 CPU 架构（$(uname -m 2>/dev/null)），无法匹配内核构建；请手动导入对应架构的内核"
        rm -f "$DL_PID"
        exit 1
      fi ;;
  esac
  # 直链第一步先取「远端最新文件名」（GitHub 抓一次元数据，唯一不能省的请求）。
  # 体积探测（HEAD）、孤儿清扫都挪到「确认要真下载」之后，不能再躺在
  # 「是否最新」的判断路径上——用户点下载之后不知所措地等，一半时间都是
  # 陪跑这些最终根本用不上的探测。
  info=""
  case "$which" in
    liuran001)
      dl_emit "downloading" 0 0 0 "" "获取最新版本…"
      info=$(resolve_direct "liuran001/mihomo" alpha) ;;
    jieluojun)
      # 该分支覆盖与 core_arch_token 一致的全部架构（见 core_jieluojun_supported），不支持的直接说明原因，
      # 别让它落到下面「GitHub 不可达」的误导提示
      if ! core_jieluojun_supported; then
        dl_emit "error" 0 0 0 "" "当前设备（$(uname -m 2>/dev/null)）的架构在 jieluojun/mihomo 分支覆盖范围之外，请在「内核管理」中改用 official 或 liuran001 内核"
        rm -f "$DL_PID"
        exit 1
      fi
      dl_emit "downloading" 0 0 0 "" "获取最新版本…"
      # 2026-10-15 起该分支滚动 tag 从 with-at-latest 改回 Prerelease-Alpha（与上游
      # liuran001 一致），版本后缀 -with-at → -zero；不传第 3 参即默认 Prerelease-Alpha
      info=$(resolve_direct "jieluojun/mihomo" alpha) ;;
    official)
      dl_emit "downloading" 0 0 0 "" "获取最新版本…"
      info=$(resolve_direct "MetaCubeX/mihomo" stable) ;;
    http*)
      info="$which ${which##*/}" ;;
  esac
  if [ -z "$info" ]; then
    # jieluojun 发布页可能尚未上传本架构的构建：与「GitHub 不可达」区分开说明，避免误导排障
    case "$which" in
      jieluojun)
        dl_emit "error" 0 0 0 "" "jieluojun/mihomo 发布页未找到本架构（$(core_arch_token)）的构建，或 GitHub 不可达；可改用 official / liuran001 内核，或切换下载加速镜像后重试（详情见下载日志）" ;;
      *)
        dl_emit "error" 0 0 0 "" "无法获取最新版下载地址：GitHub 不可达，可到「下载加速镜像」切换镜像后重试（详情见下载日志）" ;;
    esac
    rm -f "$DL_PID"
    exit 1
  fi
  url=${info%% *}
  name=${info##* }
  echo "下载地址: $name $url" >> "$DL_LOG"
  # 已是最新则直接结束——只比对文件名末尾的 tag/hash 与本地 -v，不联网、不探测体积。
  # （自定义链接无法判断版本，跳过校验）
  case "$which" in
    http*) : ;;
    *)
      if is_latest_core "$name" "$(core_version "$dest" 2>/dev/null)"; then
        echo "已是最新版，跳过下载: $name" >> "$DL_LOG"
        dl_emit "uptodate" 100 0 0 "" ""
        rm -f "$DL_PID"
        exit 0
      fi ;;
  esac
  # —— 确认要真下载了，才做这些「只对下载有意义」的活 ——
  kill_stale_fetchers
  total=$(probe_size "$url")
  case "$total" in *[!0-9]*) total=0 ;; esac
  dl_emit "downloading" 0 0 "$total" "" ""

  # 每次运行使用独立临时文件名，避免残留的下载进程把内容写进本次文件（日志错乱/文件损坏的根因）
  gz="$RUNDIR/core_download.$$.gz"
  rm -f "$gz"
  if ! fetch_mirrored "$url" "$gz" "$total"; then
    rm -f "$gz"
    dl_emit "error" 0 0 "$total" "" "下载或完整性校验失败，请查看下载日志中的网络及解压错误"
    rm -f "$DL_PID"
    exit 1
  fi
  dl_emit "unpacking" 99 "$(wc -c < "$gz" 2>/dev/null || echo 0)" "$total" "" ""
  # 下载后自动重启：若更新的是当前正在运行的内核，则停旧起新
  _dl_need_restart=0
  _dl_current=$(core_path)
  if running && [ "$dest" = "$_dl_current" ]; then
    echo "检测到目标内核正在运行，更新前先停止..." >> "$DL_LOG"
    _dl_need_restart=1
    stop_core >> "$DL_LOG" 2>&1
    nap 0.5
  fi
  if gunzip_to "$gz" "$dest"; then
    rm -f "$gz"
    # 清除版本缓存，-v 立即取新版
    rm -f "$VERCACHE" 2>/dev/null
    if [ "$_dl_need_restart" = "1" ]; then
      echo "正在重启内核..." >> "$DL_LOG"
      if start_core >> "$DL_LOG" 2>&1; then
        echo "OK: 内核已安装并重启 -> $dest ($(core_version "$dest" 2>/dev/null))" >> "$DL_LOG"
      else
        echo "WARN: 内核已安装但重启失败，请到主页手动启动" >> "$DL_LOG"
      fi
    else
      echo "OK: 内核已安装 -> $dest" >> "$DL_LOG"
      # 若内核未在运行但设置为开机自启，下次会用新版；不自动拉起避免打扰
    fi
    dl_emit "done" 100 "$(wc -c < "$dest" 2>/dev/null || echo 0)" "$total" "" ""
    live_invalidate 2>/dev/null   # 内核版本已变（status.liuran001_ver），旧缓存作废
    rm -f "$DL_PID"
    exit 0
  fi
  dl_emit "error" 0 0 "$total" "" "解压失败（下载文件非内核二进制）"
  rm -f "$DL_PID"
  exit 1
}

# ============================================================
# 内核导入（原 scripts/core-import.sh，已合并进本文件）
#
# 归档一律流式解到私有暂存文件，绝不按压缩包内给出的路径解到目录里；
# 校验（大小 / 魔数 / 唯一 ELF / 路径安全 / 重复项）全部通过后才停服务替换。
# ============================================================
ci_magic() { bytes_hex "$1" 4; }
ci_size_ok() {
  _cs_size=$(wc -c < "$1" 2>/dev/null | tr -d ' \r\n')
  case "$_cs_size" in ''|*[!0-9]*) return 1 ;; esac
  [ "$_cs_size" -gt 0 ] && [ "$_cs_size" -le 134217728 ]
}
ci_limited() (
  # sh implementations use 512- or 1024-byte blocks. This caps the temporary
  # output at <=256 MiB; the exact 128 MiB limit is checked after decoding.
  ulimit -f 262144 || exit 1
  "$@"
)
ci_tar() {
  if [ "$_ci_tar_kind" = busybox ]; then "$BUSYBOX" tar "$@"; else tar "$@"; fi
}
ci_unzip() {
  if [ "$_ci_zip_kind" = busybox ]; then "$BUSYBOX" unzip "$@"; else unzip "$@"; fi
}
ci_safe_name() {
  case "$1" in ''|/*|-*|*\\*|*'*'*|*'?'*|*'['*|*']'*) return 1 ;; esac
  case "/$1/" in */../*) return 1 ;; esac
  ! printf '%s' "$1" | LC_ALL=C grep -q '[[:cntrl:]]'
}
ci_candidate() {
  ci_size_ok "$1" || { echo 'ERR: 归档条目为空或超过 128 MiB'; return 1; }
  _ci_bytes=$((_ci_bytes + _cs_size))
  [ "$_ci_bytes" -le 268435456 ] || { echo 'ERR: 归档总解压量超过 256 MiB'; return 1; }
  [ "$(ci_magic "$1")" = 7f454c46 ] || return 0
  _ci_count=$((_ci_count + 1))
  [ "$_ci_count" = 1 ] || { echo 'ERR: 归档内有多个 ELF 二进制，无法唯一确定内核'; return 1; }
  cp "$1" "$_ci_stage/newcore" || return 1
}
ci_archive() {
  _ca_format="$1"; _ca_src="$2"
  _ci_tar_kind=system; _ci_zip_kind=system
  if [ "$_ca_format" = zip ]; then
    if have_busybox && applet_has "$BUSYBOX" unzip; then _ci_zip_kind=busybox
    elif ! command -v unzip >/dev/null 2>&1; then echo 'ERR: 没有可用的 unzip 工具'; return 1; fi
    ci_limited ci_unzip -l "$_ca_src" > "$_ci_stage/listing" || return 1
    LC_ALL=C awk '
      $1 ~ /^[0-9]+$/ && $2 ~ /^[-0-9\/]+$/ && $3 ~ /^[0-9:]+$/ && NF>=4 {
        if ($1>134217728) { bad=1; exit }
        name=$0; sub(/^[[:space:]]*[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+/, "", name)
        print (name ~ /\/$/ ? "d" : "-") "\t" name; n++
      }
      END { if(bad || !n || n>128) exit 1 }
    ' "$_ci_stage/listing" > "$_ci_stage/members" || { echo 'ERR: ZIP 列表不可用、条目过大或超过 128 项'; return 1; }
  else
    if have_busybox && applet_has "$BUSYBOX" tar; then _ci_tar_kind=busybox
    elif ! command -v tar >/dev/null 2>&1; then echo 'ERR: 没有可用的 tar 工具'; return 1; fi
    ci_limited ci_tar -tf "$_ca_src" > "$_ci_stage/names" || return 1
    ci_limited ci_tar -tvf "$_ca_src" > "$_ci_stage/types-long" || return 1
    cut -c1 "$_ci_stage/types-long" > "$_ci_stage/types"
    _ca_n=$(wc -l < "$_ci_stage/names")
    [ "$_ca_n" -gt 0 ] && [ "$_ca_n" -le 128 ] || { echo 'ERR: TAR 为空或超过 128 项'; return 1; }
    [ "$_ca_n" -eq "$(wc -l < "$_ci_stage/types")" ] || { echo 'ERR: TAR 条目类型无法对应'; return 1; }
    (
      exec 3< "$_ci_stage/types"
      while IFS= read -r _ca_name; do
        IFS= read -r _ca_type <&3 || exit 1
        printf '%s\t%s\n' "$_ca_type" "$_ca_name"
      done < "$_ci_stage/names"
    ) > "$_ci_stage/members" || return 1
  fi
  # Reject ambiguous duplicate members before reading anything from the archive.
  cut -f2- "$_ci_stage/members" | LC_ALL=C sort | uniq -d > "$_ci_stage/duplicates"
  [ ! -s "$_ci_stage/duplicates" ] || { echo 'ERR: 压缩包包含重复路径'; return 1; }
  _ca_tab=$(printf '\t')
  while IFS="$_ca_tab" read -r _ca_type _ca_name; do
    ci_safe_name "$_ca_name" || { echo 'ERR: 压缩包包含不安全或不支持的路径'; return 1; }
    case "$_ca_type" in d) continue ;; -) : ;; *) echo 'ERR: TAR 含链接或特殊文件，不支持导入'; return 1 ;; esac
    if [ "$_ca_format" = zip ]; then
      ci_limited ci_unzip -p "$_ca_src" "$_ca_name" > "$_ci_stage/member" || { echo 'ERR: ZIP 条目解压或 CRC 校验失败'; return 1; }
    else
      ci_limited ci_tar -xOf "$_ca_src" "$_ca_name" > "$_ci_stage/member" || { echo 'ERR: TAR 条目读取失败'; return 1; }
    fi
    # Empty documentation files are allowed; never count them as a core.
    [ -s "$_ci_stage/member" ] || continue
    ci_candidate "$_ci_stage/member" || return 1
  done < "$_ci_stage/members"
  [ "$_ci_count" = 1 ] || { echo 'ERR: 归档内没有 ELF 内核二进制'; return 1; }
}
core_import_apply() (
  _ci_src="$1"
  case "$2" in liuran001) _ci_dest="$CORE_LIURAN001" ;; jieluojun) _ci_dest="$CORE_JIELUOJUN" ;; official) _ci_dest="$CORE_OFFICIAL" ;; *) echo 'ERR: 非法导入目标'; exit 1 ;; esac
  [ -f "$_ci_src" ] || { echo 'ERR: 选择的文件不存在或不是普通文件'; exit 1; }
  ci_size_ok "$_ci_src" || { echo 'ERR: 文件为空或超过 128 MiB'; exit 1; }
  if [ -f "$DL_PID" ] && kill -0 "$(dl_pid_of)" 2>/dev/null; then
    echo 'ERR: 内核下载任务尚未结束，请稍后导入'; exit 1
  fi
  umask 077
  _ci_stage=$(mktemp -d "$RUNDIR/core-import.XXXXXX") || exit 1
  trap 'rm -rf "$_ci_stage"' 0
  trap 'exit 1' HUP INT TERM
  _ci_count=0; _ci_bytes=0
  # Snapshot before inspection so another app changing the selected file cannot
  # substitute different bytes between validation and installation.
  ci_limited cp "$_ci_src" "$_ci_stage/source" || exit 1
  ci_size_ok "$_ci_stage/source" || exit 1
  _ci_src="$_ci_stage/source"
  _ci_magic=$(ci_magic "$_ci_src")
  case "$_ci_magic" in
    7f454c46) cp "$_ci_src" "$_ci_stage/newcore" || exit 1 ;;
    1f8b08*)
      ci_limited gzip_decode_checked "$_ci_src" "$_ci_stage/unpacked" || { echo 'ERR: gzip 解压或完整性校验失败'; exit 1; }
      ci_size_ok "$_ci_stage/unpacked" || { echo 'ERR: gzip 解压结果为空或超过 128 MiB'; exit 1; }
      if [ "$(ci_magic "$_ci_stage/unpacked")" = 7f454c46 ]; then
        mv "$_ci_stage/unpacked" "$_ci_stage/newcore" || exit 1
      else
        ci_archive tar "$_ci_stage/unpacked" || exit 1
      fi ;;
    504b0304|504b0506) ci_archive zip "$_ci_src" || exit 1 ;;
    *) ci_archive tar "$_ci_src" || exit 1 ;;
  esac
  [ "$(ci_magic "$_ci_stage/newcore")" = 7f454c46 ] || { echo 'ERR: 不是 ELF 内核文件'; exit 1; }
  chmod 755 "$_ci_stage/newcore" || exit 1
  # Only stop the current service AFTER all decoding and candidate validation.
  _ci_restart=0
  if [ "$_ci_dest" = "$(core_path)" ] && running; then
    _ci_restart=1
    echo '校验通过，正在停止当前服务以替换内核…'
    stop_core || { echo 'ERR: 停止服务失败，未替换内核'; exit 1; }
  fi
  # Same work filesystem: atomic rename, no delete-old-first fallback.
  if ! mv -f "$_ci_stage/newcore" "$_ci_dest"; then
    echo 'ERR: 替换失败，未主动删除原内核'
    [ "$_ci_restart" = 0 ] || start_core
    exit 1
  fi
  rm -f "$VERCACHE"
  core_label_v "$2"
  echo "OK: 已导入并替换 $CLV 内核"
  if [ "$_ci_restart" = 1 ]; then
    start_core || { echo 'ERR: 内核已替换，但服务恢复失败，请检查配置及运行日志'; exit 1; }
    echo 'OK: 服务已恢复运行'
  fi
  core_version "$_ci_dest" 2>/dev/null
  exit 0
)

import_core() {
  core_import_apply "$@"
}

# ---- Geo 下载入口（立即返回，进度写入状态文件） ----
download_geo() {
  if [ -f "$GEO_PID" ] && kill -0 "$(geo_pid_of)" 2>/dev/null; then
    echo "ALREADY_RUNNING"
    return 1
  fi
  rm -f "$GEO_PID"
  # 孤儿下载器清扫移到 _geo_run（后台本体）：与内核下载同理，让本命令立即回
  # started，避免 /proc 扫描卡在启动窗口、进度弹窗读到上一轮的旧状态。
  rm -f "$GEO_STATUS" "$RUNDIR"/geo_download.*.tmp; reset_log "$GEO_LOG"
  nohup sh "$0" _geo-run >> "$GEO_LOG" 2>&1 &
  echo $! > "$GEO_PID"
  echo "started $(geo_pid_of)"
  return 0
}

# jsdelivr 的 GitHub 镜像地址 → 等价的 github.com raw 地址（供加速镜像套前缀）；
# 其余地址原样返回（自定义直链/CDN 不套镜像）。
# 例如 https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat
#    → https://github.com/MetaCubeX/meta-rules-dat/raw/release/geoip.dat
geo_gh_url() {
  case "$1" in
    *jsdelivr.net*) : ;;
    *) printf '%s' "$1"; return 0 ;;
  esac
  case "$1" in *"/gh/"*) : ;; *) printf '%s' "$1"; return 0 ;; esac
  _gg=${1#*"/gh/"}
  case "$_gg" in */*) : ;; *) printf '%s' "$1"; return 0 ;; esac
  _gg_owner=${_gg%%/*}
  _gg=${_gg#*/}
  _gg_repobr=${_gg%%/*}
  case "$_gg_repobr" in *@*) : ;; *) printf '%s' "$1"; return 0 ;; esac
  _gg_path=${_gg#*/}
  printf 'https://github.com/%s/%s/raw/%s/%s' "$_gg_owner" "${_gg_repobr%@*}" "${_gg_repobr#*@}" "$_gg_path"
  return 0
}

# 单个 Geo 文件下载（带字节轮询）：$1=url $2=tmp $3=标签 $4=起始百分比（累计字节进 _go_base）
# GitHub 系地址（含 jsdelivr /gh/ 形式）按「下载加速镜像」设置逐个候选尝试：
# 选定镜像优先 → 其余镜像 → 直连 github raw → 原地址（jsdelivr/CDN）最后兜底；
# 非 GitHub 源（用户自配的第三方直链）原样直连，不套镜像。
_geo_one() {
  _go_url="$1"; _go_out="$2"; _go_label="$3"; _go_pct0="$4"
  rm -f "$_go_out"
  _go_gurl=$(geo_gh_url "$_go_url")        # 套镜像用的 GitHub 等价地址
  _go_orig="$1"                              # 原地址：jsdelivr/CDN 最终兜底
  if is_github_url "$_go_gurl"; then
    _go_entries=$(mirror_candidates 2>/dev/null)
  else
    _go_entries="直连 -"
  fi
  case "$_go_entries" in
    *"直连"*) : ;;
    *) _go_entries="$_go_entries
直连 -" ;;
  esac
  _go_ok=0
  _go_ifs=$IFS; IFS='
'
  case $- in *f*) _go_noglob=1 ;; *) _go_noglob=0; set -f ;; esac
  for _go_entry in $_go_entries; do
    [ -n "$_go_entry" ] || continue
    _go_mname=${_go_entry%% *}
    _go_prefix=$(cand_prefix "$_go_entry") || {
      echo "跳过非法候选 [$_go_entry]" >> "$GEO_LOG"; continue; }
    _go_full="${_go_prefix}${_go_gurl}"
    echo "尝试 [$_go_mname] $_go_full" >> "$GEO_LOG"
    rm -f "$_go_out"
    start_fetcher "$_go_full" "$_go_out"
    _go_p=$FETCH_PID
    echo "$_go_p" > "$GEO_FETCH_PID" 2>/dev/null
    # 起手立即报一次镜像名，界面不用等首轮 1s 轮询才看到
    geo_emit "downloading" "$_go_pct0" "$_go_base" 0 "$_go_label · $_go_mname" ""
    while kill -0 "$_go_p" 2>/dev/null; do
      _go_b=0
      [ -f "$_go_out" ] && _go_b=$(wc -c < "$_go_out" 2>/dev/null || echo 0)
      case "$_go_b" in *[!0-9]*) _go_b=0 ;; esac
      geo_emit "downloading" "$_go_pct0" "$((_go_base + _go_b))" 0 "$_go_label · $_go_mname" ""
      sleep 1
    done
    wait "$_go_p" && _go_rc=0 || _go_rc=$?
    rm -f "$GEO_FETCH_PID"
    _go_b=0
    [ -f "$_go_out" ] && _go_b=$(wc -c < "$_go_out" 2>/dev/null || echo 0)
    case "$_go_b" in *[!0-9]*) _go_b=0 ;; esac
    if [ "${_go_rc:-1}" = "0" ] && [ "$_go_b" -gt 0 ]; then
      echo "[$_go_mname] Geo 文件下载完成($_go_b 字节)" >> "$GEO_LOG"
      _go_ok=1
      break
    fi
    echo "[$_go_mname] 失败(rc=${_go_rc:-?})，尝试下一条" >> "$GEO_LOG"
  done
  [ "$_go_noglob" = "1" ] || set +f; IFS=$_go_ifs
  # 原地址兜底（jsdelivr CDN / 自定义直链）：只有与套镜像用的 GitHub 等价地址不同才试，
  # 避免重复下载一遍刚 failure 的同一 URL。
  if [ "$_go_ok" = "0" ] && [ "$_go_orig" != "$_go_gurl" ]; then
    echo "尝试 [原地址] $_go_orig" >> "$GEO_LOG"
    rm -f "$_go_out"
    start_fetcher "$_go_orig" "$_go_out"
    _go_p=$FETCH_PID
    echo "$_go_p" > "$GEO_FETCH_PID" 2>/dev/null
    geo_emit "downloading" "$_go_pct0" "$_go_base" 0 "$_go_label · 原地址" ""
    while kill -0 "$_go_p" 2>/dev/null; do
      _go_b=0
      [ -f "$_go_out" ] && _go_b=$(wc -c < "$_go_out" 2>/dev/null || echo 0)
      case "$_go_b" in *[!0-9]*) _go_b=0 ;; esac
      geo_emit "downloading" "$_go_pct0" "$((_go_base + _go_b))" 0 "$_go_label · 原地址" ""
      sleep 1
    done
    wait "$_go_p" && _go_rc=0 || _go_rc=$?
    rm -f "$GEO_FETCH_PID"
    _go_b=0
    [ -f "$_go_out" ] && _go_b=$(wc -c < "$_go_out" 2>/dev/null || echo 0)
    case "$_go_b" in *[!0-9]*) _go_b=0 ;; esac
    if [ "${_go_rc:-1}" = "0" ] && [ "$_go_b" -gt 0 ]; then
      echo "[原地址] Geo 文件下载完成($_go_b 字节)" >> "$GEO_LOG"
      _go_ok=1
    fi
  fi
  if [ "$_go_ok" = "1" ]; then
    _go_b=0
    [ -f "$_go_out" ] && _go_b=$(wc -c < "$_go_out" 2>/dev/null || echo 0)
    case "$_go_b" in *[!0-9]*) _go_b=0 ;; esac
    _go_base=$((_go_base + _go_b))
    return 0
  fi
  rm -f "$_go_out"
  return 1
}

# 文件 sha256（小写 hex）。算不出来（设备没有 sha256sum/openssl/toybox）返回空串：
# 调用方据此放弃哈希比对——宁可多下载一次，也绝不错报「已是最新」。
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | awk '{print $1}' | tr 'A-F' 'a-f'
  elif have_busybox && applet_has "$BUSYBOX" sha256sum; then
    "$BUSYBOX" sha256sum "$1" 2>/dev/null | awk '{print $1}' | tr 'A-F' 'a-f'
  elif command -v toybox >/dev/null 2>&1 && applet_has toybox sha256sum; then
    toybox sha256sum "$1" 2>/dev/null | awk '{print $1}' | tr 'A-F' 'a-f'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" 2>/dev/null | awk '{print $NF}' | tr 'A-F' 'a-f'
  fi
}

# 取远程 Geo 数据的 sha256 指纹（<url>.sha256sum 小文件，走镜像回退，超时收紧）。
# 只有 GitHub 系地址才有配套 sha 文件；非 GitHub 源（自定义直链/CDN）返回空串。
# $1=url  $2=内部临时文件（并发调用时避免共享 $$ 同名 tmp 互相 rm；缺省自动）。
# $3=nopid：不读写 GEO_FETCH_PID（并发阶段由父进程统一登记，防止互相覆盖/误删）。
# stdout: 64 位小写 hex；失败/取不到返回空。
# 超时只为「快退坏候选」：connect 3s、总 10s、最多试 3 个候选，拿不到就放弃
# 比对直接下载——不能为了让「最新判断」更全，把「开始下载」拖慢几十秒。
fetch_geo_hash() {
  _fh_nopid="$3"
  _fh_gh=$(geo_gh_url "$1")
  is_github_url "$_fh_gh" || { printf ''; return 0; }
  _fh_entries=$(mirror_candidates 2>/dev/null)
  case "$_fh_entries" in
    *"直连GitHub"*) : ;;
    *) _fh_entries="$_fh_entries
直连GitHub -" ;;
  esac
  _fh_out="${2:-$RUNDIR/geo_download.$$.hash.tmp}"
  _fh_res=""
  _fh_n=0
  _fh_ifs=$IFS; IFS='
'
  case $- in *f*) _fh_noglob=1 ;; *) _fh_noglob=0; set -f ;; esac
  for _fh_entry in $_fh_entries; do
    [ -n "$_fh_entry" ] || continue
    _fh_n=$((_fh_n + 1))
    [ "$_fh_n" -gt 3 ] && break
    _fh_name=${_fh_entry%% *}
    _fh_prefix=$(cand_prefix "$_fh_entry") || continue
    _fh_full="${_fh_prefix}${_fh_gh}.sha256sum"
    echo "尝试 [$_fh_name] hash $_fh_full" >> "$GEO_LOG"
    rm -f "$_fh_out"
    detect_http || break
    case "$HTTP_CLIENT" in
      curl)    curl -fsSL --connect-timeout 3 --max-time 10 -A "mihomo-ksu" -o "$_fh_out" "$_fh_full" & ;;
      wget)    wget -q --timeout=8 -O "$_fh_out" "$_fh_full" & ;;
      toybox)  toybox wget -q --timeout=8 -O "$_fh_out" "$_fh_full" & ;;
      busybox) "$BUSYBOX" wget -q --timeout=8 -O "$_fh_out" "$_fh_full" & ;;
      *)       break ;;
    esac
    _fh_p=$!
    [ -n "$_fh_nopid" ] || echo "$_fh_p" > "$GEO_FETCH_PID" 2>/dev/null   # 取消时能精确杀掉 hash 抓取进程
    while kill -0 "$_fh_p" 2>/dev/null; do sleep 1; done
    wait "$_fh_p" && _fh_rc=0 || _fh_rc=$?
    [ -n "$_fh_nopid" ] || rm -f "$GEO_FETCH_PID"
    if [ "${_fh_rc:-1}" = "0" ] && [ -s "$_fh_out" ]; then
      _fh_h=$(tr -d '\r' < "$_fh_out" 2>/dev/null | awk '{print $1}')
      case "$_fh_h" in *[!0-9a-fA-F]*) _fh_h="" ;; esac
      [ "${#_fh_h}" = "64" ] || _fh_h=""
      if [ -n "$_fh_h" ]; then
        _fh_res=$(printf '%s' "$_fh_h" | tr 'A-F' 'a-f')
        echo "[$_fh_name] 取到 sha256: $_fh_res" >> "$GEO_LOG"
        break
      fi
      echo "[$_fh_name] hash 文件格式异常，忽略" >> "$GEO_LOG"
    else
      echo "[$_fh_name] hash 抓取失败(rc=${_fh_rc:-?})" >> "$GEO_LOG"
    fi
  done
  [ "$_fh_noglob" = "1" ] || set +f; IFS=$_fh_ifs
  rm -f "$_fh_out"
  printf '%s' "$_fh_res"
  return 0
}

# ---- Geo 下载任务本体（内部命令） ----
_geo_run() {
  _go_base=0
  geo_emit "downloading" 0 0 0 "" ""
  if ! have_http; then
    geo_emit "error" 0 0 0 "" "$(http_missing_msg)"
    rm -f "$GEO_PID"
    exit 1
  fi
  # 从配置 geox-url 拿地址，缺省走 jsdelivr 官方源
  geoip=$(grep -A4 'geox-url' "$CONFIG" 2>/dev/null | grep 'geoip:' | head -1 | sed -E 's/.*geoip: *"?//; s/"$//')
  geosite=$(grep -A4 'geox-url' "$CONFIG" 2>/dev/null | grep 'geosite:' | head -1 | sed -E 's/.*geosite: *"?//; s/"$//')
  mmdb=$(grep -A4 'geox-url' "$CONFIG" 2>/dev/null | grep 'mmdb:' | head -1 | sed -E 's/.*mmdb: *"?//; s/"$//')
  [ -z "$geoip" ] && geoip="https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat"
  [ -z "$geosite" ] && geosite="https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat"
  [ -z "$mmdb" ] && mmdb="https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.metadb"
  _go_fail=""
  _go_found=0
  _go_cleaned=0
  # 本地 sha256 指纹缓存：记录上一轮实际下载到的哈希（key=文件名），
  # 下次下载前先与远程 hash 比对，一致则跳过下载。
  GEO_CACHE="$WORKDIR/.geo_hash"
  _go_cached=$(cat "$GEO_CACHE" 2>/dev/null)
  _go_cache_lines=""
  # 三个远程 hash 并行抓取（各自走镜像回退）：之前逐个文件顺序「探测→下载→探测→下载…」，
  # 三个 hash 串行要等三轮，这里一轮并行压成「只等最慢的那一次」。抓不到就放弃比对
  # 直接下载（不误报最新），宁可重下也不让「开始下载」干等。
  _fh_out1="$RUNDIR/geo_download.$$.h1o.tmp"
  _fh_out2="$RUNDIR/geo_download.$$.h2o.tmp"
  _fh_out3="$RUNDIR/geo_download.$$.h3o.tmp"
  _fh_r1="$RUNDIR/geo_download.$$.h1r.tmp"
  _fh_r2="$RUNDIR/geo_download.$$.h2r.tmp"
  _fh_r3="$RUNDIR/geo_download.$$.h3r.tmp"
  _go_sp1="geoip.metadb $mmdb"
  _go_sp2="geoip.dat $geoip"
  _go_sp3="geosite.dat $geosite"
  fetch_geo_hash "$mmdb" "$_fh_out1" nopid > "$_fh_r1" &
  _go_hp1=$!
  fetch_geo_hash "$geoip" "$_fh_out2" nopid > "$_fh_r2" &
  _go_hp2=$!
  fetch_geo_hash "$geosite" "$_fh_out3" nopid > "$_fh_r3" &
  _go_hp3=$!
  # 三个并发抓取 pid 全部登记，取消时能一次性精确杀掉（空格分隔，kill 接受多 pid）
  echo "$_go_hp1 $_go_hp2 $_go_hp3" > "$GEO_FETCH_PID" 2>/dev/null
  _fh_h1=""; _fh_h2=""; _fh_h3=""
  for _go_hpid in "$_go_hp1" "$_go_hp2" "$_go_hp3"; do
    while kill -0 "$_go_hpid" 2>/dev/null; do sleep 1; done
    wait "$_go_hpid" 2>/dev/null
  done
  rm -f "$GEO_FETCH_PID"
  _fh_h1=$(cat "$_fh_r1" 2>/dev/null)
  _fh_h2=$(cat "$_fh_r2" 2>/dev/null)
  _fh_h3=$(cat "$_fh_r3" 2>/dev/null)
  rm -f "$_fh_r1" "$_fh_r2" "$_fh_r3" "$_fh_out1" "$_fh_out2" "$_fh_out3"
  _go_idx=0
  # 注：分隔符用空格而非 |——mksh 把 pattern 里的 | 当作"或"，%%|* 会 strip 掉整个串
  for _go_spec in "$_go_sp1" "$_go_sp2" "$_go_sp3"; do
    _go_name=${_go_spec%% *}; _go_url=${_go_spec#* }
    _go_tmp="$RUNDIR/geo_download.$$.${_go_name}.tmp"
    _go_idx=$((_go_idx + 1))
    _go_final="$WORKDIR/$_go_name"
    case "$_go_name" in
      geoip.metadb) _go_hash=$_fh_h1 ;;
      geoip.dat)    _go_hash=$_fh_h2 ;;
      geosite.dat)  _go_hash=$_fh_h3 ;;
    esac
    # 本地 hash：只有拿到了远程 hash 才有可比对象；没有就直接下载，绝不白算 sha256。
    _go_local=""
    if [ -n "$_go_hash" ] && [ -f "$_go_final" ]; then
      case "$_go_cached" in
        *"sha256(${_go_name})="*)
          _go_cv=${_go_cached##*"sha256(${_go_name})="}
          _go_cv=${_go_cv%%[!0-9a-fA-F]*}
          case "$_go_cv" in
            '') ;;
            *) [ "${#_go_cv}" = "64" ] && _go_local="$_go_cv" ;;
          esac
          ;;
      esac
      [ -n "$_go_local" ] || _go_local=$(sha256_of "$_go_final")
    fi
    # 最新判断（哈希比对，跳过则免下载）：本地文件与远程 sha256 一致即跳过。
    # 取不到远程 hash（非 GitHub 源 / 设备无 sha256 工具）就放弃比对，宁可重下，
    # 也不误报「最新」。已下载那份 hash 会持久化，下次启动无需重复抓取。
    if [ -n "$_go_hash" ] && [ -n "$_go_local" ] && [ "$_go_hash" = "$_go_local" ]; then
      _go_found=$((_go_found + 1))
      _go_cache_lines="$_go_cache_lines
sha256(${_go_name})=${_go_hash}"
      echo "最新: $_go_name（sha256=$_go_hash 与本地一致，跳过下载）" >> "$GEO_LOG"
      geo_emit "downloading" "$(($_go_idx * 100 / 3))" "$_go_base" 0 "$_go_name ($_go_idx/3) · 已是最新" ""
      continue
    fi
    # 孤儿清扫只跑一次、且只在这真正要下载的第一刻：/proc 扫描慢，不能躺
    # 在开局，也不能在「已是最新」路径上白跑。
    [ "$_go_cleaned" = "1" ] || { kill_stale_fetchers; _go_cleaned=1; }
    echo "下载 [$_go_name] ($_go_idx/3) $_go_url" >> "$GEO_LOG"
    if _geo_one "$_go_url" "$_go_tmp" "$_go_name ($_go_idx/3)" "$(((_go_idx - 1) * 100 / 3))" \
       && mv "$_go_tmp" "$WORKDIR/$_go_name" 2>/dev/null; then
      if [ -n "$_go_hash" ]; then
        _go_local=$(sha256_of "$_go_final")
      else
        _go_local=""
      fi
      if [ -n "$_go_hash" ] && [ -n "$_go_local" ] && [ "$_go_hash" != "$_go_local" ]; then
        rm -f "$_go_final"
        echo "ERR: $_go_name（sha256 校验失败，远程 $_go_hash ≠ 本地 $_go_local，已丢弃）" >> "$GEO_LOG"
        _go_fail="$_go_fail $_go_name"
      else
        echo "OK: $_go_name" >> "$GEO_LOG"
        _go_cache_lines="$_go_cache_lines
sha256(${_go_name})=${_go_local}"
      fi
    else
      rm -f "$_go_tmp"
      echo "ERR: $_go_name" >> "$GEO_LOG"
      _go_fail="$_go_fail $_go_name"
    fi
    geo_emit "downloading" "$(($_go_idx * 100 / 3))" "$_go_base" 0 "" ""
  done
  # 把本轮结果落盘为下次的本地指纹缓存（无空行、最多 3 行）
  printf '%s\n' "$_go_cache_lines" | sed '/^$/d' > "$GEO_CACHE" 2>/dev/null
  # 三个文件全部「哈希一致跳 download」→ 界面显示「已是最新，无需更新」。
  # 必须先于 done 分支判断：全最新时 _go_fail 也必然为空，否则会误报成 done。
  if [ "$_go_found" = "3" ]; then
    geo_emit "uptodate" 100 "$_go_base" 0 "" ""
    echo "OK: Geo 数据已是最新（3 个文件哈希一致，无需下载）" >> "$GEO_LOG"
    rm -f "$GEO_PID"
    exit 0
  fi
  if [ -z "$_go_fail" ]; then
    geo_emit "done" 100 "$_go_base" 0 "" ""
    echo "OK: Geo 数据全部更新完成" >> "$GEO_LOG"
    rm -f "$GEO_PID"
    exit 0
  fi
  geo_emit "error" 0 "$_go_base" 0 "" "以下文件下载失败:${_go_fail}（详情见 Geo 日志）"
  rm -f "$GEO_PID"
  exit 1
}

# ---------------- 启停控制 ----------------

# 配置指纹（内核路径 + 配置内容）：与上次校验通过的一致时跳过 -t，显著加快重启
config_fingerprint() {
  if command -v md5sum >/dev/null 2>&1; then
    echo "$(core_path)|$(md5sum "$CONFIG" 2>/dev/null | cut -d' ' -f1)"
  elif have_busybox; then
    echo "$(core_path)|$("$BUSYBOX" md5sum "$CONFIG" 2>/dev/null | cut -d' ' -f1)"
  else
    echo "$(core_path)|$(ls -l "$CONFIG" 2>/dev/null | awk '{print $5}')"
  fi
}

# 等待进程退出：$1=pid $2=超时秒。
# 前 1 秒 0.05s 粒度（内核收到 SIGTERM 正常 0.2~0.6s 内退出，粗粒度轮询平均
# 白等 0.1s、最坏 0.2s），之后退回 0.2s 粒度直到超时。粒度由 nap 尽力保证，
# 总时长以 now_cs 真实时钟为上限（nap 取整成 1s 时轮数与时长解耦）。
wait_exit() {
  wp=$1; wt=$2
  if ! now_cs; then
    # 极端环境无时钟：按整秒睡到超时
    _we_i=0
    while [ "$_we_i" -lt "$wt" ] && kill -0 "$wp" 2>/dev/null; do
      sleep 1; _we_i=$((_we_i + 1))
    done
    ! kill -0 "$wp" 2>/dev/null
    return
  fi
  _we_dl=$((NOW_CS + wt * 100))
  _we_fine=$((NOW_CS + 100))
  while kill -0 "$wp" 2>/dev/null; do
    now_cs || break
    [ "$NOW_CS" -ge "$_we_dl" ] && break
    if [ "$NOW_CS" -lt "$_we_fine" ]; then nap 0.05; else nap 0.2; fi
  done
  ! kill -0 "$wp" 2>/dev/null
}

# 把指定 pid 移出 App 的 cgroup 并加 oom 保护（一次性动作，无后台循环）。
# WebUI / action.sh 拉起的内核默认留在管理器 App 的 cgroup 里，App 切后台被冻结
# 或进程被回收时会被连带冻结/清理 —— 表现为「关闭 KernelSU 后台就没网」。
# 移到根 cgroup + oom_score_adj -1000 后，内核与 App 再无瓜葛：后台冻结、划卡、
# 强行停止都影响不到它（自身崩溃不会自动重启，这是有意为之：无守护进程）。
detach_pid() {
  # $1 = pid
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null || return 1
  # 内建 read 取 cgroup v2 行（以前 cat|grep|cut 三次 fork；status 每次轮询都会经过这里）
  _dp_cg=""
  while IFS= read -r _dp_l; do
    case "$_dp_l" in 0::*) _dp_cg=${_dp_l#0::}; break ;; esac
  done 2>/dev/null < "/proc/$1/cgroup"
  [ "$_dp_cg" = "/" ] && return 0   # 已在根 cgroup，无需处理
  for _dp_p in /sys/fs/cgroup/cgroup.procs /dev/cpuctl/cgroup.procs /acct/cgroup.procs; do
    [ -w "$_dp_p" ] && echo "$1" > "$_dp_p" 2>/dev/null
  done
  echo -1000 > /proc/$1/oom_score_adj 2>/dev/null
  return 0
}

# 端口 → 四位大写十六进制（零 fork）。
# /proc/net/tcp 里的端口就是这种大写形式；以前每轮轮询都 printf 两次，
# 启动等待环 12 跳 = 24 次 fork，慢设备上白付小半秒。现在一次算好反复用。
_hex4() {
  HEX4=""
  _h4_n=$1
  _h4_i=0
  while [ "$_h4_i" -lt 4 ]; do
    case $(( ( _h4_n >> (12 - _h4_i * 4) ) & 15 )) in
      0) _h4_c=0 ;; 1) _h4_c=1 ;; 2) _h4_c=2 ;; 3) _h4_c=3 ;;
      4) _h4_c=4 ;; 5) _h4_c=5 ;; 6) _h4_c=6 ;; 7) _h4_c=7 ;;
      8) _h4_c=8 ;; 9) _h4_c=9 ;; 10) _h4_c=A ;; 11) _h4_c=B ;;
      12) _h4_c=C ;; 13) _h4_c=D ;; 14) _h4_c=E ;; 15) _h4_c=F ;;
    esac
    HEX4="$HEX4$_h4_c"
    _h4_i=$((_h4_i + 1))
  done
}

# /proc/net/tcp{,6} 扫描（纯内建读，零 fork）。$1=四位大写十六进制端口，
# $2 为空 → 0=该端口已监听/已绑定；$2=inode → 把命中条目的 socket inode 放进
# _SPS_INODE（空格分隔），能命中返回 0。语义与旧 awk 版逐条对齐：跳表头；状态取
# 末两位（8x 归一成 0x）后命中 0A（LISTEN）/07（UDP 已绑定）即算「端口在用」。
# 内核输出恒为大写十六进制（Android / OpenWrt 同），不再做小写兜底。
_sc_port_scan() {
  _sps_hex=$1; _sps_want=${2:-}
  _SPS_INODE=""
  for _sps_n in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$_sps_n" ] || continue
    while read -r _sps_a _sps_b _sps_c _sps_st _sps_q _sps_tm _sps_rt _sps_uid _sps_to _sps_ino _sps_rest; do
      case "$_sps_a" in sl|Sl|Sl:) continue ;; esac
      case "$_sps_b" in *":$_sps_hex") ;; *) continue ;; esac
      _sps_s=$_sps_st
      while [ ${#_sps_s} -gt 2 ]; do _sps_s=${_sps_s#?}; done   # 取末两位（防御异常长字段）
      case "$_sps_s" in 8*) _sps_s=0${_sps_s#?} ;; esac
      case "$_sps_s" in
        0A|07)
          if [ "$_sps_want" = inode ]; then
            _SPS_INODE="$_SPS_INODE $_sps_ino"
          else
            return 0
          fi ;;
      esac
    done < "$_sps_n"
  done
  [ "$_sps_want" = inode ] || return 1
  _SPS_INODE=${_SPS_INODE# }
  [ -n "$_SPS_INODE" ]
}

# 端口监听判定。$1=端口数字 → 0=已监听（TCP LISTEN 0A 或 UDP 已绑定 07）
_sc_port_listening() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  _hex4 "$1"
  _sc_port_scan "$HEX4"
}

# 从 config.yaml 解析 external-controller 端口（兼容 0.0.0.0:9090 / :9090 / [::]:9090 / http://...）
_sc_ctl_port() {
  _scp_raw=$(grep -E '^external-controller:' "$CONFIG" 2>/dev/null | awk '{print $2}' | tr -d '"' | head -1)
  _scp_raw=${_scp_raw##*://}
  _scp_p=${_scp_raw##*:}
  # 去掉端口后可能残留的非数字（如尾随注释，已被 awk 截掉，但仍兜底）
  _scp_p=$(printf '%s' "$_scp_p" | tr -cd '0-9')
  case "$_scp_p" in ''|*[!0-9]*) echo "" ;; *) echo "$_scp_p" ;; esac
}

# 启停性能追踪：只读 /proc/uptime，阶段时间使用单调时钟，不依赖 date/网络。
action_clock() {
  _ac_u=0; read -r _ac_u _ac_rest < /proc/uptime
  _ac_s=${_ac_u%%.*}; _ac_f=${_ac_u#*.}000
  _ac_f=${_ac_f%"${_ac_f#???}"}
  ACTION_MS=$((_ac_s * 1000 + 1$_ac_f - 1000))
}
action_mark() {
  [ -n "${MH_ACTION_TRACE:-}" ] || return 0
  action_clock
  printf '%s %s\n' "$((ACTION_MS - MH_ACTION_BEGIN))" "$1" >> "$MH_ACTION_TRACE"
}
# 非必要的描述同步与缓存清理不再陪跑 action ACK；后台任务关闭全部标准流并脱离会话。
lifecycle_tail_queue() {
  [ "${_LC_DEPTH:-0}" = "0" ] || return 0
  rm -f "$BOOT_DATA_CACHE" "$LIVE_STATUS" "$LIVE_STATUS_AT" 2>/dev/null
  if command -v setsid >/dev/null 2>&1; then
    setsid sh "$0" _lifecycle-tail </dev/null >/dev/null 2>&1 &
  else
    nohup sh "$0" _lifecycle-tail </dev/null >/dev/null 2>&1 &
  fi
  return 0
}

# 生命周期互斥：并发仅用于独立工作，不能同时启动两份内核或互相改配置。
# 不排队阻塞 UI；忙时明确返回，死进程遗留的锁下次回收。
lifecycle_enter() {
  if [ "${_LC_DEPTH:-0}" -gt 0 ]; then
    _LC_DEPTH=$((_LC_DEPTH + 1)); return 0
  fi
  _lc_lock="$RUNDIR/lifecycle.lock"
  if ! mkdir "$_lc_lock" 2>/dev/null; then
    _lc_owner=""
    [ -r "$_lc_lock/pid" ] && IFS= read -r _lc_owner < "$_lc_lock/pid"
    case "$_lc_owner" in
      ''|*[!0-9]*)
        # mkdir 后、pid 写入前崩溃的无主锁；保留 5s 防止误删正在写入的锁。
        _lc_mtime=$(stat -c %Y "$_lc_lock" 2>/dev/null)
        _lc_now=$(date +%s)
        case "$_lc_mtime" in ''|*[!0-9]*) return 1 ;; esac
        [ "$((_lc_now - _lc_mtime))" -ge 5 ] || { echo "ERR_BUSY: 服务操作正在进行，请稍后重试"; return 1; }
        _lc_owner=0 ;;
    esac
    if [ "$_lc_owner" != "0" ] && kill -0 "$_lc_owner" 2>/dev/null; then
      echo "ERR_BUSY: 服务操作正在进行，请稍后重试"; return 1
    fi
    rm -rf "$_lc_lock" 2>/dev/null
    mkdir "$_lc_lock" 2>/dev/null || { echo "ERR_BUSY: 服务操作正在进行"; return 1; }
  fi
  echo "$$" > "$_lc_lock/pid"
  _LC_DEPTH=1
  MH_LIFECYCLE_EVENT=1
}
lifecycle_leave() {
  _LC_DEPTH=$((_LC_DEPTH - 1))
  if [ "$_LC_DEPTH" -eq 0 ]; then
    _lc_owner=""
    [ -r "$RUNDIR/lifecycle.lock/pid" ] && IFS= read -r _lc_owner < "$RUNDIR/lifecycle.lock/pid"
    [ "$_lc_owner" = "$$" ] && rm -rf "$RUNDIR/lifecycle.lock" 2>/dev/null
  fi
  return 0
}
start_core() {
  lifecycle_enter || return 1
  _start_core_body "$@"; _lc_start_rc=$?
  lifecycle_leave
  lifecycle_tail_queue
  return "$_lc_start_rc"
}
stop_core() {
  lifecycle_enter || return 1
  _stop_core_body "$@"; _lc_stop_rc=$?
  lifecycle_leave
  lifecycle_tail_queue
  return "$_lc_stop_rc"
}
restart_core() {
  lifecycle_enter || return 1
  _restart_core_body "$@"; _lc_restart_rc=$?
  lifecycle_leave
  lifecycle_tail_queue
  return "$_lc_restart_rc"
}
tproxy_apply() {
  lifecycle_enter || return 1
  _tproxy_apply_body "$@"; _lc_apply_rc=$?
  lifecycle_leave
  lifecycle_tail_queue
  return "$_lc_apply_rc"
}

# 切到 Tproxy 之后：等内核把 TPROXY 端口挂起来、把规则装好再返回（有界）。
#
# 为什么需要：restart-json tproxy 以前一返回就报「已切换」，而规则是由 start_core
# 的后台收敛循环装的；那个循环只覆盖约 6 秒，端口晚一点就绪就整段落空，下一次
# 自动补救要等监听循环 ~60 秒的稳态兜底轮 —— 用户看到的就是「切到 Tproxy 之后
# 很久才真正生效」，期间流量既没被接管、外部面板的连接也拿不到控制器。
# 这里把「切换完成」和「规则已装」对齐：先等端口（≤3s）再对账一次；仍没装上就
# 后台每 1 秒追一次（最多 30s），远比等 60 秒的兜底轮快。
tproxy_ready_wait() {
  _tr_port=$(tproxy_detect 2>/dev/null | awk '{print $1}')
  _tr_i=0
  if [ -n "$_tr_port" ]; then
    now_cs
    if [ "$NOW_CS" -gt 0 ]; then _tr_dl=$((NOW_CS + 300)); else _tr_dl=0; fi
    while [ "$_tr_i" -lt 30 ]; do
      tproxy_port_listening "$_tr_port" 2>/dev/null && break
      if [ "$_tr_dl" != "0" ]; then now_cs; [ "$NOW_CS" -ge "$_tr_dl" ] && break; fi
      nap 0.1
      _tr_i=$((_tr_i + 1))
    done
  fi
  tproxy_sync >/dev/null 2>&1
  # 规则可能不是「这一次」装上的：start_core 的后台对账往往已经抢到对账锁在装
  # （抢不到锁的 tproxy_sync 会立刻返回），而 TUN→Tproxy 互切时那轮对账还要先
  # 收尾 TUN 残留。以前只尝试一次就往下走，界面已经报「已切换」，规则却还在别人
  # 手里装——用户看到的就是「切过去好几秒才真的接管」。这里改成真正等到接管规则
  # 落地：以 TP_STATE 出现为准（谁装的都算），期间按真实时钟有界等待（≤2s），
  # 每 0.5s 补一次对账（对账幂等，装好即停）。
  if [ ! -f "$TP_STATE" ]; then
    _tr_k=0
    now_cs
    if [ "$NOW_CS" -gt 0 ]; then _tr_dl2=$((NOW_CS + 200)); else _tr_dl2=0; fi
    while [ "$_tr_k" -lt 20 ]; do
      [ -f "$TP_STATE" ] && break
      if [ "$_tr_dl2" != "0" ]; then now_cs; [ "$NOW_CS" -ge "$_tr_dl2" ] && break; fi
      nap 0.1
      _tr_k=$((_tr_k + 1))
      case $_tr_k in 5|10|15) tproxy_sync >/dev/null 2>&1 ;; esac
    done
  fi
  if [ -f "$TP_STATE" ]; then
    tp_log "mode-switch: 规则已就绪 port=${_tr_port:-?}（等待 ${_tr_i} 轮 / 追装 ${_tr_k:-0} 轮）"
    return 0
  fi
  tp_log "mode-switch: 端口/规则尚未就绪（port=${_tr_port:-?}），后台每秒追一次"
  ( _tr_j=0
    while [ "$_tr_j" -lt 30 ]; do
      tproxy_sync >/dev/null 2>&1
      if [ -f "$TP_STATE" ]; then
        tp_log "mode-switch: 规则就绪（后台追上，第 $((_tr_j + 1)) 次）"
        sh "$0" live-invalidate >/dev/null 2>&1
        break
      fi
      nap 1
      _tr_j=$((_tr_j + 1))
    done
  ) </dev/null >/dev/null 2>&1 &
  return 0
}

# 每次启动（含外部替换 config.yaml 后重启）都重放透明模式互斥。
# TProxy 开关优先；否则只按新配置，TUN/eBPF 同开时 TUN 优先并提示。
# 指纹变化时更新 TProxy 还原记录，不能拿旧配置的 tun_before 去修改新配置。
prepare_proxy_mode() {
  [ -f "$CONFIG" ] || { echo "ERR_CONFIG: config.yaml 不存在"; return 1; }
  case "${1:-}" in
    tproxy)
      _pm_det=$(tproxy_detect); _pm_port=${_pm_det%% *}
      [ -n "$_pm_port" ] || { echo "ERR_CONFIG: 请先在配置 → 入站设置 TProxy 端口"; return 1; }
      _pm_tp_before=$(cfg_tun_set_enable false) || return 1
      _pm_tp_marked=$(cfg_comment_tun_listeners) || return 1
      cfg_ebpf_set_enabled false >/dev/null || return 1
      return 0 ;;
    tun)
      tunhs_tun_enabled || { echo "ERR_CONFIG: 请求 TUN，但已保存配置未启用 TUN"; return 1; }
      cfg_ebpf_set_enabled false >/dev/null || return 1
      return 0 ;;
    ebpf)
      ebpf_listener_active || { echo "ERR_CONFIG: 请求 eBPF，但已保存配置未启用 eBPF"; return 1; }
      cfg_tun_set_enable false >/dev/null || return 1
      cfg_comment_tun_listeners >/dev/null || return 1
      return 0 ;;
    '') ;;
    *) echo "ERR: 模式只能是 tun / ebpf / tproxy"; return 1 ;;
  esac
  if [ "$(get_setting tproxy false)" = "true" ]; then
    _pm_det=$(tproxy_detect)
    _pm_port=${_pm_det%% *}
    [ -n "$_pm_port" ] || { echo "ERR_CONFIG: Tproxy 已开启，但新配置没有 TProxy 端口；请关闭 Tproxy 或补充端口"; return 1; }
    _pm_fp=$(config_fingerprint)
    _pm_saved=$(cat "$RUNDIR/tproxy.config.fp" 2>/dev/null)
    if [ ! -f "$TP_CFG" ] || { [ -n "$_pm_saved" ] && [ "$_pm_fp" != "$_pm_saved" ]; } ||
       { [ -z "$_pm_saved" ] && { tunhs_tun_enabled || ebpf_listener_active; }; }; then
      _pm_before=$(cfg_tun_set_enable false) || return 1
      _pm_marked=$(cfg_comment_tun_listeners) || return 1
      cfg_ebpf_set_enabled false >/dev/null || return 1
      printf 'tun_before=%s\nlistener_marked=%s\nport=%s\n' "$_pm_before" "$_pm_marked" "$_pm_port" > "$TP_CFG" || return 1
    else
      cfg_tun_set_enable false >/dev/null || return 1
      cfg_comment_tun_listeners >/dev/null || return 1
      cfg_ebpf_set_enabled false >/dev/null || return 1
    fi
    config_fingerprint > "$RUNDIR/tproxy.config.fp"
  elif tunhs_tun_enabled && ebpf_listener_active; then
    cfg_ebpf_set_enabled false >/dev/null || return 1
    echo "WARN: 配置同时启用 TUN/eBPF，已保留 TUN 并关闭 eBPF 角色开关"
  fi
  return 0
}

# ---------------- 热重启残留内核清扫 ----------------
# 现象：热重启（软重启，只重启 Android 框架层）后出现两份内核，代理不通。
# 原因：冷重启时进程必死，post-fs-data.sh 据此每次开机清掉 run/core.pid；但热重启
# 不会杀 detach 到根 cgroup、oom_score_adj=-1000 的内核——pid 文件已删而进程还
# 活着，开机 service.sh → boot → start_core 看 pid 文件为空就再拉一份：新旧两份
# 内核并存，后启动的抢不到 TUN 设备/控制器端口，表现为「进程在跑、CPU 双份、
# 代理不通」。因此启动/停止都要按 /proc cmdline 扫一遍本模块内核（core/ 下三种
# 内核名都算，裸启动与 busybox setuidgid 包装启动都能命中），有残留先杀干净——
# 启动幂等，热重启多少次也只会有一个内核实例。
# 匹配语义与旧版 _stop_core_body 兜底清扫一致（锚定，防止误杀）：cmdline 以内核
# 路径开头（setsid exec 后的裸启动形态），或含「setuidgid <uid:gid> 内核路径」
# （Tproxy 模式的 busybox 包装形态，个别 busybox 版本 setuidgid 不 exec、路径
# 留在参数里）。仅是「参数文本里引用了内核路径」的无关进程不会被误杀。
# 实现：纯内建读 /proc（零 fork）。
#   · 先读 comm（<=15 字节，内核只保留文件名前缀）：三种内核名都以 mihomo- 开头，
#     一次读就能筛掉 99% 的无关进程，且不需要 pgrep；
#   · comm 命中后再读 cmdline 核对 $COREDIR 路径，避免误杀同名无关进程；
#   · 每种内核名长度不同，comm 被截断也没关系（只看前缀）。
# 为什么不用 pgrep：Android 的 toybox pgrep -f 要对每个进程做完整 cmdline 匹配，
# 慢设备上单次 30~80ms，而这段代码在每次 start/stop 的关键路径上；系统缺 pgrep
# 时的旧兜底更是逐进程 fork 一个 tr（300+ 次 fork，秒级）。全内建扫一遍约 300 次
# read，通常 <20ms。
core_stale_pids() {
  _csp_out=""
  for _csp_p in /proc/[0-9]*; do
    _csp_n=${_csp_p#/proc/}
    [ "$_csp_n" = "$$" ] && continue
    _csp_comm=""
    IFS= read -r _csp_comm 2>/dev/null < "$_csp_p/comm" || continue
    case "$_csp_comm" in mihomo-*) ;; *) continue ;; esac
    _csp_cmd=""
    IFS= read -r _csp_cmd 2>/dev/null < "$_csp_p/cmdline" || continue
    case "$_csp_cmd" in
      "$COREDIR/mihomo-"*) ;;
      *"setuidgid"*"$COREDIR/mihomo-"*) ;;
      *) continue ;;
    esac
    _csp_out="$_csp_out $_csp_n"
  done
  _csp_out=${_csp_out# }
  [ -n "$_csp_out" ] && printf '%s\n' "$_csp_out"
  return 0
}

core_sweep_stale() {
  _css_pids=$(core_stale_pids)
  [ -n "$_css_pids" ] || return 0
  echo "WARN: 检测到热重启残留的内核进程 (pid:$_css_pids)，先清理再继续"
  kill $_css_pids 2>/dev/null
  # 0.8s 预算（与 _stop_core_body 的 TERM→KILL 上限一致）等旧内核退出，
  # 以 now_cs 真实时钟为准（nap 在 ceil 模式每轮睡 1s，不能按轮数推算）
  now_cs
  if [ "$NOW_CS" -gt 0 ]; then _css_dl=$((NOW_CS + 80)); else _css_dl=0; fi
  _css_ticks=0
  while :; do
    _css_alive=0
    for _css_pid in $_css_pids; do pid_is_live "$_css_pid" && _css_alive=1; done
    [ "$_css_alive" = "0" ] && break
    [ "$_css_dl" = "0" ] && [ "$_css_ticks" -ge 16 ] && break
    if [ "$_css_dl" != "0" ]; then
      now_cs
      [ "$NOW_CS" -ge "$_css_dl" ] && break
    fi
    nap 0.05; _css_ticks=$((_css_ticks + 1))
  done
  _css_alive=0
  for _css_pid in $_css_pids; do pid_is_live "$_css_pid" && _css_alive=1; done
  if [ "$_css_alive" = "1" ]; then
    kill -9 $_css_pids 2>/dev/null
    # SIGKILL 后短暂等它真正消失（端口随进程死亡释放），不让新内核撞上 bind
    _css_ticks=0
    while :; do
      _css_alive=0
      for _css_pid in $_css_pids; do pid_is_live "$_css_pid" && _css_alive=1; done
      [ "$_css_alive" = "0" ] && break
      [ "$_css_ticks" -ge 8 ] && break
      nap 0.05; _css_ticks=$((_css_ticks + 1))
    done
    echo "WARN: 残留内核未响应 SIGTERM，已 SIGKILL (pid:$_css_pids)"
  fi
  return 0
}

_start_core_body() {
  core=$(core_path)
  if [ ! -x "$core" ]; then
    echo "ERR_NO_CORE: 内核不存在，请先在 WebUI「内核管理」中下载内核"
    return 1
  fi
  # 短路也要验明正身：core.pid 跨重启残留被无关进程复用时，只看 kill -0
  # 会把复用者当成内核、整个开机周期不再启动（running() 是高频热路径，
  # 身份核对只放在这个低频决策点上做，不拖慢状态轮询）
  if running; then
    _sc_rp=$(pid_of)
    if [ -r "/proc/$_sc_rp/cmdline" ] && grep -qa "$COREDIR/mihomo-" "/proc/$_sc_rp/cmdline" 2>/dev/null; then
      echo "已在运行 (pid $_sc_rp)"; return 0
    fi
    rm -f "$PIDFILE" 2>/dev/null   # 残留 pid（进程已死或数字被复用）：清掉再正常启动
  fi
  # 热重启（软重启）防双实例：core.pid 已被 post-fs-data.sh 清掉，但上一会话的
  # 内核在热重启里不会死——按 core/ 路径扫 /proc，有残留先杀干净再拉新。
  # 无残留时 pgrep 一次即返回，代价可忽略；校验/端口检查都在其后，时序安全。
  core_sweep_stale
  action_mark mode_begin
  prepare_proxy_mode || return 1
  action_mark mode_done
  ulimit -n 65535 2>/dev/null
  # 主页 res 轮询看到这个文件就会显示「启动中」，不必等校验/pid 文件。
  # 所有失败/成功出口都要清掉，避免停住后一直显示启动中。
  : > "$RUNDIR/starting" 2>/dev/null
  # 启动时不自动下载 Geo 数据（含首次启动）；
  # 需要 Geo 时请在 WebUI「内核管理」中手动点击下载。
  # 配置校验（指纹未变则跳过，重启可省一次完整校验）
  # 开机自启的重试轮次可跳过校验（MH_SKIP_VERIFY=1）：上一轮死在「校验超时」时，
  # 说明是开机忙导致 -t 跑不完，而不是配置有错；真有错内核拉起即退，照样被判失败。
  # 校验与系统 IPv6 准备互不写 config，并发执行；exec 前必须等待两路完成。
  ( if [ "${MH_SKIP_VERIFY:-0}" != "1" ]; then verify_config; fi ) > "$RUNDIR/start-verify.log" 2>&1 &
  _sc_verify_pid=$!
  action_mark verify_started
  if [ "${MH_SKIP_IPV6:-0}" != "1" ]; then
    action_mark ipv6_begin
    system_ipv6_sync >/dev/null 2>&1
    action_mark ipv6_done
  fi
  wait "$_sc_verify_pid"; _sc_verify_rc=$?
  action_mark verify_done
  cat "$RUNDIR/start-verify.log" 2>/dev/null
  if [ "$_sc_verify_rc" != "0" ]; then
    rm -f "$RUNDIR/starting" 2>/dev/null
    return 1
  fi
  # 状态读取运行时快照，不把尚未重启的新磁盘配置说成当前内核状态。
  cp "$CONFIG" "$RUNDIR/active-config.yaml.tmp" &&
    mv -f "$RUNDIR/active-config.yaml.tmp" "$RUNDIR/active-config.yaml" || {
      rm -f "$RUNDIR/starting"; echo "ERR: 无法保存运行时配置快照"; return 1;
    }
  reset_log "$LOGFILE"          # 内核每次 start/restart 都从本次启动记起
  # Tproxy 模式下用 root:net_admin(0:3005) 身份拉起内核：TPROXY 规则的 OUTPUT
  # 链按 --gid-owner 3005 精确旁路内核自身流量（netd 等其它 root 进程的 DNS
  # 仍会被接管）。busybox setuidgid 不可用时保持裸 root（旁路退化为 uid 0）。
  _sc_pre=""
  if [ "$(get_setting tproxy false)" = "true" ] && have_busybox && applet_has "$BUSYBOX" setuidgid; then
    _sc_pre="$BUSYBOX setuidgid $TP_CORE_UG"
  fi
  # 启动成功的判据（决定 start/restart 要等多久）：
  #   · 配置有 external-controller 且该端口在拉起前空闲 → 端口一旦 LISTEN 即判成功。
  #     内核只有把配置完整解析通过（绝大多数「起不来」都死在这一步）才会开 API 端口，
  #     之后的入站/TUN 失败只记错误日志、进程不退出。所以「端口已开」比「活了 1.2s」
  #     更准也更快：慢设备通常 0.3~0.6s 就绪，不再固定干等 1.2s。
  #   · 无 external-controller、或端口拉起前已被占用（无法据此分辨是不是我们的进程）
    #     → 退回「连续存活 ≥1.2s」的老判据。
    #   · 连存活判据（1.2s）现在对两种情况都兜底：端口判定若在个别内核/rom 上
    #     不可用（/proc 格式差异等），不再干等 4s 上限，1.2s 活着就按成功返回——
    #     与老判据同等置信度。总开关最坏 1.2s 就能看到结果；期间进程一退出立刻判失败。
  _sc_port=$(_sc_ctl_port)
  # 就绪判据（照 Mishka 的思路：「便宜的本机事实」当判据，昂贵的判活尽量少做）：
  #   拉起前记下该端口上所有 LISTEN 条目的 socket inode（一次 /proc 扫描，零 fork），
  #   拉起后一旦出现「不属于这批旧 inode」的 LISTEN 条目，就一定是本次内核开的端口
  #   —— 立刻判就绪。以前只要「拉起前端口已在监听」就整轮退回「存活 ≥1.2s」的
  #   粗判据（重载时旧内核刚退出、端口处于半关状态就会命中这条路径），白白多等
  #   1.2 秒；现在端口被谁占着都不影响判断。
  _sc_hx=""
  [ -n "$_sc_port" ] && { _hex4 "$_sc_port"; _sc_hx=$HEX4; }
  _sc_ino_before=""
  if [ -n "$_sc_hx" ] && _sc_port_scan "$_sc_hx" inode; then _sc_ino_before=" $_SPS_INODE "; fi
  # core.log 是追加写：老内核留下的错误会一直留在文件里。记下当前字节数，
  # ipv6_proxy_guard 只读这之后的增量，避免拿上一次的报错误判本次启动失败。
  { stat -c %s "$LOGFILE" 2>/dev/null || echo 0; } > "$LOGFILE.off" 2>/dev/null
  # setsid 让内核脱离 WebUI 的会话/进程组（管理器被系统回收时不会连带杀掉），不存在时回退 nohup
  if command -v setsid >/dev/null 2>&1; then
    setsid $_sc_pre "$core" -d "$WORKDIR" -f "$CONFIG" </dev/null >> "$LOGFILE" 2>&1 &
  else
    nohup $_sc_pre "$core" -d "$WORKDIR" -f "$CONFIG" </dev/null >> "$LOGFILE" 2>&1 &
  fi
  pid=$!
  action_mark core_spawned
  echo "$pid" > "$PIDFILE"
  rm -f "$RUNDIR/starting" 2>/dev/null
  t=0; alive=0
  # 网络匹配只要进程活着就让主页切到运行中，不再干等控制器端口 1.2s。
  if [ "${MH_QUICK_START:-0}" = "1" ]; then
    kill -0 "$pid" 2>/dev/null && alive=1
  fi
  # 时限全部以 now_cs 真实时钟为准（nap 取整成 1s 时轮数与时长解耦）。
  # 轮询节奏：前 600ms 用 20ms 细粒度，之后退到 100ms 直到兜底上限。
  # 600ms 而不是更短，是因为真机上内核开控制器端口通常落在 0.3~0.6s：
  # 细粒度的每次探测只是读 /proc/net/tcp（纯内建、约 2ms、零 fork），
  # 拿它换「就绪判定不多等半个 100ms 间隔」是稳赚的；超过 600ms 仍没就绪
  # 说明是慢启动（大配置/拉 provider），这时再把节奏放粗，别空转烧 CPU。
  if now_cs; then
    _sc_dl=$((NOW_CS + 400))          # 4s 绝对上限
    _sc_dl12=$((NOW_CS + 120))        # 1.2s 存活兜底（端口判定不可用时）
  else
    _sc_dl=0; _sc_dl12=0
  fi
  while [ "$alive" != "1" ]; do
    kill -0 "$pid" 2>/dev/null || break                   # 进程已退出：立即判失败
    if [ -n "$_sc_hx" ] && _sc_port_scan "$_sc_hx" inode; then
      # 新出现的 inode = 本次内核的 listener
      for _sc_i in $_SPS_INODE; do
        case "$_sc_ino_before" in
          *" $_sc_i "*) ;;                                # 拉起前就有的旧 listener，不是我们的
          *) alive=1; break ;;
        esac
      done
      [ "$alive" = "1" ] && break
    fi
    if [ "$_sc_dl" = "0" ]; then
      [ $t -ge 12 ] && { alive=1; break; }                # 无时钟兜底：存活 ≥1.2s（旧判据）
    else
      now_cs
      [ "$NOW_CS" -ge "$_sc_dl" ] && { alive=1; break; }   # 存活 ≥4s：无条件兜底判成功
      [ "$NOW_CS" -ge "$_sc_dl12" ] && { alive=1; break; } # 存活 ≥1.2s：无条件兜底判成功（含端口判定不可用的场景）
    fi
    if [ $t -lt 30 ]; then nap 0.02; else nap 0.1; fi; t=$((t + 1))
  done
  # 到达上限仍存活：视为启动成功（配置特别大/首次拉取 provider 的慢启动场景）
  [ "$alive" = "0" ] && kill -0 "$pid" 2>/dev/null && alive=1
  if [ "$alive" = "1" ] && kill -0 "$pid" 2>/dev/null; then
    action_mark core_ready
    setting_v core jieluojun; core_label_v "$SV"
    echo "OK: mihomo 已启动 (pid $pid) [$CLV]"
    live_invalidate 2>/dev/null
    detach_pid "$pid"
    # CPU 基线预置（见 _cpu_baseline_seed）：随后 start-json 带回的状态 / UI 首次读数
    # 直接算出占用率，界面不再停在「CPU …」等一拍心跳
    _cpu_baseline_seed "$pid" 2>/dev/null
    # TUN 热点转发规则 + Tproxy 规则对账（后台重试几秒：TUN 网卡/TProxy 端口
    # 随内核启动就绪，期间每次对账幂等，就绪即装上；开关监听循环还会兜底）。
    # 只在真正用得上时才起这个循环：配置里没开 TUN 且 Tproxy 开关关着时，两路
    # 对账都是空转，却要重复拉起 24 个 shell 进程解析本脚本——恰好与前端刷新
    # 状态抢 CPU。用得上时也按「装好即停」：状态文件一出现（规则已装）就退出。
    # 某一路「开着」或「留有状态文件」（restart 保留的旧规则 / 功能刚被关掉）才对账；
    # 两路都空的常见情形（eBPF 接管、无 Tproxy）一次 shell 都不起。
    _sc_tun_on=0; _sc_tp_on=0
    tunhs_tun_enabled && _sc_tun_on=1
    [ "$(get_setting tproxy false)" = "true" ] && _sc_tp_on=1
    _sc_do_tun=$_sc_tun_on; _sc_do_tp=$_sc_tp_on
    [ -f "$TUNHS_STATE" ] && _sc_do_tun=1
    [ -f "$TP_STATE" ] && _sc_do_tp=1
    # 两路对账一个「装」一个「拆」时不再并行，装的那一路先跑完：
    # 模式互切（TUN→Tproxy / Tproxy→TUN）时，被关掉那一路只剩「清残留」——它的
    # 几十次 iptables -D / ip rule del 与装配那一路抢同一把内核 xtables 锁
    # （-w 等锁）和 CPU，装配被拖慢，用户看到的就是「切过去之后还要等一会儿
    # 才真的接管」。残留清理晚几百毫秒毫无影响（对应网卡/端口已不存在，规则
    # 挂着也不转发流量），所以让装配先独占锁跑完，再做清理。
    # 两路同态（都装 / 都只清理）时保持并行，语义不变。
    _sc_seq=none
    if [ "$_sc_do_tun" = "1" ] && [ "$_sc_do_tp" = "1" ]; then
      if [ "$_sc_tp_on" = "1" ] && [ "$_sc_tun_on" = "0" ]; then _sc_seq=tp
      elif [ "$_sc_tun_on" = "1" ] && [ "$_sc_tp_on" = "0" ]; then _sc_seq=tun
      fi
    fi
    # 系统 IPv6 开着时，代理侧 v6 初始化失败会让 TUN/eBPF 静默起不来（内核照跑、
    # 流量整段绕过代理）。这里挂一次后台守卫：发现失败就回退成仅 IPv4 代理并重启，
    # 详见 ipv6_proxy_guard 的注释。
    if [ "$(get_setting system_ipv6 false)" = "true" ]; then
      ( sh "$0" ipv6-guard ) </dev/null >/dev/null 2>&1 &
    fi
    if [ "$_sc_do_tun" = "1" ] || [ "$_sc_do_tp" = "1" ]; then
      ( _i=0
        while [ $_i -lt 12 ]; do
          if [ "$_sc_seq" = tp ]; then
            ( tproxy_sync ) >/dev/null 2>&1
            ( tun_hotspot_sync ) >/dev/null 2>&1
          elif [ "$_sc_seq" = tun ]; then
            ( tun_hotspot_sync ) >/dev/null 2>&1
            ( tproxy_sync ) >/dev/null 2>&1
          else
            ( [ "$_sc_do_tun" = "1" ] && tun_hotspot_sync ) >/dev/null 2>&1 &
            _sc_tun_job=$!
            ( [ "$_sc_do_tp" = "1" ] && tproxy_sync ) >/dev/null 2>&1 &
            _sc_tp_job=$!
            wait "$_sc_tun_job"; wait "$_sc_tp_job"
          fi
          # 收敛即停：开着的功能规则已装（状态文件已写）、关着的功能状态已清
          _sc_ok=1
          if [ "$_sc_do_tun" = "1" ]; then
            if [ "$_sc_tun_on" = "1" ]; then [ -f "$TUNHS_STATE" ] || _sc_ok=0; else [ -f "$TUNHS_STATE" ] && _sc_ok=0; fi
          fi
          if [ "$_sc_do_tp" = "1" ]; then
            if [ "$_sc_tp_on" = "1" ]; then [ -f "$TP_STATE" ] || _sc_ok=0; else [ -f "$TP_STATE" ] && _sc_ok=0; fi
          fi
          if [ "$_sc_ok" = "1" ]; then
            break
          fi
          nap 0.5; _i=$((_i+1))
        done
      ) </dev/null >/dev/null 2>&1 &
    fi
    return 0
  else
    echo "ERR: 启动失败，最后日志:"
    tail -8 "$LOGFILE"
    rm -f "$RUNDIR/starting" 2>/dev/null
    return 1
  fi
}

# $1 = keep：重启专用——内核马上会被重新拉起，接管规则（TUN 热点转发 / Tproxy）
# 原样保留给随后的 start_core 对账（规则只引用网卡名/端口/gid，重启前后不变，
# 省掉一拆一装两轮 iptables/ip 调用；Tproxy 规则留着也符合其 grace 设计——
# 重载窗口宁可短暂不通，不让流量绕过内核直连）。调用方必须保证：start 失败时
# 自己补一次对账拆规则（见 restart_core）。
_stop_core_body() {
  _st_keep=$1
  _st_unhook_done=0
  # 用户主动停止（非重启）：通知开机自启保障别再把内核拉起来
  [ "$_st_keep" = "keep" ] || : > "$RUNDIR/boot.cancel" 2>/dev/null
  rm -f "$RUNDIR/starting" 2>/dev/null
  if running; then
    pid=$(pid_of)
    action_mark stop_signal
    kill "$pid" 2>/dev/null
    # 非重启先摘 TProxy 跳转，同时等待内核退出，避免流量继续指向死端口。
    ( [ "$_st_keep" != "keep" ] && [ -f "$TP_STATE" ] && tproxy_unhook_quick ) >/dev/null 2>&1 &
    _st_unhook_pid=$!
    _st_ticks=0
    # 0.8s 上限以 now_cs 真实时钟为准：SIGTERM 后内核正常 0.2~0.6s 退出，
    # 超时补 SIGKILL（nap 在 ceil 模式每轮睡 1s，不能按轮数推算时长）
    now_cs
    if [ "$NOW_CS" -gt 0 ]; then _st_dl=$((NOW_CS + 80)); else _st_dl=0; fi
    while pid_is_live "$pid"; do
      [ "$_st_dl" = "0" ] && [ "$_st_ticks" -ge 16 ] && break
      if [ "$_st_dl" != "0" ]; then
        now_cs
        [ "$NOW_CS" -ge "$_st_dl" ] && break
      fi
      # 前 200ms 用 20ms 粒度：内核收到 SIGTERM 普遍在 0.2~0.6s 内退出，
      # 50ms 粒度在「重载」里平均多等 25ms、最坏 50ms，白付在每一次重启上。
      if [ "$_st_ticks" -lt 10 ]; then nap 0.02; else nap 0.05; fi
      _st_ticks=$((_st_ticks + 1))
    done
    if pid_is_live "$pid"; then
      kill -9 "$pid" 2>/dev/null
    fi
    action_mark core_stopped
    wait "$_st_unhook_pid" 2>/dev/null
    action_mark unhook_done
    _st_unhook_done=1
    rm -f "$PIDFILE"
  fi
  # 兜底清理：正常路径 1 秒内已退出，无残留；但热重启后 core.pid 已被
  # post-fs-data.sh 清掉而旧内核还活着——running 为假也必须按 /proc 扫一遍，
  # 否则「停止」对残留实例完全失效（表现为关了开关流量仍被旧内核接管）。
  # core_sweep_stale 按 core/ 路径匹配 cmdline，裸内核与 Tproxy 模式下经
  # busybox setuidgid 0:3005 包装启动（cmdline 以 busybox 开头）都能命中。
  core_sweep_stale
  rm -f "$PIDFILE"
  if [ "$_st_keep" = "keep" ]; then
    :   # 重启：规则留给 start_core 对账
  else
    # —— 总开关返回提速：停机后不再同步干等整轮拆除（慢设备上 tunhs+tproxy
    # 全量拆除是 60~100 次串行 iptables/ip 调用，总开关要卡 2~4 秒）——
    # ① 同步只做「摘跳转」：tproxy 的 mangle PREROUTING/OUTPUT 跳转是内核死后
    #    唯一仍会把系统流量导向死端口的规则，先删掉（几条 -D，亚秒级）；跳转
    #    一摘，链不可达、fwmark 策略路由无人打标记自动失活，返回时网络已通。
    # ② 其余全是无流量影响的清理（TUN FORWARD/8995 带、链删除、路由表、状态
    #    文件、残留扫描），放后台全量对账收尾：对账是收敛式——按调用时的实际
    #    运行状态算期望终态，与「停完立刻再启动」的竞态天然安全（内核重新在跑
    #    时期望算回 on，规则照装）；开关监听循环的周期对账照旧兜底。
    [ "$_st_unhook_done" = "1" ] || { [ -f "$TP_STATE" ] && tproxy_unhook_quick; }
    ( tun_hotspot_sync ) </dev/null >/dev/null 2>&1 &
    ( tproxy_sync ) </dev/null >/dev/null 2>&1 &
  fi
  live_invalidate 2>/dev/null
  echo "OK: 已停止"
  return 0
}

# 重启 = keep 模式停止 + 启动；启动失败时补一次全量对账，把保留下来的接管规则拆掉
# （Tproxy 规则指向已死端口等于断网，绝不能留到监听循环的下一轮——先摘跳转断开
# 流量导向，再全量清理）。
_restart_core_body() {
  _rc_mode=${1:-}
  _rc_keep_tp_cfg=0
  if [ "$_rc_mode" = tproxy ]; then
    # 能力探测不通过时不写设置、不改配置，也不停止旧内核；单独记时，
    # 诊断里可以区分「探测/等 xtables 锁」与「新核启动/规则落地」耗时。
    action_mark tproxy_probe_begin
    tproxy_probe || return 1
    action_mark tproxy_probe_done
    if [ "$(get_setting tproxy false)" = true ] && [ -f "$TP_CFG" ] &&
       [ "$(config_fingerprint)" = "$(cat "$RUNDIR/tproxy.config.fp" 2>/dev/null)" ]; then
      _rc_keep_tp_cfg=1
    fi
  fi
  # 新配置校验失败时不杀死仍可用的旧内核。
  action_mark mode_begin
  prepare_proxy_mode "$_rc_mode" || return 1
  action_mark mode_done
  action_mark restart_verify_begin
  if [ "${MH_SKIP_VERIFY:-0}" != "1" ]; then verify_config || return 1; fi
  action_mark restart_verify_done
  # 仅显式选择 TUN/eBPF 时退出 TProxy；先验证，失败仍保留原来的 TProxy 服务。
  if [ "$_rc_mode" = tproxy ]; then
    if [ "$_rc_keep_tp_cfg" != 1 ]; then
      printf 'tun_before=%s\nlistener_marked=%s\nport=%s\n' "$_pm_tp_before" "$_pm_tp_marked" "$_pm_port" > "$TP_CFG" || return 1
    fi
    config_fingerprint > "$RUNDIR/tproxy.config.fp" || return 1
    set_setting tproxy true || return 1
    action_mark tproxy_enabled
  elif [ -n "$_rc_mode" ]; then
    set_setting tproxy false || return 1
    tproxy_unhook_quick >/dev/null 2>&1
    # 不恢复旧 tun_before，避免覆盖用户刚选择的模式。
    rm -f "$TP_CFG" "$RUNDIR/tproxy.config.fp" "$TP_STATE" "$TP_MISS" 2>/dev/null
    ( tproxy_sync ) </dev/null >/dev/null 2>&1 &
    action_mark tproxy_disabled
  fi
  running && stop_core keep >/dev/null
  if start_core; then
    # Tproxy 模式（含普通重启时开关本来就是开的）：等规则真正装上再报成功，
    # 否则前端显示「已切换」但流量还没被接管，用户以为切失败/卡住了。
    if [ "$(get_setting tproxy false)" = "true" ]; then
      action_mark tproxy_ready_wait_begin
      tproxy_ready_wait
      action_mark tproxy_ready_wait_done
    fi
    return 0
  fi
  tproxy_unhook_quick 2>/dev/null
  tun_hotspot_sync >/dev/null 2>&1
  tproxy_sync >/dev/null 2>&1
  return 1
}

# ---------------- 开机自启保障 ----------------
# 现象：重启手机后偶发「内核没起来」——流量不走内核无法上网、外部面板打不开、代理页
# 没有代理组。根因是旧的开机路径只调一次 start_core 就不管了：
#   1) 开机时系统很忙，配置校验（内核 -t）可能 30 秒跑不完 → 被当成「配置错误」直接放弃；
#   2) 开机网络尚未就绪时，订阅 / 规则集首次拉取失败，内核在「存活 1.2 秒」的成功判据
#      之后才退出 —— start_core 早已返回成功，没有人再看一眼；
#   3) 内核死了而接管规则（TUN / Tproxy）还在，流量被导向死端口，表现为断网。
# 保障只在开机时跑一轮（跑完即退，不是常驻守护）：
#   · 第 1 次启动：校验超时放宽到 90 秒；
#   · 之后盯住内核：进程存活 + external-controller 端口已监听才算就绪；
#   · 没就绪（进程退出 / 迟迟不开端口）就退避重试，最多 4 轮；上一轮若死在「校验超时」，
#     下一轮跳过校验；
#   · 用户在此期间手动关闭总开关（boot.cancel）立即放弃，不与用户意图打架；
#   · 全部失败：摘掉接管规则，保证至少能正常上网，并留下 run/boot.log 供排查。
_bl() { printf '%s %s\n' "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$*" >> "$RUNDIR/boot.log" 2>/dev/null; }

# ---------------- 网络就绪（开机路径专用，零 fork） ----------------
# 旧实现是 `ping -c 1 -W 2 223.5.5.5` 循环 45 次：单轮最多 2 秒 + 一次 fork，
# 最坏要 90 秒；ICMP 被运营商/校园网拦掉时**必然**跑满 90 秒才继续开机，这段
# 时间里内核一直不启动。现在先读内核自己的事实：
#   · /proc/net/route       出现默认路由（Destination/Mask 全 0）
#   · /proc/net/ipv6_route  出现 ::/0 默认路由
# 全是内建读，出现即视为网络层就绪（毫秒级）。拿到默认路由后可选再补一次
# ICMP 确认（MH_NET_PING=1，默认关）——它只是加分项，超时也不阻塞启动：
# 真起不来由 boot_supervise 重试，不该让「网络静默丢 ICMP」拖住整个开机。
net_default_route() {
  if [ -r /proc/net/route ]; then
    while read -r _ndr_if _ndr_dst _ndr_gw _ndr_fl _ndr_rc _ndr_us _ndr_me _ndr_mask _ndr_rest; do
      case "$_ndr_if" in Iface|iface) continue ;; esac
      [ -n "$_ndr_mask" ] || continue
      case "$_ndr_dst$_ndr_mask" in 0000000000000000) return 0 ;; esac
    done < /proc/net/route
  fi
  if [ -r /proc/net/ipv6_route ]; then
    while read -r _ndr6_dst _ndr6_plen _ndr6_rest; do
      case "$_ndr6_dst" in
        00000000000000000000000000000000) case "$_ndr6_plen" in 00) return 0 ;; esac ;;
      esac
    done < /proc/net/ipv6_route
  fi
  return 1
}

# 等待网络就绪：$1=最长秒数（可空，默认 MH_NET_WAIT 或 20）。0=就绪，1=超时。
# 轮询 0.2s 起，1 秒后放宽到 0.5s —— 开机时默认路由通常 1 秒内就出现。
wait_net_ready() {
  _wn_max=${1:-${MH_NET_WAIT:-20}}
  case "$_wn_max" in ''|*[!0-9]*) _wn_max=20 ;; esac
  now_cs || { _wn_max=0; }
  _wn_dl=$((NOW_CS + _wn_max * 100))
  _wn_i=0
  while :; do
    net_default_route && return 0
    now_cs || break
    [ "$NOW_CS" -ge "$_wn_dl" ] && break
    if [ "$_wn_i" -lt 5 ]; then nap 0.2; else nap 0.5; fi
    _wn_i=$((_wn_i + 1))
  done
  return 1
}

# 内核就绪：$1=控制器端口（可空）$2=最长等待秒数。0=就绪，1=进程已退出/超时。
_boot_wait_ready() {
  _bw_port=$1; _bw_max=$2; _bw_t=0
  while [ $_bw_t -lt "$_bw_max" ]; do
    running || return 1
    if [ -n "$_bw_port" ]; then
      _sc_port_listening "$_bw_port" 2>/dev/null && return 0
    else
      [ $_bw_t -ge 5 ] && return 0          # 无 external-controller：连续存活 5 秒即视为就绪
    fi
    sleep 1; _bw_t=$((_bw_t + 1))
  done
  return 1
}

# 退避等待（可被手动停止打断）。返回 1 = 被取消。
_boot_backoff() {
  _bb_t=0
  while [ $_bb_t -lt "$1" ]; do
    [ -f "$RUNDIR/boot.cancel" ] && return 1
    sleep 1; _bb_t=$((_bb_t + 1))
  done
  [ -f "$RUNDIR/boot.cancel" ] && return 1
  return 0
}

# 开机第一次启动（行为同旧路径，仅把校验超时放宽）。结果留在 _bs_out / _bs_rc。
boot_first_start() {
  rm -f "$RUNDIR/boot.cancel" 2>/dev/null
  : > "$RUNDIR/boot.log" 2>/dev/null
  _bl "开机自启开始（系统已运行 $(cut -d' ' -f1 /proc/uptime 2>/dev/null)s）"
  MH_VERIFY_TIMEOUT=${MH_VERIFY_TIMEOUT:-90}; export MH_VERIFY_TIMEOUT
  _bs_out=$(start_core 2>&1); _bs_rc=$?
  [ -n "$_bs_out" ] && printf '%s\n' "$_bs_out"
  _bl "第 1 轮：start_core rc=$_bs_rc $(printf '%s' "$_bs_out" | tail -3 | tr '\n' ' ')"
}

# 盯住并在必要时重试。须在 boot_first_start 之后调用。
boot_supervise() {
  _bs_port=$(_sc_ctl_port)
  _bs_max=4; _bs_n=1; _bs_ok=0
  _bs_wait=${MH_BOOT_READY_WAIT:-30}; _bs_base=${MH_BOOT_BACKOFF:-6}
  while :; do
    if [ -f "$RUNDIR/boot.cancel" ]; then _bl "用户已手动停止，放弃自启保障"; return 0; fi
    if running; then
      if _boot_wait_ready "$_bs_port" "$_bs_wait"; then
        _bs_ok=1; _bl "第 $_bs_n 轮：内核就绪 (pid $(pid_of)，端口 ${_bs_port:-无})"; break
      fi
      if running; then
        _bl "第 $_bs_n 轮：内核存活但 ${_bs_wait}s 内控制器端口 ${_bs_port:-?} 未监听，终止后重试"
        stop_core keep >/dev/null 2>&1
      else
        _bl "第 $_bs_n 轮：内核在就绪前退出"
      fi
    else
      _bl "第 $_bs_n 轮：内核未运行"
    fi
    _bl "内核日志末尾: $(tail -4 "$LOGFILE" 2>/dev/null | tr '\n' '|' | cut -c1-400)"
    [ $_bs_n -ge $_bs_max ] && break
    case "$_bs_out" in *校验超时*) MH_SKIP_VERIFY=1; export MH_SKIP_VERIFY ;; esac
    _boot_backoff $((_bs_base * _bs_n)) || { _bl "退避期间用户手动停止，放弃自启保障"; return 0; }
    _bs_n=$((_bs_n + 1))
    _bl "第 $_bs_n 轮：重新启动内核"
    running || { _bs_out=$(start_core 2>&1); _bs_rc=$?; _bl "第 $_bs_n 轮：start_core rc=$_bs_rc $(printf '%s' "$_bs_out" | tail -3 | tr '\n' ' ')"; }
  done
  unset MH_SKIP_VERIFY MH_VERIFY_TIMEOUT
  if [ "$_bs_ok" = "1" ]; then
    # 内核就绪可能比 start_core 里那轮对账（约 6 秒）更晚：补一次接管规则对账
    if tunhs_tun_enabled || [ "$(get_setting tproxy false)" = "true" ] || [ -f "$TUNHS_STATE" ] || [ -f "$TP_STATE" ]; then
      sh "$0" net-sync </dev/null >/dev/null 2>&1 &
    fi
    sync_state_desc
    ( boot_data_sync ) >/dev/null 2>&1 &
    return 0
  fi
  _bl "共 $_bs_n 轮均未能拉起内核：摘除接管规则，避免流量被导向死端口"
  tproxy_unhook_quick 2>/dev/null
  tun_hotspot_sync >/dev/null 2>&1
  tproxy_sync >/dev/null 2>&1
  sync_state_desc
  ( boot_data_sync ) >/dev/null 2>&1 &
  return 1
}

# ---------------- TUN 热点共享支持 ----------------
# 修复：TUN 模式没有代理热点（/USB 共享）流量。
#
# 原理：mihomo TUN 的 auto-route 会在策略路由里装
#   「9001: from all not iif lo lookup <tun表>」——转发流量本应命中它进 TUN。
# 但 Android 上热点客户端的转发包还有三道额外的坎，全都到不了这条规则：
#   1) rp_filter 严格反向路径校验：热点子网源地址按新路由表反查，出口成了
#      TUN 设备、与实际入口网卡(wlan1/ap0/br-lan…)不符，rp_filter=1 的内核
#      在 PREROUTING 就把包丢了；
#   2) filter 表 FORWARD 链：netd 只为它登记的「热点网卡↔上游网卡」转发对
#      放行，iif/oif 为 TUN 的转发没有任何放行规则，默认策略下同样被丢；
#   3) sing-tun 的 auto-redirect 在 Android 上只装 OUTPUT 链（sing-tun 源码
#      redirect_iptables.go 中 GOOS==android 时提前 return），路由器/热点
#      场景需要的 FORWARD 放行被整段跳过——mihomo 官方文档因此写明
#      「On Android: Only forwards local IPv4 connections」。
# 本模块据此补齐（与 sing-tun Linux 端、box_for_magisk 的做法一致）：
#   · net.ipv4.ip_forward=1
#   · rp_filter=2（宽松反查；原值记录在状态文件，TUN 关闭时恢复）
#   · FORWARD 链首插入「-i/-o <tun网卡> -j ACCEPT」双向放行
#   · 配置 ipv6=false 时：REJECT 转发 IPv6 + 丢弃外发 RA(icmpv6 134)，
#     热点客户端立即回落 IPv4 全量走 TUN——否则 Android 的 v6 热点共享
#     由 eBPF 在 TC 层做 NAT66，完全绕过路由表，会静默直连泄漏；
#     ipv6=true 时改为放行 TUN 的 v6 转发（能否代理取决于设备的 v6 路径）。
# 装卸时机：内核 start/stop 同步装卸；配置热重载(PUT /configs)后延时对账；
# 「热点共享代理」开关（模块设置 hotspot_proxy，默认 true）变化立即对账；
# 开关监听循环每 ~5s 兜底对账（外部面板改配置也能收敛）。
# 状态: run/tunhs.state；日志: run/tunhs.log；规则全部幂等可重入。
# hotspot_proxy=false 时改走 direct 模式（仅 v4，热点客户端直连绕过内核）：
#   · 表 8995 = default [via 网关] dev <真实上游> + 上游/下游直连子网
#     （上游从 ip route show table all 的 default 行解析；Android 默认网络
#      优先 Wi-Fi/以太网，蜂窝兜底；切换网络后 5s 内自动重建）
#   · 策略路由 8990-8999 段：iif <上游> / iif <各下游> lookup 8995（逐网卡，
#     全版本兼容），外加 8999 的 not iif lo 兜底（个别 ip 版本不支持则跳过）
#     ——转发包与回程包先查自建表直出真实上游，绕过 TUN 与内核；本机流量
#     （iif lo）不受影响，仍走 TUN 代理。下游子网路由保证回程包（iif=上游,
#     dst=客户端子网）也走 8995 表送回热点网卡，不被 9001 吞进 TUN。
#     上游发现失败或规则安装失败时回退代理模式，状态记为 fb（前端可见）。
#   · filter 兜底链 mihomo_tunhs：-i 下游 -o 上游 / 反向 ACCEPT 对
#     （netd tetherctrl_FORWARD 缺席或未放行 TUN 之外的组合时兜底）
#   · nat 兜底链：MASQUERADE（系统 eBPF/iptables NAT 已在时先命中系统的，
#     不冲突；两者都缺席时由本链保证源地址可路由）
#   · ip6tables：转发 REJECT + 掐外发 RA —— 直连仅 v4，防客户端 v6 直连泄漏
#   · 上游发现失败（无可用 default）：自动回退代理模式规则，绝不让热点断网
# 已知边界：先于 TUN 建立、已被 Android eBPF 热点共享接管 NAT 的旧连接不会
# 迁入 TUN（重启热点或让客户端重连即可）；纯二层桥接（无线中继）流量不经
# 路由表，TUN 方案无法覆盖，需改用 eBPF 入站抓 br-lan 等桥接口。
# ------------------------------------------------------------

TUNHS_STATE=$RUNDIR/tunhs.state   # 已应用规则的状态（文件存在=已装）
TUNHS_LOG=$RUNDIR/tunhs.log       # 装卸日志（超 32KB 自动截断）
TUNHS_NOIPT=$RUNDIR/tunhs.noipt   # iptables 不可用的已告警标记（防日志刷屏）
TUNHS_NOIP=$RUNDIR/tunhs.noip     # ip 命令不可用的已告警标记（仅直连模式需要）
TUNHS_RP=$RUNDIR/tunhs.rp         # rp_filter 原值（首次应用时记录，全量拆除后清除。
                                   # 独立于状态文件：模式切换/网卡变化会重建状态文件，
                                   # 但原值必须保留到真正卸载，否则会把模块自己写的 2
                                   # 当成原值记下来，停止后无法还原）
# 热点转发「直连绕过」用的策略路由优先级：必须小于 mihomo auto-route 的
# 9000（数值更小=先匹配），且避开 Android 系统规则区（10000+）与
# VPNHotspot 等工具的 20xxx 区。8995 只属于本模块。
# 策略路由优先级带 8990-8999（必须整体小于 mihomo auto-route 的 9000）：
#   8990 = 上游网卡规则（回程包）   8991..8998 = 各下游网卡规则
#   8999 = not iif lo 兜底（个别设备的 ip 命令不支持该语法，装不上不致命）
# 主机制是逐网卡 iif 匹配——iif 是 ip rule 最基础的语法，任何版本都支持；
# 曾用单条 `not iif lo`，在部分设备上装不上→直连静默失效，教训在此。
TUNHS_PREF_MIN=8990
TUNHS_PREF_MAX=8999
# 直连模式自建路由表：Android 的默认路由在「按网络划分」的专用表里（如 table 1005），
# main 表只有直连子网、没有默认路由——所以不能 lookup main（会查不到路由跌回
# mihomo 的 9001 规则进 TUN，而直连模式没有 TUN 转发放行 → 热点直接断网）。
# 正确做法：从所有表的 default 路由解析出真实上游与网关，复制进自建表 8995。
TUNHS_TABLE=8995
TUNHS_CHAIN=mihomo_tunhs          # 直连模式的 FORWARD/NAT 兜底链（filter 与 nat 各一条同名链）
TUNHS_LOCK=$RUNDIR/tunhs.lock     # 对账互斥锁（目录型）：set 钩子/监听循环/热重载延时
                                   # 可能并发对账，交错执行会产生重复规则与残缺状态文件
                                   # （真机观察到 mode=proxy 与 up= 混排），必须串行化
TUNHS_NFT_TABLE=mihomo_tunhs      # nft 后端独立表名（通用 nftables 环境使用；fw4 环境直接把规则插进 inet fw4 的链）
TUNHS_NFT_TAG=mihomo_tunhs        # nft 规则的 comment 标记前缀（fw4 表内按它定位删除；后接 :proxy/:direct 区分模式）

# iptables/ip/nft 定位与防火墙后端选择（与 tproxy 的 tp_setup_bins 同一套策略）：
# Android 与旧 OpenWrt(fw3) 继续走 iptables；OpenWrt fw4（22.03+，纯 nftables、
# 通常没有 iptables 二进制）走 nftables —— TUN 的转发放行 / 直连兜底 NAT /
# v6 拦截规则全部落在 nft。MIHOMO_TUNHS_BACKEND=nft|iptables 可强制后端。
_tunhs_bins() {
  TUNHS_IPT=""; TUNHS_IP6T=""; TUNHS_IP=""; TUNHS_NFT=""; TUNHS_BACKEND=""
  if [ -x /system/bin/iptables ]; then TUNHS_IPT=/system/bin/iptables
  elif command -v iptables >/dev/null 2>&1; then TUNHS_IPT=$(command -v iptables); fi
  if [ -x /system/bin/ip6tables ]; then TUNHS_IP6T=/system/bin/ip6tables
  elif command -v ip6tables >/dev/null 2>&1; then TUNHS_IP6T=$(command -v ip6tables); fi
  if [ -x /system/bin/ip ]; then TUNHS_IP=/system/bin/ip
  elif command -v ip >/dev/null 2>&1; then TUNHS_IP=$(command -v ip); fi
  if [ -x /usr/sbin/nft ]; then TUNHS_NFT=/usr/sbin/nft
  elif [ -x /sbin/nft ]; then TUNHS_NFT=/sbin/nft
  elif command -v nft >/dev/null 2>&1; then TUNHS_NFT=$(command -v nft); fi
  case "${MIHOMO_TUNHS_BACKEND:-auto}" in
    nft) TUNHS_BACKEND=nft ;;
    iptables|ipt) TUNHS_BACKEND=ipt ;;
    *)
      TUNHS_BACKEND=ipt
      if [ -n "$TUNHS_NFT" ]; then
        if [ -z "$TUNHS_IPT" ]; then
          # 连 iptables 都没有（fw4-only 固件）：只能走 nft
          TUNHS_BACKEND=nft
        elif [ -x /sbin/fw4 ] || command -v fw4 >/dev/null 2>&1; then
          # fw4 在场：iptables 即便存在也是 iptables-nft 兼容层，走原生 nft 更稳
          TUNHS_BACKEND=nft
        elif [ -f /etc/openwrt_release ] && [ ! -x /sbin/fw3 ] && ! command -v fw3 >/dev/null 2>&1; then
          # /sbin/fw4 在精简固件里可能不在 PATH；OpenWrt 22.03+ 且无 fw3 时按 nftables 世代处理
          TUNHS_BACKEND=nft
        fi
      fi
      ;;
  esac
}

# ---------------- TUN 规则的 nftables 后端（OpenWrt fw4 等） ----------------
# 与 tproxy 的 nft 后端同理，但 TUN 的放行规则落在 filter hook 的 forward 上，
# 而 fw4 自己的 forward/output 链对未匹配流量有终局 reject/drop —— 独立表的
# accept 拦不住它（nftables 同一 hook 的多条 base chain 串行评估，先到的
# drop/reject 即终局）。因此：
#   · fw4 在场 → 规则直接 insert 进 inet fw4 的 forward/output/srcnat 链首
#     （等价当年的 iptables -I FORWARD / -I OUTPUT / -t nat -I POSTROUTING），
#     每条带 comment 标记，拆除时按标记精确删，绝不碰 fw4 自己的规则；
#     fw4 reload 会整表重建、我们的规则随之消失，对账/自愈循环会重新装上。
#   · 无 fw4 的通用 nftables 环境 → 独立表 inet mihomo_tunhs，原子替换，
#     不与任何系统防火墙互相干扰。

# fw4 的 forward 链是否在场（fw4 固定使用 inet fw4 表；srcnat/output 同理）
tunhs_nft_fw4_chains() {
  [ -n "$TUNHS_NFT" ] || return 1
  "$TUNHS_NFT" list chain inet fw4 forward >/dev/null 2>&1
}

# 删除 fw4 指定链里所有带本模块标记的规则（按 handle 精确删；链不存在则静默通过）
tunhs_nft_fw4_flush_chain() {
  _tnf_chain=$1
  [ -n "$TUNHS_NFT" ] || return 0
  "$TUNHS_NFT" -a list chain inet fw4 "$_tnf_chain" 2>/dev/null |
  while IFS= read -r _tnf_l; do
    case "$_tnf_l" in *"$TUNHS_NFT_TAG"*) ;; *) continue ;; esac
    case "$_tnf_l" in *"handle "*) ;; *) continue ;; esac
    _tnf_h=${_tnf_l##*handle }
    _tnf_h=$(printf '%s' "$_tnf_h" | tr -d ' \t\r')
    case "$_tnf_h" in ''|*[!0-9]*) continue ;; esac
    "$TUNHS_NFT" delete rule inet fw4 "$_tnf_chain" handle "$_tnf_h" 2>/dev/null
  done
  return 0
}

# 全量拆除本模块的 nft 规则（fw4 三条链 + 独立表），幂等
tunhs_nft_teardown() {
  [ -n "$TUNHS_NFT" ] || return 0
  tunhs_nft_fw4_flush_chain forward
  tunhs_nft_fw4_flush_chain output
  tunhs_nft_fw4_flush_chain srcnat
  "$TUNHS_NFT" delete table inet "$TUNHS_NFT_TABLE" >/dev/null 2>&1
  return 0
}

# 带 $1 标记（proxy|direct）的 nft 规则是否存在（fw4 链或独立表任一）
tunhs_nft_rules_present() {
  [ -n "$TUNHS_NFT" ] || return 1
  if "$TUNHS_NFT" list table inet "$TUNHS_NFT_TABLE" >/dev/null 2>&1; then return 0; fi
  { "$TUNHS_NFT" list chain inet fw4 forward 2>/dev/null
    "$TUNHS_NFT" list chain inet fw4 srcnat 2>/dev/null
  } 2>/dev/null | grep -q "$TUNHS_NFT_TAG:$1"
  return $?
}

# 本模块的 nft 规则是否存在（任意标记；iptables 的转发放行没有标识、查不出，
# nft 的 comment 标记让「无状态却留有规则」的孤儿也能识别并清掉）
tunhs_nft_any_present() {
  [ -n "$TUNHS_NFT" ] || return 1
  if "$TUNHS_NFT" list table inet "$TUNHS_NFT_TABLE" >/dev/null 2>&1; then return 0; fi
  { "$TUNHS_NFT" list chain inet fw4 forward 2>/dev/null
    "$TUNHS_NFT" list chain inet fw4 output 2>/dev/null
    "$TUNHS_NFT" list chain inet fw4 srcnat 2>/dev/null
  } 2>/dev/null | grep -q "$TUNHS_NFT_TAG"
  return $?
}

# 稳态对账的规则在场校验：proxy 模式查本后端的转发放行，direct 模式查兜底
# 链/标记规则。fw4 reload / 防火墙整体刷新会把我们的 forward/output/srcnat
# 规则一并清掉，只对账状态文件与 ip rule（netlink 层，reload 动不到）发现
# 不了 —— TUN 代理会静默断流，必须看规则本身还在不在。
# 校验失败只触发幂等重装（heal-reinstall / 全量换装），不改变参数。
# 无法校验的环境（相应工具缺失）按「在场」处理，维持旧的宽松行为。
tunhs_rules_ok() {
  # $1=mode(proxy|direct) $2=iface
  if [ "$TUNHS_BACKEND" = "nft" ]; then
    [ -n "$TUNHS_NFT" ] || return 0
    tunhs_nft_rules_present "$1"
    return $?
  fi
  [ -n "$TUNHS_IPT" ] || return 0
  if [ "$1" = "proxy" ]; then
    $TUNHS_IPT -w -C FORWARD -i "$2" -j ACCEPT 2>/dev/null
    return $?
  fi
  $TUNHS_IPT -w -C FORWARD -j "$TUNHS_CHAIN" 2>/dev/null
  return $?
}

# v6 拦截（ipv6=false / 直连模式共用）：拦 v6 转发 + 掐外发 RA，
# 客户端立即回落 v4。$1=标记（proxy|direct）
tunhs_nft_v6_block() {
  _tnv_tag=$1
  if tunhs_nft_fw4_chains; then
    "$TUNHS_NFT" insert rule inet fw4 forward meta nfproto ipv6 counter reject comment "\"$TUNHS_NFT_TAG:$_tnv_tag\"" 2>>"$TUNHS_LOG" || return 1
    if "$TUNHS_NFT" list chain inet fw4 output >/dev/null 2>&1; then
      "$TUNHS_NFT" insert rule inet fw4 output meta nfproto ipv6 meta l4proto ipv6-icmp icmpv6 type nd-router-advert counter drop comment "\"$TUNHS_NFT_TAG:$_tnv_tag\"" 2>>"$TUNHS_LOG" || return 1
    fi
  fi
  return 0
}

# 代理模式规则：热点客户端 ↔ TUN 转发放行（inet 一张表同时覆盖 v4+v6，
# 取代 iptables+ip6tables 各装一对的写法）。$1=TUN 网卡 $2=v6(on|off)
tunhs_nft_install_proxy() {
  _tnp_if=$1; _tnp_v6=$2
  [ -n "$TUNHS_NFT" ] || return 1
  if tunhs_nft_fw4_chains; then
    # 换模式/换参数一律全量换装：三条链先清旧再插新（幂等，不叠加；
    # direct 残留在 srcnat/output 里的 masquerade/RA 规则也要一并清掉）
    tunhs_nft_fw4_flush_chain forward
    tunhs_nft_fw4_flush_chain output
    tunhs_nft_fw4_flush_chain srcnat
    "$TUNHS_NFT" insert rule inet fw4 forward iifname "\"$_tnp_if\"" counter accept comment "\"$TUNHS_NFT_TAG:proxy\"" 2>>"$TUNHS_LOG" || return 1
    "$TUNHS_NFT" insert rule inet fw4 forward oifname "\"$_tnp_if\"" counter accept comment "\"$TUNHS_NFT_TAG:proxy\"" 2>>"$TUNHS_LOG" || return 1
    if [ "$_tnp_v6" != "on" ]; then
      tunhs_nft_v6_block proxy || return 1
    fi
    return 0
  fi
  # 通用 nftables：独立表原子替换
  _tnp_file=$RUNDIR/tunhs.nft
  {
    printf 'table inet %s {\n' "$TUNHS_NFT_TABLE"
    printf ' chain forward {\n'
    printf '  type filter hook forward priority filter; policy accept;\n'
    printf '  iifname "%s" counter accept\n' "$_tnp_if"
    printf '  oifname "%s" counter accept\n' "$_tnp_if"
    [ "$_tnp_v6" != "on" ] && printf '  meta nfproto ipv6 counter reject\n'
    printf ' }\n'
    if [ "$_tnp_v6" != "on" ]; then
      printf ' chain output {\n'
      printf '  type filter hook output priority filter; policy accept;\n'
      printf '  meta nfproto ipv6 meta l4proto ipv6-icmp icmpv6 type nd-router-advert counter drop\n'
      printf ' }\n'
    fi
    printf '}\n'
  } > "$_tnp_file" 2>/dev/null || return 1
  tunhs_nft_apply "$_tnp_file"
}

# 直连模式规则：上下游双向放行 + 下游子网 MASQUERADE 兜底 + v6 拦截。
# $1=上游网卡 $2=下游网卡列表（空格分隔，函数内部逐个查子网）
tunhs_nft_install_direct() {
  _tnd_up=$1; _tnd_downs=$2
  [ -n "$TUNHS_NFT" ] || return 1
  [ -n "$TUNHS_IP" ] || return 1
  if tunhs_nft_fw4_chains; then
    # 换模式/换参数一律全量换装：三条链先清旧再插新（幂等，不叠加）
    tunhs_nft_fw4_flush_chain forward
    tunhs_nft_fw4_flush_chain output
    tunhs_nft_fw4_flush_chain srcnat
    for _tnd_d in $_tnd_downs; do
      "$TUNHS_NFT" insert rule inet fw4 forward iifname "\"$_tnd_d\"" oifname "\"$_tnd_up\"" counter accept comment "\"$TUNHS_NFT_TAG:direct\"" 2>>"$TUNHS_LOG" || return 1
      "$TUNHS_NFT" insert rule inet fw4 forward iifname "\"$_tnd_up\"" oifname "\"$_tnd_d\"" counter accept comment "\"$TUNHS_NFT_TAG:direct\"" 2>>"$TUNHS_LOG" || return 1
    done
    if "$TUNHS_NFT" list chain inet fw4 srcnat >/dev/null 2>&1; then
      for _tnd_d in $_tnd_downs; do
        _tnd_dn=$($TUNHS_IP -4 route show dev "$_tnd_d" 2>/dev/null | awk '/proto kernel/{print $1; exit}')
        [ -n "$_tnd_dn" ] && "$TUNHS_NFT" insert rule inet fw4 srcnat ip saddr "$_tnd_dn" oifname "\"$_tnd_up\"" counter masquerade comment "\"$TUNHS_NFT_TAG:direct\"" 2>>"$TUNHS_LOG"
      done
    fi
    tunhs_nft_v6_block direct || return 1
    return 0
  fi
  _tnd_file=$RUNDIR/tunhs.nft
  {
    printf 'table inet %s {\n' "$TUNHS_NFT_TABLE"
    printf ' chain forward {\n'
    printf '  type filter hook forward priority filter; policy accept;\n'
    for _tnd_d in $_tnd_downs; do
      printf '  iifname "%s" oifname "%s" counter accept\n' "$_tnd_d" "$_tnd_up"
      printf '  iifname "%s" oifname "%s" counter accept\n' "$_tnd_up" "$_tnd_d"
    done
    printf '  meta nfproto ipv6 counter reject\n'
    printf ' }\n'
    printf ' chain output {\n'
    printf '  type filter hook output priority filter; policy accept;\n'
    printf '  meta nfproto ipv6 meta l4proto ipv6-icmp icmpv6 type nd-router-advert counter drop\n'
    printf ' }\n'
    printf ' chain srcnat {\n'
    printf '  type nat hook postrouting priority srcnat; policy accept;\n'
    for _tnd_d in $_tnd_downs; do
      _tnd_dn=$($TUNHS_IP -4 route show dev "$_tnd_d" 2>/dev/null | awk '/proto kernel/{print $1; exit}')
      [ -n "$_tnd_dn" ] && printf '  ip saddr %s oifname "%s" counter masquerade\n' "$_tnd_dn" "$_tnd_up"
    done
    printf ' }\n'
    printf '}\n'
  } > "$_tnd_file" 2>/dev/null || return 1
  tunhs_nft_apply "$_tnd_file"
}

# 独立表原子替换（同 tproxy_nft_apply：同一事务里先删旧表再建新表，失败整份不生效）
tunhs_nft_apply() {
  _tna_file=$1
  [ -n "$TUNHS_NFT" ] || return 1
  [ -r "$_tna_file" ] || return 1
  "$TUNHS_NFT" -c -f "$_tna_file" >>"$TUNHS_LOG" 2>&1 || return 1
  _tna_tmp=$RUNDIR/_tunhs_nft_apply.nft
  {
    if "$TUNHS_NFT" list table inet "$TUNHS_NFT_TABLE" >/dev/null 2>&1; then
      printf 'delete table inet %s\n' "$TUNHS_NFT_TABLE"
    fi
    cat "$_tna_file"
  } > "$_tna_tmp" 2>/dev/null || { rm -f "$_tna_tmp" 2>/dev/null; return 1; }
  "$TUNHS_NFT" -f "$_tna_tmp" >>"$TUNHS_LOG" 2>&1
  _tna_rc=$?
  rm -f "$_tna_tmp" 2>/dev/null
  return "$_tna_rc"
}

# 顶层 tun: 块内字段读取（$1=字段名；以「顶格行」界定块边界，跳过注释行）
tunhs_cfg_tun_field() {
  [ -f "$CONFIG" ] || return 0
  awk -v k="$1" '
    /^[^ \t#-]/ { inb = ($1 == "tun:") }
    inb && /^tun:[ \t]*\{/ {
      line = $0
      if (match(line, k ":[ \t]*")) {
        v = substr(line, RSTART + RLENGTH); sub(/[,}].*$/, "", v)
        gsub(/["\047]/, "", v); sub(/[ \t]+$/, "", v); print v; exit
      }
    }
    inb && $1 == k ":" { v = $2; gsub(/["\047]/, "", v); print v; exit }
  ' "$CONFIG" 2>/dev/null
}

# 顶层 ipv6 开关（mihomo 的 ipv6:，决定 TUN 是否携带 v6 路由）
tunhs_cfg_ipv6() {
  [ -f "$CONFIG" ] || return 0
  awk '/^ipv6:/ { print $2; exit }' "$CONFIG" 2>/dev/null | tr -d '"'
}

# TUN 是否视为开启：顶层 tun.enable=true，或 listeners 里存在 type: tun 入站
tunhs_tun_enabled() {
  [ "$(tunhs_cfg_tun_field enable)" = "true" ] && return 0
  grep -Eq "^[[:space:]]*(-[[:space:]]+)?type:[[:space:]]*[\"']?tun[\"']?([[:space:]]|$)" "$CONFIG" 2>/dev/null
}

# 内核的配置快照：只供运行态判定，配置手术始终读取磁盘上的新 config。
runtime_tun_enabled() {
  if [ -f "$RUNDIR/active-config.yaml" ]; then
    ( CONFIG="$RUNDIR/active-config.yaml"; tunhs_tun_enabled )
  else
    tunhs_tun_enabled
  fi
}

# 找 mihomo 实际创建的 TUN 网卡：配置 device → CalculateInterfaceName 的
# 缺省名（Meta0…）→ 现存 Meta*/mihomo* 前缀网卡。找不到输出空（等待重试）。
tunhs_find_iface() {
  _tf_dev=$(tunhs_cfg_tun_field device)
  for _tf_i in $_tf_dev Meta0 Meta1 Meta2 meta0 meta1 meta2 mihomo; do
    [ -n "$_tf_i" ] || continue
    [ -e "/sys/class/net/$_tf_i" ] && { echo "$_tf_i"; return 0; }
  done
  for _tf_e in /sys/class/net/[Mm]eta* /sys/class/net/[Mm]ihomo*; do
    [ -e "$_tf_e" ] && { echo "${_tf_e##*/}"; return 0; }
  done
  return 1
}

tunhs_log() {
  printf '%s %s\n' "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$*" >> "$TUNHS_LOG" 2>/dev/null
  _tl_s=$(wc -c < "$TUNHS_LOG" 2>/dev/null)
  case "$_tl_s" in ''|*[!0-9]*) return 0 ;; esac
  [ "$_tl_s" -gt 32768 ] && { tail -n 60 "$TUNHS_LOG" > "$TUNHS_LOG.tmp" 2>/dev/null && mv "$TUNHS_LOG.tmp" "$TUNHS_LOG" 2>/dev/null; }
  return 0
}

# 恢复 rp_filter 原值（读 tunhs.rp；ip_forward 不恢复：热点自身也需要它，netd 自会管理）
tunhs_restore_rp() {
  [ -f "$TUNHS_RP" ] || return 0
  _tr_a=$(grep '^rp_all=' "$TUNHS_RP" 2>/dev/null | cut -d= -f2)
  _tr_d=$(grep '^rp_def=' "$TUNHS_RP" 2>/dev/null | cut -d= -f2)
  case "$_tr_a" in ''|*[!0-9]*) ;; *) echo "$_tr_a" > /proc/sys/net/ipv4/conf/all/rp_filter 2>/dev/null ;; esac
  case "$_tr_d" in ''|*[!0-9]*) ;; *) echo "$_tr_d" > /proc/sys/net/ipv4/conf/default/rp_filter 2>/dev/null ;; esac
  rm -f "$TUNHS_RP"
  return 0
}

# 拆除本模块为热点共享装过的全部规则（$1=TUN 网卡名，可空）。
# 不论当前处于代理/直连哪种模式，一律全量拆除（幂等，删不存在的规则返回非零即止）：
#   · filter FORWARD 的 -i/-o <tun> ACCEPT
#   · ip6tables 的 v6 放行 / v6 拦截(REJECT+RA DROP)
#   · 策略路由 8995 直连绕过规则（v4+v6）
# 用 while -D 循环拆干净：极端并发下 -C/-I 竞态可能落下重复规则，-D 一次只删一条。
tunhs_teardown_rules() {
  _tu_i="$1"
  _tunhs_bins
  if [ -n "$TUNHS_IPT" ] && [ -n "$_tu_i" ]; then
    while $TUNHS_IPT -w -D FORWARD -i "$_tu_i" -j ACCEPT 2>/dev/null; do :; done
    while $TUNHS_IPT -w -D FORWARD -o "$_tu_i" -j ACCEPT 2>/dev/null; do :; done
  fi
  if [ -n "$TUNHS_IP6T" ]; then
    if [ -n "$_tu_i" ]; then
      while $TUNHS_IP6T -w -D FORWARD -i "$_tu_i" -j ACCEPT 2>/dev/null; do :; done
      while $TUNHS_IP6T -w -D FORWARD -o "$_tu_i" -j ACCEPT 2>/dev/null; do :; done
    fi
    while $TUNHS_IP6T -w -D FORWARD -j REJECT 2>/dev/null; do :; done
    while $TUNHS_IP6T -w -D OUTPUT -p icmpv6 --icmpv6-type 134 -j DROP 2>/dev/null; do :; done
  fi
  if [ -n "$TUNHS_IP" ]; then
    # 8990-8999 优先级带逐个清（兼容旧版本装在 8995 的单条规则）
    tunhs_clear_band
    $TUNHS_IP route flush table "$TUNHS_TABLE" 2>/dev/null
  fi
  # 直连模式的兜底链（filter + nat 同名链）
  if [ -n "$TUNHS_IPT" ]; then
    $TUNHS_IPT -w -D FORWARD -j "$TUNHS_CHAIN" 2>/dev/null
    $TUNHS_IPT -w -F "$TUNHS_CHAIN" 2>/dev/null
    $TUNHS_IPT -w -X "$TUNHS_CHAIN" 2>/dev/null
    $TUNHS_IPT -w -t nat -D POSTROUTING -j "$TUNHS_CHAIN" 2>/dev/null
    $TUNHS_IPT -w -t nat -F "$TUNHS_CHAIN" 2>/dev/null
    $TUNHS_IPT -w -t nat -X "$TUNHS_CHAIN" 2>/dev/null
  fi
  # nftables 后端（fw4 链内规则 + 独立表）同样全量拆掉；不知道当前后端时
  # 只要 nft 在场就拆（切换后端 / 升级后可能两种规则同时残留）
  _tunhs_bins 2>/dev/null
  tunhs_nft_teardown 2>/dev/null
  return 0
}

# 清空整个 8990-8999 优先级带（v4+v6）。teardown 与 heal-reinstall 共用：
# heal 不走全量 teardown，但历史/外部注入的带内残留规则必须清掉再重装。
# 先用一次 rule show 定位真实存在的优先级，只对命中的 pref 做「删到没有」：
# 旧写法对 10 个 pref × v4/v6 固定发 20 次删除探测（干净时全部扑空，还要
# 再各付一次失败回执），是 stop 同步拆除路径最大的一笔 fork 浪费；现在
# 干净时每族只有 1 次 show，有几条删几条，语义（连同重复规则）不变。
tunhs_clear_band() {
  [ -n "$TUNHS_IP" ] || return 0
  for _tu_sf in "" "-6"; do
    _tu_seen="|"
    _tu_out=$($TUNHS_IP $_tu_sf rule show 2>/dev/null)
    while IFS= read -r _tu_l || [ -n "$_tu_l" ]; do
      case "$_tu_l" in
        899[0-9]:*) _tu_p=${_tu_l%%:*} ;;
        *) continue ;;
      esac
      case "$_tu_seen" in *"|$_tu_p|"*) continue ;; esac
      _tu_seen="$_tu_seen$_tu_p|"
      while $TUNHS_IP $_tu_sf rule del pref "$_tu_p" 2>/dev/null; do :; done
    done <<MH_TUNHS_BAND
$_tu_out
MH_TUNHS_BAND
  done
  return 0
}

# 8990-8999 绕过规则是否已存在（不带 -4：v4 规则在默认输出同样可见，
# 且规避个别 ip 构建对「-4 + rule」组合的怪异行为；v6 我们从不添加）
tunhs_bypass_have() {
  [ -n "$TUNHS_IP" ] || return 1
  $TUNHS_IP rule show 2>/dev/null | grep -qE '^(899[0-9]):'
}

# 直连残留是否存在（ip rule 带 + FORWARD 跳转链 + nft 规则任一）。
# 用于自愈：期望「无直连」（关闭开关 / 回退代理）时仍需确认没有残留——
# 回退竞态、异常退出、旧版本升级都可能留下规则而状态文件已经变了。
tunhs_stale_present() {
  tunhs_bypass_have && return 0
  _tunhs_bins
  if [ -n "$TUNHS_NFT" ] && tunhs_nft_rules_present direct; then return 0; fi
  [ -n "$TUNHS_IPT" ] || return 1
  $TUNHS_IPT -w -C FORWARD -j "$TUNHS_CHAIN" 2>/dev/null
}

# ---- 直连模式：上游发现 ----
# 从系统路由解析真实 IPv4 上游。三个来源依次尝试：
#   1) ip -4 route show table all（精确 v4）
#   2) ip route show table all + 过滤 v6（via 含冒号 / pref 字段）——兼容
#      -4 组合异常的 ip 构建
#   3) 逐个枚举 ip rule 引用过的表（数字与命名表），同样过滤 v6
# 回退条件是「过滤后无有效候选」而不仅是「输出为空」——真机教训（1552 版
# 振荡根因）：-4 table all 可能非空但不完整（有 meta/dummy 行、缺 rmnet
# 命名表行），旧逻辑此时不再尝试无 -4 版 → 全被排除 → 误判无上游 →
# 回退代理 → 成功时又翻回 direct，每几秒振荡一次。
# 候选排序：带网关非蜂窝 > 带网关蜂窝 > 无网关非蜂窝 > 无网关蜂窝。
# 排除：TUN 自身、自建表(8995/2022)、dummy/ifb/gre 等虚拟网卡（Android 的
# 「无网络应用保活」dummy0 带假默认路由，真机曾误选 → 黑洞）。
# $1 = TUN 网卡名。结果：TUNHS_UP_DEV / TUNHS_UP_VIA（可空）；
# 失败时 TUNHS_UP_EV 携带各来源证据（空/全排除+前两行原文），供日志定位。
_tunhs_filter_upstream() {
  # stdin = 候选行；$1 = TUN 网卡名。stdout = 最佳行（空 = 无有效候选）。
  # 经由管道调用（子 shell）：结果只走 stdout，不依赖父进程变量。
  _tf_pick=$1; _tf_gw_nc=""; _tf_gw_cell=""; _tf_nc=""; _tf_cell=""
  while read -r _tf_l; do
    [ -n "$_tf_l" ] || continue
    case "$_tf_l" in *"table 2022"*|*"table $TUNHS_TABLE"*) continue ;; esac
    _tf_d=$(printf '%s\n' "$_tf_l" | sed -n 's/.* dev \([^ ]*\).*/\1/p')
    [ -n "$_tf_d" ] || continue
    [ -n "$_tf_pick" ] && [ "$_tf_d" = "$_tf_pick" ] && continue
    case "$_tf_d" in
      # TUN / 虚拟 / 隧道 / 桥接 / 杂项：都不是真实上游
      lo|tun*|tap*|[Mm]eta*|mihomo*|dummy*|ifb*|sit*|ip6tnl*|ip6gre*|ip_vti*|ip6_vti*|gre*|erspan*|vlan*|macvlan*|veth*|bridge*|p2p*|wifi-aware*|miw_*) continue ;;
    esac
    _tf_v=$(printf '%s\n' "$_tf_l" | sed -n 's/.* via \([^ ]*\).*/\1/p')
    _tf_c=0
    case "$_tf_d" in rmnet*|r_rmnet*|ccmni*|wwan*|ttyUSB*|radio*) _tf_c=1 ;; esac
    if [ -n "$_tf_v" ]; then
      if [ "$_tf_c" = "0" ]; then _tf_gw_nc=$_tf_l; break; fi   # 最优：带网关的非蜂窝
      [ -z "$_tf_gw_cell" ] && _tf_gw_cell=$_tf_l
    elif [ "$_tf_c" = "0" ]; then
      [ -z "$_tf_nc" ] && _tf_nc=$_tf_l
    else
      [ -z "$_tf_cell" ] && _tf_cell=$_tf_l
    fi
  done
  printf '%s\n' "${_tf_gw_nc:-${_tf_gw_cell:-${_tf_nc:-$_tf_cell}}}"
}

tunhs_pick_upstream() {
  TUNHS_UP_DEV=""; TUNHS_UP_VIA=""; TUNHS_UP_LINE=""; TUNHS_UP_EV=""
  [ -n "$TUNHS_IP" ] || return 1
  _tu_pick=$1; _tu_ev=""
  for _tu_src in 4 all tbl; do
    _tu_all=""
    case "$_tu_src" in
      4)
        _tu_all=$($TUNHS_IP -4 route show table all 2>/dev/null | grep -E '^default ' | grep -Ev 'via [^ ]*:| pref ') ;;
      all)
        _tu_all=$($TUNHS_IP route show table all 2>/dev/null | grep -E '^default ' | grep -Ev 'via [^ ]*:| pref ') ;;
      tbl)
        for _tu_t in $($TUNHS_IP rule show 2>/dev/null | sed -n 's/.*lookup \([a-zA-Z0-9_-][a-zA-Z0-9_-]*\)$/\1/p' | sort -u); do
          _tu_l=$($TUNHS_IP route show table "$_tu_t" 2>/dev/null | grep -E '^default ' | grep -Ev 'via [^ ]*:| pref ')
          [ -n "$_tu_l" ] && _tu_all="$_tu_all$_tu_l
"
        done ;;
    esac
    if [ -n "$_tu_all" ]; then
      _tu_best=$(printf '%s\n' "$_tu_all" | _tunhs_filter_upstream "$_tu_pick")
      if [ -n "$_tu_best" ]; then
        TUNHS_UP_LINE=$_tu_best
        TUNHS_UP_DEV=$(printf '%s\n' "$_tu_best" | sed -n 's/.* dev \([^ ]*\).*/\1/p')
        TUNHS_UP_VIA=$(printf '%s\n' "$_tu_best" | sed -n 's/.* via \([^ ]*\).*/\1/p')
        return 0
      fi
      _tu_ev="$_tu_ev${_tu_ev:+; }${_tu_src}有输出但全被排除[$(printf '%s\n' "$_tu_all" | head -n 2 | cut -c 1-100 | tr '\n' '~')]"
    else
      _tu_ev="$_tu_ev${_tu_ev:+; }${_tu_src}空"
    fi
  done
  TUNHS_UP_EV="$_tu_ev"
  return 1
}

# ---- 直连模式：枚举热点/USB 下游网卡 ----
# 有内核 v4 直连路由（proto kernel，即热点子网）且非 lo/TUN/上游 的网卡。
# 排除蜂窝（rmnet 等带 10.x 直连路由但绝不是热点下游）与常见虚拟隧道网卡。
# $1 = 上游网卡  $2 = TUN 网卡。输出：空格分隔的下游列表。
tunhs_list_downs() {
  _td_up=$1; _td_tun=$2
  _td_out=""
  for _td_e in /sys/class/net/*; do
    _td_i=${_td_e##*/}
    [ "$_td_i" = "lo" ] && continue
    [ "$_td_i" = "$_td_up" ] && continue
    [ -n "$_td_tun" ] && [ "$_td_i" = "$_td_tun" ] && continue
    case "$_td_i" in
      # TUN/虚拟/隧道网卡（tun* 覆盖 tunl*，gre* 覆盖 gretap*）
      [Mm]eta*|mihomo*|tun*|tap*|sit*|ip6tnl*|ip6gre*|ip_vti*|ip6_vti*|gre*|erspan*|dummy*|ifb*|vlan*|macvlan*|veth*|wifi-aware*) continue ;;
      # 蜂窝调制解调器网卡（含高通 r_rmnet* 受限口）：永远不是热点/USB 下游
      rmnet*|r_rmnet*|ccmni*|wwan*|ttyUSB*|radio*) continue ;;
    esac
    $TUNHS_IP -4 route show dev "$_td_i" 2>/dev/null | grep -q 'proto kernel' || continue
    _td_out="$_td_out $_td_i"
  done
  echo "${_td_out# }"
}

# ---- 直连模式：安装绕过规则 ----
# 前置：tunhs_pick_upstream 已成功（TUNHS_UP_DEV/VIA 就绪）。
# $1 = 下游列表（空格分隔）。幂等：链先 -F 清空重建，路由 replace 去重。
tunhs_direct_install() {
  _di_up=$TUNHS_UP_DEV
  [ -n "$_di_up" ] || return 1
  # 1) 路由表 8995：默认走真实上游 + 上游/下游直连子网（回程包送回热点网卡必需）
  $TUNHS_IP route flush table "$TUNHS_TABLE" >/dev/null 2>&1
  if [ -n "$TUNHS_UP_VIA" ]; then
    $TUNHS_IP route replace default via "$TUNHS_UP_VIA" dev "$_di_up" table "$TUNHS_TABLE" 2>>"$TUNHS_LOG" || return 1
  else
    $TUNHS_IP route replace default dev "$_di_up" table "$TUNHS_TABLE" 2>>"$TUNHS_LOG" || return 1
  fi
  _di_net=$($TUNHS_IP -4 route show dev "$_di_up" 2>/dev/null | awk '/proto kernel/{print $1; exit}')
  [ -n "$_di_net" ] && $TUNHS_IP route replace "$_di_net" dev "$_di_up" table "$TUNHS_TABLE" 2>>"$TUNHS_LOG"
  for _di_d in $1; do
    _di_dn=$($TUNHS_IP -4 route show dev "$_di_d" 2>/dev/null | awk '/proto kernel/{print $1; exit}')
    [ -n "$_di_dn" ] && $TUNHS_IP route replace "$_di_dn" dev "$_di_d" table "$TUNHS_TABLE" 2>>"$TUNHS_LOG"
  done
  # 2) 策略路由（在 mihomo 9000 规则之前）：8990=上游回程、8991..=各下游、
  #    8999=not iif lo 兜底（个别设备 ip 不支持此语法，失败不致命——逐网卡规则已覆盖）
  _di_p=$TUNHS_PREF_MIN
  while $TUNHS_IP rule del pref "$_di_p" 2>/dev/null; do :; done
  $TUNHS_IP rule add pref "$_di_p" iif "$_di_up" lookup "$TUNHS_TABLE" 2>>"$TUNHS_LOG" || return 1
  for _di_d in $1; do
    _di_p=$((_di_p + 1))
    [ "$_di_p" -ge "$TUNHS_PREF_MAX" ] && break
    while $TUNHS_IP rule del pref "$_di_p" 2>/dev/null; do :; done
    $TUNHS_IP rule add pref "$_di_p" iif "$_di_d" lookup "$TUNHS_TABLE" 2>>"$TUNHS_LOG" || return 1
  done
  while $TUNHS_IP rule del pref "$TUNHS_PREF_MAX" 2>/dev/null; do :; done
  $TUNHS_IP rule add pref "$TUNHS_PREF_MAX" not iif lo lookup "$TUNHS_TABLE" 2>>"$TUNHS_LOG"
  # 3+4) filter 兜底（上下游双向放行）与 NAT 兜底（MASQUERADE）：
  #   · nft 后端（fw4 等）→ 插进 inet fw4 的 forward/srcnat（或独立表）；
  #   · iptables 后端 → 原有 filter/nat 兜底链。
  if [ "$TUNHS_BACKEND" = "nft" ]; then
    tunhs_nft_install_direct "$_di_up" "$1" || return 1
    return 0
  fi
  $TUNHS_IPT -w -N "$TUNHS_CHAIN" 2>/dev/null
  $TUNHS_IPT -w -F "$TUNHS_CHAIN" 2>/dev/null
  for _di_d in $1; do
    $TUNHS_IPT -w -A "$TUNHS_CHAIN" -i "$_di_d" -o "$_di_up" -j ACCEPT 2>>"$TUNHS_LOG"
    $TUNHS_IPT -w -A "$TUNHS_CHAIN" -i "$_di_up" -o "$_di_d" -j ACCEPT 2>>"$TUNHS_LOG"
  done
  $TUNHS_IPT -w -C FORWARD -j "$TUNHS_CHAIN" 2>/dev/null || $TUNHS_IPT -w -A FORWARD -j "$TUNHS_CHAIN" 2>>"$TUNHS_LOG"
  # 4) NAT 兜底链：MASQUERADE（系统 NAT 已在时先命中系统的，无双重 NAT）
  $TUNHS_IPT -w -t nat -N "$TUNHS_CHAIN" 2>/dev/null
  $TUNHS_IPT -w -t nat -F "$TUNHS_CHAIN" 2>/dev/null
  for _di_d in $1; do
    _di_dn=$($TUNHS_IP -4 route show dev "$_di_d" 2>/dev/null | awk '/proto kernel/{print $1; exit}')
    [ -n "$_di_dn" ] && $TUNHS_IPT -w -t nat -A "$TUNHS_CHAIN" -s "$_di_dn" -o "$_di_up" -j MASQUERADE 2>>"$TUNHS_LOG"
  done
  $TUNHS_IPT -w -t nat -C POSTROUTING -j "$TUNHS_CHAIN" 2>/dev/null || $TUNHS_IPT -w -t nat -A POSTROUTING -j "$TUNHS_CHAIN" 2>>"$TUNHS_LOG"
  return 0
}

# 无条件清残：状态文件丢失但规则可能还在（手动清过 run/、脚本热更新等）。
# 仅在内核未运行时调用，避免误拆在线规则；同时兜底拆候选网卡名。
tun_hotspot_orphan_clean() {
  running && return 0
  _tunhs_bins
  [ -n "$TUNHS_IPT" ] || [ -n "$TUNHS_NFT" ] || return 0
  _to_old=""
  [ -f "$TUNHS_STATE" ] && _to_old=$(grep '^iface=' "$TUNHS_STATE" 2>/dev/null | cut -d= -f2)
  for _to_i in "$_to_old" "$(tunhs_cfg_tun_field device)" mihomo Meta0 Meta1 Meta2; do
    [ -n "$_to_i" ] || continue
    tunhs_teardown_rules "$_to_i"     # 内部全量拆除（FORWARD/v6/8995/nft 一并）
  done
  tunhs_restore_rp
  rm -f "$TUNHS_STATE" "$TUNHS_NOIPT" "$TUNHS_NOIP" "$TUNHS_RP" "$RUNDIR/tunhs.pickfail" "$RUNDIR/tunhs.miss"
  rm -rf "$TUNHS_LOCK" 2>/dev/null
  return 0
}

# 锁龄（秒）：锁目录 mtime 与当前时间差。stat 与 busybox stat 都不可用时
# 回 0（视为新锁不回收——宁可慢自愈也不误拆活锁）。
tunhs_lock_age() {
  _la_now=$(date +%s 2>/dev/null)
  _la_mt=$(stat -c %Y "$TUNHS_LOCK" 2>/dev/null || "$BUSYBOX" stat -c %Y "$TUNHS_LOCK" 2>/dev/null)
  case "$_la_now" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  case "$_la_mt" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  _la_a=$((_la_now - _la_mt))
  [ "$_la_a" -lt 0 ] && _la_a=0
  echo "$_la_a"
}

# 陈旧锁判定（纯判定不写日志，diag 也复用）。真机 1619 教训：锁目录在 /data
# 持久化，服务被杀/系统重启若恰有对账持锁中 → 锁永久残留 → 之后所有对账
# 静默跳过 → 状态冻结在旧模式、log 一字不出、iptables 重启清空后不再重装。
# 判定：持有 pid 已死（kill -0 失败）→ 陈旧；无 pid 文件（1552 及更早的
# 锁格式）且龄≥10s → 陈旧；锁龄≥60s（对账正常 1~3s，兼顾 pid 复用误判）→ 陈旧。
tunhs_lock_stale() {
  _lk_pid=$(cat "$TUNHS_LOCK/pid" 2>/dev/null)
  case "$_lk_pid" in ''|*[!0-9]*) _lk_pid=0 ;; esac
  _lk_age=$(tunhs_lock_age)
  if [ "$_lk_pid" -gt 0 ]; then
    kill -0 "$_lk_pid" 2>/dev/null && [ "$_lk_age" -lt 60 ] && return 1
  else
    [ "$_lk_age" -lt 10 ] && return 1    # 刚 mkdir、pid 写入前的微小窗口
  fi
  return 0
}

# 对账入口：加互斥锁后转 _tunhs_sync_body（锁机制见 TUNHS_LOCK 注释）。
tun_hotspot_sync() {
  # 开热点当下就把 br0 等下游口的 disable_ipv6 交还系统，避免等 IPv6 看门狗下一拍。
  si_restore_tether_ipv6 2>/dev/null
  # 锁被占用 = 已有对账在跑：直接跳过本轮（对账是收敛式的，在跑的那次会算出
  # 同样的终态）。绝不强行突破——真机观察到并发对账互相踩踏：一方 teardown
  # 到一半，另一方的「上游发现」读到被拆空的表 8995/规则 → 误判失败 →
  # 翻回代理模式 → 数秒后再翻回来，direct↔proxy 每 5 秒振荡。
  # 陈旧锁由 tunhs_lock_stale 判定后回收（pid 已死 / 龄超限 / 旧格式无 pid）。
  _sy_i=0
  while ! mkdir "$TUNHS_LOCK" 2>/dev/null; do
    _sy_i=$((_sy_i + 1))
    [ "$_sy_i" -gt 9 ] && return 0
    if tunhs_lock_stale; then
      tunhs_log "lock: 回收陈旧锁 pid=$(cat "$TUNHS_LOCK/pid" 2>/dev/null) age=$(tunhs_lock_age)s"
      rm -rf "$TUNHS_LOCK" 2>/dev/null
      continue
    fi
    [ "$_sy_i" -ge 5 ] && return 0    # ~1s 仍在跑：跳过本轮
    nap 0.2
  done
  echo "$$" > "$TUNHS_LOCK/pid" 2>/dev/null
  _tunhs_sync_body
  _sy_rc=$?
  # 只释放自己持有的锁：期间若被回收重建（持有者已换人）则不动它
  [ "$(cat "$TUNHS_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$TUNHS_LOCK" 2>/dev/null
  return $_sy_rc
}

# 对账式同步：期望态(内核运行 && TUN开启 && 网卡已建 && hotspot_proxy设置 && 上/下游)
# vs 已应用态(状态文件, ver=3)。幂等：无变化时零 iptables/ip 调用；变化时先全量
# 拆旧再装新。direct 模式每轮先重新发现上游（网络切换 5s 内自动重建表 8995），
# 发现失败回退 proxy 模式（绝不让热点断网）。期望「无直连」时检测残留并自愈清除。
_tunhs_sync_body() {
  _tunhs_bins
  # —— 已应用态（先解析：滞回逻辑需要知道当前是否 direct）——
  _ts_have=0; _ts_have_iface=""; _ts_have_v6=off; _ts_have_mode=proxy; _ts_have_ver=0; _ts_have_up=""; _ts_have_downs=""; _ts_have_backend=""
  if [ -f "$TUNHS_STATE" ]; then
    _ts_have=1
    _ts_have_iface=$(grep '^iface=' "$TUNHS_STATE" 2>/dev/null | cut -d= -f2)
    _ts_have_mode=$(grep '^mode=' "$TUNHS_STATE" 2>/dev/null | cut -d= -f2)
    [ -z "$_ts_have_mode" ] && _ts_have_mode=proxy
    _ts_have_ver=$(grep '^ver=' "$TUNHS_STATE" 2>/dev/null | cut -d= -f2)
    _ts_have_up=$(grep '^up=' "$TUNHS_STATE" 2>/dev/null | cut -d= -f2)
    _ts_have_downs=$(grep '^downs=' "$TUNHS_STATE" 2>/dev/null | cut -d= -f2)
    _ts_have_backend=$(grep '^backend=' "$TUNHS_STATE" 2>/dev/null | cut -d= -f2)
    [ -z "$_ts_have_backend" ] && _ts_have_backend=ipt
    grep -q '^v6=on' "$TUNHS_STATE" 2>/dev/null && _ts_have_v6=on
  fi
  # —— 期望态 ——
  _ts_want=0; _ts_iface=""; _ts_tun_up=0
  if running && runtime_tun_enabled; then
    _ts_tun_up=1
    _ts_iface=$(tunhs_find_iface)
    [ -n "$_ts_iface" ] && _ts_want=1
  fi
  # 宽限：内核在跑、TUN 已启用、只是网卡还没建出来（restart 保留规则后内核刚拉起 /
  # 热重载重建 TUN 的窗口期），已装规则先留着——规则只引用网卡名，网卡重建后照常
  # 生效；立刻拆再过几百毫秒重装纯属抖动（与 tproxy 的 grace 同理）。连续 6 轮
  # （start 后台对账 0.5s/轮 ≈3s；监听循环 3s/轮 ≈18s）仍无网卡才真正拆除。
  if [ "$_ts_want" = "0" ] && [ "$_ts_have" = "1" ] && [ "$_ts_tun_up" = "1" ]; then
    _ts_miss=$(cat "$RUNDIR/tunhs.miss" 2>/dev/null)
    case "$_ts_miss" in ''|*[!0-9]*) _ts_miss=0 ;; esac
    _ts_miss=$((_ts_miss + 1))
    echo "$_ts_miss" > "$RUNDIR/tunhs.miss" 2>/dev/null
    if [ "$_ts_miss" -le 6 ]; then
      tunhs_log "grace: TUN 网卡暂未就绪 ${_ts_miss}/6，保留已装规则 iface=${_ts_have_iface:-?}"
      return 0
    fi
    tunhs_log "grace: 连续 ${_ts_miss} 轮无 TUN 网卡，按未就绪处理"
  fi
  [ -f "$RUNDIR/tunhs.miss" ] && rm -f "$RUNDIR/tunhs.miss" 2>/dev/null
  if [ "$(get_setting hotspot_proxy true)" = "false" ]; then _ts_mode=direct; else _ts_mode=proxy; fi
  _ts_up=""; _ts_downs=""
  if [ "$_ts_want" = "1" ] && [ "$_ts_mode" = "direct" ]; then
    if [ -n "$TUNHS_IP" ] && tunhs_pick_upstream "$_ts_iface"; then
      _ts_up=$TUNHS_UP_DEV
      _ts_downs=$(tunhs_list_downs "$_ts_up" "$_ts_iface")
      rm -f "$RUNDIR/tunhs.pickfail" 2>/dev/null
    elif [ "$_ts_have" = "1" ] && [ "$_ts_have_mode" = "direct" ] && [ "$_ts_have_ver" = "3" ]; then
      # 滞回（防振荡）：上游发现偶发失败（并发/瞬时 netlink 抖动）时保留现有
      # 直连规则不拆；连续 3 次（≈15s）都失败才真正回退代理。真机观察到
      # 单次失败即回退导致 direct↔proxy 每 5 秒翻一次面。
      _ts_pf=$(cat "$RUNDIR/tunhs.pickfail" 2>/dev/null)
      case "$_ts_pf" in ''|*[!0-9]*) _ts_pf=0 ;; esac
      _ts_pf=$((_ts_pf + 1))
      echo "$_ts_pf" > "$RUNDIR/tunhs.pickfail" 2>/dev/null
      if [ "$_ts_pf" -lt 3 ]; then
        tunhs_log "picker fail #$_ts_pf（保留现有直连规则）${TUNHS_UP_EV:+ $TUNHS_UP_EV}"
        return 0
      fi
      rm -f "$RUNDIR/tunhs.pickfail" 2>/dev/null
      _ts_mode=proxy    # 连续失败：真回退代理（状态会显示 fb）
    else
      # 无现有直连可保：回退代理（fb）。1619 真机教训：fb 态的 picker 失败
      # 此前完全静默（早退不写日志），无法区分「持续失败」与「对账没在跑」；
      # 现节流留痕：第 1 次与其后每 12 次（≈1 分钟）记一条带来源证据的日志。
      _ts_pf=$(cat "$RUNDIR/tunhs.pickfail" 2>/dev/null)
      case "$_ts_pf" in ''|*[!0-9]*) _ts_pf=0 ;; esac
      _ts_pf=$((_ts_pf + 1))
      echo "$_ts_pf" > "$RUNDIR/tunhs.pickfail" 2>/dev/null
      if [ "$_ts_pf" -eq 1 ] || [ $((_ts_pf % 12)) -eq 0 ]; then
        tunhs_log "picker fail #$_ts_pf（fb 维持 proxy）${TUNHS_UP_EV:+ $TUNHS_UP_EV}"
      fi
      _ts_mode=proxy
    fi
  fi
  if [ "$_ts_want" = "1" ] && [ "$(tunhs_cfg_ipv6)" = "true" ]; then _ts_v6=on; else _ts_v6=off; fi
  # —— 无变化早退（含「TUN 尚未建好」的等待场景：不拆既有规则，等下轮重试）——
  # ver<3（旧版本状态）一律重建，保证旧规则/旧链被升级清洗。
  # 网卡/ipv6 变化必须重装（在最外层比较）；期望「无直连」（want=0 或
  # proxy↔proxy）必须确认无残留才早退——否则 fb 回退竞态留下的规则会一直
  # 挂着（真机观察到 mode=proxy 状态与 8990/8991/8999 规则共存）；
  # direct 稳态额外确认规则仍在（被外部删除时自愈重装）。
  if [ "$_ts_want" = "$_ts_have" ] && [ "$_ts_have_ver" = "3" ] \
     && [ "$_ts_iface" = "$_ts_have_iface" ] && [ "$_ts_v6" = "$_ts_have_v6" ]; then
    if [ "$_ts_want" = "0" ] || { [ "$_ts_mode" = "proxy" ] && [ "$_ts_have_mode" = "proxy" ]; }; then
      # 快轮：跳过 ip rule/iptables 直连残留扫描（全量轮再查）；但规则在场校验
      # 保留 —— fw4 reload 清表后靠它在下一个 60s 快轮自愈，nft 一条 list 即可
      # 确认（与被跳过的抽查同量级开销），iptables 后端维持快轮跳过的旧行为。
      if [ -n "$_SW_QUICK" ]; then
        if [ "$_ts_want" = "1" ] && [ "$TUNHS_BACKEND" = "nft" ] && ! tunhs_rules_ok proxy "$_ts_iface"; then
          :   # 放行规则被清（fw4 reload 等）：继续往下重装
        else
          return 0
        fi
      elif ! tunhs_stale_present; then
        if [ "$_ts_want" = "1" ] && ! tunhs_rules_ok proxy "$_ts_iface"; then
          :   # 放行规则被外部清掉（防火墙刷新等）：继续往下重装
        else
          return 0
        fi
      fi
    elif [ "$_ts_mode" = "direct" ] && [ "$_ts_have_mode" = "direct" ]; then
      if [ -n "$_SW_QUICK" ]; then
        # 快轮：只比对上/下游记录 + 规则在场校验，不复核内核规则（ip rule 开销
        # 大），全量轮再验
        if [ "$_ts_up" = "$_ts_have_up" ] && [ "$_ts_downs" = "$_ts_have_downs" ] && tunhs_rules_ok direct; then
          return 0
        fi
      else
        if [ "$_ts_up" = "$_ts_have_up" ] && [ "$_ts_downs" = "$_ts_have_downs" ] && tunhs_bypass_have && tunhs_rules_ok direct; then
          return 0
        fi
      fi
    fi
  fi
  # —— heal-reinstall：direct→direct 且上/下游未变，只是规则被外部清了
  # （bypass_have 检测失败）→ 不 teardown，直接幂等重装（install 内部每条
  # 规则先删后加、链先 -F、表先 flush），省一次全套拆除的抖动窗口。
  _ts_heal=0
  if [ "$_ts_have" = "1" ] && [ "$_ts_want" = "1" ] && [ "$_ts_mode" = "direct" ] && [ "$_ts_have_mode" = "direct" ] && [ "$_ts_have_ver" = "3" ] && [ "$_ts_up" = "$_ts_have_up" ] && [ "$_ts_downs" = "$_ts_have_downs" ]; then
    _ts_heal=1
    tunhs_clear_band                 # 带内残留（外部注入/竞态遗留）清掉再重装
    tunhs_log "heal-reinstall: 直连规则缺失，原参数重装 up=$_ts_up"
  fi
  # —— 拆旧（全量：FORWARD 放行 / v6 策略 / 8995 规则+表 / 兜底链）——
  if [ "$_ts_have" = "1" ] && [ "$_ts_heal" = "0" ]; then
    tunhs_teardown_rules "$_ts_have_iface"
    tunhs_restore_rp
    rm -f "$TUNHS_STATE"
    tunhs_log "teardown iface=${_ts_have_iface:-?} v6=$_ts_have_v6 mode=$_ts_have_mode up=${_ts_have_up:-?} (want=$_ts_want mode=$_ts_mode up=${_ts_up:-?})"
  fi
  [ "$_ts_want" = "1" ] || {
    rm -f "$TUNHS_NOIPT" "$TUNHS_NOIP" "$TUNHS_RP" "$RUNDIR/tunhs.pickfail"
    # 无状态却有残留（异常退出/竞态遗留/run 被手清）→ 兜底拆一次。直连查
    # ip rule 带 + 兜底链；nft 后端任意标记（含代理模式放行）都认得出来。
    if [ -z "$_SW_QUICK" ] && { tunhs_stale_present || tunhs_nft_any_present; }; then
      tunhs_teardown_rules "$_ts_have_iface"
      tunhs_restore_rp
      tunhs_log "heal: 清除无状态残留的接管规则"
    fi
    return 0
  }
  # —— 装新：公共 sysctl ——
  # rp 原值只在首次应用时记录（tunhs.rp 已存在说明是模式/网卡切换，原值继续沿用）
  if [ ! -f "$TUNHS_RP" ]; then
    printf 'rp_all=%s\nrp_def=%s\n' \
      "$(cat /proc/sys/net/ipv4/conf/all/rp_filter 2>/dev/null)" \
      "$(cat /proc/sys/net/ipv4/conf/default/rp_filter 2>/dev/null)" > "$TUNHS_RP" 2>/dev/null
  fi
  echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null
  echo 2 > /proc/sys/net/ipv4/conf/all/rp_filter 2>/dev/null
  echo 2 > /proc/sys/net/ipv4/conf/default/rp_filter 2>/dev/null
  # —— 装新：直连模式 ——
  if [ "$_ts_mode" = "direct" ]; then
    if [ -z "$TUNHS_IP" ]; then
      if [ ! -f "$TUNHS_NOIP" ]; then
        tunhs_log "WARN 系统无 ip 命令，热点直连绕过未生效"
        touch "$TUNHS_NOIP" 2>/dev/null
      fi
      return 1
    fi
    rm -f "$TUNHS_NOIPT" "$TUNHS_NOIP"
    if tunhs_direct_install "$_ts_downs"; then
      # 热点 v6 一并拦掉（直连仅 v4；防客户端 v6 走系统 NAT66 直连泄漏）。
      # nft 后端的 v6 拦截已由 tunhs_nft_install_direct 一并装好。
      if [ "$TUNHS_BACKEND" != "nft" ] && [ -n "$TUNHS_IP6T" ]; then
        $TUNHS_IP6T -w -C FORWARD -j REJECT 2>/dev/null || $TUNHS_IP6T -w -I FORWARD -j REJECT 2>>"$TUNHS_LOG"
        $TUNHS_IP6T -w -C OUTPUT -p icmpv6 --icmpv6-type 134 -j DROP 2>/dev/null || $TUNHS_IP6T -w -I OUTPUT -p icmpv6 --icmpv6-type 134 -j DROP 2>>"$TUNHS_LOG"
      fi
      printf 'iface=%s\nmode=direct\nv6=off\nver=3\nup=%s\ndowns=%s\n' "$_ts_iface" "$_ts_up" "$_ts_downs" > "$TUNHS_STATE" 2>/dev/null
      tunhs_log "apply-direct iface=$_ts_iface up=$_ts_up downs=[$_ts_downs] table=$TUNHS_TABLE pref=$TUNHS_PREF_MIN-$TUNHS_PREF_MAX backend=${TUNHS_BACKEND:-ipt}"
      ( boot_data_sync ) >/dev/null 2>&1 &
      return 0
    fi
    tunhs_log "WARN 直连模式安装失败，回退代理模式"
    _ts_mode=proxy
  fi
  # —— 装新：代理模式 ——
  if [ "$TUNHS_BACKEND" = "nft" ]; then
    if [ -z "$TUNHS_NFT" ]; then
      if [ ! -f "$TUNHS_NOIPT" ]; then
        tunhs_log "WARN 系统无 nft 命令，热点转发放行未生效"
        touch "$TUNHS_NOIPT" 2>/dev/null
      fi
      return 1
    fi
    rm -f "$TUNHS_NOIPT" "$TUNHS_NOIP"
    if tunhs_nft_install_proxy "$_ts_iface" "$_ts_v6"; then
      if [ "$_ts_v6" = "on" ]; then
        echo 1 > /proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null
      fi
      printf 'iface=%s\nmode=proxy\nv6=%s\nver=3\nbackend=nft\n' "$_ts_iface" "$_ts_v6" > "$TUNHS_STATE" 2>/dev/null
      tunhs_log "apply iface=$_ts_iface v6=$_ts_v6 mode=proxy backend=nft"
      ( boot_data_sync ) >/dev/null 2>&1 &
      return 0
    fi
    tunhs_log "WARN nft 热点转发放行安装失败（iface=$_ts_iface）"
    return 1
  fi
  if [ -z "$TUNHS_IPT" ]; then
    if [ ! -f "$TUNHS_NOIPT" ]; then
      tunhs_log "WARN 系统无 iptables，热点转发放行未生效"
      touch "$TUNHS_NOIPT" 2>/dev/null
    fi
    return 1
  fi
  rm -f "$TUNHS_NOIPT" "$TUNHS_NOIP"
  $TUNHS_IPT -w -C FORWARD -i "$_ts_iface" -j ACCEPT 2>/dev/null || $TUNHS_IPT -w -I FORWARD -i "$_ts_iface" -j ACCEPT 2>>"$TUNHS_LOG"
  $TUNHS_IPT -w -C FORWARD -o "$_ts_iface" -j ACCEPT 2>/dev/null || $TUNHS_IPT -w -I FORWARD -o "$_ts_iface" -j ACCEPT 2>>"$TUNHS_LOG"
  if [ "$_ts_v6" = "on" ]; then
    echo 1 > /proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null
    if [ -n "$TUNHS_IP6T" ]; then
      $TUNHS_IP6T -w -C FORWARD -i "$_ts_iface" -j ACCEPT 2>/dev/null || $TUNHS_IP6T -w -I FORWARD -i "$_ts_iface" -j ACCEPT 2>>"$TUNHS_LOG"
      $TUNHS_IP6T -w -C FORWARD -o "$_ts_iface" -j ACCEPT 2>/dev/null || $TUNHS_IP6T -w -I FORWARD -o "$_ts_iface" -j ACCEPT 2>>"$TUNHS_LOG"
    fi
  elif [ -n "$TUNHS_IP6T" ]; then
    # ipv6=false：拦住热点 v6 转发并掐掉外发 RA，客户端立即回落 v4 全量走 TUN
    $TUNHS_IP6T -w -C FORWARD -j REJECT 2>/dev/null || $TUNHS_IP6T -w -I FORWARD -j REJECT 2>>"$TUNHS_LOG"
    $TUNHS_IP6T -w -C OUTPUT -p icmpv6 --icmpv6-type 134 -j DROP 2>/dev/null || $TUNHS_IP6T -w -I OUTPUT -p icmpv6 --icmpv6-type 134 -j DROP 2>>"$TUNHS_LOG"
  fi
  printf 'iface=%s\nmode=proxy\nv6=%s\nver=3\nbackend=ipt\n' "$_ts_iface" "$_ts_v6" > "$TUNHS_STATE" 2>/dev/null
  tunhs_log "apply iface=$_ts_iface v6=$_ts_v6 mode=proxy backend=ipt"
  ( boot_data_sync ) >/dev/null 2>&1 &
  return 0
}

# 状态短串（status_json / tun-hotspot-status 共用；只读状态文件，零 iptables/ip 调用）
tunhs_status_short() {
  # $1 可选：调用方已判好的「配置是否启用 TUN」(1/0)，传入即省一次 awk+grep 扫配置
  if [ -n "$1" ]; then
    [ "$1" = "1" ] && running
  else
    running && runtime_tun_enabled
  fi
  if [ $? -eq 0 ]; then
    if [ -f "$TUNHS_STATE" ]; then
      _tsi=$(grep '^iface=' "$TUNHS_STATE" 2>/dev/null | cut -d= -f2)
      if grep -q '^v6=on' "$TUNHS_STATE" 2>/dev/null; then _tsv=on; else _tsv=off; fi
      _tsm=$(grep '^mode=' "$TUNHS_STATE" 2>/dev/null | cut -d= -f2)
      [ -z "$_tsm" ] && _tsm=proxy
      # 设置要直连但实际是 proxy = 直连安装失败/无上游而回退（fb），前端要能看出来
      setting_v hotspot_proxy true
      if [ "$_tsm" = "proxy" ] && [ "$SV" = "false" ]; then
        _tsm=fb
      fi
      echo "on:iface=${_tsi:-?}:v6=$_tsv:mode=$_tsm"
    else
      echo "pending"
    fi
  else
    echo "off"
  fi
}

# 全量诊断：同时收集 Mihomo 核心 TUN 路由和模块热点转发规则。
# 核心 TUN 规则由 Mihomo 安装，tunhs.state 只代表热点 FORWARD 规则；必须分开展示，
# 否则「热点规则已装」会被误读成「核心 TUN 已接管」。输出也带最近生命周期 trace，
# 便于把 core_spawned/core_ready 与规则落地日志按同一时间线对齐。
_tunhs_diag_config_tun() {
  _tdc_file=$1
  [ -r "$_tdc_file" ] || { echo "(不可读: $_tdc_file)"; return 0; }
  awk '
    BEGIN { n=split("enable device stack auto-route strict-route auto-redirect route-table", k, " ") }
    /^[^ \t#-]/ { inb=($1 == "tun:") }
    inb && /^tun:[ \t]*\{/ {
      line=$0
      for (i=1; i<=n; i++) if (match(line, k[i] ":[ \t]*")) {
        v[k[i]]=substr(line, RSTART+RLENGTH); sub(/[,}].*$/, "", v[k[i]])
        gsub(/["\047]/, "", v[k[i]]); sub(/[ \t]+$/, "", v[k[i]])
      }
    }
    inb { for (i=1; i<=n; i++) if ($1 == k[i] ":") {
      v[k[i]]=$2; gsub(/["\047]/, "", v[k[i]])
    } }
    END { for (i=1; i<=n; i++) printf "  %s=%s\n", k[i], (v[k[i]] == "" ? "<未设置>" : v[k[i]]) }
  ' "$_tdc_file" 2>/dev/null
}

# 从 Mihomo /configs JSON 中抽出 tun 对象（处理字符串转义与嵌套对象）。
_diag_api_tun_object() {
  awk '
    {
      key="\"tun\":"; p=index($0,key); if (!p) next
      s=substr($0,p+length(key)); depth=0; quoted=0; escaped=0
      for (i=1; i<=length(s); i++) {
        c=substr(s,i,1)
        if (quoted) {
          if (escaped) escaped=0
          else if (c=="\\") escaped=1
          else if (c=="\"") quoted=0
        } else if (c=="\"") quoted=1
        else if (c=="{") depth++
        else if (c=="}") { depth--; if (depth==0) { print substr(s,1,i); exit } }
      }
      exit
    }
  ' 2>/dev/null
}

tun_hotspot_diag() {
  now_cs; _dg_t_start=$NOW_CS
  _tunhs_bins
  echo "== 模块设置 =="
  grep -E '^(core|hotspot_proxy|autostart|tproxy)=' "$SETTINGS" 2>/dev/null
  echo "== 内核状态 =="
  if running; then
    _dg_pid=$(pid_of)
    echo "running pid $_dg_pid"
    [ -r "/proc/$_dg_pid/cmdline" ] && printf 'cmdline: %s\n' "$(tr '\000' ' ' < "/proc/$_dg_pid/cmdline" 2>/dev/null | cut -c1-240)"
  else
    echo "stopped"
  fi
  echo "== TUN 配置（磁盘：下次启动期望值） =="
  _tunhs_diag_config_tun "$CONFIG"
  echo "== TUN 配置（active-config：当前内核启动快照） =="
  _tunhs_diag_config_tun "$RUNDIR/active-config.yaml"
  echo "== Mihomo API 实际 TUN 配置 =="
  if running; then
    _dg_api=$(MH_API_TIMEOUT=1 api GET /configs 2>/dev/null)
    _dg_api_tun=$(printf '%s\n' "$_dg_api" | _diag_api_tun_object)
    [ -n "$_dg_api_tun" ] && echo "tun=$_dg_api_tun" || echo "(API 不可达 / 未返回 tun 对象)"
  else
    echo "(内核未运行)"
  fi
  echo "== TUN / eBPF / Tproxy 状态文件 =="
  echo "tunhs.state:"
  cat "$TUNHS_STATE" 2>/dev/null || echo "(无)"
  echo "tproxy.state:"
  cat "$TP_STATE" 2>/dev/null || echo "(无)"
  echo "ebpf.active: $(cat "$RUNDIR/ebpf.active" 2>/dev/null || echo '(无)')"
  echo "== tunhs.pickfail =="
  cat "$RUNDIR/tunhs.pickfail" 2>/dev/null || echo "(无)"
  echo "== 规则状态文件时间 =="
  _dg_now=$(date +%s 2>/dev/null)
  for _dg_f in "$TUNHS_STATE" "$TP_STATE"; do
    if [ -f "$_dg_f" ]; then
      _dg_mt=$(stat -c %Y "$_dg_f" 2>/dev/null || "$BUSYBOX" stat -c %Y "$_dg_f" 2>/dev/null)
      case "$_dg_now:$_dg_mt" in *[!0-9:]*) echo "${_dg_f##*/}: 时间不可读" ;;
        *) echo "${_dg_f##*/}: mtime=$_dg_mt age=$((_dg_now - _dg_mt))s" ;;
      esac
    else
      echo "${_dg_f##*/}: (无)"
    fi
  done
  echo "== 监听循环心跳 =="
  if [ -f "$RUNDIR/tunhs.beat" ]; then
    _dg_bn=$(date +%s 2>/dev/null)
    _dg_bm=$(stat -c %Y "$RUNDIR/tunhs.beat" 2>/dev/null || "$BUSYBOX" stat -c %Y "$RUNDIR/tunhs.beat" 2>/dev/null)
    _dg_ok=1
    case "$_dg_bn" in ''|*[!0-9]*) _dg_ok=0 ;; esac
    case "$_dg_bm" in ''|*[!0-9]*) _dg_ok=0 ;; esac
    if [ "$_dg_ok" = "1" ]; then
      _dg_ba=$((_dg_bn - _dg_bm)); [ "$_dg_ba" -lt 0 ] && _dg_ba=0
      if [ "$_dg_ba" -lt 30 ]; then echo "存活（${_dg_ba}s 前心跳）"
      else echo "疑似未运行（${_dg_ba}s 前心跳）——监听循环未启动或已卡死"; fi
    else echo "(心跳时间戳不可读)"; fi
  else echo "(无心跳文件——监听循环未跑过)"; fi
  echo "== 对账锁 =="
  if [ -d "$TUNHS_LOCK" ]; then
    _dg_lk="存在: pid=$(cat "$TUNHS_LOCK/pid" 2>/dev/null)"
    if tunhs_lock_stale; then _dg_lk="$_dg_lk age=$(tunhs_lock_age)s [陈旧]"; else _dg_lk="$_dg_lk age=$(tunhs_lock_age)s [持有中]"; fi
    _dg_lpid=$(cat "$TUNHS_LOCK/pid" 2>/dev/null)
    case "$_dg_lpid" in ''|*[!0-9]*) ;; *)
      [ -r "/proc/$_dg_lpid/cmdline" ] && _dg_lk="$_dg_lk cmd=$(tr '\000' ' ' < "/proc/$_dg_lpid/cmdline" 2>/dev/null | cut -c1-160)" ;;
    esac
    echo "$_dg_lk"
  else echo "(空闲)"; fi
  now_cs; _dg_t_state=$((NOW_CS - _dg_t_start)); _dg_t_mark=$NOW_CS
  echo "== 网卡列表 =="
  ls /sys/class/net 2>/dev/null | tr '\n' ' '; echo
  _dg_iface=$(tunhs_find_iface 2>/dev/null)
  echo "TUN 接口期望=$(tunhs_cfg_tun_field device) 实际=${_dg_iface:-<不存在>}"
  if [ -n "$_dg_iface" ] && [ -n "$TUNHS_IP" ]; then
    echo "== TUN 接口 link =="
    $TUNHS_IP -details link show dev "$_dg_iface" 2>&1
    echo "== TUN 接口 IPv4 地址 =="
    $TUNHS_IP -4 addr show dev "$_dg_iface" 2>&1
    echo "== TUN 接口 IPv6 地址 =="
    $TUNHS_IP -6 addr show dev "$_dg_iface" 2>&1
  fi
  if [ -n "$TUNHS_IP" ]; then
    _dg_rt=$( ( CONFIG="$RUNDIR/active-config.yaml"; tunhs_cfg_tun_field route-table ) 2>/dev/null)
    case "$_dg_rt" in ''|*[!0-9]*) _dg_rt=2022 ;; esac
    echo "== 核心 TUN 策略路由（9000-9010 / route-table=$_dg_rt） =="
    _dg_rules=$($TUNHS_IP rule show 2>&1)
    printf '%s\n' "$_dg_rules" | grep -E '(^|[[:space:]])90(0[0-9]|10):|lookup 2022|table 2022|iif .*mihomo' || echo "(未发现 Mihomo TUN 核心规则)"
    echo "== 核心 TUN IPv4 路由表 $_dg_rt =="
    $TUNHS_IP -4 route show table "$_dg_rt" 2>&1
    echo "== 核心 TUN IPv6 路由表 $_dg_rt =="
    $TUNHS_IP -6 route show table "$_dg_rt" 2>&1
    if [ "$_dg_rt" != 2022 ]; then
      echo "== 默认表 2022（对照） =="
      $TUNHS_IP route show table 2022 2>&1
    fi
    echo "== 默认路由（IPv4，各表） =="
    $TUNHS_IP -4 route show table all 2>&1 | grep -E '^default |[Ee]rror|[Uu]sage' || echo "(空)"
    echo "== 默认路由（IPv6，各表） =="
    $TUNHS_IP -6 route show table all 2>&1 | grep -E '^default |[Ee]rror|[Uu]sage' || echo "(空)"
    echo "== 策略路由（全部） =="
    printf '%s\n' "$_dg_rules"
    if [ "${TUNHS_DIAG_FULL:-0}" = "1" ]; then
      echo "== 默认路由（逐表兜底枚举，含命名表；完整诊断） =="
      for _dg_t in $(printf '%s\n' "$_dg_rules" | sed -n 's/.*lookup \([a-zA-Z0-9_-][a-zA-Z0-9_-]*\)$/\1/p' | sort -u); do
        $TUNHS_IP route show table "$_dg_t" 2>/dev/null | grep -E '^default ' | sed "s/^/  table $_dg_t: /"
      done
    else
      echo "== 默认路由逐表枚举已省略（设 TUNHS_DIAG_FULL=1 查看） =="
    fi
    echo "== TUN 热点直连专用表 $TUNHS_TABLE =="
    $TUNHS_IP route show table "$TUNHS_TABLE" 2>&1
  else echo "(无 ip 命令)"; fi
  if [ -n "$TUNHS_IPT" ]; then
    echo "== iptables FORWARD（相关行） =="
    $TUNHS_IPT -S FORWARD 2>&1 | grep -Ei 'mihomo|Meta|tunhs|tetherctrl' || echo "(无相关规则)"
    echo "== 链 $TUNHS_CHAIN (filter) =="
    $TUNHS_IPT -S "$TUNHS_CHAIN" 2>&1
    echo "== 链 $TUNHS_CHAIN (nat) =="
    $TUNHS_IPT -t nat -S "$TUNHS_CHAIN" 2>&1
  else echo "(无 iptables)"; fi
  now_cs; _dg_t_routes=$((NOW_CS - _dg_t_mark)); _dg_t_mark=$NOW_CS
  tunhs_diag_dnsmasq
  now_cs; _dg_t_dns=$((NOW_CS - _dg_t_mark)); _dg_t_mark=$NOW_CS
  echo "== 最近生命周期分段（action-latest.trace） =="
  cat "$RUNDIR/action-latest.trace" 2>/dev/null || echo "(无)"
  echo "== 当前启动 core.log（LOGFILE.off 之后的增量） =="
  _dg_off=$(cat "$LOGFILE.off" 2>/dev/null); _dg_size=$(wc -c < "$LOGFILE" 2>/dev/null)
  case "$_dg_off:$_dg_size" in *[!0-9:]*) tail -n 60 "$LOGFILE" 2>/dev/null ;;
    *) if [ "$_dg_size" -gt "$_dg_off" ]; then tail -c +$((_dg_off + 1)) "$LOGFILE" 2>/dev/null | tail -n 80
       else echo "(当前启动后暂无 core.log 内容)"; fi ;;
  esac
  echo "== tunhs.log 尾部（最近 60 行） =="
  tail -n 60 "$TUNHS_LOG" 2>/dev/null
  echo "== tproxy.log 尾部（最近 40 行） =="
  tail -n 40 "$TP_LOG" 2>/dev/null
  now_cs
  _dg_t_logs=$((NOW_CS - _dg_t_mark)); _dg_t_total=$((NOW_CS - _dg_t_start))
  printf '== 诊断耗时（配置/状态 %d.%02ds；接口/路由/防火墙 %d.%02ds；dnsmasq/IPv6 %d.%02ds；日志 %d.%02ds；总计 %d.%02ds） ==\n' \
    "$((_dg_t_state / 100))" "$((_dg_t_state % 100))" \
    "$((_dg_t_routes / 100))" "$((_dg_t_routes % 100))" \
    "$((_dg_t_dns / 100))" "$((_dg_t_dns % 100))" \
    "$((_dg_t_logs / 100))" "$((_dg_t_logs % 100))" \
    "$((_dg_t_total / 100))" "$((_dg_t_total % 100))"
  return 0
}

# dnsmasq 占用异常排查：CPU / 网络事件默认各采样 0.5s，尽量让一键诊断快返回；
# 需要完整取证时用 TUNHS_DIAG_FULL=1 sh mihomo.sh tun-hotspot-diag（恢复 2s/3s 采样及逐表默认路由枚举）。
# 同一诊断前段已经读取 Mihomo API TUN 配置，IPv6 速览跳过重复 API 请求。
tunhs_diag_dnsmasq() {
  _dd_cpu_wait=0.5; _dd_cpu_den=50; _dd_net_wait=0.5; _dd_net_label=0.5s
  if [ "${TUNHS_DIAG_FULL:-0}" = "1" ]; then
    _dd_cpu_wait=2; _dd_cpu_den=200; _dd_net_wait=3; _dd_net_label=3s
  fi
  echo "== dnsmasq =="
  _dd_found=0
  for _dd_c in /proc/[0-9]*/comm; do
    [ -r "$_dd_c" ] || continue
    _dd_n=""; IFS= read -r _dd_n < "$_dd_c" 2>/dev/null
    [ "$_dd_n" = "dnsmasq" ] || continue
    _dd_p=${_dd_c%/comm}; _dd_p=${_dd_p##*/}
    _dd_found=1
    echo "pid $_dd_p: $(tr '\0' ' ' < /proc/$_dd_p/cmdline 2>/dev/null | cut -c1-200)"
    _dd_t1=$(awk '{print $14+$15}' /proc/$_dd_p/stat 2>/dev/null)
    sleep "$_dd_cpu_wait"
    _dd_t2=$(awk '{print $14+$15}' /proc/$_dd_p/stat 2>/dev/null)
    case "$_dd_t1$_dd_t2" in
      ''|*[!0-9]*) echo "  CPU：无法采样" ;;
      *) echo "  CPU：约 $(( (_dd_t2 - _dd_t1) * 100 / $_dd_cpu_den ))%（${_dd_cpu_wait}s 采样，按 100 tick/s 折算；100=占满一核）" ;;
    esac
    echo "  wchan: $(cat /proc/$_dd_p/wchan 2>/dev/null)  fd 数: $(ls /proc/$_dd_p/fd 2>/dev/null | wc -l)  $(grep -E '^(State|Threads)' /proc/$_dd_p/status 2>/dev/null | tr '\n' ' ')"
  done
  [ "$_dd_found" = "1" ] || echo "(未运行——热点共享未开启？)"
  if [ -n "$TUNHS_IP" ]; then
    echo "== 内核网络事件（${_dd_net_label}采样，address/link/route） =="
    _dd_ev="$RUNDIR/dnsmasq.ev"
    : > "$_dd_ev" 2>/dev/null
    $TUNHS_IP monitor address link route > "$_dd_ev" 2>&1 &
    _dd_mp=$!
    sleep "$_dd_net_wait"
    kill "$_dd_mp" 2>/dev/null; wait "$_dd_mp" 2>/dev/null
    echo "共 $(wc -l < "$_dd_ev" 2>/dev/null) 行；样例："
    head -n 12 "$_dd_ev" 2>/dev/null | cut -c1-160 | sed 's/^/  /'
    rm -f "$_dd_ev" 2>/dev/null
  fi
  echo "== 系统 IPv6 对账 =="
  ipv6_status skip-api 2>&1 | head -n 30
  echo "== ip6tables OUTPUT（RA 丢弃） =="
  if [ -n "$TUNHS_IP6T" ]; then $TUNHS_IP6T -S OUTPUT 2>&1 | grep -i icmpv6 || echo "(无)"; else echo "(无 ip6tables)"; fi
  return 0
}

tun_hotspot_status() {
  echo "tun_hotspot: $(tunhs_status_short)"
  [ -f "$TUNHS_STATE" ] && sed 's/^/  /' "$TUNHS_STATE"
  echo "--- tunhs.log (tail) ---"
  tail -n 12 "$TUNHS_LOG" 2>/dev/null
  return 0
}

# ============================================================
# 系统 IPv6 开关（模块设置 system_ipv6，默认 false）
# ------------------------------------------------------------
#   false → 禁用系统 IPv6：所有网卡（lo 除外）disable_ipv6=1，内核协议栈
#           不再收发 v6，杜绝 v6 流量绕过代理直连；
#   true  → 启用系统 IPv6：disable_ipv6 归 0，恢复 Android 默认行为。
# Android 的 netd 会在网络事件（连 WiFi / 切数据 / 开关飞行模式 / 热点开关）
# 时重置个别网卡的 disable_ipv6 —— 新建的网卡甚至整块重建（飞行模式最容易
# 触发），只在「改设置 / 开机 / 起内核」时写一次，之后 netd 把值放回去就再也
# 没人管，面板里仍显示「已禁用」而 v6 地址已经回来了（IPv6 泄露）。
# 所以由 _switch_loop 每 IPV6_TICK（~5s）调 system_ipv6_sync 对账：
#   · 幂等 + 先读后写，值已正确时零写入；
#   · 关态下还写 conf/default/disable_ipv6=1（内核新建网卡从 dflt 复制该值），
#     飞行模式后重建的网卡一出生就是 v6 关闭，等不到下一拍对账；
#   · 漂移追打有 60s 冷却（IPV6_COOL），不会跟 netd 打成 netlink 风暴。
# 稳态下对账只有若干内建 read + 一次 stat，且零写入（不触发 netlink）。
# 与配置里 IPv6 相关开关的关系：本函数只管操作系统协议栈（sysctl/APN）本身；
# 配置里的 IPv6 相关开关（顶层 ipv6 / dns.ipv6 / eBPF 入站 local·shared.ipv6）
# 由「set system_ipv6」在切换时一并改齐并重启服务（见 cfg_ipv6_set_all），
# 系统 IPv6 开关＝总开关，不再与配置各自为政。用户之后手动改回配置里的个别
# 开关属高级用法，对账不追打配置，只按设置与 eBPF 需求维持协议栈可用性。
# 模块被停用（disable 标记）或卸载时一律还原为启用，不在系统里残留改动。
# eBPF 入站例外：仅当「活跃 eBPF 的某个启用角色 ipv6 生效」才需要 fd53:.../64
# IPv6 本地重定向路由，此时才必须保持系统 IPv6 协议栈可用；角色都不拦 v6
# （ipv6:false，模块默认配置）时不加 v6 路由，禁用系统 IPv6 完全安全。
# 判据见 ebpf_ipv6_redirect_needed()（复刻内核 requiresIPv6Redirect）。
# ============================================================

# 「活跃」= 存在未注释的 ebpf 条目，且它至少启用了一个角色。
# 角色判定与 WebUI 的 ebpfRoles() 同一套规则（内核 normalizeModeWithEnabled）：
#   · 只要 local.enable / shared.enable 任一写了值，就按 enable 判定（兼容旧键 enabled）；
#   · 否则看 mode（未写 == local，即启用）。
# 关闭 eBPF 时模块把两个 enable 都写成 false，内核会跳过该入站 —— 这种条目不算活跃，
# 不能再为它锁住系统 IPv6 协议栈。
ebpf_listener_active() {
  [ -f "$CONFIG" ] || return 1
  awk '
    function indof(s) { if (match(s, /[^ \t]/)) return RSTART - 1; return -1 }
    function keycol(s) { if (match(s, /^[ \t]*-[ \t]+/)) return RLENGTH; return indof(s) }
    function keytext(s) {
      if (match(s, /^[ \t]*-[ \t]+/)) return substr(s, RLENGTH + 1)
      if (match(s, /[^ \t]/)) return substr(s, RSTART)
      return ""
    }
    function boolof(s,   v) {                 # 取 `enable(d)?: X` 的 X，返回 1/0/-1(没写)
      if (!match(s, /enable(d)?:[ \t]*/)) return -1
      v = substr(s, RSTART + RLENGTH)
      sub(/[ \t]*[,}#].*$/, "", v); sub(/[ \t]+$/, "", v)
      if (v == "true") return 1
      if (v == "false") return 0
      return -1
    }
    # 扫一个条目，判断它是否至少启用一个角色
    function entryactive(   i, keyind, kt, rest, le, se, mode, b, role, childind, j) {
      keyind = keycol(ef[1]); le = -1; se = -1; mode = ""
      for (i = 1; i <= n; i++) {
        if (keycol(ef[i]) != keyind) continue
        kt = keytext(ef[i])
        if (kt ~ /^mode:[ \t]*/) {
          mode = substr(kt, 6); sub(/^[ \t]+/, "", mode); sub(/[ \t]*#.*$/, "", mode)
          sub(/[ \t]+$/, "", mode); gsub(/"/, "", mode); gsub(/'"'"'/, "", mode)
          continue
        }
        role = ""
        if (kt ~ /^local:/) role = "local"
        else if (kt ~ /^shared:/) role = "shared"
        if (role == "") continue
        rest = substr(kt, length(role) + 2); sub(/^[ \t]+/, "", rest)
        if (rest != "" && rest !~ /^#/) {     # 流式 local: {enable: false}
          b = boolof(rest)
        } else {                              # 块式：找直接子键里的 enable / enabled
          b = -1; childind = -1
          for (j = i + 1; j <= n; j++) {
            if (ef[j] ~ /^[ \t]*$/) continue
            if (indof(ef[j]) <= keyind) break
            if (childind < 0) childind = indof(ef[j])
            if (indof(ef[j]) == childind && ef[j] ~ /^[ \t]*enable(d)?:/) { b = boolof(ef[j]); break }
          }
        }
        if (role == "local") le = b; else se = b
      }
      if (le >= 0 || se >= 0) return (le == 1 || se == 1)    # 写了 enable/enabled：按它判定
      if (mode == "" || mode == "local" || mode == "shared" || mode == "hybrid") return 1
      return 1                                # 未知 mode：内核会报错，交给它，不在这里改 v6 策略
    }
    function flushentry(   i, isebpf) {
      if (n == 0) return
      isebpf = 0
      for (i = 1; i <= n; i++) {
        if (ef[i] ~ /^[ \t]*#/) continue
        if (ef[i] ~ /^[ \t]*type:[ \t]*["\047]?ebpf["\047]?[ \t]*(#.*)?$/ ||
            ef[i] ~ /^[ \t]*-[ \t]+type:[ \t]*["\047]?ebpf["\047]?[ \t]*(#.*)?$/) isebpf = 1
      }
      if (isebpf && entryactive()) found = 1
      n = 0
    }
    /^[^ \t#-]/ { flushentry(); inls = ($1 == "listeners:"); base = -1; next }
    {
      if (!inls || found) next
      if ($0 ~ /^[ \t]*#/) next                # 注释保留的旧条目不算数
      if ($0 ~ /^[[:space:]]*-[[:space:]]/) {
        match($0, /[^[:space:]]/); ind = RSTART - 1
        if (base < 0) base = ind
        if (ind == base) flushentry()
      }
      ef[++n] = $0
    }
    END { flushentry(); exit(found ? 0 : 1) }
  ' "$CONFIG" 2>/dev/null
}

# eBPF 是否需要 IPv6 重定向路由（fd53::/64 本地路由）——复刻内核 requiresIPv6Redirect()：
#   (local 启用 || shared-rewrite 启用) && (local.ipv6 生效 || shared.ipv6 生效)
# 只有这条为真，内核才会在启动时添加 IPv6 本地路由，此时才必须锁住系统 IPv6 协议栈
# （否则路由添加报 permission denied）。反之角色都不拦 v6（ipv6:false，模块默认配置），
# 内核根本不会碰 v6 路由，禁用系统 IPv6 就应当正常生效，不能因为「eBPF 存在」就锁死。
# 角色 ipv6 字段语义与内核一致：写了 true/false 按字段（false 优先于默认），没写默认 true。
ebpf_ipv6_redirect_needed() {
  [ -f "$CONFIG" ] || return 1
  awk '
    function indof(s) { if (match(s, /[^ \t]/)) return RSTART - 1; return -1 }
    function keycol(s) { if (match(s, /^[ \t]*-[ \t]+/)) return RLENGTH; return indof(s) }
    function keytext(s) {
      if (match(s, /^[ \t]*-[ \t]+/)) return substr(s, RLENGTH + 1)
      if (match(s, /[^ \t]/)) return substr(s, RSTART)
      return ""
    }
    function fieldof(s, key,   v) {          # 从 s 里取 key: 的值，返回 1/0/-1(没写)
      if (!match(s, key ":[ \t]*")) return -1
      v = substr(s, RSTART + RLENGTH)
      sub(/[ \t]*[,}#].*$/, "", v); sub(/[ \t]+$/, "", v)
      gsub(/["\047]/, "", v)
      if (v == "true") return 1
      if (v == "false") return 0
      return -1
    }
    function entneeds(   i, keyind, kt, rest, le, se, li, si, mode, b, childind, j, role) {
      keyind = keycol(ef[1]); le = -1; se = -1; li = -1; si = -1; mode = ""
      for (i = 1; i <= n; i++) {
        if (keycol(ef[i]) != keyind) continue
        kt = keytext(ef[i])
        if (kt ~ /^mode:[ \t]*/) {
          mode = substr(kt, 6); sub(/^[ \t]+/, "", mode); sub(/[ \t]*#.*$/, "", mode)
          sub(/[ \t]+$/, "", mode); gsub(/["\047]/, "", mode)
          continue
        }
        role = ""
        if (kt ~ /^local:/) role = "local"
        else if (kt ~ /^shared:/) role = "shared"
        if (role == "") continue
        rest = substr(kt, length(role) + 2); sub(/^[ \t]+/, "", rest)
        if (rest != "" && rest !~ /^#/) {     # 流式 local: {enable:..., ipv6:...}
          b = fieldof(rest, "enable"); if (b < 0) b = fieldof(rest, "enabled")
          if (role == "local") { if (b >= 0) le = b; b = fieldof(rest, "ipv6"); if (b >= 0) li = b }
          else                { if (b >= 0) se = b; b = fieldof(rest, "ipv6"); if (b >= 0) si = b }
        } else {                              # 块式：找直接子键里的 enable / ipv6
          childind = -1
          for (j = i + 1; j <= n; j++) {
            if (ef[j] ~ /^[ \t]*$/) continue
            if (indof(ef[j]) <= keyind) break
            if (childind < 0) childind = indof(ef[j])
            if (indof(ef[j]) == childind) {
              if (ef[j] ~ /^[ \t]*enable(d)?:/) { b = fieldof(ef[j], "enable"); if (b < 0) b = fieldof(ef[j], "enabled"); if (role == "local") le = b; else se = b }
              else if (ef[j] ~ /^[ \t]*ipv6:/) { b = fieldof(ef[j], "ipv6"); if (role == "local") li = b; else si = b }
            }
          }
        }
      }
      # enable：写了的按值（兼容 enabled），没写按 mode（未写==local 即启用）
      if (le < 0) le = (mode == "" || mode == "local" || mode == "hybrid") ? 1 : (mode == "shared" ? 0 : 1)
      if (se < 0) se = (mode == "shared" || mode == "hybrid") ? 1 : 0
      # ipv6：写了的按值（false 优先），没写默认 true（与内核 enabledByDefault 一致）
      if (li < 0) li = 1
      if (si < 0) si = 1
      if ((le == 1 && li == 1) || (se == 1 && si == 1)) return 1
      return 0
    }
    function flushentry(   i, isebpf) {
      if (n == 0) return
      isebpf = 0
      for (i = 1; i <= n; i++) {
        if (ef[i] ~ /^[ \t]*#/) continue
        if (ef[i] ~ /^[ \t]*type:[ \t]*["\047]?ebpf["\047]?[ \t]*(#.*)?$/ ||
            ef[i] ~ /^[ \t]*-[ \t]+type:[ \t]*["\047]?ebpf["\047]?[ \t]*(#.*)?$/) isebpf = 1
      }
      if (isebpf && entneeds()) found = 1
      n = 0
    }
    /^[^ \t#-]/ { flushentry(); inls = ($1 == "listeners:"); base = -1; next }
    {
      if (!inls || found) next
      if ($0 ~ /^[ \t]*#/) next
      if ($0 ~ /^[[:space:]]*-[[:space:]]/) {
        match($0, /[^[:space:]]/); ind = RSTART - 1
        if (base < 0) base = ind
        if (ind == base) flushentry()
      }
      ef[++n] = $0
    }
    END { flushentry(); exit(found ? 0 : 1) }
  ' "$CONFIG" 2>/dev/null
}

# eBPF 活跃缓存：system_ipv6_sync 每 ~6s 调一次，全量 awk 扫配置太贵。
# 以「mtime:size」为 key（stat 一次 + 内建 read），命中零解析；配置一变就重算。
# stat 不可用时每次重算（安全降级）；mtime 秒精度 + 同大小改写的理论竞态可忽略
# （要同秒内两次保存、字节数相同、还恰好翻转 ebpf 监听——真碰上也就错一轮）。
ebpf_active_cached() {
  # stat 缺失时回落 busybox stat：监听循环每 IPV6_TICK 秒会走到这里，取不到
  # 「mtime:size」key 就永远命不中缓存、每次退化成全量 awk 扫配置。
  _ea_key=$(stat -c '%Y:%s' "$CONFIG" 2>/dev/null || "$BUSYBOX" stat -c '%Y:%s' "$CONFIG" 2>/dev/null)
  case "$_ea_key" in
    [0-9]*:[0-9]*)
      if [ -f "$RUNDIR/ebpf.active" ]; then
        IFS=: read -r _ea_k1 _ea_k2 _ea_v < "$RUNDIR/ebpf.active" 2>/dev/null
        if [ "$_ea_k1:$_ea_k2" = "$_ea_key" ]; then [ "$_ea_v" = "1" ]; return; fi
      fi
      if ebpf_listener_active; then _ea_v=1; else _ea_v=0; fi
      printf '%s:%s\n' "$_ea_key" "$_ea_v" > "$RUNDIR/ebpf.active" 2>/dev/null
      [ "$_ea_v" = "1" ]; return ;;
    *) ebpf_listener_active ;;
  esac
}

# 「eBPF 是否锁住系统 IPv6」缓存：= ebpf 活跃 && 有启用角色 ipv6 生效（需 v6 本地路由）。
# 与 ebpf.active 同 key 机制缓存到 ebpf.v6，system_ipv6_sync 高频调用零 awk。
ebpf_ipv6_redirect_cached() {
  # 同上：本函数由 system_ipv6_sync 高频调用（开关监听循环每 IPV6_TICK 秒一次），
  # stat 不可用时宁可回落 busybox，也不能退化成每 5 秒两次 awk 扫配置。
  _ev_key=$(stat -c '%Y:%s' "$CONFIG" 2>/dev/null || "$BUSYBOX" stat -c '%Y:%s' "$CONFIG" 2>/dev/null)
  case "$_ev_key" in
    [0-9]*:[0-9]*)
      if [ -f "$RUNDIR/ebpf.v6" ]; then
        IFS=: read -r _ev_k1 _ev_k2 _ev_v < "$RUNDIR/ebpf.v6" 2>/dev/null
        if [ "$_ev_k1:$_ev_k2" = "$_ev_key" ]; then [ "$_ev_v" = "1" ]; return; fi
      fi
      if ebpf_listener_active && ebpf_ipv6_redirect_needed; then _ev_v=1; else _ev_v=0; fi
      printf '%s:%s\n' "$_ev_key" "$_ev_v" > "$RUNDIR/ebpf.v6" 2>/dev/null
      [ "$_ev_v" = "1" ]; return ;;
    *) ebpf_listener_active && ebpf_ipv6_redirect_needed ;;
  esac
}

# 系统 IPv6 应用（周期对账 + 切网补关 + 冷却追打 + 开启立即生效）：
# 期望翻转写一次，切网补关一次，被 netd 改回时最多 60s 追打一次，开启时主动触发 RS。
# 期望值来源：模块禁用？ebpf 在跑？系统 IPv6 开关（默认关 → disable_ipv6=1）。
# 曾经每 ~6s 追着重写，跟 netd 打架翻转 v6 地址，netlink 风暴让 mihomo 每几秒
# 一条 warn 还重置 DNS（rmnet 真机翻车过）。退避只能减量，要根除刷屏就得不打。
# 0206 起改为「期望不变就放手」——代价是切网后系统把值改回去就漏了（截图里
# 240e:xxx 就是这么来的）。0217 加切网指纹（路由表+网卡列表）补关一次，但 netd
# 有时在同一次切网后立刻改回，路由未再变，仍会漏。再加「冷却追打」：关态下
# 每轮读一遍各网卡 disable_ipv6，若有漂移且距上次追打 >60s 就再关一次（最多
# 1 次/分钟），平时零写入，刷屏上限 1 条/分钟。另把 accept_ra/autoconf 等一并
# 置 0/1，堵住 RA 重新拉起 v6 的路径；本机 v6 仍进 TUN，热点 v6 另有 tunhs 规则拦。
# ⚠ 关键前提：这一切都建立在「有人周期性调本函数」之上 —— _switch_loop 每
# IPV6_TICK 秒调一次。曾经把监听循环精简成「稳态纯休眠」时漏掉了这个调用，
# 结果开关飞行模式后 netd 把 disable_ipv6 放回 0，再没有任何时机追回，
# 面板显示「已禁用」而 v6 地址与默认路由一直漏在外面（IPv6 泄露）。本函数
# 内部已按「每 5s 被调一次」做了成本控制：稳态只读不写、不 fork 外部命令
# （只剩一次 stat 校验 eBPF 缓存，见函数内注释）。
# 关态另加一层保险：conf/default/disable_ipv6=1 是新建设备的模板，飞行模式后
# 重建的网卡（rmnet/wlan 重连）一出生就带着 v6 关闭，不等下一拍。
# 开启立即生效：关是删地址立即消失，开是等 RA，需主动触发。开时 accept_ra=2
# （比 1 更宽松，forwarding=1 时仍收 RA）+ router_solicitations=3 触发 RS，
# 再 ndc interface ipv6 <iface> enable + 蜂窝口 down/up 自动完成，免去手动开关数据。
# 落盘 $IPV6_WANT 记期望值（监听重启删掉重应用），$IPV6_NET 记网络指纹，
# $IPV6_LAST 记上次追打时间戳。
IPV6_WANT=$RUNDIR/ipv6.want
IPV6_SYNC_LOCK=$RUNDIR/ipv6.sync.lock  # 前台开关与周期看门狗串行化，避免同一翻转重复对账
# 代理侧 IPv6 初始化失败的证据：内容为「内核版本|内核路径」。写在这里＝这台机器
# 已经证明「开着 ipv6 就起不来 TUN/eBPF」，见 ipv6_proxy_guard 的注释。
IPV6_PFAIL=$RUNDIR/ipv6.proxyfail
IPV6_PLOG=$RUNDIR/ipv6.proxy.log
IPV6_NET=$RUNDIR/ipv6.net
IPV6_LAST=$RUNDIR/ipv6.last
IPV6_COOL=60
IPV6_TICK=5      # _switch_loop 的对账节拍（秒）。关态下这是飞行模式/切数据后
                 # 把被放开的网卡收回来的兜底窗口；新建网卡由 default 模板即时
                 # 兜住，通常不必等到这一拍。调小 = 追得更快但空转更频（每次
                 # 只有内建读 + 一次 stat），一般无需改。
# IPV6_CONF / IPV6_ROUTE / IPV6_NET / IPV6_LAST 覆盖路径：只给回归测试的假
# sysfs/路由用，生产环境永远走默认值（/proc/sys/.../conf、/proc/net/route、
# $RUNDIR/ipv6.net、$RUNDIR/ipv6.last）。

# 蜂窝/伪接口与 all/default 模板永远免于内核层禁用 v6。
# 「禁用系统 IPv6」的蜂窝侧防泄漏不再走内核 disable_ipv6（那会把 IMS APN 的 v6
# 一起打死：VoLTE/短信都走 IMS，飞行模式重建 PDN 必炸），而是等同「APN 协议=IPv4」
# 的做法 —— 见下方 APN4 子系统：把上网 APN 的 protocol 改成 IP，数据 PDN 压根不
# 协商 v6，没有 v6 可漏；IMS 承载独立、不受影响，飞行模式后天然保持。
# 内核层 disable_ipv6 因此只作用于 wlan 等非蜂窝网卡（防 Wi-Fi 下 v6 绕代理泄漏），
# all/default 模板也不能动 —— 否则飞行模式后新建的 rmnet 一出生就 v6 关闭，IMS 照炸。
# 热点/USB 共享的「下游」网卡（系统共享服务自己管它的 IPv6：起 RA、配地址、启停 dnsmasq）。
# 模块若也去写它的 disable_ipv6 / accept_ra / autoconf，会与系统互相追打：每次写都会
# 删/加一批地址，触发 netlink 地址事件风暴，dnsmasq（监听网卡地址变化）被唤醒后不断重扫
# 网卡——表现就是「一开热点共享 dnsmasq CPU 异常」。热点客户端的 v6 由 tunhs 的
# ip6tables（FORWARD REJECT + 外发 RA 丢弃）拦住，不需要动它的内核 IPv6 开关。
# 命名无歧义的直接豁免；wlan0/wlan1/eth0 这类可能是 STA 也可能是热点口，只在它带
# 「x.x.x.1」网关式 IPv4 地址（即正在充当热点网关）时才豁免。
# 随身 Wi-Fi / 部分 ROM 的热点桥是 br0（不在 ap0/wlan1 这套名字里），漏掉就会
# 把 disable_ipv6=1 写到 dnsmasq 正在听的下游口上——表现就是「一开热点 dnsmasq
# CPU 打满一核，打开系统 IPv6 就恢复」。
si_is_gateway_if() {
  _sg_ip=""
  if [ -x /system/bin/ip ]; then _sg_ip=/system/bin/ip
  elif command -v ip >/dev/null 2>&1; then _sg_ip=$(command -v ip); fi
  [ -n "$_sg_ip" ] || return 1
  $_sg_ip -4 addr show dev "$1" 2>/dev/null | grep -Eq 'inet [0-9]+\.[0-9]+\.[0-9]+\.1/'
}

si_tether_if() {
  # 热点 / USB 共享下游口：系统 dnsmasq + RA 自己管，模块绝不写它的 disable_ipv6。
  case "$1" in
    br[0-9]*|bridge*|ap[0-9]*|swlan*|softap*|rndis*|usb[0-9]*|bt-pan*|p2p*|wigig*|sipa_usb*)
      return 0 ;;
    wlan[0-9]*|eth[0-9]*) si_is_gateway_if "$1" && return 0 ;;
  esac
  return 1
}

si_exempt_if() {
  # $1 = 网卡名（含 all/default 伪接口）
  case "$1" in
    lo|all|default) return 0 ;;
    rmnet*|r_rmnet*|ccmni*|wwan*|pdp*|v4-rmnet*|radio*|cellular*) return 0 ;;
  esac
  si_tether_if "$1"
}

# 热点下游若已被上一版写成 disable_ipv6=1，豁免之后稳态不会再进修复路径，
# 会永远卡在 dnsmasq 空转。每次对账把仍为 1 的下游口拉回 0（交还系统）。
si_restore_tether_ipv6() {
  _sr_dir=${IPV6_CONF:-/proc/sys/net/ipv6/conf}
  [ -d "$_sr_dir" ] || return 0
  for _sr_f in "$_sr_dir"/*/disable_ipv6; do
    [ -e "$_sr_f" ] || continue
    _sr_if=${_sr_f%/disable_ipv6}; _sr_if=${_sr_if##*/}
    si_tether_if "$_sr_if" || continue
    _sr_v=""
    IFS= read -r _sr_v < "$_sr_f" 2>/dev/null
    [ "$_sr_v" = "0" ] && continue
    echo 0 2>/dev/null > "$_sr_f"
  done
  return 0
}

# ============================================================
# APN 仅 IPv4（蜂窝侧防 v6 泄漏，效果等同「修改接入点 → APN 协议 = IPv4」）
# ------------------------------------------------------------
# 为什么不用内核 disable_ipv6 打蜂窝口：VoLTE（高清通话）与短信（SMS over IMS）
# 都走 IMS APN 的独立承载（多数运营商是 IPv6/IPv4v6），内核层一禁就是全灭；
# 飞行模式后 netd 重建 rmnet 与看门狗追打还有竞态，炸起来只能重启。
# 改 APN 协议是运营商侧的做法：数据 PDN 只协商 IPv4，v6 根本不存在——泄漏
# 堵死，IMS 一点不碰，开关飞行模式、重启都天然保持，无竞态。
# 实现：「系统 IPv6=关」时把当前各卡首选上网 APN（preferapn）的 protocol 与
# roaming_protocol 改为 IP，原值记入 run/apn4.state（行格式 id|apn|origP|origR，
# 仅记录被本模块改过的行）；「开」时原样还原。
# 只碰 preferapn（上网 APN），跳过 type 含 ims 的行，绝不改 IMS 承载。
# 依赖系统的 content 命令（Android 自带）；不可用/被 SELinux 拦时只记日志并
# 在 apn4-status 里可见，由用户手动把 APN 协议设为 IPv4 即可（效果相同）。
# ============================================================
APN4_STATE=$RUNDIR/apn4.state
APN4_CACHE=$RUNDIR/apn4.json      # apn4-json 的结果缓存（首行时间戳，次行 JSON）
APN4_TTL=60                       # 缓存有效期（秒）：过期才重新拉起 content JVM
APN4_LOG=$RUNDIR/apn4.log
APN4_LOCK=$RUNDIR/apn4.lock              # 显式开关与 5s 对账循环可能并发触碰 APN
APN4_CONTENT_LOCK=$RUNDIR/apn4.content.lock # 序列化本模块所有 Android content JVM 调用
APN4_RETRY_FILE=$RUNDIR/apn4.restore.retry  # 内容提供者暂时失败时限频重试（单调时钟厘秒）
APN4_RETRY_COOL_CS=6000                   # 最多每 60s 重试一次，避免 5s 对账循环反复拉起 content

# 多个 WebUI APN 查询、IPv6 对账与验证回查都可能同时拉起 content JVM。
# ROM 上 content 并发查询可直接以 139 崩溃；全局串行化，避免 provider/JVM 争用。
apn4_content_lock_acquire() {
  _ac_i=0
  while ! mkdir "$APN4_CONTENT_LOCK" 2>/dev/null; do
    _ac_i=$((_ac_i + 1))
    _ac_pid=$(cat "$APN4_CONTENT_LOCK/pid" 2>/dev/null)
    case "$_ac_pid" in ''|*[!0-9]*) _ac_pid=0 ;; esac
    if [ "$_ac_pid" -gt 0 ]; then
      if ! kill -0 "$_ac_pid" 2>/dev/null; then
        rm -rf "$APN4_CONTENT_LOCK" 2>/dev/null
        continue
      fi
      [ "$_ac_i" -ge 50 ] && return 1
    elif [ "$_ac_i" -ge 50 ]; then
      rm -rf "$APN4_CONTENT_LOCK" 2>/dev/null
      _ac_i=0
      continue
    fi
    nap 0.2
  done
  if ! printf '%s\n' "$$" > "$APN4_CONTENT_LOCK/pid" 2>/dev/null; then
    rm -rf "$APN4_CONTENT_LOCK" 2>/dev/null
    return 1
  fi
  return 0
}

apn4_content_lock_release() {
  [ "$(cat "$APN4_CONTENT_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$APN4_CONTENT_LOCK" 2>/dev/null
  return 0
}

# 显式切换 IPv6 会立即对账，后台 5s 监听循环也可能同时看到同一次翻转。
# 串行化 APN 读改写与数据重连：后拿到锁的一方必须在锁内重新查询，通常会发现
# APN 已到目标值，从而不再重复 content update / svc data disable-enable。
apn4_lock_acquire() {
  _a4l_wait=0
  while ! mkdir "$APN4_LOCK" 2>/dev/null; do
    _a4l_wait=$((_a4l_wait + 1))
    _a4l_pid=$(cat "$APN4_LOCK/pid" 2>/dev/null)
    case "$_a4l_pid" in ''|*[!0-9]*) _a4l_pid=0 ;; esac
    if [ "$_a4l_pid" -gt 0 ]; then
      if ! kill -0 "$_a4l_pid" 2>/dev/null; then
        rm -rf "$APN4_LOCK" 2>/dev/null
        continue
      fi
      [ "$_a4l_wait" -ge 50 ] && return 1   # 等活锁最多 10s，避免重入并发写 APN
    else
      # mkdir 与写入 pid 间有很短窗口；仅在持续等待 10 秒后回收无 pid 的锁。
      if [ "$_a4l_wait" -ge 50 ]; then
        rm -rf "$APN4_LOCK" 2>/dev/null
        _a4l_wait=0
        continue
      fi
    fi
    nap 0.2
  done
  if ! printf '%s\n' "$$" > "$APN4_LOCK/pid" 2>/dev/null; then
    rm -rf "$APN4_LOCK" 2>/dev/null
    return 1
  fi
  return 0
}

apn4_lock_release() {
  [ "$(cat "$APN4_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$APN4_LOCK" 2>/dev/null
  return 0
}

apn4_log() {
  printf '%s %s\n' "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$*" >> "$APN4_LOG" 2>/dev/null
  [ -f "$APN4_LOG" ] || return 0
  [ "$(wc -l < "$APN4_LOG" 2>/dev/null || echo 0)" -gt 200 ] && \
    tail -100 "$APN4_LOG" > "$APN4_LOG.tmp" 2>/dev/null && mv -f "$APN4_LOG.tmp" "$APN4_LOG" 2>/dev/null
  return 0
}

# content 输出一行: "Row: 0 _id=3, apn=ctnet, protocol=IPV4V6, roaming_protocol=IPV4V6, type=..."
# 解析用 awk 按空白切 token 后剥掉尾逗号再整键匹配；roaming_protocol 与 protocol
# 同尾缀，取键必须精确（$i=="protocol=..."），不能用子串搜索。
_apn4_parse_row() {
  # $1 = content 输出一行；stdout: "id|apn|protocol|roaming|type"
  printf '%s\n' "$1" | awk '
    {
      for (i = 1; i <= NF; i++) {
        v = $i; sub(/,$/, "", v)
        if (v ~ /^_id=/)        { id = substr(v, 5) }
        else if (v ~ /^apn=/)   { apn = substr(v, 5) }
        else if (v ~ /^protocol=/)     { p = substr(v, 10) }
        else if (v ~ /^roaming_protocol=/) { r = substr(v, 18) }
        else if (v ~ /^type=/)  { t = substr(v, 6) }
      }
    }
    END { if (id != "") print id "|" apn "|" p "|" r "|" t }'
}

# content update 在部分 ROM 上成功时 stdout 为空，不能把「无输出」直接当失败，
# 也不能只看 rc=0（可能实际更新了 0 行）。若返回没有明确的 Updated N rows，
# 就按 id 回查协议；只有读回与目标一致才确认成功。
_apn4_update_verified_content_locked() {
  _au_id=$1; _au_p=$2; _au_r=$3
  APN4_UPDATE_DETAIL=""
  _au_out=$(content update --uri content://telephony/carriers \
    --where "_id=$_au_id" --bind "protocol:s:$_au_p" --bind "roaming_protocol:s:$_au_r" 2>&1)
  _au_rc=$?
  _au_n=$(printf '%s\n' "$_au_out" | awk '{ for (i=1; i<NF; i++) if (tolower($i)=="updated" && $(i+1) ~ /^[0-9]+$/) { print $(i+1); exit } }')
  case "$_au_n" in ''|*[!0-9]*) _au_n=0 ;; esac
  if [ "$_au_rc" = "0" ] && [ "$_au_n" -gt 0 ]; then
    APN4_UPDATE_DETAIL="Updated $_au_n rows"
    return 0
  fi

  _au_qout=$(content query --uri content://telephony/carriers \
    --where "_id=$_au_id" --projection _id:apn:protocol:roaming_protocol:type 2>&1)
  _au_qrc=$?
  _au_got=$(printf '%s\n' "$_au_qout" | awk -v want="$_au_id" '
    /Row:/ {
      id=""; p=""; r=""
      for (i=1; i<=NF; i++) {
        v=$i; sub(/,$/, "", v)
        if (v ~ /^_id=/) id=substr(v,5)
        else if (v ~ /^protocol=/) p=substr(v,10)
        else if (v ~ /^roaming_protocol=/) r=substr(v,18)
      }
      if (id == want) { print p "|" r; exit }
    }
  ')
  if [ "$_au_got" = "$_au_p|$_au_r" ]; then
    APN4_UPDATE_DETAIL="回查确认成功（update rc=$_au_rc, query rc=$_au_qrc）"
    return 0
  fi
  APN4_UPDATE_DETAIL="未确认（update rc=$_au_rc, 输出=${_au_out:-无输出}; query rc=$_au_qrc, 实读=${_au_got:-无匹配行}）"
  return 1
}

apn4_update_verified() {
  _au_id=$1; _au_p=$2; _au_r=$3
  if ! apn4_content_lock_acquire; then
    APN4_UPDATE_DETAIL="content provider 锁忙，跳过本次 update（id=$_au_id）"
    return 1
  fi
  _apn4_update_verified_content_locked "$_au_id" "$_au_p" "$_au_r"
  _auv_rc=$?
  apn4_content_lock_release
  return "$_auv_rc"
}

# 枚举当前各卡的首选上网 APN，每行输出 "id|apn|protocol|roaming|type"
# 兼容两种 URI 形态：/preferapn（默认卡）与 /preferapn/subId/N（逐卡）。
# 行解析用 here-doc（不是管道）：管道会让 while 落进子 shell，_a4_seen 去重失效。
# 残留查询目录清扫（与 WebUI CGI 的 webui_sweep_stale 同款逻辑）：.apn4q.<pid>
# 会被中途被杀的调用遗留（httpd 掐 CGI / 超时 / 重启都跑不到 EXIT trap），
# 每次查询前顺带扫一遍（无残留时只有一次 glob，零 fork）：
#   · pid 已死 → 目录是残留，删；
#   · 没有 pid 文件（刚 mkdir 或写 pid 前就被杀）→ 两阶段：先放 .sweep 标记，
#     下一轮仍无 pid 才删 —— 绝不误删并发中的活查询；
#   · pid 活着 → 在用（或 pid 被复用，等它自然消失后下一轮再删）。
apn4_sweep_stale() {
  for _as_d in "$RUNDIR"/.apn4q.*; do
    [ -d "$_as_d" ] || continue
    _as_p=""
    if [ -f "$_as_d/pid" ]; then
      IFS= read -r _as_p < "$_as_d/pid" 2>/dev/null
    fi
    case "$_as_p" in
      *[!0-9]*|"")
        if [ -f "$_as_d/.sweep" ]; then
          rm -rf "$_as_d" 2>/dev/null
        else
          : > "$_as_d/.sweep" 2>/dev/null
        fi
        ;;
      0)
        rm -rf "$_as_d" 2>/dev/null
        ;;
      *)
        kill -0 "$_as_p" 2>/dev/null || rm -rf "$_as_d" 2>/dev/null
        ;;
    esac
  done
  return 0
}

# 有多少张「在用」的 SIM：读 gsm.sim.state（形如 READY,READY / LOADED / ABSENT）。
# 完全是内建读 + 一次 getprop，比多拉起一个 content JVM（0.3~1s）便宜两个数量级。
# 拿不到就返回 0（调用方按「未知」处理，仍查全部 subId，行为与旧版一致）。
apn4_sim_count() {
  command -v getprop >/dev/null 2>&1 || { echo 0; return 0; }
  _asc_st=$(getprop gsm.sim.state 2>/dev/null)
  case "$_asc_st" in ''|*[!A-Z_,]*) echo 0; return 0 ;; esac
  _asc_n=0
  _asc_old=$IFS; IFS=,
  for _asc_s in $_asc_st; do
    case "$_asc_s" in
      READY|LOADED|LOADED_PIN|PERSO_UNLOCKED|PIN_REQUIRED|PUK_REQUIRED|LOCKED) _asc_n=$((_asc_n + 1)) ;;
    esac
  done
  IFS=$_asc_old
  echo "$_asc_n"
}

# 串行查询一批 URI 并把解析后的行打到 stdout，避免并发启动多个 content JVM。$1 = URI 列表。
# 用全局 _A4_SEEN 做跨批去重、_A4_NROWS 回传本批命中行数。
_apn4_fetch() {
  _a4_dir=$RUNDIR/.apn4q.$$
  rm -rf "$_a4_dir" 2>/dev/null; mkdir -p "$_a4_dir" 2>/dev/null || return 1
  # 持有者 pid：清扫器据此区分「活查询」与「被杀后来不及清理的残留」（同 webui.cgi）。
  printf '%s\n' "$$" > "$_a4_dir/pid" 2>/dev/null
  # 正常/信号退出路径都先删查询目录再走（同 exec.sh：SIGKILL 例外，
  # 那种残留由下一轮 apn4_sweep_stale 与 post-fs-data.sh 的开机清理回收）。
  trap 'rm -rf "$_a4_dir" 2>/dev/null' 0
  trap 'exit 1' HUP INT TERM PIPE
  # 不并发拉多个 content JVM：双卡 ROM 上并发查询曾导致 content 退出 139，
  # 查询串行化虽稍慢，但不会与 provider/JVM 争用，更不能读到半更新状态。
  _a4_n=0
  for _a4_u in $1; do
    content query --uri "$_a4_u" --projection _id:apn:protocol:roaming_protocol:type \
      > "$_a4_dir/$_a4_n" 2>/dev/null
    _a4_qrc=$?
    if [ "$_a4_qrc" != "0" ]; then
      _A4_QFAIL=$((_A4_QFAIL + 1))
      apn4_log "WARN content query uri=$_a4_u rc=$_a4_qrc"
    fi
    _a4_n=$((_a4_n + 1))
  done
  _a4_i=0
  while [ "$_a4_i" -lt "$_a4_n" ]; do
    _a4_out=$(cat "$_a4_dir/$_a4_i" 2>/dev/null)
    case "$_a4_out" in *"Row:"*"_id="*) : ;; *) _a4_i=$((_a4_i + 1)); continue ;; esac
    while IFS= read -r _a4_line; do
      case "$_a4_line" in *"Row:"*"_id="*) : ;; *) continue ;; esac
      _a4_row=$(_apn4_parse_row "$_a4_line")
      [ -n "$_a4_row" ] || continue
      _a4_id=${_a4_row%%|*}
      case "$_A4_SEEN" in *"|$_a4_id|"*) continue ;; esac
      _A4_SEEN="$_A4_SEEN$_a4_id|"
      printf '%s\n' "$_a4_row"
      _A4_NROWS=$((_A4_NROWS + 1))
    done <<EOF
$_a4_out
EOF
    _a4_i=$((_a4_i + 1))
  done
  rm -rf "$_a4_dir"
  return 0
}

_apn4_rows_content_locked() {
  command -v content >/dev/null 2>&1 || { apn4_log "WARN 无 content 命令，APN 改写不可用"; return 1; }
  apn4_sweep_stale
  _A4_SEEN="|"; _A4_NROWS=0; _A4_QFAIL=0
  # content 每次调用都要拉起一个 JVM（慢设备 0.3~1 秒），而且**并发不等于免费**：
  # 手机上 5 个 JVM 抢 CPU，墙钟反而比只查 1 个还长。所以按「真在用的 SIM 数」查：
  #   · 单卡（绝大多数场景）：只查默认 preferapn = 1 个 JVM（旧版固定 5 个）；
  #   · 双卡 N 张：默认 + subId/1..N；
  #   · 单卡那一次没查到（个别 ROM 的默认 URI 为空）才补查 subId/1。
  _a4_sims=$(apn4_sim_count)
  case "$_a4_sims" in ''|*[!0-9]*) _a4_sims=0 ;; esac
  if [ "$_a4_sims" -lt 1 ] || [ "$_a4_sims" -gt 4 ]; then
    # 拿不到 SIM 状态：退回旧行为（1..4 全查），只求结果正确
    _a4_sims=4
    _apn4_fetch "content://telephony/carriers/preferapn $(i=1; while [ $i -le 4 ]; do printf 'content://telephony/carriers/preferapn/subId/%s ' $i; i=$((i+1)); done)"
    return 0
  fi
  if [ "$_a4_sims" -le 1 ]; then
    _apn4_fetch "content://telephony/carriers/preferapn"
    [ "$_A4_NROWS" -gt 0 ] || [ "$_A4_QFAIL" -gt 0 ] || _apn4_fetch "content://telephony/carriers/preferapn/subId/1"
    return 0
  fi
  _a4_uris=""
  _a4_n=1
  while [ "$_a4_n" -le "$_a4_sims" ]; do
    _a4_uris="$_a4_uris content://telephony/carriers/preferapn/subId/$_a4_n"
    _a4_n=$((_a4_n + 1))
  done
  # 多卡时逐卡 URI 已覆盖实际首选 APN；只有 ROM 不支持 subId URI 时才退回默认 URI，
  # 避免正常情况下为同一张默认卡额外启动一个 content JVM。
  _apn4_fetch "$_a4_uris"
  [ "$_A4_NROWS" -gt 0 ] || [ "$_A4_QFAIL" -gt 0 ] || _apn4_fetch "content://telephony/carriers/preferapn"
  return 0
}

apn4_rows() {
  if ! apn4_content_lock_acquire; then
    apn4_log "WARN content provider 锁忙，本次 APN 查询跳过"
    return 1
  fi
  _apn4_rows_content_locked
  _arows_rc=$?
  apn4_content_lock_release
  return "$_arows_rc"
}

# APN provider 更新可能自行触发 Android telephony 重建数据连接。不要再额外执行
# svc data disable/enable：在观察到 provider 已重连的 ROM 上会造成第二次掉线；
# 若 ROM 不会自动重建，APN 新协议将在下一次自然附着时生效。

# 「系统 IPv6=关」：把上网 APN 协议改成 IPv4（幂等；只写漂移的行）
_apn4_apply_locked() {
  _aa_rows=$(apn4_rows)
  if [ -z "$_aa_rows" ]; then
    apn4_log "WARN 未查询到首选 APN，APN 未改写（可手动把 APN 协议设为 IPv4，效果相同）"
    return 1
  fi
  _aa_changed=0
  while IFS='|' read -r _aa_id _aa_apn _aa_p _aa_r _aa_t; do
    [ -n "$_aa_id" ] || continue
    case "$_aa_t" in *ims*) apn4_log "跳过 IMS 承载行 id=$_aa_id apn=$_aa_apn type=$_aa_t"; continue ;; esac
    if [ "$_aa_p" = "IP" ] && [ "$_aa_r" = "IP" ]; then
      # 已是 IPv4：若不是本模块改的（状态无记录），不接管还原
      grep -q "^$_aa_id|" "$APN4_STATE" 2>/dev/null || \
        apn4_log "id=$_aa_id apn=$_aa_apn 已是 IPv4（用户自设，不接管还原）"
      continue
    fi
    if ! grep -q "^$_aa_id|" "$APN4_STATE" 2>/dev/null; then
      printf '%s|%s|%s|%s\n' "$_aa_id" "$_aa_apn" "$_aa_p" "$_aa_r" >> "$APN4_STATE" 2>/dev/null
    fi
    if apn4_update_verified "$_aa_id" IP IP; then
      apn4_log "id=$_aa_id apn=$_aa_apn: $_aa_p/$_aa_r -> IP/IP ($_APN4_UPDATE_DETAIL)"
      _aa_changed=1
    else
      apn4_log "WARN id=$_aa_id 写库失败: $APN4_UPDATE_DETAIL"
    fi
  done <<EOF
$_aa_rows
EOF
  if [ "$_aa_changed" = "1" ]; then
    # 改写过的行刚变：APN 读取缓存立刻作废，否则前端「cached 秒画」会把改动前的
    # 协议再显示一次（用户看到的就是「明明关了 IPv6，APN 还写着 IPv4/IPv6」）
    rm -f "$APN4_CACHE" 2>/dev/null
    apn4_log "APN 已改为 IPv4；不再主动切换移动数据，交由 Android provider 生效"
  fi
  return 0
}

# 公共入口持锁后再查询 APN，避免显式开关与周期监听并发重复写库.
apn4_apply() {
  apn4_lock_acquire || { apn4_log "WARN APN 对账锁忙，本轮跳过，等待下一次对账"; return 1; }
  _a4a_rc=0
  _apn4_apply_locked || _a4a_rc=$?
  apn4_lock_release
  return "$_a4a_rc"
}

# 「系统 IPv6=开」：按 run/apn4.state 还原 protocol/roaming_protocol
# state 行格式：id|apn|origProtocol|origRoaming（有行失败则保留文件下次再试）
_apn4_restore_locked() {
  [ -f "$APN4_STATE" ] || return 0
  _ar_changed=0
  _ar_fail=0
  while IFS='|' read -r _ar_id _ar_apn _ar_p _ar_r; do
    if [ -z "$_ar_id" ]; then
      case "$_ar_apn$_ar_p$_ar_r" in '') continue ;; esac
      apn4_log "WARN APN 状态记录缺少 id，无法安全还原：${_ar_apn:-?}"
      _ar_fail=1
      continue
    fi
    if apn4_update_verified "$_ar_id" "$_ar_p" "$_ar_r"; then
      apn4_log "还原 id=$_ar_id apn=$_ar_apn -> $_ar_p/$_ar_r ($_APN4_UPDATE_DETAIL)"
      _ar_changed=1
    else
      apn4_log "WARN 还原 id=$_ar_id apn=$_ar_apn 失败: $APN4_UPDATE_DETAIL"
      _ar_fail=1
    fi
  done < "$APN4_STATE"
  if [ "$_ar_fail" = "0" ]; then
    rm -f "$APN4_STATE" "$APN4_RETRY_FILE" 2>/dev/null
  fi
  if [ "$_ar_changed" = "1" ]; then
    # 同 apn4_apply：还原后缓存必须作废，别让前端先画出还原前的协议
    rm -f "$APN4_CACHE" 2>/dev/null
    apn4_log "APN 协议已还原；不再主动切换移动数据，交由 Android provider 生效"
  fi
  return 0
}

apn4_restore() {
  apn4_lock_acquire || { apn4_log "WARN APN 对账锁忙，本轮还原跳过，等待下一次对账"; return 1; }
  _a4r_rc=0
  _apn4_restore_locked || _a4r_rc=$?
  apn4_lock_release
  return "$_a4r_rc"
}

# 系统 IPv6 保持开启但 APN 还原失败时，保留状态并限频重试；显式开关翻转强制
# 立即试一次，后续由 5s 对账循环最多每 60s 重试，避免每拍重复拉起 content。
apn4_restore_retry() {
  [ -f "$APN4_STATE" ] || { rm -f "$APN4_RETRY_FILE" 2>/dev/null; return 0; }
  _arr_force=${1:-0}
  now_cs || return 0
  _arr_now=$NOW_CS; _arr_last=""
  [ -f "$APN4_RETRY_FILE" ] && IFS= read -r _arr_last < "$APN4_RETRY_FILE" 2>/dev/null
  case "$_arr_last" in ''|*[!0-9]*) _arr_last="" ;; esac
  if [ "$_arr_force" != "1" ] && [ -n "$_arr_last" ] && [ "$_arr_now" -ge "$_arr_last" ] &&
     [ $((_arr_now - _arr_last)) -lt "$APN4_RETRY_COOL_CS" ]; then
    return 0
  fi
  apn4_restore
  if [ -f "$APN4_STATE" ]; then
    now_cs && printf '%s\n' "$NOW_CS" > "$APN4_RETRY_FILE" 2>/dev/null
  else
    rm -f "$APN4_RETRY_FILE" 2>/dev/null
  fi
  return 0
}

# 诊断/速览：当前各首选 APN 的协议与接管状态
apn4_status() {
  echo "APN 仅 IPv4（蜂窝侧防 v6 泄漏，等同「APN 协议=IPv4」）："
  if [ ! -f "$APN4_STATE" ]; then
    echo "  接管状态：未接管（系统 IPv6=开，或从未应用过）"
  else
    echo "  接管状态：已接管（系统 IPv6=关）"
  fi
  command -v content >/dev/null 2>&1 || { echo "  ⚠ 无 content 命令，无法查询/改写 APN"; return 1; }
  _a4_any=0
  while IFS='|' read -r _a4_id _a4_apn _a4_p _a4_r _a4_t; do
    [ -n "$_a4_id" ] || continue
    _a4_any=1
    _a4_mark=""
    grep -q "^$_a4_id|" "$APN4_STATE" 2>/dev/null && _a4_mark="（已接管，可还原）"
    echo "  首选 APN id=$_a4_id apn=$_a4_apn type=${_a4_t:-?}: 协议=$_a4_p 漫游=$_a4_r$_a4_mark"
  done <<EOF
$(apn4_rows)
EOF
  [ "$_a4_any" = "0" ] && echo "  （未查询到首选 APN——多卡/定制 ROM 可试试手动把 APN 协议设为 IPv4，效果相同）"
  [ -f "$APN4_LOG" ] && { echo "  最近日志："; tail -5 "$APN4_LOG" | sed 's/^/    /'; }
  return 0
}

# WebUI「模块设置」用：系统 IPv6 行下方要显示「首选 APN「ctnet」：协议 IPv4，漫游 IPv4」。
# JSON 而不是让前端解析 apn4-status 的文本：字段名就是 content 的列名，前端零猜测。
#   {"ok":1,"content":1,"taken":0|1,"items":[{"id","apn","protocol","roaming","type","managed"}]}
# 只在弹层打开 / 切换系统 IPv6 后各调用一次——content 每次都要拉起一个 JVM，
# 绝不能塞进 1.5 秒一次的 mod-state 轮询。
_apn4_json_esc() {
  printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g'
}
# 缓存：APN 协议不会每秒变，content 却每次都要拉起 JVM。
#   apn4-json           → 缓存新鲜（默认 60s）就直接吐，过期才查
#   apn4-json cached    → 只吐缓存（没有就吐空 items），供界面先秒开再后台刷新
#   apn4-json refresh   → 强制真查并更新缓存
apn4_json() {
  _aj_mode=${1:-auto}
  if [ "$_aj_mode" = "cached" ]; then
    if [ -f "$APN4_CACHE" ]; then
      sed -n '2,$p' "$APN4_CACHE" 2>/dev/null
      return 0
    fi
    # cache miss must stay cheap: the caller will explicitly request one fresh read next.
    _aj_cmd=1; command -v content >/dev/null 2>&1 || _aj_cmd=0
    _aj_taken=0; [ -f "$APN4_STATE" ] && _aj_taken=1
    printf '{"ok":1,"content":%s,"taken":%s,"items":[]}\n' "$_aj_cmd" "$_aj_taken"
    return 0
  fi
  if [ -f "$APN4_CACHE" ] && [ "$_aj_mode" != "refresh" ]; then
    _aj_ts=""; IFS= read -r _aj_ts < "$APN4_CACHE" 2>/dev/null
    case "$_aj_ts" in ''|*[!0-9]*) _aj_ts=0 ;; esac
    _aj_now=$(date +%s 2>/dev/null)
    case "$_aj_now" in ''|*[!0-9]*) _aj_now=0 ;; esac
    if [ "$_aj_ts" -gt 0 ] && [ "$_aj_now" -gt 0 ] && [ $((_aj_now - _aj_ts)) -lt "$APN4_TTL" ]; then
      sed -n '2,$p' "$APN4_CACHE" 2>/dev/null
      return 0
    fi
  fi
  _aj_cmd=1; command -v content >/dev/null 2>&1 || _aj_cmd=0
  _aj_taken=0; [ -f "$APN4_STATE" ] && _aj_taken=1
  # 一次算完再落缓存：先流式打印再重算一遍等于把 content 查两次。
  _aj_body=""
  _aj_first=1
  if [ "$_aj_cmd" = "1" ]; then
    while IFS='|' read -r _aj_id _aj_apn _aj_p _aj_r _aj_t; do
      [ -n "$_aj_id" ] || continue
      _aj_m=0
      grep -q "^$_aj_id|" "$APN4_STATE" 2>/dev/null && _aj_m=1
      [ "$_aj_first" = "1" ] || _aj_body="$_aj_body,"
      _aj_first=0
      _aj_body="$_aj_body$(printf '{"id":"%s","apn":"%s","protocol":"%s","roaming":"%s","type":"%s","managed":%s}' \
        "$(_apn4_json_esc "$_aj_id")" "$(_apn4_json_esc "$_aj_apn")" \
        "$(_apn4_json_esc "$_aj_p")" "$(_apn4_json_esc "$_aj_r")" \
        "$(_apn4_json_esc "$_aj_t")" "$_aj_m")"
    done <<EOF
$(apn4_rows)
EOF
  fi
  _aj_json=$(printf '{"ok":1,"content":%s,"taken":%s,"items":[%s]}' "$_aj_cmd" "$_aj_taken" "$_aj_body")
  _aj_now=$(date +%s 2>/dev/null)
  case "$_aj_now" in ''|*[!0-9]*) _aj_now=0 ;; esac
  if [ -d "$RUNDIR" ]; then
    { printf '%s\n' "$_aj_now"; printf '%s\n' "$_aj_json"; } > "$APN4_CACHE" 2>/dev/null
  fi
  printf '%s\n' "$_aj_json"
  return 0
}

_system_ipv6_sync_body() {
  _si_dir=${IPV6_CONF:-/proc/sys/net/ipv6/conf}
  [ -d "$_si_dir" ] || return 0
  # 热点下游交还系统：与期望开关无关，br0 等绝不能停在 disable_ipv6=1。
  si_restore_tether_ipv6
  # 保持系统 IPv6 协议栈可用（_si_d=0 → disable_ipv6=0）的三类情况：
  #  1) 模块被停用/卸载 → 还原系统默认，不残留禁用；
  #  2) 用户显式「系统 IPv6」开启；
  #  3) eBPF 入站活跃且至少一个启用角色的 ipv6 生效（需要 fd53 v6 重定向路由，
  #     禁了协议栈内核初始化 eBPF 会报 "add local route permission denied"）。
  # 其余情况禁用系统 IPv6（_si_d=1）。注意第 3 项已收敛：以前只要 eBPF 活跃就
  # 无条件保持 IPv6 可用，导致「eBPF 模式 + 角色 ipv6:false（默认）」时用户想
  # 禁用系统 IPv6 被锁住关不掉。内核只在角色 ipv6 生效时才加 v6 本地路由
  # （requiresIPv6Redirect），角色都不拦 v6 时禁用 IPv6 完全安全。
  _si_user=$(get_setting system_ipv6 false)
  if [ -f "$MODDIR/disable" ]; then
    _si_d=0; _si_reason=module-disabled
  elif [ "$_si_user" = "true" ]; then
    _si_d=0; _si_reason=user-enabled
  elif ebpf_ipv6_redirect_cached; then
    _si_d=0; _si_reason=ebpf-redirect
  else
    _si_d=1; _si_reason=user-disabled
  fi
  _si_prev=""
  [ -f "$IPV6_WANT" ] && IFS= read -r _si_prev < "$IPV6_WANT" 2>/dev/null

  _si_route=${IPV6_ROUTE:-/proc/net/route}
  _si_net_file=${IPV6_NET:-$RUNDIR/ipv6.net}
  _si_last_file=${IPV6_LAST:-$RUNDIR/ipv6.last}
  # 网络指纹 = 路由表内容 + 网卡集合。全部用内建 read/glob 拼出来，不再 fork
  # cat/ls：本函数现在由 _switch_loop 每 IPV6_TICK 秒调一次，稳态开销必须只剩
  # 内建读（旧写法每次两个进程，5s 一次在慢设备上不划算）。
  _si_cur=""
  if [ -r "$_si_route" ]; then
    while IFS= read -r _si_l || [ -n "$_si_l" ]; do _si_cur="$_si_cur$_si_l "; done < "$_si_route"
  fi
  for _si_f in "$_si_dir"/*/disable_ipv6; do
    [ -e "$_si_f" ] || continue
    _si_if=${_si_f%/disable_ipv6}; _si_if=${_si_if##*/}
    _si_cur="$_si_cur$_si_if "
  done
  _si_net_prev=""
  [ -f "$_si_net_file" ] && IFS= read -r _si_net_prev < "$_si_net_file" 2>/dev/null

  # 判定是否需要进入修复路径
  _si_need=0
  _si_is_drift=0
  _si_flip=0      # 期望值翻转（开↔关）：APN 侧接管/还原的触发点
  _si_netchg=0    # 网络指纹变化（飞行模式/切网/换卡）：APN 侧幂等复查的触发点
  if [ "$_si_prev" != "$_si_d" ]; then
    _si_need=1
    _si_flip=1
  else
    if [ "$_si_d" = "1" ]; then
      # 关态：网络变化 → 必修；网络未变 → 检查是否有漂移，有则看冷却。
      # 本函数由 _switch_loop 每 IPV6_TICK 秒调一次，这一支就是「飞行模式/切数据
      # 后 netd 把 v6 放开」的追回点：指纹变了立刻补关（不受冷却限制），指纹没变
      # 但某块网卡被改回 0 时按冷却追打。
      if [ "$_si_cur" != "$_si_net_prev" ] || [ -z "$_si_net_prev" ]; then
        _si_need=1
        _si_netchg=1
      else
        # 扫描一遍是否真有网卡被改回 0（读开销可忽略，写才触发 netlink 风暴）。
        # glob 含 all / default / 各网卡（lo 跳过）：default 是新建设备的模板，
        # 被 netd 放回 0 也要跟着追回，否则飞行模式后新建的网卡会带 v6 出生。
        for _si_f in "$_si_dir"/*/disable_ipv6; do
          [ -e "$_si_f" ] || continue
          _si_if=${_si_f%/disable_ipv6}; _si_if=${_si_if##*/}
          si_exempt_if "$_si_if" && continue
          IFS= read -r _si_v < "$_si_f" 2>/dev/null
          if [ "$_si_v" != "$_si_d" ]; then _si_need=1; _si_is_drift=1; break; fi
        done
        if [ "$_si_need" = "1" ]; then
          # 冷却：同一次切网后 netd 可能立刻改回，若每 6s 追打会刷屏，限 60s 一次
          _si_now=$(date +%s 2>/dev/null)
          case "$_si_now" in ''|*[!0-9]*) _si_now=0 ;; esac
          _si_last=0
          [ -f "$_si_last_file" ] && IFS= read -r _si_last < "$_si_last_file" 2>/dev/null
          case "$_si_last" in ''|*[!0-9]*) _si_last=0 ;; esac
          if [ "$_si_now" -gt 0 ] && [ "$_si_last" -gt 0 ]; then
            _si_age=$((_si_now - _si_last))
            if [ "$_si_age" -lt "$IPV6_COOL" ]; then
              _si_need=0
            fi
          fi
        fi
      fi
    else
      # 开态：切网只更新指纹
      if [ "$_si_cur" != "$_si_net_prev" ]; then
        printf '%s' "$_si_cur" 2>/dev/null > "$_si_net_file"
      fi
      return 0
    fi
  fi

  [ "$_si_need" = "0" ] && return 0
  apn4_log "IPv6/APN 对账：setting=${_si_user:-?} effective_disable=$_si_d reason=$_si_reason prev=${_si_prev:-?} flip=$_si_flip netchg=$_si_netchg"

  # —— 蜂窝侧防 v6 泄漏：走 APN（等同「APN 协议=IPv4」），不碰内核 disable_ipv6 ——
  # 见 APN4 子系统注释。触发点：
  #   · 期望翻转到关（含开机首拍/模块启用/设置变化）→ 接管（幂等，只写漂移行）；
  #   · 关态下网络指纹变化（飞行模式/切网/换卡）→ 复查一遍（防用户手动改回/换卡漏管）；
  #   · 期望翻转到开 → 按 run/apn4.state 还原协议并清接管。
  if [ "$_si_d" = "1" ]; then
    if [ "$_si_flip" = "1" ] || [ "$_si_netchg" = "1" ]; then
      apn4_apply
    fi
  else
    apn4_restore_retry "$_si_flip"
  fi

  # 修复：只写值不对的网卡（lo 跳过），并把 RA 相关一并置位，堵住重拉起路径
  # 开启时要尽量立即生效：关是删地址立即消失，开是等 RA，需主动触发 RS
  _si_n=0
  _si_changed=""
  for _si_f in $_si_dir/*/disable_ipv6; do
    [ -e "$_si_f" ] || continue
    _si_if=${_si_f%/disable_ipv6}; _si_if=${_si_if##*/}
    si_exempt_if "$_si_if" && continue
    IFS= read -r _si_v < "$_si_f" 2>/dev/null
    [ "$_si_v" = "$_si_d" ] && continue
    echo "$_si_d" 2>/dev/null > "$_si_f" && _si_n=$((_si_n + 1)) && _si_changed="$_si_changed $_si_if"
    # 额外加固：关时禁 RA/自动配置，开时恢复（文件不存在则忽略）
    if [ "$_si_d" = "1" ]; then
      echo 0 2>/dev/null > "$_si_dir/$_si_if/accept_ra"
      echo 0 2>/dev/null > "$_si_dir/$_si_if/autoconf"
      echo 0 2>/dev/null > "$_si_dir/$_si_if/accept_ra_defrtr"
      echo 0 2>/dev/null > "$_si_dir/$_si_if/accept_ra_pinfo"
    else
      # 开：accept_ra=2 比 1 更宽松（forwarding=1 时 1 会忽略 RA，2 仍接收）
      echo 2 2>/dev/null > "$_si_dir/$_si_if/accept_ra"
      echo 1 2>/dev/null > "$_si_dir/$_si_if/autoconf"
      echo 1 2>/dev/null > "$_si_dir/$_si_if/accept_ra_defrtr"
      echo 1 2>/dev/null > "$_si_dir/$_si_if/accept_ra_pinfo"
      echo 1 2>/dev/null > "$_si_dir/$_si_if/accept_ra_rtr_pref"
      echo 0 2>/dev/null > "$_si_dir/$_si_if/disable_tempaddr"
      # 主动触发 RS：写 router_solicitations 会让内核立刻发 RS
      echo 3 2>/dev/null > "$_si_dir/$_si_if/router_solicitations"
    fi
  done
  # 开启路径的立即生效兜底：非破坏性触发后，再尝试让 netd 重新接管
  if [ "$_si_d" = "0" ] && [ -n "$_si_changed" ]; then
    # 1) ndc 通知 netd（存在才生效，无则忽略）
    if command -v ndc >/dev/null 2>&1; then
      for _si_if in $_si_changed; do
        ndc interface ipv6 "$_si_if" enable 2>/dev/null
      done
    fi
    # 2) 对蜂窝口做一次 down/up，等同手动开关数据，但由脚本自动完成
    #    wlan 不做：down 会断 WiFi，用户体感差，靠 RS 已足够；蜂窝 down/up 1s 内自恢复
    _si_ip=""
    if [ -x /system/bin/ip ]; then _si_ip=/system/bin/ip
    elif command -v ip >/dev/null 2>&1; then _si_ip=$(command -v ip)
    fi
    if [ -n "$_si_ip" ]; then
      for _si_if in $_si_changed; do
        case "$_si_if" in
          rmnet*|ccmni*|wwan*|r_rmnet*)
            $_si_ip link set "$_si_if" down 2>/dev/null
            ;;
        esac
      done
      # 批量 down 后统一 up，减少中间态时间
      for _si_if in $_si_changed; do
        case "$_si_if" in
          rmnet*|ccmni*|wwan*|r_rmnet*)
            $_si_ip link set "$_si_if" up 2>/dev/null
            ;;
        esac
      done
    fi
  fi
  printf '%s' "$_si_d" 2>/dev/null > "$IPV6_WANT"
  printf '%s' "$_si_cur" 2>/dev/null > "$_si_net_file"
  if [ "$_si_is_drift" = "1" ]; then
    _si_now=$(date +%s 2>/dev/null)
    case "$_si_now" in ''|*[!0-9]*) _si_now=0 ;; esac
    [ "$_si_now" -gt 0 ] && printf '%s' "$_si_now" 2>/dev/null > "$_si_last_file"
  fi
  if [ "$_si_n" -gt 0 ]; then
    if [ "$_si_prev" = "$_si_d" ]; then
      if [ "$_si_is_drift" = "1" ]; then
        sw_log "系统 IPv6 漂移重关：应用 ${_si_n} 块网卡"
      else
        sw_log "系统 IPv6 切网重关：应用 ${_si_n} 块网卡"
      fi
    else
      if [ "$_si_d" = "1" ]; then _si_word=关; else _si_word=开; fi
      sw_log "系统 IPv6 切为${_si_word}：应用 ${_si_n} 块网卡"
    fi
  fi
  return 0
}

# set system_ipv6 与 _switch_loop 可能同时看到同一次翻转。互斥整个对账函数，
# 让后执行者重新读取 IPV6_WANT/当前 APN 后决定是否需要动作；APN 子锁保护写库，
# 该锁则避免两个 sync 分别按过期快照作出相反动作。
system_ipv6_sync() {
  _sis_wait=0
  while ! mkdir "$IPV6_SYNC_LOCK" 2>/dev/null; do
    _sis_wait=$((_sis_wait + 1))
    _sis_pid=$(cat "$IPV6_SYNC_LOCK/pid" 2>/dev/null)
    case "$_sis_pid" in ''|*[!0-9]*) _sis_pid=0 ;; esac
    if [ "$_sis_pid" -gt 0 ]; then
      if ! kill -0 "$_sis_pid" 2>/dev/null; then
        rm -rf "$IPV6_SYNC_LOCK" 2>/dev/null
        continue
      fi
      if [ "$_sis_wait" -ge 50 ]; then
        sw_log "系统 IPv6 对账锁忙（pid=$_sis_pid），本轮跳过"
        return 0
      fi
    elif [ "$_sis_wait" -ge 50 ]; then
      # mkdir 与 pid 落盘的微小窗口；持续 10s 无 pid 才视为陈旧锁。
      rm -rf "$IPV6_SYNC_LOCK" 2>/dev/null
      _sis_wait=0
      continue
    fi
    nap 0.2
  done
  if ! printf '%s\n' "$$" > "$IPV6_SYNC_LOCK/pid" 2>/dev/null; then
    rm -rf "$IPV6_SYNC_LOCK" 2>/dev/null
    return 0
  fi
  _system_ipv6_sync_body
  _sis_rc=$?
  [ "$(cat "$IPV6_SYNC_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$IPV6_SYNC_LOCK" 2>/dev/null
  return "$_sis_rc"
}

# 配置里顶层 ipv6 的裸值（true/false/空）。只认顶格键，不会被 dns.ipv6、
# eBPF 入站里的 ipv6 干扰。
cfg_top_ipv6() {
  [ -f "$CONFIG" ] || return 0
  awk '
    /^[^ \t#-]/ {
      if ($1 ~ /^ipv6:/) { v = $2; gsub(/[\"\047]/, "", v); sub(/#.*$/, "", v); print v; exit }
    }' "$CONFIG" 2>/dev/null
}

# 本机能不能在 IPv6 下接管（TUN / eBPF）。返回 1 ＝ 上次已证明不行：
# 内核（版本 + 内核路径都相同）在这个配置下起不来 TUN/eBPF 入站，换了内核或
# 修好后自动失效（key 变了）。
ipv6_proxy_capable() {
  [ -f "$IPV6_PFAIL" ] || return 0
  _ipc_saved=$(cat "$IPV6_PFAIL" 2>/dev/null)
  [ "$_ipc_saved" = "$(uname -r 2>/dev/null)|$(core_path 2>/dev/null)" ] && return 1
  return 0
}

# ★「开了系统 IPv6，TUN / eBPF 的流量就整段不进内核」的现场处置。
#
# 成因（mihomo 侧行为，已核对 ReCreateTun / PatchInboundListeners）：
#   顶层 `ipv6: true` 且本机存在全局 IPv6 地址时，内核会真的去配 IPv6：
#   TUN 加 inet6 地址 + v6 路由/ip rule（auto-route + strict-route），eBPF 角色
#   加 v6 重定向本地路由。这些步骤在部分 ROM/内核上会失败；而 mihomo 对这两种
#   失败的处理都是「记一条 error、把这个入站关掉、内核继续跑」：
#     · TUN：ReCreateTun 里 `tunConf.Enable = false`；
#     · eBPF：PatchInboundListeners 里 `log.Errorln("Listener %s listen err")` 后 continue。
#   于是面板显示「运行中」，实际没有任何流量进内核 —— 正是用户看到的现象。
#   而系统 IPv6 一关就恢复，因为那时 config 里 ipv6 又是 false，内核压根不去碰 v6。
#
# 处置：发现「配置要 TUN/eBPF 却没起来」时，把**代理侧**的 4 个 v6 开关改回 false
# （系统协议栈、APN 都不动，系统 IPv6 仍然是开的），记下证据后重启一次。
# 故障标记会阻止后台自动重复探测；用户显式再次开启系统 IPv6 时会清掉旧标记、同步配置并重试，
# 若仍失败，本守卫再次回退并落标记，避免后台无限重试。
ipv6_proxy_guard() {
  [ "$(get_setting system_ipv6 false)" = "true" ] || return 0
  [ "$(cfg_top_ipv6)" = "true" ] || return 0
  running || return 0
  ipv6_proxy_capable || return 0
  # 等内核把 /configs 答上来（刚拉起时控制器端口可能还在监听路上）
  _ipg_cfg=""; _ipg_i=0
  while [ "$_ipg_i" -lt 30 ]; do
    _ipg_cfg=$(MH_API_TIMEOUT=2 api GET /configs 2>/dev/null)
    case "$_ipg_cfg" in *'"tun"'*) break ;; esac
    _ipg_cfg=""
    nap 0.2
    _ipg_i=$((_ipg_i + 1))
  done
  _ipg_bad=""
  if tunhs_tun_enabled; then
    # 配置要 TUN，内核自报的却还是 enable:false → TUN 没起来（core 在跑）
    case "$_ipg_cfg" in
      *'"tun":{"enable":false'*|*'"tun":{"enable": false'*)
        _ipg_bad="TUN 未启动（配置里 tun.enable=true，内核自报 false）" ;;
    esac
  fi
  if [ -z "$_ipg_bad" ]; then
    # 兜底证据：内核日志。TUN 与 eBPF 入站起不来时各有一条 error，两者都能命中；
    # log-level: silent 时看不到（那就只靠上面 TUN 的 API 自报）。
    # 只扫本次启动之后新写进 core.log 的行（logs-clear 截断过则整篇都算新）
    _ipg_seg=""
    _ipg_off=$(cat "$LOGFILE.off" 2>/dev/null)
    case "$_ipg_off" in ''|*[!0-9]*) _ipg_off=0 ;; esac
    if [ -f "$LOGFILE" ]; then
      _ipg_size=$(stat -c %s "$LOGFILE" 2>/dev/null || echo 0)
      case "$_ipg_size" in ''|*[!0-9]*) _ipg_size=0 ;; esac
      [ "$_ipg_size" -lt "$_ipg_off" ] && _ipg_off=0
      [ "$_ipg_off" -gt 0 ] && _ipg_seg=$(tail -c +$((_ipg_off + 1)) "$LOGFILE" 2>/dev/null) \
        || _ipg_seg=$(tail -n 200 "$LOGFILE" 2>/dev/null)
    fi
    _ipg_err=$(printf '%s\n' "$_ipg_seg" | grep -aE "listen err|Start TUN listening error" | tail -n 1)
    [ -n "$_ipg_err" ] && _ipg_bad="入站监听失败：$_ipg_err"
  fi
  [ -n "$_ipg_bad" ] || return 0
  printf '%s|%s\n' "$(uname -r 2>/dev/null)" "$(core_path 2>/dev/null)" > "$IPV6_PFAIL" 2>/dev/null
  _ipg_fp0=$(config_fingerprint)
  _ipg_chg=$(cfg_ipv6_set_all false)
  case "$_ipg_chg" in ''|*[!0-9]*) _ipg_chg=0 ;; esac
  if [ "$_ipg_chg" != "0" ] && [ "$_ipg_fp0" = "$(cat "$TESTED" 2>/dev/null)" ]; then
    config_fingerprint > "$TESTED" 2>/dev/null
  fi
  printf '%s 代理侧 IPv6 初始化失败（%s）；已把 ipv6 / dns.ipv6 / eBPF 接管 IPv6 改回 false（%s 项），系统 IPv6 仍保持开启\n' \
    "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$_ipg_bad" "$_ipg_chg" >> "$IPV6_PLOG" 2>/dev/null
  sw_log "IPv6 代理不可用，已回退为仅 IPv4 代理（系统 IPv6 仍开启）：$_ipg_bad"
  live_invalidate 2>/dev/null
  # 只重启一次让 v4-only 配置生效；marker 已落盘，本次不再触发第二轮
  nap 1
  sh "$0" restart-json >/dev/null 2>&1
  return 0
}

# 代理侧 IPv6 现状（给 status-json / 诊断用）：on / off / fallback
ipv6_proxy_state() {
  if [ "$(get_setting system_ipv6 false)" != "true" ]; then echo off; return 0; fi
  if [ "$(cfg_top_ipv6)" = "true" ]; then echo on; return 0; fi
  echo fallback
}

# 系统 IPv6 速览（诊断/自检用）：期望值、上次漂移追打、各网卡实况。
# 关态下若某块网卡显示 0：它刚被 netd 放开，下一拍对账（≤IPV6_TICK 秒）就会
# 追回，除非正处于 60s 冷却窗口 —— 这是排查「飞行模式后 v6 泄露」的第一手现场。
ipv6_status() {
  # 代理侧结论（on/off/fallback）放在最前面：这是「开了系统 IPv6 之后代理不接管」
  # 的第一判断点，见 ipv6_proxy_guard。
  echo "代理侧 IPv6：$(ipv6_proxy_state)（on=TUN/eBPF 也在接管 v6；fallback=本机内核起不来，已回退仅 IPv4；off=系统 IPv6 关）"
  if [ -f "$IPV6_PLOG" ]; then
    echo "回退记录（最近 3 条）："
    tail -n 3 "$IPV6_PLOG" 2>/dev/null | sed 's/^/  /'
  fi
  echo "配置文件顶层 ipv6: $(cfg_top_ipv6)（空=未写）"
  [ -f "$RUNDIR/active-config.yaml" ] && echo "内核在用配置 ipv6: $(CONFIG="$RUNDIR/active-config.yaml" cfg_top_ipv6)（空=未写）"
  echo "配置文件 TUN: $( tunhs_tun_enabled && echo on || echo off )"
  if [ "${1:-}" != "skip-api" ]; then
    _iv_tunrep=$(MH_API_TIMEOUT=2 api GET /configs 2>/dev/null | grep -o '"tun":{"enable":[a-z]*' | head -n 1)
    [ -n "$_iv_tunrep" ] && echo "内核自报 TUN: $_iv_tunrep （enable=false 而配置是 true ＝ TUN 没起来，流量不会进内核）"
  fi
  _iv_dir=${IPV6_CONF:-/proc/sys/net/ipv6/conf}
  _iv_w=""; [ -f "$IPV6_WANT" ] && IFS= read -r _iv_w < "$IPV6_WANT" 2>/dev/null
  case "$_iv_w" in
    0) echo "期望：系统 IPv6 保持可用（disable_ipv6=0）" ;;
    1) echo "期望：禁用系统 IPv6（disable_ipv6=1）" ;;
    *) echo "期望：（未落盘，等待首次对账）" ;;
  esac
  _iv_l=""; [ -f "$IPV6_LAST" ] && IFS= read -r _iv_l < "$IPV6_LAST" 2>/dev/null
  echo "上次漂移追打：${_iv_l:-无}"
  echo "对账节拍：${IPV6_TICK}s（冷却 ${IPV6_COOL}s）"
  # 蜂窝侧（APN 协议接管）摘要：关态=上网 APN 协议应为 IP；开态=应已还原。
  # 蜂窝网卡的内核 disable_ipv6 永久豁免（IMS/VoLTE 靠它），防泄漏只看这里。
  _iv_a4=""; [ -f "$APN4_STATE" ] && IFS= read -r _iv_a4 < "$APN4_STATE" 2>/dev/null
  if [ "$_iv_w" = "1" ]; then
    if [ -n "$_iv_a4" ]; then
      _iv_a4id=${_iv_a4%%|*}
      echo "APN4：已接管（协议=IPv4；原值记录 id=$_iv_a4id @ run/apn4.state）"
    else
      echo "APN4：未接管（无记录——首次对账后生效；也可手动把 APN 协议设为 IPv4）"
    fi
  else
    [ -n "$_iv_a4" ] && echo "APN4：残留接管记录（应已还原，可执行 apn4-restore 清理）" || echo "APN4：未接管（系统 IPv6 开启，不改 APN）"
  fi
  echo "各网卡（conf/*/disable_ipv6）："
  for _iv_f in "$_iv_dir"/*/disable_ipv6; do
    [ -e "$_iv_f" ] || continue
    _iv_if=${_iv_f%/disable_ipv6}; _iv_if=${_iv_if##*/}
    _iv_v=""; IFS= read -r _iv_v < "$_iv_f" 2>/dev/null
    si_exempt_if "$_iv_if" && { echo "  ${_iv_if}: ${_iv_v:-?}（豁免：蜂窝走 APN4 / 热点共享下游网卡交还系统管理）"; continue; }
    echo "  ${_iv_if}: ${_iv_v:-?}"
  done
  return 0
}

# ============================================================
# Tproxy 透明代理（模块设置 tproxy，默认 false）
# ------------------------------------------------------------
# 开启后不依赖 TUN 网卡，改用 netfilter TPROXY 接管系统流量：
#   · 自动识别配置里的 TProxy 端口：顶层 tproxy-port 优先，其次
#     listeners 中 type: tproxy 条目的 port（找不到则拒绝开启）；
#   · 自动关闭配置里的 TUN：顶层 tun.enable → false；listeners 中
#     type: tun 条目整条按 #TPROXY_OFF# 标记注释（关闭开关时按标记原样恢复）；
#   · 安装 mangle TPROXY 规则 + 策略路由（fwmark 0x1000000 → 表 252
#     「local default dev lo」），本机流量在 OUTPUT 打 mark 后经 lo 回注
#     PREROUTING，由 TPROXY 送进内核监听端口（与 box_for_magisk 同拓扑，
#     fwmark/表号/优先级同值，避开 netd 的 fwmark 位段与模块自身 8990-8999）；
#   · 防回环旁路：内核以 root:net_admin(0:3005) 身份拉起（busybox
#     setuidgid），OUTPUT 链按 --gid-owner 3005 精确旁路内核自身流量——
#     netd 等其它 root 进程的明文 DNS 仍会被接管，配合配置里的
#     「DST-PORT,53,dns-out」规则，fake-ip 链路与 TUN 模式一致；
#     setuidgid 不可用时回退裸 root + --uid-owner 0 旁路（root 进程直连，
#     DNS 走系统直连，域名规则依赖嗅探兜底）。
#   · 应用黑白名单：直接复用配置里 TUN 的「仅代理以下应用」
#     （tun.include-package）与「排除以下应用」（tun.exclude-package），
#     无需另设开关——TUN 页面改完名单保存即对 Tproxy 生效：
#     include 非空 = 白名单（只代理名单内应用），否则 exclude 非空 =
#     黑名单（名单内直连），否则全部代理（与 mihomo TUN 语义一致，
#     include 优先）。包名经包管理器解析为 UID 后生成 --uid-owner 规则；
#     名单仅作用于本机应用流量，热点/USB 共享的转发流量仍全部接管。
# 对账（tproxy_sync）幂等可重入：期望态 = 开关开 && 内核运行 && 端口已识别
# && 端口在监听 && 名单指纹；由 启停 / set 钩子 / 监听循环 / 配置热重载 驱动。
# 规则状态: run/tproxy.state；配置改动记录: run/tproxy.cfg；日志: run/tproxy.log
# ============================================================
TP_STATE_VER=11                   # 状态格式/安装策略版本（v11 所有 Tproxy 后端安装前检查 Mihomo TUN redirect 残留）
TP_UID_REFRESH=600                # 名单模式下 UID 重解析间隔（秒）：应用重装会换 UID，
                                  # 降级态（包管理器暂不可用/名单未解析）也靠它重试恢复
TP_APP_MAX=64                     # 单次安装最多写入的 UID 数（名单已按 UID 排序，超限取前 N 个并记日志）
TP_STATE=$RUNDIR/tproxy.state     # 已应用规则的状态（文件存在=已装）:
                                  # port= v6= bypass= mode= want= fp= fb= apps= uids= uh= pref= ver= backend=
TP_MISS=$RUNDIR/tproxy.miss       # 「内核在但端口未就绪」连续命中次数（宽限期内不拆规则）
TP_GRACE=3                        # 宽限轮数（对账约 5s/轮 → 约 15s）
                                  # 权衡：太短挡不住热重载抖动（又变回直连窗口），
                                  # 太长则内核真死时规则久留，流量被送进黑洞（无网络）。
                                  # 15s 足够覆盖内核重载配置，又不至于长时间黑洞。
TP_CFG=$RUNDIR/tproxy.cfg         # 开启时对 config.yaml 的改动记录（关闭时据此还原）
TP_LOG=$RUNDIR/tproxy.log
TP_LOG_PREV=$RUNDIR/tproxy.prev.log   # 关闭时保留最近一段，便于诊断互切前后的时间线
TP_CAP=$RUNDIR/tproxy.cap         # 已通过的内核/iptables 能力探测缓存，避免每次开关重复探测
TP_LOCK=$RUNDIR/tproxy.lock       # 对账互斥锁（目录型，语义同 TUNHS_LOCK）
TP_MARK="0x1000000/0x1000000"     # fwmark（bit 24，netd 不使用该位；set-xmark 保留原 mark 其余位）
TP_TABLE=252                      # 策略路由表：local default dev lo（须 ≤255：busybox ip 的表号是 u8，253–255 为系统保留）
TP_PREF=100                       # ip rule 优先级（先于系统各网络规则与 TUN 的 9000+）
TP_PREF_ALT="101 102 103 104"     # 主优先级被其它程序占用时的顺延备位
TP_CORE_UG="0:3005"               # tproxy 模式下内核的运行身份 root:net_admin
TP_CORE_GID=3005
TP_CHAIN_PRE=mihomo_tp_pre        # PREROUTING 子链：TPROXY 分流
TP_CHAIN_OUT=mihomo_tp_out        # OUTPUT 子链：本机流量打 mark
TP_CHAIN_DIV=mihomo_tp_divert     # 已建连 socket 快速通道（best-effort）
TP_NFT_TABLE=mihomo_tproxy        # nftables 独立表（inet 家族，与 fw4 的 inet fw4 表共存）
TP_NFT_FILE=$RUNDIR/tproxy.nft    # 最近一次生成/应用的 nft 规则（诊断与排障用）
TP_MARK_VALUE=0x01000000          # TP_MARK 的数值位（nft meta mark set 用）
TP_BACKEND=""                     # 运行时后端：nft | ipt（tp_setup_bins 填充）
TP_NFT=""                         # nft 命令路径（tp_setup_bins 填充）
TP_MARKER='#TPROXY_OFF#'        # 注释 tun 监听器条目的行标记（还原时按标记剥除）

tp_log() {
  printf '%s %s\n' "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$*" >> "$TP_LOG" 2>/dev/null
  _tl_s=$(wc -c < "$TP_LOG" 2>/dev/null)
  case "$_tl_s" in ''|*[!0-9]*) return 0 ;; esac
  [ "$_tl_s" -gt 32768 ] && { tail -n 60 "$TP_LOG" > "$TP_LOG.tmp" 2>/dev/null && mv "$TP_LOG.tmp" "$TP_LOG" 2>/dev/null; }
  return 0
}

# 识别配置里的 TProxy 入站。stdout 一行: "<port> <toplevel|listener> <bind/listen 地址|->"
# 顶层 tproxy-port 优先（全局 bind-address 决定 v6 能力）；其次 listeners 里
# 第一个带有效端口的 type: tproxy 条目（条目 listen 决定 v6 能力）。
tproxy_detect() {
  [ -f "$CONFIG" ] || return 0
  # 容忍常见写法差异：`tproxy-port: 10086`（标准）、`tproxy-port:10086`（冒号后
  # 无空格，此时 awk 的 $2 为空，早期版本会漏判成「没配端口」）、带引号、缩进、
  # 行尾注释。注释掉的整行（行首 # 在 tproxy-port 之前）不算数——那是被手动关掉的。
  _td_p=$(awk '
    {
      l = $0
      sub(/[[:space:]]*#.*$/, "", l)
      if (l ~ /^[[:space:]]*tproxy-port[[:space:]]*:/) {
        p = l
        sub(/^[[:space:]]*tproxy-port[[:space:]]*:[[:space:]]*/, "", p)
        gsub(/["\047]/, "", p)
        sub(/[^0-9].*$/, "", p)
        if (p + 0 > 0) { print p; exit }
      }
    }
  ' "$CONFIG" 2>/dev/null)
  if [ -n "$_td_p" ]; then
    _td_b=$(awk '/^bind-address:/ { print $2; exit }' "$CONFIG" 2>/dev/null | tr -d "\"'")
    echo "$_td_p toplevel ${_td_b:--}"
    return 0
  fi
  awk '
    function flushentry(   i, istp, p, l) {
      if (n == 0) return
      istp = 0; p = ""; l = "-"
      for (i = 1; i <= n; i++)
        if (ef[i] ~ /^[[:space:]]*(-[[:space:]]+)?type:[[:space:]]*["\047]?tproxy["\047]?[[:space:]]*(#.*)?$/) istp = 1
      if (istp) {
        for (i = 1; i <= n; i++) {
          if (p == "" && ef[i] ~ /^[[:space:]]*ports?:[[:space:]]*["\047]?[0-9]+/) {
            p = ef[i]; sub(/^[[:space:]]*ports?:[[:space:]]*/, "", p); gsub(/["\047]/, "", p); sub(/[^0-9].*$/, "", p)
          }
          if (l == "-" && ef[i] ~ /^[[:space:]]*listen:[[:space:]]*/) {
            l = ef[i]; sub(/^[[:space:]]*listen:[[:space:]]*/, "", l); sub(/[[:space:]]*(#.*)?$/, "", l); gsub(/["\047]/, "", l)
            if (l == "") l = "-"
          }
        }
        if (p + 0 > 0) { printf "%s listener %s\n", p, l; hit = 1 }
      }
      n = 0
    }
    /^[^ \t#-]/ {
      flushentry(); if (hit) exit
      inls = ($1 == "listeners:"); base = -1
      next
    }
    {
      if (!inls) next
      # 条目分界只认「与首个条目同缩进」的 - 行：dns-hijack 等嵌套列表
      # 缩进更深，不能被当成新条目把整条切碎
      if ($0 ~ /^[[:space:]]*-[[:space:]]/) {
        match($0, /[^[:space:]]/); ind = RSTART - 1
        if (base < 0) base = ind
        if (ind == base) { flushentry(); if (hit) exit }
      }
      ef[++n] = $0
    }
    END { flushentry() }
  ' "$CONFIG" 2>/dev/null | head -1
}

# DNS fake-ip 的 IPv6 段（mihomo 缺省 fd11:4455:fdea:4000::/64）。
# 真 240e: GUA 必须走原生；只把这一段送进 TPROXY，否则 test-ipv6 的 AAAA
# 是 fake-ip，包从真实网卡发出去就黑洞（TUN 会进虚拟网卡所以能测到）。
tproxy_fakeip6_range() {
  _f6=""
  if [ -f "$CONFIG" ]; then
    _f6=$(awk '
      /^[^ \t#-]/ { inb = ($1 == "dns:") }
      inb {
        l = $0; sub(/[ \t]*#.*$/, "", l)
        if (l ~ /^[ \t]*fake-ip-range6:[ \t]*/) {
          sub(/^[ \t]*fake-ip-range6:[ \t]*/, "", l); gsub(/["\047]/, "", l); print l; exit
        }
      }
    ' "$CONFIG" 2>/dev/null)
  fi
  case "$_f6" in
    *:*) printf '%s\n' "$_f6" ;;
    *)   printf '%s\n' "fd11:4455:fdea:4000::/64" ;;
  esac
}

# 系统 IPv6 打开时：真地址原生，只劫持 fake-ip6。
# $1 = toplevel|listener  $2 = 监听地址（- 表示缺省）
tproxy_v6_want() {
  [ "$(get_setting system_ipv6 false)" = "true" ] || return 1
  case "$1" in
    toplevel) case "$2" in "-"|"*"|"::") return 0 ;; esac ;;
    listener) case "$2" in "*"|"::") return 0 ;; esac ;;
  esac
  return 1
}

# TProxy 端口是否已在监听（内核真正就绪才装规则，避免把流量导向空端口）。
# 读 /proc/net/tcp{,6} 的 LISTEN(0A) 行，本地地址端口为十六进制。
tproxy_port_listening() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  _tp_hx=$(printf '%04X' "$1")
  # 只挑真实存在的文件：awk 碰到不存在的文件会 fatal 退出非零，
  # 那会被当成「端口没在听」，进而把好端端的规则拆掉。
  _tp_f=""
  for _tp_n in tcp udp tcp6 udp6; do
    [ -r "/proc/net/$_tp_n" ] && _tp_f="$_tp_f /proc/net/$_tp_n"
  done
  [ -n "$_tp_f" ] || return 1
  # TCP LISTEN(0A) 或 UDP 已绑定(07) 都算就绪：tproxy 入站同时开 TCP 与 UDP，
  # 只查 TCP 会在内核重建监听的瞬间误判成「未就绪」而触发不必要的拆装。
  #
  # st 必须先归一化：部分内核（实测若干 Android 设备）会把高位 0x80 一并置起，
  # 输出 8A/87 而不是 0A/07。精确匹配 0A 会漏判成「端口没在听」→ 状态卡在
  # pending → 规则一条不装 → 表现就是「开了 tproxy 却完全直连」，而诊断里
  # 监听条目明明列得出来，极具误导性。清掉高位再比即可。
  awk -v p="$_tp_hx" '
    function st_norm(s) {
      if (length(s) > 2) s = substr(s, length(s) - 1, 2)
      if (substr(s, 1, 1) == "8") s = "0" substr(s, 2, 1)
      return s
    }
    FNR > 1 {
      n = split($2, a, ":")
      if (toupper(a[n]) == p) {
        s = st_norm($4)
        if (s == "0A" || s == "07") f = 1
      }
    }
    END { exit !f }
  ' $_tp_f 2>/dev/null
}

# ---------------- TProxy 防火墙后端（iptables / nftables） ----------------
# Android 与旧 OpenWrt(fw3) 继续使用 iptables 实现；OpenWrt fw4 则优先使用
# 原生 nftables：规则落在独立的 inet mihomo_tproxy 表，fw4 reload 只重建
# 自己的 inet fw4 表，不会清掉本表。fw4 不在场时即使系统里有 nft 也不抢占
# Android 的 iptables 路径。MIHOMO_TPROXY_BACKEND=nft|iptables 可强制后端。
tp_setup_bins() {
  _tunhs_bins
  TP_IPT=$TUNHS_IPT; TP_IP=$TUNHS_IP; TP_IP6T=$TUNHS_IP6T
  TP_NFT=""
  if [ -x /usr/sbin/nft ]; then TP_NFT=/usr/sbin/nft
  elif [ -x /sbin/nft ]; then TP_NFT=/sbin/nft
  elif command -v nft >/dev/null 2>&1; then TP_NFT=$(command -v nft); fi
  case "${MIHOMO_TPROXY_BACKEND:-auto}" in
    nft) TP_BACKEND=nft ;;
    iptables|ipt) TP_BACKEND=ipt ;;
    *)
      TP_BACKEND=ipt
      if [ -n "$TP_NFT" ]; then
        if [ -x /sbin/fw4 ] || command -v fw4 >/dev/null 2>&1; then
          TP_BACKEND=nft
        elif [ -f /etc/openwrt_release ] && [ ! -x /sbin/fw3 ] && ! command -v fw3 >/dev/null 2>&1; then
          # /sbin/fw4 在精简固件里可能不在 PATH；OpenWrt 22.03+ 且无 fw3
          # 时按 nftables 世代处理（此处 nft 命令已经存在）。
          TP_BACKEND=nft
        fi
      fi
      ;;
  esac
  return 0
}

tp_nft_table_present() {
  [ -n "$TP_NFT" ] || return 1
  "$TP_NFT" list table inet "$TP_NFT_TABLE" >/dev/null 2>&1
}

tproxy_nft_delete() {
  [ -n "$TP_NFT" ] || return 0
  "$TP_NFT" delete table inet "$TP_NFT_TABLE" >/dev/null 2>&1
  return 0
}

# 查询 TCP LISTEN 状态（0=有监听，1=无监听，2=/proc 不可读或参数异常）。
# Mihomo TUN auto-redirect 会把 LAN TCP 改送到动态高端口；若内核退出/切换后
# 该端口已无人监听，残留的 inet mihomo NAT 表会在本模块 TPROXY 之后再次改写
# 目的端口，导致浏览器连接重置。只在确认目标端口全都失效时才考虑清表。
tproxy_nft_tcp_port_listening() {
  case "$1" in ''|*[!0-9]*) return 2 ;; esac
  [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null || return 2
  _tnp_hx=$(printf '%04X' "$1" 2>/dev/null) || return 2
  _tnp_seen=0
  for _tnp_f in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$_tnp_f" ] || continue
    _tnp_seen=1
    _tnp_result=$(awk -v p="$_tnp_hx" '
      FNR > 1 {
        n = split($2, a, ":")
        if (toupper(a[n]) == p && toupper($4) == "0A") f = 1
      }
      END { if (f) print "LISTEN"; else print "NONE" }
    ' "$_tnp_f" 2>/dev/null)
    _tnp_rc=$?
    [ "$_tnp_rc" = "0" ] || return 2
    case "$_tnp_result" in
      LISTEN) return 0 ;;
      NONE) ;;
      *) return 2 ;;
    esac
  done
  [ "$_tnp_seen" = "1" ] && return 1
  return 2
}

# 切入任一 Tproxy 后端前处理 Mihomo 自己的 TUN auto-redirect 残留。即使 Tproxy 使用 iptables，
# nft inet mihomo 仍可在后续 hook 优先级改写目的端口；这里只调用系统已有 nft，不安装新依赖。
# 安全条件：本配置的 TUN 已关闭；inet mihomo 表里能解析出 redirect 目标端口；
# 所有目标端口都没有 TCP LISTEN。只要 TUN 仍开、监听状态未知或任一端口仍活着，
# 都保留整张表并拒绝叠加，避免误删另一实例/仍在使用的 TUN 规则。
tproxy_nft_clear_stale_mihomo_redirect() {
  if [ -z "$TP_NFT" ]; then
    if [ "${TP_BACKEND:-ipt}" = "nft" ]; then
      tp_log "WARN nft 后端缺少 nft 命令，无法检查 inet mihomo 表；安装中止"
      return 1
    fi
    tp_log "WARN nft 命令不可用，无法检查可能残留的 inet mihomo 表；不额外安装 nft 依赖，继续既有 iptables 路径"
    return 0
  fi
  _tnm_table=$("$TP_NFT" list table inet mihomo 2>/dev/null)
  _tnm_rc=$?
  if [ "$_tnm_rc" != "0" ]; then
    _tnm_tables=$("$TP_NFT" list tables 2>/dev/null) || {
      tp_log "WARN 无法确认 inet mihomo 表是否存在，保留现状并拒绝叠加 TPROXY"
      return 1
    }
    if printf '%s\n' "$_tnm_tables" | grep -Eq '^table[[:space:]]+inet[[:space:]]+mihomo$'; then
      tp_log "WARN inet mihomo 表存在但无法读取，保留原表并拒绝叠加 TPROXY"
      return 1
    fi
    return 0
  fi
  _tnm_scan=$(printf '%s\n' "$_tnm_table" | awk '
    {
      gsub(/"[^"]*"/, "", $0)  # 不把 comment 字符串误识别为 nft 动作
      for (i = 1; i <= NF; i++) if ($i == "redirect" && $(i + 1) == "to") {
        seen = 1
        p = $(i + 2)
        if (p ~ /^:?[0-9]+$/) {
          sub(/^:/, "", p)
          if (p + 0 >= 1 && p + 0 <= 65535) print p + 0
          else print "UNKNOWN"
        } else print "UNKNOWN"
      }
    }
    END { if (!seen) print "NO_REDIRECT" }
  ' | sort -u)
  case "$_tnm_scan" in
    *UNKNOWN*)
      tp_log "WARN inet mihomo 含无法安全识别的 redirect 目标，保留原表并拒绝叠加 TPROXY"
      return 1
      ;;
    NO_REDIRECT) return 0 ;;
  esac
  _tnm_ports=$(printf '%s\n' "$_tnm_scan" | grep -E '^[0-9]+$' | sort -nu)
  [ -n "$_tnm_ports" ] || {
    tp_log "WARN 无法确认 inet mihomo redirect 目标端口，保留原表并拒绝叠加 TPROXY"
    return 1
  }
  [ -r "$CONFIG" ] || {
    tp_log "WARN 配置不存在或不可读，无法确认 TUN 已关闭；保留 inet mihomo 表并拒绝叠加 TPROXY"
    return 1
  }
  if tunhs_tun_enabled; then
    tp_log "WARN TUN 仍开启，保留 inet mihomo 表并拒绝叠加 TPROXY"
    return 1
  fi
  _tnm_live=""; _tnm_unknown=0
  for _tnm_p in $_tnm_ports; do
    if tproxy_nft_tcp_port_listening "$_tnm_p"; then
      _tnm_live="$_tnm_live $_tnm_p"
    else
      _tnm_rc=$?
      [ "$_tnm_rc" = "2" ] && _tnm_unknown=1
    fi
  done
  if [ -n "$_tnm_live" ]; then
    tp_log "WARN inet mihomo redirect 端口仍有 TCP 监听:${_tnm_live}；拒绝删除活动规则/叠加 TPROXY"
    return 1
  fi
  if [ "$_tnm_unknown" = "1" ]; then
    tp_log "WARN 无法确认 inet mihomo redirect 端口监听状态，保留原表并拒绝叠加 TPROXY"
    return 1
  fi
  if tunhs_tun_enabled; then
    tp_log "WARN 清理前检测到 TUN 已开启，保留 inet mihomo 表并拒绝叠加 TPROXY"
    return 1
  fi
  if "$TP_NFT" delete table inet mihomo >/dev/null 2>&1; then
    tp_log "heal: 清除失效的 Mihomo TUN auto-redirect 残留表 inet mihomo ports=$_tnm_ports"
    return 0
  fi
  _tnm_verify=$("$TP_NFT" list table inet mihomo 2>/dev/null)
  _tnm_rc=$?
  if [ "$_tnm_rc" = "0" ]; then
    tp_log "WARN 清理后 inet mihomo 表仍存在，拒绝叠加 TPROXY"
    return 1
  fi
  _tnm_tables=$("$TP_NFT" list tables 2>/dev/null) || {
    tp_log "WARN 清理后无法确认 inet mihomo 表状态，保留现状并拒绝叠加 TPROXY"
    return 1
  }
  if printf '%s\n' "$_tnm_tables" | grep -Eq '^table[[:space:]]+inet[[:space:]]+mihomo$'; then
    tp_log "WARN 无法清除失效的 inet mihomo redirect 表，拒绝叠加 TPROXY"
    return 1
  fi
  return 0
}

# 当前后端是否仍挂着接管规则（稳态自愈抽查用；只认当前后端）。
tproxy_hook_present() {
  if [ "$TP_BACKEND" = "nft" ]; then
    tp_nft_table_present
    return $?
  fi
  [ -n "$TP_IPT" ] || return 1
  $TP_IPT -w -t mangle -C PREROUTING -j "$TP_CHAIN_PRE" 2>/dev/null && return 0
  $TP_IPT -w -t mangle -C OUTPUT -p tcp -j "$TP_CHAIN_OUT" 2>/dev/null && return 0
  return 1
}

# nft 能力探测片段：stdin 是一份完整 ruleset，只做 nft -c 校验、不真正下发，
# 因此不会像临时挂钩那样在探测瞬间误接管真实流量。
_tpnft_check() {
  [ -n "$TP_NFT" ] || return 1
  _tnf_file=$RUNDIR/_tp_nft_probe.nft
  cat > "$_tnf_file" 2>/dev/null || return 1
  "$TP_NFT" -c -f "$_tnf_file" >/dev/null 2>>"$TP_LOG"
  _tnf_rc=$?
  rm -f "$_tnf_file" 2>/dev/null
  return "$_tnf_rc"
}

tproxy_probe_nft_caps() {
  if _tpnft_check <<EOF
table inet mihomo_tp_probe {
 chain prerouting {
  type filter hook prerouting priority mangle; policy accept;
  meta l4proto tcp tproxy ip to 127.0.0.1:1 meta mark set $TP_MARK_VALUE accept
 }
}
EOF
  then _tp_cap_tproxy=1; fi
  if _tpnft_check <<EOF
table inet mihomo_tp_probe {
 chain output {
  type route hook output priority mangle; policy accept;
  meta l4proto tcp meta skuid 0 meta skgid $TP_CORE_GID return
 }
}
EOF
  then _tp_cap_gid=1; fi
  if _tpnft_check <<EOF
table inet mihomo_tp_probe {
 chain output {
  type route hook output priority mangle; policy accept;
  meta l4proto tcp meta skuid 0 return
 }
}
EOF
  then _tp_cap_uid=1; fi
  if _tpnft_check <<EOF
table inet mihomo_tp_probe {
 chain prerouting {
  type filter hook prerouting priority mangle; policy accept;
  meta l4proto { tcp, udp } socket transparent 1 meta mark set $TP_MARK_VALUE accept
 }
}
EOF
  then _tp_cap_sockt=1; fi
  if _tpnft_check <<EOF
table inet mihomo_tp_probe {
 chain prerouting {
  type filter hook prerouting priority mangle; policy accept;
  meta l4proto { tcp, udp } socket wildcard 0 meta mark set $TP_MARK_VALUE accept
 }
}
EOF
  then _tp_cap_sock=1; fi
  if _tpnft_check <<EOF
table inet mihomo_tp_probe {
 chain prerouting {
  type filter hook prerouting priority mangle; policy accept;
  meta l4proto udp ip6 daddr fd00::/8 tproxy ip6 to :1 meta mark set $TP_MARK_VALUE accept
 }
}
EOF
  then _tp_cap_v6=1; fi
  return 0
}

# 能力探测：TPROXY 目标与 owner 匹配必须可用，否则装上规则内核自身流量
# 无法旁路 → 回环/黑洞。临时链探测，完毕即删。结果写入 _tp_cap_* 全局，
# install 直接引用。探测失败输出用户可读的 ERR 并返回非零。
tproxy_probe() {
  tp_setup_bins
  if [ -z "$TP_IP" ]; then
    echo "ERR: 系统缺少 ip 命令（OpenWrt 请安装 ip-full），无法启用 Tproxy 代理"
    return 1
  fi
  if [ "$TP_BACKEND" = "nft" ]; then
    if [ -z "$TP_NFT" ]; then
      echo "ERR: 已选择 nftables 后端但缺少 nft 命令（请安装 nftables-json），无法启用 Tproxy 代理"
      return 1
    fi
  elif [ -z "$TP_IPT" ]; then
    echo "ERR: 系统缺少 iptables / ip 命令，无法启用 Tproxy 代理"
    return 1
  fi
  # TProxy 开关通常会反复操作，而这些能力只由内核/防火墙实现决定；
  # 成功探测后按内核版本、后端与命令路径缓存，避免每次开关都重复探测。
  # 缓存不匹配时自然回退到完整探测。
  _tp_key="$(uname -r 2>/dev/null)|$TP_BACKEND|${TP_NFT:-$TP_IPT}|$TP_IP6T|$TP_CORE_GID"
  if [ -r "$TP_CAP" ]; then
    _tp_ck=""; _tp_ct=0; _tp_cg=0; _tp_cu=0; _tp_cs=0; _tp_cst=0; _tp_cv=0
    IFS="$(printf '\t')" read -r _tp_ck _tp_ct _tp_cg _tp_cu _tp_cs _tp_cst _tp_cv < "$TP_CAP" 2>/dev/null
    if [ "$_tp_ck" = "$_tp_key" ] && [ "$_tp_ct" = "1" ] && { [ "$_tp_cg" = "1" ] || [ "$_tp_cu" = "1" ]; }; then
      _tp_cap_tproxy=$_tp_ct; _tp_cap_gid=$_tp_cg; _tp_cap_uid=$_tp_cu
      _tp_cap_sock=$_tp_cs; _tp_cap_sockt=$_tp_cst; _tp_cap_v6=$_tp_cv
      return 0
    fi
  fi
  _tp_cap_tproxy=0; _tp_cap_gid=0; _tp_cap_uid=0; _tp_cap_sock=0; _tp_cap_sockt=0; _tp_cap_v6=0
  if [ "$TP_BACKEND" = "nft" ]; then
    tproxy_probe_nft_caps
  else
  $TP_IPT -w -t mangle -N mihomo_tp_probe 2>/dev/null
  $TP_IPT -w -t mangle -A mihomo_tp_probe -m owner --uid-owner 0 --gid-owner "$TP_CORE_GID" -j RETURN 2>/dev/null && _tp_cap_gid=1
  $TP_IPT -w -t mangle -A mihomo_tp_probe -m owner --uid-owner 0 -j RETURN 2>/dev/null && _tp_cap_uid=1
  $TP_IPT -w -t mangle -A mihomo_tp_probe -p tcp -j TPROXY --on-ip 127.0.0.1 --on-port 1 --tproxy-mark "$TP_MARK" 2>/dev/null && _tp_cap_tproxy=1
  $TP_IPT -w -t mangle -A mihomo_tp_probe -p tcp -m socket --transparent -j RETURN 2>/dev/null && _tp_cap_sockt=1
  $TP_IPT -w -t mangle -A mihomo_tp_probe -p tcp -m socket -j RETURN 2>/dev/null && _tp_cap_sock=1
  $TP_IPT -w -t mangle -F mihomo_tp_probe 2>/dev/null
  $TP_IPT -w -t mangle -X mihomo_tp_probe 2>/dev/null
  if [ -n "$TP_IP6T" ]; then
    $TP_IP6T -w -t mangle -N mihomo_tp_probe 2>/dev/null
    $TP_IP6T -w -t mangle -A mihomo_tp_probe -p udp -j TPROXY --on-ip :: --on-port 1 --tproxy-mark "$TP_MARK" 2>/dev/null && _tp_cap_v6=1
    $TP_IP6T -w -t mangle -F mihomo_tp_probe 2>/dev/null
    $TP_IP6T -w -t mangle -X mihomo_tp_probe 2>/dev/null
  fi
  fi
  if [ "$_tp_cap_tproxy" != "1" ]; then
    rm -f "$TP_CAP" 2>/dev/null
    if [ "$TP_BACKEND" = "nft" ]; then
      echo "ERR: 内核不支持 nftables TPROXY，无法启用 Tproxy 代理（请安装 kmod-nft-tproxy，并确认 nft 命令可用）"
    else
      echo "ERR: 内核不支持 TPROXY（mangle 目标缺失），无法启用 Tproxy 代理（请安装 iptables-mod-tproxy 与 kmod-ipt-tproxy）"
    fi
    return 1
  fi
  if [ "$_tp_cap_gid" != "1" ] && [ "$_tp_cap_uid" != "1" ]; then
    rm -f "$TP_CAP" 2>/dev/null
    if [ "$TP_BACKEND" = "nft" ]; then
      echo "ERR: nftables 缺少 skuid/skgid 匹配，无法旁路内核自身流量（会形成回环断网），未启用（请安装 nftables-json 与 kmod-nft-core）"
    else
      echo "ERR: 内核缺少 iptables owner 匹配，无法旁路内核自身流量（会形成回环断网），未启用（请安装 iptables-mod-extra）"
    fi
    return 1
  fi
  # 原子落盘，避免进程被杀时留下半行缓存；失败时下次会重新探测。
  _tp_cap_tmp="$TP_CAP.$$"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$_tp_key" "$_tp_cap_tproxy" "$_tp_cap_gid" "$_tp_cap_uid" "$_tp_cap_sock" "$_tp_cap_sockt" "$_tp_cap_v6" > "$_tp_cap_tmp" 2>/dev/null && mv -f "$_tp_cap_tmp" "$TP_CAP" 2>/dev/null
  rm -f "$_tp_cap_tmp" 2>/dev/null
  return 0
}

# OUTPUT 子链首条：内核自身流量旁路。gid=按组精确匹配（只旁路内核，netd 的
# DNS 仍被接管）；uid=兜底（root 进程全部直连，DNS 走系统直连）。
tp_bypass_rule() {
  # $1 = iptables 命令（$TP_IPT 或 $TP_IP6T）  $2 = 链名  $3 = gid|uid
  if [ "$3" = "gid" ]; then
    tp_b_add "$1" "$2" -m owner --uid-owner 0 --gid-owner "$TP_CORE_GID" -j RETURN
  else
    tp_b_add "$1" "$2" -m owner --uid-owner 0 -j RETURN
  fi
}

# ---------------- 应用黑白名单（复用 tun.include/exclude-package） ----------------
# stdin→指纹（cksum→md5sum→行数字节数三级回退；两边同 helper，结果可比）
tp_fp_of() {
  _fp_in=$(cat 2>/dev/null)
  _fp_v=$(printf '%s' "$_fp_in" | cksum 2>/dev/null | awk '{print $1}')
  if [ -z "$_fp_v" ]; then _fp_v=$(printf '%s' "$_fp_in" | md5sum 2>/dev/null | awk '{print $1}'); fi
  if [ -z "$_fp_v" ]; then _fp_v="n$(printf '%s' "$_fp_in" | wc -l 2>/dev/null):$(printf '%s' "$_fp_in" | wc -c 2>/dev/null)"; fi
  printf '%s' "${_fp_v:-0}"
}

# 读取 tun 块内列表字段（$1=字段名），stdout 每行一个条目。
# 支持块式（- 项）与流式（[a, b] / []），跳过注释与空行，去引号去首尾空白；
# 字段缺失、tun 块缺失、空列表一律输出空（调用方按「无名单」处理）。
tproxy_tun_list() {
  [ -f "$CONFIG" ] || return 0
  awk -v k="$1" '
    function emit_flow(v,   n, a, i, x) {
      sub(/^[ \t]*\[/, "", v); sub(/\][ \t]*$/, "", v)
      n = split(v, a, ",")
      for (i = 1; i <= n; i++) {
        x = a[i]
        gsub(/^[ \t"\047]+|[ \t"\047]+$/, "", x)
        if (x != "") print x
      }
    }
    function ind(s) { if (match(s, /[^ \t]/)) return RSTART - 1; return 0 }
    /^[^ \t#-]/ { inb = ($1 == "tun:"); inf = 0; next }
    !inb { next }
    /^[ \t]*#/ || /^[ \t]*$/ { next }
    {
      line = $0
      sub(/[ \t]+#.*$/, "", line)   # 行尾注释（包名/数字不可能含 #，可安全剥除）
      if (!inf) {
        if (line ~ "^[ \t]*" k "[ \t]*:([ \t]+.*|[ \t]*)$") {
          rest = line
          sub("^[ \t]*" k "[ \t]*:", "", rest); sub(/^[ \t]+/, "", rest)
          if (rest ~ /^\[.*\]$/) { emit_flow(rest); exit }
          if (rest == "" || rest == "[]") { inf = 1; find = ind($0); next }
          gsub(/^[ \t"\047]+|[ \t"\047]+$/, "", rest)
          if (rest != "") print rest   # 标量单值（写法不规范也容忍一个）
          exit
        }
        next
      }
      # 块式列表项：缩进必须比字段行更深，否则视为字段结束
      if (line ~ /^[ \t]*-[ \t]+/ && ind($0) > find) {
        item = line; sub(/^[ \t]*-[ \t]+/, "", item)
        gsub(/^[ \t"\047]+|[ \t"\047]+$/, "", item)
        if (item != "") print item
        next
      }
      exit
    }
  ' "$CONFIG" 2>/dev/null
}

# 应用分流规格。stdout 一行: "<mode> <count> <fp>"
#   mode  = all | include | exclude（include 非空优先，与 mihomo TUN 语义一致）
#   count = 生效名单的包名数（all 为 0）
#   fp    = 生效名单的指纹（名单内容不变则 fp 不变；all 固定为 all）
# 对账只比对 fp，不解析 UID —— 包管理器查询只发生在真正需要装规则时，
# 稳态每轮对账零包管理器调用。
tproxy_app_spec() {
  _as_inc=$(tproxy_tun_list include-package | sort -u)
  if [ -n "$_as_inc" ]; then
    _as_list=$_as_inc; _as_mode=include
  else
    _as_exc=$(tproxy_tun_list exclude-package | sort -u)
    if [ -n "$_as_exc" ]; then _as_list=$_as_exc; _as_mode=exclude
    else echo "all 0 all"; return 0; fi
  fi
  _as_cnt=$(printf '%s\n' "$_as_list" | grep -c .)
  _as_fp=$(printf '%s\n' "$_as_list" | tp_fp_of)
  echo "$_as_mode $_as_cnt ${_as_fp:-0}"
}

# 生效名单的包名（一行一个；all 模式输出空）。$1=mode
tproxy_app_list() {
  case "$1" in
    include) tproxy_tun_list include-package | sort -u ;;
    exclude) tproxy_tun_list exclude-package | sort -u ;;
  esac
}

# 包名→UID 映射转储（user 0）。stdout 为 `list packages -U` 原文；失败返回非零。
tproxy_pkg_dump() {
  for _pd_b in cmd pm; do
    if [ "$_pd_b" = cmd ]; then
      _pd_out=$(pkg_query cmd package list packages --user 0 -U 2>/dev/null) || continue
    else
      _pd_out=$(pkg_query pm list packages --user 0 -U 2>/dev/null) || continue
    fi
    printf '%s\n' "$_pd_out" | grep -q '^package:.* uid:[0-9]' || continue
    printf '%s\n' "$_pd_out"
    return 0
  done
  return 1
}

# 包名解析为 UID。$1=dump 文件；$2=wanted 包名文件（一行一个）。
# stdout 行: "U:<uid>"（含多用户展开）与 "M:<包名>"（未解析到），调用方按前缀拆分。
# 多用户展开：tun.include-android-user 非空时，把每个 UID 按 appId 展开到所列
# 用户（uid = user*100000 + appId）；为空则只匹配 user 0（单用户设备无影响，
# 多用户设备请在该字段列出用户 ID，诊断里会提示）。
tproxy_resolve_uids() {
  _ru_dump=$1; _ru_want=$2
  _ru_users=$(tproxy_tun_list include-android-user 2>/dev/null | grep -E '^[0-9]+$' | sort -nu | tr '\n' ' ')
  awk -v users="$_ru_users" '
    NR == FNR { if ($0 != "") want[$0] = 0; next }
    /^package:/ {
      name = $1; sub(/^package:/, "", name)
      if (!(name in want)) next
      want[name] = 1
      u = ""
      for (i = 2; i <= NF; i++) if ($i ~ /^uid:[0-9]+$/) { u = $i; sub(/^uid:/, "", u) }
      if (u == "") next
      print "U:" u
      if (users != "") {
        aid = u % 100000
        n = split(users, arr, " ")
        for (i = 1; i <= n; i++)
          if (arr[i] != "" && arr[i] != 0) print "U:" (arr[i] * 100000 + aid)
      }
    }
    END { for (w in want) if (!want[w]) print "M:" w }
  ' "$_ru_want" "$_ru_dump" 2>/dev/null
}

# 按当前期望名单解析 UID（供对账调用，前置 _ps_wmode 已就绪）。
# 成功返回 0 并设置 _PU_UIDS（空格分隔去重 UID，可为空）/_PU_MISS（空格分隔缺失包名）
# /_PU_FB（1=include 名单全部未解析，有效规则退化为全部代理）；包管理器完全
# 不可用返回 1（调用方按降级处理并记日志）。
tproxy_prepare_uids() {
  _PU_UIDS=""; _PU_MISS=""; _PU_FB=0
  [ "$_ps_wmode" = "all" ] && return 0
  _pu_want=$RUNDIR/_tp_want.tmp; _pu_dump=$RUNDIR/_tp_dump.tmp
  tproxy_app_list "$_ps_wmode" > "$_pu_want" 2>/dev/null
  if ! grep -q . "$_pu_want" 2>/dev/null; then
    rm -f "$_pu_want" "$_pu_dump" 2>/dev/null
    _PU_FB=1
    return 0
  fi
  if ! tproxy_pkg_dump > "$_pu_dump" 2>/dev/null; then
    rm -f "$_pu_want" "$_pu_dump" 2>/dev/null
    return 1
  fi
  _pu_all=$(tproxy_resolve_uids "$_pu_dump" "$_pu_want" 2>/dev/null)
  rm -f "$_pu_want" "$_pu_dump" 2>/dev/null
  _PU_UIDS=$(printf '%s\n' "$_pu_all" | grep '^U:' | cut -c3- | grep -E '^[0-9]+$' | sort -nu | tr '\n' ' ' | sed 's/ $//')
  _PU_MISS=$(printf '%s\n' "$_pu_all" | grep '^M:' | cut -c3- | tr '\n' ' ' | sed 's/ $//')
  # include 名单一个都解析不到 = 白名单无成员：有效规则退化为全部代理并标记 fb，
  # 由 UID 定期重解析在应用装好后自动恢复（exclude 为空本就等价于全部，无需标记）。
  if [ -z "$_PU_UIDS" ] && [ "$_ps_wmode" = "include" ]; then _PU_FB=1; fi
  return 0
}

# 解析结果落日志（只在真正装规则时调用，稳态重解析命中时不刷屏）。
tproxy_log_resolve() {
  # $1=1 表示包管理器完全不可用（tproxy_prepare_uids 返回 1）
  if [ "$1" = "1" ]; then
    tp_log "WARN 包管理器查询失败，应用名单暂不生效，已按全部应用代理（${TP_UID_REFRESH} 秒后自动重试）"
    return 0
  fi
  if [ -n "$_PU_MISS" ]; then
    tp_log "WARN $_ps_wmode 名单中有包名未解析到 UID，已跳过：$_PU_MISS"
  fi
  if [ "${_PU_FB:-0}" = "1" ]; then
    tp_log "WARN $_ps_wmode 名单全部未解析，已按全部应用代理（${TP_UID_REFRESH} 秒后自动重试）"
  fi
}

# 状态文件年龄（秒）。读不到按 0 处理（调用方只在 have=1 时查询）。
tproxy_state_age() {
  _sa_now=$(date +%s 2>/dev/null)
  _sa_mt=$(stat -c %Y "$TP_STATE" 2>/dev/null || "$BUSYBOX" stat -c %Y "$TP_STATE" 2>/dev/null)
  case "$_sa_now" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  case "$_sa_mt" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  _sa_a=$((_sa_now - _sa_mt))
  [ "$_sa_a" -lt 0 ] && _sa_a=0
  echo "$_sa_a"
}

# 以下三个函数的调用约定：$1=ip 命令路径，$2=pref，其余参数原样传给 ip
# （v6 调用时多传一个 -6）。不能把 "$TP_IP -6" 当成一个参数——那样会被
# 当成名为「ip -6」的命令，v6 规则永远装不上。

# 该优先级的策略路由规则是否存在（ip rule show 输出格式各家不同：
# 「100:	from all ...」或「... pref 100 ...」，两种都认）
# 该优先级上「本模块装的」策略路由规则是否存在。
# 判据是 fwmark + 路由表与本模块一致：只认自己的，绝不碰别的程序在同一
# 优先级上的规则——删掉别人的策略路由会直接搞坏人家的网络。
tproxy_iprule_ours() {
  _to_ip=$1; _to_p=$2; shift 2
  $_to_ip "$@" rule show 2>/dev/null | awk -v p="$_to_p" -v m="$TP_MARK" -v t="$TP_TABLE" '
    { isp = 0
      if ($1 == p ":" || $1 == p) isp = 1
      for (i = 1; i < NF; i++) if ($i == "pref" && $(i + 1) == p) isp = 1
      if (isp && index($0, m) && index($0, "lookup " t)) f = 1 }
    END { exit !f }'
}

# 清掉指定优先级上本模块的策略路由规则（幂等；不是自己的规则直接返回）。
# busybox/toybox 的 `ip rule del pref N` 常因语法差异匹配不到任何规则，旧
# 规则清不掉、随后 add 报 "RTNETLINK answers: File exists" 让整次 install
# 失败，所以这里按完整参数先精确删、再按 pref 删，直到确实删不动为止。
tproxy_iprule_clear() {
  _tc_ip=$1; _tc_p=$2; shift 2
  _tc_i=0
  while [ "$_tc_i" -lt 8 ]; do
    tproxy_iprule_ours "$_tc_ip" "$_tc_p" "$@" || return 0
    $_tc_ip "$@" rule del fwmark "$TP_MARK" table "$TP_TABLE" pref "$_tc_p" 2>/dev/null
    $_tc_ip "$@" rule del pref "$_tc_p" 2>/dev/null
    $_tc_ip "$@" rule del table "$TP_TABLE" pref "$_tc_p" 2>/dev/null
    _tc_i=$((_tc_i + 1))
  done
}

# 添加策略路由规则，主优先级被其它程序占用时顺延到备用位。
# 输出实际用到的优先级，供状态文件记录、teardown 精确回收。
tproxy_iprule_add() {
  # $1=ip 命令  $2=pref 列表（空格分隔）  其余参数原样传给 ip
  _ta_ip=$1; _ta_list=$2; shift 2
  # 幂等优先：本模块的规则本来就在（重装/切端口/切名单都会走到这里）时直接复用
  # 同一个优先级。以前是先 `rule add`（撞已存在）→ `rule show` → `rule del` →
  # 再 `rule add`，多跑四个进程，而且删除到重建之间带 mark 的包会短暂丢路由
  # ——切换瞬间的断流就是它。
  _ta_show=$($_ta_ip "$@" rule show 2>/dev/null)
  if [ -n "$_ta_show" ]; then
    _ta_hit=$(printf '%s\n' "$_ta_show" | awk -v list="$_ta_list" -v m="$TP_MARK" -v t="$TP_TABLE" '
      BEGIN { n = split(list, a, " "); for (i = 1; i <= n; i++) want[a[i]] = 1 }
      { p = $1; sub(/:$/, "", p)
        if ((p in want) && index($0, m) && index($0, "lookup " t)) print p }' | head -1)
    if [ -n "$_ta_hit" ]; then
      echo "$_ta_hit"
      return 0
    fi
  fi
  for _ta_p in $_ta_list; do
    _ta_err=$($_ta_ip "$@" rule add pref "$_ta_p" fwmark "$TP_MARK" table "$TP_TABLE" 2>&1) && { echo "$_ta_p"; return 0; }
    printf '%s\n' "$_ta_err" >> "$TP_LOG" 2>/dev/null
    # 参数本身被拒（如表号超出 busybox 范围）换优先级也没用，直接失败，不能误报成「优先级被占用」
    case "$_ta_err" in *nvalid*) tp_log "ERR ip rule 参数被拒绝，停止顺延: $_ta_err"; return 1 ;; esac
    # 被占用。只有确认是本模块上次的残留才清理后重试；别人的规则一律顺延，不动。
    if tproxy_iprule_ours "$_ta_ip" "$_ta_p" "$@"; then
      tp_log "ip rule pref $_ta_p 是上次残留，清理后重试"
      tproxy_iprule_clear "$_ta_ip" "$_ta_p" "$@"
      if $_ta_ip "$@" rule add pref "$_ta_p" fwmark "$TP_MARK" table "$TP_TABLE" 2>>"$TP_LOG"; then
        echo "$_ta_p"
        return 0
      fi
    fi
    tp_log "WARN ip rule pref $_ta_p 被其它程序占用，顺延下一个"
  done
  return 1
}

# ICMPv6（RS/RA/NS/NA）与 DHCPv6 必须直连，否则网卡拿不到 GUA。
# $1=ip6tables  $2=链名
_ti_v6_nd_bypass() {
  tp_b_add "$1" "$2" -p icmpv6 -j RETURN
  tp_b_add "$1" "$2" -p udp --dport 546 -j RETURN
  tp_b_add "$1" "$2" -p udp --dport 547 -j RETURN
  tp_b_add "$1" "$2" -p udp --sport 546 -j RETURN
  tp_b_add "$1" "$2" -p udp --sport 547 -j RETURN
  return 0
}

# 本机 GUA / ULA（xt_addrtype 在部分机没有，按 ip -6 addr 逐条 RETURN）
_ti_v6_local_return() {
  [ -n "$TP_IP" ] || return 0
  # 循环不能放进管道子 shell：批量模式下规则是攒在变量里的，子 shell 里的
  # 追加会随子 shell 一起丢掉（表现为这几条直连规则静默消失）。
  _lr_all=$($TP_IP -6 addr show 2>/dev/null)
  while IFS= read -r _lr_l; do
    case "$_lr_l" in *" inet6 "*) ;; *) continue ;; esac
    _lr_a=$(printf '%s\n' "$_lr_l" | awk '{print $2}')
    _lr_a=${_lr_a%%/*}
    case "$_lr_a" in
      ""|::|::1|fe80:*) continue ;;
    esac
    tp_b_add "$1" "$2" -d "$_lr_a" -j RETURN
  done <<EOF
$_lr_all
EOF
  return 0
}

# v6 半成品回滚：local default 留在表里会让所有 v6 目的地变成本机。
tproxy_v6_unhook() {
  if [ "$TP_BACKEND" = "nft" ]; then
    # nft 后端没有独立的 v6 链可摘：v6 规则与 v4 同在一张表里，
    # 这里只回收 v6 策略路由，整表去留由 install/teardown 决定。
    tproxy_nft_clear_v6_routes
    return 0
  fi
  if [ -n "$TP_IP6T" ]; then
    while $TP_IP6T -w -t mangle -D PREROUTING -j "$TP_CHAIN_PRE" 2>/dev/null; do :; done
    while $TP_IP6T -w -t mangle -D OUTPUT -p tcp -j "$TP_CHAIN_OUT" 2>/dev/null; do :; done
    while $TP_IP6T -w -t mangle -D OUTPUT -p udp -j "$TP_CHAIN_OUT" 2>/dev/null; do :; done
    for _tv_c in "$TP_CHAIN_PRE" "$TP_CHAIN_OUT" "$TP_CHAIN_DIV"; do
      $TP_IP6T -w -t mangle -F "$_tv_c" 2>/dev/null
      $TP_IP6T -w -t mangle -X "$_tv_c" 2>/dev/null
    done
  fi
  tproxy_v6_unhook_routes
  return 0
}

# 只回收 v6 的策略路由（ip rule + 路由表）。v6 跳转/链的清理与它分开：
# 批量下发路径下跳转由事务里的 -D 处理，链由声明清空，这里只剩 ip 侧要动。
tproxy_v6_unhook_routes() {
  if [ -n "$TP_IP" ]; then
    for _tv_p in "$TP_PREF" $TP_PREF_ALT; do
      tproxy_iprule_clear "$TP_IP" "$_tv_p" -6
    done
    $TP_IP -6 route flush table "$TP_TABLE" 2>/dev/null
  fi
  return 0
}

# 向 OUTPUT 子链追加应用 UID 规则（$1=iptables 命令，$2=链名）。
# exclude=名单 RETURN（直连），include=名单 MARK（仅名单进代理）；
# 前置：_ti_mode/_ti_uids 就绪。任一规则失败返回非零（调用方决定回滚或降级）。
_ti_app_rules() {
  _ti_applied=0
  for _ti_u in $_ti_uids; do
    [ "$_ti_applied" -ge "$TP_APP_MAX" ] && break
    case $_ti_u in ''|*[!0-9]*) continue ;; esac
    case $_ti_mode in
      exclude)
        tp_b_add "$1" "$2" -m owner --uid-owner "$_ti_u" -j RETURN || return 1 ;;
      include)
        tp_b_add "$1" "$2" -p tcp -m owner --uid-owner "$_ti_u" -j MARK --set-xmark "$TP_MARK" || return 1
        tp_b_add "$1" "$2" -p udp -m owner --uid-owner "$_ti_u" -j MARK --set-xmark "$TP_MARK" || return 1 ;;
    esac
    _ti_applied=$((_ti_applied + 1))
  done
  return 0
}

# ---------------- nftables 后端 ----------------
# 只清 IPv6 策略路由（v6 fake-ip 装配失败时回退到纯 v4，不碰 v4 路由）。
tproxy_nft_clear_v6_routes() {
  [ -n "$TP_IP" ] || return 0
  for _nv_p in "$TP_PREF" $TP_PREF_ALT; do
    case "$_nv_p" in ''|*[!0-9]*) continue ;; esac
    tproxy_iprule_clear "$TP_IP" "$_nv_p" -6
  done
  $TP_IP -6 route flush table "$TP_TABLE" 2>/dev/null
  return 0
}

# 生成 nft ruleset 到 $1（$2=fake-ip-range6，已校验）。
# 前置：_ti_port/_ti_v6_ok/_ti_bp/_ti_mode/_ti_uids 与 _tp_cap_* 就绪。
# 结构与 iptables 版一一对应：PREROUTING 做 socket 快速通道/保留地址绕行/
# TPROXY；OUTPUT(route) 做内核旁路/应用名单/保留地址绕行/打 mark。
# nft 的 skuid/skgid 对应 iptables owner；tproxy 语句对应 TPROXY 目标。
tproxy_nft_write() {
  _tn_file=$1; _tn_f6=$2
  _ti_applied=0; _tn_uid_csv=""
  case "$_ti_mode" in
    include|exclude)
      for _tn_u in $_ti_uids; do
        case "$_tn_u" in ''|*[!0-9]*) continue ;; esac
        [ "$_ti_applied" -ge "$TP_APP_MAX" ] && break
        if [ -n "$_tn_uid_csv" ]; then _tn_uid_csv="$_tn_uid_csv, $_tn_u"; else _tn_uid_csv=$_tn_u; fi
        _ti_applied=$((_ti_applied + 1))
      done
      ;;
  esac
  _tn_mark="meta mark set meta mark or $TP_MARK_VALUE"
  _tn_local6=""
  if [ "$_ti_v6_ok" = "on" ] && [ -n "$TP_IP" ]; then
    _tn_local6=$($TP_IP -6 addr show 2>/dev/null | awk '
      $1 == "inet6" {
        a = $2; sub(/\/.*/, "", a)
        if (a != "" && a != "::" && a != "::1" && a !~ /^fe80:/) print a
      }')
  fi
  {
    printf 'table inet %s {\n' "$TP_NFT_TABLE"
    printf ' chain prerouting {\n'
    printf '  type filter hook prerouting priority mangle; policy accept;\n'
    if [ "$_ti_v6_ok" = "on" ]; then
      printf '  meta nfproto ipv6 meta l4proto ipv6-icmp return\n'
      printf '  meta nfproto ipv6 udp dport { 546, 547 } return\n'
      printf '  meta nfproto ipv6 udp sport { 546, 547 } return\n'
    fi
    if [ "$_tp_cap_sockt" = "1" ]; then
      printf '  meta l4proto { tcp, udp } socket transparent 1 counter %s accept\n' "$_tn_mark"
    fi
    if [ "$_ti_v6_ok" = "on" ]; then
      for _tn_a in $_tn_local6; do
        printf '  ip6 daddr %s return\n' "$_tn_a"
      done
      # fake-ip6 必须排在 fc00::/7 等保留段绕行之前，与 iptables 版同序。
      printf '  meta l4proto tcp ip6 daddr %s counter tproxy ip6 to :%s %s accept\n' "$_tn_f6" "$_ti_port" "$_tn_mark"
      printf '  meta l4proto udp ip6 daddr %s counter tproxy ip6 to :%s %s accept\n' "$_tn_f6" "$_ti_port" "$_tn_mark"
      printf '  ip6 daddr { ::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8 } return\n'
    fi
    printf '  ip daddr { 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4 } return\n'
    printf '  meta nfproto ipv4 meta l4proto tcp counter tproxy ip to 127.0.0.1:%s %s accept\n' "$_ti_port" "$_tn_mark"
    printf '  meta nfproto ipv4 meta l4proto udp counter tproxy ip to 127.0.0.1:%s %s accept\n' "$_ti_port" "$_tn_mark"
    printf ' }\n'
    printf ' chain output {\n'
    printf '  type route hook output priority mangle; policy accept;\n'
    if [ "$_ti_v6_ok" = "on" ]; then
      printf '  meta nfproto ipv6 meta l4proto ipv6-icmp return\n'
      printf '  meta nfproto ipv6 udp dport { 546, 547 } return\n'
      printf '  meta nfproto ipv6 udp sport { 546, 547 } return\n'
    fi
    if [ "$_ti_bp" = "gid" ]; then
      printf '  meta l4proto { tcp, udp } meta skuid 0 meta skgid %s return\n' "$TP_CORE_GID"
    else
      printf '  meta l4proto { tcp, udp } meta skuid 0 return\n'
    fi
    if [ -n "$_tn_uid_csv" ]; then
      if [ "$_ti_mode" = "exclude" ]; then
        printf '  meta l4proto { tcp, udp } meta skuid { %s } return\n' "$_tn_uid_csv"
      else
        printf '  meta l4proto { tcp, udp } meta skuid { %s } counter %s\n' "$_tn_uid_csv" "$_tn_mark"
      fi
    fi
    printf '  ip daddr { 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4 } return\n'
    if [ "$_ti_mode" = "include" ]; then
      printf '  meta l4proto { tcp, udp } return\n'
    else
      printf '  meta nfproto ipv4 meta l4proto { tcp, udp } counter %s\n' "$_tn_mark"
      if [ "$_ti_v6_ok" = "on" ]; then
        printf '  meta nfproto ipv6 meta l4proto { tcp, udp } ip6 daddr %s counter %s\n' "$_tn_f6" "$_tn_mark"
      fi
    fi
    printf ' }\n'
    printf '}\n'
  } > "$_tn_file" 2>/dev/null
}

# 原子替换本模块的 nft 表：同一份事务里先删旧表（如存在）再建新表，
# 中途失败整份事务不生效，不会留下半套规则。
tproxy_nft_apply() {
  [ -n "$TP_NFT" ] || return 1
  [ -r "$TP_NFT_FILE" ] || return 1
  "$TP_NFT" -c -f "$TP_NFT_FILE" >>"$TP_LOG" 2>&1 || return 1
  _tn_apply=$RUNDIR/_tp_nft_apply.nft
  {
    if "$TP_NFT" list table inet "$TP_NFT_TABLE" >/dev/null 2>&1; then
      printf 'delete table inet %s\n' "$TP_NFT_TABLE"
    fi
    cat "$TP_NFT_FILE"
  } > "$_tn_apply" 2>/dev/null || { rm -f "$_tn_apply" 2>/dev/null; return 1; }
  "$TP_NFT" -f "$_tn_apply" >>"$TP_LOG" 2>&1
  _tn_rc=$?
  rm -f "$_tn_apply" 2>/dev/null
  return "$_tn_rc"
}

# ---------------- 批量下发（iptables-restore） ----------------
# iptables 后端装一次规则要几十次 fork：每次 `iptables` 都要起进程、抢 xtables 锁、
# 走一遍 netlink，手机上单次 40~100ms，四十来次就是好几秒 —— 这正是「切到 Tproxy
# 之后要等很久才真正生效」的主因。这里把整份规则攒成一份 ruleset，用
# `iptables-restore --noflush` 一个事务下发：
#   · 链声明 `:CHAIN - [0:0]` 自带建链 + 清空，等价于原来的 -N 加 -F；
#   · -A / -I / -D 都在同一事务里，整份规则原子生效，没有「链清了、规则还没加」
#     的空窗；
#   · 没有 iptables-restore（精简 busybox / 老固件）或某个版本不认这些行时，事务
#     会失败 → 整体回退到逐条下发，行为与以前一致（TP_BULK=0）。
TP_BULK=0                 # 1=攒批量 0=逐条下发
TP_BULK_CHAINS4=""; TP_BULK_CHAINS6=""    # 待声明（建链+清空）的链
TP_BULK_RULES4=""; TP_BULK_RULES6=""      # 待下发的规则行
TP_BULK_DEL=""                            # 已排队的 -D（同一条跳转只删一次）

# $1=iptables/ip6tables 路径 → stdout 打印同目录（或 PATH 里）的 *-restore
tp_restore_bin() {
  case "$1" in
    *ip6tables*) _trb_n=ip6tables-restore ;;
    *) _trb_n=iptables-restore ;;
  esac
  case "$1" in
    */*) [ -x "${1%/*}/$_trb_n" ] && { printf '%s\n' "${1%/*}/$_trb_n"; return 0; } ;;
  esac
  command -v "$_trb_n" 2>/dev/null
}


# --noflush 是批量下发的前提：没有它 iptables-restore 会先清空整张 mangle 表
# （别人的规则一并没了）。只在第一次用某个 restore 命令时问一次 --help 并缓存，
# 问不到就当作不支持、退回逐条 —— 宁慢不炸。
TP_BULK_OK_F=""
TP_BULK_OK_MEMO=""
tp_bulk_noflush_ok() {   # $1=restore 命令
  [ -n "$1" ] || return 1
  case " $TP_BULK_OK_MEMO " in *" $1 "*) return 0 ;; esac
  TP_BULK_OK_F=$RUNDIR/tproxy.bulk.ok
  if grep -qxF "$1" "$TP_BULK_OK_F" 2>/dev/null; then
    TP_BULK_OK_MEMO="$TP_BULK_OK_MEMO $1"
    return 0
  fi
  "$1" --help 2>&1 | grep -q -- '--noflush' || return 1
  printf '%s\n' "$1" >> "$TP_BULK_OK_F" 2>/dev/null
  TP_BULK_OK_MEMO="$TP_BULK_OK_MEMO $1"
  return 0
}

tp_bulk_begin() {
  TP_BULK=0
  TP_BULK_CHAINS4=""; TP_BULK_CHAINS6=""; TP_BULK_RULES4=""; TP_BULK_RULES6=""
  TP_BULK_DEL=""
  [ "${TP_BACKEND:-ipt}" = "ipt" ] || return 0
  _tbb_r4=""; _tbb_r6=""
  [ -n "$TP_IPT" ] && _tbb_r4=$(tp_restore_bin "$TP_IPT")
  [ -n "$_tbb_r4" ] || return 0
  if [ -n "$TP_IP6T" ]; then
    _tbb_r6=$(tp_restore_bin "$TP_IP6T")
    [ -n "$_tbb_r6" ] || return 0
  fi
  tp_bulk_noflush_ok "$_tbb_r4" || return 0
  [ -z "$_tbb_r6" ] || tp_bulk_noflush_ok "$_tbb_r6" || return 0
  TP_BULK=1
  return 0
}

# 建链 + 清空。批量模式只记账，逐条模式照旧两条命令。
tp_b_chain() {   # $1=bin $2=链
  if [ "$TP_BULK" = "1" ]; then
    case "$1" in
      *ip6tables*) TP_BULK_CHAINS6="$TP_BULK_CHAINS6 $2" ;;
      *) TP_BULK_CHAINS4="$TP_BULK_CHAINS4 $2" ;;
    esac
    return 0
  fi
  "$1" -w -t mangle -N "$2" 2>/dev/null
  "$1" -w -t mangle -F "$2" 2>/dev/null
  return 0
}

# -A：批量模式攒行，逐条模式真下发
tp_b_add() {   # $1=bin $2=链 其余=规则参数
  _tba_bin=$1; _tba_chain=$2; shift 2
  if [ "$TP_BULK" = "1" ]; then
    _tba_line="-A $_tba_chain"
    for _tba_a in "$@"; do _tba_line="$_tba_line $_tba_a"; done
    case "$_tba_bin" in
      *ip6tables*) TP_BULK_RULES6="$TP_BULK_RULES6$_tba_line
" ;;
      *) TP_BULK_RULES4="$TP_BULK_RULES4$_tba_line
" ;;
    esac
    return 0
  fi
  "$_tba_bin" -w -t mangle -A "$_tba_chain" "$@" 2>>"$TP_LOG"
}

# 排一条 -D（删跳转）。同一个事务里重复的 -D 会让整份 ruleset 被拒（第二次删
# 时规则已经不在了），所以按「链 + 规则」去重：v6 收尾和随后的挂载想删同一条
# 跳转时只留一条。
tp_b_del() {   # $1=bin $2=链 其余=规则参数
  _tbd_bin=$1; _tbd_chain=$2; shift 2
  _tbd_key="-D $_tbd_chain"
  for _tbd_a in "$@"; do _tbd_key="$_tbd_key $_tbd_a"; done
  case "$TP_BULK_DEL" in *"|$_tbd_key|"*) return 0 ;; esac
  TP_BULK_DEL="$TP_BULK_DEL|$_tbd_key|"
  case "$_tbd_bin" in
    *ip6tables*) TP_BULK_RULES6="$TP_BULK_RULES6$_tbd_key
" ;;
    *) TP_BULK_RULES4="$TP_BULK_RULES4$_tbd_key
" ;;
  esac
  return 0
}

# 挂跳转：唯一且在链首。已在位时把「删一条 + 插一条」写进同一个事务，
# 既保证顺序又不留空窗；逐条模式仍是原来「删到删不动再插」。
tp_b_jump() {   # $1=bin $2=内置链 其余=规则参数
  _tbj_bin=$1; _tbj_chain=$2; shift 2
  if [ "$TP_BULK" = "1" ]; then
    if "$_tbj_bin" -w -t mangle -C "$_tbj_chain" "$@" >/dev/null 2>&1; then
      tp_b_del "$_tbj_bin" "$_tbj_chain" "$@"
    fi
    _tbj_line="-I $_tbj_chain 1"
    for _tbj_a in "$@"; do _tbj_line="$_tbj_line $_tbj_a"; done
    case "$_tbj_bin" in
      *ip6tables*) TP_BULK_RULES6="$TP_BULK_RULES6$_tbj_line
" ;;
      *) TP_BULK_RULES4="$TP_BULK_RULES4$_tbj_line
" ;;
    esac
    return 0
  fi
  while "$_tbj_bin" -w -t mangle -D "$_tbj_chain" "$@" 2>/dev/null; do :; done
  "$_tbj_bin" -w -t mangle -I "$_tbj_chain" "$@" 2>>"$TP_LOG" || return 1
  return 0
}

# 摘跳转：批量模式下 -D 不存在的规则会让整个事务失败，所以先 -C 探一次。
tp_b_unhook() {   # $1=bin $2=内置链 其余=规则参数
  _tbu_bin=$1; _tbu_chain=$2; shift 2
  if [ "$TP_BULK" = "1" ]; then
    "$_tbu_bin" -w -t mangle -C "$_tbu_chain" "$@" >/dev/null 2>&1 || return 0
    tp_b_del "$_tbu_bin" "$_tbu_chain" "$@"
    return 0
  fi
  while "$_tbu_bin" -w -t mangle -D "$_tbu_chain" "$@" 2>/dev/null; do :; done
  return 0
}

# 提交一个家族的事务；非零 = 批量不可用/被拒，调用方须整体回退逐条
tp_b_commit() {   # $1=bin
  [ "$TP_BULK" = "1" ] || return 0
  [ -n "$1" ] || return 0
  case "$1" in
    *ip6tables*) _tbc_ch=$TP_BULK_CHAINS6; _tbc_rules=$TP_BULK_RULES6 ;;
    *) _tbc_ch=$TP_BULK_CHAINS4; _tbc_rules=$TP_BULK_RULES4 ;;
  esac
  [ -n "$_tbc_ch$_tbc_rules" ] || return 0
  _tbc_rb=$(tp_restore_bin "$1")
  [ -n "$_tbc_rb" ] || return 1
  _tbc_file=$RUNDIR/_tp_bulk.$$.rules
  {
    printf '*mangle\n'
    for _tbc_c in $_tbc_ch; do printf ':%s - [0:0]\n' "$_tbc_c"; done
    printf '%s' "$_tbc_rules"
    printf 'COMMIT\n'
  } > "$_tbc_file" 2>/dev/null || { rm -f "$_tbc_file" 2>/dev/null; return 1; }
  "$_tbc_rb" -w --noflush "$_tbc_file" 2>>"$TP_LOG"
  _tbc_rc=$?
  if [ "$_tbc_rc" != "0" ]; then
    cp "$_tbc_file" "$RUNDIR/tproxy.bulk.reject" 2>/dev/null
    tp_log "WARN 批量下发被拒（rc=$_tbc_rc），改逐条下发；现场见 run/tproxy.bulk.reject"
  fi
  rm -f "$_tbc_file" 2>/dev/null
  return "$_tbc_rc"
}

tproxy_install() {
  # $1=port $2=v6(on|off) $3=bypass(gid|uid) $4=mode(all|include|exclude，默认 all)
  # $5=UID 列表（空格分隔，可为空）。另读全局：_ti_want（期望名单）_ti_fp（指纹）
  # _ti_fb（1=降级为全部代理）_ti_apps（名单包数）。前置：tproxy_probe 已通过
  _ti_port=$1; _ti_v6=$2; _ti_bp=$3; _ti_mode=${4:-all}; _ti_uids=$5
  _ti_want=${_ti_want:-$_ti_mode}; _ti_fp=${_ti_fp:-none}; _ti_fb=${_ti_fb:-0}
  case "$_ti_port" in ''|*[!0-9]*) tp_log "WARN install 拒绝：端口非法 [$_ti_port]"; return 1 ;; esac
  # 后端共用此安全检查：iptables Tproxy 也可能被独立 nft inet mihomo 表覆盖。
  if ! tproxy_nft_clear_stale_mihomo_redirect; then
    tp_log "WARN 活动或状态未知的 inet mihomo redirect 与 TPROXY 冲突，安装已中止（backend=${TP_BACKEND:-unknown}）"
    tproxy_teardown
    return 1
  fi
  echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null    # 热点/USB 共享的转发流量也要进 TPROXY
  # —— 策略路由：带 mark 的包一律判为本机（经 lo 回注 PREROUTING 后由 TPROXY 接管）——
  # 半途失败一律整体回滚：只挂了 iptables 而没有策略路由时，包被 TPROXY 收走
  # 却回注不到内核，表现就是整机断网——宁可全拆（流量直连）也不能留半成品。
  _ti_pref=$(tproxy_iprule_add "$TP_IP" "$TP_PREF $TP_PREF_ALT")
  if [ -z "$_ti_pref" ]; then
    tp_log "WARN ip rule 添加失败（优先级全被占用）"
    tproxy_teardown
    return 1
  fi
  if ! $TP_IP route replace local default dev lo table "$TP_TABLE" 2>>"$TP_LOG"; then
    tp_log "WARN ip route 添加失败"
    tproxy_teardown
    return 1
  fi
  # —— nftables 后端（OpenWrt fw4）：一份 ruleset 原子替换独立表 ——
  if [ "$TP_BACKEND" = "nft" ]; then
    _ti_v6_ok=off
    _ti_f6=$(tproxy_fakeip6_range)
    case "$_ti_f6" in *[!0-9A-Fa-f:/]*|'') _ti_v6=off ;; esac
    if [ "$_ti_v6" = "on" ] && [ "$_tp_cap_v6" = "1" ]; then
      _ti_v6pref=$(tproxy_iprule_add "$TP_IP" "$TP_PREF $TP_PREF_ALT" -6)
      if [ -n "$_ti_v6pref" ] && $TP_IP -6 route replace local "$_ti_f6" dev lo table "$TP_TABLE" 2>>"$TP_LOG"; then
        _ti_v6_ok=on
      else
        tproxy_nft_clear_v6_routes
        tp_log "WARN v6 fake-ip 策略路由不完整，本机 v6 仍走原生"
      fi
    fi
    _ti_total=$(printf '%s' "$_ti_uids" | wc -w 2>/dev/null)
    if [ "${_ti_total:-0}" -gt "$TP_APP_MAX" ] 2>/dev/null; then
      tp_log "WARN 应用名单过大（UID $_ti_total 个），仅前 $TP_APP_MAX 个生效"
    fi
    _tn_ok=0
    if tproxy_nft_write "$TP_NFT_FILE" "$_ti_f6" && tproxy_nft_apply; then
      _tn_ok=1
    elif [ "$_ti_v6_ok" = "on" ]; then
      tp_log "WARN nft v6 fake-ip 规则不完整，回退为纯 IPv4 TProxy"
      _ti_v6_ok=off
      tproxy_nft_clear_v6_routes
      if tproxy_nft_write "$TP_NFT_FILE" "$_ti_f6" && tproxy_nft_apply; then
        _tn_ok=1
      fi
    fi
    if [ "$_tn_ok" != "1" ]; then
      tp_log "WARN nftables TProxy 规则应用失败"
      tproxy_teardown
      return 1
    fi
    _ti_v4n=$_ti_applied
    _ti_uh=$(printf '%s' "$_ti_uids" | tp_fp_of)
    printf 'port=%s\nv6=%s\nbypass=%s\nmode=%s\nwant=%s\nfp=%s\nfb=%s\napps=%s\nuids=%s\nuh=%s\npref=%s\nver=%s\nbackend=%s\n' \
      "$_ti_port" "$_ti_v6_ok" "$_ti_bp" "$_ti_mode" "$_ti_want" "$_ti_fp" "$_ti_fb" "${_ti_apps:-0}" "${_ti_v4n:-0}" "$_ti_uh" "$_ti_pref" "$TP_STATE_VER" "nft" > "$TP_STATE" 2>/dev/null
    rm -f "$RUNDIR/tproxy.fail" "$TP_MISS" 2>/dev/null
    tp_log "install backend=nft port=$_ti_port v6=$_ti_v6_ok bypass=$_ti_bp mode=$_ti_mode want=$_ti_want fb=$_ti_fb uids=${_ti_v4n:-0} table=$TP_TABLE pref=$_ti_pref"
    ( boot_data_sync ) >/dev/null 2>&1 &
    return 0
  fi
  # —— iptables 后端：整份规则一个事务下发；确认不支持/被拒则整套逐条重来 ——
  # 逐条下发一次要几十次 fork（手机上单次几十毫秒），批量把「切到 Tproxy 之后
  # 的生效等待」从数秒压到一次事务的时间。
  tp_bulk_begin
  _tproxy_install_ipt
  _ti_rc=$?
  if [ "$_ti_rc" = "2" ]; then
    TP_BULK=0
    _tproxy_install_ipt
    _ti_rc=$?
  fi
  return "$_ti_rc"
}

# iptables 后端的实际下发（v4 + v6）。$TP_BULK=1 时规则只是攒起来，最后交给
# 一个 iptables-restore 事务；返回 2 表示「批量被拒，请逐条重来」。
_tproxy_install_ipt() {
  # —— v4 mangle 链（先建链清链，再挂跳转，全程幂等）——
  tp_b_chain "$TP_IPT" "$TP_CHAIN_DIV"
  tp_b_add "$TP_IPT" "$TP_CHAIN_DIV" -j MARK --set-xmark "$TP_MARK"
  tp_b_add "$TP_IPT" "$TP_CHAIN_DIV" -j ACCEPT

  tp_b_chain "$TP_IPT" "$TP_CHAIN_PRE"
  # 已建连的 tproxy socket 走快速通道（内核不支持 socket 匹配时跳过，
  # xt_TPROXY 自身也能续接已建连接，divert 只是省一次查找）
  if [ "$_tp_cap_sockt" = "1" ]; then
    tp_b_add "$TP_IPT" "$TP_CHAIN_PRE" -p tcp -m socket --transparent -j "$TP_CHAIN_DIV" 2>/dev/null
    tp_b_add "$TP_IPT" "$TP_CHAIN_PRE" -p udp -m socket --transparent -j "$TP_CHAIN_DIV" 2>/dev/null
  elif [ "$_tp_cap_sock" = "1" ]; then
    tp_b_add "$TP_IPT" "$TP_CHAIN_PRE" -p tcp -m socket -j "$TP_CHAIN_DIV" 2>/dev/null
    tp_b_add "$TP_IPT" "$TP_CHAIN_PRE" -p udp -m socket -j "$TP_CHAIN_DIV" 2>/dev/null
  fi
  # 保留/内网/组播地址直连（fake-ip 198.18.0.0/16 是基准测试段，不在其中，
  # 会被正常接管——这正是 fake-ip 链路需要的）
  for _ti_c in 0.0.0.0/8 10.0.0.0/8 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
    tp_b_add "$TP_IPT" "$TP_CHAIN_PRE" -d "$_ti_c" -j RETURN
  done
  tp_b_add "$TP_IPT" "$TP_CHAIN_PRE" -p tcp -j TPROXY --on-ip 127.0.0.1 --on-port "$_ti_port" --tproxy-mark "$TP_MARK" 2>>"$TP_LOG" || { tp_log "WARN TPROXY(tcp) 添加失败"; tproxy_teardown; return 1; }
  tp_b_add "$TP_IPT" "$TP_CHAIN_PRE" -p udp -j TPROXY --on-ip 127.0.0.1 --on-port "$_ti_port" --tproxy-mark "$TP_MARK" 2>>"$TP_LOG" || { tp_log "WARN TPROXY(udp) 添加失败"; tproxy_teardown; return 1; }

  tp_b_chain "$TP_IPT" "$TP_CHAIN_OUT"
  tp_bypass_rule "$TP_IPT" "$TP_CHAIN_OUT" "$_ti_bp" || { tp_log "WARN owner 旁路添加失败"; tproxy_teardown; return 1; }
  # 应用黑白名单（UID 规则插在内核旁路之后、网段直连之前；白名单默认尾巴是直连）
  _ti_app_rules "$TP_IPT" "$TP_CHAIN_OUT" || { tp_log "WARN 应用 UID 规则添加失败"; tproxy_teardown; return 1; }
  _ti_v4n=$_ti_applied
  _ti_total=$(printf '%s' "$_ti_uids" | wc -w 2>/dev/null)
  if [ "${_ti_total:-0}" -gt "$TP_APP_MAX" ] 2>/dev/null; then
    tp_log "WARN 应用名单过大（UID $_ti_total 个），仅前 $TP_APP_MAX 个生效"
  fi
  for _ti_c in 0.0.0.0/8 10.0.0.0/8 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
    tp_b_add "$TP_IPT" "$TP_CHAIN_OUT" -d "$_ti_c" -j RETURN
  done
  if [ "$_ti_mode" = "include" ]; then
    tp_b_add "$TP_IPT" "$TP_CHAIN_OUT" -p tcp -j RETURN
    tp_b_add "$TP_IPT" "$TP_CHAIN_OUT" -p udp -j RETURN
  else
    tp_b_add "$TP_IPT" "$TP_CHAIN_OUT" -p tcp -j MARK --set-xmark "$TP_MARK"
    tp_b_add "$TP_IPT" "$TP_CHAIN_OUT" -p udp -j MARK --set-xmark "$TP_MARK"
  fi

  # 挂载（先删干净再插链首；PREROUTING 同时覆盖 lo 回注与热点转发流量）
  tp_b_jump "$TP_IPT" PREROUTING -j "$TP_CHAIN_PRE" || { tp_log "WARN PREROUTING 挂载失败"; tproxy_teardown; return 1; }
  tp_b_jump "$TP_IPT" OUTPUT -p tcp -j "$TP_CHAIN_OUT" || { tp_log "WARN OUTPUT(tcp) 挂载失败"; tproxy_teardown; return 1; }
  tp_b_jump "$TP_IPT" OUTPUT -p udp -j "$TP_CHAIN_OUT" || { tp_log "WARN OUTPUT(udp) 挂载失败"; tproxy_teardown; return 1; }

  # —— v6：真 GUA 原生；只把 DNS fake-ip6 送进 TPROXY（对齐 IPv4 的 198.18.0.0/16）。
  # 禁止 local default + 全量 OUTPUT mark，否则系统测不到 240e: 地址。
  if [ "$TP_BULK" = "1" ]; then
    # 批量模式：v6 跳转先探再删（写进同一个 v6 事务），链由随后的声明清空，
    # 不必再来一遍「删到删不动」。没有 v6 记录又这次也不装 v6 时连探测都省掉
    # （稳态一次安装少三次 fork）；状态文件缺失或记着 v6=on 就照常全套清理。
    _tp_prev_v6=""
    if [ -f "$TP_STATE" ]; then
      while IFS= read -r _pv_l; do
        case "$_pv_l" in v6=on) _tp_prev_v6=on ;; v6=off) _tp_prev_v6=off ;; esac
      done < "$TP_STATE"
    fi
    # 只有「v6 曾经装着、这次不装了」或「状态未知」才需要清理：v6 继续装着时
    # 跳转会被随后的挂载原地替换、策略路由原样复用，多探一次只是白花时间。
    _tp_v6_clean=0
    [ -z "$_tp_prev_v6" ] && _tp_v6_clean=1
    [ "$_tp_prev_v6" = "on" ] && [ "$_ti_v6" != "on" ] && _tp_v6_clean=1
    if [ "$_tp_v6_clean" = "1" ]; then
      [ -n "$TP_IP6T" ] && {
        tp_b_unhook "$TP_IP6T" PREROUTING -j "$TP_CHAIN_PRE"
        tp_b_unhook "$TP_IP6T" OUTPUT -p tcp -j "$TP_CHAIN_OUT"
        tp_b_unhook "$TP_IP6T" OUTPUT -p udp -j "$TP_CHAIN_OUT"
      }
      [ "$_tp_prev_v6" = "on" ] && tproxy_v6_unhook_routes
    fi
  else
    tproxy_v6_unhook
  fi
  _ti_v6_ok=off
  if [ "$_ti_v6" = "on" ] && [ "$_tp_cap_v6" = "1" ] && [ -n "$TP_IP6T" ]; then
    _ti_v6ok=1
    _ti_f6=$(tproxy_fakeip6_range)
    _ti_v6pref=$(tproxy_iprule_add "$TP_IP" "$TP_PREF $TP_PREF_ALT" -6)
    [ -n "$_ti_v6pref" ] || _ti_v6ok=0
    $TP_IP -6 route replace local "$_ti_f6" dev lo table "$TP_TABLE" 2>>"$TP_LOG" || _ti_v6ok=0
    tp_b_chain "$TP_IP6T" "$TP_CHAIN_PRE"
    _ti_v6_nd_bypass "$TP_IP6T" "$TP_CHAIN_PRE"
    _ti_v6_local_return "$TP_IP6T" "$TP_CHAIN_PRE"
    # fake-ip 必须在 fc00::/7 RETURN 之前 TPROXY，否则 AAAA 假地址被放行出真实网卡。
    tp_b_add "$TP_IP6T" "$TP_CHAIN_PRE" -d "$_ti_f6" -p tcp -j TPROXY --on-ip :: --on-port "$_ti_port" --tproxy-mark "$TP_MARK" 2>>"$TP_LOG" || _ti_v6ok=0
    tp_b_add "$TP_IP6T" "$TP_CHAIN_PRE" -d "$_ti_f6" -p udp -j TPROXY --on-ip :: --on-port "$_ti_port" --tproxy-mark "$TP_MARK" 2>>"$TP_LOG" || _ti_v6ok=0
    for _ti_c in ::/128 ::1/128 fc00::/7 fe80::/10 ff00::/8; do
      tp_b_add "$TP_IP6T" "$TP_CHAIN_PRE" -d "$_ti_c" -j RETURN
    done
    tp_b_chain "$TP_IP6T" "$TP_CHAIN_OUT"
    _ti_v6_nd_bypass "$TP_IP6T" "$TP_CHAIN_OUT"
    tp_bypass_rule "$TP_IP6T" "$TP_CHAIN_OUT" "$_ti_bp" || _ti_v6ok=0
    tp_b_add "$TP_IP6T" "$TP_CHAIN_OUT" -d "$_ti_f6" -p tcp -j MARK --set-xmark "$TP_MARK" 2>>"$TP_LOG" || _ti_v6ok=0
    tp_b_add "$TP_IP6T" "$TP_CHAIN_OUT" -d "$_ti_f6" -p udp -j MARK --set-xmark "$TP_MARK" 2>>"$TP_LOG" || _ti_v6ok=0
    tp_b_jump "$TP_IP6T" PREROUTING -j "$TP_CHAIN_PRE" || _ti_v6ok=0
    tp_b_jump "$TP_IP6T" OUTPUT -p tcp -j "$TP_CHAIN_OUT" || _ti_v6ok=0
    tp_b_jump "$TP_IP6T" OUTPUT -p udp -j "$TP_CHAIN_OUT" || _ti_v6ok=0
    if [ "$_ti_v6ok" = "1" ]; then
      _ti_v6_ok=on
      tp_log "v6 fake-ip $_ti_f6 → TPROXY，其余 IPv6 原生"
    else
      if [ "$TP_BULK" = "1" ]; then
        # 事务还没下发：把 v6 待发规则整体丢掉就等于「没装 v6」，只保留 -D 行
        # （那是为了摘掉上一次的 v6 跳转，必须留着）。
        _tb_keep=""
        while IFS= read -r _tb_l; do
          case "$_tb_l" in -D\ *) _tb_keep="$_tb_keep$_tb_l
" ;; esac
        done <<EOF
$TP_BULK_RULES6
EOF
        TP_BULK_RULES6="$_tb_keep"
        TP_BULK_CHAINS6=""
      else
        tproxy_v6_unhook
      fi
      tp_log "WARN v6 fake-ip 规则不完整，本机 v6 仍走原生"
    fi
  fi
  # 一个家族一个事务提交；被拒（老 iptables-restore / 精简环境）就整体逐条重来
  tp_b_commit "$TP_IPT" || return 2
  [ -n "$TP_IP6T" ] && { tp_b_commit "$TP_IP6T" || return 2; }
  _ti_uh=$(printf '%s' "$_ti_uids" | tp_fp_of)
  printf 'port=%s\nv6=%s\nbypass=%s\nmode=%s\nwant=%s\nfp=%s\nfb=%s\napps=%s\nuids=%s\nuh=%s\npref=%s\nver=%s\nbackend=%s\n' \
    "$_ti_port" "$_ti_v6_ok" "$_ti_bp" "$_ti_mode" "$_ti_want" "$_ti_fp" "$_ti_fb" "${_ti_apps:-0}" "${_ti_v4n:-0}" "$_ti_uh" "$_ti_pref" "$TP_STATE_VER" "ipt" > "$TP_STATE" 2>/dev/null
  rm -f "$RUNDIR/tproxy.fail" "$TP_MISS" 2>/dev/null
  tp_log "install backend=ipt port=$_ti_port v6=$_ti_v6_ok bypass=$_ti_bp mode=$_ti_mode want=$_ti_want fb=$_ti_fb uids=${_ti_v4n:-0} table=$TP_TABLE pref=$_ti_pref"
  ( boot_data_sync ) >/dev/null 2>&1 &
  return 0
}

# 停止路径专用「摘跳转」：只删把系统流量引入 TPROXY 链的 mangle PREROUTING/
# OUTPUT 跳转（v4+v6）。内核已死时它们是唯一仍会把流量导向死端口的规则——
# 摘掉后链不可达、fwmark 策略路由无人打标记，自动失活，网络立刻恢复。
# 其余清理（链删除、ip rule、路由表、状态文件）无流量影响，交给随后的
# 后台全量对账。这里 6 条「删到没有」循环，亚秒级，专为总开关返回提速。
tproxy_unhook_quick() {
  tp_setup_bins
  tproxy_nft_delete
  [ -n "$TUNHS_IPT" ] && {
    while $TUNHS_IPT -w -t mangle -D PREROUTING -j "$TP_CHAIN_PRE" 2>/dev/null; do :; done
    while $TUNHS_IPT -w -t mangle -D OUTPUT -p tcp -j "$TP_CHAIN_OUT" 2>/dev/null; do :; done
    while $TUNHS_IPT -w -t mangle -D OUTPUT -p udp -j "$TP_CHAIN_OUT" 2>/dev/null; do :; done
  }
  [ -n "$TUNHS_IP6T" ] && {
    while $TUNHS_IP6T -w -t mangle -D PREROUTING -j "$TP_CHAIN_PRE" 2>/dev/null; do :; done
    while $TUNHS_IP6T -w -t mangle -D OUTPUT -p tcp -j "$TP_CHAIN_OUT" 2>/dev/null; do :; done
    while $TUNHS_IP6T -w -t mangle -D OUTPUT -p udp -j "$TP_CHAIN_OUT" 2>/dev/null; do :; done
  }
  return 0
}

# 全量拆除（v4+v6 一律清，幂等：删不存在的规则返回非零即止）。
# 顺序：先摘内置链跳转，再清链删链（链被引用时 -X 会失败）。
tproxy_teardown() {
  tp_setup_bins
  tproxy_nft_delete
  if [ -n "$TP_IPT" ]; then
    while $TP_IPT -w -t mangle -D PREROUTING -j "$TP_CHAIN_PRE" 2>/dev/null; do :; done
    while $TP_IPT -w -t mangle -D OUTPUT -p tcp -j "$TP_CHAIN_OUT" 2>/dev/null; do :; done
    while $TP_IPT -w -t mangle -D OUTPUT -p udp -j "$TP_CHAIN_OUT" 2>/dev/null; do :; done
    for _tt_c in "$TP_CHAIN_PRE" "$TP_CHAIN_OUT" "$TP_CHAIN_DIV"; do
      $TP_IPT -w -t mangle -F "$_tt_c" 2>/dev/null
      $TP_IPT -w -t mangle -X "$_tt_c" 2>/dev/null
    done
  fi
  if [ -n "$TP_IP6T" ]; then
    while $TP_IP6T -w -t mangle -D PREROUTING -j "$TP_CHAIN_PRE" 2>/dev/null; do :; done
    while $TP_IP6T -w -t mangle -D OUTPUT -p tcp -j "$TP_CHAIN_OUT" 2>/dev/null; do :; done
    while $TP_IP6T -w -t mangle -D OUTPUT -p udp -j "$TP_CHAIN_OUT" 2>/dev/null; do :; done
    for _tt_c in "$TP_CHAIN_PRE" "$TP_CHAIN_OUT" "$TP_CHAIN_DIV"; do
      $TP_IP6T -w -t mangle -F "$_tt_c" 2>/dev/null
      $TP_IP6T -w -t mangle -X "$_tt_c" 2>/dev/null
    done
  fi
  if [ -n "$TP_IP" ]; then
    # 按实际用过的优先级回收（可能顺延到了备位），主优先级和全部备位都清一遍，
    # 避免残留的 fwmark 规则把本机流量继续往 TPROXY 送
    _tt_p=$(grep '^pref=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    for _tt_c in $_tt_p "$TP_PREF" $TP_PREF_ALT; do
      case "$_tt_c" in ''|*[!0-9]*) continue ;; esac
      tproxy_iprule_clear "$TP_IP" "$_tt_c"
      tproxy_iprule_clear "$TP_IP" "$_tt_c" -6
    done
    $TP_IP route flush table "$TP_TABLE" 2>/dev/null
    $TP_IP -6 route flush table "$TP_TABLE" 2>/dev/null
  fi
  rm -f "$TP_STATE" "$RUNDIR/tproxy.fail" "$TP_MISS"
  ( boot_data_sync ) >/dev/null 2>&1 &
  return 0
}

# 残留检测：状态文件丢失但规则还在（异常重启/手动清过 run/）。
tproxy_stale_present() {
  tp_setup_bins
  if tp_nft_table_present; then return 0; fi
  if [ -n "$TP_IPT" ]; then
    $TP_IPT -w -t mangle -C PREROUTING -j "$TP_CHAIN_PRE" 2>/dev/null && return 0
    $TP_IPT -w -t mangle -C OUTPUT -p tcp -j "$TP_CHAIN_OUT" 2>/dev/null && return 0
  fi
  [ -n "$TP_IP" ] || return 1
  # 覆盖全部候选优先级：规则可能顺延到了备位（主位被别的程序占用时）
  for _ts_p in $TP_PREF $TP_PREF_ALT; do
    tproxy_iprule_ours "$TP_IP" "$_ts_p" && return 0
  done
  return 1
}

# 锁龄/陈旧判定（与 tunhs_lock_* 同语义，路径换 TP_LOCK）
tproxy_lock_age() {
  _la_now=$(date +%s 2>/dev/null)
  _la_mt=$(stat -c %Y "$TP_LOCK" 2>/dev/null || "$BUSYBOX" stat -c %Y "$TP_LOCK" 2>/dev/null)
  case "$_la_now" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  case "$_la_mt" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  _la_a=$((_la_now - _la_mt))
  [ "$_la_a" -lt 0 ] && _la_a=0
  echo "$_la_a"
}

tproxy_lock_stale() {
  _tk_pid=$(cat "$TP_LOCK/pid" 2>/dev/null)
  case "$_tk_pid" in ''|*[!0-9]*) _tk_pid=0 ;; esac
  _tk_age=$(tproxy_lock_age)
  if [ "$_tk_pid" -gt 0 ]; then
    kill -0 "$_tk_pid" 2>/dev/null && [ "$_tk_age" -lt 60 ] && return 1
  else
    [ "$_tk_age" -lt 10 ] && return 1
  fi
  return 0
}

_tproxy_sync_body() {
  tp_setup_bins
  # —— 已应用态（mode=实际生效名单，swant=安装时期望名单，fp=名单指纹，fb=降级标记）——
  _ps_have=0; _ps_port=""; _ps_v6=off; _ps_bp=uid; _ps_ver=0; _ps_backend=ipt; _ps_wbackend=$TP_BACKEND
  _ps_mode=all; _ps_swant=all; _ps_fp=all; _ps_fb=0; _ps_uids=0; _ps_uh=""
  if [ -f "$TP_STATE" ]; then
    _ps_have=1
    _ps_port=$(grep '^port=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    grep -q '^v6=on' "$TP_STATE" 2>/dev/null && _ps_v6=on
    _ps_bp=$(grep '^bypass=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    _ps_ver=$(grep '^ver=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    _ps_mode=$(grep '^mode=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    _ps_swant=$(grep '^want=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    _ps_fp=$(grep '^fp=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    _ps_fb=$(grep '^fb=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    _ps_uids=$(grep '^uids=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    _ps_uh=$(grep '^uh=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    _ps_backend=$(grep '^backend=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    case "$_ps_backend" in nft|ipt) ;; *) _ps_backend=ipt ;; esac
    case "$_ps_mode" in include|exclude) ;; *) _ps_mode=all ;; esac
    case "$_ps_swant" in include|exclude) ;; *) _ps_swant=all ;; esac
    [ -n "$_ps_fp" ] || _ps_fp=all
    case "$_ps_fb" in 1) ;; *) _ps_fb=0 ;; esac
    case "$_ps_uids" in ''|*[!0-9]*) _ps_uids=0 ;; esac
  fi
  # —— 期望态 ——
  _ps_want=0; _ps_wport=""; _ps_wv6=off; _ps_wbp=uid
  _ps_wmode=all; _ps_wfp=all; _ps_wcnt=0
  _ps_core_up=0          # 内核进程是否在跑（与「端口是否就绪」分开看）
  if [ "$(get_setting tproxy false)" = "true" ] && running; then
    _ps_core_up=1
    _ps_det=$(tproxy_detect)
    _ps_wport=$(printf '%s\n' "$_ps_det" | awk '{print $1}')
    _ps_src=$(printf '%s\n' "$_ps_det" | awk '{print $2}')
    _ps_lsn=$(printf '%s\n' "$_ps_det" | awk '{print $3}')
    if [ -n "$_ps_wport" ] && tproxy_port_listening "$_ps_wport"; then
      # 内核实际运行身份决定旁路方式：gid=3005（setuidgid 拉起）→ 精确旁路；
      # 否则 uid 0 兜底（root 进程全部直连）
      _ps_g=$(awk '/^Gid:/{print $2; exit}' "/proc/$(pid_of)/status" 2>/dev/null)
      if [ "$_ps_g" = "$TP_CORE_GID" ]; then _ps_wbp=gid; else _ps_wbp=uid; fi
      tproxy_v6_want "$_ps_src" "$_ps_lsn" && _ps_wv6=on
      # 应用名单期望（只读配置算指纹，不查包管理器，稳态零开销）
      _ps_spec=$(tproxy_app_spec)
      _ps_wmode=$(printf '%s\n' "$_ps_spec" | awk '{print $1}')
      _ps_wcnt=$(printf '%s\n' "$_ps_spec" | awk '{print $2}')
      _ps_wfp=$(printf '%s\n' "$_ps_spec" | awk '{print $3}')
      case "$_ps_wmode" in include|exclude) ;; *) _ps_wmode=all; _ps_wfp=all; _ps_wcnt=0 ;; esac
      case "$_ps_wcnt" in ''|*[!0-9]*) _ps_wcnt=0 ;; esac
      _ps_want=1
    fi
  fi
  [ "$_ps_want" = "1" ] && rm -f "$TP_MISS" 2>/dev/null
  # 内核在跑、开关也开着，只是这一轮没探到端口（内核热重载配置 / 重启的窗口
  # 期，端口会短暂消失）：已装好的规则先留着。以前这里直接判 want=0 把规则拆
  # 掉，拆到重装之间那几秒流量完全绕过内核直连——这就是日志里
  # 「teardown → 数秒后 install」反复出现、以及用户观察到「流量全走直连」的成因。
  if [ "$_ps_want" != "1" ] && [ "$_ps_core_up" = "1" ] && [ "$_ps_have" = "1" ]; then
    _ps_miss=$(cat "$TP_MISS" 2>/dev/null)
    case "$_ps_miss" in ''|*[!0-9]*) _ps_miss=0 ;; esac
    _ps_miss=$((_ps_miss + 1))
    echo "$_ps_miss" > "$TP_MISS" 2>/dev/null
    if [ "$_ps_miss" -le "$TP_GRACE" ]; then
      tp_log "grace: 端口暂未就绪 ${_ps_miss}/${TP_GRACE}，保留已装规则 port=${_ps_port:-?}"
      return 0
    fi
    tp_log "grace: 连续 ${_ps_miss} 次未就绪（>${TP_GRACE}），按未就绪处理"
    rm -f "$TP_MISS" 2>/dev/null
  fi
  # —— 稳态早退：期望与已应用一致且参数未变（含名单指纹；版本号对不上就重装，
  # 旧版 ver=1 状态天然迁移）——
  if [ "$_ps_want" = "1" ] && [ "$_ps_have" = "1" ] && [ "$_ps_ver" = "$TP_STATE_VER" ] \
     && [ "$_ps_wbackend" = "$_ps_backend" ] \
     && [ "$_ps_wport" = "$_ps_port" ] && [ "$_ps_wv6" = "$_ps_v6" ] && [ "$_ps_wbp" = "$_ps_bp" ] \
     && [ "$_ps_wmode" = "$_ps_swant" ] && [ "$_ps_wfp" = "$_ps_fp" ]; then
    # 名单模式定期重解析 UID：应用重装/升级会换 UID，包管理器抖动或名单未解析的
    # 降级态也靠它恢复。UID 无变化则静默 touch 状态文件顺延窗口（稳态零日志）。
    _ps_refresh=0
    if [ "$_ps_wmode" != "all" ] && [ "$(tproxy_state_age)" -ge "$TP_UID_REFRESH" ]; then
      if tproxy_prepare_uids; then
        _ps_newuh=$(printf '%s' "$_PU_UIDS" | tp_fp_of)
        if [ "$_ps_newuh" != "$_ps_uh" ] || [ "${_PU_FB:-0}" != "$_ps_fb" ]; then
          _ps_refresh=1
        else
          touch "$TP_STATE" 2>/dev/null
        fi
      else
        tp_log "UID 重解析：包管理器暂不可用，保留已装规则（${TP_UID_REFRESH} 秒后重试）"
        touch "$TP_STATE" 2>/dev/null
      fi
    fi
    if [ "$_ps_refresh" = "1" ]; then
      tp_log "UID 变化，重装规则 mode=$_ps_wmode"
      tproxy_probe >/dev/null 2>&1 || return 1
      tproxy_log_resolve 0
      _ps_eff=$_ps_wmode; [ "${_PU_FB:-0}" = "1" ] && _ps_eff=all
      _ti_want=$_ps_wmode; _ti_fp=$_ps_wfp; _ti_fb=${_PU_FB:-0}; _ti_apps=$_ps_wcnt
      tproxy_install "$_ps_port" "$_ps_v6" "$_ps_bp" "$_ps_eff" "$_PU_UIDS"
      return $?
    fi
    # 稳态抽查：接管规则被外部删除时自愈重装（install 全幂等）
    [ -n "$_SW_QUICK" ] && return 0   # 快轮跳过抽查（查规则有开销），全量轮再验
    if tproxy_hook_present; then
      return 0
    fi
    tp_log "heal-reinstall: 规则缺失，原参数重装 port=$_ps_port mode=$_ps_wmode"
    tproxy_probe >/dev/null 2>&1 || return 1
    # 名单模式需重解析 UID（状态文件只存指纹不存 UID 列表）；包管理器暂不可用
    # 则中止自愈保留现场（跳转缺失比名单错配更严重的问题下次对账继续尝试）
    _PU_UIDS=""; _PU_FB=0
    if [ "$_ps_wmode" != "all" ]; then
      if ! tproxy_prepare_uids; then
        tp_log "WARN heal 中止：包管理器暂不可用，保留已装规则"
        return 1
      fi
      tproxy_log_resolve 0
    fi
    _ps_eff=$_ps_wmode; [ "${_PU_FB:-0}" = "1" ] && _ps_eff=all
    _ti_want=$_ps_wmode; _ti_fp=$_ps_wfp; _ti_fb=${_PU_FB:-0}; _ti_apps=$_ps_wcnt
    tproxy_install "$_ps_port" "$_ps_v6" "$_ps_bp" "$_ps_eff" "$_PU_UIDS"
    return $?
  fi
  # —— 参数变了、后端没变：原地重建，不「先拆后装」 ——
  # install 会用一个事务把自己的三条链原子地换成新参数，跳转留在原处；先拆再装
  # 的话，拆与装之间那几百毫秒到几秒里流量完全绕过内核（面板打不开、直连没网），
  # 正是「切到 Tproxy 之后卡一阵」的另一半原因。
  if [ "$_ps_have" = "1" ] && [ "$_ps_want" = "1" ] && [ "$_ps_backend" = "$_ps_wbackend" ]; then
    tp_log "reinstall-in-place: port=${_ps_port:-?}→${_ps_wport:-?} v6=$_ps_v6→$_ps_wv6 mode=${_ps_mode:-all}→$_ps_wmode（不拆链）"
    _ps_have=0
  fi
  # —— 拆旧 ——
  if [ "$_ps_have" = "1" ]; then
    tproxy_teardown
    tp_log "teardown port=${_ps_port:-?} v6=$_ps_v6 bypass=$_ps_bp mode=${_ps_mode:-all} (want=$_ps_want port=${_ps_wport:-?} v6=$_ps_wv6 bypass=$_ps_wbp wmode=$_ps_wmode)"
  fi
  # —— 期望无规则：确认无残留再返回（异常重启/手动清过 run/ 都可能留下规则而状态已丢）——
  [ "$_ps_want" = "1" ] || {
    if [ -z "$_SW_QUICK" ] && tproxy_stale_present; then
      tp_log "heal: 清除无状态残留的 tproxy 规则"
      tproxy_teardown
    fi
    return 0
  }
  # —— 装新（探测失败节流留痕，避免 5 秒对账刷屏）——
  if ! tproxy_probe >/dev/null 2>&1; then
    _ps_pf=$(cat "$RUNDIR/tproxy.fail" 2>/dev/null)
    case "$_ps_pf" in ''|*[!0-9]*) _ps_pf=0 ;; esac
    _ps_pf=$((_ps_pf + 1))
    echo "$_ps_pf" > "$RUNDIR/tproxy.fail" 2>/dev/null
    if [ "$_ps_pf" -eq 1 ] || [ $((_ps_pf % 12)) -eq 0 ]; then
      tp_log "WARN 能力探测失败 #$_ps_pf（tproxy=$_tp_cap_tproxy gid=$_tp_cap_gid uid=$_tp_cap_uid），规则未安装"
    fi
    return 1
  fi
  # 名单模式解析 UID（包管理器不可用 → 降级为全部代理并记日志，靠 UID 重解析恢复）
  _PU_UIDS=""; _PU_FB=0
  if [ "$_ps_wmode" != "all" ]; then
    if tproxy_prepare_uids; then
      tproxy_log_resolve 0
    else
      _PU_UIDS=""; _PU_FB=1
      tproxy_log_resolve 1
    fi
  fi
  _ps_eff=$_ps_wmode; [ "${_PU_FB:-0}" = "1" ] && _ps_eff=all
  _ti_want=$_ps_wmode; _ti_fp=$_ps_wfp; _ti_fb=${_PU_FB:-0}; _ti_apps=$_ps_wcnt
  tproxy_install "$_ps_wport" "$_ps_wv6" "$_ps_wbp" "$_ps_eff" "$_PU_UIDS"
}

# 对账入口：加互斥锁后转 _tproxy_sync_body（锁语义同 tun_hotspot_sync）
tproxy_sync() {
  _tp_i=0
  while ! mkdir "$TP_LOCK" 2>/dev/null; do
    _tp_i=$((_tp_i + 1))
    [ "$_tp_i" -gt 9 ] && return 0
    if tproxy_lock_stale; then
      tp_log "lock: 回收陈旧锁 pid=$(cat "$TP_LOCK/pid" 2>/dev/null)"
      rm -rf "$TP_LOCK" 2>/dev/null
      continue
    fi
    [ "$_tp_i" -ge 5 ] && return 0
    nap 0.2
  done
  echo "$$" > "$TP_LOCK/pid" 2>/dev/null
  _tproxy_sync_body
  _tp_rc=$?
  [ "$(cat "$TP_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$TP_LOCK" 2>/dev/null
  return $_tp_rc
}

# ---------------- 配置手术：关 TUN / 还原 ----------------
# 把顶层 tun: 块的 enable 置为 $1（true/false）。stdout=改动前的值；
# 无 tun 块或无 enable 行时输出空且不改动（mihomo 缺省即 enable:false）。
cfg_tun_set_enable() {
  _ct_new=$1
  _ct_cur=$(tunhs_cfg_tun_field enable)
  case "$_ct_cur" in
    "$_ct_new"|"") printf '%s\n' "$_ct_cur"; return 0 ;;
  esac
  awk -v want="$_ct_new" '
    /^[^ \t#-]/ { inb = ($1 == "tun:") }
    {
      if (inb && /^tun:[ \t]*\{/ && /enable:/) {
        sub(/enable:[ \t]*[^,}]*/, "enable: " want); inb = 0
      } else if (inb && $1 == "enable:") {
        cmt = ""; if (match($0, /[ \t]+#.*$/)) cmt = substr($0, RSTART)
        sub(/enable:.*/, "enable: " want cmt); inb = 0
      }
      print
    }
  ' "$CONFIG" > "$RUNDIR/_tp_cfg.tmp" 2>/dev/null || { rm -f "$RUNDIR/_tp_cfg.tmp"; printf '%s\n' "$_ct_cur"; return 1; }
  if cat "$RUNDIR/_tp_cfg.tmp" > "$CONFIG" 2>/dev/null; then
    rm -f "$RUNDIR/_tp_cfg.tmp"
  else
    rm -f "$RUNDIR/_tp_cfg.tmp"; printf '%s\n' "$_ct_cur"; return 1
  fi
  printf '%s\n' "$_ct_cur"
}

# 注释 listeners 中 type: tun 的整条目（每行前缀 "#TPROXY_OFF# "）。stdout=注释条目数。
cfg_comment_tun_listeners() {
  awk -v mark="$TP_MARKER " '
    function flushentry(   i, istun) {
      if (n == 0) return
      istun = 0
      for (i = 1; i <= n; i++)
        if (ef[i] ~ /^[[:space:]]*(-[[:space:]]+)?type:[[:space:]]*["'"'"']?tun["'"'"']?[[:space:]]*(#.*)?$/) istun = 1
      for (i = 1; i <= n; i++) { if (istun) print mark ef[i]; else print ef[i] }
      if (istun) c++
      n = 0
    }
    /^[^ \t#-]/ { flushentry(); inls = ($1 == "listeners:"); base = -1; print; next }
    {
      if (!inls) { print; next }
      # 条目分界只认「与首个条目同缩进」的 - 行（嵌套列表不切分，见 tproxy_detect）
      if ($0 ~ /^[[:space:]]*-[[:space:]]/) {
        match($0, /[^[:space:]]/); ind = RSTART - 1
        if (base < 0) base = ind
        if (ind == base) flushentry()
      }
      ef[++n] = $0
    }
    END { flushentry(); print "TPCNT:" c + 0 }
  ' "$CONFIG" > "$RUNDIR/_tp_cfg.tmp" 2>/dev/null || { rm -f "$RUNDIR/_tp_cfg.tmp"; echo 0; return 1; }
  _cc_cnt=$(awk -F: '/^TPCNT:/{print $2; f=1} END{if(!f)print 0}' "$RUNDIR/_tp_cfg.tmp" 2>/dev/null)
  case "$_cc_cnt" in ''|*[!0-9]*) _cc_cnt=0 ;; esac
  if [ "$_cc_cnt" -gt 0 ]; then
    grep -v '^TPCNT:' "$RUNDIR/_tp_cfg.tmp" > "$RUNDIR/_tp_cfg2.tmp" 2>/dev/null \
      && cat "$RUNDIR/_tp_cfg2.tmp" > "$CONFIG" 2>/dev/null
    rm -f "$RUNDIR/_tp_cfg2.tmp" "$RUNDIR/_tp_cfg.tmp"
  else
    rm -f "$RUNDIR/_tp_cfg.tmp"
  fi
  echo "$_cc_cnt"
}

# 按标记还原被注释的 tun 监听器条目
cfg_uncomment_tun_listeners() {
  grep -q "^$TP_MARKER " "$CONFIG" 2>/dev/null || return 0
  sed "s/^$TP_MARKER //" "$CONFIG" > "$RUNDIR/_tp_cfg.tmp" 2>/dev/null || { rm -f "$RUNDIR/_tp_cfg.tmp"; return 1; }
  cat "$RUNDIR/_tp_cfg.tmp" > "$CONFIG" 2>/dev/null
  rm -f "$RUNDIR/_tp_cfg.tmp"
  return 0
}

# TProxy 开启时关闭 listeners 中 type: ebpf 的入站：把 local.enable / shared.enable
# 写成 $1（false 关 / true 开），条目连同用户的全部参数原样留在文件里。
# 内核在 normalizeModeWithEnabled 就会报 "local.enable or shared.enable must be
# enable" 并跳过该入站，eBPF 不接管任何流量；改回 true 即完整恢复。
# 与 WebUI 的 setEbpfEnabled() 写法完全一致（以前双方都是整条目加 # 注释，配置文件里
# 会留下一大段注释，且与源码编辑器互相打架）。mode 与 enable 内核不允许并存，遇到
# 旧配置里的 mode 行顺手删掉。stdout=改动的条目数。
cfg_ebpf_set_enabled() {
  _ce_want=$1
  case "$_ce_want" in true|false) ;; *) echo 0; return 1 ;; esac
  awk -v want="$_ce_want" '
    function indof(s) { if (match(s, /[^ \t]/)) return RSTART - 1; return -1 }
    # 键所在列与键文本：条目首行 `- name: x` 的键在破折号之后
    function keycol(s) { if (match(s, /^[ \t]*-[ \t]+/)) return RLENGTH; return indof(s) }
    function keytext(s) {
      if (match(s, /^[ \t]*-[ \t]+/)) return substr(s, RLENGTH + 1)
      if (match(s, /[^ \t]/)) return substr(s, RSTART)
      return ""
    }
    function istype(s) {
      return (s ~ /^[[:space:]]*type:[[:space:]]*["\047]?ebpf["\047]?[[:space:]]*(#.*)?$/ ||
              s ~ /^[[:space:]]*-[[:space:]]+type:[[:space:]]*["\047]?ebpf["\047]?[[:space:]]*(#.*)?$/)
    }
    function pad(k,   s) { s = ""; while (length(s) < k) s = s " "; return s }
    # 块式 `enable: x` 改值（兼容旧键 enabled），行尾注释保留；写出一律 enable
    function setblockline(s, val,   rest, cmt) {
      if (!match(s, /^[ \t]*enable(d)?:[ \t]*/)) return s
      rest = substr(s, RLENGTH + 1); cmt = ""
      if (match(rest, /#.*$/)) cmt = "  " substr(rest, RSTART)
      match(s, /^[ \t]*/)
      return substr(s, 1, RLENGTH) "enable: " val cmt
    }
    # 流式 `{... enable: x ...}` 改值（兼容 enabled），写出一律 enable
    function setflowval(s, val,   pre, rest) {
      if (!match(s, /enable(d)?:[ \t]*/)) return s
      pre = substr(s, 1, RSTART - 1) "enable: "
      rest = substr(s, RSTART + RLENGTH)
      if (match(rest, /^[^,}#[:space:]]+/)) rest = substr(rest, RLENGTH + 1)
      return pre val rest
    }
    # 把条目里 role 块的 enable 设成 val；块不存在就补一个
    function setrole(role, val, keyind,   i, at, kt, rest, childind, enat, lim, out, on) {
      at = 0
      for (i = 1; i <= cn; i++) {
        if (keycol(cur[i]) != keyind) continue
        kt = keytext(cur[i])
        if (substr(kt, 1, length(role) + 1) == role ":") { at = i; break }
      }
      if (at == 0) {                      # 没有该块：补在条目末尾（跳过尾随空行）
        lim = cn
        while (lim > 0 && cur[lim] ~ /^[ \t]*$/) lim--
        on = 0
        for (i = 1; i <= lim; i++) out[++on] = cur[i]
        out[++on] = pad(keyind) role ":"
        out[++on] = pad(keyind + 2) "enable: " val
        for (i = lim + 1; i <= cn; i++) out[++on] = cur[i]
        cn = on
        for (i = 1; i <= cn; i++) cur[i] = out[i]
        return
      }
      kt = keytext(cur[at]); rest = substr(kt, length(role) + 2)
      sub(/^[ \t]+/, "", rest)
      if (role == "local" && rest != "" && rest !~ /^#/) {
        sub(/^[ \t]*\{[ \t]*/, "", rest)
        sub(/[ \t]*\}[ \t]*(#.*)?$/, "", rest)
        on = 0
        for (i = 1; i < at; i++) out[++on] = cur[i]
        out[++on] = pad(keyind) role ":"
        out[++on] = pad(keyind + 2) "enable: " val
        if (rest != "") {
          n_pairs = split(rest, pairs, /[ \t]*,[ \t]*/)
          for (p = 1; p <= n_pairs; p++) {
            sub(/^[ \t]+/, "", pairs[p]); sub(/[ \t]+$/, "", pairs[p])
            if (pairs[p] != "" && pairs[p] !~ /^enable(d)?:/) {
              out[++on] = pad(keyind + 2) pairs[p]
            }
          }
        }
        for (i = at + 1; i <= cn; i++) out[++on] = cur[i]
        cn = on
        for (i = 1; i <= cn; i++) cur[i] = out[i]
        return
      }
      if (rest != "" && rest !~ /^#/) {   # 流式：local: {} / local: {a: b}
        if (rest ~ /enable(d)?:/) cur[at] = setflowval(cur[at], val)
        else if (rest ~ /^\{[ \t]*\}/) sub(/\{[ \t]*\}/, "{enable: " val "}", cur[at])
        else if (rest ~ /^\{/) sub(/\{/, "{enable: " val ", ", cur[at])
        return
      }
      childind = -1                       # 块式：定位直接子键的缩进
      for (i = at + 1; i <= cn; i++) {
        if (cur[i] ~ /^[ \t]*$/) continue
        if (indof(cur[i]) <= keyind) break
        childind = indof(cur[i]); break
      }
      if (childind < 0) childind = keyind + 2
      enat = 0
      for (i = at + 1; i <= cn; i++) {
        if (cur[i] ~ /^[ \t]*$/) continue
        if (indof(cur[i]) <= keyind) break
        if (indof(cur[i]) == childind && cur[i] ~ /^[ \t]*enable(d)?:/) { enat = i; break }
      }
      if (enat > 0) { cur[enat] = setblockline(cur[enat], val); return }
      on = 0                              # 插到块首（文档示例里 enable 就是首键）
      for (i = 1; i <= at; i++) out[++on] = cur[i]
      out[++on] = pad(childind) "enable: " val
      for (i = at + 1; i <= cn; i++) out[++on] = cur[i]
      cn = on
      for (i = 1; i <= cn; i++) cur[i] = out[i]
    }
    function flushentry(   i, isebpf, keyind) {
      if (n == 0) return
      isebpf = 0
      for (i = 1; i <= n; i++) if (istype(ef[i])) isebpf = 1
      if (!isebpf) { for (i = 1; i <= n; i++) print ef[i]; n = 0; return }
      keyind = keycol(ef[1])
      cn = 0
      for (i = 1; i <= n; i++) {          # mode 与 enable 不能并存：删掉 mode 行
        if (keycol(ef[i]) == keyind && keytext(ef[i]) ~ /^mode:/) continue
        cur[++cn] = ef[i]
      }
      setrole("local", want, keyind)
      setrole("shared", want, keyind)
      for (i = 1; i <= cn; i++) print cur[i]
      c++
      n = 0
    }
    /^[^ \t#-]/ { flushentry(); inls = ($1 == "listeners:"); base = -1; print; next }
    {
      if (!inls) { print; next }
      # 条目分界只认与首个条目同缩进的 -（嵌套列表不切分，见 cfg_comment_tun_listeners）
      if ($0 ~ /^[[:space:]]*-[[:space:]]/) {
        match($0, /[^[:space:]]/); ind = RSTART - 1
        if (base < 0) base = ind
        if (ind == base) flushentry()
      }
      ef[++n] = $0
    }
    END { flushentry(); print "EBCNT:" c + 0 }
  ' "$CONFIG" > "$RUNDIR/_tp_cfg.tmp" 2>/dev/null || { rm -f "$RUNDIR/_tp_cfg.tmp"; echo 0; return 1; }
  _ce_cnt=$(awk -F: '/^EBCNT:/{print $2; f=1} END{if(!f)print 0}' "$RUNDIR/_tp_cfg.tmp" 2>/dev/null)
  case "$_ce_cnt" in ''|*[!0-9]*) _ce_cnt=0 ;; esac
  if [ "$_ce_cnt" -gt 0 ]; then
    grep -v '^EBCNT:' "$RUNDIR/_tp_cfg.tmp" > "$RUNDIR/_tp_cfg2.tmp" 2>/dev/null \
      && cat "$RUNDIR/_tp_cfg2.tmp" > "$CONFIG" 2>/dev/null
    rm -f "$RUNDIR/_tp_cfg2.tmp" "$RUNDIR/_tp_cfg.tmp"
  else
    rm -f "$RUNDIR/_tp_cfg.tmp"
  fi
  echo "$_ce_cnt"
}

# 同步配置里所有 IPv6 相关开关到 $1（true|false）——系统 IPv6 总开关的配置侧手术：
#   · 顶层 ipv6（缺键时补在 log-level/mode 之后）；
#   · dns 块的 ipv6（缺键补块首）；
#   · listeners 中 type: ebpf 条目的 local.ipv6 / shared.ipv6（角色块存在的才动；
#     旧键 ipv6-mode 就地换算成 ipv6 并删除，与 WebUI normalizeEbpfLegacy 一致）。
# 值已一致的行不动（排版、行尾注释原样保留）；stdout=实际改动条数。
# 供 set system_ipv6 调用：系统 IPv6 开关＝总开关，切换时把配置里的 IPv6 相关开关
# 一并改齐（包括 eBPF 入站），随后由调用方重启服务让内核与 eBPF 入站按新开关重建。
cfg_ipv6_set_all() {
  _ci_want=$1
  case "$_ci_want" in true|false) ;; *) echo 0; return 1 ;; esac
  [ -f "$CONFIG" ] || { echo 0; return 1; }
  awk -v want="$_ci_want" '
    function indof(s) { if (match(s, /[^ \t]/)) return RSTART - 1; return -1 }
    function keycol(s) { if (match(s, /^[ \t]*-[ \t]+/)) return RLENGTH; return indof(s) }
    function keytext(s) {
      if (match(s, /^[ \t]*-[ \t]+/)) return substr(s, RLENGTH + 1)
      if (match(s, /[^ \t]/)) return substr(s, RSTART)
      return ""
    }
    function istype(s) {
      return (s ~ /^[[:space:]]*type:[[:space:]]*["\047]?ebpf["\047]?[[:space:]]*(#.*)?$/ ||
              s ~ /^[[:space:]]*-[[:space:]]+type:[[:space:]]*["\047]?ebpf["\047]?[[:space:]]*(#.*)?$/)
    }
    function pad(k,   s) { s = ""; while (length(s) < k) s = s " "; return s }
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function emit(s) { out[++outn] = s }
    # 块式 `key: val # cmt` 的当前值（无该键返回 \001）；一律按裸值比较
    function bval(s, key,   rest) {
      if (!match(s, "^[ \t]*" key ":[ \t]*")) return "\001"
      rest = substr(s, RLENGTH + 1)
      if (match(rest, /#/)) rest = substr(rest, 1, RSTART - 1)
      return trim(rest)
    }
    # 块式 `key: val # cmt` 改值，行尾注释保留
    function setbval(s, key, val,   rest, cmt) {
      if (!match(s, "^[ \t]*" key ":[ \t]*")) return s
      rest = substr(s, RLENGTH + 1); cmt = ""
      if (match(rest, /#/)) { cmt = "  " substr(rest, RSTART); rest = substr(rest, 1, RSTART - 1) }
      match(s, /^[ \t]*/)
      return substr(s, 1, RLENGTH) key ": " val cmt
    }
    # 流式 `{...}` 行里管理键 key：有 key 且值不同才改；有 ipv6-mode 无 key 时换算成
    # key:val；都没有则补进花括号（空 {} 直接落键，否则插在最前）。} 后的行尾注释保留。
    function flowset(s, key, val,   pre, rest, body, tail, seg, v, bs, bl) {
      if (!match(s, /\{/)) return s
      pre = substr(s, 1, RSTART)
      rest = substr(s, RSTART + 1)
      if (!match(rest, /\}/)) return s
      body = substr(rest, 1, RSTART - 1)
      tail = substr(rest, RSTART)
      if (match(body, key ":[ \t]*[^,}#[:space:]]*")) {
        bs = RSTART; bl = RLENGTH
        seg = substr(body, bs, bl)
        match(seg, key ":[ \t]*")
        v = substr(seg, RLENGTH + 1)
        if (v != val) {
          body = substr(body, 1, bs - 1) substr(seg, 1, RLENGTH) val substr(body, bs + bl)
          chg++
        }
      } else if (match(body, /ipv6-mode:[ \t]*[^,}#[:space:]]*/)) {
        body = substr(body, 1, RSTART - 1) key ": " val substr(body, RSTART + RLENGTH)
        chg++
      } else {
        if (body ~ /^[ \t]*$/) body = key ": " val
        else body = key ": " val ", " body
        chg++
      }
      return pre body tail
    }
    # dns 块（from..to 为块内行）：直接子键 ipv6 改值/补键
    function dnsblock(from, to,   i, l, childind, at) {
      childind = -1
      for (i = from; i <= to; i++) {
        l = lines[i]
        if (l ~ /^[ \t]*$/ || l ~ /^[ \t]*#/) continue
        childind = indof(l); break
      }
      if (childind < 0) childind = 2
      at = 0
      for (i = from; i <= to; i++) {
        l = lines[i]
        if (l ~ /^[ \t]*$/ || l ~ /^[ \t]*#/ || l ~ /^[ \t]*-/) continue
        if (indof(l) == childind && keytext(l) ~ /^ipv6:/) { at = i; break }
      }
      if (at == 0) {
        emit(pad(childind) "ipv6: " want); chg++
        for (i = from; i <= to; i++) emit(lines[i])
        return
      }
      for (i = from; i <= to; i++) {
        if (i == at && bval(lines[i], "ipv6") != want) { emit(setbval(lines[i], "ipv6", want)); chg++ }
        else emit(lines[i])
      }
    }
    # eBPF 条目角色块（local/shared）里的 ipv6：块存在才动。改值→删冲突旧键；
    # 仅旧键→就地换算；都没有→补到角色块首。
    function rolesetipv6(role, keyind,   i, k, at, kt, rest, childind, ipv6at, modeat, on) {
      at = 0
      for (i = 1; i <= cn; i++) {
        if (keycol(cur[i]) != keyind) continue
        kt = keytext(cur[i])
        if (substr(kt, 1, length(role) + 1) == role ":") { at = i; break }
      }
      if (at == 0) return
      kt = keytext(cur[at]); rest = substr(kt, length(role) + 2)
      sub(/^[ \t]+/, "", rest)
      if (rest != "" && rest !~ /^#/) {        # 流式 local: {...}
        cur[at] = flowset(cur[at], "ipv6", want)
        return
      }
      childind = -1
      for (i = at + 1; i <= cn; i++) {
        if (cur[i] ~ /^[ \t]*$/) continue
        if (indof(cur[i]) <= keyind) break
        childind = indof(cur[i]); break
      }
      if (childind < 0) childind = keyind + 2
      ipv6at = 0; modeat = 0
      for (i = at + 1; i <= cn; i++) {
        if (cur[i] ~ /^[ \t]*$/) continue
        if (indof(cur[i]) <= keyind) break
        if (indof(cur[i]) != childind || cur[i] ~ /^[ \t]*-/) continue
        kt = keytext(cur[i])
        if (ipv6at == 0 && kt ~ /^ipv6:/) ipv6at = i
        else if (kt ~ /^ipv6-mode:/) modeat = i
      }
      if (ipv6at > 0) {
        if (bval(cur[ipv6at], "ipv6") != want) { cur[ipv6at] = setbval(cur[ipv6at], "ipv6", want); chg++ }
        if (modeat > 0) {                      # 冲突旧键整行摘掉（同 mode/enable 并存的处理）
          on = 0
          for (k = 1; k <= cn; k++) if (k != modeat) out2[++on] = cur[k]
          cn = on; for (k = 1; k <= cn; k++) cur[k] = out2[k]
          chg++
        }
        return
      }
      if (modeat > 0) {                        # 旧键换算（同 WebUI normalizeEbpfLegacy）
        cur[modeat] = pad(childind) "ipv6: " want
        chg++
        return
      }
      on = 0                                   # 插到角色块首
      for (k = 1; k <= at; k++) out2[++on] = cur[k]
      out2[++on] = pad(childind) "ipv6: " want
      for (k = at + 1; k <= cn; k++) out2[++on] = cur[k]
      cn = on; for (k = 1; k <= cn; k++) cur[k] = out2[k]
      chg++
    }
    function entryemit(from, to,   i, isebpf, keyind) {
      isebpf = 0
      for (i = from; i <= to; i++) if (istype(L[i])) isebpf = 1
      if (!isebpf) { for (i = from; i <= to; i++) emit(L[i]); return }
      cn = 0
      for (i = from; i <= to; i++) cur[++cn] = L[i]
      keyind = keycol(cur[1])
      rolesetipv6("local", keyind)
      rolesetipv6("shared", keyind)
      for (i = 1; i <= cn; i++) emit(cur[i])
    }
    # listeners 块（from..to 为块内行）：按首个 `- ` 的缩进切条目，逐条处理 eBPF
    function listenersblock(from, to,   ln, i, k, l, ind, base, efrom) {
      ln = 0
      for (i = from; i <= to; i++) L[++ln] = lines[i]
      base = -1; efrom = -1
      for (i = 1; i <= ln; i++) {
        l = L[i]
        if (l ~ /^[ \t]*-[ \t]/) {
          match(l, /[^ \t]/); ind = RSTART - 1
          if (base < 0) {
            base = ind; efrom = i
            for (k = 1; k < i; k++) emit(L[k])   # 首个条目前的注释/空行原样
            continue
          }
          if (ind == base) {
            entryemit(efrom, i - 1)
            efrom = i
          }
        }
      }
      if (efrom >= 0) entryemit(efrom, ln)
      else for (i = 1; i <= ln; i++) emit(L[i])
    }
    { lines[++n] = $0 }
    END {
      hastop = 0
      for (i = 1; i <= n; i++) if (lines[i] ~ /^ipv6:[ \t]/ || lines[i] ~ /^ipv6:[ \t]*$/) hastop = 1
      if (!hastop) {                        # 顶层缺键：补在 log-level/mode 之后；
        anchor = 0                          # 都没有则跳过头部注释、插在首个顶层键前
        for (i = 1; i <= n; i++) if (lines[i] ~ /^log-level:/) { anchor = i; break }
        if (!anchor) for (i = 1; i <= n; i++) if (lines[i] ~ /^mode:/) { anchor = i; break }
        if (!anchor) for (i = 1; i <= n; i++) {
          if (lines[i] ~ /^[ \t]*$/ || lines[i] ~ /^[ \t]*#/) { anchor = i; continue }
          break
        }
        at = anchor + 1
        if (at < 1 || at > n + 1) at = n + 1
        for (k = n; k >= at; k--) lines[k + 1] = lines[k]
        lines[at] = "ipv6: " want
        n++
        chg++
      }
      for (i = 1; i <= n; i++) {
        l = lines[i]
        if (indof(l) == 0 && l !~ /^[ \t]*#/ && keytext(l) != "") {
          kt = keytext(l)
          if (kt ~ /^ipv6:/) {
            if (bval(l, "ipv6") != want) { emit(setbval(l, "ipv6", want)); chg++ } else emit(l)
            continue
          }
          nl = l; if (match(nl, /#/)) nl = substr(nl, 1, RSTART - 1)
          if (kt ~ /^dns:/) {
            rest = substr(kt, 5); sub(/^[ \t]+/, "", rest)
            if (rest == "" || rest ~ /^#/) {
              j = i + 1
              while (j <= n && !(indof(lines[j]) == 0 && lines[j] !~ /^[ \t]*#/ && keytext(lines[j]) != "")) j++
              emit(l)
              dnsblock(i + 1, j - 1)
              i = j - 1
              continue
            }
            if (nl ~ /\{/) { emit(flowset(l, "ipv6", want)); continue }
            emit(l); continue
          }
          if (kt ~ /^listeners:/) {
            rest = substr(kt, 11); sub(/^[ \t]+/, "", rest)
            if (rest == "" || rest ~ /^#/) {
              j = i + 1
              while (j <= n && !(indof(lines[j]) == 0 && lines[j] !~ /^[ \t]*#/ && keytext(lines[j]) != "")) j++
              emit(l)
              listenersblock(i + 1, j - 1)
              i = j - 1
              continue
            }
            emit(l); continue
          }
          emit(l); continue
        }
        emit(l)
      }
      for (i = 1; i <= outn; i++) print out[i]
      print "CHG:" chg + 0
    }
  ' "$CONFIG" > "$RUNDIR/_ci6.tmp" 2>/dev/null || { rm -f "$RUNDIR/_ci6.tmp"; echo 0; return 1; }
  _ci_chg=$(awk -F: '/^CHG:/{print $2; f=1} END{if(!f)print 0}' "$RUNDIR/_ci6.tmp" 2>/dev/null)
  case "$_ci_chg" in ''|*[!0-9]*) _ci_chg=0 ;; esac
  if [ "$_ci_chg" -gt 0 ]; then
    grep -v '^CHG:' "$RUNDIR/_ci6.tmp" > "$RUNDIR/_ci62.tmp" 2>/dev/null \
      && cat "$RUNDIR/_ci62.tmp" > "$CONFIG" 2>/dev/null
    rm -f "$RUNDIR/_ci62.tmp"
  fi
  rm -f "$RUNDIR/_ci6.tmp"
  echo "$_ci_chg"
}

# 开关主流程（同步执行，输出用户可读结果）。$1 = true|false（on/off/1/0 亦接受）
_tproxy_apply_body() {
  _ta_defer_restart=false
  [ "$2" = "defer" ] && _ta_defer_restart=true
  case "$1" in
    true|on|1)  _ta_w=true ;;
    false|off|0) _ta_w=false ;;
    *) echo "ERR: 参数只能是 true / false"; return 1 ;;
  esac
  if [ "$_ta_w" = "true" ]; then
    # 1) 识别端口：找不到直接拒绝，不写设置、不动配置
    _ta_det=$(tproxy_detect)
    _ta_port=$(printf '%s\n' "$_ta_det" | awk '{print $1}')
    if [ -z "$_ta_port" ]; then
      echo "ERR: 未在配置中找到 TProxy 端口。请先在「配置 → 入站」里设置 TProxy 端口（tproxy-port）或添加 tproxy 类型监听器，保存后再开启本开关"
      return 1
    fi
    # 2) 能力探测：不通过同样拒绝，防止装上无法旁路内核自身的回环规则导致断网
    tproxy_probe || return 1
    # 3) 写设置 + 配置手术（关 TUN；首次开启记录原值，关闭开关时据此还原）
    set_setting tproxy true
    prepare_proxy_mode || return 1
    _ta_spec=$(tproxy_app_spec)
    _ta_mode=$(printf '%s\n' "$_ta_spec" | awk '{print $1}')
    _ta_cnt=$(printf '%s\n' "$_ta_spec" | awk '{print $2}')
    case "$_ta_mode" in include|exclude) ;; *) _ta_mode=all; _ta_cnt=0 ;; esac
    case "$_ta_mode" in
      include) _ta_appmsg="仅代理名单内 $_ta_cnt 个应用" ;;
      exclude) _ta_appmsg="名单内 $_ta_cnt 个应用直连、其余走代理" ;;
      *) _ta_appmsg="全部应用经 Tproxy" ;;
    esac
    tp_log "enable: port=$_ta_port（配置已关 TUN，并关闭 eBPF 入站的 local/shared.enable） app=$_ta_mode:$_ta_cnt"
    # 4) 内核在跑 → 重启：TUN 关闭要生效，且内核需以 root:net_admin 身份
    #    重新拉起（gid 旁路依赖它）
    if running; then
      stop_core keep >/dev/null 2>&1
      if ! start_core; then
        echo "ERR: 内核重启失败，规则未安装（开关保持开启，修正配置后会自动生效；关闭开关可还原）"
        return 1
      fi
    fi
    # 5) 立即尝试同步 TProxy 规则（端口一旦监听就直接装好并生成 $TP_STATE，免除等待延迟）
    # 等待期只做廉价端口探测（tproxy_port_listening 一次 awk 读 /proc）：旧写法每 0.1s
    # 甩一整轮 tproxy_sync（加锁 + 全量对账 + 应用名单时还要问一遍包管理器），端口没
    # 就绪时白跑十几轮，是「启用 Tproxy 慢」的大头之一。端口就绪后一次对账装好。
    _i=0
    # 3 秒上限以 now_cs 真实时钟为准（nap 取整成 1s 时轮数与时长解耦）
    now_cs
    if [ "$NOW_CS" -gt 0 ]; then _ta_dl=$((NOW_CS + 300)); else _ta_dl=0; fi
    while [ $_i -lt 30 ]; do
      tproxy_port_listening "$_ta_port" 2>/dev/null && break
      if [ "$_ta_dl" != "0" ]; then
        now_cs
        [ "$NOW_CS" -ge "$_ta_dl" ] && break
      fi
      nap 0.1
      _i=$((_i+1))
    done
    tproxy_sync >/dev/null 2>&1
    [ -f "$TP_STATE" ] || {
      ( _i=0
        while [ $_i -lt 12 ]; do
          sh "$0" tproxy-sync >/dev/null 2>&1
          if [ -f "$TP_STATE" ]; then
            sh "$0" boot-data-sync >/dev/null 2>&1
            sh "$0" live-invalidate >/dev/null 2>&1
            break
          fi
          nap 0.5; _i=$((_i+1))
        done
      ) </dev/null >/dev/null 2>&1 &
    }
    ( boot_data_sync ) >/dev/null 2>&1 &
    live_invalidate 2>/dev/null
    echo "OK: Tproxy 已开启，流量将导入端口 $_ta_port（配置中的 TUN 已关闭；$_ta_appmsg，名单复用 TUN 页设置）"
    return 0
  fi
  # ---- 关闭：还原默认状态 ----
  set_setting tproxy false
  # —— 关闭提速：同步只摘跳转（tproxy 的 mangle PREROUTING/OUTPUT 跳转是唯一仍把
  #    系统流量导向 TPROXY 链的规则，摘掉即恢复原路径，亚秒级）；链删除、ip rule、
  #    路由表等无流量影响的清理放后台全量对账收尾（设置已置 false，对账算出的期望
  #    终态就是「全拆」，与「拆完立刻再开」的竞态天然安全）。
  tproxy_unhook_quick
  ( sh "$0" tproxy-sync >/dev/null 2>&1 ) </dev/null >/dev/null 2>&1 &
  rm -f "$TP_STATE" "$TP_MISS" 2>/dev/null
  live_invalidate 2>/dev/null
  tp_log "disable: 规则已拆除"
  # 主日志继续按原约定在关闭后清空；先留最近 80 行到独立上一段快照，
  # 这样切到 TUN 后再打开 Tproxy 诊断，仍能看到刚才那轮拆除/互切时间线。
  if [ -s "$TP_LOG" ]; then
    tail -n 80 "$TP_LOG" > "$TP_LOG_PREV.tmp" 2>/dev/null &&
      mv -f "$TP_LOG_PREV.tmp" "$TP_LOG_PREV" 2>/dev/null
    rm -f "$TP_LOG_PREV.tmp" 2>/dev/null
  else
    : > "$TP_LOG_PREV" 2>/dev/null
  fi
  : > "$TP_LOG" 2>/dev/null
  if [ -f "$TP_CFG" ] && [ -f "$RUNDIR/tproxy.config.fp" ] &&
     [ "$(config_fingerprint)" != "$(cat "$RUNDIR/tproxy.config.fp")" ]; then
    rm -f "$TP_CFG" "$RUNDIR/tproxy.config.fp"
    tp_log "disable: 配置已替换或修改，不向新配置还原旧 TUN 值"
  fi
  if [ -f "$TP_CFG" ]; then
    _ta_before=$(grep '^tun_before=' "$TP_CFG" 2>/dev/null | cut -d= -f2)
    _ta_marked=$(grep '^listener_marked=' "$TP_CFG" 2>/dev/null | cut -d= -f2)
    [ "$_ta_before" = "true" ] && cfg_tun_set_enable true >/dev/null
    case "$_ta_marked" in ''|0|*[!0-9]*) ;; *) cfg_uncomment_tun_listeners ;; esac
    # eBPF 不在这里恢复：关闭 TProxy 后由 WebUI 的 TUN/eBPF 选择弹窗决定。
    rm -f "$TP_CFG" "$RUNDIR/tproxy.config.fp"
    tp_log "disable: TUN 配置已还原，eBPF 保持关闭等待模式选择 (tun_before=${_ta_before:-?} listener_marked=${_ta_marked:-0})"
    if running && [ "$_ta_defer_restart" != "true" ]; then
      stop_core keep >/dev/null 2>&1
      if ! start_core >/dev/null 2>&1; then
        echo "ERR: 内核重启失败，请检查配置后手动启动（Tproxy 规则已拆除、配置已还原）"
        return 1
      fi
    fi
    if [ "$_ta_defer_restart" = "true" ]; then
      echo "OK: Tproxy 已关闭，配置已还原，等待选择 TUN / eBPF 后重启内核"
    else
      echo "OK: 已还原默认状态（Tproxy 规则已拆除，TUN 配置已恢复）"
    fi
  else
    echo "OK: Tproxy 已关闭"
  fi
  boot_data_sync >/dev/null 2>&1 &
  return 0
}

# 状态短串（status_json / tproxy-status 共用；只读设置与状态文件，零 iptables 调用）
#   off     = 开关未开启
#   standby = 开关已开启，内核未运行（启动后自动生效）
#   pending = 内核运行中，等待 TProxy 端口就绪
#   holding = 规则已装但端口暂不可见，宽限期内保留规则（不拆，避免直连窗口）
#   on:port=N:v6=on|off = 规则已应用
tproxy_status_short() {
  setting_v tproxy false
  [ "$SV" = "true" ] || { echo "off"; return 0; }
  if [ -f "$TP_STATE" ]; then
    _tss_p=$(grep '^port=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    if grep -q '^v6=on' "$TP_STATE" 2>/dev/null; then _tss_v=on; else _tss_v=off; fi
    # 应用名单后缀（want=期望名单，apps=包数；fb=名单暂未生效、已按全部代理）
    _tss_a=$(grep '^want=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    _tss_n=$(grep '^apps=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    case "$_tss_a" in include|exclude) ;; *) _tss_a=all ;; esac
    case "$_tss_n" in ''|*[!0-9]*) _tss_n=0 ;; esac
    _tss_app=":app=$_tss_a"
    [ "$_tss_a" != "all" ] && _tss_app="$_tss_app:apps=$_tss_n"
    grep -q '^fb=1' "$TP_STATE" 2>/dev/null && _tss_app="$_tss_app:fb"
    if [ -f "$TP_MISS" ]; then
      _tss_m=$(cat "$TP_MISS" 2>/dev/null)
      case "$_tss_m" in ''|*[!0-9]*) _tss_m=0 ;; esac
      echo "holding:port=${_tss_p:-?}:v6=$_tss_v:${_tss_m}/${TP_GRACE}${_tss_app}"
    else
      echo "on:port=${_tss_p:-?}:v6=$_tss_v${_tss_app}"
    fi
  elif running; then
    echo "pending"
  else
    echo "standby"
  fi
}

# 一键诊断：把「端口识别 / 内核身份 / 端口监听 / 策略路由 / iptables / 状态文件」
# 一次打全。tproxy 不生效时先看这个，不用逐条手敲。
tproxy_diag() {
  tp_setup_bins
  echo "=== 开关与状态 ==="
  echo "tproxy 开关: $(get_setting tproxy false)"
  echo "状态: $(tproxy_status_short)"
  echo "状态文件: $([ -f "$TP_STATE" ] && tr '\n' ' ' < "$TP_STATE" || echo '（无）')"
  if [ "$TP_BACKEND" = "nft" ]; then
    echo "防火墙后端: nftables（独立表 inet $TP_NFT_TABLE，nft=${TP_NFT:-缺失}）"
  else
    echo "防火墙后端: iptables"
  fi
  echo "TUN 配置（磁盘）:"
  _tunhs_diag_config_tun "$CONFIG"
  echo "TUN 配置（当前内核快照）:"
  _tunhs_diag_config_tun "$RUNDIR/active-config.yaml"
  echo "eBPF 状态: $(cat "$RUNDIR/ebpf.active" 2>/dev/null || echo '(无)')"
  if running; then
    _td_api_cfg=$(MH_API_TIMEOUT=2 api GET /configs 2>/dev/null)
    _td_api_tun=$(printf '%s\n' "$_td_api_cfg" | _diag_api_tun_object)
    echo "Mihomo API TUN: ${_td_api_tun:-不可达/无 tun 对象}"
  fi
  echo "TP_STATE 时间: $([ -f "$TP_STATE" ] && { _td_now=$(date +%s 2>/dev/null); _td_mt=$(stat -c %Y "$TP_STATE" 2>/dev/null || "$BUSYBOX" stat -c %Y "$TP_STATE" 2>/dev/null); case "$_td_now:$_td_mt" in *[!0-9:]*) echo '不可读' ;; *) echo "mtime=$_td_mt age=$((_td_now - _td_mt))s" ;; esac; } || echo '(无)')"
  echo "TP_MISS: $(cat "$TP_MISS" 2>/dev/null || echo '(无)')"
  echo "TP_LOCK:"
  if [ -d "$TP_LOCK" ]; then
    _td_tpid=$(cat "$TP_LOCK/pid" 2>/dev/null)
    _td_tlock="pid=${_td_tpid:-?} age=$(tproxy_lock_age)s"
    if tproxy_lock_stale; then _td_tlock="$_td_tlock [陈旧]"; else _td_tlock="$_td_tlock [持有中]"; fi
    case "$_td_tpid" in ''|*[!0-9]*) ;; *)
      [ -r "/proc/$_td_tpid/cmdline" ] && _td_tlock="$_td_tlock cmd=$(tr '\000' ' ' < "/proc/$_td_tpid/cmdline" 2>/dev/null | cut -c1-180)" ;;
    esac
    echo "$_td_tlock"
  else echo "(空闲)"; fi
  echo "iptables-restore 能力缓存: $(cat "$RUNDIR/tproxy.bulk.ok" 2>/dev/null | tr '\n' ' ' || echo '(无)')"
  if [ -f "$RUNDIR/tproxy.bulk.reject" ]; then
    echo "批量下发回退现场: 存在"
    head -n 45 "$RUNDIR/tproxy.bulk.reject" 2>/dev/null
  else
    echo "批量下发回退现场: (无)"
  fi

  echo
  echo "=== 端口识别 ==="
  _td_d=$(tproxy_detect)
  if [ -n "$_td_d" ]; then
    echo "识别结果: $_td_d"
    _td_port=$(printf '%s\n' "$_td_d" | awk '{print $1}')
    _td_hx=$(printf '%04X' "$_td_port")
    echo "十六进制端口: 0x$_td_hx"
    # 监听地址很关键：TPROXY 规则固定把流量送到 127.0.0.1:端口，
    # 若内核只监听了某个具体网卡地址或仅 IPv6，v4 规则就会把流量送进黑洞。
    echo "-- 该端口的监听条目（/proc/net）--"
    _td_seen=0; _td_v4=0; _td_v6=0
    for _td_n in tcp udp tcp6 udp6; do
      [ -r "/proc/net/$_td_n" ] || continue
      awk -v p="$_td_hx" -v f="$_td_n" '
        function st_norm(s) {
          if (length(s) > 2) s = substr(s, length(s) - 1, 2)
          if (substr(s, 1, 1) == "8") s = "0" substr(s, 2, 1)
          return s
        }
        FNR > 1 {
          n = split($2, a, ":")
          if (toupper(a[n]) == p) {
            s = st_norm($4)
            # 状态同时给出归一化值，8A 这类「高位被置起」的写法才看得出来
            extra = (s == $4) ? "" : " (原 " $4 ")"
            printf "  %s %s → 地址 %s 状态 %s%s %s\n", f, $2, a[1], s, extra,
                   (s == "0A" || s == "07") ? "[算监听]" : "[不算监听]"
          }
        }
      ' "/proc/net/$_td_n" 2>/dev/null
      # 统计该协议族有没有条目，用于下面的 v4/v6 提示
      if awk -v p="$_td_hx" 'FNR > 1 { n = split($2, a, ":"); if (toupper(a[n]) == p) found = 1 } END { exit !found }' \
           "/proc/net/$_td_n" 2>/dev/null; then
        _td_seen=1
        case "$_td_n" in tcp6|udp6) _td_v6=1 ;; *) _td_v4=1 ;; esac
      fi
    done
    if tproxy_port_listening "$_td_port"; then
      echo "端口监听: 是"
    else
      echo "端口监听: 否 ← 内核没在听这个端口，规则装了也接不到流量"
    fi
    # v6-only 提示：规则送的是 IPv4 127.0.0.1，靠 dual-stack 才能被 v6 通配监听到。
    if [ "$_td_seen" = "1" ] && [ "$_td_v6" = "1" ] && [ "$_td_v4" = "0" ]; then
      echo "⚠ 内核仅监听 IPv6 通配地址(::)：IPv4 规则靠 dual-stack 才能接通。"
      echo "  若 /proc/sys/net/ipv6/bindv6only = 1，请改为 0，或让内核同时监听 IPv4。"
      echo "  当前 bindv6only=$(cat /proc/sys/net/ipv6/bindv6only 2>/dev/null || echo 未知)"
    fi
  else
    echo "识别结果: 未找到 ← 配置里没有可识别的 TProxy 端口"
    grep -n "tproxy" "$CONFIG" 2>/dev/null | head -5 | sed 's/^/  配置命中: /'
  fi

  echo
  echo "=== 内核 ==="
  if running; then
    _td_pid=$(pid_of)
    echo "运行中: 是 (pid $_td_pid)"
    echo "Gid: $(awk '/^Gid:/{print $2; exit}' "/proc/$_td_pid/status" 2>/dev/null)  （旁路需要 $TP_CORE_GID）"
  else
    echo "运行中: 否"
  fi

  echo
  echo "=== 应用名单（复用 TUN 页 include/exclude-package）==="
  _td_spec=$(tproxy_app_spec)
  _td_amode=$(printf '%s\n' "$_td_spec" | awk '{print $1}')
  _td_acnt=$(printf '%s\n' "$_td_spec" | awk '{print $2}')
  case "$_td_amode" in
    include) echo "期望: 白名单（仅代理名单内应用），包 $_td_acnt 个" ;;
    exclude) echo "期望: 黑名单（名单内直连、其余代理），包 $_td_acnt 个" ;;
    *) echo "期望: 全部应用经 Tproxy（两份名单都为空）"; _td_amode=all ;;
  esac
  if [ -f "$TP_STATE" ]; then
    _td_emode=$(grep '^mode=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    _td_eapps=$(grep '^apps=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    _td_euids=$(grep '^uids=' "$TP_STATE" 2>/dev/null | cut -d= -f2)
    if grep -q '^fb=1' "$TP_STATE" 2>/dev/null; then
      echo "已装: 生效全部代理 ← 名单暂未解析成功（包管理器不可用或包名无匹配），就绪后自动切换"
    else
      echo "已装: 生效 ${_td_emode:-all}（包 ${_td_eapps:-0} 个，UID 规则 ${_td_euids:-0} 条）"
    fi
  else
    echo "已装: （规则未安装）"
  fi
  if [ "$_td_amode" != "all" ]; then
    echo "-- 名单包名 --"
    tproxy_app_list "$_td_amode" | sed 's/^/  /'
    echo "-- UID 解析（user 0）--"
    _td_wantf=$RUNDIR/_tp_diag_want.tmp; _td_dumpf=$RUNDIR/_tp_diag_dump.tmp
    tproxy_app_list "$_td_amode" > "$_td_wantf" 2>/dev/null
    if tproxy_pkg_dump > "$_td_dumpf" 2>/dev/null; then
      tproxy_resolve_uids "$_td_dumpf" "$_td_wantf" 2>/dev/null | sed 's/^U:/  UID /;s/^M:/  未解析 ← /'
    else
      echo "  包管理器查询失败（cmd/pm 均不可用），名单暂不生效"
    fi
    rm -f "$_td_wantf" "$_td_dumpf" 2>/dev/null
    _td_users=$(tproxy_tun_list include-android-user 2>/dev/null | grep -E '^[0-9]+$' | sort -nu | tr '\n' ' ' | sed 's/ $//')
    if [ -n "$_td_users" ]; then
      echo "多用户展开: $_td_users（名单 UID 已按 appId 展开到这些用户）"
    else
      echo "多用户展开: 未配置（只匹配 user 0；多用户设备请在 TUN 页 include-android-user 列出用户 ID）"
    fi
  fi

  echo
  echo "=== 策略路由 ==="
  if [ -n "$TUNHS_IP" ]; then
    echo "-- ip rule（本模块相关）--"
    $TUNHS_IP rule show 2>/dev/null | grep -E "lookup $TP_TABLE|fwmark $TP_MARK" | sed 's/^/  /'
    echo "-- table $TP_TABLE --"
    $TUNHS_IP route show table "$TP_TABLE" 2>/dev/null | sed 's/^/  /'
    echo "-- ip -6 rule（本模块相关）--"
    $TUNHS_IP -6 rule show 2>/dev/null | grep -E "lookup $TP_TABLE|fwmark $TP_MARK" | sed 's/^/  /'
    echo "-- table $TP_TABLE (IPv6) --"
    $TUNHS_IP -6 route show table "$TP_TABLE" 2>/dev/null | sed 's/^/  /'
    echo "-- fake-ip-range6: $(tproxy_fakeip6_range) --"
  else echo "  ip 命令缺失"; fi

  echo
if [ "$TP_BACKEND" = "nft" ]; then
  echo "=== nftables（inet $TP_NFT_TABLE）==="
  if [ -n "$TP_NFT" ]; then
    echo "nft: $TP_NFT"
    if tp_nft_table_present; then
      "$TP_NFT" list table inet "$TP_NFT_TABLE" 2>/dev/null | sed 's/^/  /'
    else
      echo "  （表 inet $TP_NFT_TABLE 不存在：规则未安装或已被删除）"
    fi
    echo "  生成规则文件: $TP_NFT_FILE"
  else
    echo "  nft 命令缺失（请安装 nftables-json）"
  fi
  echo
  echo "=== 流量计数（判断包是否进入 TPROXY）==="
  if [ -n "$TP_NFT" ] && tp_nft_table_present; then
    echo "-- nft 表计数（counter 随规则输出）--"
    "$TP_NFT" list table inet "$TP_NFT_TABLE" 2>/dev/null | grep -E 'counter|tproxy|skuid|skgid' | sed 's/^/  /'
  else
    echo "  （nft 表不存在，无计数）"
  fi
else
  echo "=== iptables mangle ==="
  if [ -n "$TP_IPT" ] || [ -n "$TUNHS_IPT" ]; then
    _td_ipt=${TP_IPT:-$TUNHS_IPT}
    echo "-- PREROUTING 跳转 --"
    $_td_ipt -w -t mangle -S PREROUTING 2>/dev/null | grep -i "$TP_CHAIN_PRE" | sed 's/^/  /'
    echo "-- OUTPUT 跳转 --"
    $_td_ipt -w -t mangle -S OUTPUT 2>/dev/null | grep -i "$TP_CHAIN_OUT" | sed 's/^/  /'
    for _td_c in "$TP_CHAIN_PRE" "$TP_CHAIN_OUT"; do
      echo "-- 链 $_td_c --"
      $_td_ipt -w -t mangle -S "$_td_c" 2>/dev/null | sed 's/^/  /'
    done
  else echo "  iptables 缺失"; fi

  echo
  echo "=== ip6tables mangle ==="
  _td_ip6t=${TP_IP6T:-$TUNHS_IP6T}
  if [ -n "$_td_ip6t" ]; then
    echo "-- PREROUTING 跳转 --"
    $_td_ip6t -w -t mangle -S PREROUTING 2>/dev/null | grep -i "$TP_CHAIN_PRE" | sed 's/^/  /'
    echo "-- OUTPUT 跳转 --"
    $_td_ip6t -w -t mangle -S OUTPUT 2>/dev/null | grep -i "$TP_CHAIN_OUT" | sed 's/^/  /'
    for _td_c in "$TP_CHAIN_PRE" "$TP_CHAIN_OUT"; do
      echo "-- 链 $_td_c --"
      $_td_ip6t -w -t mangle -S "$_td_c" 2>/dev/null | sed 's/^/  /'
    done
  else echo "  ip6tables 缺失"; fi

  echo
  echo "=== 流量计数（判断包是否进入 TPROXY）==="
  _td_ipt=${TP_IPT:-$TUNHS_IPT}
  if [ -n "$_td_ipt" ]; then
    echo "-- PREROUTING 跳转（pkts bytes）--"
    $_td_ipt -w -t mangle -vnL PREROUTING 2>/dev/null | grep "$TP_CHAIN_PRE" | sed 's/^/  /'
    echo "-- $TP_CHAIN_PRE 规则计数 --"
    $_td_ipt -w -t mangle -vnL "$TP_CHAIN_PRE" 2>/dev/null | sed 's/^/  /'
    echo "-- $TP_CHAIN_OUT 规则计数 --"
    $_td_ipt -w -t mangle -vnL "$TP_CHAIN_OUT" 2>/dev/null | sed 's/^/  /'
  fi
fi
  echo
  echo "=== 可能冲突的 Mihomo nft TUN 表（两种 Tproxy 后端共用）==="
  if [ -n "$TP_NFT" ]; then
    if "$TP_NFT" list table inet mihomo >/dev/null 2>&1; then
      _td_auto=$("$TP_NFT" list table inet mihomo 2>/dev/null | grep -E 'redirect to|type nat hook prerouting' | sed 's/^/  /')
      if [ -n "$_td_auto" ]; then
        echo "  ⚠ inet mihomo 表存在；安装前会确认 TUN 状态及 redirect 端口监听："
        printf '%s\n' "$_td_auto"
      else
        echo "  ⚠ inet mihomo 表存在，但未发现常见 redirect 规则"
      fi
    else
      echo "  未发现 inet mihomo 表"
    fi
  else
    echo "  nft 命令不可用；iptables/Android 路径不附加安装 nft 依赖，无法检查此表"
  fi
  echo
    echo "-- 内核丢包计数（/proc/net/netstat IpExt）--"
  awk '/^IpExt:/{ if (!h) { for (i = 2; i <= NF; i++) n[i] = $i; h = 1 }
                  else { for (i = 2; i <= NF; i++) if (n[i] == "IPReversePathFilter" || n[i] == "InNoRoutes") print "  " n[i] "=" $i } }' /proc/net/netstat 2>/dev/null
  echo "-- sysctl --"
  for _td_k in net/ipv4/ip_forward net/ipv4/conf/all/rp_filter net/ipv4/conf/default/rp_filter net/ipv4/conf/all/route_localnet net/ipv4/conf/all/accept_local; do
    echo "  $_td_k = $(cat /proc/sys/$_td_k 2>/dev/null || echo ?)"
  done
  echo "-- 硬件/软件 flow offloading（开启时已建立的转发流会绕过 mangle，TPROXY 收不到包）--"
  _td_fo=$(uci -q get firewall.@defaults[0].flow_offloading 2>/dev/null)
  _td_fh=$(uci -q get firewall.@defaults[0].flow_offloading_hw 2>/dev/null)
  echo "  flow_offloading=${_td_fo:-未设置}  flow_offloading_hw=${_td_fh:-未设置}"
  echo "-- 路由决策：带 mark 的目标流量应走 lo --"
  if [ -n "$TUNHS_IP" ]; then
    _td_rg=$($TUNHS_IP route get 1.1.1.1 mark 0x1000000 2>/dev/null)
    if [ -n "$_td_rg" ]; then printf '%s\n' "$_td_rg" | head -2 | sed 's/^/  /'
    else echo "  （本 ip 不支持 route get mark，请看上方 table 252）"; fi
  fi
  echo
  echo "=== 生命周期分段（action-latest.trace；毫秒） ==="
  _td_now=$(date +%s 2>/dev/null)
  _td_trace_mt=$(stat -c %Y "$RUNDIR/action-latest.trace" 2>/dev/null || "$BUSYBOX" stat -c %Y "$RUNDIR/action-latest.trace" 2>/dev/null)
  case "$_td_now:$_td_trace_mt" in *[!0-9:]*) echo "trace 时间: 不可读" ;;
    *) echo "trace age=$((_td_now - _td_trace_mt))s" ;; esac
  cat "$RUNDIR/action-latest.trace" 2>/dev/null || echo "(无)"
  echo "=== 当前启动 core.log（LOGFILE.off 之后的增量） ==="
  _td_off=$(cat "$LOGFILE.off" 2>/dev/null); _td_size=$(wc -c < "$LOGFILE" 2>/dev/null)
  case "$_td_off:$_td_size" in *[!0-9:]*) tail -n 60 "$LOGFILE" 2>/dev/null ;;
    *) if [ "$_td_size" -gt "$_td_off" ]; then tail -c +$((_td_off + 1)) "$LOGFILE" 2>/dev/null | tail -n 80
       else echo "(当前启动后暂无 core.log 内容)"; fi ;;
  esac
  echo "=== 当前 tproxy.log 尾部（最近 40 行） ==="
  tail -n 40 "$TP_LOG" 2>/dev/null || true
  echo "=== 上一段 tproxy.log（关闭时保存，最近 80 行） ==="
  if [ -f "$TP_LOG_PREV" ]; then tail -n 80 "$TP_LOG_PREV" 2>/dev/null; else echo "(无)"; fi
  echo "=== tunhs.log 尾部（最近 40 行；观察 TUN↔Tproxy 清理次序） ==="
  tail -n 40 "$TUNHS_LOG" 2>/dev/null || true
}

tproxy_status() {
  echo "tproxy: $(tproxy_status_short)"
  echo "detect: $(tproxy_detect)"
  [ -f "$TP_STATE" ] && sed 's/^/  state: /' "$TP_STATE"
  [ -f "$TP_CFG" ] && sed 's/^/  cfg: /' "$TP_CFG"
  echo "--- tproxy.log (tail) ---"
  tail -n 12 "$TP_LOG" 2>/dev/null
  return 0
}

# 解析控制器地址与密钥，结果缓存在 API_HOST/API_SEC（同进程多次 api 调用只解析一次）
api_init() {
  [ -n "$API_CACHED" ] && return 0
  # 解析结果进程间缓存：以 config.yaml 的 size+mtime 为 key，文件没变直接读缓存，
  # 省掉每次 2 组 grep/awk/tr/sed/head 的 fork（模式切换与 5 秒状态轮询都受益）
  _ai_ck=""
  if command -v stat >/dev/null 2>&1; then
    _ai_ck=$(stat -c '%s %Y' "$CONFIG" 2>/dev/null)
  elif have_busybox; then
    _ai_ck=$("$BUSYBOX" stat -c '%s %Y' "$CONFIG" 2>/dev/null)
  fi
  if [ -n "$_ai_ck" ] && [ -f "$RUNDIR/api.cache" ]; then
    while IFS="$(printf '\t')" read -r _ck _ch _cs; do
      [ "$_ck" = "$_ai_ck" ] || continue
      API_HOST="$_ch"; API_SEC="$_cs"; API_CACHED=1
      return 0
    done < "$RUNDIR/api.cache"
  fi
  _ai_ctl=$(grep -E '^external-controller:' "$CONFIG" 2>/dev/null | awk '{print $2}' | tr -d '"' | head -1)
  _ai_ctl=${_ai_ctl##*://}
  _ai_sec=$(grep -E '^secret:' "$CONFIG" 2>/dev/null | awk '{print $2}' | sed 's/^"\(.*\)"$/\1/' | head -1)
  [ -n "$_ai_ctl" ] || { echo "ERR: 配置中无 external-controller" >&2; return 1; }
  case "$_ai_ctl" in 0.0.0.0*|"") _ai_host="127.0.0.1:${_ai_ctl#*:}";;
                 :*) _ai_host="127.0.0.1$_ai_ctl";;
                 *) _ai_host="$_ai_ctl";; esac
  API_HOST="$_ai_host"; API_SEC="$_ai_sec"; API_CACHED=1
  # 仅解析成功才写缓存；配置暂缺时保持每次现读。
  # 必须先写临时文件再 mv：浏览器远程访问时两个 CGI 请求会并发进来，
  # 直接重定向写同一文件可能留下半截内容，下一个请求就会读到错误的
  # API 地址（表现为代理列表读不到，而管理器内串行执行从不触发）。
  if [ -n "$_ai_ck" ]; then
    printf '%s\t%s\t%s\n' "$_ai_ck" "$API_HOST" "$API_SEC" > "$RUNDIR/api.cache.tmp" 2>/dev/null \
      && mv "$RUNDIR/api.cache.tmp" "$RUNDIR/api.cache" 2>/dev/null
    rm -f "$RUNDIR/api.cache.tmp" 2>/dev/null
  fi
  return 0
}

# 大响应瘦身（MH_API_TRIM=1 时生效，只用于 GET）
#
# 为什么需要：/providers/proxies 在订阅节点上百时能到几 MB —— 其中绝大部分是
# 每个节点几十上百条的延迟 history（{"time":…,"delay":…} 反复堆叠）。
# 浏览器远程要把它 base64 之后再过一层 CGI 桥，几 MB 的往返经常把通道压垮：
# httpd 收到的是空响应体，前端 res.json() 直接抛 "Unexpected end of JSON input"，
# 订阅节点于是整片只剩名字、协议类型全变「未知」（管理器走原生桥不经过 base64，
# 所以那边一直是好的 —— 典型的「一边正常一边不正常」）。
#
# 只砍旧的、留最近 3 条，而不是清空：前端的延迟正是由 history 的最后一条
# 非零 delay 推出来的（见 webroot/js/page-proxies.js 的 historyDelay），
# 清空会让所有订阅节点的延迟一并消失。留 3 条既保留延迟显示，
# 也留了「最近一次测速失败（delay=0）时往前找一个有效值」的余地。
# 实测 122 节点 × 500 条：2.9 MB → 24 KB（约 0.8%），节点数与 type 全保留。
#
# 兜底：sed 结果为空（表达式不被当前 sed 支持等）时原样吐出原始内容，
# 绝不因为「瘦身」把数据弄丢 —— 宁可慢，不可错。
api_trim_pipe() {
  _tp="$RUNDIR/api.trim.$$"
  cat > "$_tp" 2>/dev/null
  if [ -s "$_tp" ]; then
    sed -e 's/"history":[[:space:]]*\[[^]]*\(\({[^}]*},[[:space:]]*\)\{2\}\)\({[^}]*}\)\]/"history":[\1\3]/g' \
        "$_tp" 2>/dev/null > "$_tp.2"
    if [ -s "$_tp.2" ]; then cat "$_tp.2"; else cat "$_tp"; fi
    rm -f "$_tp.2" 2>/dev/null
  fi
  rm -f "$_tp" 2>/dev/null
  return 0
}

api() {
  # 只在「显式要求瘦身 + 无请求体（GET）」时走管道；
  # 其余调用保持原路径，不多一次 cat 的开销。
  if [ "${MH_API_TRIM:-0}" = "1" ] && [ -z "$3" ]; then
    _api_raw "$@" | api_trim_pipe
    return 0
  fi
  _api_raw "$@"
}

# Preserve controller error JSON on old Android curl versions too.
# -f discards the body; --fail-with-body is unavailable on many bundled curls.
_api_curl_checked() (
  umask 077
  _acc_dir=$(mktemp -d "$RUNDIR/api-curl.XXXXXX") || { echo "ERR: cannot create API response buffer" >&2; exit 1; }
  trap 'rm -rf "$_acc_dir"' 0
  trap 'exit 130' INT TERM
  if [ -n "$4" ]; then
    _acc_status=$(curl -sS --max-time "$5" -X "$1" -H "$3" -H "Content-Type: application/json" -d "$4" -o "$_acc_dir/body" -w '%{http_code}' "$2")
  else
    _acc_status=$(curl -sS --max-time "$5" -X "$1" -H "$3" -o "$_acc_dir/body" -w '%{http_code}' "$2")
  fi
  _acc_rc=$?
  [ ! -f "$_acc_dir/body" ] || cat "$_acc_dir/body"
  [ "$_acc_rc" -eq 0 ] || exit "$_acc_rc"
  case "$_acc_status" in
    2[0-9][0-9]) exit 0 ;;
    [1-5][0-9][0-9]) printf 'MH_API_HTTP_STATUS=%s\n' "$_acc_status" >&2; exit 22 ;;
    *) echo "ERR: invalid HTTP status from curl" >&2; exit 1 ;;
  esac
)

_api_raw() {
  # api <METHOD> <PATH> [JSON body]   依赖 9090 RESTful API
  method="$1"; path="$2"; body="$3"
  api_init || return 1
  url="http://$API_HOST$path"
  hdr="Authorization: Bearer $API_SEC"
  # MH_API_TIMEOUT 可缩短单次等待（status 回读用 3 秒，避免拖慢状态刷新）
  tmo=${MH_API_TIMEOUT:-8}
  # 带 body、或非 GET 方法（PUT/PATCH/DELETE）的调用：
  # wget 系只会发 GET/POST，发不了这些，所以优先 curl，没有就用 nc 手写。
  if [ -n "$body" ] || [ "$method" != "GET" ]; then
    if command -v curl >/dev/null 2>&1; then
      # 严格模式保留错误正文及 HTTP 状态；不使用丢弃正文的 -f。
      if [ "${MH_API_FAIL:-0}" = "1" ]; then
        _api_curl_checked "$method" "$url" "$hdr" "$body" "$tmo"
        return $?
      fi
      if [ -n "$body" ]; then
        curl -sS --max-time "$tmo" -X "$method" -H "$hdr" -H "Content-Type: application/json" -d "$body" "$url"
      else
        curl -sS --max-time "$tmo" -X "$method" -H "$hdr" "$url"
      fi
      return $?
    fi
    if _api_nc "$method" "$path" "$body" "$tmo"; then return 0; fi
    echo "ERR: 执行 $method 需要 curl 或 nc，当前系统两者都不可用（切换节点 / 切模式会失败，安装 Busybox 即可恢复）" >&2
    return 1
  fi
  # GET：不再凭 command -v 一命中就返回 —— 那个 wget 可能是缺 applet 的
  # toybox 软链接（"Unknown command wget"），会把后面真正可用的 busybox wget 挡住。
  # 改由 _http_client_pick 实测挑选；挑不到才报错。
  _hc=$(_http_client_pick) || {
    echo "ERR: 无可用的 HTTP 客户端（curl / wget 都不存在或无法执行，请安装 Busybox）" >&2
    return 1
  }
  _http_do_get "$_hc" "$url" "$hdr" "$tmo"
  _arc=$?
  # 真跑失败了就作废缓存：下次重新挑（本次选中的客户端可能是坏的）
  [ "$_arc" -ne 0 ] && rm -f "$RUNDIR/api.httpclient" 2>/dev/null
  return $_arc
}

# 路径段百分号编码：纯 ASCII 直接过，含空格/中文等才编码（od 缺失时逐字节编码）。
# 服务端对 %XX 正常解码；日志里仍用原文，可读性不受影响。
urlencode() {
  case "$1" in *[!A-Za-z0-9._~-]*)
    if command -v od >/dev/null 2>&1; then
      printf '%s' "$1" | od -A n -v -t x1 | tr -d ' \n' | sed 's/\([0-9a-fA-F][0-9a-fA-F]\)/%\1/g'
    else
      _ue_s=$1; _ue_o=""
      while [ -n "$_ue_s" ]; do
        _ue_c=${_ue_s%"${_ue_s#?}"}; _ue_s=${_ue_s#?}
        case "$_ue_c" in [A-Za-z0-9._~-]) _ue_o="$_ue_o$_ue_c" ;; *) _ue_o="$_ue_o$(printf '%%%02x' "'$_ue_c")" ;; esac
      done
      printf '%s' "$_ue_o"
    fi ;;
  *) printf '%s' "$1" ;; esac
}

# 把 p:名 / r:名 行拆成 _us_t(p/r) 与 _us_n(去首尾引号的名)
_us_split() {
  _us_t=${1%"${1#?}"}; _us_n=${1#??}
  _us_n=${_us_n#'"'}; _us_n=${_us_n%'"'}; _us_n=${_us_n#"'"}; _us_n=${_us_n%"'"}
}

# 订阅更新进度上报（detail 明细来自文件，逐行转 JSON 字符串）
us_emit() {
  # $1 stage $2 done $3 total $4 ok $5 fail $6 skipped
  _ue_d=$(sed 's/\\/\\\\/g; s/"/\\"/g' "$RUNDIR/_us_detail.txt" 2>/dev/null | sed 's/.*/"&"/' | paste -sd, - 2>/dev/null)
  case "$6" in ''|*[!0-9]*) _ue_s=0 ;; *) _ue_s=$6 ;; esac
  printf '{"stage":"%s","done":%s,"total":%s,"ok":%s,"fail":%s,"skipped":%s,"detail":[%s]}\n' \
    "$1" "$2" "$3" "$4" "$5" "$_ue_s" "${_ue_d:-}" > "$US_STATUS" 2>/dev/null
}

# 更新全部订阅（前台，秒回）：mihomo 的 PUT 更新是同步阻塞的（订阅抓完才回 204），
# 串行等等于把 UI 钉死；这里只负责建任务丢后台，进度走 US_STATUS 文件轮询。
# 输出 started <总数> / ALREADY_RUNNING / OK: 无需更新 / ERR: ...
update_subs() {
  command -v curl >/dev/null 2>&1 || { echo "ERR: 系统无 curl，无法更新订阅"; return 1; }
  api_init || return 1
  [ -f "$CONFIG" ] || { echo "ERR: 配置文件不存在"; return 1; }
  if [ -f "$US_PID" ] && kill -0 "$(cat "$US_PID" 2>/dev/null)" 2>/dev/null; then
    echo "ALREADY_RUNNING"; return 1
  fi
  rm -f "$US_PID"
  awk '
    function flush() { if (pname != "") { if (ptype == "file") print "SKIP:"pname > "/dev/stderr"; else print psec":"pname; pname=""; ptype="" } }
    /^proxy-providers:/ { flush(); s="p"; lvl=-1; next }
    /^rule-providers:/ { flush(); s="r"; lvl=-1; next }
    /^[^ #]/ { flush(); s=""; next }
    s != "" && /^[ ]+[^ #]/ {
      line=$0; sub(/[^ ].*$/, "", line); n=length(line)
      if (lvl < 0) lvl=n
      if (n == lvl) { flush(); name=$0; sub(/^ +/, "", name); sub(/:.*$/, "", name); sub(/[ ]+$/, "", name); if (name != "") { pname=name; psec=s } }
      else if (n > lvl && $1 == "type:" && index($2, "file") > 0) { ptype="file" }
    }
    END { flush() }' "$CONFIG" 2>"$RUNDIR/_us_skip.txt" | tr -d '\r' > "$RUNDIR/_subs.txt"
  _us_skip=$(grep -c '^SKIP:' "$RUNDIR/_us_skip.txt" 2>/dev/null)
  case "$_us_skip" in ''|*[!0-9]*) _us_skip=0 ;; esac
  printf '%s' "$_us_skip" > "$RUNDIR/_us_skip.txt"
  _us_total=$(wc -l < "$RUNDIR/_subs.txt" 2>/dev/null | tr -d ' ')
  case "$_us_total" in ''|*[!0-9]*) _us_total=0 ;; esac
  if [ "$_us_total" -eq 0 ]; then
    rm -f "$RUNDIR/_subs.txt"
    echo "OK: 未发现订阅（配置中无 proxy/rule-providers），无需更新"; return 0
  fi
  rm -f "$RUNDIR"/_us_code.* "$RUNDIR"/_us_name.*
  : > "$RUNDIR/_us_detail.txt"
  us_emit "updating" 0 "$_us_total" 0 0 "$_us_skip"
  reset_log "$US_LOG"
  nohup sh "$0" _us-run >> "$US_LOG" 2>&1 &
  echo $! > "$US_PID"
  echo "started $_us_total"
  return 0
}

# 更新单个订阅（走 update-subs 同一套后台+进度机制，前台秒回）
# 用法: update-sub <p|r> <name>；输出 started 1 / ALREADY_RUNNING / ERR: ...
update_one_sub() {
  _uo_t=$1; _uo_n=$2
  command -v curl >/dev/null 2>&1 || { echo "ERR: 系统无 curl，无法更新订阅"; return 1; }
  api_init || return 1
  [ -n "$_uo_n" ] || { echo "ERR: 缺少订阅名"; return 1; }
  case "$_uo_t" in p|r) ;; *) _uo_t=p ;; esac
  if [ -f "$US_PID" ] && kill -0 "$(cat "$US_PID" 2>/dev/null)" 2>/dev/null; then
    echo "ALREADY_RUNNING"; return 1
  fi
  rm -f "$US_PID"
  printf '%s:%s\n' "$_uo_t" "$_uo_n" | tr -d '\r' > "$RUNDIR/_subs.txt"
  printf '0' > "$RUNDIR/_us_skip.txt"
  rm -f "$RUNDIR"/_us_code.* "$RUNDIR"/_us_name.*
  : > "$RUNDIR/_us_detail.txt"
  us_emit "updating" 0 1 0 0 0
  reset_log "$US_LOG"
  nohup sh "$0" _us-run >> "$US_LOG" 2>&1 &
  echo $! > "$US_PID"
  echo "started 1"
  return 0
}

# 订阅更新日志（US_LOG 每次任务从空开始，记启停+明细）
_us_log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$US_LOG" 2>/dev/null; }

# 订阅更新任务本体（内部命令，后台跑）：全部 PUT 并行打出去，每秒汇总进度。
# US_CURL_MAXTIME 单订阅上限（默认 60s，同步接口必须给足）、US_DEADLINE 总上限（默认 75s）。
_us_run() {
  _ur_t0=$(date +%s 2>/dev/null)
  _ur_max=${US_CURL_MAXTIME:-60}; _ur_end=${US_DEADLINE:-75}
  case "$_ur_max" in ''|*[!0-9]*) _ur_max=60 ;; esac
  case "$_ur_end" in ''|*[!0-9]*) _ur_end=75 ;; esac
  _ur_skip=$(cat "$RUNDIR/_us_skip.txt" 2>/dev/null)
  case "$_ur_skip" in ''|*[!0-9]*) _ur_skip=0 ;; esac
  if ! api_init >/dev/null 2>&1; then
    printf '✗ 控制器解析失败\n' > "$RUNDIR/_us_detail.txt"
    _us_log "更新失败：控制器解析失败"
    us_emit "done" 0 0 0 1 "$_ur_skip"; rm -f "$US_PID" "$RUNDIR/_us_detail.txt" "$RUNDIR/_us_detail.txt.tmp"; exit 1
  fi
  _ur_list=$RUNDIR/_subs.txt
  _ur_n=0
  if [ -f "$_ur_list" ]; then
    while read -r _ur_e <&3; do
      [ -n "$_ur_e" ] || continue
      _us_split "$_ur_e"
      [ -n "$_us_n" ] || continue
      case "$_us_t" in p) _ur_kind="proxies" ;; r) _ur_kind="rules" ;; *) continue ;; esac
      _ur_n=$((_ur_n+1))
      printf '%s' "$_us_n" > "$RUNDIR/_us_name.$_ur_n"
      _ur_k="$_ur_kind"; _ur_nm="$_us_n"; _ur_i="$_ur_n"
      ( _cc=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time "$_ur_max" -X PUT \
          -H "Authorization: Bearer $API_SEC" "http://$API_HOST/providers/$_ur_k/$(urlencode "$_ur_nm")" 2>/dev/null) \
          || _cc="000"
        printf '%s' "$_cc" > "$RUNDIR/_us_code.$_ur_i" ) &
    done 3< "$_ur_list"
  fi
  _ur_total="$_ur_n"
  _us_log "更新开始：共 $_ur_total 个订阅（跳过本地文件 $_ur_skip 个）"
  _ur_el=0
  while :; do
    _ur_done=0; _ur_ok=0; _ur_fail=0
    : > "$RUNDIR/_us_detail.txt.tmp"
    _ur_i=0
    while [ "$_ur_i" -lt "$_ur_total" ]; do
      _ur_i=$((_ur_i+1))
      [ -f "$RUNDIR/_us_code.$_ur_i" ] || continue
      _ur_done=$((_ur_done+1))
      _ur_cc=$(cat "$RUNDIR/_us_code.$_ur_i" 2>/dev/null)
      _ur_nm=$(cat "$RUNDIR/_us_name.$_ur_i" 2>/dev/null)
      case "$_ur_cc" in
        2*) _ur_ok=$((_ur_ok+1)); printf '✓ %s\n' "$_ur_nm" >> "$RUNDIR/_us_detail.txt.tmp" ;;
        000) _ur_fail=$((_ur_fail+1)); printf '✗ %s (超时)\n' "$_ur_nm" >> "$RUNDIR/_us_detail.txt.tmp" ;;
        *) _ur_fail=$((_ur_fail+1)); printf '✗ %s (%s)\n' "$_ur_nm" "$_ur_cc" >> "$RUNDIR/_us_detail.txt.tmp" ;;
      esac
    done
    mv "$RUNDIR/_us_detail.txt.tmp" "$RUNDIR/_us_detail.txt" 2>/dev/null
    if [ "$_ur_done" -ge "$_ur_total" ]; then break; fi
    _ur_el=$((_ur_el+1))
    if [ "$_ur_el" -ge "$_ur_end" ]; then
      _ur_i=0
      while [ "$_ur_i" -lt "$_ur_total" ]; do
        _ur_i=$((_ur_i+1))
        [ -f "$RUNDIR/_us_code.$_ur_i" ] && continue
        _ur_nm=$(cat "$RUNDIR/_us_name.$_ur_i" 2>/dev/null)
        printf '✗ %s (超时)\n' "$_ur_nm" >> "$RUNDIR/_us_detail.txt"
        _ur_fail=$((_ur_fail+1))
      done
      _ur_done="$_ur_total"
      _us_log "总超时（${_ur_end}s）：剩余未完成记为超时"
      break
    fi
    us_emit "updating" "$_ur_done" "$_ur_total" "$_ur_ok" "$_ur_fail" "$_ur_skip"
    sleep 1
  done
  us_emit "done" "$_ur_done" "$_ur_total" "$_ur_ok" "$_ur_fail" "$_ur_skip"
  sed 's/^/  /' "$RUNDIR/_us_detail.txt" >> "$US_LOG" 2>/dev/null
  _us_log "更新完成：成功 $_ur_ok，失败 $_ur_fail（共 $_ur_total 个，耗时 $(($(date +%s) - _ur_t0))s）"
  rm -f "$US_PID" "$RUNDIR"/_us_code.* "$RUNDIR"/_us_name.* "$RUNDIR/_subs.txt" "$RUNDIR/_us_skip.txt" "$RUNDIR/_us_detail.txt" "$RUNDIR/_us_detail.txt.tmp"
}

# 一键切换运行模式：PATCH + 断开存量连接 + 回读校验，一次调用内完成。
# 模式切换只约束新连接：存量长连接（视频/下载/长轮询）会保持旧路由几分钟，
# 不关闭它们，用户体感就是"点了切换但没生效"。断开后各应用自动重建连接，新模式立即全面生效。
switch_mode() {
  case "$1" in rule|global|direct) : ;; *) echo "ERR: 未知模式: $1"; return 1 ;; esac
  # 点击响应提速：关键路径只保留一次 HTTP 请求。
  #  - PATCH /configs 带 -f 校验（MH_API_FAIL=1：非 2xx 即失败），请求成功即切换生效，
  #    不做 GET /configs 回读（省一次 curl 启动 + 一次 HTTP 往返）；
  #  - 断存量连接（DELETE /connections）移入后台：PATCH 之后新连接已按新模式路由，
  #    存量连接晚几百毫秒断开不影响正确性，没必要阻塞点击响应（原本失败也忽略）；
  #  - 后台子壳先重定向 stdio，避免孙进程握着 CGI/原生桥的输出管道拖住回包。
  MH_API_FAIL=1 MH_API_TIMEOUT=3 api PATCH /configs "{\"mode\":\"$1\"}" >/dev/null 2>&1 \
    || { echo "ERR: 控制器不可达，切换失败"; return 1; }
  ( MH_API_TIMEOUT=3 api DELETE /connections >/dev/null 2>&1 ) </dev/null >/dev/null 2>&1 &
  echo "OK: 已切换到 $1"
  live_invalidate 2>/dev/null
  ( boot_data_sync ) >/dev/null 2>&1 &
}

# ---------------- eBPF 环境自检 ----------------

check_env() {
  # eBPF 入站环境自检：输出宽松可解析的 JSON（WebUI parseJsonLoose）。
  # 探测项对齐 liuran001/mihomo docs/ebpf-inbound.md：cgroup v2 必需、bpf 文件系统、
  # 内核编译选项（BPF/BPF_SYSCALL/CGROUP_BPF 必需，BPF_JIT 推荐，NET_CLS_BPF shared TC 需要）、
  # BPF 系统调用运行时探测、TCX（内核 ≥6.6）、memlock、unprivileged_bpf_disabled。
  # 检测不到的输出 null/空串，由 WebUI 显示「未知」，不臆断。
  echo "{"
  echo "\"kernel\": \"$(uname -r)\","
  echo "\"arch\": \"$(uname -m)\","
  # cgroup v2：以 /proc/mounts 实际挂载为准（内核入站 v1 直接拒绝；路径留空时入站同样按此自动探测）
  CG2_PATH=$(awk '$3=="cgroup2"{print $2; exit}' /proc/mounts 2>/dev/null)
  [ -n "$CG2_PATH" ] && cg=1 || cg=0
  echo "\"cgroup_v2\": $cg,"
  echo "\"cgroup_path\": \"${CG2_PATH:-/sys/fs/cgroup}\","
  # bpf 文件系统：编译进内核 + 实际挂载（挂载点通常 /sys/fs/bpf）
  grep -qw bpf /proc/filesystems 2>/dev/null && bpffs=1 || bpffs=0
  BPF_MNT=$(awk '$3=="bpf"{print $2; exit}' /proc/mounts 2>/dev/null)
  [ -n "$BPF_MNT" ] && bpfm=1 || bpfm=0
  echo "\"bpf_fs\": $bpffs,"
  echo "\"bpf_mount\": $bpfm,"
  echo "\"bpf_mount_path\": \"${BPF_MNT:-}\","
  # 内核编译选项（/proc/config.gz 存在才可查；值为 y/m/n，取不到为空 = 未知）
  kcfg() { [ -e /proc/config.gz ] || return 0; v=$(gunzip -c /proc/config.gz 2>/dev/null | grep "^CONFIG_$1=" | head -1 | cut -d= -f2); echo "${v:-n}"; }
  [ -e /proc/config.gz ] && cgz=1 || cgz=0
  echo "\"config_gz\": $cgz,"
  echo "\"k_bpf\": \"$(kcfg BPF)\","
  echo "\"k_bpf_syscall\": \"$(kcfg BPF_SYSCALL)\","
  echo "\"k_cgroup_bpf\": \"$(kcfg CGROUP_BPF)\","
  echo "\"k_bpf_jit\": \"$(kcfg BPF_JIT)\","
  echo "\"k_net_cls_bpf\": \"$(kcfg NET_CLS_BPF)\","
  # BPF 系统调用运行时探测：有 bpftool 才做真实探测（feature probe 全量探测较慢，失败再试轻量 btf）
  if command -v bpftool >/dev/null 2>&1; then
    echo "\"bpftool\": 1,"
    if bpftool feature probe kernel >/dev/null 2>&1; then probe=1
    elif bpftool btf list >/dev/null 2>&1; then probe=1
    else probe=0; fi
    echo "\"bpf_syscall\": $probe,"
  else
    echo "\"bpftool\": 0,"
    echo "\"bpf_syscall\": null,"
  fi
  # TCX：内核 ≥6.6 且 tc-priority=1 时经 TCX 挂载，否则回落 clsact 过滤器
  tcx=$(awk -v k="$(uname -r | cut -d. -f1-2)" 'BEGIN{split(k,p,"."); print (p[1]>6 || (p[1]==6 && p[2]>=6)) ? 1 : 0}')
  echo "\"tcx\": $tcx,"
  # RLIMIT_MEMLOCK 软限制（KB 或 unlimited；eBPF 地图占用它，root 下通常不受限）
  echo "\"memlock_kb\": \"$(ulimit -l 2>/dev/null || echo unknown)\","
  echo "\"unprivileged_bpf_disabled\": \"$(cat /proc/sys/kernel/unprivileged_bpf_disabled 2>/dev/null || echo unknown)\","
  # 默认路由网卡（local 数据面 data-plane=tc 抓默认接口的 egress）
  echo "\"default_iface\": \"$(awk '$2=="00000000"{print $1; exit}' /proc/net/route 2>/dev/null)\","
  # 网卡列表（排除 lo）
  echo "\"ifaces\": \"$(ls /sys/class/net/ 2>/dev/null | grep -v "^lo$" | tr '\n' ',' | sed 's/,$//')\""
  echo "}"
}

# ---------------- 状态输出 ----------------

# 运行中则从 RESTful API 回读实时 mode（供 WebUI 显示，避免前端再发一次请求）
# 关键：切换模式走的是 PATCH，不落盘 config.yaml，因此必须以 API 的实时值为准
api_mode() {
  command -v curl >/dev/null 2>&1 || return 0
  _am_r=$(MH_API_TIMEOUT=1 api GET /configs 2>/dev/null)
  # mihomo 返回的是紧凑 JSON（"mode":"rule"），纯参数展开即可取值，省 tr/sed/head 三次 fork；
  # 取最后一次出现，与下面 sed 的贪婪匹配语义一致。带空格等非常规格式再回落 sed。
  case "$_am_r" in
    *\"mode\":\"*)
      _am_v=${_am_r##*\"mode\":\"}; _am_v=${_am_v%%\"*}
      case "$_am_v" in *[[:cntrl:]]*|*\\*) ;; *) printf '%s\n' "$_am_v"; return 0 ;; esac ;;
  esac
  printf '%s' "$_am_r" | tr -d '\n' \
    | sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

# ps etime（D-HH:MM:SS / HH:MM:SS / MM:SS）→ 整秒
etime_to_sec() {
  # 入参可能带换行（ps 的空行），先压成单行再算，否则 awk 会逐行输出、结果里夹换行
  s=$(printf '%s' "$1" | tr -d ' \t\r\n')
  [ -z "$s" ] && { echo ""; return 1; }
  d=0
  case "$s" in
    *-*) d=${s%%-*}; s=${s#*-} ;;
  esac
  echo "$s" | awk -F: -v d="$d" '{
    n = NF;
    if (n < 2) { print ""; next; }
    sec = $n; min = $(n-1); hr = (n >= 3 ? $(n-2) : 0);
    if (sec !~ /^[0-9]+$/ || min !~ /^[0-9]+$/ || hr !~ /^[0-9]+$/) { print ""; next; }
    print d*86400 + hr*3600 + min*60 + sec;
  }'
}

# 内核运行时长：直接读 /proc（两次 builtin read，零 fork），成功则设置
# _pu_sec（秒）与 _pu_etime（ps etime 风格 [[D-]HH:]MM:SS 字符串）。
# /proc/<pid>/stat 第 22 字段 starttime 单位是 USER_HZ（Linux 上固定 100），
# 与 ps -o etime 的算法相同（uptime - starttime/100，整秒截断）。失败返回 1 → 回落 ps。
proc_uptime() {
  _pu_sec=""; _pu_etime=""
  [ -n "$1" ] || return 1
  # 2>/dev/null 必须写在 < 前面：重定向从左到右生效，进程刚退出时 open 失败的报错才不会漏到 stderr
  read -r _pu_now _pu_idle 2>/dev/null < /proc/uptime || return 1
  read -r _pu_st 2>/dev/null < "/proc/$1/stat" || return 1
  _pu_st=${_pu_st##*) }        # 去掉 "pid (comm) "：comm 可能含空格/括号，只能按最后一个 ")" 切
  set -- $_pu_st               # 之后 $1=state $2=ppid … 原第 22 字段 starttime 在这里是第 20 个
  _pu_start=${20:-}
  _pu_now=${_pu_now%%.*}
  case "$_pu_start" in ''|*[!0-9]*) return 1 ;; esac
  case "$_pu_now" in ''|*[!0-9]*) return 1 ;; esac
  _pu_sec=$(( _pu_now - _pu_start / 100 ))
  [ "$_pu_sec" -ge 0 ] 2>/dev/null || _pu_sec=0
  _pu_d=$(( _pu_sec / 86400 )); _pu_h=$(( _pu_sec % 86400 / 3600 ))
  _pu_m=$(( _pu_sec % 3600 / 60 )); _pu_s=$(( _pu_sec % 60 ))
  [ "$_pu_h" -lt 10 ] && _pu_h=0$_pu_h
  [ "$_pu_m" -lt 10 ] && _pu_m=0$_pu_m
  [ "$_pu_s" -lt 10 ] && _pu_s=0$_pu_s
  if [ "$_pu_d" -gt 0 ]; then _pu_etime="$_pu_d-$_pu_h:$_pu_m:$_pu_s"
  elif [ "$_pu_h" != "00" ]; then _pu_etime="$_pu_h:$_pu_m:$_pu_s"
  else _pu_etime="$_pu_m:$_pu_s"; fi
  return 0
}

# status_json 专用：一趟 awk 同时取 mode / external-controller / mixed-port / tun.enable / 是否有 tun 监听器，
# 代替原来 3 组 grep|awk|tr|head 管道 + tunhs_tun_enabled 的 awk+grep（共 10 余次 fork）。
# 语义与各自的单独实现保持一致：mode / external-controller / mixed-port 取首个顶层匹配行的第 2 列（去双引号）；
# tun.enable 取顶层 tun: 块内首个 enable:；监听器判定同 tunhs_tun_enabled 的 grep。
# 输出 5 行（值可能为空行），调用方逐行 read。
config_proxy_mode() {
  (
    CONFIG=${1:-$CONFIG}
    if [ "$(get_setting tproxy false)" = true ]; then echo tproxy
    elif tunhs_tun_enabled; then echo tun
    elif ebpf_listener_active; then echo ebpf
    else echo none; fi
  )
}

status_cfg_scan() {
  _ss_cfg=${1:-$CONFIG}
  [ -f "$_ss_cfg" ] || { printf '\n\n\n\n0\n'; return 0; }
  awk '
    /^[^ \t#-]/ { inb = ($1 == "tun:") }
    /^mode:/ && !mf { m = $2; mf = 1 }
    /^external-controller:/ && !cf { c = $2; cf = 1 }
    /^mixed-port:/ && !mpf { mp = $2; mpf = 1 }
    inb && /^tun:[ \t]*\{/ && !tf && match($0, /enable:[ \t]*/) {
      te = substr($0, RSTART + RLENGTH); sub(/[,}].*$/, "", te); sub(/[ \t]+$/, "", te); tf = 1
    }
    inb && $1 == "enable:" && !tf { te = $2; tf = 1 }
    /^[ \t]*(-[ \t]+)?type:[ \t]*["'"'"']?tun["'"'"']?([ \t]|$)/ { tl = 1 }
    END { gsub(/"/, "", m); gsub(/"/, "", c); gsub(/"/, "", mp); gsub(/["\047]/, "", te); print m; print c; print mp; print te; print (tl ? 1 : 0) }
  ' "$_ss_cfg" 2>/dev/null
}

# ---------------- CPU / 内存占用：/proc 零 fork 跨读数差分 ----------------
# /proc/<pid>/stat 的 utime+stime 是累计 tick 数，「占用率」必须跨时间窗做差。
# status_json 不 sleep 等窗口（每次 status 都在 UI 轮询关键路径上，多等 200ms 就是
# 肉眼可见的顿挫）：基线持久化在 CPU_SAMPLE（pid ticks ms p10），每次 status 读到
# 「本次累计 − 上次累计」即该窗口的占用率。
#   - 窗口 < 2s（连发轮询太近）：不复算，沿用上次结果、保留旧基线，避免短窗口噪声；
#   - 基线 pid 不符（内核重启）或文件缺失：本轮只存基线（标记为首次窗口）、cpu 输出 null，
#     600ms 后的补读就出真值；
#   - cpu_wait_ms：本轮没出真值时要等多久（毫秒），前端据此精确排补读，不必盲等 2.5s；
#   - p10 为 decipct（40 = 4.0%），-1 表示尚未算出；上限 10000（1000%）兜底。
# 时间戳用 /proc/uptime（开机秒 + 百分秒，与 tick 同一内核时钟，单调无跳变，10ms 精度）：
#   * 绝不用 EPOCHREALTIME + 10# 基数前缀 —— dash / 老 busybox ash 的算术解析器不认
#     10#，赋值失败会让 _rs_ms 为空、函数静默返回 null（实测 bug：真机 CPU 永远「—」）；
#   * 绝不用 date：多一次 fork，还要担心 %N 支持差异。
# 本函数只允许 POSIX 算术与字符串操作（与 proc_uptime 同等保守），任何分支失败都把
# 原因写进 _rs_dbg 并随 status JSON 带出（cpu_dbg 字段），界面上直接可见、可截图反馈。
# RSS 直接读 statm（常驻页 × 页大小），单点即得，无需差分。
# 前端按 uptime 同款定点更新（不进 statusSig），不会周期性整页重绘。
CPU_SAMPLE=$RUNDIR/cpu.sample
CPU_SAMPLE_MIN_MS=2000
# 首次窗口下限：基线是「刚建立」的（CPU_SAMPLE 第 5 字段为 1，由 _cpu_baseline_seed /
# 首读路径写下）时，只要 600ms 就出一个真值 —— 内核刚被 action.sh 启动、用户立刻进主页
# 是最常见的路径，界面不该在「…」上等满 2 秒。窗口仍然是真的跨读数差分，只是短一些
# （CLK_TCK=100 时 600ms ≈ 10 tick，分辨率约 1.7%，够用；稳态读数照旧回到 2s）。
CPU_SAMPLE_FIRST_MS=600
_RS_HZ=""; _RS_PGSZ=""
rs_sysinfo() {
  # getconf 会 fork，单条命令生命周期内只取一次；回落值覆盖没有 getconf 的环境
  [ -n "$_RS_HZ" ] && [ -n "$_RS_PGSZ" ] && return 0
  _RS_HZ=$(getconf CLK_TCK 2>/dev/null)
  case "$_RS_HZ" in ''|*[!0-9]*) _RS_HZ=100 ;; esac
  _RS_PGSZ=$(getconf PAGESIZE 2>/dev/null)
  case "$_RS_PGSZ" in ''|*[!0-9]*) _RS_PGSZ=4096 ;; esac
}
# 原子写基线（tmp + mv）：两个 status 并发时不会读到半行
# $1=pid $2=ticks $3=ms $4=decipct $5=是否「首次窗口」（可省，默认 0）
_rs_w() {
  _rs_tmp=$CPU_SAMPLE.$$
  printf '%s %s %s %s %s\n' "$1" "$2" "$3" "$4" "${5:-0}" > "$_rs_tmp" 2>/dev/null \
    && mv -f "$_rs_tmp" "$CPU_SAMPLE" 2>/dev/null || rm -f "$_rs_tmp" 2>/dev/null
  return 0
}
# $1=pid → _rs_cpu（JSON 数值如 4.0，或 null）、_rs_memk（RSS KiB，读不到为 0）、_rs_dbg（诊断）
proc_res_usage() {
  _rs_cpu="null"; _rs_memk=0; _rs_dbg="wait"; _rs_wait=0
  [ -n "$1" ] || { _rs_dbg="nopid"; return 0; }
  _rs_pid=$1   # 解析 stat 的 set -- 会覆盖位置参数，先存住 pid（与 proc_uptime 同理）
  rs_sysinfo
  # RSS：statm 第 2 字段为常驻页数（零 fork）。read 的最后一个变量会吃掉整行剩余
  # （含第 3~7 字段），必须用 %% * 只切第二 token
  read -r _rs_a _rs_rest 2>/dev/null < "/proc/$_rs_pid/statm" || { _rs_dbg="statm"; return 0; }
  _rs_rss=${_rs_rest%% *}
  case "$_rs_rss" in ''|*[!0-9]*) _rs_dbg="rss"; return 0 ;; esac
  _rs_memk=$(( _rs_rss * _RS_PGSZ / 1024 ))
  # 毫秒时间戳：/proc/uptime 第 1 字段（秒 + 2 位百分秒）
  read -r _rs_ut _ 2>/dev/null < /proc/uptime || { _rs_dbg="uptime"; return 0; }
  case "$_rs_ut" in ''|*[!0-9.]*|*.*.*) _rs_dbg="utfmt"; return 0 ;; esac
  _rs_ut_s=${_rs_ut%%.*}
  _rs_ut_f=${_rs_ut#*.}
  case "$_rs_ut" in *.*) ;; *) _rs_ut_f=00 ;; esac   # 无小数点（极少见）：百分秒按 0
  [ -n "$_rs_ut_f" ] || _rs_ut_f=00
  case "$_rs_ut_f" in *[!0-9]*) _rs_dbg="utfmt"; return 0 ;; esac
  case ${#_rs_ut_f} in
    1) _rs_ut_f=${_rs_ut_f}0 ;;
    2) ;;
    *) _rs_ut_f=${_rs_ut_f%"${_rs_ut_f#??}"} ;;
  esac
  case "$_rs_ut_f" in 0*) _rs_ut_f=${_rs_ut_f#0} ;; esac   # 去掉前导 0，避免任何八进制歧义
  [ -n "$_rs_ut_f" ] || _rs_ut_f=0
  _rs_ms=$(( _rs_ut_s * 1000 + _rs_ut_f * 10 ))
  # CPU：去掉 "pid (comm) " 后 utime=第12字段 stime=第13字段（与 proc_uptime 同切法）。
  # token 循环直接取字段，不用 set --（免位置参数被覆盖的副作用，见 _cpu_baseline_seed）
  read -r _rs_st 2>/dev/null < "/proc/$_rs_pid/stat" || { _rs_dbg="stat"; return 0; }
  _rs_st=${_rs_st##*) }
  # 第 12/13 = utime/stime，第 20 = starttime（开机以来 tick，proc_uptime 同款编号）
  _rs_i=0; _rs_f12=""; _rs_f13=""; _rs_f20=""
  for _rs_tok in $_rs_st; do
    _rs_i=$((_rs_i + 1))
    [ "$_rs_i" -eq 12 ] && _rs_f12=$_rs_tok
    [ "$_rs_i" -eq 13 ] && _rs_f13=$_rs_tok
    [ "$_rs_i" -eq 20 ] && { _rs_f20=$_rs_tok; break; }
  done
  case "$_rs_f12" in ''|*[!0-9]*) _rs_dbg="stat12"; return 0 ;; esac
  case "$_rs_f13" in ''|*[!0-9]*) _rs_dbg="stat13"; return 0 ;; esac
  _rs_ticks=$(( _rs_f12 + _rs_f13 ))
  # 生命期均值（占位值）：累计 tick ÷ 进程已运行时长。还没有差分窗口时用它先给
  # 界面一个数（dbg=avg），2.5s 后的补读会换成实时窗口值。稳态长跑的内核（mihomo
  # 常开）两者接近；内核刚起 <1s 时不产出（窗口值马上就有）。
  _rs_provi=-1
  case "$_rs_f20" in
    ''|*[!0-9]*) ;;
    *)
      _rs_pup=$(( _rs_ms - _rs_f20 * 1000 / _RS_HZ ))
      if [ "$_rs_pup" -ge 1000 ] 2>/dev/null; then
        _rs_provi=$(( _rs_ticks * 1000000 / (_RS_HZ * _rs_pup) ))
        [ "$_rs_provi" -gt 10000 ] 2>/dev/null && _rs_provi=10000
      fi ;;
  esac
  _rs_p_pid=""; _rs_p_t=""; _rs_p_ms=""; _rs_p_p10=-1; _rs_p_first=0
  [ -f "$CPU_SAMPLE" ] && read -r _rs_p_pid _rs_p_t _rs_p_ms _rs_p_p10 _rs_p_first 2>/dev/null < "$CPU_SAMPLE"
  case "$_rs_p_ms" in ''|*[!0-9]*) _rs_p_ms="" ;; esac
  case "$_rs_p_p10" in ''|*[!0-9]*) _rs_p_p10=-1 ;; esac
  case "$_rs_p_first" in ''|*[!0-9]*) _rs_p_first=0 ;; esac
  # 首次窗口（基线刚建立）只要 600ms 就出真值；出过一次真值后回到 2s 稳态窗口
  _rs_min=$CPU_SAMPLE_MIN_MS
  [ "$_rs_p_first" = "1" ] && _rs_min=$CPU_SAMPLE_FIRST_MS
  if [ "$_rs_p_pid" = "$_rs_pid" ] && [ -n "$_rs_p_ms" ]; then
    _rs_dt=$(( _rs_ms - _rs_p_ms ))
    if [ "$_rs_dt" -ge "$_rs_min" ] 2>/dev/null; then
      _rs_dtk=$(( _rs_ticks - _rs_p_t ))
      [ "$_rs_dtk" -lt 0 ] 2>/dev/null && _rs_dtk=0
      # cpu% = (Δticks / CLK_TCK) / (Δms / 1000) × 100，保留一位小数（p10）
      _rs_p10=$(( _rs_dtk * 1000000 / (_RS_HZ * _rs_dt) ))
      [ "$_rs_p10" -lt 0 ] 2>/dev/null && _rs_p10=0
      [ "$_rs_p10" -gt 10000 ] 2>/dev/null && _rs_p10=10000
      _rs_cpu="$(( _rs_p10 / 10 )).$(( _rs_p10 % 10 ))"
      _rs_dbg="ok"
      _rs_wait=0
      # 已出真值：基线改回稳态窗口（第 5 字段 0），后续读数按 2s 采样
      _rs_w "$_rs_pid" "$_rs_ticks" "$_rs_ms" "$_rs_p10" 0
    else
      _rs_dbg="short"
      # 还差多少毫秒才够窗口：前端拿它排补读（下限 60ms，免得排出一串 0ms 的连环读）
      _rs_wait=$(( _rs_min - _rs_dt ))
      [ "$_rs_wait" -lt 60 ] 2>/dev/null && _rs_wait=60
      if [ "$_rs_p_p10" -ge 0 ] 2>/dev/null; then
        _rs_cpu="$(( _rs_p_p10 / 10 )).$(( _rs_p_p10 % 10 ))"
      elif [ "$_rs_provi" -ge 0 ] 2>/dev/null; then
        _rs_cpu="$(( _rs_provi / 10 )).$(( _rs_provi % 10 ))"
        _rs_dbg="avg"
      fi
    fi
  else
    _rs_dbg="new"
    [ "$_rs_provi" -ge 0 ] 2>/dev/null && { _rs_cpu="$(( _rs_provi / 10 )).$(( _rs_provi % 10 ))"; _rs_dbg="avg"; }
    # 新基线按「首次窗口」记：600ms 后的补读就有真值（内核刚启动的主路径）
    _rs_w "$_rs_pid" "$_rs_ticks" "$_rs_ms" -1 1
    _rs_wait=$CPU_SAMPLE_FIRST_MS
  fi
  return 0
}

# 内核刚启动时为它立刻写 CPU 基线（start_core 成功路径调用）：第一次 status 读数
# 就能直接算出占用率，不用把首个读数耗在「建基线」上 —— 前端少等一拍（最多 5s 心跳），
# start-json 带回的状态甚至直接带真值。纯 POSIX 读数，与 proc_res_usage 同款；
# 失败无任何副作用（下轮 status 会自然补建基线）。
_cpu_baseline_seed() {
  [ -n "$1" ] || return 0
  read -r _cb_st 2>/dev/null < "/proc/$1/stat" || return 0
  _cb_st=${_cb_st##*) }
  _cb_i=0; _cb_f12=""; _cb_f13=""
  for _cb_tok in $_cb_st; do
    _cb_i=$((_cb_i + 1))
    [ "$_cb_i" -eq 12 ] && _cb_f12=$_cb_tok
    [ "$_cb_i" -eq 13 ] && { _cb_f13=$_cb_tok; break; }
  done
  case "$_cb_f12" in ''|*[!0-9]*) return 0 ;; esac
  case "$_cb_f13" in ''|*[!0-9]*) return 0 ;; esac
  read -r _cb_ut _ 2>/dev/null < /proc/uptime || return 0
  case "$_cb_ut" in ''|*[!0-9.]*|*.*.*) return 0 ;; esac
  _cb_s=${_cb_ut%%.*}; _cb_f=${_cb_ut#*.}
  case "$_cb_ut" in *.*) ;; *) _cb_f=00 ;; esac
  [ -n "$_cb_f" ] || _cb_f=00
  case "$_cb_f" in *[!0-9]*) return 0 ;; esac
  case ${#_cb_f} in
    1) _cb_f=${_cb_f}0 ;;
    2) ;;
    *) _cb_f=${_cb_f%"${_cb_f#??}"} ;;
  esac
  case "$_cb_f" in 0*) _cb_f=${_cb_f#0} ;; esac
  [ -n "$_cb_f" ] || _cb_f=0
  # 第 5 字段 1 = 首次窗口：紧接着的第一次读数只要 600ms 差分就出真值
  _rs_w "$1" "$(( _cb_f12 + _cb_f13 ))" "$(( _cb_s * 1000 + _cb_f * 10 ))" -1 1
  return 0
}

status_json() {
  # 运行时长优先走 /proc（零 fork）；回落 ps 时输出必须逐行清洗：部分 ROM 的 `ps -o etime=`
  # 会先输出一个空行（表头被 = 置空但换行还在），只有过滤掉空行、且只取第一条含数字的行，
  # 才能保证 up 是干净的 "MM:SS" / "HH:MM:SS"
  if running; then
    run=1; pid=$_rn_pid          # running 刚读过 pid 文件，直接复用，免 $(pid_of)
    if proc_uptime "$pid"; then
      up=$_pu_etime; up_sec=$_pu_sec
    else
      up=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' \t\r' | sed -n '/[0-9]/p' | head -1)
      up_sec=$(etime_to_sec "$up")
    fi
  else
    run=0; pid=""; up=""; up_sec=""
  fi
  # epoch 必须与 etime 紧邻采样：前端用「epoch - 已运行秒数」推内核启动的绝对时刻，
  # 两次采样之间若隔着 detach_pid / awk 等 fork，其耗时波动会混进起点计算，
  # 导致前端每次轮询都把显示起点拽偏，运行时长秒数周期性卡顿/回跳。
  # mksh / 新 busybox ash 自带 EPOCHREALTIME / EPOCHSECONDS，免 date 一次 fork+exec；没有再回落
  case "${EPOCHREALTIME:-}" in
    [0-9]*) epoch_sec=${EPOCHREALTIME%%.*} ;;
    *) case "${EPOCHSECONDS:-}" in [0-9]*) epoch_sec=$EPOCHSECONDS ;; *) epoch_sec=$(date +%s 2>/dev/null) ;; esac ;;
  esac
  case "$epoch_sec" in ''|*[!0-9]*) epoch_sec=$(date +%s 2>/dev/null) ;; esac
  # CPU / 内存占用（见 proc_res_usage）：停止时没有可读进程，固定 null / 0 / stopped
  if [ "$run" = "1" ]; then proc_res_usage "$pid"; else _rs_cpu="null"; _rs_memk=0; _rs_dbg="stopped"; fi
  # 注意：这里所有「顺手做事」的调用都必须把 stdout 也丢掉。
  # 只写 2>/dev/null 时，被调函数里任何一句 echo 都会混进 JSON，
  # 前端 JSON.parse 直接失败 → 界面显示「无法获取模块状态」。
  [ "$run" = "1" ] && detach_pid "$pid" >/dev/null 2>&1   # 自愈：运行中的内核若还在 App cgroup 里（如升级前启动的），顺手迁出
  # 一趟 awk 取齐配置里的 5 个值（见 status_cfg_scan）
  mode=""; ctl=""; _sj_mp=""; _sj_te=""; _sj_tl=0
  { read -r mode; read -r ctl; read -r _sj_mp; read -r _sj_te; read -r _sj_tl; } <<MH_STATUS_CFG
$(if [ "$run" = "1" ] && [ -f "$RUNDIR/active-config.yaml" ]; then
    status_cfg_scan "$RUNDIR/active-config.yaml"
  else status_cfg_scan; fi)
MH_STATUS_CFG
  _sj_tun=0
  case "$_sj_te" in true) _sj_tun=1 ;; *) [ "$_sj_tl" = "1" ] && _sj_tun=1 ;; esac
  # mode_src 标记取值来源：live=API 实时回读，config=配置文件兜底。
  # 前端据此判断能否用回读值纠正「乐观切换记忆」（回读不可用时不能乱纠）
  mode_src="config"
  [ "$run" = "1" ] && [ "${_SJ_FAST:-}" != "1" ] && { live=$(api_mode); [ -n "$live" ] && { mode="$live"; mode_src="live"; }; }
  setting_v core jieluojun; sel=$SV
  case "$sel" in official|liuran001) : ;; *) sel=jieluojun ;; esac   # 同 core_path：其余值一律按 jieluojun
  setting_v autostart true; _sj_as=$SV
  setting_v hotspot_proxy true; _sj_hp=$SV
  setting_v system_ipv6 false; _sj_v6=$SV
  # 系统 IPv6 是否正被 eBPF 入站锁住（用户关不掉的原因提示；仅 eBPF 活跃且需 v6 路由时）
  _sj_v6lock="0"
  if ebpf_ipv6_redirect_cached; then _sj_v6lock="1"; fi
  setting_v tproxy false; _sj_tp=$SV
  if [ -f "$CONFIG" ]; then _sj_cfg=1; else _sj_cfg=0; fi
  if [ -x "$CORE_LIURAN001" ]; then _sj_lx=1; else _sj_lx=0; fi
  if [ -x "$CORE_JIELUOJUN" ]; then _sj_jx=1; else _sj_jx=0; fi
  if [ -x "$CORE_OFFICIAL" ]; then _sj_ox=1; else _sj_ox=0; fi
  # 各内核的版本缓存 key 一次 stat 取齐（缺 stat 时留空，core_version 自己兜底）
  _sj_kl=""; _sj_kj=""; _sj_ko=""
  if command -v stat >/dev/null 2>&1; then
    _sj_keys=$(stat -c '%n|%s|%Y' "$CORE_LIURAN001" "$CORE_JIELUOJUN" "$CORE_OFFICIAL" 2>/dev/null)
    _sj_nl='
'
    while [ -n "$_sj_keys" ]; do
      _sj_line=${_sj_keys%%"$_sj_nl"*}
      case "$_sj_line" in
        "$CORE_LIURAN001|"*) _sj_kl=$_sj_line ;;
        "$CORE_JIELUOJUN|"*) _sj_kj=$_sj_line ;;
        "$CORE_OFFICIAL|"*) _sj_ko=$_sj_line ;;
      esac
      [ "$_sj_line" = "$_sj_keys" ] && break
      _sj_keys=${_sj_keys#*"$_sj_nl"}
    done
  fi
  core_version_v "$CORE_LIURAN001" "$_sj_kl"; _sj_lv=$CVV
  core_version_v "$CORE_JIELUOJUN" "$_sj_kj"; _sj_jv=$CVV
  core_version_v "$CORE_OFFICIAL" "$_sj_ko"; _sj_ov=$CVV
  case "$sel" in official) _sj_cv=$_sj_ov ;; jieluojun) _sj_cv=$_sj_jv ;; *) _sj_cv=$_sj_lv ;; esac   # 同 core_path 的选择逻辑
  _sj_ths=$(tunhs_status_short "$_sj_tun")
  _sj_tps=$(tproxy_status_short)
  # 字段转义走 jv（变量版 json_str，零 fork）；输出改用 printf '%s\n'：dash/ash 的 echo 会
  # 吃掉字段里的反斜杠转义（json_str 刚加的 \\ 又被 echo 还原成 \），printf 不会
  printf '%s\n' "{"
  printf '%s\n' "\"running\": $run,"
  jv "$pid";      printf '%s\n' "\"pid\": \"$J\","
  jv "$up";       printf '%s\n' "\"uptime\": \"$J\","
  case "$up_sec" in ''|*[!0-9]*) up_sec=$(json_num "$up_sec") ;; esac       # 常规都是纯数字，免子 shell
  case "$epoch_sec" in ''|*[!0-9]*) epoch_sec=$(json_num "$epoch_sec") ;; esac
  printf '%s\n' "\"uptime_sec\": $up_sec,"
  printf '%s\n' "\"epoch_sec\": $epoch_sec,"
  jv "$sel";      printf '%s\n' "\"core\": \"$J\","
  jv "$mode";     printf '%s\n' "\"mode\": \"$J\","
  jv "$mode_src"; printf '%s\n' "\"mode_src\": \"$J\","
  jv "$_sj_as";   printf '%s\n' "\"autostart\": \"$J\","
  jv "$ctl";      printf '%s\n' "\"controller\": \"$J\","
  jv "$_sj_mp";   printf '%s\n' "\"mixed_port\": \"$J\","
  jv "$_sj_ths";  printf '%s\n' "\"tun_hotspot\": \"$J\","
  _sj_proxy_cfg=$CONFIG
  [ "$run" = 1 ] && [ -f "$RUNDIR/active-config.yaml" ] && _sj_proxy_cfg="$RUNDIR/active-config.yaml"
  jv "$(config_proxy_mode "$_sj_proxy_cfg")"; printf '%s\n' "\"proxy_mode\": \"$J\","
  jv "$_sj_hp";   printf '%s\n' "\"hotspot_proxy\": \"$J\","
  jv "$_sj_v6";   printf '%s\n' "\"system_ipv6\": \"$J\","
  printf '%s\n' "\"ipv6_locked_by\": $_sj_v6lock,"
  jv "$_sj_tp";   printf '%s\n' "\"tproxy\": \"$J\","
  jv "$_sj_tps";  printf '%s\n' "\"tproxy_state\": \"$J\","
  printf '%s\n' "\"config_exists\": $_sj_cfg,"
  printf '%s\n' "\"liuran001_exists\": $_sj_lx,"
  printf '%s\n' "\"jieluojun_exists\": $_sj_jx,"
  printf '%s\n' "\"official_exists\": $_sj_ox,"
  jv "$_sj_lv";   printf '%s\n' "\"liuran001_ver\": \"$J\","
  jv "$_sj_jv";   printf '%s\n' "\"jieluojun_ver\": \"$J\","
  jv "$_sj_ov";   printf '%s\n' "\"official_ver\": \"$J\","
  jv "$_sj_cv";   printf '%s\n' "\"current_ver\": \"$J\","
  jv "$WORKDIR";  printf '%s\n' "\"workdir\": \"$J\","
  case "$_rs_memk" in ''|*[!0-9]*) _rs_memk=0 ;; esac
  jv "$_rs_dbg";   printf '%s\n' "\"cpu_dbg\": \"$J\","
  printf '%s\n' "\"cpu_pct\": $_rs_cpu,"
  case "$_rs_wait" in ''|*[!0-9]*) _rs_wait=0 ;; esac
  printf '%s\n' "\"cpu_wait_ms\": $_rs_wait,"
  printf '%s\n' "\"mem_kib\": $_rs_memk"
  printf '%s\n' "}"
  if [ "${_SJ_FAST:-}" != "1" ]; then sync_state_desc >/dev/null 2>&1; fi
  return 0
}

# ---------------- 状态热缓存：常驻预热守护（B 方案） ----------------
# status_json 的耗时大头是 api_mode 的 curl（3s 超时）与若干 fork；每次读状态
# 都现算，首屏三路并行也要等最慢的一路。这里由一个常驻守护每 2 秒预算一次，
# 读数直接取 6 秒内的热缓存（约 10ms）；变更点作废缓存，守护缺席时自动回落现算。
# 前端只加两行（保存配置 / 切换模式后 ping 一下热缓存，其余零改动）：首屏骨架
# 只闪现约一次热读数的时间，且全应用的读数都变快。
LIVE_DIR=$RUNDIR/live
LIVE_STATUS=$LIVE_DIR/status.json
LIVE_STATUS_AT=$LIVE_DIR/status.at
LIVE_PID=$LIVE_DIR/lived.pid
LIVE_TTL=6

# 缓存新鲜即命中（两个小文件比对，一次 cat + 一次 date，约 10ms）。
live_cache_fresh() {
  [ -f "$LIVE_STATUS" ] && [ -f "$LIVE_STATUS_AT" ] || return 1
  _la=$(cat "$LIVE_STATUS_AT" 2>/dev/null)
  case "$_la" in ''|*[!0-9]*) return 1 ;; esac
  _ln=$(date +%s 2>/dev/null || echo 0)
  [ $((_ln - _la)) -lt $LIVE_TTL ]
}

# stdin → 原子落盘 + 时间戳。调用方保证 stdin 是完整 status_json 输出。
# 顺序：先落 STATUS，再写 AT。AT 新鲜时 STATUS 必已是新值，避免
# “AT 新鲜但 STATUS 仍是旧 running=0”的窗口；invalidate 若在
# 中间插入则两文件不同时存在，fresh 判定失败走现算，不会命中 stale。
live_cache_store() {
  mkdir -p "$LIVE_DIR" 2>/dev/null || return 1
  _ls_tmp=$LIVE_STATUS.tmp.$$
  cat > "$_ls_tmp" 2>/dev/null || { rm -f "$_ls_tmp"; return 1; }
  mv -f "$_ls_tmp" "$LIVE_STATUS" 2>/dev/null || { rm -f "$_ls_tmp"; return 1; }
  date +%s 2>/dev/null > "$LIVE_STATUS_AT" 2>/dev/null
  return 0
}

# 作废（一次 rm，约 1ms，前台调用也无负担）。
live_invalidate() { rm -f "$LIVE_STATUS" "$LIVE_STATUS_AT" 2>/dev/null; }

# 守护单步：重算一次并入库。失败不删旧缓存（旧值至多 TTL+2 秒）。
lived_tick() {
  [ -f "$MODDIR/disable" ] && return 1
  if _lv_out=$(status_json 2>/dev/null); then
    case "$_lv_out" in '{'*'}') printf '%s' "$_lv_out" | live_cache_store ;; esac
  fi
  return 0
}

# 方案 B：彻底移除后台轮询预热守护（_lived-loop）
_lived_loop() { exit 0; }
lived_running() { return 1; }
lived_start() { return 0; }
lived_stop() { return 0; }

# status 统一入口：按需即时读取并同步模块描述，零后台轮询
status_cached() {
  _sj_out=$(status_json); _sj_rc=$?
  printf '%s\n' "$_sj_out"
  return $_sj_rc
}

# 轻量资源读数：主页 CPU / 内存徽标的实时刷新用（前端每 2 秒一次，见 app.js startResourceLoop）。
# 为什么另开一条命令，而不是把 status 心跳调快：
#   status_json 要回读 API（curl，3 秒超时）、扫配置、算 Tproxy/热点状态 —— 秒级跑一遍
#   在慢设备上就是可观的常驻开销；而 CPU / 内存只依赖 /proc（pid 文件内建判活
#   + stat/statm/uptime 三次 read），零 fork（仅首次取 CLK_TCK/PAGESIZE 各一次 getconf），
#   单次往返只有 exec 桥本身的开销。
# 采样窗口：proc_res_usage 的窗口下限 2 秒，所以前端节拍也定 2 秒 —— 更快只会读到
# 同一个窗口值（dbg=short 时沿用上一次的窗口值），白费一次桥往返。
# 输出字段与 status_json 同名同型，前端直接合并进 state.status：running/pid/cpu_pct/cpu_dbg/mem_kib。
res_json() {
  _rj_pid=""
  running && _rj_pid=$_rn_pid          # running 刚读过 pid 文件，直接复用（内建判活，零 fork）
  case "$_rj_pid" in ''|*[!0-9]*) _rj_pid="" ;; esac
  if [ -n "$_rj_pid" ]; then
    proc_res_usage "$_rj_pid"
    # _rs_cpu 已经是 JSON 数值（4.0）或 null；_rs_dbg 只可能是函数内的字面量诊断词
    case "$_rs_wait" in ''|*[!0-9]*) _rs_wait=0 ;; esac
    printf '{"running":1,"pid":"%s","cpu_pct":%s,"cpu_dbg":"%s","cpu_wait_ms":%s,"mem_kib":%s}\n' \
      "$_rj_pid" "$_rs_cpu" "$_rs_dbg" "$_rs_wait" "$_rs_memk"
  else
    printf '{"running":0,"pid":"","cpu_pct":null,"cpu_dbg":"stopped","cpu_wait_ms":0,"mem_kib":0}\n'
  fi
}

# 模块设置弹层专用的轻量状态：只含「TUN 热点 / Tproxy」四个字段。
# 为什么不复用 status：status 要回读 API、扫配置、算资源，慢设备上要秒级；
# 这里只读设置文件和状态文件（零 curl、零 iptables、零配置扫描），单次往返很快，
# 前端用它在开关返回的第一时间刷新两行状态文案。
mod_state_json() {
  _ms_ths=$(tunhs_status_short)
  _ms_tps=$(tproxy_status_short)
  setting_v hotspot_proxy true; _ms_hp=$SV
  setting_v tproxy false; _ms_tp=$SV
  jv "$_ms_ths"; _ms_a=$J
  jv "$_ms_tps"; _ms_b=$J
  jv "$_ms_hp";  _ms_c=$J
  jv "$_ms_tp";  _ms_d=$J
  printf '{"tun_hotspot":"%s","tproxy_state":"%s","hotspot_proxy":"%s","tproxy":"%s"}\n' "$_ms_a" "$_ms_b" "$_ms_c" "$_ms_d"
}

BOOT_DATA_CACHE=$RUNDIR/boot_data.json

boot_data_sync() {
  # 生命周期与其派生的规则 worker 仅作废缓存；不再启动一堆完整 status/API/-v 预热。
  if [ "${MH_LIFECYCLE_EVENT:-0}" = "1" ]; then
    rm -f "$BOOT_DATA_CACHE" 2>/dev/null; return 0
  fi
  _bds_tmp=$BOOT_DATA_CACHE.tmp.$$
  boot_data_calc > "$_bds_tmp" 2>/dev/null && mv -f "$_bds_tmp" "$BOOT_DATA_CACHE" 2>/dev/null || rm -f "$_bds_tmp"
}

# 快照里的 *_exists 必须与磁盘一致：下载/导入/删除内核不会作废快照，
# 未运行时若不校验，「未安装」会一直停留到下次启动（启动才使快照失效）。
boot_data_cores_match() {
  _bdc_ok=1
  for _bdc_pair in "liuran001:$CORE_LIURAN001" "jieluojun:$CORE_JIELUOJUN" "official:$CORE_OFFICIAL"; do
    _bdc_key=${_bdc_pair%%:*}
    _bdc_path=${_bdc_pair#*:}
    if [ -x "$_bdc_path" ]; then _bdc_want=1; else _bdc_want=0; fi
    case "$1" in
      *"\"${_bdc_key}_exists\": ${_bdc_want}"*|*"\"${_bdc_key}_exists\":${_bdc_want}"*) : ;;
      *) _bdc_ok=0 ;;
    esac
  done
  [ "$_bdc_ok" = 1 ]
}

# 首屏聚合数据：优先走新鲜预热快照（0.5ms 返回），无快照或运行态/PID/Tproxy状态失效时现算并回填
boot_data() {
  if [ -f "$BOOT_DATA_CACHE" ]; then
    _bd_cached=$(cat "$BOOT_DATA_CACHE" 2>/dev/null)
    if [ -n "$_bd_cached" ]; then
      _bd_valid=1
      if running; then
        case "$_bd_cached" in
          *'"running": 1'*|*'"running":1'*) : ;;
          *) _bd_valid=0 ;;
        esac
        _bd_cur_pid=$(pid_of)
        case "$_bd_cached" in
          *'"pid": "'$_bd_cur_pid'"'*|*'"pid":"'$_bd_cur_pid'"'*) : ;;
          *) _bd_valid=0 ;;
        esac
        # 校验 tproxy 状态一致性：避免启动中间态 pending 缓存导致刷新后误报
        if [ "$(get_setting tproxy false)" = "true" ]; then
          if [ -f "$TP_STATE" ]; then
            case "$_bd_cached" in
              *'"tproxy_state": "on:'*|*'"tproxy_state": "holding:'*|*'"tproxy_state":"on:'*|*'"tproxy_state":"holding:'*) : ;;
              *) _bd_valid=0 ;;
            esac
          else
            case "$_bd_cached" in
              *'"tproxy_state": "pending"'*|*'"tproxy_state":"pending"'*|*'"tproxy_state": "standby"'*|*'"tproxy_state":"standby"'*) : ;;
              *) _bd_valid=0 ;;
            esac
          fi
        else
          case "$_bd_cached" in
            *'"tproxy_state": "off"'*|*'"tproxy_state":"off"'*) : ;;
            *) _bd_valid=0 ;;
          esac
        fi
      else
        case "$_bd_cached" in
          *'"running": 0'*|*'"running":0'*) : ;;
          *) _bd_valid=0 ;;
        esac
      fi

      # 配置文件已更新时缓存失效：避免保存后重进面板仍拿到旧 config_b64（# 真实根因）
      if [ "$_bd_valid" = "1" ] && [ -f "$CONFIG" ] && [ -f "$BOOT_DATA_CACHE" ]; then
        _bd_cfg_mt=$(stat -c %Y "$CONFIG" 2>/dev/null || "$BUSYBOX" stat -c %Y "$CONFIG" 2>/dev/null || echo 0)
        _bd_cache_mt=$(stat -c %Y "$BOOT_DATA_CACHE" 2>/dev/null || "$BUSYBOX" stat -c %Y "$BOOT_DATA_CACHE" 2>/dev/null || echo 0)
        if [ "$_bd_cfg_mt" -gt "$_bd_cache_mt" ]; then _bd_valid=0; fi
      fi

      # 内核文件存在性变化（下载 / 导入 / 删除）后快照作废，见 boot_data_cores_match
      if [ "$_bd_valid" = "1" ] && ! boot_data_cores_match "$_bd_cached"; then _bd_valid=0; fi

      if [ "$_bd_valid" = "1" ]; then
        # CPU / 内存是快变量：快照里的四个字段是预热时刻的值。内核刚被 action.sh
        # 启动后立刻进主页时，快照里还是 null（基线刚建立、600ms 首次窗口没走完），
        # 而 serve 此刻窗口可能已经走完 —— 直接返回快照会让界面在「CPU …」上多等
        # 一整拍补读（快照里的 cpu_wait_ms 还是预热时刻的剩余量，早已过期，
        # 前端会按它多等几百毫秒）。模块开关路径不抖，正是因为开关监听在启动
        # 约 1 秒后又做了一次 boot_data_sync，预热出真值才被命中；而 action.sh
        # 路径的第二次同步落在 loop 相位上，时有时无。
        # 这里用一次零 fork 的 /proc 现读把四个字段刷成最新值再返回（与 res 命令
        # 同款开销：几次 read + 一次 sed 改写）；快照文件本身不回写（重变量仍走
        # 快照，首屏依然一次往返），下次命中照样现读，永远新鲜。
        if running; then
          proc_res_usage "$_rn_pid"
          case "$_rs_wait" in ''|*[!0-9]*) _rs_wait=0 ;; esac
          case "$_rs_memk" in ''|*[!0-9]*) _rs_memk=0 ;; esac
          _bd_cached=$(printf '%s' "$_bd_cached" \
            | sed -e "s/\"cpu_dbg\": \"[^\"]*\"/\"cpu_dbg\": \"$_rs_dbg\"/" \
                  -e "s/\"cpu_pct\": [^,} ]*/\"cpu_pct\": $_rs_cpu/" \
                  -e "s/\"cpu_wait_ms\": [0-9][0-9]*/\"cpu_wait_ms\": $_rs_wait/" \
                  -e "s/\"mem_kib\": [0-9][0-9]*/\"mem_kib\": $_rs_memk/")
        fi
        printf '%s\n' "$_bd_cached"
        return 0
      fi
    fi
  fi
  boot_data_calc
}

boot_data_calc() {
  _bd_status=$(status_cached 2>/dev/null)
  case "$_bd_status" in
    '{'*'}') ;;
    *) _bd_status='{"running": 0, "status_err": 1}' ;;
  esac

  _bd_ver=""
  [ -f "$MODDIR/module.prop" ] && _bd_ver=$(grep '^version=' "$MODDIR/module.prop" 2>/dev/null | head -1 | cut -d= -f2)

  _bd_cfg_b64=""
  if [ -f "$CONFIG" ]; then
    _bd_cfg_b64=$(b64_encode < "$CONFIG" 2>/dev/null | tr -d '\r\n')
  fi

  _bd_logs_b64=""
  if [ -f "$LOGFILE" ]; then
    _bd_logs_b64=$(tail -n 120 "$LOGFILE" 2>/dev/null | b64_encode 2>/dev/null | tr -d '\r\n')
  fi

  _bd_res=$(printf '{\n"module_version": "%s",\n"status": %s,\n"config_b64": "%s",\n"logs_b64": "%s"\n}\n' \
    "$(json_str "$_bd_ver")" \
    "$_bd_status" \
    "$_bd_cfg_b64" \
    "$_bd_logs_b64")
  printf '%s\n' "$_bd_res"
  printf '%s' "$_bd_res" > "$BOOT_DATA_CACHE" 2>/dev/null
}

# ---------------- 运行状态同步 + 模块开关联动 ----------------
# 目标：
# 1) root 管理器模块页的开关（disable 文件）直接控制内核启停，且秒级响应；
# 2) module.prop 的 description **最前面**实时显示内核运行状态；
# 3) 所有会改变内核状态的入口（WebUI 总开关 / action.sh / 开机自启 / setcore /
#    模块开关）统一调用 sync_state_desc，状态信息保持一致。

DESC_BASE=$RUNDIR/desc.base       # 不含状态前缀的原始 description（首次运行时抽取并缓存）
PROP_TPL=$RUNDIR/prop.tpl         # module.prop 的完整骨架（description 行用占位符代替）
MODSTATE_PREV=$RUNDIR/modstate.prev
DESC_LOCK=$RUNDIR/desc.lock       # 写 module.prop 的互斥锁（mkdir 原子性）
SWITCH_PID=$RUNDIR/switch.pid     # 模块开关监听进程 pid
SWITCH_LOG=$RUNDIR/switch.log

# 开关监听 transitions 日志：直写 $SWITCH_LOG（与 tunhs_log 同格式）。循环本体的
# stdout 虽然也进这个文件，但各 sync/启停调用的 redirect 不一，直写最稳，换调用
# 上下文也不会被吞（0058/0110 教训）。只记稀疏事件（监听启停/模块开关/内核启停/
# 面板拉起），稳态零写入；监听重启会 reset，无需体积截断。
sw_log() {
  printf '%s %s\n' "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$*" 2>/dev/null >> "${SWITCH_LOG:-/dev/null}"
}

# module.prop 是否完好（必须有 id= 与 version=，否则管理器会显示 Unknown）
_prop_ok() {
  # 内建 read 扫这几行（以前两次 grep = 两次 fork；每次 sync_state_desc 都要经过）
  _pk_id=""; _pk_ver=""
  [ -r "$1" ] || return 1
  while IFS= read -r _pk_l || [ -n "$_pk_l" ]; do
    case "$_pk_l" in id=*) _pk_id=1 ;; version=*) _pk_ver=1 ;; esac
  done < "$1"
  [ -n "$_pk_id" ] && [ -n "$_pk_ver" ]
}

# 首次抽取并缓存：正文 + 整份骨架。骨架里 description 行替换为 @@DESC@@ 占位。
# 之后每次刷新都由骨架整份重建，绝不在原文件上做增量编辑。
_desc_cache_build() {
  _mprop=$MODDIR/module.prop
  _prop_ok "$_mprop" || return 1
  _db=$(grep '^description=' "$_mprop" 2>/dev/null | head -1 | sed 's/^description=//')
  # 剥掉 "[状态] 正文" 的状态前缀，只留正文
  _db=$(echo "$_db" | sed -E 's/^\[[^]]*\][[:space:]]*//')
  [ -n "$_db" ] || return 1
  printf '%s\n' "$_db" > "$DESC_BASE.new" 2>/dev/null || return 1
  mv -f "$DESC_BASE.new" "$DESC_BASE" 2>/dev/null || return 1
  awk '/^description=/{print "@@DESC@@"; next}{print}' "$_mprop" > "$PROP_TPL.new" 2>/dev/null || return 1
  grep -q '^@@DESC@@$' "$PROP_TPL.new" 2>/dev/null || { rm -f "$PROP_TPL.new"; return 1; }
  mv -f "$PROP_TPL.new" "$PROP_TPL" 2>/dev/null || return 1
  return 0
}

# 把状态写成 description 的前缀：description=[🟢 内核运行中 · PID 1234] 正文
sync_module_desc() {
  _ms=$1
  _mprop=$MODDIR/module.prop
  [ -f "$_mprop" ] || return 0
  _md_prev=""
  [ -f "$MODSTATE_PREV" ] && IFS= read -r _md_prev < "$MODSTATE_PREV" 2>/dev/null
  [ "$_md_prev" = "$_ms" ] && return 0

  # 互斥：mkdir 是原子的。热更新收尾与 _switch-loop 可能同时抢锁，
  # 抢锁失败重试 3 次，直接放弃会使本次状态显示丢失
  _try=0
  while ! mkdir "$DESC_LOCK" 2>/dev/null; do
    _try=$((_try+1))
    [ $_try -ge 3 ] && return 0
    [ "$(cat "$MODSTATE_PREV" 2>/dev/null)" = "$_ms" ] && return 0
    nap 0.15
  done

  # 缓存缺失或 module.prop 被写坏时重建缓存；文件已损坏则用骨架修复
  if [ ! -s "$DESC_BASE" ] || [ ! -s "$PROP_TPL" ]; then
    _desc_cache_build || { rmdir "$DESC_LOCK" 2>/dev/null; return 0; }
  fi

  _base=$(cat "$DESC_BASE" 2>/dev/null)
  if [ -z "$_base" ]; then rmdir "$DESC_LOCK" 2>/dev/null; return 0; fi

  # 由骨架整份重建到临时文件，校验通过后用 mv 原子替换（rename 不会出现截断窗口）
  _tmp=$_mprop.tmp.$$
  awk -v line="description=[$_ms] $_base" \
      '/^@@DESC@@$/{print line; next}{print}' "$PROP_TPL" > "$_tmp" 2>/dev/null
  if _prop_ok "$_tmp"; then
    chmod 644 "$_tmp" 2>/dev/null
    mv -f "$_tmp" "$_mprop" 2>/dev/null && echo "$_ms" > "$MODSTATE_PREV" 2>/dev/null
  fi
  rm -f "$_tmp" 2>/dev/null
  rmdir "$DESC_LOCK" 2>/dev/null
}

# 自愈：若 module.prop 已被写坏（缺 id/version），用骨架立即还原
heal_prop() {
  _mprop=$MODDIR/module.prop
  _prop_ok "$_mprop" && return 0
  [ -s "$PROP_TPL" ] && [ -s "$DESC_BASE" ] || return 1
  _tmp=$_mprop.tmp.$$
  awk -v line="description=$(cat "$DESC_BASE")" \
      '/^@@DESC@@$/{print line; next}{print}' "$PROP_TPL" > "$_tmp" 2>/dev/null
  if _prop_ok "$_tmp"; then
    chmod 644 "$_tmp" 2>/dev/null
    mv -f "$_tmp" "$_mprop" 2>/dev/null
    rm -f "$MODSTATE_PREV" 2>/dev/null   # 强制下次重新写状态
    rm -f "$_tmp" 2>/dev/null
    return 0
  fi
  rm -f "$_tmp" 2>/dev/null
  return 1
}

# 按当前实际运行状态同步一次模块描述。所有启停入口统一调用它。
sync_state_desc() {
  heal_prop 2>/dev/null
  if running; then
    sync_module_desc "🟢 内核运行中 · PID $_rn_pid"   # running 刚读过 pid 文件，直接复用
  elif [ -f "$MODDIR/disable" ]; then
    sync_module_desc "⚪ 模块已禁用 · 内核已停止"
  else
    sync_module_desc "🔴 内核已停止"
  fi
}

# ---- 模块开关监听：让管理器模块页的开关秒级控制内核 ----
# KernelSU/Magisk 关闭模块时创建 $MODDIR/disable，重新打开时删除它。
# 该文件的增删没有任何广播可订阅，因此用轮询来做到「秒级响应」。节拍 1 秒：
# 开/关模块、内核启停的感知延迟最多 1 秒，完全可接受；而 0.2s 节拍每轮要 fork
# 跑 running()+sleep，一秒 15 次进程创建，常驻空转 CPU 可观。1s 节拍 + 内建命令
# 判活（见循环内），每秒只剩约 1 次 fork（sleep 自身），周期对账另计。
switch_running() {
  _sp=""
  [ -f "$SWITCH_PID" ] && IFS= read -r _sp < "$SWITCH_PID" 2>/dev/null
  case "$_sp" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$_sp" 2>/dev/null || return 1
  # 与 web_running 同理：pid 跨重启残留被复用时，只看 kill -0 会误判监听
  # 还在、永不再拉，而开关监听恰是面板自愈的载体，必须验明正身
  [ -r "/proc/$_sp/cmdline" ] && grep -qa '_switch-loop' "/proc/$_sp/cmdline" 2>/dev/null
}

# ---------------- 模块开关极简监听（仅监听 disable 文件） ----------------
# 纯事件/状态驱动：不包含任何周期性 iptables/ip rule/ps/awk 耗电扫表。
# 稳态下纯 sleep，零外部子进程 fork，仅在用户于 root 管理器中打开/关闭模块时
# 即时停止或恢复内核与面板服务，并同步模块状态描述。

switch_running() {
  _sp=""
  [ -f "$SWITCH_PID" ] && IFS= read -r _sp < "$SWITCH_PID" 2>/dev/null
  case "$_sp" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$_sp" 2>/dev/null || return 1
  # 与 web_running 同理：pid 跨重启残留被复用时，只看 kill -0 会误判监听
  # 还在、永不再拉，而开关监听恰是面板自愈的载体，必须验明正身
  [ -r "/proc/$_sp/cmdline" ] && grep -qa '_switch-loop' "/proc/$_sp/cmdline" 2>/dev/null
}

switch_sweep() {
  for _sw_p in /proc/[0-9]*; do
    _sw_n=${_sw_p#/proc/}
    [ "$_sw_n" = "$$" ] && continue
    case "$(tr '\0' ' ' < "$_sw_p/cmdline" 2>/dev/null)" in
      *_switch-loop*) kill "$_sw_n" 2>/dev/null ;;
    esac
  done
}

switch_start() {
  switch_running && { echo "模块开关监听已在运行 (pid $(cat "$SWITCH_PID"))"; return 0; }
  switch_sweep 2>/dev/null
  rm -f "$SWITCH_PID"
  reset_log "$SWITCH_LOG"
  # setsid 脱离拉起方会话（理由同 web_spawn_once），无 setsid 回退 nohup
  if command -v setsid >/dev/null 2>&1; then
    setsid sh "$0" _switch-loop </dev/null >> "$SWITCH_LOG" 2>&1 &
  else
    nohup sh "$0" _switch-loop </dev/null >> "$SWITCH_LOG" 2>&1 &
  fi
  echo $! > "$SWITCH_PID"
  detach_pid "$(cat "$SWITCH_PID")" 2>/dev/null
  echo "OK: 模块开关监听已启动 (pid $(cat "$SWITCH_PID"))"
}

switch_stop() {
  _sp=$(cat "$SWITCH_PID" 2>/dev/null)
  [ -n "$_sp" ] && kill "$_sp" 2>/dev/null
  rm -f "$SWITCH_PID"
  echo "OK: 模块开关监听已停止"
}

# ============================================================
# 网络匹配（根据 Wi-Fi / 移动数据自动启停内核）
# ============================================================
NETMATCH_CONF=$WORKDIR/netmatch.json
NETMATCH_LOG=$RUNDIR/netmatch.log
NETMATCH_STATE=$RUNDIR/netmatch.state

netmatch_log() {
  # $1 message
  [ -f "$NETMATCH_CONF" ] || return 0
  grep -q '"log"[[:space:]]*:[[:space:]]*true' "$NETMATCH_CONF" 2>/dev/null || return 0
  _nml_t=$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date)
  printf '[%s] %s\n' "$_nml_t" "$1" >> "$NETMATCH_LOG" 2>/dev/null
  if [ -f "$NETMATCH_LOG" ] && [ "$(wc -l < "$NETMATCH_LOG" 2>/dev/null || echo 0)" -gt 300 ]; then
    tail -150 "$NETMATCH_LOG" > "$NETMATCH_LOG.tmp" 2>/dev/null && mv -f "$NETMATCH_LOG.tmp" "$NETMATCH_LOG" 2>/dev/null
  fi
}

_netmatch_clean_ssid() {
  _cs_s=$(printf '%s' "$1" | sed 's/^["'\'']//; s/["'\'']$//')
  case "$_cs_s" in
    "<unknown ssid>"|"<none>"|"0x"|"null"|"none"|""|"*"|"00:00:00:00:00:00")
      _cs_s="" ;;
  esac
  printf '%s' "$_cs_s"
}

_netmatch_clean_bssid() {
  _cb_b=$(printf '%s' "$1" | sed 's/^["'\'']//; s/["'\'']$//')
  case "$_cb_b" in
    "00:00:00:00:00:00"|"null"|"<none>"|""|"0")
      _cb_b="" ;;
  esac
  printf '%s' "$_cb_b"
}

netmatch_detect() {
  # 检测当前网络环境，输出: wifi|ssid|bssid|cellular|mcc_mnc|sim_slot
  _nd_wifi=0; _nd_ssid=""; _nd_bssid=""; _nd_cell=0; _nd_mcc=""; _nd_sim=0
  _nd_disc=0

  # 1. 优先使用 cmd wifi status 检测连接与 SSID
  if command -v cmd >/dev/null 2>&1; then
    _nd_cstat=$(cmd wifi status 2>/dev/null)
    if [ -n "$_nd_cstat" ]; then
      if echo "$_nd_cstat" | grep -qiE 'Wifi is disabled|Wifi is disconnected|Wifi is not connected'; then
        _nd_disc=1
      else
        _nd_cs=$(echo "$_nd_cstat" | grep -i 'Wifi is connected to' | sed -n 's/.*"\(.*\)".*/\1/p' | head -1)
        _nd_cs=$(_netmatch_clean_ssid "$_nd_cs")
        if [ -n "$_nd_cs" ]; then
          _nd_ssid="$_nd_cs"
          _nd_wifi=1
        fi
      fi
    fi
  fi

  # 2. 如果尚未判定且 dumpsys 可用，检测 dumpsys wifi
  if [ "$_nd_wifi" = "0" ] && [ "$_nd_disc" = "0" ] && command -v dumpsys >/dev/null 2>&1; then
    _nd_wdump=$(dumpsys wifi 2>/dev/null)
    if echo "$_nd_wdump" | grep -qE 'curState=DisconnectedState|state: DISCONNECTED|Supplicant state: DISCONNECTED|INTERFACE_DISABLED'; then
      _nd_disc=1
    else
      _nd_s=$(echo "$_nd_wdump" | grep -E 'mWifiInfo|WifiInfo:|mNetworkInfo' | sed -n 's/.*SSID: "\([^"]*\)".*/\1/p; s/.*SSID: \([^, "]*\).*/\1/p' | head -1)
      _nd_s=$(_netmatch_clean_ssid "$_nd_s")
      _nd_b=$(echo "$_nd_wdump" | grep -E 'mWifiInfo|WifiInfo:' | sed -n 's/.*BSSID: \([0-9a-fA-F:]*\).*/\1/p' | head -1)
      _nd_b=$(_netmatch_clean_bssid "$_nd_b")
      if [ -n "$_nd_s" ] || [ -n "$_nd_b" ]; then
        _nd_wifi=1
        _nd_ssid="$_nd_s"
        _nd_bssid="$_nd_b"
      fi
    fi
  fi

  # 3. 兜底检查：若未判定为断开，检查 wlan 网卡接口 IPv4 与 carrier
  if [ "$_nd_wifi" = "0" ] && [ "$_nd_disc" = "0" ]; then
    _nd_wip=$(ip -o -4 addr show 2>/dev/null | grep -E ' (wlan|ap)[0-9]' | awk '{print $4}' | head -1)
    if [ -n "$_nd_wip" ]; then
      if [ "$(cat /sys/class/net/wlan0/operstate 2>/dev/null)" = "up" ] || [ "$(cat /sys/class/net/wlan0/carrier 2>/dev/null)" = "1" ]; then
        _nd_wifi=1
      fi
    fi
  fi

  # 4. 蜂窝移动网络检测
  if ip -o -4 addr show 2>/dev/null | grep -qE ' (rmnet|ccmni|pdp|v4-rmnet|wwan|cellular)[0-9_]'; then
    _nd_cell=1
  elif command -v dumpsys >/dev/null 2>&1 && dumpsys telephony.registry 2>/dev/null | grep -q 'mDataConnectionState=2'; then
    _nd_cell=1
  elif [ "$_nd_wifi" = "0" ]; then
    _nd_def=$(awk '$2=="00000000"{print $1; exit}' /proc/net/route 2>/dev/null)
    case "$_nd_def" in
      rmnet*|ccmni*|pdp*|v4-rmnet*|wwan*) _nd_cell=1 ;;
    esac
  fi

  # 5. MCC+MNC 与 SIM 卡槽检测
  _nd_mcc=$(getprop gsm.sim.operator.numeric 2>/dev/null)
  [ -z "$_nd_mcc" ] && _nd_mcc=$(getprop gsm.operator.numeric 2>/dev/null)
  _nd_slot=$(getprop persist.radio.default.data 2>/dev/null)
  [ -z "$_nd_slot" ] && _nd_slot=$(getprop gsm.default.data 2>/dev/null)
  case "$_nd_slot" in
    0) _nd_sim=1 ;;
    1) _nd_sim=2 ;;
    *) [ "$_nd_cell" = "1" ] && _nd_sim=1 ;;
  esac

  printf '%s|%s|%s|%s|%s|%s\n' "$_nd_wifi" "$_nd_ssid" "$_nd_bssid" "$_nd_cell" "$_nd_mcc" "$_nd_sim"
}

netmatch_eval() {
  [ -f "$NETMATCH_CONF" ] || return 2
  grep -q '"enabled"[[:space:]]*:[[:space:]]*true' "$NETMATCH_CONF" 2>/dev/null || return 2

  _ne_info=$(netmatch_detect)
  _ne_wifi=$(echo "$_ne_info" | cut -d'|' -f1)
  _ne_ssid=$(echo "$_ne_info" | cut -d'|' -f2)
  _ne_bssid=$(echo "$_ne_info" | cut -d'|' -f3)
  _ne_cell=$(echo "$_ne_info" | cut -d'|' -f4)
  _ne_mcc=$(echo "$_ne_info" | cut -d'|' -f5)
  _ne_sim=$(echo "$_ne_info" | cut -d'|' -f6)

  _ne_matched=$(awk -F'[:, \t\r\n{}\\[\\]"]+' \
                    -v wifi="${_ne_wifi:-0}" \
                    -v ssid="${_ne_ssid:-}" \
                    -v bssid="${_ne_bssid:-}" \
                    -v cell="${_ne_cell:-0}" \
                    -v mcc="${_ne_mcc:-}" \
                    -v sim="${_ne_sim:-0}" '
    BEGIN {
      matched = 0; has_rules = 0;
      ssid_low = tolower(ssid);
      bssid_low = tolower(bssid);
    }
    {
      for (i = 1; i <= NF; i++) {
        if ($i == "type" && (i+1) <= NF) {
          t = $(i+1);
          v = "";
          for (j = 1; j <= NF; j++) {
            if ($j == "value" && (j+1) <= NF) {
              v = $(j+1);
              break;
            }
          }
          has_rules = 1;
          if (t == "wifi" && wifi == 1) matched = 1;
          else if (t == "wifi_ssid" && wifi == 1 && (ssid == v || ssid_low == tolower(v))) matched = 1;
          else if (t == "wifi_bssid" && wifi == 1 && (bssid == v || bssid_low == tolower(v))) matched = 1;
          else if (t == "cellular" && cell == 1) matched = 1;
          else if (t == "mcc_mnc" && index(mcc, v) > 0) matched = 1;
          else if (t == "sim1" && cell == 1 && sim == 1) matched = 1;
          else if (t == "sim2" && cell == 1 && sim == 2) matched = 1;
        }
      }
    }
    END {
      if (!has_rules) print 0;
      else print matched;
    }
  ' "$NETMATCH_CONF" 2>/dev/null)

  [ "$_ne_matched" = "1" ] && return 0 || return 1
}

netmatch_tick() {
  [ -f "$MODDIR/disable" ] && return 0
  [ -f "$NETMATCH_CONF" ] || return 0
  grep -q '"enabled"[[:space:]]*:[[:space:]]*true' "$NETMATCH_CONF" 2>/dev/null || return 0

  _nt_on_m=$(grep -E '"on_match"[[:space:]]*:' "$NETMATCH_CONF" 2>/dev/null | sed -n 's/.*"on_match"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  _nt_on_u=$(grep -E '"on_mismatch"[[:space:]]*:' "$NETMATCH_CONF" 2>/dev/null | sed -n 's/.*"on_mismatch"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [ -z "$_nt_on_m" ] && _nt_on_m="start"
  [ -z "$_nt_on_u" ] && _nt_on_u="stop"

  # 上一拍状态。附加 boot_id 校验：状态文件在 /data 上跨重启保留，而开机自启
  # 不看网络匹配、无条件拉起内核——若上一会话恰好停在「matched」（如 WiFi 下
  # 停止了内核），重启后第一拍会把残留状态误判成「无变迁」，匹配规则
  # （如 WiFi → 停止服务）永远不执行。这里随状态记录写入时的 boot_id，跨了
  # 开机（冷/热重启都会变）即视为状态未知，第一拍强制对账。post-fs-data.sh
  # 在 Android 上每次开机也会清掉该文件，此处兜底非 Android 平台与旧格式文件
  # （旧格式单列状态值读出的 boot_id 必不等于当前值，同样按未知处理）。
  _nt_boot=""
  if [ -r /proc/sys/kernel/random/boot_id ]; then
    IFS= read -r _nt_boot _ < /proc/sys/kernel/random/boot_id 2>/dev/null
  fi
  # 注意不能用 `IFS= read -r a b` 分两列——实测 bash/dash/ash 下 IFS 置空即禁用
  # 分词，第二个变量恒为空，状态会被每拍误判成未知。单变量整行读入后按第一个
  # 空格切开；无空格的旧行格式（单列状态值）按未知 boot_id 处理。
  _nt_last=""; _nt_last_boot=""
  _nt_line=""
  if [ -f "$NETMATCH_STATE" ]; then
    IFS= read -r _nt_line < "$NETMATCH_STATE" 2>/dev/null
  fi
  case "$_nt_line" in
    *" "*)
      _nt_last_boot=${_nt_line%% *}
      _nt_last=${_nt_line#* } ;;
    *)
      _nt_last_boot=$_nt_line
      _nt_last="" ;;
  esac
  [ "$_nt_boot" = "$_nt_last_boot" ] || _nt_last=""

  if netmatch_eval; then
    _nt_cur="matched"
    if [ "$_nt_cur" != "$_nt_last" ]; then
      printf '%s %s\n' "$_nt_boot" "$_nt_cur" > "$NETMATCH_STATE" 2>/dev/null
      netmatch_log "网络状态变更 -> 匹配成功 (触发操作: $_nt_on_m)"
      case "$_nt_on_m" in
        start) ! running && MH_SKIP_IPV6=1 MH_QUICK_START=1 start_core >/dev/null 2>&1 ;;
        stop)  running && stop_core >/dev/null 2>&1 ;;
      esac
      live_invalidate 2>/dev/null
      sync_state_desc >/dev/null 2>&1
      ( boot_data_sync ) >/dev/null 2>&1 &
    fi
  else
    _nt_cur="mismatched"
    if [ "$_nt_cur" != "$_nt_last" ]; then
      printf '%s %s\n' "$_nt_boot" "$_nt_cur" > "$NETMATCH_STATE" 2>/dev/null
      netmatch_log "网络状态变更 -> 未匹配 (触发操作: $_nt_on_u)"
      case "$_nt_on_u" in
        stop)  running && stop_core >/dev/null 2>&1 ;;
        start) ! running && MH_SKIP_IPV6=1 MH_QUICK_START=1 start_core >/dev/null 2>&1 ;;
      esac
      live_invalidate 2>/dev/null
      sync_state_desc >/dev/null 2>&1
      ( boot_data_sync ) >/dev/null 2>&1 &
    fi
  fi
}

_switch_loop() {
  _prev_dis=""
  _prev_run=""
  _sw_ivt=0                    # 系统 IPv6 看门狗节拍：每 IPV6_TICK 秒对账一次
  _sw_webt=0                   # 面板看门狗节拍
  _sw_wmiss=0                  # 面板看门狗连续判死次数（两次才动手）
  sw_log "模块开关监听启动 pid=$$"
  rmdir "$DESC_LOCK" 2>/dev/null
  while :; do
    # 孤儿自退
    [ "$(cat "$SWITCH_PID" 2>/dev/null)" = "$$" ] || exit 0

    # 纯 shell 内建检测（test / read / kill -0，零外部进程 fork）：
    if [ -f "$MODDIR/disable" ]; then _dis=1; else _dis=0; fi
    _sw_pid=""; [ -f "$PIDFILE" ] && read -r _sw_pid < "$PIDFILE" 2>/dev/null
    if [ -n "$_sw_pid" ] && kill -0 "$_sw_pid" 2>/dev/null; then _run=1; else _run=0; fi

    # 仅当模块开关翻转时才动作（稳态 100% 纯 sleep，零 iptables/ip 外部命令执行）
    if [ "$_dis" != "$_prev_dis" ] && [ -n "$_prev_dis" ]; then
      if [ "$_dis" = "1" ]; then
        sw_log "模块禁用"
        [ "$_run" = "1" ] && stop_core >/dev/null 2>&1
        system_ipv6_sync >/dev/null 2>&1
        if web_running; then
          sw_log "面板停止（模块禁用）"
          _wp=$(cat "$WEB_PID" 2>/dev/null)
          [ -n "$_wp" ] && kill "$_wp" 2>/dev/null
          rm -f "$WEB_PID"
        fi
      else
        sw_log "模块启用"
        if [ "$_run" = "0" ] && [ -x "$(core_path)" ]; then
          start_core >/dev/null 2>&1 || sw_log "WARN 模块启用后内核启动失败"
        fi
        if ! web_running; then
          web_start >/dev/null 2>&1
          web_running && sw_log "面板启动（模块启用）"
        fi
      fi
      _prev_run=""
    fi

    # 仅在内核状态或模块开关发生真实变化时才更新一次描述与首屏快照
    if [ "$_run" != "$_prev_run" ] || [ "$_dis" != "$_prev_dis" ]; then
      sync_state_desc >/dev/null 2>&1
      ( boot_data_sync ) >/dev/null 2>&1 &
    fi

    # 网络匹配自控（若已启用）
    if [ "$_dis" = "0" ]; then
      netmatch_tick
      # 启停发生在本拍：立刻按新 pid 刷新描述，不等下一秒循环
      _sw_pid=""; [ -f "$PIDFILE" ] && read -r _sw_pid < "$PIDFILE" 2>/dev/null
      if [ -n "$_sw_pid" ] && kill -0 "$_sw_pid" 2>/dev/null; then _run=1; else _run=0; fi
    fi

    # 系统 IPv6 看门狗：开关飞行模式 / 切数据 / 重连 WiFi 后，netd 会把网卡的
    # disable_ipv6 重新置 0（蜂窝网卡还可能整块重建），只在设置变更或开机时
    # 应用一次就再也追不回来 —— 面板显示「已禁用」，v6 地址和默认路由却在
    # 外面跑（IPv6 泄露）。这里每 IPV6_TICK 秒对账一次：稳态零写入，
    # 追打受 60s 冷却限制，不会跟 netd 打成 netlink 风暴。
    _sw_ivt=$((_sw_ivt + 1))
    if [ "$_sw_ivt" -ge "$IPV6_TICK" ]; then
      _sw_ivt=0
      # 心跳文件：诊断页看它判断监听循环是否活着（以前只读不写，永远显示「未跑过」）
      date +%s 2>/dev/null > "$RUNDIR/tunhs.beat"
    fi
    if [ "$_dis" = "0" ] && [ "$_sw_ivt" -eq 0 ]; then
      # 先取网络指纹再对账：指纹变了（飞行模式 / 切数据 / 重连 Wi-Fi）说明 netd
      # 重建过网卡，rp_filter、FORWARD 放行、8995 直连表等都可能被它重置或拆散
      # ——立刻对账 TUN 热点转发与 Tproxy 规则。以前这里只有 IPv6 看门狗在追，
      # 注释里「监听循环每 ~5s 兜底对账」的规则侧周期对账在循环精简时被整段删掉
      # 了，飞行模式后没有任何人把规则/sysctl 追回来，只能重启手机恢复。
      _sw_netprev=""
      [ -f "$IPV6_NET" ] && _sw_netprev=$(cat "$IPV6_NET" 2>/dev/null)
      system_ipv6_sync >/dev/null 2>&1
      _sw_netnow=""
      [ -f "$IPV6_NET" ] && _sw_netnow=$(cat "$IPV6_NET" 2>/dev/null)
      if [ "$_sw_netnow" != "$_sw_netprev" ] || [ -z "$_sw_netprev" ]; then
        sh "$0" net-sync >/dev/null 2>&1
        _sw_slow=0
      else
        # 稳态兜底：每 ~60s 一次快轮（_SW_QUICK=1 跳过 iptables/ip rule 抽查，
        # 只看状态与期望是否收敛），防外部改动/竞态残留后永不收敛。全量轮在
        # 网络变化时已覆盖，这里不重复付 iptables 的开销。
        _sw_slow=$((${_sw_slow:-0} + 1))
        if [ "$_sw_slow" -ge 12 ]; then
          _sw_slow=0
          _SW_QUICK=1 sh "$0" net-sync >/dev/null 2>&1
        fi
      fi
    fi

    # 面板看门狗：httpd 在开机竞态里没起来（pid 残留误判、bind 撞车重试
    # 耗尽）、或运行中被系统回收时，以前没有任何人会再拉它 —— boot 只在
    # 开机时调两次 web_start，短路/失败后整个开机周期面板都是死的（页面
    # 靠 Service Worker 缓存打开，所有请求 Failed to fetch，用户只能再
    # 重启碰运气）。这里每约 30 秒探活一次：判活（已含 cmdline 身份
    # 核对）+ 端口监听（纯内建读 /proc/net）双确认，确认没在服务才补拉；
    # 正常时每 30 秒只多两次小文件读取，稳态无感。模块禁用时不拉（禁用
    # 分支已负责停面板）；热更新流程会先停本监听再停面板，不会被抢跑。
    _sw_webt=$((_sw_webt + 1))
    if [ "$_sw_webt" -ge 30 ]; then
      _sw_webt=0
      if [ "$_dis" = "0" ]; then
        _sw_wpt=$(web_port)
        if ! web_running || ! _sc_port_listening "$_sw_wpt"; then
          # 先别急着重启：执行桥每处理一个请求都会 touch run/webui.cgi.alive，
          # 它很新说明 httpd 正在正常干活，只是这一刻的判活采样没命中（长请求
          # 期间 /proc 读取抖动）。这时重启 httpd 会把正在跑的长请求连回包一起
          # 掐掉，前端只能看到「HTTP 400 / 空响应」——「切代理模式来回互切就报
          # 服务重启失败」正是这么来的。
          _sw_wa=""
          [ -f "$RUNDIR/webui.cgi.alive" ] && _sw_wa=$(stat -c %Y "$RUNDIR/webui.cgi.alive" 2>/dev/null)
          case "$_sw_wa" in ''|*[!0-9]*) _sw_wa=0 ;; esac
          _sw_now=$(date +%s 2>/dev/null); case "$_sw_now" in ''|*[!0-9]*) _sw_now=0 ;; esac
          if [ "$_sw_wa" -gt 0 ] && [ "$_sw_now" -gt 0 ] && [ $((_sw_now - _sw_wa)) -lt 90 ]; then
            _sw_wmiss=0
          else
            _sw_wmiss=$((_sw_wmiss + 1))
            if [ "$_sw_wmiss" -lt 2 ]; then
              sw_log "面板看门狗：判活未命中（端口 ${_sw_wpt:-?}），下一轮再确认"
            else
              _sw_wmiss=0
              sw_log "面板看门狗：httpd 未在监听（端口 ${_sw_wpt:-?}），尝试重新拉起"
              web_start >/dev/null 2>&1
              if web_running && _sc_port_listening "$_sw_wpt"; then
                sw_log "面板看门狗：httpd 已恢复监听"
              else
                sw_log "WARN 面板看门狗：httpd 仍未恢复，30 秒后重试（详见 run/httpd.log）"
              fi
            fi
          fi
        else
          _sw_wmiss=0
        fi
      fi
    fi

    _prev_dis=$_dis
    _prev_run=$_run

    # 稳态仅休眠：1 秒一次极轻检测（纯内建命令，秒级响应模块开关）
    sleep 1
  done
}

# ============================================================
# 面板 HTTP 服务（管理器 + 浏览器统一入口）
# ------------------------------------------------------------
# 架构（对标“神秘”模块）：面板本身就是一套常驻的 HTTP 服务，
# 管理器 WebUI 与浏览器打开的是同一份页面、同一个执行桥，
# 不再有“管理器原生桥 / 浏览器 CGI”两套 I/O 路径。
#   · $MODDIR/webroot/ui/            面板真实文件（httpd 站点根）
#   · $MODDIR/webroot/               跳转页 index.html + ui/ + tools/（tools 含 app-info）
#   · webroot/ui/cgi-bin/exec.sh     root 执行桥（CGI，httpd 以 root 运行）
# 服务在模块启用期间常驻：开机、开关监听、热更新都会确保它活着；
# 管理器里点开模块界面，本质就是打开一次本机 HTTP 页面。
# webui 设置 = 监听范围（默认 true，保持旧行为）：
#   true  → 0.0.0.0（局域网 / 热点共享设备可远程访问）
#   false → 127.0.0.1（仅本机与管理器，局域网不可见）
# 注意：它不再是“服务开关”——服务常驻，关掉的只是远程访问面。
# ============================================================
# 面板服务的运行时文件统一叫 httpd.*（跑的就是 busybox httpd）；
# run/webui.* 留给 WebUI 界面自身：webui.log = 前端日志，webui.token = 访问令牌
WEB_PID=$RUNDIR/httpd.pid
WEB_LOG=$RUNDIR/httpd.log
WEB_CONF=$RUNDIR/httpd.conf     # httpd 配置：声明 .sh 的解释器 + 放行 CGI
WEB_TOKEN=$RUNDIR/webui.token
WEB_TOKEN_DEFAULT=mihomo        # 默认访问令牌（令牌校验默认关闭，开启后若未自定义即用它）
WEBROOT=$MODDIR/webroot/ui              # 面板真实文件；webroot/ 下只有一个跳转页
WEB_REDIRECT=$MODDIR/webroot/index.html

# 浏览器禁访端口判定（0=禁访）。Chromium 系（含管理器 WebView 和几乎所有
# Android 浏览器）拒绝连接这些端口（ERR_UNSAFE_PORT），连跳转页的探活 fetch
# 都一样被拦 —— 面板是纯 WebUI，跑在上面等于把自己锁在门外谁都进不来。
# 名单对齐 Chromium net/base/port_util.cc kRestrictedPorts（Firefox 基本重合）。
# 纯 case 匹配，零 fork。
web_port_unsafe() {
  case ",$1," in *,1,*|*,7,*|*,9,*|*,11,*|*,13,*|*,15,*|*,17,*|*,19,*|*,20,*|*,21,*|*,22,*|*,23,*|*,25,*|*,37,*|*,42,*|*,43,*|*,53,*|*,69,*|*,77,*|*,79,*|*,87,*|*,95,*|*,101,*|*,102,*|*,103,*|*,104,*|*,109,*|*,110,*|*,111,*|*,113,*|*,115,*|*,117,*|*,119,*|*,123,*|*,135,*|*,137,*|*,139,*|*,143,*|*,161,*|*,179,*|*,389,*|*,427,*|*,465,*|*,512,*|*,513,*|*,514,*|*,515,*|*,526,*|*,530,*|*,531,*|*,532,*|*,540,*|*,548,*|*,554,*|*,556,*|*,563,*|*,587,*|*,601,*|*,636,*|*,989,*|*,990,*|*,993,*|*,995,*|*,1719,*|*,1720,*|*,1723,*|*,2049,*|*,3659,*|*,4045,*|*,5060,*|*,5061,*|*,6000,*|*,6566,*|*,6665,*|*,6666,*|*,6667,*|*,6668,*|*,6669,*|*,6697,*|*,10080,*) return 0 ;; esac
  return 1
}

web_port() { get_setting webui_port 55555; }

# 远程访问范围：默认开启（局域网可访问）；关闭后仅回环地址可进
web_remote_on() { [ "$(get_setting webui true)" = "true" ]; }

web_bind_addr() { web_remote_on && echo "0.0.0.0" || echo "127.0.0.1"; }

# 令牌校验开关：默认关闭（局域网内直接 IP:端口 打开即可）
web_auth_on() { [ "$(get_setting webui_auth false)" = "true" ]; }

# $1=pid → 0 表示这确实是本模块的面板 httpd（cmdline 里同时带 httpd 与
# 本模块的站点根路径）。判活不能只看 kill -0：pid 文件在 /data 上跨重启
# 保留，旧 pid 会被开机进程复用，届时「数字还活着」会被误判成「面板在
# 运行」，web_start 直接短路、整个开机周期都不再拉服务（post-fs-data 已
# 在开机清 pid 文件，这里再兜住运行期残留/复用的情形，双保险）。
web_pid_is_httpd() {
  [ -n "$1" ] && [ -r "/proc/$1/cmdline" ] || return 1
  grep -qa 'httpd' "/proc/$1/cmdline" 2>/dev/null || return 1
  grep -qa "$WEBROOT" "/proc/$1/cmdline" 2>/dev/null
}

web_running() {
  _wp=""
  [ -f "$WEB_PID" ] && IFS= read -r _wp < "$WEB_PID" 2>/dev/null
  case "$_wp" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$_wp" 2>/dev/null || return 1
  web_pid_is_httpd "$_wp"
}

# 面板 HTTP 服务：busybox httpd（Magisk / KSU 等完整 busybox）优先；
# 精简 busybox 无 httpd 小程序时回退 uhttpd（OpenWrt 自带）。
# 两者的 -f/-p/-h/-c 同义，且 uhttpd 的配置文件同样识别 `*.sh:解释器` 行，无需翻译参数。
# （toybox 没有 httpd applet）
web_httpd_bin() {
  if have_busybox && applet_has "$BUSYBOX" httpd; then echo "$BUSYBOX httpd"; return 0; fi
  if command -v httpd >/dev/null 2>&1; then echo "httpd"; return 0; fi
  if command -v uhttpd >/dev/null 2>&1; then echo "uhttpd"; return 0; fi
  return 1
}

web_token() {
  if [ ! -s "$WEB_TOKEN" ]; then
    echo "$WEB_TOKEN_DEFAULT" > "$WEB_TOKEN" 2>/dev/null
    chmod 600 "$WEB_TOKEN" 2>/dev/null
  fi
  cat "$WEB_TOKEN" 2>/dev/null
}

# 随机令牌（想要强口令时用；默认不再自动生成随机串）
web_token_random() {
  _t=$(cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-' | cut -c1-16)
  [ -n "$_t" ] || _t="mihomo$(date +%s)"
  echo "$_t" > "$WEB_TOKEN" 2>/dev/null
  chmod 600 "$WEB_TOKEN" 2>/dev/null
  cat "$WEB_TOKEN" 2>/dev/null
}

# 恢复默认令牌 mihomo
web_token_reset() { rm -f "$WEB_TOKEN"; web_token; }

# 自定义令牌（仅允许可安全放进 URL 的字符，避免破坏链接与 shell 传参）
web_token_set() {
  case "$1" in
    '') echo "ERR: 令牌不能为空"; return 1 ;;
    *[!A-Za-z0-9_.~-]*) echo "ERR: 令牌只能包含字母、数字和 - _ . ~"; return 1 ;;
  esac
  if [ "${#1}" -lt 4 ]; then echo "ERR: 令牌至少 4 位"; return 1; fi
  echo "$1" > "$WEB_TOKEN" 2>/dev/null || { echo "ERR: 写入失败"; return 1; }
  chmod 600 "$WEB_TOKEN" 2>/dev/null
  echo "OK: 令牌已更新"
}

# 本机所有可用 IPv4（Wi-Fi / 以太网 / 热点 ap0、wlan1、rndis0 等），排除回环
web_addrs() {
  {
    if command -v ip >/dev/null 2>&1; then
      ip -4 -o addr show 2>/dev/null | awk '{print $2" "$4}' | sed 's#/[0-9]*##' \
        | grep -v '^lo ' | awk '{print $1"|"$2}'
    else
      ifconfig 2>/dev/null | awk '
        /^[a-zA-Z0-9_-]+/ { ifn=$1 }
        /inet addr:/ { split($2,a,":"); if (a[2] != "127.0.0.1") print ifn"|"a[2] }
        /inet / && !/inet addr:/ { if ($2 != "127.0.0.1") print ifn"|"$2 }'
    fi
    # 本机回环：本设备自带浏览器直接打开用，始终可用（即使断网 / 未开热点）
    echo "lo|127.0.0.1"
  } | grep -v '|169\.254\.' | awk '!seen[$0]++'
}

# 管理器跳转页渲染（webroot/ 下的唯一文件）。
# $1 = 端口（缺省取当前设置），$2 = 查询串如 ?t=xxx（缺省按令牌开关推导）。
# 输出到 stdout：build.sh 打包时用它烘焙出厂默认页，运行时用 web_sync_webroot 落盘。
webroot_render() {
  _wr_pt=$1; _wr_q=$2
  case "$_wr_pt" in ''|*[!0-9]*) _wr_pt=$(web_port) ;; esac
  case "$_wr_pt" in ''|*[!0-9]*) _wr_pt=55555 ;; esac
  if [ -z "$_wr_q" ] && web_auth_on 2>/dev/null; then _wr_q="/?t=$(web_token 2>/dev/null)"; fi
  [ -n "$_wr_q" ] || _wr_q="/"
  _wr_target="http://127.0.0.1:$_wr_pt$_wr_q"
  cat <<EOF
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Cache-Control" content="no-cache, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>Mihomo Box</title>
<style>
html,body{margin:0;padding:0;min-height:100vh}
body{display:flex;align-items:center;justify-content:center;background:#F5F6FA;color:#222;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
@media (prefers-color-scheme:dark){body{background:#0C0C0F;color:#E8E8EA}}
.card{width:min(420px,88vw);text-align:center;padding:32px 24px;border-radius:20px;background:rgba(127,127,127,.08)}
.t{font-size:16px;font-weight:700;margin-bottom:8px}
.d{font-size:13px;opacity:.72;line-height:1.7}
a.go{display:inline-block;margin-top:16px;font-size:14px;color:#3B82F6;text-decoration:none}
.btn{display:inline-block;margin-top:18px;padding:10px 26px;font-size:15px;border:0;border-radius:12px;background:#3B82F6;color:#fff}
</style>
</head>
<body>
<noscript><div class="card"><div class="t">Mihomo Box</div><div><a class="go" href="$_wr_target">点这里进入面板</a></div></div></noscript>
<script>
(function () {
  var TARGET = '$_wr_target';
  function go() {
    try { window.location.replace(TARGET); }
    catch (e) { window.location.href = TARGET; }
  }
  function showErr() {
    document.body.innerHTML = '<div class="card"><div class="t">面板服务未就绪</div>' +
      '<div class="d">没有连上本机面板服务（' + TARGET + '）。<br>请确认模块已启用；刚开机时服务需要几秒启动。<br>也可点下面按钮重试一次，或直接进入。</div>' +
      '<div><button class="btn" id="retry" type="button">重试</button></div>' +
      '<div><a class="go" href="' + TARGET + '">直接进入</a></div></div>';
    document.getElementById('retry').onclick = function () {
      document.body.innerHTML = '';
      go();
      setTimeout(showErr, 2500);
    };
  }
  // 零延迟瞬间直跳，不等待网络探活往返
  go();
  setTimeout(showErr, 2500);
})();
</script>
</body>
</html>
EOF
}

# 把当前端口 / 令牌烘焙进管理器跳转页。
# 每次服务启动、端口 / 令牌变更后都调用，保证管理器点开即跳对地方。
web_sync_webroot() {
  mkdir -p "${WEB_REDIRECT%/*}" 2>/dev/null || return 1
  webroot_render > "$WEB_REDIRECT.tmp" 2>/dev/null || return 1
  mv "$WEB_REDIRECT.tmp" "$WEB_REDIRECT" 2>/dev/null || return 1
  chmod 644 "$WEB_REDIRECT" 2>/dev/null
}

# 启动一个 httpd 实例并等它就绪；成功返回 0（web_running 为真）。
# 单独抽出来是为了让 web_start 能重试：bind 撞上「端口尚未释放」时再给一次机会。
web_spawn_once() {
  # -p <bind>:port 绑定监听范围；-h 站点根；-c 配置；-f 前台便于取 pid
  # uhttpd 独有参数：它默认最多只并发跑 3 个脚本请求（源码 max_script_requests
  # 默认 3），超出的 CGI 被排队 defer；而面板前端按「HTTP 天生并发」多路齐发
  #（首屏三路并行 + 状态/日志轮询 + 代理大接口），慢命令会把后面的执行桥
  # 请求全堵在队列里，直到前端 15 秒超时误报失败。故 uhttpd 时放宽到 16；
  # busybox httpd 无此概念，不加。
  _sextra=""
  case "$_hb" in uhttpd) _sextra="-n 16" ;; esac
  # setsid 脱离启动方（开机 service / 管理器 CGI）的会话与进程组：与内核
  # 同理，拉起它的脚本退出、会话被回收时不能把面板连带杀掉（开机偶发
  # 「面板起来一会儿又没了」的来源之一）。无 setsid 时回退 nohup。
  # 非作业控制的 sh 里后台子进程不是进程组组长，setsid 直接 exec 不 fork，
  # $! 仍是 httpd 本身。
  if command -v setsid >/dev/null 2>&1; then
    setsid $_hb $_sextra -f -p "$_bind:$_pt" -h "$WEBROOT" -c "$WEB_CONF" </dev/null >> "$WEB_LOG" 2>&1 &
  else
    nohup $_hb $_sextra -f -p "$_bind:$_pt" -h "$WEBROOT" -c "$WEB_CONF" </dev/null >> "$WEB_LOG" 2>&1 &
  fi
  _wpid=$!
  echo $_wpid > "$WEB_PID"
  detach_pid "$_wpid" 2>/dev/null
  # 轮询等待进程就绪，而不是固定 sleep 1。
  # 实测 httpd 十几毫秒就能起来，固定等 1 秒等于白白让用户多等近 1 秒；
  # 反过来在慢设备上固定 1 秒又未必够。这里每 20ms 探一次，最多等 2 秒：
  # 快设备几乎瞬时返回，慢设备也有足够余量。
  # 探测端口是否已被我们的 httpd 监听。优先用 nc，缺失时回退到只看进程存活。
  _wi=0
  _have_nc=0
  have_busybox && "$BUSYBOX" nc --help 2>&1 | grep -q '^Usage: nc' && _have_nc=1
  # 2 秒上限以 now_cs 真实时钟为准（nap 取整成 1s 时轮数与时长解耦）
  now_cs
  if [ "$NOW_CS" -gt 0 ]; then _wp_dl=$((NOW_CS + 200)); else _wp_dl=0; fi
  while [ "$_wi" -lt 100 ]; do
    kill -0 "$_wpid" 2>/dev/null || break      # 进程已退出（端口被占等），立即走报错分支
    if [ "$_have_nc" = 1 ]; then
      "$BUSYBOX" nc -z 127.0.0.1 "$_pt" 2>/dev/null && break
    else
      # 无 nc：进程活过 3 轮（约 60ms）即认为已就绪，httpd 的 bind 是同步的
      [ "$_wi" -ge 3 ] && break
    fi
    if [ "$_wp_dl" != "0" ]; then
      now_cs
      [ "$NOW_CS" -ge "$_wp_dl" ] && break
    fi
    _wi=$((_wi + 1))
    nap 0.02
  done
  web_running
}

web_start() {
  # 不安全端口自救：服务跑在浏览器禁访端口上等于谁都进不来（ERR_UNSAFE_PORT）。
  # 旧版本不拦、手改设置都可能留下这种端口；这里直接修回 55555 并落盘重建，
  # 面板永远有门可进。放短路判断之前：在跑的也照修（顺道重建）。
  _ws_pt=$(web_port)
  case "$_ws_pt" in ''|*[!0-9]*) _ws_pt=55555 ;; esac
  if web_port_unsafe "$_ws_pt"; then
    set_setting webui_port 55555
    printf '%s 自救：端口 %s 被浏览器禁访(ERR_UNSAFE_PORT)，已改回 55555\n' "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$_ws_pt" >> "$WEB_LOG" 2>/dev/null
    echo "WARN: 端口 $_ws_pt 被浏览器禁访(ERR_UNSAFE_PORT)，已自动改回 55555"
    set -- force   # 落盘已改，必须重建服务才生效
  fi
  # $1=force 时无视「已在运行」直接重建（更新模块后的重启用）。
  # 默认行为保留短路：手动点「启动」时不该把好端端的服务重启一遍。
  if [ "$1" = "force" ]; then
    web_stop >/dev/null 2>&1
  else
    web_running && { echo "OK: 面板服务已在运行 (pid $(cat "$WEB_PID"))"; web_info; return 0; }
  fi
  _hb=$(web_httpd_bin) || {
    echo "ERR_NO_HTTPD: 未找到面板 HTTP 服务（busybox httpd / uhttpd），无法启动面板。"
    echo "已查找：PATH / Magisk(/data/adb/magisk/busybox) / KernelSU / APatch / busybox-ndk 模块；uhttpd 于 PATH 中查找。"
    echo "Android 请安装 busybox-ndk 模块；OpenWrt 请执行 opkg install uhttpd（或 apk add uhttpd）后重试。"
    return 1
  }
  [ -d "$WEBROOT" ] || { echo "ERR: 面板目录不存在: $WEBROOT" | return 1; }
  # 模块已被停用时拒绝启动：否则「关闭模块后服务还在跑」的问题会从
  # 别的入口（手动执行、开关监听未运行等）重新冒出来
  [ -f "$MODDIR/disable" ] && { echo "ERR: 模块已停用，请先在管理器中启用模块"; return 1; }
  [ -f "$WEBROOT/cgi-bin/exec.sh" ] || { echo "ERR: 缺少执行桥 cgi-bin/exec.sh，请重新刷入模块"; return 1; }
  _pt=$(web_port)
  case "$_pt" in ''|*[!0-9]*) _pt=55555 ;; esac
  _bind=$(web_bind_addr)
  web_token >/dev/null
  chmod 755 "$WEBROOT/cgi-bin/exec.sh" 2>/dev/null

  # httpd 默认要求 CGI 脚本自身可执行（fork+exec 走 shebang）。模块目录在
  # /data/adb/modules 下，刷入方式不同可能丢执行位，某些设备 overlay 还带 noexec；
  # 加之脚本 shebang 写的是 /system/bin/sh，个别环境并不存在 —— 这些都会让
  # httpd 直接回 404，前端表现就是「无法获取模块状态」。
  # 用 httpd.conf 声明 .sh 的解释器后，httpd 改以「解释器 + 脚本」方式启动，
  # 不依赖执行位与 shebang，兼容性最好。
  _sh=/system/bin/sh
  [ -x "$_sh" ] || _sh=$(command -v sh 2>/dev/null) || _sh=/bin/sh
  # 除解释器外还要声明 MIME：busybox httpd 内置表没有 .webmanifest，
  # 不声明就不带 Content-Type，Chrome 会拒绝解析 manifest，PWA 装不上。
  # manifest 文件现已改名为 manifest.json（ui/manifest.json）：uhttpd 的
  # httpd.conf 解析器根本不认 MIME 行（只认 auth/索引/404/解释器），给它
  # 补声明没用；而它内置 MIME 表有 json → application/json，改用 .json
  # 后缀后两边零配置都给出合法类型。下面 .webmanifest 一行仅作历史兼容
  # （手动放回旧文件时仍正确），实际生效的是 .json 行。
  {
    echo "*.sh:$_sh"
    echo ".webmanifest:application/manifest+json"
    echo ".json:application/json"
    echo ".svg:image/svg+xml"
    echo ".woff2:font/woff2"
    echo "A:*"
  } > "$WEB_CONF" 2>/dev/null

  rm -f "$WEB_PID"
  reset_log "$WEB_LOG"             # httpd 重启：日志从本次开始（含端口/令牌变更后的重启）
  # 保存诊断同样跟服务同生命周期：它只在「保存走了非外科式路径」时由前端整份覆盖写，
  # 界面上只有提示、没有读取方，留着跨重启的旧诊断只会让人误读成「这次又重排了」。
  reset_log "$SAVE_FALLBACK_LOG"
  # 上一会话被 SIGKILL/SIGPIPE 掐死的 CGI 残留目录（run/webui.cgi.*）一并清掉：
  # exec.sh 每个请求会按 pid 清扫，这里在 httpd 重建时兜一次底（此刻本模块
  # 面板服务正在重建，旧 CGI 请求注定失败，清掉无副作用）。
  rm -rf "$RUNDIR"/webui.cgi.* 2>/dev/null
  # 启动前先按「谁在监听这个端口」清一次。
  # 更新模块时「停」与「启」是两次独立调用（停用的是旧脚本），旧 httpd 往往还没
  # 释放端口、pid 文件也已被删 —— 只看 pid 文件必然漏掉它，新实例 bind 直接失败。
  # 端口无人监听时该函数立即返回，几乎零成本。
  web_kill_port_holder
  # 带重试：旧实例释放端口需要一点时间，第一次 bind 撞上很正常。
  # 实测「更新模块后 httpd 起不来」正是卡在这一步，重试后自愈。
  _ws_try=0
  while [ "$_ws_try" -lt 3 ]; do
    web_spawn_once && break
    _ws_try=$((_ws_try + 1))
    [ "$_ws_try" -lt 3 ] || break
    web_kill_port_holder
    nap 0.5
  done
  if ! web_running; then
    rm -f "$WEB_PID"
    echo "ERR: 面板服务启动失败（端口 $_pt 可能被占用），详见 $WEB_LOG"
    # 顺手把占用者报出来：以前只有一句「可能被占用」，用户不知道是谁，也无从下手。
    if ! web_port_check "$_pt"; then echo "     $WEB_PORT_CHECK_MSG"; fi
    return 1
  fi
  # 注意：这里不再写 webui=true。webui 是用户的监听范围意愿（远程开/关），
  # 服务启停（更新时的 stop→start、看门狗拉起）绝不能把它改掉。
  web_sync_webroot 2>/dev/null   # 跳转页跟随当前端口 / 令牌
  lived_start 2>/dev/null   # 状态热缓存守护随面板服务同生
  echo "OK: 面板服务已启动 (pid $(cat "$WEB_PID"), 监听 $_bind:$_pt)"
  web_info
}

web_stop() {
  lived_stop 2>/dev/null   # 面板停则守护停（停用分支由守护自退兜底）
  _wp=$(cat "$WEB_PID" 2>/dev/null)
  rm -f "$WEB_PID"
  # 只杀验明正身的自家 httpd：pid 文件残留且数字被无关进程复用时，照着
  # 旧 pid 直接 kill 会误杀别人（端口兜底 web_kill_port_holder 同样只认
  # 本模块进程，两边口径一致）
  case "$_wp" in ''|*[!0-9]*) _wp="" ;; esac
  if [ -n "$_wp" ] && web_pid_is_httpd "$_wp"; then
    kill "$_wp" 2>/dev/null
    # 必须等它真正退出再返回。kill 只是发信号，进程可能还在善后；
    # 紧接着启动新 httpd 时端口仍被占着（bind 失败），表现就是
    #「更新后远程访问起不来」。这里最多等 2 秒，超时再补一记 KILL。
    _wi=0
    now_cs
    if [ "$NOW_CS" -gt 0 ]; then _ws_dl=$((NOW_CS + 200)); else _ws_dl=0; fi
    while [ "$_wi" -lt 100 ]; do
      kill -0 "$_wp" 2>/dev/null || break
      if [ "$_ws_dl" != "0" ]; then
        now_cs
        [ "$NOW_CS" -ge "$_ws_dl" ] && break
      fi
      _wi=$((_wi + 1))
      nap 0.02
    done
    if kill -0 "$_wp" 2>/dev/null; then
      kill -9 "$_wp" 2>/dev/null
      nap 0.2
    fi
  fi
  # 兜底：pid 文件可能丢失、或与真实进程不符（旧版本残留 / 已被上游删过）。
  # 此时按端口反查还占着的 httpd 一并清掉。不看 pid 文件是否为空 —— 更新模块时
  # pid 文件常常已被删掉，恰恰是最需要这一步的时候。
  web_kill_port_holder
  # 注意：不再写 webui=false。stop 只是停进程（更新/重启时的中间态），
  # 用户的监听范围意愿保留，下次 start 按原范围恢复。
  echo "OK: 面板服务已停止"
}

# ============================================================
# 端口占用检测：改端口前先问一句「这个端口有人监听吗」
#
# 判定只认 TCP LISTEN：httpd 绑的是 TCP，别的进程占着同号 UDP 端口（如 mDNS
# 5353）照样绑得上，把它算成占用只会让人无端换端口。
# 取值路径与下面的清理逻辑同源 —— 不用 ss/netstat（输出格式各家不同，且
# busybox awk 不支持三参数 match()），直接读 /proc/net/tcp{,6} 拿 socket
# inode，再从 /proc/*/fd 反查持有者，不依赖任何外部命令的语法细节。
#
# 三档结论：
#   · 端口空闲                        → 放行
#   · 占着它的是本模块自己的面板 httpd → 放行（web_start 会按端口清掉残留再起）
#   · 任何别的进程                     → 拦下，占用者写进 $WEB_PORT_CHECK_MSG
#
# 成本：端口空闲时只读两个 /proc/net 文件，秒回；只有真被别的进程占用时才扫
# 一遍 /proc/*/fd 反查持有者 —— 也就是报错那一次，慢一点不影响体感。
# ============================================================
WEB_PORT_CHECK_MSG=""

# $1=端口 → 该端口上所有 TCP LISTEN socket 的 inode（空格分隔；无人监听 = 空）
web_port_sock_inodes() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  _wpsi_hx=$(printf '%04X' "$1" 2>/dev/null)
  [ -n "$_wpsi_hx" ] || return 1
  # 只挑真实存在的文件：awk 碰到不存在的文件会 fatal 退出，那会被当成「没人监听」
  _wpsi_f=""
  for _wpsi_n in tcp tcp6; do
    [ -r "/proc/net/$_wpsi_n" ] && _wpsi_f="$_wpsi_f /proc/net/$_wpsi_n"
  done
  [ -n "$_wpsi_f" ] || return 1
  # st 归一化：部分内核输出 8A 而非 0A（见 tproxy_port_listening 的说明），
  # 精确匹配会漏掉真正占着端口的进程，占用检测就形同虚设。
  awk -v p="$_wpsi_hx" '
    function st_norm(s) {
      if (length(s) > 2) s = substr(s, length(s) - 1, 2)
      if (substr(s, 1, 1) == "8") s = "0" substr(s, 2, 1)
      return s
    }
    FNR > 1 {
      n = split($2, a, ":")
      if (toupper(a[n]) == p && st_norm($4) == "0A" && $10 != "" && !seen[$10]++) printf "%s ", $10
    }
  ' $_wpsi_f 2>/dev/null
}

# $1=socket inode 列表（空格分隔）→ 持有这些 socket 的进程 pid（每行一个，去重）
#
# 性能核心：千万不能写 for _wip_fd in /proc/[0-9]*/fd/*; do _wip_t=$(readlink ...); done！
# Android 真实设备常驻 500+ 进程、40000+ 个 fd，逐个 $(readlink) 会触发数万次子 shell fork，
# 在手机上需要整整 1–3 分钟，导致前端界面卡死在「检测中…」。
# 这里直接单次 ls -l /proc/[0-9]*/fd 走 C 语言批量读符号链接，再一趟 awk 流式匹配 inode 并吐出 PID，
# 全过程 5–10 毫秒完成，零 fork、秒级响应。
web_inode_pids() {
  [ -n "$1" ] || return 1
  ls -l /proc/[0-9]*/fd 2>/dev/null | awk -v inos="$1" '
    BEGIN {
      n = split(inos, a, " ")
      for (i = 1; i <= n; i++) wanted[a[i]] = 1
    }
    /^\/proc\/[0-9]+\/fd:?/ {
      n = split($1, parts, "/")
      if (n >= 3) { cur_pid = parts[3]; sub(/:$/, "", cur_pid) }
      next
    }
    /socket:\[[0-9]+\]/ {
      line_pid = cur_pid
      for (i = 1; i <= NF; i++) {
        if (index($i, "/proc/") == 1) {
          n = split($i, parts, "/")
          if (n >= 3 && parts[2] == "proc") line_pid = parts[3]
        }
      }
      for (i = 1; i <= NF; i++) {
        if (index($i, "socket:[") == 1) {
          ino = substr($i, 9)
          sub(/\]$/, "", ino)
          if (line_pid != "" && (ino in wanted) && !seen_pid[line_pid]++) {
            print line_pid
          }
        }
      }
    }
  '
}

# $1=pid → 0 表示这是本模块自己的进程（cmdline 里带模块路径）。
# 清理残留 httpd 与占用判定共用，口径一致，绝不误伤别人的进程。
web_proc_is_ours() { grep -qa "mihomo_box" "/proc/$1/cmdline" 2>/dev/null; }

# $1=pid → 进程短名（给人看的）：cmdline 前两段去路径，取不到退回 comm。
# 如 "busybox httpd -f -p …" → "busybox httpd"；"mihomo -d …" → "mihomo"。
web_proc_name() {
  _wpn_cmd=$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null)
  [ -n "$_wpn_cmd" ] || _wpn_cmd=$(cat "/proc/$1/comm" 2>/dev/null)
  _wpn_first=${_wpn_cmd%% *}
  _wpn_first=${_wpn_first##*/}
  [ -n "$_wpn_first" ] || _wpn_first="未知进程"
  _wpn_rest=${_wpn_cmd#* }
  _wpn_sub=""
  [ "$_wpn_rest" = "$_wpn_cmd" ] || _wpn_sub=${_wpn_rest%% *}
  _wpn_sub=${_wpn_sub##*/}
  case "$_wpn_sub" in -*) _wpn_sub="" ;; esac   # 第二段是选项（如 mihomo -d）就丢掉
  echo "$_wpn_first${_wpn_sub:+ $_wpn_sub}"
}

# 给一个当前空闲的端口（占用报错时顺手告诉用户能换哪个）。
# 候选：请求端口顺延几位 → 模块默认段；跳过禁访端口与越界值。
web_port_suggest() {
  _wps_req=$1
  case "$_wps_req" in ''|*[!0-9]*) _wps_req=55555 ;; esac
  for _wps_p in $((_wps_req + 1)) $((_wps_req + 2)) $((_wps_req + 3)) 55555 55556 55557; do
    [ "$_wps_p" -ge 1024 ] && [ "$_wps_p" -le 65535 ] || continue
    web_port_unsafe "$_wps_p" && continue
    [ -n "$(web_port_sock_inodes "$_wps_p")" ] && continue
    echo "$_wps_p"
    return 0
  done
  return 1
}

# 改端口前的占用检测：$1=目标端口。
# 返回 0 = 可以改（端口空闲，或占着它的只是本模块自己的面板 httpd）；
# 返回 1 = 已被别的进程占用，此时 $WEB_PORT_CHECK_MSG 是给用户看的原因。
web_port_check() {
  _wpc_p=$1
  WEB_PORT_CHECK_MSG=""
  case "$_wpc_p" in ''|*[!0-9]*) return 0 ;; esac
  _wpc_inodes=$(web_port_sock_inodes "$_wpc_p")
  [ -n "$_wpc_inodes" ] || return 0        # 端口空闲：最常见路径，秒回
  # ① 占着它的是当前正在跑的面板 httpd（重设当前端口这类）？
  #    只看它一个进程的 fd，不必扫全系统。
  _wpc_self=$(cat "$WEB_PID" 2>/dev/null)
  case "$_wpc_self" in ''|*[!0-9]*) _wpc_self="" ;; esac
  if [ -n "$_wpc_self" ] && kill -0 "$_wpc_self" 2>/dev/null; then
    for _wpc_fd in /proc/$_wpc_self/fd/*; do
      _wpc_t=$(readlink "$_wpc_fd" 2>/dev/null) || continue
      case "$_wpc_t" in
        socket:\[*\]) _wpc_i=${_wpc_t#socket:[}; _wpc_i=${_wpc_i%]} ;;
        *) continue ;;
      esac
      case " $_wpc_inodes " in *" $_wpc_i "*) return 0 ;; esac
    done
  fi
  # ② 别的进程占着：反查持有者（这一趟扫 /proc/*/fd，只在真被占用时才走）
  _wpc_opid=""; _wpc_oname=""; _wpc_residue=0
  for _wpc_h in $(web_inode_pids "$_wpc_inodes"); do
    if web_proc_is_ours "$_wpc_h"; then
      _wpc_residue=1                      # 自家 httpd 的残留（pid 文件丢了等）
      continue
    fi
    [ -n "$_wpc_opid" ] && continue
    _wpc_opid=$_wpc_h
    _wpc_oname=$(web_proc_name "$_wpc_h")
  done
  # 占着端口的全是我们自己的残留 httpd：放行，web_start 会按端口清掉再起。
  if [ -z "$_wpc_opid" ] && [ "$_wpc_residue" = "1" ]; then return 0; fi
  if [ -n "$_wpc_opid" ]; then
    WEB_PORT_CHECK_MSG="端口 $_wpc_p 已被占用（${_wpc_oname}，pid $_wpc_opid 正在监听）"
  else
    WEB_PORT_CHECK_MSG="端口 $_wpc_p 已被占用（占用者未能识别，可能是系统或其它应用的进程）"
  fi
  # 顺手给个现成的替代端口：用户不用自己去猜哪个端口是空的
  _wpc_sug=$(web_port_suggest "$_wpc_p")
  [ -n "$_wpc_sug" ] && WEB_PORT_CHECK_MSG="$WEB_PORT_CHECK_MSG；可改用空闲端口 $_wpc_sug"
  WEB_PORT_CHECK_MSG="$WEB_PORT_CHECK_MSG。"
  return 1
}

# 按监听端口清掉残留的 httpd。pid 文件缺失/与真实进程不符时的兜底。
# inode→pid 的反查与上面的占用检测共用一套，不再各写一份。
web_kill_port_holder() {
  _kpo_pt=$(web_port)
  case "$_kpo_pt" in ''|*[!0-9]*) return 0 ;; esac
  _kpo_inodes=$(web_port_sock_inodes "$_kpo_pt")
  [ -n "$_kpo_inodes" ] || return 0
  for _kpo_p in $(web_inode_pids "$_kpo_inodes"); do
    # 只杀我们自己的 httpd：确认它确实在提供本模块的面板目录，绝不误伤他人
    web_proc_is_ours "$_kpo_p" || continue
    kill "$_kpo_p" 2>/dev/null
  done
  return 0
}

web_info() {
  _pt=$(web_port)
  if web_auth_on; then _q="/?t=$(web_token)"; else _q="/"; fi
  if web_remote_on; then
    echo "访问地址（同一 Wi-Fi / 本机热点下的设备均可打开；管理器点开模块界面即本机访问）:"
    web_addrs | while IFS='|' read -r _ifn _ip; do
      [ -n "$_ip" ] || continue
      echo "  [$_ifn] http://$_ip:$_pt$_q"
    done
  else
    echo "远程访问已关闭：仅本机可打开（管理器模块界面 / 本机浏览器）："
    echo "  [lo] http://127.0.0.1:$_pt$_q"
  fi
  web_auth_on || echo "（当前未启用访问令牌，任何能连到本机的设备都可打开）"
}

# WebUI 用的 JSON 状态
web_status_json() {
  _pt=$(web_port)
  if web_running; then _r=true; else _r=false; fi
  if web_httpd_bin >/dev/null 2>&1; then _h=true; else _h=false; fi
  if web_auth_on; then _a=true; _tk=$(web_token); else _a=false; _tk=$(web_token); fi
  if web_remote_on; then _b=all; else _b=local; fi
  # 未启用令牌时链接不带 ?t=；逗号交给 awk 处理（while 读管道在子 shell 里，变量不回传）
  if web_auth_on; then _q="/?t=$_tk"; else _q="/"; fi
  _urls=$(web_addrs | awk -F'|' -v pt="$_pt" -v q="$_q" '
    $2 == "" { next }
    { if (n++) printf ","; printf "{\"iface\":\"%s\",\"ip\":\"%s\",\"url\":\"http://%s:%s%s\"}", $1, $2, $2, pt, q }')
  printf '{"running":%s,"httpd":%s,"auth":%s,"port":%s,"bind":"%s","token":"%s","urls":[%s]}\n' \
    "$_r" "$_h" "$_a" "$_pt" "$_b" "$_tk" "$_urls"
}

# ============================================================
# 应用列表：使用 PackageManager 的真实系统标志，不根据 UID 猜测。
# 与默认主用户应用范围一致：user 0；不包含已卸载残留（不使用 -u）。
# packages.list 不含系统标志，不能作为准确分类的降级数据源。
# cmd 避免 pm 的 app_process 包装；都有超时，失败时明确报错。
pkg_query() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 8 "$@"
  elif have_busybox; then
    "$BUSYBOX" timeout 8 "$@"
  else
    echo "ERR: 缺少 timeout，无法安全查询应用列表" >&2
    return 1
  fi
}
pkg_list() {
  _pl_ok=0
  for _pl_backend in cmd pm; do
    if [ "$_pl_backend" = cmd ]; then
      _pl_all=$(pkg_query cmd package list packages --user 0 -U 2>/dev/null) || continue
      _pl_sys=$(pkg_query cmd package list packages --user 0 -U -s 2>/dev/null) || continue
    else
      _pl_all=$(pkg_query pm list packages --user 0 -U 2>/dev/null) || continue
      _pl_sys=$(pkg_query pm list packages --user 0 -U -s 2>/dev/null) || continue
    fi
    # 不把错误文字或不支持的参数返回当成完整列表。
    printf '%s\n' "$_pl_all" | grep -q '^package:.* uid:[0-9]' || continue
    printf '%s\n' "$_pl_sys" | grep -q '^package:.* uid:[0-9]' || continue
    _pl_ok=1
    break
  done
  [ "$_pl_ok" = 1 ] || {
    echo "ERR: 包管理器查询失败，无法准确获取主用户应用及系统分类" >&2
    return 1
  }
  { printf '%s\n' "$_pl_sys"; printf '%s\n' '--ALL--'; printf '%s\n' "$_pl_all"; } | awk '
    $0 == "--ALL--" { all=1; next }
    /^package:/ {
      name=$1; sub(/^package:/,"",name)
      uid=""; for(i=2;i<=NF;i++) if($i ~ /^uid:[0-9]+$/) { uid=$i; sub(/^uid:/,"",uid) }
      if(name=="" || uid=="") next
      if(!all) is_system[name]=1
      else if(!seen[name]++) print name "\t" uid "\t" (is_system[name]?1:0)
    }'
}

# ---------------- 主流程 ----------------

# 启停确认专用最小快照：这里绝不调用 status_json / 内核 -v / API / boot_data。
# status_partial=1 告诉前端合并旧的静态元数据，而不是丢掉内核安装/版本信息。
status_with_action() {
  _swa_rc=$1; _swa_msg=$2
  _swa_pid=""; _swa_run=0; _swa_up=""; _swa_sec=0
  if running; then
    _swa_run=1; _swa_pid=$_rn_pid
    if proc_uptime "$_swa_pid"; then _swa_up=$_pu_etime; _swa_sec=$_pu_sec; fi
    proc_res_usage "$_swa_pid"
  else
    _rs_cpu=null; _rs_memk=0; _rs_dbg=stopped; _rs_wait=0
  fi
  case "$_swa_sec" in ''|*[!0-9]*) _swa_sec=0 ;; esac
  # epoch 必须随 uptime 一起更新，不能让前端合并到上一次采样的旧 epoch。
  case "${EPOCHREALTIME:-}" in
    [0-9]*) _swa_epoch=${EPOCHREALTIME%%.*} ;;
    *) case "${EPOCHSECONDS:-}" in [0-9]*) _swa_epoch=$EPOCHSECONDS ;; *) _swa_epoch=$(date +%s) ;; esac ;;
  esac
  _swa_mode=rule; _swa_cfg=$CONFIG
  [ "$_swa_run" = "1" ] && [ -f "$RUNDIR/active-config.yaml" ] && _swa_cfg="$RUNDIR/active-config.yaml"
  if [ -r "$_swa_cfg" ]; then
    while read -r _swa_key _swa_value _swa_rest; do
      [ "$_swa_key" = "mode:" ] || continue
      case "$_swa_value" in
        global|\"global\"|\'global\') _swa_mode=global ;;
        direct|\"direct\"|\'direct\') _swa_mode=direct ;;
      esac
      break
    done < "$_swa_cfg"
  fi
  # 设置状态为只读短串，不触发规则扫描/安装或内核版本查询。
  setting_v tproxy false; _swa_tp_on=$SV
  _swa_proxy=$(config_proxy_mode "$_swa_cfg")
  _swa_tp=$(tproxy_status_short)
  _swa_tun=$(tunhs_status_short)
  _swa_i6=$(ipv6_proxy_state)
  printf '{"status_partial":1,"running":%s,"pid":"%s","uptime":"%s","uptime_sec":%s,' \
    "$_swa_run" "$_swa_pid" "$_swa_up" "$_swa_sec"
  printf '"epoch_sec":%s,"mode":"%s","mode_src":"config","proxy_mode":"%s","tproxy":"%s","tproxy_state":"%s","tun_hotspot":"%s","ipv6_proxy":"%s",' \
    "$_swa_epoch" "$_swa_mode" "$_swa_proxy" "$_swa_tp_on" "$_swa_tp" "$_swa_tun" "$_swa_i6"
  printf '"cpu_pct":%s,"cpu_dbg":"%s","cpu_wait_ms":%s,"mem_kib":%s,' \
    "${_rs_cpu:-null}" "${_rs_dbg:-wait}" "${_rs_wait:-0}" "${_rs_memk:-0}"
  # 启动/重启成功时把已应用 YAML 同包返回；前端无需再发一次完整状态/配置请求。
  # 读取运行快照，不能把用户刚替换但尚未应用的磁盘文件说成内核实际配置。
  if [ "$_swa_rc" = "0" ] && [ "$_swa_run" = "1" ]; then
    case "${cmd:-}" in
      start-json|restart-json)
        if [ -r "$_swa_cfg" ]; then
          printf '"service_config_b64":"'
          b64_encode < "$_swa_cfg" 2>/dev/null | tr -d '\r\n'
          printf '",'
        fi ;;
    esac
  fi
  action_mark ack_ready
  action_clock
  _swa_ms=$((ACTION_MS - MH_ACTION_BEGIN))
  printf '"action_rc":%s,"action_elapsed_ms":%s,"action_msg":"%s"}\n' \
    "$_swa_rc" "$_swa_ms" "$(json_str_ml "$_swa_msg")"
}
# 命令在当前 shell 执行，释放生命周期锁后才 ACK；不是后台点火后谎报成功。
lifecycle_action_json() {
  MH_ACTION_TRACE="$RUNDIR/action-$$.trace"
  action_clock; MH_ACTION_BEGIN=$ACTION_MS
  printf '0 %s\n' "$1" > "$MH_ACTION_TRACE"
  _aj_log="$RUNDIR/action-$$.out"
  case "$1" in
    start-json) start_core > "$_aj_log" 2>&1 ;;
    stop-json) stop_core > "$_aj_log" 2>&1 ;;
    restart-json) restart_core "${2:-}" > "$_aj_log" 2>&1 ;;
  esac
  _aj_rc=$?
  action_mark lifecycle_returned
  _aj_msg=$(cat "$_aj_log" 2>/dev/null)
  status_with_action "$_aj_rc" "$_aj_msg"
  # 最近一次跟踪便于工具页复制；原始跟踪最多保留少量，避免无限增长。
  cp "$MH_ACTION_TRACE" "$RUNDIR/action-latest.trace" 2>/dev/null
  rm -f "$_aj_log"
  # 轮换靠固定槽：pid%8，原始 pid 文件随即删除；并发忙返回不会覆盖另一条仍在写的文件。
  mv -f "$MH_ACTION_TRACE" "$RUNDIR/action-$(( $$ % 8 )).history" 2>/dev/null
}

cmd="$1"; shift
case "$cmd" in
  start)
    start_core; exit $? ;;
  stop)       stop_core ;;
  restart)
    restart_core "$@"; exit $? ;;
  # 启停/重启并直接吐出状态 JSON（见 status_with_action）
  start-json|stop-json|restart-json)
    lifecycle_action_json "$cmd" "$@"; exit 0 ;;
  _lifecycle-tail)
    sync_state_desc >/dev/null 2>&1; exit 0 ;;
  action-trace)
    cat "$RUNDIR/action-latest.trace" 2>/dev/null ;;
  # 管理器「运行」按钮（action.sh）：一个进程内完成 监听/面板保活 + 切换内核 +
  # 描述刷新。以前 action.sh 串行拉起 6 次本脚本、外加 3 秒固定 sleep。
  action-toggle)
    switch_start >/dev/null 2>&1
    web_start >/dev/null 2>&1
    if running; then
      echo "⏹ mihomo 正在运行，正在停止…"
      stop_core >/dev/null 2>&1
      echo "✅ 已停止"
    else
      echo "▶ mihomo 未运行，正在启动…"
      if start_core; then
        echo "✅ 已启动，详见 WebUI 主页"
      else
        echo "⚠ 启动未成功，请打开 WebUI 主页查看日志"
      fi
    fi
    sync_state_desc
    exit 0 ;;
  running)    running ;;
  detach)
    if running; then detach_pid "$(pid_of)"; echo "OK: 内核已脱离 App cgroup (pid $(pid_of))"; else echo "内核未运行"; fi ;;
  status)     status_cached ;;
  # 跳过 api_mode 的 curl（内核刚启停时控制器还没听，3s 超时会把主页刷新拖到十来秒）
  status-fast) _SJ_FAST=1; status_cached ;;
  res)        res_json ;;
  mod-state)  mod_state_json ;;
  boot-data)  boot_data ;;
  boot-data-sync) boot_data_sync && echo "OK" ;;
  # 热缓存前台刷新：先作废（读数立刻走新鲜慢路），再重算入库。前端变更后 ping 它。
  # 同步作废 boot_data 聚合缓存（内含 config_b64），否则保存后重进面板会拿到旧配置
  live-refresh) live_invalidate; rm -f "$BOOT_DATA_CACHE" 2>/dev/null; lived_tick >/dev/null 2>&1; ( boot_data_sync ) >/dev/null 2>&1 & echo "OK" ;;
  _lived-loop)  _lived_loop ;;
  syncdesc)   sync_state_desc; echo "OK" ;;
  healprop)   if heal_prop; then echo "OK: module.prop 正常"; else echo "ERR: 无法修复 module.prop"; fi ;;
  webui-start)   web_start ;;
  # 启动后直接吐出状态 JSON：前端点一次按钮只需一次往返，
  # 不必再串行发一条 webui-status（在慢设备上那是实打实的二次延迟）
  webui-start-json)
    web_start >/dev/null 2>&1
    web_status_json ;;
  webui-restart-json)
    web_start force >/dev/null 2>&1
    web_status_json ;;
  webui-stop)    web_stop ;;
  webui-restart) web_start force ;;
  webui-status)  web_status_json ;;
  webui-info)    web_info ;;
  # 远程访问范围：true → 0.0.0.0（局域网可进）；false → 127.0.0.1（仅本机/管理器）。
  # 服务本身常驻不停，只是换监听地址重建一次。
  webui-remote)
    case "$1" in
      true|on|1)  set_setting webui true ;;
      false|off|0) set_setting webui false ;;
      *) echo "ERR: 参数只能是 true / false"; exit 1 ;;
    esac
    if web_running; then
      web_start force
    else
      web_sync_webroot 2>/dev/null
      echo "OK: 已记录（服务未运行，下次启动时按新范围监听）"
    fi ;;
  webui-port)
    case "$1" in
      ''|*[!0-9]*) echo "ERR: 端口必须是数字"; exit 1 ;;
    esac
    [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || { echo "ERR: 端口范围 1-65535"; exit 1; }
    web_port_unsafe "$1" && { echo "ERR: 端口 $1 是浏览器禁访端口（报 ERR_UNSAFE_PORT，谁都进不来），请换一个（如 55555）"; exit 1; }
    # 占用检测：目标端口已被别的进程监听 → 直接拒绝，设置一个字节都不动。
    # 以前是「先写设置、再停服务重建」，bind 撞车后新端口起不来、旧端口也回不去
    # （设置已被新值覆盖），面板就此掉线且用户以为端口已改。现在检测在前，
    # 失败即无副作用；占着端口的是本模块自己的 httpd 残留时照常放行。
    if ! web_port_check "$1"; then
      printf '%s 改端口被拒：%s\n' "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$WEB_PORT_CHECK_MSG" >> "$WEB_LOG" 2>/dev/null
      echo "ERR: 端口修改已取消 —— $WEB_PORT_CHECK_MSG"
      exit 1
    fi
    set_setting webui_port "$1"
    echo "OK: 端口已设为 $1"
    if web_running; then web_stop >/dev/null 2>&1; web_start; else web_sync_webroot 2>/dev/null; fi ;;
  webui-token-reset)  web_token_reset >/dev/null; web_sync_webroot 2>/dev/null; echo "OK: 访问令牌已恢复默认 ($WEB_TOKEN_DEFAULT)" ;;
  webui-token-random) web_token_random >/dev/null; web_sync_webroot 2>/dev/null; echo "OK: 已生成随机令牌 ($(web_token))" ;;
  webui-token-set)   web_token_set "$1" && web_sync_webroot 2>/dev/null ;;
  webui-auth)
    case "$1" in
      true|on|1)  set_setting webui_auth true;  web_token >/dev/null; echo "OK: 已启用访问令牌" ;;
      false|off|0) set_setting webui_auth false; echo "OK: 已关闭访问令牌（局域网内任何设备均可打开）" ;;
      *) echo "ERR: 参数只能是 true / false"; exit 1 ;;
    esac
    web_sync_webroot 2>/dev/null ;;
  webroot-render) webroot_render "$1" "$2" ;;
  webroot-sync)   web_sync_webroot && echo "OK: 管理器跳转页已同步" ;;
  pkg-list)    pkg_list ;;
  app-info|app-info-labels|app-info-icons)
    # 批次上限与前端一致（名称 1024 / 图标 200，两路并发）；超了直接报错，
    # 不静默截断——截断会让前端以为这些包「没有名称/图标」。
    _app_limit=200; _app_mode=""
    case "$cmd" in app-info-labels) _app_limit=1024; _app_mode=--labels ;; app-info-icons) _app_mode=--icons ;; esac
    [ "$#" -le "$_app_limit" ] || { echo "ERR: 应用信息批次过大" >&2; exit 1; }
    [ -r "$MODDIR/scripts/app-info.dex" ] || { echo "ERR: 应用信息组件缺失，请重新刷入模块" >&2; exit 1; }
    for _app_pkg in "$@"; do
      case "$_app_pkg" in ''|*[!A-Za-z0-9_.]*) echo "ERR: 无效包名" >&2; exit 1 ;; esac
    done
    export CLASSPATH="$MODDIR/scripts/app-info.dex"
    # 200 个图标要逐个解码 + 压 PNG，慢设备上比名称批量重得多，放宽到 60s
    # 取图标时若 native 断言杀掉进程，stderr 里只有一句断言；断点文件记录了死在哪个包的哪一步
    _app_trace="$RUNDIR/appinfo.trace"; _app_err="$RUNDIR/appinfo.err"
    mkdir -p "$RUNDIR" 2>/dev/null; rm -f "$_app_trace" "$_app_err" 2>/dev/null
    export APPINFO_TRACE="$_app_trace"
    run_timeout 60 app_process /system/bin AppInfo $_app_mode "$@" 2>"$_app_err"
    _app_rc=$?
    if [ "$_app_rc" -ne 0 ]; then
      [ -s "$_app_trace" ] && printf '[断点 %s] ' "$(head -c 160 "$_app_trace")" >&2
      head -c 400 "$_app_err" >&2 2>/dev/null
    fi
    exit $_app_rc
    ;;
  switch-start) switch_start ;;
  switch-stop)  switch_stop ;;
  switch-status) if switch_running; then echo "running $(cat "$SWITCH_PID")"; else echo "stopped"; fi ;;
  _switch-loop) _switch_loop ;;
  # TUN 热点共享：手动对账 / 清残 / 查看状态（正常情况下由启停/热重载/监听循环自动维护）
  tun-hotspot-sync)   tun_hotspot_sync && echo "OK: 已对账 $(tunhs_status_short)" ;;
  tun-hotspot-clean)  tun_hotspot_orphan_clean; echo "OK: 已清残" ;;
  tun-hotspot-status) tun_hotspot_status ;;
  tun-hotspot-diag)   tun_hotspot_diag ;;
  # 系统 IPv6：手动对账一次 / 查看各网卡实况（正常由监听循环每 IPV6_TICK 秒自动做）
  ipv6-sync)     system_ipv6_sync >/dev/null 2>&1; echo "OK: 系统 IPv6 已按当前开关对账" ;;
  ipv6-status)   ipv6_status ;;
  ipv6-guard)    ipv6_proxy_guard ;;
  # APN 协议接管（等效「APN 协议=IPv4」防蜂窝 v6 泄漏，不碰 IMS）：
  apn4-status)   apn4_status ;;
  apn4-json)     apn4_json "$1" ;;
  apn4-apply)    apn4_apply  && echo "OK: APN 已按 IPv4 接管（详见 $APN4_LOG）" ;;
  apn4-restore)  apn4_restore && echo "OK: APN 协议已还原（详见 $APN4_LOG）" ;;
  # Tproxy 透明代理：开关主流程 / 手动对账 / 查看状态
  tproxy-set)    tproxy_apply "$1" "$2"; _tp_rc=$?; [ $_tp_rc -eq 0 ] && live_invalidate 2>/dev/null; exit $_tp_rc ;;
  tproxy-sync)   tproxy_sync && echo "OK: 已对账 $(tproxy_status_short)" ;;
  net-sync)
    # 一次进程内跑完两组规则对账（TUN 热点转发 + TProxy）。以前各处都是
    # `sh $0 tun-hotspot-sync; sh $0 tproxy-sync` 连拉两次，每拉一次都要重新
    # 解析一份 9000+ 行的脚本（慢设备 100~200ms），两者之间还白等一个进程启动。
    # _SW_QUICK=1 由调用方通过环境变量传入，两个函数各自识别（跳过抽查的全量轮）。
    # 互切时与 _start_core_body 同一原则：先跑「装」的那一路，再跑「清残留」的
    # 那一路，别让逐条 -D / ip rule del 抢装配的 xtables 锁。
    _ns_tun_on=0; _ns_tp_on=0
    tunhs_tun_enabled && _ns_tun_on=1
    [ "$(get_setting tproxy false)" = "true" ] && _ns_tp_on=1
    if [ "$_ns_tp_on" = "1" ] && [ "$_ns_tun_on" = "0" ]; then
      tproxy_sync >/dev/null 2>&1
      tun_hotspot_sync >/dev/null 2>&1
    else
      tun_hotspot_sync >/dev/null 2>&1
      tproxy_sync >/dev/null 2>&1
    fi
    exit 0 ;;
  tproxy-status) tproxy_status ;;
  tproxy-diag)   tproxy_diag ;;
  boot)
    # 无守护进程：仅按 autostart 设置决定开机是否直接启动内核。
    # 整条开机链在这里一次跑完（面板 → 网络门槛 → 内核 → 开关监听），
    # service.sh 只调用一次本命令：每多调一次 `sh mihomo.sh` 都要重新解析
    # 一份 9000+ 行的脚本，慢设备上单次 100~200ms，纯属白付。
    action_clock; MH_ACTION_BEGIN=$ACTION_MS
    # 面板先于一切拉起：面板只是一个 HTTP 服务，不依赖内核、IPv6 或网络。
    # 系统 IPv6 对账（含 APN 协议改写，真机上要 fork 十几次 settings/ip 命令，
    # 首次接管可达数百毫秒）排在它后面 —— 否则开机后要多等这一整段才能打开面板。
    # 内核启动（校验与等待）也同理，放在面板后面。
    [ -f "$MODDIR/disable" ] || web_start >/dev/null 2>&1
    action_mark boot_web_ready
    system_ipv6_sync >/dev/null 2>&1   # 系统 IPv6 开关开机即生效（之后由监听循环维持）
    action_mark boot_ipv6_ready
    setting_v autostart true; _bt_auto=$SV
    _bt_sup=0
    if [ "$_bt_auto" = "true" ] && [ -x "$(core_path)" ]; then
      # 网络门槛：只等「默认路由出现」（/proc 内建读，通常 1 秒内），而不是
      # ping 循环最多 90 秒。默认路由都没有时内核的订阅/provider 必然拉不动；
      # 但也不必等 ICMP 通 —— 真起不来由 boot_supervise 退避重试兜底。
      if wait_net_ready "${MH_BOOT_NET_WAIT:-20}"; then
        action_mark boot_net_ready
      else
        action_mark boot_net_timeout
        echo "boot: 等待默认路由超时（继续启动内核，由其自身重试）"
      fi
      boot_first_start
      _bt_sup=1
    elif [ "$_bt_auto" = "true" ]; then
      echo "boot: 无内核，跳过自启"
      sync_state_desc
    else
      echo "boot: 自启已关闭"
      sync_state_desc
    fi
    switch_start >/dev/null 2>&1
    # 面板 HTTP 服务：模块启用即随开机拉起（管理器界面 + 浏览器共用）。
    # 上面已经起过一次（本次在运行时短路返回）；这里只兜「内核拉起期间面板
    # 挂了」的情况。模块被停用时 disable 标记仍在，此时不该起服务 —— 开关
    # 监听会在用户重新启用模块后自动补起来。
    if [ ! -f "$MODDIR/disable" ]; then
      web_start >/dev/null 2>&1
    fi
    ( boot_data_sync ) >/dev/null 2>&1 &
    # 自启保障：面板已经能打开之后，再盯住内核是否真的就绪（见 boot_supervise）
    [ "$_bt_sup" = "1" ] && { boot_supervise; _bt_rc=$?; exit $_bt_rc; }
    exit 0 ;;
  setcore)
    # $1 = liuran001 | jieluojun | official
    case "$1" in
      liuran001|jieluojun|official) _sc_new=$1 ;;
      *) echo "ERR: 内核只能是 liuran001、jieluojun 或 official"; exit 1 ;;
    esac
    core_label_v "$_sc_new"; _sc_label=$CLV
    _sc_old=$(get_setting core jieluojun)
    case "$_sc_old" in official|liuran001) : ;; *) _sc_old=jieluojun ;; esac   # 同 core_path：其余值一律按 jieluojun
    core_label_v "$_sc_old"; _sc_old_label=$CLV
    # 内核未运行：只改设置，不做任何等待（切换瞬间完成）
    if ! running; then
      set_setting core "$_sc_new"
      echo "OK: 已切换到 $_sc_label（内核未运行，下次启动时生效）"
      live_invalidate 2>/dev/null
      ( boot_data_sync ) >/dev/null 2>&1 &
      exit 0
    fi
    if [ "$_sc_new" = "$_sc_old" ]; then
      echo "OK: 当前已使用 $_sc_label，无需切换"
      exit 0
    fi
    # 先校验新内核能否吃下当前配置。
    # 不兼容时（如官方内核 + Smart 策略组）在这里就返回，避免
    # 「停掉正在跑的内核 → 起不来 → 干等启动超时」这条最慢的路径。
    echo "切换到 $_sc_label：正在校验配置…"
    set_setting core "$_sc_new"
    if ! verify_config; then
      set_setting core "$_sc_old"      # 回滚，保持当前内核继续运行
      echo ""
      echo "已取消切换，仍在使用 $_sc_old_label（服务未中断）"
      echo "请修正上述配置后重试；完整校验日志: $RUNDIR/test.log"
      exit 1
    fi
    echo "校验通过，正在重启内核…"
    restart_core || exit 1
    ( boot_data_sync ) >/dev/null 2>&1 &
    echo "OK: 已切换到 $_sc_label 并重启完成 (pid $(pid_of))" ;;
  set)
    # tproxy / system_ipv6 走专用流程：前者要先识别端口并做能力探测（不通过
    # 则拒绝开启，不能盲写设置），后者写完立即对账 sysctl
    case "$1" in
      tproxy)
        tproxy_apply "$2" "$3"; _tp_rc=$?; [ $_tp_rc -eq 0 ] && live_invalidate 2>/dev/null; ( boot_data_sync ) >/dev/null 2>&1 & exit $_tp_rc ;;
      system_ipv6)
        case "$2" in
          true|on|1)   _s6_v=true;  _s6_wd=启用 ;;
          false|off|0) _s6_v=false; _s6_wd=禁用 ;;
          *) echo "ERR: 参数只能是 true / false"; exit 1 ;;
        esac
        set_setting system_ipv6 "$_s6_v"
        # 系统 IPv6＝总开关：切换的同时把配置里的 IPv6 相关开关（顶层 ipv6 /
        # dns.ipv6 / eBPF 入站 local·shared.ipv6）一并改齐（见 cfg_ipv6_set_all），
        # 再重启服务让内核与 eBPF 入站按新开关重建（包括 eBPF 的 v6 重定向路由）。
        # 校验指纹联动：本次手术只翻上面 4 个布尔开关。改前的配置若已通过校验
        # （指纹在 TESTED 里），改后必然同样有效——把指纹直接记成新配置，让
        # start_core 的 verify_config 命中缓存跳过整轮 mihomo -t。大配置每轮
        # 1~3 秒起步，带远程 provider 的还得在线拉取，是「开关系统 IPv6 要等很久」
        # 最大的一截。改前没校验过的一律照旧真跑，不给手术护短。
        _s6_fp0=$(config_fingerprint)
        _s6_chg=$(cfg_ipv6_set_all "$_s6_v")
        case "$_s6_chg" in ''|*[!0-9]*) _s6_chg=0 ;; esac
        if [ "$_s6_chg" != "0" ] && [ "$_s6_fp0" = "$(cat "$TESTED" 2>/dev/null)" ]; then
          config_fingerprint > "$TESTED" 2>/dev/null
        fi
        # 用户显式打开系统 IPv6 = 请求重试代理侧 IPv6。旧的能力失败标记只
        # 防止后台循环自动反复试；这里清掉后交给 ipv6_proxy_guard 实测，若仍失败
        # 它会重新落标记、回退配置为 IPv4-only 并重启，避免静默绕过代理。
        if [ "$_s6_v" = "true" ] && [ "$(cfg_top_ipv6)" = "true" ]; then
          if [ -f "$IPV6_PFAIL" ]; then
            sw_log "用户显式启用系统 IPv6，重试此前失败的代理侧 IPv6 接管"
            rm -f "$IPV6_PFAIL" 2>/dev/null
          fi
        fi
        system_ipv6_sync
        # 系统 IPv6 开↔关 = TPROXY 是否劫持 v6，立即对账装卸 v6 规则。放后台不
        # 阻塞返回：start_core 拉起后还会起 tproxy 对账循环、开关监听循环也会
        # 周期兜底，规则是收敛式的；同步串行跑 iptables（60~100 次调用，2~4 秒）
        # 会把「正在重启服务…」白白拖长（与 hotspot_proxy 同款处理）。
        [ "$(get_setting tproxy false)" = "true" ] && tproxy_sync >/dev/null 2>&1 &
        live_invalidate 2>/dev/null
        ( boot_data_sync ) >/dev/null 2>&1 &
        _s6_done="系统 IPv6 已$_s6_wd，配置里的 IPv6 相关开关已同步（$_s6_chg 项）"
        if running; then
          echo "IPv6 相关配置已同步（$_s6_chg 项），正在重启服务…"
          # 刚跑完 system_ipv6_sync（含 APN 侧）：start_core 里的例行再对账是纯
          # 重复（还要再付一轮 APN 查询，会把写 pid 拖到数秒之后），跳过。
          MH_SKIP_IPV6=1
          export MH_SKIP_IPV6
          if ! restart_core; then
            unset MH_SKIP_IPV6
            echo "ERR: $_s6_done，但服务重启失败，请检查配置后手动启动"
            exit 1
          fi
          unset MH_SKIP_IPV6
          echo "OK: $_s6_done，服务已重启"
          exit 0
        fi
        echo "OK: $_s6_done；服务未运行，下次启动时生效"
        exit 0 ;;
    esac
    set_setting "$1" "$2" || exit 1
    live_invalidate 2>/dev/null
    # 后台预热配置校验：设置改动可能连带配置文件变化，随后的「重载/启动」就不必
    # 在关键路径上再跑一遍 mihomo -t（见 verify_prewarm_async）
    verify_prewarm_async
    ( boot_data_sync ) >/dev/null 2>&1 &
    echo "OK"
    # 热点共享代理开关变化 → 立即对账装卸规则（后台执行，不阻塞返回；
    # 开关监听循环的周期对账会兜底，这里只是让切换即时生效）
    [ "$1" = "hotspot_proxy" ] && tun_hotspot_sync >/dev/null 2>&1 & ;;
  verify-prewarm)
    # 内部命令：配置落盘后由前端/其它命令在后台调用，把 mihomo -t 挪出关键路径。
    # 结果只写缓存（tested.fp / verify.fail），任何时候都能安全地重复调用。
    verify_prewarm
    exit 0 ;;
  test)
    core=$(core_path)
    if [ ! -x "$core" ]; then echo "ERR_NO_CORE: 内核不存在"; exit 1; fi
    "$core" -t -d "$WORKDIR" -f "$CONFIG" 2>&1
    _tv_rc=$?
    # 校验通过即记指纹（与 verify_config 同款）：随后启动的 verify_config 命中
    # 缓存直接跳过，免得「手动校验 → 启动」把整轮 mihomo -t 付两次（大配置
    # 每轮 1~3 秒，是开启服务最显眼的一截等待）。
    [ "$_tv_rc" = "0" ] && config_fingerprint > "$TESTED" 2>/dev/null
    exit $_tv_rc ;;
  download-core) download_core "$@" ;;
  _dl-run)      _dl_run "$@" ;;
  download-status)
    if [ -f "$DL_PID" ] && kill -0 "$(dl_pid_of)" 2>/dev/null; then
      [ -f "$DL_STATUS" ] && cat "$DL_STATUS" || echo '{"stage":"downloading","percent":0,"loaded":0,"total":0}'
    else
      [ -f "$DL_STATUS" ] && cat "$DL_STATUS" || echo '{"stage":"idle","percent":0,"loaded":0,"total":0}'
    fi ;;
  download-cancel)
    # 先精确杀：下载器子进程（pid 文件）+ 任务主进程。故意不用 pkill -P：
    # 部分设备 toybox 不支持 -P，静默失败后父进程先死、curl 失亲（PPid=1）继续跑满超时。
    if [ -f "$DL_FETCH_PID" ]; then
      _kfp=$(cat "$DL_FETCH_PID" 2>/dev/null)
      [ -n "$_kfp" ] && kill -9 "$_kfp" 2>/dev/null
    fi
    [ -f "$DL_PID" ] && kill -9 "$(dl_pid_of)" 2>/dev/null
    rm -f "$DL_PID"
    # 立即回报：孤儿横扫刚被移到后台（它那次 /proc 扫描要一两秒，之前就卡在
    # 这里，点了「取消下载」得眼巴巴等它扫完才回到界面）。
    dl_emit "cancelled" 0 0 0 "" "已取消"
    echo "cancelled"
    # 兜底清扫可以慢，但不能挡住用户：交给后台，界面即时翻转。
    ( kill_stale_fetchers ) </dev/null >/dev/null 2>&1 &
    ;;
  get)        get_setting "$1" "$2" ;;
  download-geo)  download_geo ;;
  _geo-run)      _geo_run ;;
  download-geo-status)
    if [ -f "$GEO_PID" ] && kill -0 "$(geo_pid_of)" 2>/dev/null; then
      [ -f "$GEO_STATUS" ] && cat "$GEO_STATUS" || echo '{"stage":"downloading","percent":0,"loaded":0,"total":0}'
    else
      [ -f "$GEO_STATUS" ] && cat "$GEO_STATUS" || echo '{"stage":"idle","percent":0,"loaded":0,"total":0}'
    fi ;;
  download-geo-cancel)
    if [ -f "$GEO_FETCH_PID" ]; then
      _kfp=$(cat "$GEO_FETCH_PID" 2>/dev/null)
      [ -n "$_kfp" ] && kill -9 $_kfp 2>/dev/null   # 支持多 pid（并发 hash 探测）逐词展开
    fi
    [ -f "$GEO_PID" ] && kill -9 "$(geo_pid_of)" 2>/dev/null
    rm -f "$GEO_PID" "$RUNDIR"/geo_download.*.tmp
    # 与 download-cancel 同策略：孤儿横扫移到后台，界面立即翻转，不再干等 /proc 扫描。
    geo_emit "cancelled" 0 0 0 "" "已取消"
    echo "cancelled"
    ( kill_stale_fetchers ) </dev/null >/dev/null 2>&1 &
    ;;
  import-core)   import_core "$@"; _ic_rc=$?; [ $_ic_rc -eq 0 ] && live_invalidate 2>/dev/null; [ $_ic_rc -eq 0 ] && verify_prewarm_async; exit $_ic_rc ;;
  check-env)     check_env ;;
  wait-net)
    # 等网络就绪。判据是内核路由表里的默认路由（零 fork），不再死等 ICMP：
    # 旧实现 ping 循环 45×2s，ICMP 被拦时必然跑满 90 秒。$1 可指定上限秒数。
    if wait_net_ready "${1:-}"; then echo "network ready"; exit 0; fi
    echo "network wait timeout"; exit 0 ;;
  api)
    api "$@"
    _api_rc=$?
    # 切模式走执行桥时，调用方会把 MH_API_MODE 带进来：说明这次 PATCH 改的是
    # 运行模式，首屏快照（内嵌整份 status，含旧 mode）已经过期，就地作废 ——
    # 反正脚本已经在跑，一次 rm 等于免费；直连 HTTP 时前端用一条 fire-and-forget
    # 的 rm 达到同样效果，都不必再为此单独拉一次 shell。
    case "${MH_API_MODE:-}" in
      rule|global|direct)
        [ "$_api_rc" = "0" ] && [ "$1" = "PATCH" ] && [ "$2" = "/configs" ] && rm -f "$BOOT_DATA_CACHE" 2>/dev/null ;;
    esac
    # 配置热重载可能切换 TUN / 改 TProxy 端口：后台延时几秒重查热点转发与
    # Tproxy 规则（TUN 网卡重建、TProxy 端口重新监听都需要一点时间）
    if [ "$1" = "PUT" ] && [ "$2" = "/configs" ]; then
      ( sleep 3; sh "$0" net-sync </dev/null >/dev/null 2>&1 ) </dev/null >/dev/null 2>&1 &
    fi
    exit $_api_rc ;;
  switch-mode)   switch_mode "$1" ;;
  update-subs)   update_subs ;;
  update-sub)    update_one_sub "$1" "$2" ;;
  _us-run)      _us_run ;;
  update-subs-status)
    [ -f "$US_STATUS" ] && cat "$US_STATUS" || echo '{"stage":"idle","done":0,"total":0,"ok":0,"fail":0,"skipped":0,"detail":[]}' ;;
  logs)          n="${1:-100}"; tail -n "$n" "$LOGFILE" 2>/dev/null ;;
  logs-clear)    [ -f "$LOGFILE" ] && : > "$LOGFILE" 2>/dev/null; echo "OK: 运行日志已清空" ;;
  version)
    core_label_v liuran001;    _v_l=$CLV
    core_label_v jieluojun; _v_j=$CLV
    core_label_v official;  _v_o=$CLV
    echo "$_v_l: $(core_version $CORE_LIURAN001)"
    echo "$_v_j: $(core_version $CORE_JIELUOJUN)"
    echo "$_v_o: $(core_version $CORE_OFFICIAL)" ;;
  netmatch-get)
    if [ -f "$NETMATCH_CONF" ]; then
      cat "$NETMATCH_CONF"
    else
      echo '{"enabled":false,"on_match":"start","on_mismatch":"stop","log":false,"rules":[]}'
    fi
    exit 0 ;;
  netmatch-set)
    _nms_val="$1"
    mkdir -p "$WORKDIR" "$RUNDIR" 2>/dev/null
    printf '%s\n' "$_nms_val" > "$NETMATCH_CONF.tmp.$$" 2>/dev/null && \
      mv -f "$NETMATCH_CONF.tmp.$$" "$NETMATCH_CONF" 2>/dev/null || rm -f "$NETMATCH_CONF.tmp.$$"
    rm -f "$NETMATCH_STATE" 2>/dev/null
    switch_running || switch_start >/dev/null 2>&1
    netmatch_tick
    echo "OK: 网络匹配配置已保存"
    exit 0 ;;
  netmatch-status)
    _ns_info=$(netmatch_detect)
    _ns_wifi=$(echo "$_ns_info" | cut -d'|' -f1)
    _ns_ssid=$(echo "$_ns_info" | cut -d'|' -f2)
    _ns_bssid=$(echo "$_ns_info" | cut -d'|' -f3)
    _ns_cell=$(echo "$_ns_info" | cut -d'|' -f4)
    _ns_mcc=$(echo "$_ns_info" | cut -d'|' -f5)
    _ns_sim=$(echo "$_ns_info" | cut -d'|' -f6)
    _ns_mat=0; netmatch_eval && _ns_mat=1
    printf '{"wifi":%s,"ssid":"%s","bssid":"%s","cellular":%s,"mcc_mnc":"%s","sim":%s,"matched":%s}\n' \
      "${_ns_wifi:-0}" "$_ns_ssid" "$_ns_bssid" "${_ns_cell:-0}" "$_ns_mcc" "${_ns_sim:-0}" "$_ns_mat"
    exit 0 ;;
  netmatch-log)
    [ -f "$NETMATCH_LOG" ] && cat "$NETMATCH_LOG" || echo "暂无网络控制日志"
    exit 0 ;;
  netmatch-clear-log)
    rm -f "$NETMATCH_LOG" 2>/dev/null
    echo "OK: 网络控制日志已清空"
    exit 0 ;;
  httpclient)
    # 诊断用：读出当前实际会用的 HTTP 客户端，并列出全部候选的实测结果。
    # 代理列表读不到、切换节点失败时，先看这个能立刻分清是「没有客户端」
    # 还是「客户端坏了」（比如 wget 是缺 applet 的 toybox 软链接）。
    _hc=$(_http_client_pick) && echo "OK: $_hc" || echo "ERR: 无可用的 HTTP 客户端（curl / wget 都不可用）"
    _hcl=$(_http_client_list 2>/dev/null)
    while IFS= read -r _c; do
      [ -n "$_c" ] || continue
      if _http_client_usable "$_c"; then echo "  [可用]   $_c"; else echo "  [不可用] $_c"; fi
    done <<MH_HTTP_CLIENT_DIAGNOSTICS
$_hcl
MH_HTTP_CLIENT_DIAGNOSTICS
    _hn=$(_nc_bin) && echo "写请求兜底(nc): $_hn" || echo "写请求兜底(nc): 不可用（无 curl 时将无法切换节点）"
    ;;
  # WebUI「远程下载配置」：单次抓取 http(s) 正文并原样吐到 stdout，
  # 前端校验 YAML 后加入草稿（点保存才写文件），不直接动配置文件。
  # 复用 fetch_one_stdout 的客户端回退链（curl → wget → toybox → busybox），
  # 超时口径与它一致（≤12s），收在执行桥 15s 上限内。
  # GitHub 地址先走镜像候选（国内直连常不通），其余直连；末尾恒留直连保底。
  fetch-url)
    # dispatch 顶部已 cmd="$1"; shift —— 这里 URL 在 $1
    _fu_url="$1"
    case "$_fu_url" in
      http://*|https://*) : ;;
      *) echo "ERR: 地址需以 http:// 或 https:// 开头" >&2; exit 1 ;;
    esac
    if is_github_url "$_fu_url"; then
      _fu_entries=$(mirror_candidates 2>/dev/null)
    else
      _fu_entries=""
    fi
    case "$_fu_entries" in
      *"直连GitHub"*) : ;;
      *) _fu_entries="$_fu_entries
直连GitHub -" ;;
    esac
    _fu_ok=1
    _fu_ifs=$IFS; IFS='
'
    case $- in *f*) _fu_noglob=1 ;; *) _fu_noglob=0; set -f ;; esac
    for _fu_entry in $_fu_entries; do
      [ -n "$_fu_entry" ] || continue
      _fu_prefix=$(cand_prefix "$_fu_entry") || { echo "跳过非法候选 [$_fu_entry]" >&2; continue; }
      _fu_body=$(fetch_one_stdout "${_fu_prefix}${_fu_url}" 2>/dev/null) && [ -n "$_fu_body" ] && {
        printf '%s' "$_fu_body"; _fu_ok=0; break; }
      echo "抓取失败 [$_fu_entry]" >&2
    done
    [ "$_fu_noglob" = "1" ] || set +f; IFS=$_fu_ifs
    [ "$_fu_ok" = "0" ] || { echo "ERR: 下载失败（镜像与直连均未取到内容）" >&2; exit 1; }
    exit 0 ;;
  *) echo "未知命令: $cmd"; exit 2 ;;
esac
