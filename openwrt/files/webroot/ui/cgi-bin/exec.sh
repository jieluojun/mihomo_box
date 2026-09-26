#!/bin/sh
# ============================================================
# Mihomo Box · 面板执行桥（OpenWrt / busybox httpd CGI）
#
# 与 Android 端 cgi-bin/exec.sh 同一套协议（面板前端不做任何分支）：
#   请求：POST /cgi-bin/exec.sh
#     头  X-Mihomo-Token: <令牌>   （或 ?t=<令牌>）
#     体  base64(shell 命令)
#   响应：{"errno":N,"stdout_b64":"…","stderr_b64":"…"}
#
# 整段 base64 的原因：命令里常含引号 / 换行 / 中文（写配置就是 base64 管道），
# 明文传会被 URL 解码与 shell 二次解析破坏。
#
# 与 Android 版的差别有三处：解释器是 /bin/sh、安装目录靠自身位置推导
# （不写死路径，换目录 / 测试前缀也能用）、PATH 用路由器工具链；
# 另加一条保留命令 __panel_info__：面板前端据此得知安装目录与平台
# （路由器上 httpd 的文档根就是 ui/，前端无法从 URL 反推，见下方注释）。
# ============================================================

# 自身位置：<安装目录>/webroot/ui/cgi-bin/exec.sh → 安装目录 = 上溯三级
_self=$0
WORKDIR=$(CDPATH= cd -- "$(dirname -- "$_self")/../../.." 2>/dev/null && pwd) || WORKDIR=''
case "$WORKDIR" in
  */mihomo_box) : ;;
  *) WORKDIR=/etc/mihomo_box ;;          # 推不出来就退回默认安装目录
esac
MODDIR=$WORKDIR
export WORKDIR MODDIR

RUNDIR=$WORKDIR/run
TOKEN_FILE=$RUNDIR/webui.token
SETTINGS=$WORKDIR/module-settings.conf

# 路由器工具链：OpenWrt 的可执行文件在 /usr/sbin /usr/bin /sbin /bin，
# 顺带保留旧位置以兼容改装过的固件。
export PATH="/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin:$PATH"

# base64：优先系统自带；非 busybox 的 BusyBox 本体按常见绝对路径找
B64="base64"
if ! command -v base64 >/dev/null 2>&1; then
  for _bb in "$(command -v busybox 2>/dev/null)" /bin/busybox /usr/bin/busybox /usr/sbin/busybox; do
    [ -n "$_bb" ] && [ -x "$_bb" ] && { B64="$_bb base64"; break; }
  done
  unset _bb
fi

json_out() {
  # $1 errno  $2 stdout文件  $3 stderr文件
  #
  # 必须「流式拼接」，绝不能把 base64 结果用 $(...) 塞进 printf 的参数：
  # /providers/proxies 这类几 MB 的大响应会在拼参数时把 CGI 进程拖垮，
  # httpd 只收到空响应体，前端 res.json() 抛 Unexpected end of JSON input。
  # 分五次写，管道直连 socket，内存只占一个块，与响应大小无关。
  printf 'Content-Type: application/json\r\n'
  printf 'Cache-Control: no-store\r\n'
  printf '\r\n'
  printf '{"errno":%s,"stdout_b64":"' "$1"
  $B64 < "$2" 2>/dev/null | tr -d '\r\n'
  printf '","stderr_b64":"'
  $B64 < "$3" 2>/dev/null | tr -d '\r\n'
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
AUTH=$(grep -E '^webui_auth=' "$SETTINGS" 2>/dev/null | head -1 | cut -d= -f2-)
if [ "$AUTH" = "true" ]; then
  [ -s "$TOKEN_FILE" ] || fail "503 Unavailable" "token missing"
  WANT=$(cat "$TOKEN_FILE" 2>/dev/null)
  GOT=$HTTP_X_MIHOMO_TOKEN
  if [ -z "$GOT" ]; then
    GOT=$(echo "$QUERY_STRING" | tr '&' '\n' | sed -n 's/^t=//p' | head -1)
  fi
  if [ -z "$GOT" ] || [ "$GOT" != "$WANT" ]; then fail "401 Unauthorized" "bad token"; fi
fi

# ---------- 读取请求体 ----------
[ "$REQUEST_METHOD" = "POST" ] || fail "405 Method Not Allowed" "POST only"
LEN=${CONTENT_LENGTH:-0}
case "$LEN" in ''|*[!0-9]*) LEN=0 ;; esac
[ "$LEN" -gt 0 ] || fail "400 Bad Request" "empty body"
[ "$LEN" -le 8000000 ] || fail "413 Too Large" "body too large"

umask 077
mkdir -p "$RUNDIR" 2>/dev/null || fail "500 Internal Server Error" "runtime directory unavailable"
TMPDIR=$(mktemp -d "$RUNDIR/webui.cgi.XXXXXX" 2>/dev/null) || fail "500 Internal Server Error" "temporary directory unavailable"
TMP=$TMPDIR/request
trap 'rm -rf "$TMPDIR"' 0
trap 'exit 1' HUP INT TERM
# head -c 一次读完；极简环境没有 head 时退回 dd
head -c "$LEN" > "$TMP.b64" 2>/dev/null
[ -s "$TMP.b64" ] || dd bs=1 count="$LEN" 2>/dev/null > "$TMP.b64"
ACTUAL=$(wc -c < "$TMP.b64" | tr -d ' ')
[ "$ACTUAL" = "$LEN" ] || fail "400 Bad Request" "incomplete body"

# 解码到文件而非变量：单个 argv 上限限制，保存较大的 config.yaml 时 sh -c "$CMD" 会 E2BIG
$B64 -d < "$TMP.b64" > "$TMP.cmd" 2>/dev/null || fail "400 Bad Request" "decode failed"
rm -f "$TMP.b64"
if [ ! -s "$TMP.cmd" ]; then rm -f "$TMP.cmd"; fail "400 Bad Request" "decode failed"; fi

# ---------- 保留命令：面板自举 ----------
# 路由器上 httpd 的文档根就是 webroot/ui，前端从 URL 里推不出安装目录
# （Android 是 /data/adb/modules/mihomo_box/webroot/ui/js/…，路由器是 /js/…），
# 而前端拼命令又必须知道安装目录 —— 先问这里。前端只在推不出路径时问一次。
if [ "$(cat "$TMP.cmd" 2>/dev/null)" = "__panel_info__" ]; then
  _ver=$(cat "$WORKDIR/box.version" 2>/dev/null | head -1)
  # module_dir 是「模块脚本所在目录」（路由器上就是安装目录）；workdir 是 mihomo 的运行目录。
  # 两者分开报，前端才不会拿 workdir 去拼 scripts/mihomo.sh（Android 上那是两个路径）。
  printf '{"platform":"openwrt","module_dir":"%s","workdir":"%s","version":"%s"}' "$MODDIR" "$WORKDIR" "$_ver" > "$TMP.out"
  json_out "0" "$TMP.out" "$TMP.err"
  rm -f "$TMP.cmd" "$TMP.out" "$TMP.err"
  exit 0
fi

# ---------- 执行 ----------
# 以脚本文件方式执行：命令长度只受磁盘限制，不受 argv 上限约束。
# 直接跑用户的命令（httpd 以 root 运行，路由器上这就是 root shell 的能力）；
# 面板的令牌开关是唯一的门禁，安装时默认开启。
cd / 2>/dev/null
sh "$TMP.cmd" > "$TMP.out" 2> "$TMP.err"
RC=$?
json_out "$RC" "$TMP.out" "$TMP.err"
rm -f "$TMP.cmd" "$TMP.out" "$TMP.err"
exit 0
