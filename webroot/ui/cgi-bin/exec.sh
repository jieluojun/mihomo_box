#!/system/bin/sh
# 注：httpd 已通过 httpd.conf 指定解释器调用本脚本，不依赖此 shebang 与执行位。
# ============================================================
# WebUI 浏览器访问桥：把 HTTP 请求转成 root shell 执行
# 由 busybox httpd 以 CGI 方式调用（httpd 本身以 root 运行）
#
# 请求：POST /cgi-bin/exec.sh
#   头  X-Mihomo-Token: <令牌>   （或 ?t=<令牌>）
#   体  base64(shell 命令)
# 响应：{"errno":N,"stdout_b64":"...","stderr_b64":"..."}
#
# 之所以整段 base64：命令里常含引号/换行/中文（写配置就是 base64 管道），
# 直接明文传会被 URL 解码与 shell 二次解析破坏。
# ============================================================

# 安装目录：由本脚本位置推断（cgi-bin/ 向上 3 级）。Android 模块（/data/adb/modules/*）
# 的工作目录固定为 /data/adb/mihomo_box。不用「/data/adb 是否存在」判断平台。
_cgi_mod=$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd)
[ -n "$_cgi_mod" ] || _cgi_mod=/etc/mihomo_box
case "$_cgi_mod" in
  /data/adb/modules/*) WORKDIR=/data/adb/mihomo_box ;;
  *) WORKDIR=$_cgi_mod ;;
esac
RUNDIR=$WORKDIR/run
TOKEN_FILE=$RUNDIR/webui.token
SETTINGS=$WORKDIR/module-settings.conf

export PATH="/data/adb/ksu/bin:/data/adb/ap/bin:/data/adb/magisk:/data/adb/modules/busybox-ndk/system/xbin:$PATH:/sbin:/system/bin:/system/xbin"

# base64：系统 base64 → busybox base64（须确认有该 applet）→ awk 纯实现（精简 busybox 没有 base64 时）。
B64=""
if command -v base64 >/dev/null 2>&1; then
  B64="base64"
else
  # 按绝对路径找：Magisk 的 busybox 是单文件 /data/adb/magisk/busybox，不在 PATH 中
  for _bb in "$(command -v busybox 2>/dev/null)" /data/adb/magisk/busybox \
             /data/adb/ksu/bin/busybox /data/adb/ap/bin/busybox \
             /data/adb/modules/busybox-ndk/system/xbin/busybox; do
    [ -n "$_bb" ] && [ -x "$_bb" ] && "$_bb" base64 </dev/null >/dev/null 2>&1 && { B64="$_bb base64"; break; }
  done
  unset _bb
fi

# 纯 awk 回退（与 mihomo.sh 的 b64_encode 同源）。编码按文件末尾是否有换行处理，保证与 base64 逐字节一致。
B64_ENC_AWK='
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
}'
B64_DEC_AWK='
BEGIN {
  B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  for (i = 0; i < 64; i++) d[substr(B, i + 1, 1)] = i
}
{ buf = buf $0 }
END {
  gsub(/[^A-Za-z0-9+\/=]/, "", buf)
  n = length(buf)
  for (i = 1; i <= n; i += 4) {
    c1 = substr(buf, i, 1); c2 = substr(buf, i + 1, 1)
    c3 = substr(buf, i + 2, 1); c4 = substr(buf, i + 3, 1)
    if (c2 == "" || c2 == "=") break
    printf "%c", d[c1] * 4 + int(d[c2] / 16)
    if (c3 == "" || c3 == "=") break
    printf "%c", (d[c2] % 16) * 16 + int(d[c3] / 4)
    if (c4 == "" || c4 == "=") break
    printf "%c", (d[c3] % 4) * 64 + d[c4]
  }
}'

# 精简 busybox 没有 base64 小程序时（OpenWrt 常见）：前端写文件的命令是
# `echo … | base64 -d > 文件`，找不到 base64 会失败，而 `>` 在执行前就已把目标
# 文件清空（配置会被截成 0 字节）。这里在 PATH 前置一个 base64 shim：
# busybox 有 base64 就转发给它，否则用上面的 awk 实现。
if ! command -v base64 >/dev/null 2>&1; then
  _sd="$RUNDIR/bin"
  mkdir -p "$_sd" 2>/dev/null
  printf '%s\n' "$B64_ENC_AWK" > "$_sd/b64enc.awk"
  printf '%s\n' "$B64_DEC_AWK" > "$_sd/b64dec.awk"
  {
    printf '#!/bin/sh\nBB=%s\nRD=%s\n' "'${B64% base64}'" "'$_sd'"
    cat <<'SHIM'
# base64 shim（exec.sh 生成）：支持 -d/-D/--decode、-w N、文件参数或标准输入
d=0; f=-; skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -d|-D|--decode) d=1 ;;
    -w|--wrap) skip=1 ;;
    -*) ;;
    *) f=$a ;;
  esac
done
t=""
if [ "$f" = "-" ]; then
  t="$RD/b64in.$$"; cat > "$t"; f=$t
fi
if [ -n "$BB" ]; then
  if [ "$d" = 1 ]; then "$BB" base64 -d < "$f"; else "$BB" base64 < "$f"; fi
  rc=$?
elif [ "$d" = 1 ]; then
  LC_ALL=C awk -f "$RD/b64dec.awk" "$f"; rc=$?
else
  nl=0
  [ "$(tail -c1 "$f" 2>/dev/null | wc -l | tr -d ' ')" -gt 0 ] 2>/dev/null && nl=1
  LC_ALL=C awk -v tail_nl="$nl" -f "$RD/b64enc.awk" "$f"; rc=$?
fi
[ -n "$t" ] && rm -f "$t"
exit "${rc:-1}"
SHIM
  } > "$_sd/base64" && chmod 755 "$_sd/base64"
  PATH="$_sd:$PATH"; export PATH
fi

# 编码文件 $1 → stdout（调用方再 tr 掉换行）；解码文件 $1 → stdout
b64_enc_file() {
  if [ -n "$B64" ]; then $B64 < "$1" 2>/dev/null; return 0; fi
  _nl=0
  [ "$(tail -c1 "$1" 2>/dev/null | wc -l | tr -d ' ')" -gt 0 ] 2>/dev/null && _nl=1
  LC_ALL=C awk -v tail_nl="$_nl" "$B64_ENC_AWK" "$1" 2>/dev/null
}
b64_dec_file() {
  if [ -n "$B64" ]; then $B64 -d < "$1"; return $?; fi
  LC_ALL=C awk "$B64_DEC_AWK" "$1"
}

json_out() {
  # $1 errno  $2 stdout文件  $3 stderr文件
  #
  # 必须「流式拼接」，绝不能把 base64 结果用 $(...) 塞进 printf 的参数。
  # 以前是 printf '...%s...' "$($B64 < out | tr -d '\r\n')"：整段 base64 先被
  # shell 收进内存当参数，再一次性展开 —— /providers/proxies 这种上百节点的
  # 大响应（几 MB，base64 后更大）走这条路，CGI 进程会在拼参数时被拖垮，
  # httpd 只收到一个空响应体，前端 res.json() 直接抛
  # "SyntaxError: Unexpected end of JSON input"，表现为「节点类型全部未知」。
  # 分五次写出去，管道直连 socket，内存只占一个块，与响应大小无关。
  printf 'Content-Type: application/json\r\n'
  printf 'Cache-Control: no-store\r\n'
  printf '\r\n'
  printf '{"errno":%s,"stdout_b64":"' "$1"
  b64_enc_file "$2" | tr -d '\r\n'
  printf '","stderr_b64":"'
  b64_enc_file "$3" | tr -d '\r\n'
  printf '"}'
}

fail() {
  # $1 HTTP 状态行  $2 消息
  printf 'Status: %s\r\n' "$1"
  printf 'Content-Type: application/json\r\n\r\n'
  printf '{"errno":-1,"error":"%s"}' "$2"
  exit 0
}

# ---------- 令牌校验 ----------
# 开关默认关闭：局域网内直接用 IP:端口 访问，不需要令牌。
AUTH=$(grep -E '^webui_auth=' "$SETTINGS" 2>/dev/null | head -1 | cut -d= -f2-)
if [ "$AUTH" = "true" ]; then
  [ -s "$TOKEN_FILE" ] || fail "503 Unavailable" "token missing"
  WANT=$(cat "$TOKEN_FILE" 2>/dev/null)
  GOT=$HTTP_X_MIHOMO_TOKEN
  if [ -z "$GOT" ]; then
    GOT=$(echo "$QUERY_STRING" | tr '&' '\n' | sed -n 's/^t=//p' | head -1)
  fi
  [ -n "$GOT" ] && [ "$GOT" = "$WANT" ] || fail "401 Unauthorized" "bad token"
fi

# ---------- 读取请求体 ----------
[ "$REQUEST_METHOD" = "POST" ] || fail "405 Method Not Allowed" "POST only"
LEN=${CONTENT_LENGTH:-0}
case "$LEN" in ''|*[!0-9]*) LEN=0 ;; esac
[ "$LEN" -gt 0 ] || fail "400 Bad Request" "empty body"
[ "$LEN" -le 8000000 ] || fail "413 Too Large" "body too large"

# ---------- 残留请求目录清扫 ----------
# OpenWrt 上 run/webui.cgi.* 目录会无限叠加：uhttpd 在客户端断开时对 CGI 直接
# SIGKILL、busybox httpd 则让 CGI 在写回包时撞 SIGPIPE —— 两种死法都跑不到
# EXIT trap（trap 0 只在正常退出/被捕获信号时执行），目录就此漏下。手机端
# 管理器 WebView 复用长连接几乎不断流，所以看不出问题；OpenWrt 面板经
# LAN/WiFi 访问，状态/日志轮询一遇切页/锁屏/超时即断流，漏得飞快。
# 每个请求顺带扫一遍（无残留时只有一次 glob，零 fork）：
#   · pid 已死 → 目录是残留（SIGKILL/SIGPIPE 的死者），删；
#   · 没有 pid 文件（刚 mkdir 或写 pid 前就被杀）→ 两阶段：先放 .sweep 标记，
#     下一轮仍无 pid 才删 —— 绝不误删并发中的活请求；
#   · pid 活着 → 在用（或 pid 被复用，等它自然消失后下一轮再删）。
webui_sweep_stale() {
  for _sw_d in "$RUNDIR"/webui.cgi.*; do
    [ -d "$_sw_d" ] || continue
    _sw_p=""
    if [ -f "$_sw_d/pid" ]; then
      IFS= read -r _sw_p < "$_sw_d/pid" 2>/dev/null
    fi
    case "$_sw_p" in
      *[!0-9]*|"")
        if [ -f "$_sw_d/.sweep" ]; then
          rm -rf "$_sw_d" 2>/dev/null
        else
          : > "$_sw_d/.sweep" 2>/dev/null
        fi
        ;;
      0)
        rm -rf "$_sw_d" 2>/dev/null
        ;;
      *)
        kill -0 "$_sw_p" 2>/dev/null || rm -rf "$_sw_d" 2>/dev/null
        ;;
    esac
  done
  return 0
}

# 请求文件含 root 命令和输出，使用私有目录，并在所有正常/信号退出路径清理。
umask 077
mkdir -p "$RUNDIR" 2>/dev/null || fail "500 Internal Server Error" "runtime directory unavailable"
TMPDIR=$(mktemp -d "$RUNDIR/webui.cgi.XXXXXX") || fail "500 Internal Server Error" "temporary directory unavailable"
TMP=$TMPDIR/request
# 持有者 pid：清扫器据此区分「活请求」与「被 httpd 掐死、来不及清理的残留」
printf '%s\n' "$$" > "$TMPDIR/pid" 2>/dev/null
trap 'rm -rf "$TMPDIR"' 0
# PIPE 必须捕获：客户端断开时回包管道断裂，shell 默认被 SIGPIPE 直杀，
# EXIT trap 不会执行（OpenWrt 上 webui.cgi.* 目录叠加的主因之一）
trap 'exit 1' HUP INT TERM PIPE
webui_sweep_stale
# 逐字节读（dd bs=1）在保存大 config.yaml 时是几十万次系统调用，慢到能被
# 当成超时；head -c 一次读完。极简环境没有 head 时再退回 dd。
head -c "$LEN" > "$TMP.b64" 2>/dev/null
[ -s "$TMP.b64" ] || dd bs=1 count="$LEN" 2>/dev/null > "$TMP.b64"
ACTUAL=$(wc -c < "$TMP.b64" | tr -d ' ')
[ "$ACTUAL" = "$LEN" ] || fail "400 Bad Request" "incomplete body"

# 解码到文件而非变量：Linux 单个 argv 参数上限 128KiB(MAX_ARG_STRLEN)，
# 保存较大的 config.yaml 时 sh -c "$CMD" 会直接 E2BIG 失败。
b64_dec_file "$TMP.b64" > "$TMP.cmd" 2>/dev/null || fail "400 Bad Request" "decode failed"
rm -f "$TMP.b64"
[ -s "$TMP.cmd" ] || { rm -f "$TMP.cmd"; fail "400 Bad Request" "decode failed"; }

# ---------- 执行 ----------
# 以脚本文件方式执行，命令长度只受磁盘限制，不再受 argv 上限约束
cd / 2>/dev/null
sh "$TMP.cmd" > "$TMP.out" 2> "$TMP.err"
RC=$?
json_out "$RC" "$TMP.out" "$TMP.err"
rm -f "$TMP.cmd" "$TMP.out" "$TMP.err"
exit 0
