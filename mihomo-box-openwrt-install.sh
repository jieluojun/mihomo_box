#!/bin/sh
# ============================================================
# Mihomo Box · OpenWrt 一键安装 / 卸载（OpenWrt 21.02+ 及 ImmortalWrt 等衍生版）
#
#   在线安装  curl -fsSL https://raw.githubusercontent.com/jieluojun/mihomo_box/main/mihomo-box-openwrt-install.sh | sh
#   在线卸载  curl -fsSL https://raw.githubusercontent.com/jieluojun/mihomo_box/main/mihomo-box-openwrt-install.sh | sh -s -- uninstall
#   离线安装  sh mihomo-box-openwrt-install.sh --zip mihomo-box-<版本>.zip
#   离线卸载  sh /etc/mihomo_box/uninstall-openwrt.sh
#   可选参数  --no-start   安装后不启动服务
#
# 要点（与 Android 版一致）：
#   · 安装目录 /etc/mihomo_box（MIHOMO_BOX_DIR 仅供测试覆盖）
#   · 安装包来自 Release 资产：加速镜像「自动优选」（与面板内核页同序），直连兜底
#   · 不下载内核：内核在面板「内核管理」页下载，按 uname -m 自动匹配资产
#   · 首次安装写默认配置 config.yaml 与模块设置；升级覆盖模块文件，用户配置保留
#   · 不生成系统垫片：精简 busybox 的兼容（nohup / base64 / od / 小数 sleep / uhttpd）由模块层完成
#   · 清理旧版安装器留下的垫片（只删带本脚本标记的文件）
#   · 依赖按防火墙后端安装；fw3/iptables 另需 nftables-json 供 Mihomo TUN 残留检查/清理
# ============================================================

# ---------- 可覆盖常量（测试 / 定制用） ----------
REPO="${MIHOMO_BOX_REPO:-jieluojun/mihomo_box}"
INSTALL_DIR="${MIHOMO_BOX_DIR:-/etc/mihomo_box}"
INITD="${MIHOMO_BOX_INITD:-/etc/init.d/mihomo_box}"
COMPAT_DIR="${MIHOMO_BOX_COMPAT:-/usr/sbin}"          # 兼容垫片落点（在 CGI / init 的 PATH 内）
SHIM_MARKER="mihomo-box-openwrt"
LATEST_PAGE="https://github.com/$REPO/releases/latest"
# 加速镜像：顺序与面板「内核管理」页「自动优选」一致；直连 GitHub 殿后兜底
MIRRORS="https://v6.gh-proxy.org/ https://ghfast.top/ https://gh-proxy.com/ https://ghproxy.net/ https://github.moeyy.xyz/"

PKG_MGR=""
FIREWALL=""
_pkg_updated=""
HTTP_CLIENT=""

# ---------- 输出 ----------
say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }
die()  { printf '\n  ❌ %s\n' "$*" >&2; exit 1; }
step() {
  printf '\n==> %s\n' "$*"
  # 每步落一行时间戳到 run/install.trace，卡住时据此定位（curl | sh 场景排障用）
  mkdir -p "$INSTALL_DIR/run" 2>/dev/null
  printf '%s %s\n' "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$*" >> "$INSTALL_DIR/run/install.trace" 2>/dev/null
}

# ---------- HTTP 下载（curl → wget → busybox wget）----------
pick_http() {
  if command -v curl >/dev/null 2>&1; then HTTP_CLIENT=curl
  elif command -v wget >/dev/null 2>&1; then HTTP_CLIENT=wget
  elif command -v busybox >/dev/null 2>&1; then HTTP_CLIENT="busybox wget"
  else return 1; fi
}

# $1=url $2=输出文件 $3=最长秒数
http_get() {
  _t="${3:-300}"
  if [ "$HTTP_CLIENT" = curl ]; then
    curl -f -s -S -L --connect-timeout 10 --max-time "$_t" -o "$2" "$1"
  elif command -v timeout >/dev/null 2>&1; then
    timeout "$_t" $HTTP_CLIENT -q -O "$2" "$1"
  else
    $HTTP_CLIENT -q -O "$2" "$1"
  fi
}

# 镜像可能对不存在的路径回 200 + 错误页，只看非空会把垃圾当成功，按类型验真：
#   zip  —— PK 魔数 + 包内文件名含 module.prop（zip 文件名明文，不依赖 unzip）
#   json —— 含 {
valid_payload() {
  case "$2" in
    zip)  [ "$(head -c 2 "$1" 2>/dev/null)" = "PK" ] && grep -q 'module\.prop' "$1" 2>/dev/null ;;
    json) grep -q '{' "$1" 2>/dev/null ;;
  esac
}

# 镜像链抓取：GitHub 资源依次走镜像，全部失败再直连；非 GitHub 地址直连。
# $1=url $2=输出 $3=超时秒 $4=类型 zip|json（空=不校验）；成功后 $2.used 记录所用通道
fetch_via_mirror() {
  _u="$1"; _o="$2"; _t="${3:-300}"; _k="$4"
  _try() {
    http_get "$1" "$_o" "$_t" && [ -s "$_o" ] || { rm -f "$_o"; return 1; }
    if [ -n "$_k" ] && ! valid_payload "$_o" "$_k"; then
      info "内容校验未通过（返回的不是有效 $_k），换下一条"
      rm -f "$_o"; return 1
    fi
    return 0
  }
  rm -f "$_o" "$_o.used"
  case "$_u" in
    https://github.com/*|http://github.com/*|https://raw.githubusercontent.com/*|https://codeload.github.com/*)
      for _m in $MIRRORS; do
        info "尝试加速镜像 $_m"
        _try "$_m$_u" && { echo "加速镜像 $_m" > "$_o.used"; return 0; }
      done
      info "镜像均不可用，兜底直连 GitHub"
      _try "$_u" && { echo "直连 GitHub" > "$_o.used"; return 0; }
      ;;
    *)
      info "直连下载 $_u"
      _try "$_u" && { echo "直连" > "$_o.used"; return 0; }
      ;;
  esac
  return 1
}

# ---------- 安装包获取（Release zip，直接走 GitHub，不依赖 update.json）----------
# 路线：releases/latest 页面（GitHub 会跳到最新 Release）→ 解析资产名 mihomo-box-<版本>.zip
#       与 tag 链接 → 依次尝试 latest/download 直链、按版本拼的 releases/download 地址。
# 不再读取 update.json：它要等发布提交推到 main 才更新，可能滞后于最新 Release。
# 结果：PKG_FILE 指向本地 zip；--zip 指定时直接使用
parse_latest_tag() {
  grep -o "/$REPO/releases/tag/[^\"'?#<> ]*" 2>/dev/null | sed 's|.*/tag/||' | head -1
}

obtain_package() {
  if [ -n "$ARG_ZIP" ]; then
    [ -f "$ARG_ZIP" ] || die "本地安装包不存在: $ARG_ZIP"
    PKG_FILE="$ARG_ZIP"
    info "使用本地安装包: $ARG_ZIP"
    return 0
  fi
  PKG_FILE="$STAGE/pkg.zip"
  PKG_VER=""; PKG_ASSET=""; PKG_TAG=""

  step "获取最新版本（GitHub Release）"
  if fetch_via_mirror "$LATEST_PAGE" "$STAGE/releases.html" 30; then
    PKG_ASSET=$(parse_asset_name < "$STAGE/releases.html")
    PKG_TAG=$(parse_latest_tag < "$STAGE/releases.html")
    if [ -n "$PKG_ASSET" ]; then
      PKG_VER=${PKG_ASSET#mihomo-box-}; PKG_VER=${PKG_VER%.zip}
    elif [ -n "$PKG_TAG" ]; then
      PKG_VER=${PKG_TAG#v}
    fi
    ok "最新版本: ${PKG_VER:-未知}（$(cat "$STAGE/releases.html.used" 2>/dev/null)）"
  else
    warn "Release 页面获取失败，改用 latest 直链"
  fi

  step "下载 Mihomo Box 发布包（Release zip）"
  _cands=""
  [ -n "$PKG_ASSET" ] && _cands="$_cands https://github.com/$REPO/releases/latest/download/$PKG_ASSET"
  [ -n "$PKG_TAG" ] && [ -n "$PKG_VER" ] && _cands="$_cands https://github.com/$REPO/releases/download/$PKG_TAG/mihomo-box-$PKG_VER.zip"
  [ -n "$PKG_VER" ] && _cands="$_cands https://github.com/$REPO/releases/latest/download/mihomo-box-$PKG_VER.zip"
  [ -n "$_cands" ] || _cands="https://github.com/$REPO/releases/latest/download/mihomo-box.zip"
  for _u in $_cands; do
    info "地址: $_u"
    if fetch_via_mirror "$_u" "$PKG_FILE" 300 zip; then
      ok "下载完成（$(wc -c < "$PKG_FILE" | tr -d ' ') 字节，$(cat "$PKG_FILE.used")）"
      return 0
    fi
    warn "该地址失败，换下一个"
  done
  die "Release 安装包下载失败（镜像与直连均不可用）。可稍后重试；或在能下载的机器上取 mihomo-box-*.zip，传到路由器后用 --zip 离线安装"
}

# ---------- 解压 & 定位包根 ----------
# unzip → busybox unzip → 缺 unzip 时自动安装（路由器在线时可用；离线请先装好 unzip）
unzip_to() {
  if command -v unzip >/dev/null 2>&1 && unzip -o -q "$1" -d "$2" 2>/dev/null; then return 0; fi
  if command -v busybox >/dev/null 2>&1 && busybox unzip -o -q "$1" -d "$2" 2>/dev/null; then return 0; fi
  detect_pkg_mgr && pkg_install_one unzip >/dev/null 2>&1
  command -v unzip >/dev/null 2>&1 && unzip -o -q "$1" -d "$2" 2>/dev/null
}

extract_package() {
  step "解压安装包"
  rm -rf "$STAGE/root"; mkdir -p "$STAGE/root"
  unzip_to "$PKG_FILE" "$STAGE/root" || die "安装包解压失败（请确认 unzip 可用）"
  _m=$(find "$STAGE/root" -name module.prop 2>/dev/null | head -1)
  [ -n "$_m" ] || die "安装包结构异常：缺少 module.prop"
  PKG_ROOT=${_m%/module.prop}
  for _f in scripts/mihomo.sh webroot/ui/cgi-bin/exec.sh webroot/ui/index.html; do
    [ -f "$PKG_ROOT/$_f" ] || die "安装包结构异常：缺少 $_f"
  done
  # 剔除不随路由器安装的内容：开发文件，以及 Android 专属文件
  # （刷机安装器 / KSU·Magisk 生命周期脚本 / Android dex 组件 / 面板 Java 工具源码）
  rm -rf "$PKG_ROOT/tests" "$PKG_ROOT/.github" "$PKG_ROOT/node_modules" \
         "$PKG_ROOT/META-INF" "$PKG_ROOT/webroot/tools" 2>/dev/null
  rm -f "$PKG_ROOT/.gitignore" "$PKG_ROOT/.gitattributes" \
        "$PKG_ROOT/update.json" "$PKG_ROOT/CHANGELOG.md" "$PKG_ROOT/UPDATE.md" \
        "$PKG_ROOT/build.sh" "$PKG_ROOT/scripts/publish-release.sh" \
        "$PKG_ROOT/customize.sh" "$PKG_ROOT/post-fs-data.sh" "$PKG_ROOT/service.sh" \
        "$PKG_ROOT/action.sh" "$PKG_ROOT/uninstall.sh" "$PKG_ROOT/scripts/app-info.dex" 2>/dev/null
  find "$PKG_ROOT" \( -name '*.zip' -type f -o -name __pycache__ -o -name node_modules \) \
       -exec rm -rf {} + 2>/dev/null
  ok "安装包就绪: $PKG_ROOT"
}

# ---------- 卸载相关 ----------
# 删除本脚本生成的兼容垫片（只删带标记的文件，不碰系统原有的 curl / wget / sleep 等）
remove_compat_shims() {
  for _p in "$COMPAT_DIR/httpd" "$COMPAT_DIR/nohup" "$COMPAT_DIR/base64" "$COMPAT_DIR/od" \
            "$COMPAT_DIR/usleep" "$COMPAT_DIR/sleep" "$COMPAT_DIR/curl" "$COMPAT_DIR/wget" \
            $(for _c in httpd nohup base64 od usleep sleep curl wget; do command -v "$_c" 2>/dev/null; done); do
    [ -f "$_p" ] && grep -q "$SHIM_MARKER" "$_p" 2>/dev/null && rm -f "$_p"
  done
  return 0
}

# 随安装留存的离线卸载脚本（与 uninstall 子命令逻辑一致）
write_uninstall_helper() {
  cat > "$INSTALL_DIR/uninstall-openwrt.sh" <<'HELPER'
#!/bin/sh
# Mihomo Box · OpenWrt 卸载（离线可用，由安装脚本生成）
INSTALL_DIR="@DIR@"; INITD="@INITD@"; COMPAT_DIR="@COMPAT@"
[ -x "$INITD" ] && { "$INITD" stop </dev/null >/dev/null 2>&1; "$INITD" disable </dev/null >/dev/null 2>&1; }
for _c in switch-stop stop webui-stop; do
  sh "$INSTALL_DIR/scripts/mihomo.sh" "$_c" </dev/null >/dev/null 2>&1
done
rm -f "$INITD"
for _p in "$COMPAT_DIR/httpd" "$COMPAT_DIR/nohup" "$COMPAT_DIR/base64" "$COMPAT_DIR/od" \
          "$COMPAT_DIR/usleep" "$COMPAT_DIR/sleep" "$COMPAT_DIR/curl" "$COMPAT_DIR/wget" \
          $(for _c in httpd nohup base64 od usleep sleep curl wget; do command -v "$_c" 2>/dev/null; done); do
  [ -f "$_p" ] && grep -q "mihomo-box-openwrt" "$_p" 2>/dev/null && rm -f "$_p"
done
rm -rf "$INSTALL_DIR"
sleep 1
rm -rf "$INSTALL_DIR" 2>/dev/null
echo "✅ Mihomo Box 已卸载（$INSTALL_DIR 已删除）"
HELPER
  sed -i "s|@DIR@|$INSTALL_DIR|; s|@INITD@|$INITD|; s|@COMPAT@|$COMPAT_DIR|" \
    "$INSTALL_DIR/uninstall-openwrt.sh"
  chmod 755 "$INSTALL_DIR/uninstall-openwrt.sh"
}

do_uninstall() {
  say "─────────────────────────────"
  say "  Mihomo Box · OpenWrt 卸载"
  say "─────────────────────────────"
  [ -x "$INITD" ] && { "$INITD" stop </dev/null >/dev/null 2>&1; "$INITD" disable </dev/null >/dev/null 2>&1; }
  if [ -f "$INSTALL_DIR/scripts/mihomo.sh" ]; then
    for _c in switch-stop stop webui-stop; do
      sh "$INSTALL_DIR/scripts/mihomo.sh" "$_c" </dev/null >/dev/null 2>&1
    done
  fi
  rm -f "$INITD"
  remove_compat_shims
  rm -rf "$INSTALL_DIR"
  sleep 1   # 后台清扫进程可能稍后才落盘，二次清理防止目录复活
  rm -rf "$INSTALL_DIR" 2>/dev/null
  ok "已删除 $INSTALL_DIR 与开机自启 $INITD"
  say "  ✅ Mihomo Box 已卸载"
}

# ---------- 安装主流程 ----------
do_install() {
  say "─────────────────────────────"
  say "  Mihomo Box · OpenWrt 安装"
  say "  安装目录: $INSTALL_DIR"
  say "─────────────────────────────"
  if [ "$(id -u)" != "0" ]; then
    case "$INSTALL_DIR" in
      /etc/*|/usr/*|/data/*) die "请以 root 运行本脚本" ;;
      *) warn "非 root 运行（自定义安装目录，按测试模式继续）" ;;
    esac
  fi
  pick_http || die "未找到可用的 HTTP 客户端（curl / wget / busybox wget），请先安装 curl"
  info "下载通道: $HTTP_CLIENT"

  # 热更新判定：已有完整上一版且跑过安装才算热更新，否则按首次安装
  FIRST=1
  if [ -f "$INSTALL_DIR/scripts/mihomo.sh" ] && [ -f "$INSTALL_DIR/module.prop" ] \
     && [ -f "$INSTALL_DIR/module-settings.conf" ]; then
    FIRST=0
  fi

  STAGE=$(mktemp -d /tmp/mihomo-box-install.XXXXXX 2>/dev/null) || {
    STAGE="/tmp/mihomo-box-install.$$"; rm -rf "$STAGE"; mkdir -p "$STAGE" || die "无法创建临时目录"; }
  trap 'rm -rf "$STAGE"' 0 1 2 15

  obtain_package
  extract_package
  MODSH="$INSTALL_DIR/scripts/mihomo.sh"

  if [ "$FIRST" = 0 ]; then
    step "检测到已安装，执行热更新"
    sh "$MODSH" switch-stop </dev/null >/dev/null 2>&1
    sh "$MODSH" webui-stop </dev/null >/dev/null 2>&1
    # 旧版面板 pid 记在 run/webui.pid，兜底杀一次
    _old=$(cat "$INSTALL_DIR/run/webui.pid" 2>/dev/null)
    [ -n "$_old" ] && kill "$_old" 2>/dev/null
    rm -f "$INSTALL_DIR/run/webui.pid"
  fi

  step "同步模块文件到 $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -af "$PKG_ROOT"/. "$INSTALL_DIR"/ 2>/dev/null
  stale_clean
  patch_paths
  setup_workdir
  stamp_panel_cache
  write_uninstall_helper

  ensure_system_deps
  write_initd
  clean_legacy_shims

  # 子进程统一断开 stdin：curl | sh 时脚本本身在 stdin 上，误读会吞掉剩余脚本
  if [ "$NO_START" = 1 ]; then
    warn "按 --no-start 跳过服务启动（重启后由 $INITD 自动拉起）"
  elif [ "$FIRST" = 0 ]; then
    step "重载运行时（无需重启）"
    sh "$MODSH" switch-start </dev/null >/dev/null 2>&1
    _f="$INSTALL_DIR/run/.webui-restart.out"
    sh "$MODSH" webui-restart </dev/null > "$_f" 2>&1
    _o=$(cat "$_f" 2>/dev/null); rm -f "$_f"
    sh "$MODSH" syncdesc </dev/null >/dev/null 2>&1
    case "$_o" in
      OK:*) ok "面板服务已按新版本重启" ;;
      *)    warn "面板服务未能启动："; printf '%s\n' "$_o" | head -4 | while IFS= read -r _l; do [ -n "$_l" ] && info "$_l"; done ;;
    esac
  else
    step "启动服务（无需重启路由器）"
    _f="$INSTALL_DIR/run/.boot.out"
    sh "$MODSH" boot </dev/null > "$_f" 2>&1
    while IFS= read -r _l; do [ -n "$_l" ] && info "$_l"; done < "$_f"
    rm -f "$_f"
  fi

  httpclient_check

  VER=$(grep -m1 '^version=' "$INSTALL_DIR/module.prop" 2>/dev/null | cut -d= -f2- | tr -d '\r')
  say ""
  say "─────────────────────────────"
  if [ "$FIRST" = 0 ]; then say "  ✅ Mihomo Box 热更新完成"; else say "  ✅ Mihomo Box 首次安装完成"; fi
  say "  版本: ${VER:-未知}    目录: $INSTALL_DIR"
  say "  内核未下载，请在面板 「内核」页下载"
  say "  系统架构 $(uname -m 2>/dev/null)，默认内核 $(default_core_for_arch)"
  say "  面板后续：「主页」开启总开关；「内核」下载加速镜像建议选「自动优选」"
  if [ "$NO_START" != 1 ]; then
    _wi=$(sh "$MODSH" webui-info </dev/null 2>/dev/null)
    [ -n "$_wi" ] && printf '%s\n' "$_wi" | while IFS= read -r _l; do say "  $_l"; done
  fi
  [ -x "$INITD" ] && say "  开机自启: $INITD（已启用）"
  say "  卸载: sh $INSTALL_DIR/uninstall-openwrt.sh   或   curl ... | sh -s -- uninstall"
  say "─────────────────────────────"
}

usage() {
  cat <<'EOF'
Mihomo Box · OpenWrt 一键安装 / 卸载

用法：
  sh mihomo-box-openwrt-install.sh [install] [--zip <本地包>] [--no-start]
  sh mihomo-box-openwrt-install.sh uninstall

  --zip <本地包>   离线安装（使用已下载的 mihomo-box-*.zip）
  --no-start       安装后不启动服务
EOF
}

main() {
  CMD=install; ARG_ZIP=""; NO_START=0
  while [ $# -gt 0 ]; do
    case "$1" in
      install|uninstall) CMD=$1 ;;
      --zip)      shift; [ $# -ge 1 ] || die "--zip 缺少参数"; ARG_ZIP=$1 ;;
      --no-start) NO_START=1 ;;
      -h|--help)  usage; exit 0 ;;
      *)          die "未知参数: $1（-h 查看用法）" ;;
    esac
    shift
  done
  case "$CMD" in
    uninstall) do_uninstall ;;
    *)         do_install ;;
  esac
}


# ---------- 包管理器 / 防火墙 / TUN·Tproxy 依赖（只装缺失项，已具备则跳过） ----------
detect_pkg_mgr() {
  if command -v apk >/dev/null 2>&1 && [ -d /etc/apk ]; then PKG_MGR=apk
  elif command -v opkg >/dev/null 2>&1; then PKG_MGR=opkg
  elif command -v apk >/dev/null 2>&1; then PKG_MGR=apk
  else PKG_MGR=""; fi
  [ -n "$PKG_MGR" ]
}

detect_firewall() {
  # 判定顺序（从可信到兜底）：fw4/fw3 兼容二进制经常同时存在，不能只看 PATH。
  # 1) 已生效的 fw4 表：防火墙已经按 nftables 在跑，这是最硬的证据。
  if command -v nft >/dev/null 2>&1 && nft list table inet fw4 >/dev/null 2>&1; then
    FIREWALL=nftables
    return 0
  fi
  # 2) 防火墙 init 脚本实际调用的后端（/etc/init.d/firewall 里写的是 fw4 还是 fw3）。
  if [ -r /etc/init.d/firewall ]; then
    if grep -Eq '(^|[^A-Za-z0-9_])fw4([^A-Za-z0-9_]|$)' /etc/init.d/firewall 2>/dev/null; then
      FIREWALL=nftables
      return 0
    fi
    if grep -Eq '(^|[^A-Za-z0-9_])fw3([^A-Za-z0-9_]|$)' /etc/init.d/firewall 2>/dev/null; then
      FIREWALL=iptables
      return 0
    fi
  fi
  # 3) 包数据库里装着的防火墙实现（firewall4=fw4；firewall=fw3）。
  [ -n "$PKG_MGR" ] || detect_pkg_mgr >/dev/null 2>&1
  if pkg_is_installed firewall4; then
    FIREWALL=nftables
    return 0
  fi
  if pkg_is_installed firewall; then
    FIREWALL=iptables
    return 0
  fi
  # 4) 只有一个后端二进制时按它走。
  if { command -v fw4 >/dev/null 2>&1 || [ -x /sbin/fw4 ]; } && ! { command -v fw3 >/dev/null 2>&1 || [ -x /sbin/fw3 ]; }; then
    FIREWALL=nftables
    return 0
  fi
  if { command -v fw3 >/dev/null 2>&1 || [ -x /sbin/fw3 ]; } && ! { command -v fw4 >/dev/null 2>&1 || [ -x /sbin/fw4 ]; }; then
    FIREWALL=iptables
    return 0
  fi
  # 5) OpenWrt 世代兜底：22.03 起默认 fw4/nftables，更早是 fw3/iptables。
  _df_rel=$(sed -n "s/^DISTRIB_RELEASE=['\"]\{0,1\}\([0-9][0-9]*\).*/\1/p" /etc/openwrt_release 2>/dev/null | head -1)
  case "$_df_rel" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$_df_rel" -ge 22 ] 2>/dev/null; then FIREWALL=nftables; else FIREWALL=iptables; fi
      return 0
      ;;
  esac
  if command -v nft >/dev/null 2>&1 && ! command -v iptables >/dev/null 2>&1; then
    FIREWALL=nftables
  elif command -v iptables >/dev/null 2>&1 && ! command -v nft >/dev/null 2>&1; then
    FIREWALL=iptables
  else
    FIREWALL=nftables   # 无法判定时的兜底：现行 OpenWrt 默认 fw4
  fi
}

pkg_is_installed() {
  case "$PKG_MGR" in
    opkg) opkg status "$1" 2>/dev/null | grep -q '^Status: install' ;;
    apk)  apk info -e "$1" </dev/null >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

pkg_install_one() {
  pkg_is_installed "$1" && { info "$1 已安装，跳过"; return 0; }
  info "安装 $1 …"
  case "$PKG_MGR" in
    opkg)
      opkg install "$1" </dev/null >/dev/null 2>&1 && { ok "$1 安装完成"; return 0; }
      if [ "$_pkg_updated" != "1" ]; then
        _pkg_updated=1
        info "软件源索引可能过期，opkg update 后重试"
        opkg update </dev/null >/dev/null 2>&1
        opkg install "$1" </dev/null >/dev/null 2>&1 && { ok "$1 安装完成"; return 0; }
      fi ;;
    apk)
      apk add "$1" </dev/null >/dev/null 2>&1 && { ok "$1 安装完成"; return 0; }
      if [ "$_pkg_updated" != "1" ]; then
        _pkg_updated=1
        info "软件源索引可能过期，apk update 后重试"
        apk update </dev/null >/dev/null 2>&1
        apk add "$1" </dev/null >/dev/null 2>&1 && { ok "$1 安装完成"; return 0; }
      fi ;;
    *) return 1 ;;
  esac
  warn "$1 安装失败（可稍后手动 $PKG_MGR install $1）"
  return 1
}

dep_tproxy_iptables_cap_ok() {
  _DP_MISS=""
  _DP_OPT=""
  command -v iptables >/dev/null 2>&1 || { _DP_MISS="iptables 命令"; return 1; }
  command -v ip >/dev/null 2>&1 || { _DP_MISS="ip 命令"; return 1; }
  iptables -w -t mangle -N mihomo_dep_probe 2>/dev/null || { _DP_MISS="mangle 表建链（iptables 与内核兼容层）"; return 1; }
  _dp_ok=1
  _DP_MISS=""
  _DP_OPT=""
  iptables -w -t mangle -A mihomo_dep_probe -p tcp -j TPROXY --on-ip 127.0.0.1 \
    --on-port 1 --tproxy-mark 1 2>/dev/null || { _dp_ok=0; _DP_MISS="$_DP_MISS TPROXY目标"; }
  iptables -w -t mangle -A mihomo_dep_probe -m owner \
    --uid-owner 0 -j RETURN 2>/dev/null || { _dp_ok=0; _DP_MISS="$_DP_MISS owner匹配"; }
  # socket 匹配只是已建连接的快速通道（运行时可缺省），缺它不影响 TPROXY 工作
  iptables -w -t mangle -A mihomo_dep_probe -p tcp \
    -m socket --transparent -j RETURN 2>/dev/null || _DP_OPT="socket匹配"
  iptables -w -t mangle -F mihomo_dep_probe 2>/dev/null
  iptables -w -t mangle -X mihomo_dep_probe 2>/dev/null
  [ "$_dp_ok" = "1" ]
}

# nftables 能力探测：用 nft -c 校验表达式（只校验不下发、零流量影响），
# 与模块运行时的 tproxy_probe_nft_caps 同口径。socket 快速通道仍是可选项。
_dep_nft_check() {
  cat > "$_dp_f" 2>/dev/null || return 1
  nft -c -f "$_dp_f" >/dev/null 2>&1
}

dep_tproxy_nft_cap_ok() {
  _DP_MISS=""
  _DP_OPT=""
  command -v nft >/dev/null 2>&1 || { _DP_MISS="nft 命令（nftables-json）"; return 1; }
  command -v ip >/dev/null 2>&1 || { _DP_MISS="ip 命令（ip-full）"; return 1; }
  _dp_f="${TMPDIR:-/tmp}/mihomo_dep_nft.$$"
  _dp_ok=1
  if ! _dep_nft_check <<'EOF'
table inet mihomo_dep_probe {
 chain prerouting {
  type filter hook prerouting priority mangle; policy accept;
  meta l4proto tcp tproxy ip to 127.0.0.1:1 meta mark set 0x01000000 accept
 }
}
EOF
  then
    _dp_ok=0; _DP_MISS="$_DP_MISS nft-TPROXY"
  fi
  _dp_owner=0
  if _dep_nft_check <<'EOF'
table inet mihomo_dep_probe {
 chain output {
  type route hook output priority mangle; policy accept;
  meta l4proto tcp meta skuid 0 meta skgid 3005 return
 }
}
EOF
  then
    _dp_owner=1
  elif _dep_nft_check <<'EOF'
table inet mihomo_dep_probe {
 chain output {
  type route hook output priority mangle; policy accept;
  meta l4proto tcp meta skuid 0 return
 }
}
EOF
  then
    _dp_owner=1
  fi
  [ "$_dp_owner" = "1" ] || { _dp_ok=0; _DP_MISS="$_DP_MISS skuid/skgid旁路"; }
  if ! _dep_nft_check <<'EOF'
table inet mihomo_dep_probe {
 chain prerouting {
  type filter hook prerouting priority mangle; policy accept;
  meta l4proto { tcp, udp } socket transparent 1 meta mark set 0x01000000 accept
 }
}
EOF
  then
    _DP_OPT="socket快速通道"
  fi
  rm -f "$_dp_f" 2>/dev/null
  [ "$_dp_ok" = "1" ]
}

# 按当前防火墙后端分发能力探测：nftables 系统只探 nft，iptables 系统只探 iptables，
# 不再用 iptables 的结果去决定要不要给 nftables 系统装包。
dep_tproxy_cap_ok() {
  [ -n "$FIREWALL" ] || detect_firewall
  if [ "$FIREWALL" = "nftables" ]; then
    dep_tproxy_nft_cap_ok
  else
    dep_tproxy_iptables_cap_ok
  fi
}

ensure_system_deps() {
  detect_pkg_mgr || {
    warn "未找到包管理器（opkg / apk），跳过 TUN / Tproxy 依赖检查"
    return 0
  }
  detect_firewall
  step "系统依赖检查（TUN / Tproxy · 包管理器 $PKG_MGR · 防火墙 $FIREWALL）"

  # Mihomo TUN auto-redirect 使用独立的 nft inet mihomo 表。fw3/iptables 下
  # 也需要 nft 命令检查/清理这张残留表；这里只安装 nftables-json 用户态工具，
  # 不安装 nft TPROXY 内核模块，也不改变 Tproxy 的 iptables 后端。
  if [ "$FIREWALL" = "iptables" ]; then
    if command -v nft >/dev/null 2>&1; then
      ok "nft 命令已存在（供 Mihomo TUN 残留检查/清理使用）"
    else
      info "iptables/fw3 后端额外安装 nftables-json（仅作 Mihomo TUN 残留检查/清理工具）"
      if pkg_install_one nftables-json; then
        command -v nft >/dev/null 2>&1 || warn "安装后仍未找到 nft；Mihomo TUN 残留检查/清理不可用"
      else
        warn "nftables-json 安装失败；Mihomo TUN 残留检查/清理不可用"
      fi
    fi
  fi

  if [ -c /dev/net/tun ]; then
    ok "TUN: /dev/net/tun 已存在，跳过"
  else
    if pkg_is_installed kmod-tun; then
      info "kmod-tun 已安装，加载内核模块"
    else
      pkg_install_one kmod-tun
    fi
    command -v modprobe >/dev/null 2>&1 && modprobe tun >/dev/null 2>&1
    if [ -c /dev/net/tun ]; then
      ok "TUN: /dev/net/tun 就绪"
    else
      warn "TUN: /dev/net/tun 仍不可用（内核可能未编入 TUN 或需重启后生效）"
    fi
  fi

  if command -v ip >/dev/null 2>&1; then
    ok "ip: 系统已有，跳过"
  else
    pkg_install_one ip-full
  fi

  if dep_tproxy_cap_ok && [ -z "$_DP_OPT" ]; then
    if [ "$FIREWALL" = "nftables" ]; then
      ok "Tproxy 能力已就绪（nft TPROXY / socket / skuid·skgid），跳过"
    else
      ok "Tproxy 能力已就绪（TPROXY / socket / owner），跳过"
    fi
    return 0
  fi
  # 只装当前防火墙后端的 Tproxy 能力依赖；iptables 路径的 nftables-json 仅用于上面的残留清理。
  _dp_list=""
  if [ "$FIREWALL" = "nftables" ]; then
    command -v nft >/dev/null 2>&1 || _dp_list="$_dp_list nftables-json"
    _dp_list="$_dp_list kmod-nft-tproxy kmod-nft-socket"
  else
    command -v iptables >/dev/null 2>&1 || _dp_list="$_dp_list iptables"
    command -v ip6tables >/dev/null 2>&1 || _dp_list="$_dp_list ip6tables"
    _dp_list="$_dp_list iptables-mod-tproxy kmod-ipt-tproxy iptables-mod-extra iptables-mod-socket"
  fi
  for _dp_p in $_dp_list; do
    pkg_install_one "$_dp_p"
  done
  if dep_tproxy_cap_ok; then
    if [ -n "$_DP_OPT" ]; then
      warn "Tproxy 就绪，但缺 ${_DP_OPT}（已建连接快速通道不可用，不影响透明代理）"
      if [ "$FIREWALL" = "nftables" ]; then
        warn "排查：$PKG_MGR install kmod-nft-socket；确认内核含 NFT_SOCKET"
      else
        warn "排查：$PKG_MGR install iptables-mod-socket；确认内核含 xt_socket"
      fi
    elif [ "$FIREWALL" = "nftables" ]; then
      ok "Tproxy 能力就绪（nft TPROXY / socket / skuid·skgid）"
    else
      ok "Tproxy 能力就绪（TPROXY / socket / owner）"
    fi
  else
    warn "Tproxy 能力探测未通过（缺：${_DP_MISS:-未知}）——透明代理暂不可用，面板可正常安装"
    if [ "$FIREWALL" = "nftables" ]; then
      warn "排查：$PKG_MGR install nftables-json kmod-nft-tproxy kmod-nft-socket；确认内核含 NFT_TPROXY / NFT_SOCKET"
    else
      warn "排查：$PKG_MGR install iptables-mod-tproxy iptables-mod-extra iptables-mod-socket；确认内核含 xt_TPROXY / xt_owner / xt_socket"
    fi
  fi
  return 0
}


# ---------- 旧版残留垫片清理（精简 busybox 的兼容已移至模块层，安装器不再生成垫片） ----------
drop_dlrewrite() {
  for _dr_p in "$COMPAT_DIR/curl" "$COMPAT_DIR/wget"; do
    [ -f "$_dr_p" ] || continue
    if grep -q "$SHIM_MARKER-dlrewrite" "$_dr_p" 2>/dev/null; then
      rm -f "$_dr_p" && info "已移除旧版下载改写垫片: $_dr_p"
    fi
  done
  return 0
}

clean_legacy_shims() {
  step "清理旧版残留垫片"
  remove_compat_shims
  drop_dlrewrite
  return 0
}


# ---------- 默认内核 / 工具函数 ----------
default_core_for_arch() {
  case "$(uname -m 2>/dev/null)" in
    aarch64|arm64) echo jieluojun ;;
    *)             echo official ;;
  esac
}

json_str_field() {
  _jsf_re='s/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
  sed -n "$_jsf_re" "$1" 2>/dev/null | head -1
}

canonical_github_url() {
  printf '%s\n' "$1" | sed -n 's|.*\(https://github\.com/[^" ]*\)|\1|p'
}

parse_asset_name() {
  grep -o 'mihomo-box-[0-9]\{8\}-[0-9]\{4\}\.zip' 2>/dev/null | head -1
}


# ---------- 安装目录同步：清残、路径适配、缓存打点 ----------
stale_clean() {
  # 只删除「上一版包清单里有、本版包里已没有」的文件。
  # 旧逻辑是「安装目录里凡不在包内的文件全删」，会误删内核运行时生成的文件
  # （外部面板 ui/、cache.db、geoip.metadb、geoip.dat、geosite.dat 等）。
  # 清单存 run/pkg.manifest；首次升级没有旧清单时不删任何文件（宁可留残留，不误删）。
  _sc_new="$STAGE/manifest.txt"
  _sc_old="$INSTALL_DIR/run/pkg.manifest"
  ( cd "$PKG_ROOT" && find . -type f | sed 's|^\./||' ) > "$_sc_new"
  _sc_n=0
  if [ -s "$_sc_old" ]; then
    while IFS= read -r _sc_r; do
      [ -n "$_sc_r" ] || continue
      case "$_sc_r" in
        disable|remove|update|skip_test|uninstall-openwrt.sh|config.yaml|module-settings.conf|core/*|run/*|proxies/*|rules/*|backup/*|ui/*) continue ;;
      esac
      grep -qxF "$_sc_r" "$_sc_new" 2>/dev/null && continue
      if [ -f "$INSTALL_DIR/$_sc_r" ]; then
        rm -f "$INSTALL_DIR/$_sc_r" && _sc_n=$((_sc_n + 1))
      fi
    done < "$_sc_old"
    find "$INSTALL_DIR" -mindepth 1 -type d -empty -delete 2>/dev/null
    [ "$_sc_n" -gt 0 ] && ok "已删除上一版包内的旧文件 $_sc_n 个"
  else
    info "首次记录安装包清单，本次不做清残（用户/内核文件均保留）"
  fi
  mkdir -p "$INSTALL_DIR/run" 2>/dev/null
  cp -f "$_sc_new" "$_sc_old" 2>/dev/null
  return 0
}

patch_paths() {
  step "适配安装路径（Android 路径 → $INSTALL_DIR）"
  _pp_n=0
  for _pp_f in $(find "$INSTALL_DIR" -type f 2>/dev/null); do
    case "$_pp_f" in
      *.dex|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.woff2|*.sha256) continue ;;
      */core/*|*/run/*|*/backup/*) continue ;;
      # 面板脚本与执行桥自己按安装位置推断路径（见两者头部），不改写：
      # 安装后与发布包内文件逐字节一致，手动覆盖也能直接用
      */scripts/mihomo.sh|*/webroot/ui/cgi-bin/exec.sh) continue ;;
    esac
    _pp_sz=$(wc -c < "$_pp_f" 2>/dev/null | tr -d ' ')
    case "$_pp_sz" in ''|*[!0-9]*) continue ;; esac
    [ "$_pp_sz" -gt 2097152 ] && continue   # 模块文本文件都远小于此；超大一律当二进制跳过
    grep -q -e '/data/adb/modules/mihomo_box' -e '/data/adb/mihomo_box' "$_pp_f" 2>/dev/null || continue
    mkdir -p "$INSTALL_DIR/run" 2>/dev/null
    printf '%s 路径重写 %s\n' "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$_pp_f" >> "$INSTALL_DIR/run/install.trace" 2>/dev/null
    sed -i \
      -e "s|/data/adb/modules/mihomo_box|$INSTALL_DIR|g" \
      -e "s|/data/adb/mihomo_box|$INSTALL_DIR|g" \
      "$_pp_f" 2>/dev/null && _pp_n=$((_pp_n + 1))
  done
  [ -f "$INSTALL_DIR/module.prop" ] && \
    sed -i 's/for KernelSU Next/for OpenWrt/; s/for KernelSU/for OpenWrt/; s/for APatch/for OpenWrt/; s/for Magisk/for OpenWrt/' \
      "$INSTALL_DIR/module.prop" 2>/dev/null
  for _pp_s in $(find "$INSTALL_DIR" -type f -name '*.sh' 2>/dev/null); do
    case "$_pp_s" in */scripts/mihomo.sh|*/webroot/ui/cgi-bin/exec.sh) continue ;; esac
    sed -i '1s|^#!/system/bin/sh|#!/bin/sh|' "$_pp_s" 2>/dev/null
  done
  ok "已改写 $_pp_n 个文件中的安装路径"

  _pj_f="$INSTALL_DIR/webroot/ui/js/app.js"
  if [ -f "$_pj_f" ] && grep -q "visibilityState !== 'visible' || current" "$_pj_f" 2>/dev/null; then
    _pj_tmp="$_pj_f.p.$$"
    awk '
      /if \(document\.visibilityState !== .visible. \|\| current !== .page-dashboard.\) return;/ {
        print "  if (document.visibilityState !== '\''visible'\'') return;"
        print "  // 状态结构变化后，停留中的页面必须整体重绘——不只是概览页。内核/工具/代理页"
        print "  // 的空数据预热构建会赶在 status 之前落地（慢设备上是常态）；若这里不重绘，"
        print "  // 刷新网页后内核页会永远停在「未安装」——后端 exists=1 也没人再画一遍。"
        print "  if (sigChanged) {"
        print "    if (current === '\''page-dashboard'\'' || (!isInteracting() && !userScrollingOrEditing())) rerenderCurrent();"
        print "  } else if (current === '\''page-dashboard'\'') { paintUptime(); paintResources(); }"
        getline; getline
        next
      }
      { print }
    ' "$_pj_f" > "$_pj_tmp" 2>/dev/null && mv "$_pj_tmp" "$_pj_f" 2>/dev/null || rm -f "$_pj_tmp"
    if grep -q "停留中的页面必须整体重绘" "$_pj_f" 2>/dev/null; then
      ok "已应用 WebUI 渲染时序补丁（修复刷新后内核页误显未安装）"
    else
      warn "WebUI 渲染时序补丁未应用（app.js 结构可能与预期不同），如遇内核页误显未安装请反馈"
    fi
  fi
}


# ---------- 工作目录 / 面板缓存 / 开机自启 ----------
setup_workdir() {
  step "准备工作目录（默认配置 / 模块设置）"
  mkdir -p "$INSTALL_DIR/core" "$INSTALL_DIR/run" "$INSTALL_DIR/backup" \
           "$INSTALL_DIR/proxies" "$INSTALL_DIR/rules"

  if [ ! -f "$INSTALL_DIR/config.yaml" ]; then
    cp "$INSTALL_DIR/data/config.yaml" "$INSTALL_DIR/config.yaml" 2>/dev/null
    ok "已写入默认配置 config.yaml"
  else
    info "检测到已有配置，保留 config.yaml"
  fi

  if [ ! -f "$INSTALL_DIR/module-settings.conf" ]; then
    cat > "$INSTALL_DIR/module-settings.conf" <<EOF
core=$(default_core_for_arch)
autostart=true
mirror=auto
webui=true
EOF
    ok "已写入默认模块设置（远程访问默认开启：监听 0.0.0.0）"
  else
    info "检测到已有模块设置，保留"
    if ! grep -qE '^webui=' "$INSTALL_DIR/module-settings.conf" 2>/dev/null; then
      echo "webui=true" >> "$INSTALL_DIR/module-settings.conf"
      ok "已为旧配置补上远程访问默认值"
    fi
  fi

  chmod 755 "$INSTALL_DIR/scripts/mihomo.sh" 2>/dev/null
  chmod 755 "$INSTALL_DIR/webroot/ui/cgi-bin/exec.sh" 2>/dev/null
  chmod 644 "$INSTALL_DIR/config.yaml" "$INSTALL_DIR/module-settings.conf" 2>/dev/null

  rm -f "$INSTALL_DIR/run/modstate.prev" "$INSTALL_DIR/run/desc.base" \
        "$INSTALL_DIR/run/prop.tpl" 2>/dev/null
  rmdir "$INSTALL_DIR/run/desc.lock" 2>/dev/null
  return 0
}

stamp_panel_cache() {
  step "面板缓存打点"
  _sp_ver=$(grep -m1 '^version=' "$INSTALL_DIR/module.prop" 2>/dev/null | cut -d= -f2- | tr -d '\r')
  [ -n "$_sp_ver" ] || _sp_ver=$(date '+%Y%m%d-%H%M')
  _sp_stamp="$_sp_ver.$(date '+%Y%m%d%H%M%S')"
  if [ -f "$INSTALL_DIR/webroot/ui/index.html" ]; then
    sed -i "s/?v=[0-9A-Za-z._-]*/?v=$_sp_stamp/g" "$INSTALL_DIR/webroot/ui/index.html"
    chmod 644 "$INSTALL_DIR/webroot/ui/index.html"
  fi
  if [ -f "$INSTALL_DIR/webroot/ui/sw.js" ]; then
    sed -i "s|^const INSTALL_STAMP = .*|const INSTALL_STAMP = '$_sp_stamp';|" "$INSTALL_DIR/webroot/ui/sw.js"
    chmod 644 "$INSTALL_DIR/webroot/ui/sw.js"
  fi
  printf '%s\n' "$_sp_stamp" > "$INSTALL_DIR/webroot/ui/install.stamp"
  chmod 644 "$INSTALL_DIR/webroot/ui/install.stamp"
  find "$INSTALL_DIR/webroot/ui" -type f -exec touch {} + 2>/dev/null
  [ -d "$INSTALL_DIR/webroot" ] && find "$INSTALL_DIR/webroot" -maxdepth 1 -type f -exec touch {} + 2>/dev/null
  ok "刷入指纹 $_sp_stamp（旧缓存将在下次打开面板时自动清除）"
}

write_initd() {
  if [ ! -f /etc/rc.common ]; then
    warn "未找到 /etc/rc.common（非 OpenWrt 环境？），跳过开机自启配置"
    return 0
  fi
  step "写入开机自启服务 $INITD"
  cat > "$INITD" <<EOF
#!/bin/sh /etc/rc.common
START=99
STOP=10

start() {
	# 面板先起：不依赖网络与内核（restart 时 stop() 已停掉面板，这里立刻拉起，
	# 不必等 wait-net 的 ping 与内核校验）
	sh $INSTALL_DIR/scripts/mihomo.sh webui-start >/dev/null 2>&1
	(
		sh $INSTALL_DIR/scripts/mihomo.sh wait-net >/dev/null 2>&1
		sleep 3
		sh $INSTALL_DIR/scripts/mihomo.sh boot
	) >/dev/null 2>&1 &
}

stop() {
	sh $INSTALL_DIR/scripts/mihomo.sh switch-stop >/dev/null 2>&1
	sh $INSTALL_DIR/scripts/mihomo.sh stop >/dev/null 2>&1
	sh $INSTALL_DIR/scripts/mihomo.sh webui-stop >/dev/null 2>&1
}
EOF
  chmod 755 "$INITD"
  if "$INITD" enable </dev/null >/dev/null 2>&1; then
    ok "已启用开机自启（rc.d S99）"
  else
    warn "enable 失败，可手动执行：$INITD enable"
  fi
}


# ---------- 收尾自检 ----------
httpclient_check() {
  step "HTTP 客户端自检"
  _hc_line=$(sh "$INSTALL_DIR/scripts/mihomo.sh" httpclient </dev/null 2>/dev/null | head -1)
  case "$_hc_line" in
    OK:*) ok "读取内核数据用: ${_hc_line#OK: }" ;;
    *)    warn "未找到可用的 HTTP 客户端，代理页可能读不到数据（建议安装 curl 或 wget）" ;;
  esac
}


# 测试时可设 MIHOMO_BOX_LIB=1 只加载函数不执行
[ "${MIHOMO_BOX_LIB:-0}" = 1 ] || main "$@"
