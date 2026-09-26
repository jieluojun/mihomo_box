#!/bin/sh
# ============================================================
# Mihomo Box · OpenWrt 一键安装
#
#   sh install.sh                  # 装到 /etc/mihomo_box，自动选架构下载内核，装好即启动
#   sh install.sh --mirror auto    # 走内置 GitHub 加速镜像（国内网络常用）
#   sh install.sh --core /tmp/mihomo.gz
#   sh install.sh --uninstall      # 卸载（保留配置与内核，可加 --purge 全删）
#
# 目录结构（全部在 /etc/mihomo_box 下；模块控制脚本与面板复用 Android 端同一份源码）：
#   config.yaml            主配置
#   module-settings.conf   模块设置（面板端口 / 令牌开关 / 自启等）
#   core/mihomo-official   mihomo 内核（官方 release，按架构自动选择）
#   scripts/mihomo-module.sh  模块控制脚本（与 Android 端同一份）
#   scripts/mihomo.sh         调度器（面板前端的调用入口，等价 box.sh）
#   scripts/box.sh            路由器命令行入口 mihomo-box
#   webroot/ui/…           面板 WebUI（含 cgi-bin 执行桥）
#   webroot/index.html     跳转页（进面板用）
#   run/…                  运行期文件：pid / 日志 / 令牌
#
# 注意：本脚本用了 set -e，一切「可能不成立」的判断都写成 if 而不是 `[ … ] && cmd`，
# 否则条件为假时整脚本会静默退出（这个坑踩过一次，勿改回去）。
# ============================================================
set -e

HERE=$(dirname "$0")

# ---------------- 自举（curl | sh 场景）----------------
# 单独把 install.sh 抓下来跑时，没有 lib/ 也没有 files/：先把程序包（含 lib 与面板文件）
# 拉到临时目录，再用那份完整的安装器重新执行自己，参数原样透传。
# 这段刻意用 _bs_ 前缀自带一套最小实现：此刻还没有 lib/common.sh 可用。
_bs_have() { command -v "$1" >/dev/null 2>&1; }
_bs_die() { printf '错误：%s\n' "$*" >&2; exit 1; }
_bs_info() { printf '  %s\n' "$*"; }
_bs_fetch() {                      # $1 url  $2 out
  _bs_u=$1; _bs_o=$2
  # 每条都加连接/总超时：路由器的网络可能被墙到「连上但不动」，
  # 不给超时就会静默挂几分钟，看起来像「命令没反应」。
  if _bs_have curl; then curl -fsSL --connect-timeout 10 --max-time 180 -o "$_bs_o" "$_bs_u" && [ -s "$_bs_o" ] && return 0
  elif _bs_have wget; then wget -q -T 60 -O "$_bs_o" "$_bs_u" && [ -s "$_bs_o" ] && return 0
  elif _bs_have uclient-fetch; then uclient-fetch -q -T 60 -O "$_bs_o" "$_bs_u" && [ -s "$_bs_o" ] && return 0
  fi
  return 1
}
_bs_get() {                        # $1 url → stdout（探测用，超时要短）
  _bs_u=$1
  if _bs_have curl; then curl -fsSL --connect-timeout 6 --max-time 12 "$_bs_u"
  elif _bs_have wget; then wget -q -T 12 -O - "$_bs_u"
  elif _bs_have uclient-fetch; then uclient-fetch -q -T 12 -O - "$_bs_u"
  fi
}
# 版本探测：先直连 API，再直连网页，最后逐个镜像试网页。
# （国内网络 api.github.com 常被连接超时拖死，所以每一步都短超时、且允许走镜像。）
_bs_latest_tag() {                 # $1 repo  $2... 镜像前缀列表
  _bs_r=$1; shift
  _bs_t=$(_bs_get "${_bs_api_base}/repos/$_bs_r/releases/latest" 2>/dev/null) || _bs_t=''
  _bs_tag=$(printf '%s' "$_bs_t" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$_bs_tag" ]; then
    _bs_h=$(_bs_get "${_bs_gh_base}/$_bs_r/releases/latest" 2>/dev/null) || _bs_h=''
    _bs_tag=$(printf '%s' "$_bs_h" | sed -n 's#.*/releases/tag/\(v\?[0-9][^"<]*\).*#\1#p' | head -1)
  fi
  for _bs_p in "$@"; do
    [ -n "$_bs_tag" ] && break
    case "$_bs_p" in ''|direct) continue ;; esac
    _bs_info "探测版本（镜像 $_bs_p）…"
    _bs_h=$(_bs_get "$_bs_p${_bs_gh_base}/$_bs_r/releases/latest" 2>/dev/null) || _bs_h=''
    _bs_tag=$(printf '%s' "$_bs_h" | sed -n 's#.*/releases/tag/\(v\?[0-9][^"<]*\).*#\1#p' | head -1)
  done
  [ -n "$_bs_tag" ] || return 1
  printf '%s\n' "$_bs_tag"
}

if [ ! -f "$HERE/lib/common.sh" ]; then
  _bs_repo=${MIHOMO_BOX_REPO:-jieluojun/mihomo_box}
  # 基准地址：默认官方。自建源 / 测试环境可用环境变量整体换掉（镜像前缀会拼在它前面）
  _bs_gh_base=${MIHOMO_BOX_GH_BASE:-https://github.com}
  _bs_api_base=${MIHOMO_BOX_API_BASE:-https://api.github.com}
  _bs_codeload_base=${MIHOMO_BOX_CODELOAD_BASE:-https://codeload.github.com}
  # 从命令行里取 --mirror（自举阶段只有它会用到镜像）
  _bs_mir=''
  _bs_prev=''
  for _bs_a in "$@"; do
    case "$_bs_prev" in mirror) _bs_mir=$_bs_a ;; esac
    case "$_bs_a" in --mirror=*) _bs_mir=${_bs_a#*=} ;; esac
    _bs_prev=$_bs_a
  done
  case "$_bs_mir" in
    auto) _bs_list='direct https://ghfast.top/ https://gh-proxy.com/ https://ghproxy.net/' ;;
    ''|direct) _bs_list='direct' ;;
    *) _bs_list="$_bs_mir direct" ;;
  esac
  _bs_dir=$(mktemp -d "${TMPDIR:-/tmp}/mihomo-box.XXXXXX") || _bs_die "无法创建临时目录"
  # 尝试顺序（每条内部再走镜像列表）：
  #   ① release 资产 mihomo-box-openwrt-<tag>.tar.gz —— 最稳，装了就能用
  #   ② 仓库快照（main 分支 tar.gz）—— 只提交、还没打 release 时也能装
  _bs_ok=0
  _bs_info "自举：正在探测程序包版本…（网络慢时这行之后可能要等十几秒）"
  _bs_tag=$(_bs_latest_tag "$_bs_repo" $_bs_list) || _bs_tag=''
  if [ -n "$_bs_tag" ]; then
    _bs_asset=mihomo-box-openwrt-$_bs_tag.tar.gz
    _bs_url=$_bs_gh_base/$_bs_repo/releases/download/$_bs_tag/$_bs_asset
    for _bs_pre in $_bs_list; do
      case "$_bs_pre" in
        ''|direct) _bs_u=$_bs_url ;;
        */)        _bs_u="$_bs_pre$_bs_url" ;;
        *)         _bs_u="$_bs_pre/$_bs_url" ;;
      esac
      _bs_info "下载程序包：$_bs_tag${_bs_pre:+（镜像 $_bs_pre）}…"
      if _bs_fetch "$_bs_u" "$_bs_dir/$_bs_asset"; then
        _bs_ok=1
        _bs_info "已下载 $(wc -c < "$_bs_dir/$_bs_asset" | tr -d ' ') 字节"
        break
      fi
      _bs_info "  这条地址没拿到，换下一个"
    done
    if [ "$_bs_ok" = "1" ]; then
      tar -xzf "$_bs_dir/$_bs_asset" -C "$_bs_dir" || _bs_die "程序包解压失败"
    else
      _bs_info "release 里没有 $_bs_asset，改用仓库快照（分支 ${MIHOMO_BOX_BRANCH:-main}）"
    fi
  else
    _bs_info "取不到 release 版本号，改用仓库快照（分支 ${MIHOMO_BOX_BRANCH:-main}）"
  fi
  if [ "$_bs_ok" != "1" ]; then
    # ② 仓库快照（分支 tar.gz）：只提交、还没打 release 时也能装。
    #    解压后直接跑快照里的 openwrt/install.sh —— 安装器识别到「仓库检出」会
    #    自己把 src/ 的模块脚本与面板组装成程序包（见 payload 解析节）。
    _bs_branch=${MIHOMO_BOX_BRANCH:-main}
    _bs_url=$_bs_codeload_base/$_bs_repo/tar.gz/refs/heads/$_bs_branch
    for _bs_pre in $_bs_list; do
      case "$_bs_pre" in
        ''|direct) _bs_u=$_bs_url ;;
        */)        _bs_u="$_bs_pre$_bs_url" ;;
        *)         _bs_u="$_bs_pre/$_bs_url" ;;
      esac
      _bs_info "下载仓库快照：$_bs_branch${_bs_pre:+（镜像 $_bs_pre）}…"
      if _bs_fetch "$_bs_u" "$_bs_dir/snapshot.tar.gz"; then
        mkdir -p "$_bs_dir/snap" || _bs_die "无法创建解压目录"
        tar -xzf "$_bs_dir/snapshot.tar.gz" -C "$_bs_dir/snap" || _bs_die "仓库快照解压失败"
        _bs_root=$(find "$_bs_dir/snap" -maxdepth 1 -mindepth 1 -type d | head -1)
        if [ -n "$_bs_root" ] && [ -f "$_bs_root/openwrt/install.sh" ]; then
          # 仓库快照里，安装所需的三种布局任选其一即可（都由快照里的安装器自己识别）：
          #   ① openwrt/files/ 已是一份完整程序包（模块脚本 + 面板都在里面）—— 当前仓库就是这样
          #   ② 仓库里有 src/（模块脚本 + 面板源码），安装器会就地组装
          #   ③ openwrt/payload.tar.gz（把打好的 tgz 传上去）
          if [ -f "$_bs_root/openwrt/files/mihomo.sh" ] && [ -d "$_bs_root/openwrt/files/webroot/ui" ]; then
            _bs_info "仓库快照里带完整程序包（openwrt/files/），转到完整安装器…"
            exec sh "$_bs_root/openwrt/install.sh" "$@"
          elif [ -f "$_bs_root/src/scripts/mihomo.sh" ] && [ -d "$_bs_root/src/webroot/ui" ]; then
            _bs_info "仓库快照里带源码（src/），转到完整安装器（就地组装）…"
            exec sh "$_bs_root/openwrt/install.sh" "$@"
          elif [ -f "$_bs_root/openwrt/payload.tar.gz" ]; then
            _bs_info "仓库快照里带 openwrt/payload.tar.gz，转到完整安装器…"
            exec sh "$_bs_root/openwrt/install.sh" "$@"
          fi
          _bs_info "仓库快照里只有 openwrt/ 的脚本，缺安装件。三者任选其一即可：
  ① 让 openwrt/files/ 里带上 mihomo.sh 与 webroot/ui（README 里说明了怎么生成）；
  ② 把 src/（模块脚本 + 面板源码）推到仓库；
  ③ 把打好的程序包传到 openwrt/payload.tar.gz。
  另外：Release 里挂 mihomo-box-openwrt-<最新 tag>.tar.gz 也行（自举优先用它）。"
        else
          _bs_info "仓库快照里没有 openwrt/install.sh（openwrt/ 目录还没提交？）"
        fi
      fi
    done
    _bs_die "自举失败：Release 资产与仓库快照都没取到。
  最省事的做法：把程序包挂到 Release —— 资产名必须是 mihomo-box-openwrt-<最新 tag>.tar.gz
  （仓库当前最新 tag：${_bs_tag:-未知}）。或者加 --mirror auto 走镜像，或手动下载 tgz 后离线安装。"
  fi
  [ -f "$_bs_dir/install.sh" ] || _bs_die "程序包里没有 install.sh"
  _bs_info "转到完整安装器…"
  exec sh "$_bs_dir/install.sh" "$@"
fi


. "$HERE/lib/common.sh"

REPO=${MIHOMO_BOX_REPO:-jieluojun/mihomo_box}

usage() {
  cat <<EOF
用法：sh install.sh [选项]

安装
  --dir <路径>          安装目录（默认 /etc/mihomo_box）
  --port <端口>         面板端口（默认 55555）
  --token <字符串>      面板访问令牌（默认随机生成）
  --no-auth             关闭面板令牌校验（同网段任何人可进面板执行命令，不建议）
  --core <文件|URL>     用本地内核文件或直链安装（.gz 或裸 ELF）
  --core-version <v>    指定内核版本，如 v1.19.31（默认取最新正式版）
  --variant <变体>      amd64: compatible|v2|v3；mips/le: softfloat|hardfloat；loong64: abi1|abi2
  --mirror <前缀>       GitHub 加速前缀（如 https://ghfast.top/）；auto=内置镜像列表；direct=直连
  --no-core             跳过内核安装（自备内核或只想先装面板）
  --install-tun         顺带安装 kmod-tun（配置里用 TUN 接管流量时需要）
  --no-curl-install     缺少 curl 时不尝试用 opkg/apk 安装，只提示
  --no-start            安装完不启动服务
  --payload <目录|tgz|URL>  程序包来源（默认自动：本地 files/ 或仓库 release）
  --force               目标目录已存在且不是本程序时仍继续

卸载
  --uninstall           卸载（服务、程序、面板；保留 config.yaml 与内核）
  --purge               卸载时连配置与内核一起删

其他
  --prefix <路径>       安装根前缀（测试用；正常部署不要加）
  -y                    不询问
  -h, --help            本帮助
EOF
}

DIR=/etc/mihomo_box
PORT=$DEFAULT_PORT
TOKEN=''
AUTH=1
CORE_SRC=''
CORE_VER=''
VARIANT=''
MIRROR=''
DO_CORE=1
DO_TUN=0
CURL_INSTALL=1
DO_START=1
PAYLOAD=''
FORCE=0
ASSUME_YES=0
UNINSTALL=0
PURGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=$2; shift 2 ;;
    --dir=*) DIR=${1#*=}; shift ;;
    --port) PORT=$2; shift 2 ;;
    --port=*) PORT=${1#*=}; shift ;;
    --token) TOKEN=$2; shift 2 ;;
    --token=*) TOKEN=${1#*=}; shift ;;
    --no-auth) AUTH=0; shift ;;
    --core) CORE_SRC=$2; shift 2 ;;
    --core=*) CORE_SRC=${1#*=}; shift ;;
    --core-version) CORE_VER=$2; shift 2 ;;
    --core-version=*) CORE_VER=${1#*=}; shift ;;
    --variant) VARIANT=$2; shift 2 ;;
    --variant=*) VARIANT=${1#*=}; shift ;;
    --mirror) MIRROR=$2; shift 2 ;;
    --mirror=*) MIRROR=${1#*=}; shift ;;
    --no-core) DO_CORE=0; shift ;;
    --install-tun) DO_TUN=1; shift ;;
    --no-curl-install) CURL_INSTALL=0; shift ;;
    --no-start) DO_START=0; shift ;;
    --payload) PAYLOAD=$2; shift 2 ;;
    --payload=*) PAYLOAD=${1#*=}; shift ;;
    --prefix) PREFIX=$2; shift 2 ;;
    --prefix=*) PREFIX=${1#*=}; shift ;;
    --force) FORCE=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
done

# 选项与路径重新落位（common.sh 已被 source，路径要按最终 PREFIX/DIR 重算）
if [ -n "$PREFIX" ]; then
  DIR="${PREFIX}${DIR}"
  INITD=$PREFIX/etc/init.d/mihomo_box
  UCICFG=$PREFIX/etc/config/mihomo_box
  BINLINK=$PREFIX/usr/bin/mihomo-box
fi
ETC=$DIR
RUN=$ETC/run
COREDIR=$ETC/core
CONFIG=$ETC/config.yaml
SETTINGS=$ETC/module-settings.conf
SCRIPTDIR=$ETC/scripts
WEBROOT=$ETC/webroot/ui
OWRT_MARK=$ETC/platform
CORE_BIN=$COREDIR/mihomo-official
CORE_URL_FILE=$ETC/core.source
BOX_VERSION_FILE=$ETC/box.version

case "$PORT" in ''|*[!0-9]*) PORT=$DEFAULT_PORT ;; esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then PORT=$DEFAULT_PORT; fi

# 镜像前缀列表（程序包与内核共用）
case "$MIRROR" in
  auto)   MIRLIST=$MIRROR_LIST_DEFAULT ;;
  '')     MIRLIST='direct' ;;
  direct) MIRLIST='direct' ;;
  *)      MIRLIST="$MIRROR direct" ;;
esac

# ---------------- 卸载 ----------------
if [ "$UNINSTALL" = "1" ]; then
  if [ ! -d "$ETC" ]; then die "找不到安装目录 $ETC"; fi
  if [ "$ASSUME_YES" = "0" ]; then
    _keepmsg='（保留 config.yaml 与内核）'
    if [ "$PURGE" = "1" ]; then _keepmsg='，配置与内核一并删除'; fi
    printf '确认卸载 %s ？服务与面板会被移除%s [y/N] ' "$ETC" "$_keepmsg"
    _ans=''
    read -r _ans || _ans=''
    case "$_ans" in y|Y|yes|YES) : ;; *) die "已取消" ;; esac
  fi
  if [ -x "$INITD" ] && [ -z "$PREFIX" ]; then
    "$INITD" stop >/dev/null 2>&1 || true
    "$INITD" disable >/dev/null 2>&1 || true
  fi
  if [ -x "$SCRIPTDIR/box.sh" ]; then
    "$SCRIPTDIR/box.sh" stop >/dev/null 2>&1 || true
  fi
  sleep 1
  # 兜底：还有自家进程活着就按 pid 文件收掉
  for _up_pf in "$RUN/httpd.pid" "$RUN/core.pid"; do
    if [ -f "$_up_pf" ]; then
      _up_p=$(cat "$_up_pf" 2>/dev/null)
      case "$_up_p" in ''|*[!0-9]*) : ;; *) kill "$_up_p" 2>/dev/null || true ;; esac
    fi
  done
  rm -f "$INITD" "$UCICFG" "$BINLINK"
  if [ "$PURGE" = "1" ]; then
    rm -rf "$ETC"
    log "已卸载并删除 $ETC"
  else
    rm -rf "$ETC/scripts" "$ETC/webroot" "$ETC/run" "$ETC/platform" "$ETC/box.version" "$ETC/module.prop" "$ETC/uninstall.sh" "$ETC/README.md" 2>/dev/null || true
    log "已卸载（保留 $CONFIG 与 $CORE_BIN；彻底删除请加 --purge）"
  fi
  exit 0
fi

# ---------------- 前置检查 ----------------
# root 检查：正常部署必须 root（要装服务、写 /etc）。测试用 --prefix 时跳过，
# 因为那只是在一个临时前缀里摆一套目录，不碰系统。
if [ -z "$PREFIX" ] && [ "$(id -u 2>/dev/null || echo 1)" != "0" ]; then
  die "需要 root 权限运行（OpenWrt 上先 ssh 登录）"
fi

if ! is_openwrt && [ -z "$PREFIX" ]; then
  warn "没检测到 OpenWrt（缺 /etc/openwrt_release 与 /etc/rc.common），继续安装可能不适用本机"
  if [ "$ASSUME_YES" = "0" ]; then
    printf '继续？[y/N] '
    _a=''
    read -r _a || _a=''
    case "$_a" in y|Y|yes) : ;; *) die "已取消" ;; esac
  fi
fi

lacks=0
for t in sh awk sed grep tar gzip; do
  if ! have "$t"; then warn "缺少必需命令：$t"; lacks=1; fi
done
if [ "$lacks" = "1" ]; then die "系统工具不全，请先安装 busybox / coreutils"; fi
if ! detect_dl_tool; then warn "没找到下载器（curl / wget / uclient-fetch）—— 离线安装请用 --payload 指定本地程序包"; fi

# curl：面板自身的功能（状态回读 / 订阅更新 / 部分写入）依赖它
if ! have curl; then
  if [ "$CURL_INSTALL" = "1" ] && [ -n "$(pkg_manager)" ]; then
    info "未检测到 curl，尝试安装：curl + ca-bundle …"
    if ! pkg_install curl ca-bundle; then
      pkg_install curl ca-certificates || warn "curl 安装失败（可稍后手动 opkg install curl ca-bundle）"
    fi
  fi
  if ! have curl; then
    warn "仍无 curl：面板可用，但「订阅更新」与部分写入操作用不了（GET 退回 wget，写请求退回 nc）"
  fi
fi

# busybox httpd 是面板的宿主，必须存在
if ! have httpd; then
  if ! have busybox || ! busybox httpd --help >/dev/null 2>&1; then
    warn "找不到 busybox httpd（面板服务需要它；OpenWrt 默认自带，若精简过请装 busybox）"
  fi
fi

# ---------------- 目标目录 ----------------
if [ -e "$ETC" ] && [ ! -f "$OWRT_MARK" ] && [ ! -f "$SCRIPTDIR/mihomo.sh" ] && [ "$FORCE" = "0" ]; then
  die "$ETC 已存在且不是本程序（加 --force 才继续，或 --dir 换目录）"
fi
mkdir -p "$ETC" "$RUN" "$COREDIR" "$SCRIPTDIR" "$WEBROOT" || die "创建 $ETC 失败"
chmod 755 "$ETC" "$RUN" "$COREDIR" "$SCRIPTDIR" 2>/dev/null || true

# 磁盘空间：内核解压后约 25~35 MB
_free_kib=$(free_kib "$ETC")
if [ "$DO_CORE" = "1" ] && [ "$_free_kib" -gt 0 ] 2>/dev/null; then
  if [ "$_free_kib" -lt 40000 ]; then
    warn "$ETC 可用空间仅 $((_free_kib / 1024)) MB，安装内核后可能不够（建议 --dir 指到大分区）"
  fi
fi

# ---------------- 程序文件（面板 / 脚本 / 配置模板）----------------
# 优先级：显式 --payload > 本地完整程序包目录（files/ 齐活）> 仓库检出（就地组装）
#         > 仓库 release 下载。
# 顺序很重要：从仓库快照或 git clone 直接跑时，$HERE/files 是「源码目录」而不是程序包
# （模块脚本在 ../src/scripts，面板在 ../src/webroot/ui），所以 --payload 必须压过自动探测。
PAYLOAD_DIR=''
PDIR=''
if [ -n "$PAYLOAD" ]; then
  case "$PAYLOAD" in
    *.tar.gz|*.tgz)
      if [ ! -f "$PAYLOAD" ]; then die "程序包不存在：$PAYLOAD"; fi
      PDIR=$ETC/.payload; rm -rf "$PDIR"; mkdir -p "$PDIR"
      tar -xzf "$PAYLOAD" -C "$PDIR" || die "程序包解压失败"
      PAYLOAD_DIR=$PDIR ;;
    http://*|https://*)
      PTMP=$ETC/.payload.dl.tar.gz
      fetch_multi "$PAYLOAD" "$MIRLIST" "$PTMP" || die "程序包下载失败：$PAYLOAD"
      PDIR=$ETC/.payload; rm -rf "$PDIR"; mkdir -p "$PDIR"
      tar -xzf "$PTMP" -C "$PDIR" || die "程序包解压失败"
      rm -f "$PTMP"; PAYLOAD_DIR=$PDIR ;;
    *)
      if [ ! -d "$PAYLOAD" ] || [ ! -f "$PAYLOAD/files/box.sh" ]; then
        die "--payload 需要是本程序包目录 / tgz / URL（目录里要有 files/box.sh）"
      fi
      PAYLOAD_DIR=$PAYLOAD ;;
  esac
fi

if [ -z "$PAYLOAD_DIR" ]; then
  if [ -d "$HERE/files" ] && [ -f "$HERE/files/box.sh" ] && [ -f "$HERE/files/mihomo.sh" ] && [ -d "$HERE/files/webroot/ui" ]; then
    # 当前目录就是打好的程序包（tgz 解开的那个目录）
    PAYLOAD_DIR=$HERE
  elif [ -f "$HERE/payload.tar.gz" ]; then
    # 仓库里放了打好的程序包（openwrt/payload.tar.gz）：直接用它
    info "使用仓库内程序包 openwrt/payload.tar.gz"
    PDIR=$ETC/.payload; rm -rf "$PDIR"; mkdir -p "$PDIR"
    tar -xzf "$HERE/payload.tar.gz" -C "$PDIR" || die "openwrt/payload.tar.gz 解压失败"
    PAYLOAD_DIR=$PDIR
  elif [ -d "$HERE/files" ] && [ -f "$HERE/../src/scripts/mihomo.sh" ] && [ -d "$HERE/../src/webroot/ui" ]; then
    # 直接跑仓库检出（git clone 后 sh openwrt/install.sh）：把模块脚本与面板就地组装成程序包
    info "检测到仓库检出，就地组装程序包"
    PDIR=$ETC/.payload; rm -rf "$PDIR"; mkdir -p "$PDIR/files/webroot" "$PDIR/lib"
    cp -f "$HERE/lib/common.sh" "$PDIR/lib/" || die "组装失败：lib/common.sh"
    _asm_ok=0
    for _asm_f in "$HERE/files/"*; do
      if [ -f "$_asm_f" ]; then cp -f "$_asm_f" "$PDIR/files/"; _asm_ok=1; fi
    done
    if [ "$_asm_ok" != "1" ]; then die "组装失败：openwrt/files 是空的"; fi
    cp -f "$HERE/../src/scripts/mihomo.sh" "$PDIR/files/mihomo.sh" || die "组装失败：scripts/mihomo.sh"
    rm -rf "$PDIR/files/webroot/ui"
    cp -a "$HERE/../src/webroot/ui" "$PDIR/files/webroot/ui" || die "组装失败：webroot/ui"
    cp -f "$HERE/files/exec.sh" "$PDIR/files/webroot/ui/cgi-bin/exec.sh"
    rm -f "$PDIR/files/webroot/ui/install.stamp"
    date +%Y%m%d-%H%M > "$PDIR/VERSION"
    PAYLOAD_DIR=$PDIR
  else
    # 最后才走网络：从仓库 release 拉程序包
    PTMP=$ETC/.payload.dl.tar.gz
    _pv=$(fetch_stdout "https://api.github.com/repos/$REPO/releases/latest" 20 2>/dev/null | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1) || _pv=''
    if [ -z "$_pv" ]; then die "无法确定程序包版本（网络不通？用 --payload 指定本地 tgz）"; fi
    _purl="https://github.com/$REPO/releases/download/$_pv/mihomo-box-openwrt-$_pv.tar.gz"
    info "下载程序包：$_pv"
    fetch_multi "$_purl" "$MIRLIST" "$PTMP" || die "程序包下载失败（可 --mirror auto，或 --payload 本地包）"
    PDIR=$ETC/.payload; rm -rf "$PDIR"; mkdir -p "$PDIR"
    tar -xzf "$PTMP" -C "$PDIR" || die "程序包解压失败"
    rm -f "$PTMP"
    PAYLOAD_DIR=$PDIR
  fi
fi


info "安装程序文件到 $ETC"
cp -f "$PAYLOAD_DIR/files/mihomo.sh" "$SCRIPTDIR/mihomo-module.sh" || die "复制模块脚本失败"
cp -f "$PAYLOAD_DIR/files/box.sh"    "$SCRIPTDIR/box.sh"           || die "复制 box.sh 失败"
# 面板前端固定调用 scripts/mihomo.sh：那份文件是调度器（= box.sh），
# 真正的模块脚本放在 mihomo-module.sh，由调度器按需转发。
cp -f "$PAYLOAD_DIR/files/box.sh"    "$SCRIPTDIR/mihomo.sh"        || die "复制调度器失败"
chmod 755 "$SCRIPTDIR/mihomo-module.sh" "$SCRIPTDIR/box.sh" "$SCRIPTDIR/mihomo.sh"

# 工作目录骨架与随包数据文件（与 Android 版 customize.sh 同一套语义）：
#   · proxies/ 放本地 provider 文件（默认配置里的「钉钉直连」「非免节点」就指向它们）
#   · rules/ backup/ 只是先建好，方便用户往里放文件
# 已存在的文件一律不覆盖 —— 用户改过的节点清单要保住。
mkdir -p "$ETC/proxies" "$ETC/rules" "$ETC/backup"
if [ -d "$PAYLOAD_DIR/files/data/proxies" ]; then
  _inst=0
  for _pf in "$PAYLOAD_DIR/files/data/proxies/"*; do
    [ -f "$_pf" ] || continue
    _pn=${_pf##*/}
    if [ -f "$ETC/proxies/$_pn" ]; then
      info "已存在，保留不动：proxies/$_pn"
    else
      cp -f "$_pf" "$ETC/proxies/$_pn" || die "写入 proxies/$_pn 失败"
      chmod 644 "$ETC/proxies/$_pn" 2>/dev/null || true
      info "已放入 proxies/$_pn"
      _inst=$((_inst + 1))
    fi
  done
  [ "$_inst" -gt 0 ] || true
else
  warn "程序包里没有 data/proxies（钉钉直连.yaml / 非免节点.txt 未安装）"
fi
# 公共库：box.sh 的 update-core / check-env 等要用（装在 scripts/lib/ 下）
mkdir -p "$SCRIPTDIR/lib"
if [ -f "$PAYLOAD_DIR/lib/common.sh" ]; then
  cp -f "$PAYLOAD_DIR/lib/common.sh" "$SCRIPTDIR/lib/common.sh" || die "复制 lib/common.sh 失败"
else
  warn "程序包内没有 lib/common.sh：mihomo-box update-core / check-env 等命令会不可用"
fi

# 面板 WebUI：整棵 ui/ 目录（index.html / js / css / img / cgi-bin / sw.js / manifest）
if [ -d "$PAYLOAD_DIR/files/webroot/ui" ]; then
  mkdir -p "$ETC/webroot"
  rm -rf "$ETC/webroot/ui.new" "$ETC/webroot/ui.old"
  cp -a "$PAYLOAD_DIR/files/webroot/ui" "$ETC/webroot/ui.new" || die "复制面板文件失败"
  if [ -d "$WEBROOT" ]; then
    mv "$WEBROOT" "$ETC/webroot/ui.old" 2>/dev/null || rm -rf "$WEBROOT"
  fi
  mv "$ETC/webroot/ui.new" "$WEBROOT" || die "替换面板目录失败"
  rm -rf "$ETC/webroot/ui.old" 2>/dev/null || true
else
  warn "程序包内没有 webroot/ui —— 面板不会安装（只装了命令行）"
fi
if [ -f "$PAYLOAD_DIR/files/module.prop" ]; then cp -f "$PAYLOAD_DIR/files/module.prop" "$ETC/module.prop"; fi
if [ -f "$PAYLOAD_DIR/files/uninstall.sh" ]; then cp -f "$PAYLOAD_DIR/files/uninstall.sh" "$ETC/uninstall.sh"; chmod 755 "$ETC/uninstall.sh"; fi
if [ -f "$PAYLOAD_DIR/files/README.md" ]; then cp -f "$PAYLOAD_DIR/files/README.md" "$ETC/README.md"; fi
if [ -f "$PAYLOAD_DIR/VERSION" ]; then cp -f "$PAYLOAD_DIR/VERSION" "$BOX_VERSION_FILE"; fi
if [ ! -s "$BOX_VERSION_FILE" ]; then echo "dev" > "$BOX_VERSION_FILE"; fi

# 平台标记：后端（mihomo.sh）据此上报 platform=openwrt，面板据此隐藏安卓专有功能
echo openwrt > "$OWRT_MARK"

# cgi-bin 执行桥：httpd.conf 已声明解释器，这里再补执行位
if [ -f "$WEBROOT/cgi-bin/exec.sh" ]; then chmod 755 "$WEBROOT/cgi-bin/exec.sh" 2>/dev/null || true; fi

# ---------------- 设置与令牌 ----------------
if [ ! -f "$SETTINGS" ]; then : > "$SETTINGS"; fi
setting_set webui_port "$PORT"
setting_set webui true
setting_set core official
setting_set autostart "$(setting_get autostart true)"
if [ "$AUTH" = "1" ]; then
  setting_set webui_auth true
  if [ -z "$TOKEN" ]; then TOKEN=$(random_token); fi
  printf '%s\n' "$TOKEN" > "$RUN/webui.token"
  chmod 600 "$RUN/webui.token" 2>/dev/null || true
else
  setting_set webui_auth false
  rm -f "$RUN/webui.token" 2>/dev/null || true
fi
if [ -n "$MIRROR" ]; then setting_set mirror "$MIRROR"; fi

# ---------------- 内核 ----------------
if [ "$DO_CORE" = "1" ]; then
  _core_local=$CORE_SRC
  case "$CORE_SRC" in
    http://*|https://*)
      _core_local=$ETC/.core.user.gz
      info "下载指定内核：$CORE_SRC"
      fetch_multi "$CORE_SRC" "$MIRLIST" "$_core_local" || die "指定内核下载失败"
      ;;
  esac
  core_install "$CORE_VER" "$VARIANT" "$MIRLIST" "$_core_local" || die "内核安装失败"
  if [ -f "$ETC/.core.user.gz" ]; then rm -f "$ETC/.core.user.gz"; fi
  # 内核换过 → 清掉版本缓存，状态里立刻是新版本号
  rm -f "$RUN/vercache" "$RUN/tested.fp" 2>/dev/null || true
else
  warn "已跳过内核安装（--no-core）：稍后可跑 mihomo-box setup-core"
fi

# TUN 模式（config.yaml 里 tun.enable: true 时）需要 /dev/net/tun
if [ "$DO_TUN" = "1" ]; then
  if [ -c "$PREFIX/dev/net/tun" ] || [ -c /dev/net/tun ]; then
    info "/dev/net/tun 已存在，无需安装"
  else
    info "安装 kmod-tun（TUN 模式必需）…"
    pkg_install kmod-tun || warn "kmod-tun 安装失败：TUN 模式不可用（可在路由器软件包里手动装）"
  fi
fi
if [ -z "$PREFIX" ]; then
  if [ ! -c /dev/net/tun ]; then
    warn "当前没有 /dev/net/tun：配置里若用 TUN 接管流量会启动失败（装 kmod-tun 或改用其它方式）"
  fi
fi

# ---------------- 默认配置 ----------------
if [ ! -f "$CONFIG" ]; then
  info "写入默认配置 $CONFIG"
  if [ -f "$PAYLOAD_DIR/files/config.yaml" ]; then
    cp -f "$PAYLOAD_DIR/files/config.yaml" "$CONFIG" || die "写入默认配置失败"
  else
    die "程序包里缺少 config.yaml 模板"
  fi
else
  info "已存在配置，保持不动：$CONFIG"
fi

# ---------------- 跳转页（与 Android 端同源，用真实模块脚本生成）----------------
if ! MODDIR=$ETC WORKDIR=$ETC sh "$SCRIPTDIR/mihomo.sh" webroot-sync >/dev/null 2>&1; then
  warn "跳转页生成失败（不影响面板直接访问 http://<路由器IP>:$PORT/）"
fi

# ---------------- 安装指纹 ----------------
# Android 端由 customize.sh 现场写 webroot/install.stamp（内容 = 本次版本戳），
# 面板前端据此判断「模块被重装过」并作废旧 Service Worker 缓存。
# 路由器端每次安装/升级同样重写，语义保持一致（缺这个文件前端会 404 一次）。
if [ -d "$WEBROOT" ]; then
  printf '%s\n' "$(cat "$BOX_VERSION_FILE" 2>/dev/null | head -1)" > "$WEBROOT/install.stamp" 2>/dev/null || warn "写入 install.stamp 失败（不影响使用）"
fi

# ---------------- 服务 ----------------
if [ -z "$PREFIX" ]; then
  info "安装服务 /etc/init.d/mihomo_box 与配置 /etc/config/mihomo_box"
  mkdir -p "$PREFIX/etc/init.d" "$PREFIX/etc/config" "$PREFIX/usr/bin"
  cp -f "$PAYLOAD_DIR/files/mihomo_box.init" "$INITD" || die "安装 init 脚本失败"
  chmod 755 "$INITD"
  if [ ! -f "$UCICFG" ]; then cp -f "$PAYLOAD_DIR/files/mihomo_box.config" "$UCICFG" 2>/dev/null || true; fi
  ln -sf "$SCRIPTDIR/box.sh" "$BINLINK" 2>/dev/null || cp -f "$SCRIPTDIR/box.sh" "$BINLINK"
  chmod 755 "$BINLINK" 2>/dev/null || true
  if have uci; then
    uci -q set mihomo_box.@main[0].enabled='1' >/dev/null 2>&1 || true
    uci -q commit mihomo_box >/dev/null 2>&1 || true
  fi
  "$INITD" enable >/dev/null 2>&1 || warn "开机自启注册失败（可手动：/etc/init.d/mihomo_box enable）"
else
  # 测试前缀：不装真正的 procd 服务，写一个等价入口（box.sh 的路径会被替换成实际安装目录）
  mkdir -p "$PREFIX/etc/init.d" "$PREFIX/usr/bin" 2>/dev/null || true
  sed "s#/etc/mihomo_box#$ETC#g" "$PAYLOAD_DIR/files/mihomo_box.init" > "$INITD" 2>/dev/null || cp -f "$PAYLOAD_DIR/files/mihomo_box.init" "$INITD"
  chmod 755 "$INITD" 2>/dev/null || true
  ln -sf "$SCRIPTDIR/box.sh" "$BINLINK" 2>/dev/null || true
fi

# ---------------- 收尾 ----------------
if [ "$DO_START" = "1" ]; then
  info "启动服务…"
  if ! MODDIR=$ETC WORKDIR=$ETC sh "$SCRIPTDIR/box.sh" start >/dev/null 2>&1; then
    warn "启动失败：稍后手动执行 mihomo-box start 看错误"
  fi
  sleep 1
fi
rm -rf "$ETC/.payload" 2>/dev/null || true

# ---------------- 结果 ----------------
_addr=$(ip -4 addr show 2>/dev/null | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | grep -v '^127\.' | head -1) || _addr=''
if [ -z "$_addr" ]; then
  _addr=$(ifconfig 2>/dev/null | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p' | grep -v '^127\.' | head -1) || _addr=''
fi
if [ -z "$_addr" ]; then _addr='<路由器IP>'; fi
_q='/'
if [ "$AUTH" = "1" ]; then _q="/?t=$(cat "$RUN/webui.token" 2>/dev/null)"; fi

cat <<EOF

============================================================
 Mihomo Box 已安装到 $ETC
============================================================
 面板地址   http://${_addr}:$PORT${_q}
EOF
if [ "$AUTH" = "1" ]; then printf ' 访问令牌   %s\n' "$(cat "$RUN/webui.token" 2>/dev/null)"; fi
cat <<EOF
 内核       $(sed 's#.*/##' "$CORE_URL_FILE" 2>/dev/null || echo '（未安装）')
 配置       $CONFIG
 命令行     mihomo-box help        （status / logs / restart / update-core / panel-url …）
 服务       /etc/init.d/mihomo_box {start|stop|restart|enable|disable}
 卸载       sh $ETC/uninstall.sh   或  mihomo-box uninstall

 下一步：
   1) 打开面板 → 「配置」页加订阅，或直接编辑 $CONFIG
   2) 要整机接管流量：配置里加 tun: {enable: true, stack: system}（需 kmod-tun），
      或自行配置 mihomo 的 TPROXY（本包不改动系统防火墙）
============================================================
EOF
