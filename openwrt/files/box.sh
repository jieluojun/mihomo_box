#!/bin/sh
# ============================================================
# Mihomo Box · OpenWrt 命令行入口（mihomo-box）
#
# 路由器侧的一层薄壳：把路径环境准备好，然后把请求交给与 Android 端同一份
# 模块控制脚本（scripts/mihomo.sh）。路由器专有的几件事（服务启停、面板保活、
# 按架构更新内核、环境自检、卸载）在这里实现；安卓专有的命令在这里给出明确
# 说明而不是让它们半死不活地跑。
#
#   mihomo-box start|stop|restart|status|logs|test|set|…   同 Android 端语义
#   mihomo-box update-core [版本]      按 CPU 架构下载官方内核并替换
#   mihomo-box core-import <文件>      用本地文件（.gz 或裸 ELF）换内核
#   mihomo-box panel-url               打印带令牌的面板地址
#   mihomo-box check-env               路由器环境自检（架构 / TUN / curl / 端口 / 空间）
#   mihomo-box supervise               面板保活守护（由 procd 拉起，一般不用手跑）
#   mihomo-box uninstall [--purge]     卸载
# ============================================================

PREFIX=${MIHOMO_BOX_PREFIX:-}

# ---- 1) 先定安装目录（这一段不能依赖 lib/common.sh）----
# 三种来源，优先级从高到低：环境变量 > 自身位置（安装后的正常情形）> --prefix 前缀。
# 注意：不能直接用 lib/common.sh 里的 ETC —— 那是按 --prefix 推的，遇到自定义
# --dir（如 /mnt/sda1/mihomo_box）就推错。所以这里先算好，souce 之后再覆盖回去。
BOX_DIR=${MIHOMO_BOX_DIR:-}
if [ -z "$BOX_DIR" ]; then
  _self=$0
  if command -v readlink >/dev/null 2>&1; then
    _r=$(readlink -f "$_self" 2>/dev/null) || _r=''
    if [ -n "$_r" ]; then _self=$_r; fi
  fi
  _sd=$(CDPATH= cd -- "$(dirname -- "$_self")" 2>/dev/null && pwd) || _sd=''
  case "$_sd" in
    */scripts) BOX_DIR=$(CDPATH= cd -- "$_sd/.." 2>/dev/null && pwd) ;;
    *)         BOX_DIR=$PREFIX/etc/mihomo_box ;;
  esac
fi
[ -n "$BOX_DIR" ] || BOX_DIR=/etc/mihomo_box
ETC=$BOX_DIR

# ---- 2) 公共库：安装后放在 <安装目录>/scripts/lib/ ----------
if [ -f "$ETC/scripts/lib/common.sh" ]; then
  . "$ETC/scripts/lib/common.sh"
elif [ -f "$(dirname "$0")/lib/common.sh" ]; then
  . "$(dirname "$0")/lib/common.sh"
fi

# ---- 3) 路径统一按 BOX_DIR 落位（覆盖 lib 里按前缀推出来的值）----
ETC=$BOX_DIR
MODDIR=$ETC
WORKDIR=$ETC
export MODDIR WORKDIR
# 路由器工具链；Android 那串路径留着无害（不存在即跳过）
PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export PATH
RUN=$ETC/run
COREDIR=$ETC/core
CONFIG=$ETC/config.yaml
SETTINGS=$ETC/module-settings.conf
SCRIPTDIR=$ETC/scripts
WEBROOT=$ETC/webroot/ui
CORE_BIN=$COREDIR/mihomo-official
CORE_URL_FILE=$ETC/core.source
INITD=$PREFIX/etc/init.d/mihomo_box
BINLINK=$PREFIX/usr/bin/mihomo-box
BOXLOG=$RUN/box.log

MODSH=$SCRIPTDIR/mihomo-module.sh
BOXLINK=/usr/bin/mihomo-box

# ---------- 小工具 ----------
have() { command -v "$1" >/dev/null 2>&1; }

# 监听端口计数：netstat 可能是独立包，也可能只在 busybox 里；都没有则返回 '?'
port_listen_count() {
  for _plc_cmd in "netstat -ltn" "busybox netstat -ltn"; do
    _plc_out=$($_plc_cmd 2>/dev/null) || continue
    [ -n "$_plc_out" ] || continue
    printf '%s\n' "$_plc_out" | awk -v p=":$1" '$4 ~ p"$" {n++} END {print n+0}'
    return 0
  done
  echo '?'
}

logline() {
  mkdir -p "$RUN" 2>/dev/null
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null)" "$*" >> "$BOXLOG" 2>/dev/null
  # 日志上限 256KB，超了就留最后 800 行
  _sz=$(wc -c < "$BOXLOG" 2>/dev/null || echo 0)
  case "$_sz" in ''|*[!0-9]*) _sz=0 ;; esac
  if [ "$_sz" -gt 262144 ]; then
    tail -800 "$BOXLOG" > "$BOXLOG.tmp" 2>/dev/null && mv "$BOXLOG.tmp" "$BOXLOG" 2>/dev/null
  fi
}

modsh() { sh "$MODSH" "$@"; }

panel_port() {
  _pp=$(sed -n 's/^webui_port=//p' "$SETTINGS" 2>/dev/null | head -1)
  case "$_pp" in ''|*[!0-9]*) _pp=$DEFAULT_PORT ;; esac
  [ "$_pp" -ge 1 ] 2>/dev/null && [ "$_pp" -le 65535 ] 2>/dev/null || _pp=$DEFAULT_PORT
  printf '%s\n' "$_pp"
}

panel_token() { cat "$RUN/webui.token" 2>/dev/null; }

panel_auth_on() {
  [ "$(sed -n 's/^webui_auth=//p' "$SETTINGS" 2>/dev/null | head -1)" = "true" ]
}

core_running() {
  _cr_p=$(cat "$RUN/core.pid" 2>/dev/null)
  [ -n "$_cr_p" ] && kill -0 "$_cr_p" 2>/dev/null
}

panel_running() {
  _pr_p=$(cat "$RUN/httpd.pid" 2>/dev/null)
  [ -n "$_pr_p" ] && kill -0 "$_pr_p" 2>/dev/null
}

# ---------- 面板地址 ----------
panel_addrs() {
  # 排序：192.168 > 10. > 172.16-31 > 其它公网/自定义 > 169.254 链路本地（路由器上最可能用的是第一个）
  ip -4 addr show 2>/dev/null | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | grep -v '^127\.' | sort -u | awk '
    { r = 4
      if ($0 ~ /^192\.168\./) r = 1
      else if ($0 ~ /^10\./) r = 2
      else if ($0 ~ /^172\.(1[6-9]|2[0-9]|3[01])\./) r = 3
      else if ($0 ~ /^169\.254\./) r = 9
      printf "%d %s\n", r, $0 }' | sort -k1,1n -k2,2 | awk '{print $2}'
}

cmd_panel_url() {
  _pt=$(panel_port)
  _ip=$(panel_addrs | head -1)
  [ -n "$_ip" ] || _ip='127.0.0.1'
  if panel_auth_on; then
    printf 'http://%s:%s/?t=%s\n' "$_ip" "$_pt" "$(panel_token)"
    panel_addrs | while IFS= read -r _a; do
      [ "$_a" = "$_ip" ] && continue
      printf 'http://%s:%s/?t=%s\n' "$_a" "$_pt" "$(panel_token)"
    done
  else
    printf 'http://%s:%s/\n' "$_ip" "$_pt"
    panel_addrs | while IFS= read -r _a; do
      [ "$_a" = "$_ip" ] && continue
      printf 'http://%s:%s/\n' "$_a" "$_pt"
    done
  fi
}

# ---------- 启停 ----------
start_core_if_wanted() {
  _sc_want=$(sed -n 's/^autostart=//p' "$SETTINGS" 2>/dev/null | head -1)
  [ -n "$_sc_want" ] || _sc_want=true
  if [ "$_sc_want" != "true" ]; then
    logline "boot: 自启已关闭（设置里 autostart=false）"
    return 0
  fi
  if [ ! -x "$CORE_BIN" ]; then
    logline "boot: 无内核（$CORE_BIN），跳过自启"
    return 0
  fi
  if core_running; then
    logline "boot: 内核已在运行 (pid $(cat "$RUN/core.pid" 2>/dev/null))"
    return 0
  fi
  logline "boot: 启动内核"
  modsh start >/dev/null 2>&1 || logline "boot: 内核启动失败（mihomo-box logs 看日志）"
}

cmd_boot() {
  start_core_if_wanted
  if ! panel_running; then
    logline "boot: 启动面板服务"
    modsh webui-start >/dev/null 2>&1 || logline "boot: 面板启动失败"
  fi
  # 预热一次状态缓存：进面板首屏更快（拿不到也无所谓）
  modsh live-refresh >/dev/null 2>&1 || true
}

cmd_start() {
  cmd_boot
  _pt=$(panel_port)
  if panel_running; then
    echo "OK: 面板服务已启动 (pid $(cat "$RUN/httpd.pid" 2>/dev/null), 端口 $_pt)"
    cmd_panel_url
  else
    echo "ERR: 面板服务未启动（mihomo-box logs 看原因）"
    return 1
  fi
}

cmd_stop() {
  modsh webui-stop >/dev/null 2>&1 || true
  modsh stop >/dev/null 2>&1 || true
  logline "stop: 已停止面板与内核"
  echo "OK: 已停止"
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

# ---------- 面板保活守护（procd 拉起，前台运行）----------
SUP_RUNNING=1
sup_shutdown() {
  SUP_RUNNING=0
  logline "supervise: 收到退出信号，停止面板与内核"
  modsh webui-stop >/dev/null 2>&1 || true
  modsh stop >/dev/null 2>&1 || true
  exit 0
}

# UCI 开关（/etc/config/mihomo_box）里的 enabled：1=服务启用，0=停用
svc_enabled() {
  if [ -n "$MIHOMO_BOX_PREFIX" ] || ! have uci; then return 0; fi
  _se=$(uci -q get mihomo_box.@main[0].enabled 2>/dev/null) || _se='1'
  [ "$_se" = "0" ] && return 1
  return 0
}

cmd_supervise() {
  trap sup_shutdown TERM INT HUP
  if svc_enabled; then
    cmd_boot
    logline "supervise: 守护已就绪（每 20s 检查面板）"
  else
    logline "supervise: 服务已在 UCI 里停用，等待重新启用"
  fi
  while [ "$SUP_RUNNING" = "1" ]; do
    sleep 20
    if ! svc_enabled; then
      # 被停用：停掉自家进程，但不退出（否则 procd 会不停重启本守护）
      if panel_running || core_running; then
        logline "supervise: 服务已停用，停止面板与内核"
        modsh webui-stop >/dev/null 2>&1 || true
        modsh stop >/dev/null 2>&1 || true
      fi
      continue
    fi
    # 只盯面板：内核是用户手动启停的对象（面板上的「停止」不该被守护又拉起来）
    if ! panel_running; then
      logline "supervise: 面板服务掉了，自动拉起"
      modsh webui-start >/dev/null 2>&1 || logline "supervise: 拉起失败，下轮再试"
    fi
  done
}

# ---------- 内核管理 ----------
cmd_update_core() {
  _uc_tag=$1
  _uc_mir=$(sed -n 's/^mirror=//p' "$SETTINGS" 2>/dev/null | head -1)
  _uc_cus=$(sed -n 's/^mirror_custom=//p' "$SETTINGS" 2>/dev/null | head -1 | tr -d '"')
  case "$_uc_mir" in
    custom) _uc_pre="${_uc_cus:-direct}" ;;
    ''|direct) _uc_pre='direct' ;;
    auto) _uc_pre=$MIRROR_LIST_DEFAULT ;;
    *) _uc_pre="$_uc_mir" ;;
  esac
  detect_dl_tool || die "系统里没有可用下载器（curl / wget / uclient-fetch）"
  if core_running; then
    info "先停止内核再替换（避免 Text file busy）"
    modsh stop >/dev/null 2>&1 || true
    sleep 1
  fi
  core_install "$_uc_tag" '' "$_uc_pre" '' || return 1
  rm -f "$RUN/vercache" "$RUN/tested.fp" 2>/dev/null || true
  echo "OK: 内核已更新到 $("$CORE_BIN" -v 2>/dev/null | head -1)"
  if [ "$(sed -n 's/^autostart=//p' "$SETTINGS" 2>/dev/null | head -1)" != "false" ]; then
    modsh start >/dev/null 2>&1 && echo "OK: 已按自启设置重新启动内核"
  fi
}

cmd_core_import() {
  _ci_file=$1
  if [ -z "$_ci_file" ]; then die "用法：mihomo-box core-import <文件路径>（.gz 或裸 ELF）"; fi
  if [ ! -f "$_ci_file" ]; then die "文件不存在：$_ci_file"; fi
  if core_running; then modsh stop >/dev/null 2>&1 || true; sleep 1; fi
  core_install '' '' 'direct' "$_ci_file" || return 1
  rm -f "$RUN/vercache" "$RUN/tested.fp" 2>/dev/null || true
  echo "OK: 内核已导入：$("$CORE_BIN" -v 2>/dev/null | head -1)"
}

cmd_core_info() {
  echo "内核路径   $CORE_BIN"
  if [ -x "$CORE_BIN" ]; then
    echo "版本       $("$CORE_BIN" -v 2>/dev/null | head -1)"
    _csz=$(ls -l "$CORE_BIN" 2>/dev/null | awk '{print $5}')
    [ -n "$_csz" ] && echo "大小       $((_csz / 1048576)) MB"
  else
    echo "版本       （未安装）"
  fi
  echo "来源       $(cat "$CORE_URL_FILE" 2>/dev/null || echo -)"
  echo "本机架构   $(host_arch) → $(arch_token "$(host_arch)" '')"
  echo "运行状态   $(core_running && echo "运行中 (pid $(cat "$RUN/core.pid" 2>/dev/null))" || echo '未运行')"
}

# ---------- 环境自检（替换 Android 版的 check-env）----------
cmd_check_env() {
  detect_dl_tool >/dev/null 2>&1 || true    # 如实报告可用下载器
  echo "===== Mihomo Box · 路由器环境自检 ====="
  echo "安装目录   $ETC   （版本 $(cat "$ETC/box.version" 2>/dev/null || echo '?'))"
  echo "平台       $([ -f "$ETC/platform" ] && cat "$ETC/platform" || echo '?')  /  $(uname -srm 2>/dev/null)"
  echo "架构       $(host_arch) → 内核资产 $(arch_token "$(host_arch)" '')"
  if [ -f /etc/openwrt_release ]; then
    echo "系统       $(sed -n "s/^DISTRIB_DESCRIPTION='//p" /etc/openwrt_release 2>/dev/null | tr -d "'")"
    echo "发行版架构 $(sed -n "s/^DISTRIB_ARCH='//p" /etc/openwrt_release 2>/dev/null | tr -d "'")"
  fi
  echo "服务       $(panel_running && echo "面板运行中 (pid $(cat "$RUN/httpd.pid" 2>/dev/null))" || echo '面板未运行')  |  $(core_running && echo "内核运行中 (pid $(cat "$RUN/core.pid" 2>/dev/null))" || echo '内核未运行')"
  echo "内核       $("$CORE_BIN" -v 2>/dev/null | head -1 || echo '未安装')"
  echo "httpd      $(have httpd && echo '有 httpd' || echo '无独立 httpd')  |  $(have busybox && busybox httpd --help >/dev/null 2>&1 && echo 'busybox httpd 可用' || echo 'busybox httpd 不可用！')"
  echo "下载器     ${DL_TOOL:-无}  |  curl: $(have curl && curl --version 2>/dev/null | head -1 || echo '未安装（订阅更新会受影响）')"
  echo "TUN        $(if [ -c /dev/net/tun ]; then echo '/dev/net/tun 存在（TUN 模式可用）'; else echo '/dev/net/tun 缺失（需 kmod-tun）'; fi)"
  echo "防火墙     $(if have nft; then echo 'nft (fw4)'; elif have iptables; then echo 'iptables (fw3/兼容)'; else echo '未检测到'; fi)"
  _lc=$(port_listen_count "$(panel_port)")
  case "$_lc" in
    '?') echo "面板端口   $(panel_port)（本机没有 netstat，无法探测监听）" ;;
    *)   echo "面板端口   $(panel_port)（监听中：$_lc）" ;;
  esac
  echo "令牌       $(panel_auth_on && echo '已启用' || echo '未启用（同网段可直连）')"
  echo "磁盘       $ETC 可用 $(( $(free_kib "$ETC") / 1024 )) MB"
  echo "内存       $(awk '/MemTotal|MemAvailable/ {printf "%s %s MB  ", $1, int($2/1024)}' /proc/meminfo 2>/dev/null)"
  echo "配置文件   $CONFIG（$( [ -f "$CONFIG" ] && wc -l < "$CONFIG" || echo 0) 行）"
  # 开机自启：路由器上真身是 procd（UCI enabled + /etc/init.d 软链），不是模块设置里的键
  if have uci; then
    _bo=$(uci -q get mihomo_box.@main[0].enabled 2>/dev/null)
    if [ "$_bo" = "0" ]; then
      echo "开机自启   已关闭（procd 服务 disabled）"
    elif [ -e "$PREFIX/etc/rc.d/S96mihomo_box" ]; then
      echo "开机自启   已启用（procd 服务，rc.d 已挂）"
    else
      echo "开机自启   已启用（UCI enabled=1；rc.d 软链未挂，跑 /etc/init.d/mihomo_box enable）"
    fi
  else
    echo "开机自启   $( [ -x "$INITD" ] && "$INITD" enabled >/dev/null 2>&1 && echo '已启用' || echo '未启用/未知（本机没有 uci，路由器上读 /etc/config/mihomo_box）')"
  fi
}

# ---------- 卸载 ----------
cmd_uninstall() {
  _pu=0
  [ "$1" = "--purge" ] && _pu=1
  logline "uninstall: 开始卸载（purge=$_pu）"
  if [ -x "$INITD" ]; then "$INITD" stop >/dev/null 2>&1 || true; "$INITD" disable >/dev/null 2>&1 || true; fi
  modsh webui-stop >/dev/null 2>&1 || true
  modsh stop >/dev/null 2>&1 || true
  sleep 1
  for _pf in "$RUN/httpd.pid" "$RUN/core.pid"; do
    if [ -f "$_pf" ]; then
      _pp=$(cat "$_pf" 2>/dev/null)
      case "$_pp" in ''|*[!0-9]*) : ;; *) kill "$_pp" 2>/dev/null || true ;; esac
    fi
  done
  rm -f "$INITD" "$PREFIX/etc/config/mihomo_box" "$BINLINK" 2>/dev/null || true
  if [ "$_pu" = "1" ]; then
    rm -rf "$ETC"
    echo "已卸载并删除 $ETC"
  else
    rm -rf "$ETC/scripts" "$ETC/webroot" "$ETC/run" "$ETC/platform" "$ETC/box.version" "$ETC/module.prop" "$ETC/README.md" 2>/dev/null || true
    echo "已卸载（保留 $CONFIG 与 $CORE_BIN；彻底删除：mihomo-box uninstall --purge）"
  fi
}

cmd_version() {
  echo "mihomo-box  $(cat "$ETC/box.version" 2>/dev/null || echo dev)   (OpenWrt)"
  echo "内核        $("$CORE_BIN" -v 2>/dev/null | head -1 || echo '未安装')"
  echo "面板端口    $(panel_port)"
}

usage() {
  cat <<EOF
Mihomo Box · OpenWrt 命令行

  服务        start | stop | restart | supervise（procd 用）
  状态        info（摘要） | status（原始 JSON，面板用） | panel-url | core-info | check-env | version
  内核        update-core [版本] | core-import <文件> | setup-core
  模块命令    logs | logs-clear | test | get <键> | set <键> <值> | api GET <路径> …
              （与 Android 端同语义，交给 scripts/mihomo.sh 执行）
  卸载        uninstall [--purge]

安装目录：$ETC
面板地址：$(panel_addrs | head -1 | sed "s#.*#http://&:$(panel_port)/#")
EOF
}

# ---------- 安卓专有命令的明确答复 ----------
android_only_msg() {
  case "$1" in
    download-core|download-core-*)
      echo "路由器平台请用：mihomo-box update-core（按 CPU 架构自动选择官方内核）"
      echo "或：mihomo-box core-import <本地文件>" ;;
    pkg-list|pkg-*)
      echo "应用列表是 Android 专有功能（PackageManager），路由器上不适用。" ;;
    tproxy-*)
      echo "TPROXY 一键接管是 Android 专有实现（iptables）。路由器上请自行配置 mihomo 的 TPROXY，"
      echo "或改用配置里的 tun.enable（TUN 模式，需 kmod-tun）。" ;;
    netmatch-*)
      echo "网络匹配是 Android 专有功能（按 Wi-Fi/SSID 切换配置），路由器上不适用。" ;;
    tun-hotspot-*|hotspot*)
      echo "热点共享代理是 Android 专有功能，路由器上不适用。" ;;
    ebpf*|switch-*|action-toggle|detach|_lived-loop|_switch-loop|syncdesc|healprop)
      echo "该命令属于 Android 模块运行时，路由器上不适用。" ;;
    setcore)
      echo "路由器上只有一个上游内核（official），无需切换。更新内核用：mihomo-box update-core" ;;
    *)
      echo "该命令在路由器平台不适用：$1" ;;
  esac
  return 1
}

# ---------- 主派发 ----------
cmd=${1:-help}
case "$cmd" in
  ''|help|-h|--help) usage; exit 0 ;;
  start)      cmd_start ;;
  stop)       cmd_stop ;;
  restart)    cmd_restart ;;
  boot)       cmd_boot ;;
  supervise)  cmd_supervise ;;
  panel-url)  cmd_panel_url ;;
  check-env)  cmd_check_env ;;
  update-core|setup-core) shift; cmd_update_core "$@" ;;
  core-import|import-core)
     # 面板「本地导入」发的是 `import-core <路径> <内核key>`；路由器只有一个内核，
     # 所以取第一个参数当文件，key 忽略。命令行也可以只给文件：core-import <文件>
     shift
     _ic_arg1=${1:-}
     case "$_ic_arg1" in
       liuran001|jieluojun|official) _ic_file=${2:-} ;;
       *) _ic_file=$_ic_arg1 ;;
     esac
     cmd_core_import "$_ic_file" ;;
  core-info)  cmd_core_info ;;
  uninstall)  shift; cmd_uninstall "$@" ;;
  version)    cmd_version ;;
  info|overview)
     # 人类可读摘要。注意 status 本身必须原样透传 —— 面板的 refreshStatus 解析的
     # 就是 `status` 的 JSON，这里不能把它变成人类可读文本（踩过）。
     echo "面板       $(panel_running && echo "运行中 (pid $(cat "$RUN/httpd.pid" 2>/dev/null))" || echo '未运行')   $(panel_addrs | head -1 | sed "s#.*#http://&:$(panel_port)/#")"
     echo "内核       $(core_running && echo "运行中 (pid $(cat "$RUN/core.pid" 2>/dev/null))" || echo '未运行')   $("$CORE_BIN" -v 2>/dev/null | head -1 || echo '未安装')"
     _md=$(modsh status 2>/dev/null | sed -n 's/.*"mode": *"\([^"]*\)".*/\1/p' | head -1)
     if [ -n "$_md" ]; then echo "模式       $_md"; fi
     echo "（原始 JSON：mihomo-box status）" ;;
  set)
     # 安卓专有的设置键挡在前面；autostart 要额外镜像到 procd（路由器开机自启的真身）；
     # 其余原样交给模块脚本。
     case "$2" in
       hotspot_proxy|system_ipv6|tproxy) android_only_msg "set $2" ; exit 1 ;;
       autostart)
          _as_val=$3
          shift 3
          modsh set autostart "$_as_val"
          _as_rc=$?
          # 面板的开机自启开关 = 路由器服务的 enable/disable：
          # 只写 module-settings.conf 的话，procd 还是会照旧开机拉起（或永远不拉）。
          if [ "$PREFIX" = '' ] || [ -x "$INITD" ]; then
            if [ "$_as_val" = "true" ]; then
              if have uci; then uci -q set mihomo_box.@main[0].enabled='1' >/dev/null 2>&1; uci -q commit mihomo_box >/dev/null 2>&1; fi
              [ -x "$INITD" ] && "$INITD" enable >/dev/null 2>&1
            else
              if have uci; then uci -q set mihomo_box.@main[0].enabled='0' >/dev/null 2>&1; uci -q commit mihomo_box >/dev/null 2>&1; fi
              [ -x "$INITD" ] && "$INITD" disable >/dev/null 2>&1
            fi
          fi
          exit $_as_rc ;;
       *) shift; modsh set "$@" ;;
     esac ;;
  download-core|download-core-*|pkg-list|pkg-*|tproxy-*|netmatch-*|tun-hotspot-*|hotspot*|ebpf*|switch-*|action-toggle|detach|_switch-loop|syncdesc|healprop)
     android_only_msg "$cmd"; exit 1 ;;
  *)
     # 其余全部交给模块控制脚本（status/res/boot-data/logs/test/get/api/webui-* …）
     modsh "$@" ;;
esac
