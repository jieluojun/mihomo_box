#!/bin/sh
# ============================================================
# OpenWrt 部署 · 公共库（install.sh 与 box.sh 共用）
#
# 设计要点：
#  · 单一安装目录 /etc/mihomo_box（$ETC），模块控制脚本 scripts/mihomo.sh 原样复用，
#    靠 MODDIR / WORKDIR 环境变量把 Android 路径改指到这里 —— 两个平台一份后端。
#  · 所有路径都经 $PREFIX 前缀（默认空）：测试时用 --prefix /tmp/xxx 在临时目录里
#    跑完整安装流程，不碰真机。
#  · 不假设路由器有 curl：curl → wget → uclient-fetch 依次找，找不到就明确报错。
# ============================================================

# ---------- 路径 ----------
PREFIX=${MIHOMO_BOX_PREFIX:-}
ETC=$PREFIX/etc/mihomo_box
RUN=$ETC/run
COREDIR=$ETC/core
CONFIG=$ETC/config.yaml
SETTINGS=$ETC/module-settings.conf
SCRIPTDIR=$ETC/scripts
WEBROOT=$ETC/webroot/ui
INITD=$PREFIX/etc/init.d/mihomo_box
UCICFG=$PREFIX/etc/config/mihomo_box
BINLINK=$PREFIX/usr/bin/mihomo-box
OWRT_MARK=$ETC/platform

BOX_VERSION_FILE=$ETC/box.version
CORE_BIN=$COREDIR/mihomo-official          # 与 mihomo.sh 的 CORE_OFFICIAL 对齐
CORE_URL_FILE=$ETC/core.source

# 面板默认端口：与 Android 端保持一致（55555），避免两平台行为不同
DEFAULT_PORT=55555

# ---------- 输出 ----------
log()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*" >&2; }
die()  { printf '错误：%s\n' "$*" >&2; exit 1; }

# ---------- 环境探测 ----------
have() { command -v "$1" >/dev/null 2>&1; }

# 安装包管理器（OpenWrt 24.10 及更早是 opkg；25.x 起改用 apk）
pkg_manager() {
  if have opkg; then echo opkg; elif have apk; then echo apk; else echo ''; fi
}

# 装包（尽力而为；失败返回非 0，由调用方决定要不要继续）
pkg_install() {
  _pm=$(pkg_manager)
  case "$_pm" in
    opkg) opkg update >/dev/null 2>&1; opkg install "$@" >/dev/null 2>&1 ;;
    apk)  apk update  >/dev/null 2>&1; apk add "$@"     >/dev/null 2>&1 ;;
    *)    return 1 ;;
  esac
}

is_openwrt() {
  [ -f "$PREFIX/etc/openwrt_release" ] && return 0
  [ -f "$PREFIX/etc/rc.common" ] && return 0
  return 1
}

# ---------- 下载 ----------
# 找一个可用的下载器：$DL_TOOL 为 "curl" / "wget" / "uclient-fetch" / ""
DL_TOOL=''
detect_dl_tool() {
  if have curl; then DL_TOOL=curl; return 0; fi
  # busybox wget 必须支持 -O；uclient-fetch 是 OpenWrt 自带的常客
  if have wget; then DL_TOOL=wget; return 0; fi
  if have uclient-fetch; then DL_TOOL=uclient-fetch; return 0; fi
  DL_TOOL=''
  return 1
}

# fetch <url> <输出文件> [超时秒]
fetch() {
  _fu_url=$1; _fu_out=$2; _fu_tmo=${3:-300}
  rm -f "$_fu_out"
  [ -n "$DL_TOOL" ] || detect_dl_tool || return 1
  case "$DL_TOOL" in
    curl) curl -fsSL --connect-timeout 15 --max-time "$_fu_tmo" --retry 1 -A "mihomo-box-openwrt" -o "$_fu_out" "$_fu_url" ;;
    wget) wget -q -T "$_fu_tmo" -O "$_fu_out" "$_fu_url" ;;
    uclient-fetch) uclient-fetch -q -T "$_fu_tmo" -O "$_fu_out" "$_fu_url" ;;
    *) return 1 ;;
  esac
  [ -s "$_fu_out" ]
}

# 抓取到 stdout（用于取 GitHub API / 元数据，抓不到就返回非 0 且不吐垃圾）
fetch_stdout() {
  _fs_url=$1; _fs_tmo=${2:-20}
  [ -n "$DL_TOOL" ] || detect_dl_tool || return 1
  case "$DL_TOOL" in
    curl) curl -fsSL --connect-timeout 8 --max-time "$_fs_tmo" -A "mihomo-box-openwrt" "$_fs_url" ;;
    wget) wget -q -T "$_fs_tmo" -O - "$_fs_url" ;;
    uclient-fetch) uclient-fetch -q -T "$_fs_tmo" -O - "$_fs_url" ;;
    *) return 1 ;;
  esac
}

# GitHub 加速前缀（只对 github.com / raw.githubusercontent.com 生效）
#   $1 = 完整 URL，$2 = 已选前缀（'' = 直连）
mirror_of() {
  _mo_url=$1; _mo_pre=$2
  case "$_mo_url" in
    https://github.com/*|https://raw.githubusercontent.com/*) ;;
    *) echo "$_mo_url"; return 0 ;;
  esac
  case "$_mo_pre" in
    ''|direct) echo "$_mo_url" ;;
    auto)      echo "$_mo_pre" ;;                       # auto 由调用方展开成列表
    *)         case "$_mo_pre" in */) : ;; *) _mo_pre="$_mo_pre/" ;; esac
               echo "$_mo_pre$_mo_url" ;;
  esac
}

# 依次尝试多个前缀下载同一 URL（直连 + 常用镜像），成功返回 0
#   $1 = URL，$2 = 前缀列表（空格分隔，'' 表示直连），$3 = 输出文件
fetch_multi() {
  _fm_url=$1; _fm_list=$2; _fm_out=$3
  [ -n "$_fm_list" ] || _fm_list=' '
  _fm_ok=0
  for _fm_pre in $_fm_list; do
    _fm_u=$(mirror_of "$_fm_url" "$_fm_pre")
    [ -n "$_fm_u" ] || continue
    if fetch "$_fm_u" "$_fm_out" 600; then _fm_ok=1; break; fi
    info "镜像不可用，换下一个：${_fm_pre:-直连}"
  done
  [ "$_fm_ok" = "1" ]
}

# 默认镜像列表：直连优先，其次若干常用公共加速
MIRROR_LIST_DEFAULT='direct https://ghfast.top/ https://gh-proxy.com/ https://ghproxy.net/'

# ---------- 内核：架构 → 官方 release 资产名 ----------
# mihomo 的 Linux 资产命名（平台自带，非 Android 线）：
#   mihomo-linux-<arch>[-<variant>]-<tag>.gz
# 这里只做「uname -m → 资产 token」的映射；变体（softfloat / v1-v3 / abi）可用
# --variant 覆盖，映射表在 reports 里可查（mihomo-box check-env 会打印本机判定）。
arch_token() {
  _at_m=$1; _at_v=$2
  case "$_at_m" in
    aarch64|arm64)        echo "linux-arm64" ;;
    x86_64|amd64)
      case "$_at_v" in
        compatible) echo "linux-amd64-compatible" ;;
        v2)         echo "linux-amd64-v2" ;;
        v3)         echo "linux-amd64-v3" ;;
        *)          echo "linux-amd64" ;;
      esac ;;
    i386|i486|i586|i686|x86)
      echo "linux-386" ;;
    armv8l|armv7l|armv7)
      echo "linux-armv7" ;;
    armv6l|armv6)
      echo "linux-armv6" ;;
    armv5tel|armv5l|armv5*)
      echo "linux-armv5" ;;
    mips64)
      echo "linux-mips64" ;;
    mips64el)
      echo "linux-mips64le" ;;
    mips)
      case "$_at_v" in hardfloat|hf) echo "linux-mips-hardfloat" ;; *) echo "linux-mips-softfloat" ;; esac ;;
    mipsel)
      case "$_at_v" in hardfloat|hf) echo "linux-mipsle-hardfloat" ;; *) echo "linux-mipsle-softfloat" ;; esac ;;
    riscv64)
      echo "linux-riscv64" ;;
    loongarch64|loong64)
      case "$_at_v" in abi2) echo "linux-loong64-abi2" ;; *) echo "linux-loong64-abi1" ;; esac ;;
    ppc64le)
      echo "linux-ppc64le" ;;
    s390x)
      echo "linux-s390x" ;;
    *) echo '' ;;
  esac
}

# 架构来源：优先 uname -m；OpenWrt 的 DISTRIB_ARCH 作为交叉核对（abort 不了就只提示）
host_arch() {
  uname -m 2>/dev/null
}

# 解析最新正式版 tag（先 API，再 HTML 跳转兜底）
latest_tag() {
  _lt_repo=$1; _lt_pre=$2
  _lt_api="https://api.github.com/repos/$_lt_repo/releases/latest"
  _lt_txt=$(fetch_stdout "$_lt_api" 20 2>/dev/null) || _lt_txt=''
  case "$_lt_txt" in
    *'"tag_name"'*)
      _lt_tag=$(printf '%s' "$_lt_txt" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
      if [ -n "$_lt_tag" ]; then echo "$_lt_tag"; return 0; fi
      ;;
  esac
  # HTML 兜底：releases/latest 会 302 到 /releases/tag/<tag>
  _lt_u=$(mirror_of "https://github.com/$_lt_repo/releases/latest" "$_lt_pre")
  _lt_html=$(fetch_stdout "$_lt_u" 20 2>/dev/null) || return 1
  _lt_tag=$(printf '%s' "$_lt_html" | sed -n 's#.*/releases/tag/\(v\?[0-9][^"<]*\).*#\1#p' | head -1)
  if [ -z "$_lt_tag" ]; then return 1; fi
  echo "$_lt_tag"
}

# 下载并安装内核到 $CORE_BIN
#   $1 tag（可空 = 最新）  $2 变体  $3 前缀列表  $4 本地文件（可空，直装）
core_install() {
  _ci_tag=$1; _ci_var=$2; _ci_pre=$3; _ci_local=$4
  _ci_arch=$(host_arch)
  _ci_token=$(arch_token "$_ci_arch" "$_ci_var")
  [ -n "$_ci_token" ] || die "无法识别的架构：$_ci_arch（可用 --variant 或 --core-file 手动指定内核）"

  mkdir -p "$COREDIR" || die "无法创建 $COREDIR"
  if [ -n "$_ci_local" ]; then
    _ci_src=$_ci_local
    [ -f "$_ci_src" ] || die "本地内核文件不存在：$_ci_src"
    info "从本地文件安装内核：$_ci_src"
  else
    [ -n "$_ci_tag" ] || { _ci_tag=$(latest_tag "MetaCubeX/mihomo" "$(printf '%s' "$_ci_pre" | awk '{print $1}')") || die "无法获取最新版本号（检查网络 / 用 --mirror 指定加速）"; }
    case "$_ci_tag" in v*) : ;; *) _ci_tag="v$_ci_tag" ;; esac
    _ci_name="mihomo-$_ci_token-$_ci_tag.gz"
    _ci_url="https://github.com/MetaCubeX/mihomo/releases/download/$_ci_tag/$_ci_name"
    info "架构：$_ci_arch → $_ci_token"
    info "版本：$_ci_tag"
    info "下载：$_ci_name"
    _ci_tmp=$ETC/.core.dl.gz
    fetch_multi "$_ci_url" "$_ci_pre" "$_ci_tmp" || die "内核下载失败（可换 --mirror，或 --core-file 手动传内核）"
    _ci_src=$_ci_tmp
  fi

  # 支持 .gz（官方发布形态）与裸 ELF（用户自己交叉编译）
  case "$_ci_src" in
    *.gz)
      rm -f "$CORE_BIN.new"
      gzip -dc "$_ci_src" > "$CORE_BIN.new" 2>/dev/null || busybox gzip -dc "$_ci_src" > "$CORE_BIN.new" 2>/dev/null \
        || die "解压失败：$_ci_src（gzip 不可用？）"
      ;;
    *)
      cp "$_ci_src" "$CORE_BIN.new" || die "复制内核失败"
      ;;
  esac
  # 校验：必须是 ELF（魔数 7f 45 4c 46），否则拒绝覆盖现有内核
  _ci_magic=$(od -An -tx1 -N4 "$CORE_BIN.new" 2>/dev/null | tr -d ' \r\n') || _ci_magic=''
  [ "$_ci_magic" = "7f454c46" ] || { rm -f "$CORE_BIN.new"; die "下载内容不是有效的可执行文件（魔数 $_ci_magic）"; }
  chmod 755 "$CORE_BIN.new" || die "设置执行权限失败"
  mv -f "$CORE_BIN.new" "$CORE_BIN" || die "安装内核失败（$CORE_BIN 被占用？）"
  if [ -f "$ETC/.core.dl.gz" ]; then rm -f "$ETC/.core.dl.gz"; fi
  printf '%s\n' "$_ci_url" > "$CORE_URL_FILE" 2>/dev/null
  _ci_ver=$("$CORE_BIN" -v 2>/dev/null | head -1) || _ci_ver=''
  if [ -z "$_ci_ver" ]; then warn "内核已就位但 -v 无输出 —— 可能是架构不匹配（继续，但启动会失败）"; fi
  info "内核已安装：$CORE_BIN${_ci_ver:+（$_ci_ver）}"
  return 0
}

# ---------- 设置文件（与 mihomo.sh 的 module-settings.conf 同格式：key=value 一行一项）----------
setting_set() {
  _ss_k=$1; _ss_v=$2
  mkdir -p "$(dirname "$SETTINGS")" 2>/dev/null
  if [ ! -f "$SETTINGS" ]; then printf '%s=%s\n' "$_ss_k" "$_ss_v" > "$SETTINGS"; return 0; fi
  if grep -qE "^$_ss_k=" "$SETTINGS" 2>/dev/null; then
    _ss_esc=$(printf '%s' "$_ss_v" | sed 's/[\\&|]/\\&/g')
    sed -i "s|^$_ss_k=.*|$_ss_k=$_ss_esc|" "$SETTINGS"
  else
    printf '%s=%s\n' "$_ss_k" "$_ss_v" >> "$SETTINGS"
  fi
}

setting_get() {
  _sg_k=$1; _sg_d=$2
  if [ -f "$SETTINGS" ]; then
    _sg_v=$(sed -n "s/^$_sg_k=//p" "$SETTINGS" 2>/dev/null | head -1) || _sg_v=''
    if [ -n "$_sg_v" ]; then printf '%s\n' "$_sg_v"; return 0; fi
  fi
  printf '%s\n' "$_sg_d"
}

# 随机令牌（/proc 没有就用 date+pid 兜底）
random_token() {
  _rt=$(cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-')
  [ -n "$_rt" ] || _rt="box$(date +%s)$$"
  printf '%s' "$_rt" | cut -c1-16
}

free_kib() {
  _fk=$(df -k "$1" 2>/dev/null | awk 'NR==2 {print $4}')
  case "$_fk" in ''|*[!0-9]*) echo 0 ;; *) echo "$_fk" ;; esac
}
