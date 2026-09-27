#!/bin/sh
# ============================================================
# Mihomo Box · OpenWrt 一键安装脚本
#
# 用法（路由器上以 root 执行）：
#   sh mihomo-box-openwrt-install.sh                # 安装 / 热更新
#   sh mihomo-box-openwrt-install.sh install        # 同上
#   sh mihomo-box-openwrt-install.sh uninstall      # 卸载
#
# 可选参数（install）：
#   --zip <本地包>   用本地发布包安装（离线安装，支持 .zip）
#   --url <地址>     指定安装包下载地址（.zip / .tar.gz）
#   --no-start       安装后不立即启动服务
#
# 与 Android 版（KernelSU / Magisk 模块）的对应关系：
#   · 安装目录 /etc/mihomo_box —— 模块文件与工作目录同址
#     （对应 Android 的 /data/adb/modules/mihomo_box + /data/adb/mihomo_box，
#       仅路径不同，脚本 / 面板 / 默认配置全部保持与 Android 版一致）
#   · 下载走「mihomo box 面板内核管理页」同款加速镜像，直连 GitHub 殿后兜底：
#       v6.gh-proxy.org → ghfast.top → gh-proxy.com → ghproxy.net → moeyy → 直连
#   · 不下载 mihomo 内核 —— 内核交给面板「内核管理」页下载（与 Android 版相同，
#     模块包内本来就不含内核）
#   · 默认配置 config.yaml / 钉钉直连 / 非免节点 / module-settings.conf /
#     面板缓存打点等安装步骤与 Android 版 customize.sh 完全一致
#   · 开机自启由 /etc/init.d/mihomo_box 承担（对应 Android 版 service.sh 流程）
#   · 面板服务依赖 busybox httpd，而 OpenWrt 的 busybox 一般不含 httpd 小程序：
#     缺失时自动安装兼容垫片（httpd→uhttpd 透传 / nohup / base64 / od，只补不覆盖，
#     模块脚本零改动）；busybox 自带时则直接使用（od 垫片修内核下载 gzip/ELF
#     校验在缺 od 系统上「每个镜像下完就判损坏、换镜像重下」的死循环）
#   · 自动识别包管理器（opkg / apk）与防火墙后端，检查并安装 TUN / Tproxy 依赖
#     （kmod-tun；iptables 防火墙装 iptables tproxy 套件，nftables 防火墙另加
#     kmod-nft-tproxy 与 iptables-nft 兼容层）；已具备则跳过，不重复安装
#
# 兼容：busybox ash / dash / bash；OpenWrt 21.02+（含 iStoreOS / ImmortalWrt 等衍生版）
# ============================================================

# ---------- 可覆盖常量（测试 / 定制用，日常无需改动） ----------
REPO="${MIHOMO_BOX_REPO:-jieluojun/mihomo_box}"
INSTALL_DIR="${MIHOMO_BOX_DIR:-/etc/mihomo_box}"
INITD="${MIHOMO_BOX_INITD:-/etc/init.d/mihomo_box}"
COMPAT_DIR="${MIHOMO_BOX_COMPAT:-/usr/sbin}"         # 兼容垫片落点（在 CGI/init PATH 内）
HTTPD_SHIM="${MIHOMO_BOX_HTTPD:-$COMPAT_DIR/httpd}"  # 面板 httpd 适配器（uhttpd 后端）
SHIM_MARKER="mihomo-box-openwrt"
UPDATE_JSON_URL="https://raw.githubusercontent.com/$REPO/main/update.json"
LATEST_PAGE="https://github.com/$REPO/releases/latest"

# ---------- 输出 ----------
say()  { printf '%s\n' "$*"; }
step() {
  printf '\n==> %s\n' "$*"
  # 现场痕迹：每步落一行时间戳到 run/install.trace ——真机万一再出现
  # 「输出停在某处」，看这个文件就知道卡在哪一步（curl|sh 场景排障专用）
  if [ -n "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR/run" 2>/dev/null
    printf '%s %s\n' "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$*" >> "$INSTALL_DIR/run/install.trace" 2>/dev/null
  fi
}
ok()   { printf '  ✅ %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }
die()  { printf '\n  ❌ %s\n' "$*" >&2; exit 1; }

# ---------- 加速镜像（与面板「内核管理」页的下载加速镜像一致） ----------
# 候选顺序与面板「自动优选」相同：镜像按推荐序打头，直连 GitHub 殿后只作兜底，
# 单条链路不通自动换下一条，不会拖垮整次下载。
MIRRORS='https://v6.gh-proxy.org/
https://ghfast.top/
https://gh-proxy.com/
https://ghproxy.net/
https://github.moeyy.xyz/'

is_github_url() {
  case "$1" in
    https://github.com/*|http://github.com/*|https://raw.githubusercontent.com/*|https://codeload.github.com/*)
      return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- HTTP 客户端（curl / wget / busybox wget 依次找一个能跑的） ----------
HTTP_CLIENT=""
pick_http() {
  if command -v curl >/dev/null 2>&1; then HTTP_CLIENT=curl; return 0; fi
  if command -v wget >/dev/null 2>&1; then HTTP_CLIENT=wget; return 0; fi
  if command -v busybox >/dev/null 2>&1; then HTTP_CLIENT="busybox wget"; return 0; fi
  return 1
}

# $1=url $2=输出文件 $3=最长等待秒
http_get() {
  _hg_t="${3:-300}"
  case "$HTTP_CLIENT" in
    curl)
      curl -f -s -S -L --connect-timeout 10 --max-time "$_hg_t" -o "$2" "$1" ;;
    wget)
      if command -v timeout >/dev/null 2>&1; then
        timeout "$_hg_t" wget -q -O "$2" "$1"
      else
        wget -q -O "$2" "$1"
      fi ;;
    "busybox wget")
      if command -v timeout >/dev/null 2>&1; then
        timeout "$_hg_t" busybox wget -q -O "$2" "$1"
      else
        busybox wget -q -O "$2" "$1"
      fi ;;
    *) return 1 ;;
  esac
}

# 下载结果校验：镜像对不支持的路径可能回 200 + 错误页（HTML）甚至空 tar 包，
# 只看非空会把垃圾当成功。按类型验真：
#   zip    —— 文件头 PK 魔数 + 包内文件名明文含 module.prop（zip 文件名不压缩，
#             grep 即可，不依赖 unzip；结构完整性解压时再验）
#   tar.gz —— tar 能列出 module.prop
#   json   —— 看结构
valid_payload() {
  # $1=文件 $2=类型(zip|tar.gz|json|any)
  case "$2" in
    zip)
      [ "$(head -c 2 "$1" 2>/dev/null)" = "PK" ] && grep -q 'module\.prop' "$1" 2>/dev/null ;;
    tar.gz)
      tar -tzf "$1" 2>/dev/null | grep -q 'module\.prop' ;;
    json)
      grep -q '{' "$1" 2>/dev/null ;;
    *)
      [ -s "$1" ] ;;
  esac
}

# ---------- 纯 shell 解 zip（终阶兜底，零外部依赖）----------
# OpenWrt 默认既没有 Info-ZIP unzip，busybox 也不带 unzip 小程序，但必有
# dd / od / gunzip。zip 条目若为 deflate（method 8），把裸 deflate 流包一层
# gzip 头尾（CRC32/长度取自 zip 中央目录）交给 gunzip 解出；stored（method 0）
# 直接 dd。由此任何 OpenWrt 都能解包，不必动 opkg。
leN() {
  # $1=偏移 $2=字节数(2|4) $3=文件 → stdout 无符号小端整数
  case "$2" in
    2) od -An -tu2 -j "$1" -N2 "$3" | tr -d ' \n' ;;
    4) od -An -tu4 -j "$1" -N4 "$3" | tr -d ' \n' ;;
  esac
}

emit_le4() {
  # $1=十进制数(0..2^32-1) → stdout 4 个小端字节
  _el_v=$1
  _el_b0=$((_el_v % 256)); _el_v=$((_el_v / 256))
  _el_b1=$((_el_v % 256)); _el_v=$((_el_v / 256))
  _el_b2=$((_el_v % 256)); _el_v=$((_el_v / 256))
  _el_b3=$((_el_v % 256))
  printf "$(printf '\\%03o\\%03o\\%03o\\%03o' "$_el_b0" "$_el_b1" "$_el_b2" "$_el_b3")"
}

shell_unzip() {
  # $1=zip文件 $2=输出目录
  _sz_zip="$1"; _sz_out="$2"
  command -v od >/dev/null 2>&1 || return 1
  command -v gunzip >/dev/null 2>&1 || command -v zcat >/dev/null 2>&1 || return 1
  _sz_size=$(wc -c < "$_sz_zip" | tr -d ' ')
  case "$_sz_size" in ''|*[!0-9]*) return 1 ;; esac
  [ "$_sz_size" -gt 22 ] || return 1

  # ---- EOCD（签名 50 4b 05 06）：在文件尾部 66KB 内找最后一个 ----
  _sz_span=$_sz_size
  [ "$_sz_span" -gt 65558 ] && _sz_span=65558
  _sz_tail_off=$((_sz_size - _sz_span))
  _sz_eocd=$(od -An -v -tx1 -j "$_sz_tail_off" -N "$_sz_span" "$_sz_zip" | awk -v base="$_sz_tail_off" '
    { for (i = 1; i <= NF; i++) { n++; b[n] = $i; o[n] = base + n - 1 } }
    END {
      p = 0
      for (k = 1; k <= n - 3; k++)
        if (b[k] == "50" && b[k+1] == "4b" && b[k+2] == "05" && b[k+3] == "06") p = k
      if (p) print o[p]
    }')
  [ -n "$_sz_eocd" ] || return 1
  _sz_cd_off=$(leN $((_sz_eocd + 16)) 4 "$_sz_zip")
  _sz_nent=$(leN $((_sz_eocd + 10)) 2 "$_sz_zip")
  case "$_sz_cd_off$_sz_nent" in ''|*[!0-9]*) return 1 ;; esac
  [ "$_sz_nent" -gt 0 ] || return 1

  # ---- 逐条目走中央目录（签名 50 4b 01 02 = 33639248）----
  _sz_p=$_sz_cd_off
  _sz_i=0
  while [ "$_sz_i" -lt "$_sz_nent" ]; do
    _sz_sig=$(leN "$_sz_p" 4 "$_sz_zip")
    [ "$_sz_sig" = "33639248" ] || return 1
    _sz_method=$(leN $((_sz_p + 10)) 2 "$_sz_zip")
    _sz_crc=$(leN $((_sz_p + 16)) 4 "$_sz_zip")
    _sz_csize=$(leN $((_sz_p + 20)) 4 "$_sz_zip")
    _sz_usize=$(leN $((_sz_p + 24)) 4 "$_sz_zip")
    _sz_nlen=$(leN $((_sz_p + 28)) 2 "$_sz_zip")
    _sz_elen=$(leN $((_sz_p + 30)) 2 "$_sz_zip")
    _sz_clen=$(leN $((_sz_p + 32)) 2 "$_sz_zip")
    _sz_lho=$(leN $((_sz_p + 42)) 4 "$_sz_zip")
    case "$_sz_method$_sz_csize$_sz_usize$_sz_nlen$_sz_lho" in ''|*[!0-9]*) return 1 ;; esac
    _sz_name=$(dd if="$_sz_zip" bs=1 skip=$((_sz_p + 46)) count="$_sz_nlen" 2>/dev/null)
    # 本地头 30 字节固定区，名字/扩展长度可能与中央目录不同，必须现场读
    _sz_lnlen=$(leN $((_sz_lho + 26)) 2 "$_sz_zip")
    _sz_lelen=$(leN $((_sz_lho + 28)) 2 "$_sz_zip")
    case "$_sz_lnlen$_sz_lelen" in ''|*[!0-9]*) return 1 ;; esac
    _sz_data=$((_sz_lho + 30 + _sz_lnlen + _sz_lelen))

    if [ -n "$_sz_name" ]; then
      case "$_sz_name" in
        */)  # 目录条目
          mkdir -p "$_sz_out/$_sz_name" 2>/dev/null ;;
        *)   # 文件条目
          _sz_dest="$_sz_out/$_sz_name"
          mkdir -p "${_sz_dest%/*}" 2>/dev/null
          if [ "$_sz_method" = "0" ]; then
            dd if="$_sz_zip" of="$_sz_dest" bs=1 skip="$_sz_data" count="$_sz_csize" 2>/dev/null || return 1
          elif [ "$_sz_method" = "8" ]; then
            # 裸 deflate → gzip 容器（头固定，尾部 CRC32 + 原长度均小端）
            _sz_gz="$_sz_out/.su.gz"
            printf '\037\213\010\000\000\000\000\000\000\003' > "$_sz_gz"
            dd if="$_sz_zip" bs=1 skip="$_sz_data" count="$_sz_csize" 2>/dev/null >> "$_sz_gz"
            emit_le4 "$_sz_crc" >> "$_sz_gz"
            emit_le4 "$_sz_usize" >> "$_sz_gz"
            if command -v gunzip >/dev/null 2>&1; then
              gunzip -c "$_sz_gz" > "$_sz_dest" 2>/dev/null
            else
              zcat "$_sz_gz" > "$_sz_dest" 2>/dev/null
            fi
            _sz_rc=$?
            rm -f "$_sz_gz"
            [ "$_sz_rc" = "0" ] || { rm -f "$_sz_dest"; return 1; }
          else
            return 1   # 不认识的压缩方法
          fi ;;
      esac
    fi
    _sz_p=$((_sz_p + 46 + _sz_nlen + _sz_elen + _sz_clen))
    _sz_i=$((_sz_i + 1))
  done
  return 0
}

# zip 解包层层兜底：
#   1) unzip（Info-ZIP） 2) busybox unzip  3) 纯 shell 解包（零依赖，必成）
#   4) 包管理器装 unzip 后再解  5) 失败
try_extract_zip() {
  # $1=zip $2=目标目录
  if command -v unzip >/dev/null 2>&1; then
    unzip -o -q "$1" -d "$2" 2>/dev/null && return 0
  fi
  if command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx unzip; then
    busybox unzip -o -q "$1" -d "$2" 2>/dev/null && return 0
  fi
  if shell_unzip "$1" "$2"; then
    return 0
  fi
  warn "内置解包未成功，尝试通过包管理器安装 unzip"
  if command -v opkg >/dev/null 2>&1; then
    info "opkg update && opkg install unzip …"
    opkg update </dev/null >/dev/null 2>&1
    opkg install unzip </dev/null >/dev/null 2>&1
    if command -v unzip >/dev/null 2>&1 && unzip -o -q "$1" -d "$2" 2>/dev/null; then
      return 0
    fi
  fi
  if command -v apk >/dev/null 2>&1; then
    info "apk add unzip …"
    apk add --no-cache unzip </dev/null >/dev/null 2>&1
    if command -v unzip >/dev/null 2>&1 && unzip -o -q "$1" -d "$2" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

# 镜像链抓取：GitHub 资源按「镜像 → 直连兜底」逐个尝试；非 GitHub 地址直连。
# 成功把链路记进 $2.used；失败清掉残文件。
# $3=最长等待秒（缺省 300） $4=内容类型（缺省 any，见 valid_payload）
fetch_via_mirror() {
  _fm_url="$1"; _fm_out="$2"; _fm_t="${3:-300}"; _fm_kind="${4:-any}"
  rm -f "$_fm_out" "$_fm_out.used"
  _fm_try() {
    # $1=完整URL $2=链路描述
    http_get "$1" "$_fm_out" "$_fm_t" || { rm -f "$_fm_out"; return 1; }
    if [ "$_fm_kind" != "any" ] && ! valid_payload "$_fm_out" "$_fm_kind"; then
      info "  内容校验未通过（$2 返回的不是有效 $_fm_kind），换下一条"
      rm -f "$_fm_out"; return 1
    fi
    [ -s "$_fm_out" ] || { rm -f "$_fm_out"; return 1; }
    return 0
  }
  if is_github_url "$_fm_url"; then
    _fm_ok=""
    for _fm_pre in $MIRRORS; do
      [ -n "$_fm_pre" ] || continue
      info "尝试加速镜像 ${_fm_pre}"
      if _fm_try "${_fm_pre}${_fm_url}" "加速镜像 ${_fm_pre}"; then
        _fm_ok="加速镜像 ${_fm_pre}"
        break
      fi
      rm -f "$_fm_out"
    done
    if [ -z "$_fm_ok" ]; then
      info "镜像均不可用，兜底直连 GitHub"
      if _fm_try "$_fm_url" "直连 GitHub"; then
        _fm_ok="直连 GitHub"
      else
        rm -f "$_fm_out"; return 1
      fi
    fi
  else
    info "直连下载 ${_fm_url}"
    _fm_try "$_fm_url" "直连" || { rm -f "$_fm_out"; return 1; }
    _fm_ok="直连"
  fi
  printf '%s\n' "$_fm_ok" > "$_fm_out.used"
  return 0
}

# update.json 字段提取：$1=文件 $2=键名 → stdout 字符串值（取不到输出空）
json_str_field() {
  _jsf_re='s/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
  sed -n "$_jsf_re" "$1" 2>/dev/null | head -1
}

# 剥掉 update.json zipUrl 里可能自带的镜像前缀，还原 GitHub 原始地址
canonical_github_url() {
  printf '%s\n' "$1" | sed -n 's|.*\(https://github\.com/[^" ]*\)|\1|p'
}

# releases/latest 页面 HTML → stdout: 最新资产名（mihomo-box-YYYYMMDD-HHMM.zip）
parse_asset_name() {
  grep -o 'mihomo-box-[0-9]\{8\}-[0-9]\{4\}\.zip' 2>/dev/null | head -1
}

# ============================================================
# 安装包获取：镜像链下载，直连兜底
#   默认路线（依次降级）：
#     1. update.json 里的 Release 资产 zip（与 Android 版同源）
#     2. releases/latest 页面解析出的资产 zip
#   （仓库只托管 update.json / CHANGELOG / README，模块内容仅存在于 Release 资产；
#     解压不依赖 unzip —— 见 try_extract_zip 的层层兜底）
# 成功后设置 PKG_FILE / PKG_KIND(zip|tar.gz)
# ============================================================
obtain_package() {
  PKG_FILE=""; PKG_KIND=""

  if [ -n "$ARG_ZIP" ]; then
    [ -f "$ARG_ZIP" ] || die "本地安装包不存在: $ARG_ZIP"
    PKG_FILE="$ARG_ZIP"; PKG_KIND=zip
    info "使用本地安装包: $ARG_ZIP"
    return 0
  fi

  if [ -n "$ARG_URL" ]; then
    case "$ARG_URL" in
      *.tar.gz|*.tgz) PKG_KIND=tar.gz ;;
      *)              PKG_KIND=zip ;;
    esac
    step "下载安装包（自定义地址）"
    PKG_FILE="$STAGE/pkg.$PKG_KIND"
    fetch_via_mirror "$ARG_URL" "$PKG_FILE" 300 "$PKG_KIND" || die "安装包下载失败: $ARG_URL"
    ok "下载完成（$(wc -c < "$PKG_FILE" | tr -d ' ') 字节，$(cat "$PKG_FILE.used" 2>/dev/null)）"
    return 0
  fi

  # ---- 1. 版本信息（update.json）----
  PKG_VER=""; ZIP_URL=""
  UJ="$STAGE/update.json"
  step "获取版本信息（update.json）"
  if fetch_via_mirror "$UPDATE_JSON_URL" "$UJ" 20 json; then
    PKG_VER=$(json_str_field "$UJ" version)
    ZIP_URL=$(canonical_github_url "$(json_str_field "$UJ" zipUrl)")
    ok "最新版本: ${PKG_VER:-未知}（$(cat "$UJ.used" 2>/dev/null)）"
  else
    warn "update.json 获取失败，改从 Release 页面解析"
  fi

  # ---- 2. Release 资产 zip ----
  step "下载 Mihomo Box 发布包（Release zip）"
  PKG_KIND=zip
  PKG_FILE="$STAGE/pkg.zip"
  _ob_ok=0
  for _ob_u in \
    "$ZIP_URL" \
    "$( [ -n "$PKG_VER" ] && echo "https://github.com/$REPO/releases/latest/download/mihomo-box-$PKG_VER.zip" )"
  do
    [ -n "$_ob_u" ] || continue
    info "地址: $_ob_u"
    if fetch_via_mirror "$_ob_u" "$PKG_FILE" 300 zip; then
      ok "下载完成（$(wc -c < "$PKG_FILE" | tr -d ' ') 字节，$(cat "$PKG_FILE.used" 2>/dev/null)）"
      _ob_ok=1
      break
    fi
    warn "该地址失败，换下一个"
  done
  if [ "$_ob_ok" != "1" ]; then
    # 解析 releases/latest 页面拿资产名
    _ob_page="$STAGE/releases.html"
    if fetch_via_mirror "$LATEST_PAGE" "$_ob_page" 30; then
      _ob_asset=$(parse_asset_name < "$_ob_page")
      if [ -n "$_ob_asset" ]; then
        info "地址: https://github.com/$REPO/releases/latest/download/$_ob_asset"
        fetch_via_mirror "https://github.com/$REPO/releases/latest/download/$_ob_asset" "$PKG_FILE" 300 zip && {
          ok "下载完成（$(wc -c < "$PKG_FILE" | tr -d ' ') 字节，$(cat "$PKG_FILE.used" 2>/dev/null)）"
          _ob_ok=1
        }
      fi
    fi
  fi
  [ "$_ob_ok" = "1" ] && return 0

  # 全部通道失败只能报错或改走离线安装
  die "Release 安装包下载失败（所有镜像与直连均不可用）。
       可稍后重试；或在能下载的机器上打开 $LATEST_PAGE
       取 mihomo-box-*.zip，传到路由器后用 --zip 离线安装"
}

# $1=包文件 $2=解压目标目录 $3=类型(zip|tar.gz)
# 解压后定位包根目录（Release zip 在根上；自定义 tar.gz 包可能多一层剥离目录）→ PKG_ROOT
extract_package() {
  _ex_stage="$2"
  rm -rf "$_ex_stage"; mkdir -p "$_ex_stage" || return 1
  case "$3" in
    zip)
      try_extract_zip "$1" "$_ex_stage" || return 1 ;;
    tar.gz)
      tar -xzf "$1" -C "$_ex_stage" || return 1 ;;
  esac
  if [ -f "$_ex_stage/module.prop" ]; then
    PKG_ROOT="$_ex_stage"
  else
    _ex_m=$(find "$_ex_stage" -name module.prop 2>/dev/null | head -1)
    [ -n "$_ex_m" ] || return 1
    PKG_ROOT=${_ex_m%/module.prop}
  fi
  [ -f "$PKG_ROOT/scripts/mihomo.sh" ] || return 1
  [ -f "$PKG_ROOT/webroot/ui/cgi-bin/exec.sh" ] || return 1
  [ -f "$PKG_ROOT/webroot/ui/index.html" ] || return 1
  return 0
}

# 源码包路线的清理：剔除打包时本就不入包的开发文件（对齐 build.sh 的剔除清单），
# 保证源码包安装结果与 Release zip 一致
cleanup_pkg_root() {
  rm -rf "$PKG_ROOT/tests" "$PKG_ROOT/.github" "$PKG_ROOT/node_modules" \
         "$PKG_ROOT/.gitignore" "$PKG_ROOT/.gitattributes" 2>/dev/null
  rm -f "$PKG_ROOT/update.json" "$PKG_ROOT/CHANGELOG.md" "$PKG_ROOT/UPDATE.md" 2>/dev/null
  find "$PKG_ROOT" -name '*.zip' -type f -delete 2>/dev/null
  find "$PKG_ROOT" -type d \( -name '__pycache__' -o -name node_modules \) -exec rm -rf {} + 2>/dev/null
  return 0
}

# ============================================================
# 递归清残：删除安装目录中「不在本次包内」的旧文件（对齐 Android 版 customize.sh）。
# 用户数据与模块标记不删：config.yaml / module-settings.conf / core / run /
# proxies / rules / backup / disable / remove / update / 卸载脚本
# ============================================================
stale_clean() {
  _sc_list="$STAGE/manifest.txt"
  ( cd "$PKG_ROOT" && find . -type f | sed 's|^\./||' ) > "$_sc_list"
  _sc_n=0
  for _sc_f in $(find "$INSTALL_DIR" -type f 2>/dev/null); do
    _sc_r=${_sc_f#$INSTALL_DIR/}
    case "$_sc_r" in
      disable|remove|update|skip_test|uninstall-openwrt.sh|config.yaml|module-settings.conf|core/*|run/*|proxies/*|rules/*|backup/*)
        continue ;;
    esac
    grep -qxF "$_sc_r" "$_sc_list" 2>/dev/null || { rm -f "$_sc_f"; _sc_n=$((_sc_n + 1)); }
  done
  find "$INSTALL_DIR" -mindepth 1 -type d -empty -delete 2>/dev/null
  [ "$_sc_n" -gt 0 ] && ok "已删除包外旧文件 $_sc_n 个（含子目录残留）"
  return 0
}

# ============================================================
# 路径适配：Android 的模块目录 / 工作目录两个路径，OpenWrt 上合并为 $INSTALL_DIR。
# 长串先替换（/data/adb/modules/mihomo_box），避免被短串（/data/adb/mihomo_box）误伤。
# 除此之外脚本内容不动 —— 其余部分保持与 Android 一样。
# ============================================================
patch_paths() {
  step "适配安装路径（Android 路径 → $INSTALL_DIR）"
  _pp_n=0
  for _pp_f in $(grep -rl -e '/data/adb/modules/mihomo_box' -e '/data/adb/mihomo_box' "$INSTALL_DIR" 2>/dev/null); do
    case "$_pp_f" in
      *.dex|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.woff2|*.sha256) continue ;;
      # 用户数据与运行期产物永不进路径重写：core/ 里的内核二进制动辄 60MB+，
      # 内部常整 MB 无换行，busybox sed 逐字节啃「超长行」再回写几十 MB，
      # 真机上就是安装永久停在「适配安装路径」这一步（等多久都不动）
      */core/*|*/run/*|*/backup/*) continue ;;
    esac
    _pp_sz=$(wc -c < "$_pp_f" 2>/dev/null | tr -d ' ')
    case "$_pp_sz" in ''|*[!0-9]*) continue ;; esac
    [ "$_pp_sz" -gt 2097152 ] && continue   # 模块文本文件都远小于此；超大一律当二进制跳过
    mkdir -p "$INSTALL_DIR/run" 2>/dev/null
    printf '%s 路径重写 %s\n' "$(date '+%m-%d %H:%M:%S' 2>/dev/null)" "$_pp_f" >> "$INSTALL_DIR/run/install.trace" 2>/dev/null
    sed -i \
      -e "s|/data/adb/modules/mihomo_box|$INSTALL_DIR|g" \
      -e "s|/data/adb/mihomo_box|$INSTALL_DIR|g" \
      "$_pp_f" 2>/dev/null && _pp_n=$((_pp_n + 1))
  done
  # 模块描述改写（对应 Android 版 customize.sh 识别 root 方案后重写描述里的工具名）
  [ -f "$INSTALL_DIR/module.prop" ] && \
    sed -i 's/for KernelSU Next/for OpenWrt/; s/for KernelSU/for OpenWrt/; s/for APatch/for OpenWrt/; s/for Magisk/for OpenWrt/' \
      "$INSTALL_DIR/module.prop" 2>/dev/null
  # shebang 里的 Android shell 路径改写为 /bin/sh：
  # busybox httpd 靠 httpd.conf 的 *.sh:解释器 启动 CGI 不看 shebang，但 uhttpd
  # 后端无解释器匹配时会按 shebang 直接 exec（#!/system/bin/sh 在 OpenWrt 不存在）
  for _pp_s in $(find "$INSTALL_DIR" -type f -name '*.sh' 2>/dev/null); do
    sed -i '1s|^#!/system/bin/sh|#!/bin/sh|' "$_pp_s" 2>/dev/null
  done
  ok "已改写 $_pp_n 个文件中的安装路径"

  # —— WebUI 渲染时序补丁（慢设备放大前端竞态；Android 快设备上被速度掩盖）——
  # 原逻辑：status 结构变化后只重绘概览页，其它页仅作废「落地缓存」等下次切页重建；
  # 而内核/工具/代理页的空数据预热构建会赶在 status 返回之前落地（路由器上 status 要
  # 跑数秒，窗口极大）。两件事叠加＝刷新网页后内核页永远停在「未安装」（后端明明
  # exists=1，却没人再画一遍）。这里把「status 结构变化 → 重绘」扩展到当前停留的
  # 任意页（编辑/滚动中不打扰）。幂等：已应用则原样跳过。
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

# ============================================================
# 工作目录初始化 —— 与 Android 版 customize.sh 逐行对应：
# 首次安装写默认配置，升级只补缺失文件 / 缺失键，用户配置一律保留
# ============================================================
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

  if [ ! -f "$INSTALL_DIR/proxies/钉钉直连.yaml" ]; then
    cp "$INSTALL_DIR/data/proxies/钉钉直连.yaml" "$INSTALL_DIR/proxies/钉钉直连.yaml" 2>/dev/null
    ok "已添加 钉钉直连.yaml"
  fi

  # 默认配置声明了「非免节点」本地订阅（./proxies/非免节点.txt），缺文件面板会挂红，
  # 随包放一份空骨架（与 Android 版相同）
  if [ ! -f "$INSTALL_DIR/proxies/非免节点.txt" ]; then
    cp "$INSTALL_DIR/data/proxies/非免节点.txt" "$INSTALL_DIR/proxies/非免节点.txt" 2>/dev/null
    ok "已添加 非免节点.txt（空骨架，自行填入节点）"
  fi

  if [ ! -f "$INSTALL_DIR/module-settings.conf" ]; then
    cat > "$INSTALL_DIR/module-settings.conf" <<'EOF'
core=jieluojun
autostart=true
mirror=direct
webui=true
EOF
    ok "已写入默认模块设置（远程访问默认开启：监听 0.0.0.0）"
  else
    info "检测到已有模块设置，保留"
    # 老版本升级补默认值：只在键完全不存在时补，不覆盖用户选择（与 Android 版相同）
    if ! grep -qE '^webui=' "$INSTALL_DIR/module-settings.conf" 2>/dev/null; then
      echo "webui=true" >> "$INSTALL_DIR/module-settings.conf"
      ok "已为旧配置补上远程访问默认值"
    fi
  fi

  chmod 755 "$INSTALL_DIR/scripts/mihomo.sh" 2>/dev/null
  chmod 755 "$INSTALL_DIR/webroot/ui/cgi-bin/exec.sh" 2>/dev/null
  chmod 755 "$INSTALL_DIR/service.sh" "$INSTALL_DIR/post-fs-data.sh" \
            "$INSTALL_DIR/action.sh" "$INSTALL_DIR/uninstall.sh" 2>/dev/null
  chmod 644 "$INSTALL_DIR/config.yaml" "$INSTALL_DIR/module-settings.conf" \
            "$INSTALL_DIR/proxies/钉钉直连.yaml" "$INSTALL_DIR/proxies/非免节点.txt" 2>/dev/null

  # 清理模块描述状态缓存（热更新必需，与 Android 版相同）：
  # 旧缓存会让状态前缀 [🟢]/[🔴]/[⚪] 丢失，收尾由 syncdesc 按新 module.prop 重建
  rm -f "$INSTALL_DIR/run/modstate.prev" "$INSTALL_DIR/run/desc.base" \
        "$INSTALL_DIR/run/prop.tpl" 2>/dev/null
  rmdir "$INSTALL_DIR/run/desc.lock" 2>/dev/null
  return 0
}

# ============================================================
# 面板缓存打点 —— 与 Android 版 customize.sh 完全一致：
# 「版本戳.刷入时刻」写进 index.html 资源戳 / sw.js INSTALL_STAMP / install.stamp，
# 每次安装都作废旧缓存，反复装同一个包也一样
# ============================================================
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
  # 静态文件 mtime 归零到本次安装时刻（busybox httpd 无缓存头，靠启发式新鲜期，
  # 旧时间戳会让更新后仍读到旧面板 —— 与 Android 版相同处理）
  find "$INSTALL_DIR/webroot/ui" -type f -exec touch {} + 2>/dev/null
  [ -d "$INSTALL_DIR/webroot" ] && find "$INSTALL_DIR/webroot" -maxdepth 1 -type f -exec touch {} + 2>/dev/null
  ok "刷入指纹 $_sp_stamp（旧缓存将在下次打开面板时自动清除）"
}

# 生成独立卸载脚本（随安装留存，更新时受 stale_clean 白名单保护）
write_uninstall_helper() {
  cat > "$INSTALL_DIR/uninstall-openwrt.sh" <<EOF
#!/bin/sh
# Mihomo Box · OpenWrt 卸载脚本（由 mihomo-box-openwrt-install.sh 生成）
# 用法： sh $INSTALL_DIR/uninstall-openwrt.sh
INITD=$INITD
[ -x "\$INITD" ] && { "\$INITD" stop </dev/null >/dev/null 2>&1; "\$INITD" disable </dev/null >/dev/null 2>&1; }
if [ -f "$INSTALL_DIR/scripts/mihomo.sh" ]; then
  sh "$INSTALL_DIR/scripts/mihomo.sh" switch-stop </dev/null >/dev/null 2>&1
  sh "$INSTALL_DIR/scripts/mihomo.sh" stop </dev/null >/dev/null 2>&1
  sh "$INSTALL_DIR/scripts/mihomo.sh" webui-stop </dev/null >/dev/null 2>&1
fi
rm -f "\$INITD"
# 移除兼容垫片 httpd/nohup/base64/od/usleep/sleep/curl/wget（只删自动生成的，不碰系统原有文件）
for _hp in $HTTPD_SHIM $COMPAT_DIR/nohup $COMPAT_DIR/base64 $COMPAT_DIR/od $COMPAT_DIR/usleep $COMPAT_DIR/sleep $COMPAT_DIR/curl $COMPAT_DIR/wget \$(command -v httpd 2>/dev/null) \$(command -v nohup 2>/dev/null) \$(command -v base64 2>/dev/null) \$(command -v od 2>/dev/null) \$(command -v usleep 2>/dev/null) \$(command -v sleep 2>/dev/null) \$(command -v curl 2>/dev/null) \$(command -v wget 2>/dev/null); do
  [ -f "\$_hp" ] && grep -q "$SHIM_MARKER" "\$_hp" 2>/dev/null && rm -f "\$_hp"
done
rm -rf "$INSTALL_DIR"
# 兜底：stop 的后台清扫进程可能稍后才落盘，二次清理防止目录复活
sleep 1
rm -rf "$INSTALL_DIR" 2>/dev/null
echo "✅ Mihomo Box 已卸载（$INSTALL_DIR 已删除）"
EOF
  chmod 755 "$INSTALL_DIR/uninstall-openwrt.sh"
}

# ============================================================
# 开机自启（对应 Android 版 service.sh）：
#   START=99 —— 等系统与网络就绪后由 boot 一次性拉起；
#   不设 procd 守护 —— 与 Android 版一致，内核 / 开关监听 / 面板服务
#   各自 nohup 常驻，本脚本只负责开机触发一次
# ============================================================
write_initd() {
  if [ ! -f /etc/rc.common ]; then
    warn "未找到 /etc/rc.common（非 OpenWrt 环境？），跳过开机自启配置"
    return 0
  fi
  step "写入开机自启服务 $INITD"
  cat > "$INITD" <<EOF
#!/bin/sh /etc/rc.common
# Mihomo Box 开机自启（由 mihomo-box-openwrt-install.sh 生成，与 Android 版 service.sh 同流程）
START=99
STOP=10

start() {
	# 与 Android 版 service.sh 相同：等网络就绪（最多约 90 秒）→ boot
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

# ============================================================
# 系统依赖包（TUN / Tproxy）—— 自动识别包管理器（opkg / apk）与防火墙后端
# mihomo.sh 的 Tproxy 同步 / 热点转发用 iptables 语法（tproxy-sync / tunhs）：
# fw4+nftables 系统经 iptables-nft 兼容层执行，fw3/legacy 直接执行。能力已具备
# 则整组跳过；缺什么装什么（只装缺失包，不重复安装）。
#   · TUN:      kmod-tun（/dev/net/tun 已存在则跳过）
#   · Tproxy:   TPROXY 目标 + socket 匹配 + owner 匹配（tproxy_probe 硬要求）
#               iptables 防火墙 → iptables-mod-tproxy kmod-ipt-tproxy iptables-mod-extra
#               nftables 防火墙 → 另加 kmod-nft-tproxy（原生 tproxy 内核支持）
#               且 iptables/ip6tables 命令缺失时装 iptables-nft / ip6tables-nft
#   · 策略路由: ip 命令缺失时 ip-full（tproxy/tunhs 的 ip rule/route table 需要）
# 卸载不移除这些系统包（属路由器通用能力，留给其他组件复用）。
# ============================================================

PKG_MGR=""
FIREWALL=""

detect_pkg_mgr() {
  # OpenWrt ≤24.10 用 opkg；25.12+ / ImmortalWrt 25.12 起默认 apk
  if command -v apk >/dev/null 2>&1 && [ -d /etc/apk ]; then PKG_MGR=apk
  elif command -v opkg >/dev/null 2>&1; then PKG_MGR=opkg
  elif command -v apk >/dev/null 2>&1; then PKG_MGR=apk
  else PKG_MGR=""; fi
  [ -n "$PKG_MGR" ]
}

detect_firewall() {
  # fw4 = firewall4/nftables（22.03+ 默认）；fw3 = 旧 iptables 防火墙
  if command -v fw4 >/dev/null 2>&1 || [ -x /sbin/fw4 ]; then FIREWALL=nftables
  elif command -v fw3 >/dev/null 2>&1 || [ -x /sbin/fw3 ]; then FIREWALL=iptables
  elif command -v nft >/dev/null 2>&1 && ! command -v iptables >/dev/null 2>&1; then FIREWALL=nftables
  elif command -v iptables >/dev/null 2>&1 && ! command -v nft >/dev/null 2>&1; then FIREWALL=iptables
  else FIREWALL=nftables   # 22.03+ 默认 fw4，取保守值
  fi
}

pkg_is_installed() {
  case "$PKG_MGR" in
    opkg) opkg status "$1" 2>/dev/null | grep -q '^Status: install' ;;
    apk)  apk info -e "$1" </dev/null >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

_pkg_updated=""
pkg_install_one() {
  # $1=包名 → 0=已装或装好；索引过期时自动 update 后重试一次
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

# Tproxy 能力探测（与 mihomo.sh tproxy_probe 同款口径：TPROXY + socket + owner
# 三件套 + ip 命令，临时链探测完毕即删）——全过则整组依赖视为已就绪；
# 失败时把缺项写进 _DP_MISS，告警可直说缺什么
dep_tproxy_cap_ok() {
  _DP_MISS=""
  command -v iptables >/dev/null 2>&1 || { _DP_MISS="iptables 命令"; return 1; }
  command -v ip >/dev/null 2>&1 || { _DP_MISS="ip 命令"; return 1; }
  iptables -w -t mangle -N mihomo_dep_probe 2>/dev/null || { _DP_MISS="mangle 表建链（iptables 与内核兼容层）"; return 1; }
  _dp_ok=1
  _DP_MISS=""
  iptables -w -t mangle -A mihomo_dep_probe -p tcp -j TPROXY --on-ip 127.0.0.1 \
    --on-port 1 --tproxy-mark 1 2>/dev/null || { _dp_ok=0; _DP_MISS="$_DP_MISS TPROXY目标"; }
  iptables -w -t mangle -A mihomo_dep_probe -p tcp \
    -m socket --transparent -j RETURN 2>/dev/null || { _dp_ok=0; _DP_MISS="$_DP_MISS socket匹配"; }
  iptables -w -t mangle -A mihomo_dep_probe -m owner \
    --uid-owner 0 -j RETURN 2>/dev/null || { _dp_ok=0; _DP_MISS="$_DP_MISS owner匹配"; }
  iptables -w -t mangle -F mihomo_dep_probe 2>/dev/null
  iptables -w -t mangle -X mihomo_dep_probe 2>/dev/null
  [ "$_dp_ok" = "1" ]
}

ensure_system_deps() {
  detect_pkg_mgr || {
    warn "未找到包管理器（opkg / apk），跳过 TUN / Tproxy 依赖检查"
    return 0
  }
  detect_firewall
  step "系统依赖检查（TUN / Tproxy · 包管理器 $PKG_MGR · 防火墙 $FIREWALL）"

  # ---- 1) TUN（/dev/net/tun 是唯一硬指标，存在即跳过）----
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

  # ---- 2) 策略路由 ip 命令（tproxy / tunhs 的 ip rule、路由表 8995 需要）----
  if command -v ip >/dev/null 2>&1; then
    ok "ip: 系统已有，跳过"
  else
    pkg_install_one ip-full
  fi

  # ---- 3) Tproxy 能力（TPROXY + socket + owner，缺则按防火墙后端补齐）----
  if dep_tproxy_cap_ok; then
    ok "Tproxy 能力已就绪（TPROXY / socket / owner），跳过"
    return 0
  fi
  _dp_list=""
  # iptables / ip6tables 命令是 mihomo.sh tproxy-sync 的语法载体，缺失必须补
  if ! command -v iptables >/dev/null 2>&1; then
    if [ "$FIREWALL" = "nftables" ]; then _dp_list="$_dp_list iptables-nft"
    else _dp_list="$_dp_list iptables"; fi
  fi
  if ! command -v ip6tables >/dev/null 2>&1; then
    if [ "$FIREWALL" = "nftables" ]; then _dp_list="$_dp_list ip6tables-nft"
    else _dp_list="$_dp_list ip6tables"; fi
  fi
  # nftables 防火墙加装原生 tproxy 内核支持（用户 nft 规则 / LuCI 场景直接受益）
  [ "$FIREWALL" = "nftables" ] && _dp_list="$_dp_list kmod-nft-tproxy"
  # 三件套：TPROXY 目标 + socket 匹配（iptables-mod-tproxy）；owner 匹配（mod-extra）
  _dp_list="$_dp_list iptables-mod-tproxy kmod-ipt-tproxy iptables-mod-extra"
  for _dp_p in $_dp_list; do
    pkg_install_one "$_dp_p"
  done
  if dep_tproxy_cap_ok; then
    ok "Tproxy 能力就绪（TPROXY / socket / owner）"
  else
    warn "Tproxy 能力探测未通过（缺：${_DP_MISS:-未知}）——透明代理暂不可用，面板可正常安装"
    warn "排查：$PKG_MGR install iptables-mod-tproxy iptables-mod-extra；确认内核含 xt_TPROXY / xt_socket / xt_owner"
  fi
  return 0
}

# ============================================================
# 系统兼容垫片（OpenWrt 特有，模块脚本保持与 Android 一样不改动）
# ImmortalWrt / OpenWrt 的精简 busybox 默认不编入这些小工具（上游 Config-defaults：
# httpd=n nohup=n base64=n od=n usleep=n stat=n），Android 靠 busybox-ndk 全都有。
# 这里按缺失情况生成兼容垫片，mihomo.sh / exec.sh 原样可用：
#   1) httpd  —— 面板服务（busybox httpd 语法 → uhttpd，LuCI 标配全系自带）
#   2) nohup  —— 面板 / 开关监听 / 内核 / 后台下载共 7 处拉起常驻进程都用它
#   3) base64 —— CGI 执行桥协议与配置快照的编解码硬依赖
#   4) od     —— 内核下载的 gzip/ELF 魔数校验（缺了会「换镜像无限重下」）
# ============================================================

# 垫片通用写入：$1=路径 $2=用途描述；已是自家垫片则原地更新，别人的文件不覆盖
shim_target_ok() {
  # $1=目标路径 → 0=可写（不存在或是自家垫片）
  [ -e "$1" ] || return 0
  grep -q "$SHIM_MARKER" "$1" 2>/dev/null
}

write_shim_head() {
  # $1=路径 $2=用途（写入文件头注释）—— 调用方接着往 fd 1 输出正文
  printf '%s\n%s\n%s\n' \
    "#!/bin/sh" \
    "# $SHIM_MARKER-$2 —— $2 兼容垫片（由 mihomo-box-openwrt-install.sh 生成）" \
    "# 精简 busybox 无 $2 小程序时的等价实现；系统自带 $2 时本文件不会生成。"
}

# ---- 1) httpd 适配器 ----
install_httpd_shim() {
  if command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx httpd; then
    info "系统 busybox 自带 httpd 小程序，面板服务直接使用（无需适配）"
    return 0
  fi
  _hs_target="$HTTPD_SHIM"
  _hs_cur=$(command -v httpd 2>/dev/null)
  if [ -n "$_hs_cur" ]; then
    if grep -q "$SHIM_MARKER-httpd" "$_hs_cur" 2>/dev/null; then
      _hs_target="$_hs_cur"   # 已是本适配器，原地更新
    else
      info "系统已有 httpd（$_hs_cur），面板服务直接使用（不覆盖）"
      return 0
    fi
  fi
  if ! command -v uhttpd >/dev/null 2>&1; then
    warn "系统既无 busybox httpd 也未找到 uhttpd —— 面板服务将无法启动"
    warn "请先安装 uhttpd（opkg install uhttpd / apk add uhttpd），再重跑本脚本"
    return 0
  fi
  case "$_hs_target" in
    */*) mkdir -p "${_hs_target%/*}" 2>/dev/null ;;
  esac
  {
    write_shim_head "$_hs_target" httpd
    printf '%s\n' \
      "# mihomo.sh 以 busybox httpd 语法启动面板：httpd -f -p bind:port -h 站点根 -c conf" \
      "# uhttpd 与之同构（-f/-p/-h/-c 同义，conf 里 \`*.sh:解释器\` 行同语法），直接透传。" \
      "exec uhttpd \"\$@\""
  } > "$_hs_target"
  chmod 755 "$_hs_target" 2>/dev/null || { warn "无法写入 $_hs_target"; return 1; }
  ok "已安装面板 httpd 适配器: $_hs_target（uhttpd 后端，busybox httpd 兼容语法）"
  return 0
}

# ---- 2) nohup 垫片 ----
ensure_nohup() {
  if command -v nohup >/dev/null 2>&1 && ! grep -q "$SHIM_MARKER-nohup" "$(command -v nohup)" 2>/dev/null; then
    info "系统已有 nohup，无需适配"
    return 0
  fi
  _nh_target="$COMPAT_DIR/nohup"
  _nh_cur=$(command -v nohup 2>/dev/null)
  [ -n "$_nh_cur" ] && grep -q "$SHIM_MARKER-nohup" "$_nh_cur" 2>/dev/null && _nh_target="$_nh_cur"
  mkdir -p "${_nh_target%/*}" 2>/dev/null
  {
    write_shim_head "$_nh_target" nohup
    printf '%s\n' \
      "# POSIX nohup 最小语义：忽略 SIGHUP（忽略态经 exec 被目标进程继承），其余还原命令。" \
      "# mihomo.sh 7 处 `nohup cmd >> log 2>&1 &` 的输出重定向由调用方自行处理。" \
      "trap '' HUP" \
      "exec \"\$@\""
  } > "$_nh_target"
  chmod 755 "$_nh_target" 2>/dev/null || { warn "无法写入 $_nh_target"; return 1; }
  ok "已安装 nohup 适配器: $_nh_target（SIGHUP 免疫，等价 busybox nohup）"
  return 0
}

# ---- 3) base64 垫片（awk 实现，编码/解码与 GNU base64 互操作）----
ensure_base64() {
  if command -v base64 >/dev/null 2>&1; then
    if grep -q "$SHIM_MARKER-base64" "$(command -v base64)" 2>/dev/null; then
      : # 已是自家垫片，走下方原地更新
    else
      info "系统已有 base64，无需适配"
      return 0
    fi
  fi
  _b6_target="$COMPAT_DIR/base64"
  _b6_cur=$(command -v base64 2>/dev/null)
  [ -n "$_b6_cur" ] && grep -q "$SHIM_MARKER-base64" "$_b6_cur" 2>/dev/null && _b6_target="$_b6_cur"
  mkdir -p "${_b6_target%/*}" 2>/dev/null
  {
    write_shim_head "$_b6_target" base64
    cat <<'SHIMEOF'
# 用法与 busybox base64 最小子集一致：base64 编码 stdin；base64 -d 解码 stdin。
# awk 仅按字节处理（LC_ALL=C），输出为标准 base64 字母表（与 atob/btoa 互通）。
# 限制：编码侧不含 NUL 字节（经 tr 预剔除），文本 / 日志 / 配置场景无感。
mode=enc
case "$1" in
  -d|-D|--decode|--decrypt) mode=dec ;;
esac
if [ "$mode" = dec ]; then
  LC_ALL=C awk '
    BEGIN {
      B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
      for (i = 0; i < 64; i++) dec[substr(B, i + 1, 1)] = i
    }
    { gsub(/[ \t\r\n]/, ""); buf = buf $0
      while (length(buf) >= 4) {
        a = dec[substr(buf, 1, 1)] + 0; b = dec[substr(buf, 2, 1)] + 0
        c1 = substr(buf, 3, 1); d1 = substr(buf, 4, 1); buf = substr(buf, 5)
        c = (c1 == "=") ? 0 : dec[c1] + 0
        d = (d1 == "=") ? 0 : dec[d1] + 0
        printf "%c", a * 4 + int(b / 16)
        if (c1 != "=") printf "%c", (b % 16) * 16 + int(c / 4)
        if (d1 != "=") printf "%c", (c % 4) * 64 + d
      }
    }'
  exit $?
fi
# 编码：先落盘拿换行计数（判定结尾换行），再按 3 字节一组流式编码
_t="/tmp/.mihomo-b64.$$"
tr -d '\000' > "$_t" 2>/dev/null
_n=$(wc -l < "$_t" | tr -d " ")
LC_ALL=C awk -v NLEN="$_n" '
  BEGIN {
    B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    for (i = 1; i < 256; i++) ord[sprintf("%c", i)] = i
    acc = 0; cnt = 0; out = ""
  }
  {
    s = $0
    if (NR <= NLEN) s = s sprintf("%c", 10)
    for (i = 1; i <= length(s); i++) {
      acc = acc * 256 + ord[substr(s, i, 1)]; cnt++
      if (cnt == 3) {
        out = out substr(B, int(acc / 262144) + 1, 1) substr(B, int(acc / 4096) % 64 + 1, 1) \
                   substr(B, int(acc / 64) % 64 + 1, 1) substr(B, acc % 64 + 1, 1)
        acc = 0; cnt = 0
        if (length(out) >= 76) { printf "%s\n", out; out = "" }
      }
    }
  }
  END {
    if (cnt == 1) out = out substr(B, int(acc / 4) + 1, 1) substr(B, acc % 4 * 16 + 1, 1) "=="
    else if (cnt == 2) out = out substr(B, int(acc / 1024) + 1, 1) substr(B, int(acc / 16) % 64 + 1, 1) \
                           substr(B, acc % 16 * 4 + 1, 1) "="
    if (out != "") printf "%s\n", out
  }' < "$_t"
_rc=$?
rm -f "$_t"
exit $_rc
SHIMEOF
  } > "$_b6_target"
  chmod 755 "$_b6_target" 2>/dev/null || { warn "无法写入 $_b6_target"; return 1; }
  ok "已安装 base64 适配器: $_b6_target（awk 实现，编解码与 GNU base64 互通）"
  return 0
}

# ---- 4) od 垫片（读魔数/字节值；内核下载的 gzip/ELF 校验硬依赖）----
# mihomo.sh 用 od 读 gzip 魔数(1f8b08)、ELF 魔数(7f454c46)、ZIP 头 u16/u32
# （内核下载 gzip_decode_checked / gunzip_to / ci_magic，以及安装器 shell_unzip）。
# ImmortalWrt 的 busybox 无 od 小程序（Config-defaults: OD=n）——缺了它，
# 内核每个镜像下载完成后都被判「gzip 文件头无效」，换镜像从头再来，永无止境。
# 实现：优先 busybox hexdump（Config-defaults: HEXDUMP=y，逐字节精确），
# 无 hexdump 时退化为 dd 逐字节取值（精确但有 8192 字节上限，魔数场景足够）。
ensure_od() {
  if command -v od >/dev/null 2>&1 && ! grep -q "$SHIM_MARKER-od" "$(command -v od)" 2>/dev/null; then
    info "系统已有 od，无需适配"
    return 0
  fi
  _od_target="$COMPAT_DIR/od"
  _od_cur=$(command -v od 2>/dev/null)
  [ -n "$_od_cur" ] && grep -q "$SHIM_MARKER-od" "$_od_cur" 2>/dev/null && _od_target="$_od_cur"
  mkdir -p "${_od_target%/*}" 2>/dev/null
  {
    write_shim_head "$_od_target" od
    cat <<'SHIMEOF'
# 用法子集（覆盖 mihomo.sh / 安装器 shell_unzip 的全部调用）：
#   od [-An|-A n] [-v] (-tx1|-t x1|-tu2|-t u2|-tu4|-t u4) [-j N|-jN] [-N N|-NN] [file]
# 输出与 GNU od 等价（调用方均以 tr 去空白取紧凑值）；x1=十六进制字节，
# u2/u4=小端无符号整数（路由器均为小端）。无文件参数或 file=- 时读标准输入。
type=x1; skip=0; cnt=0; file=""
while [ $# -gt 0 ]; do
  case "$1" in
    -An) ;;
    -A) shift ;;
    -v) ;;
    -tx1) type=x1 ;;
    -tu2) type=u2 ;;
    -tu4) type=u4 ;;
    -t) shift
        case "$1" in x1) type=x1;; u2) type=u2;; u4) type=u4;; esac ;;
    -j*) skip="${1#-j}"; [ -n "$skip" ] || { shift; skip="$1"; } ;;
    -N*) cnt="${1#-N}"; [ -n "$cnt" ] || { shift; cnt="$1"; } ;;
    -*) ;;
    -) file="" ;;
    *) file="$1" ;;
  esac
  shift
done
case "$skip" in ''|*[!0-9]*) skip=0 ;; esac
case "$cnt" in ''|*[!0-9]*) cnt=0 ;; esac
# 取十六进制字节流：优先 hexdump（逐字节精确、一次 fork）
hex_stream() {
  _hs_hx=""
  if command -v hexdump >/dev/null 2>&1; then _hs_hx="hexdump"
  else
    for _hs_b in "$(command -v busybox 2>/dev/null)" busybox; do
      [ -n "$_hs_b" ] && [ -x "$_hs_b" ] && "$_hs_b" --list 2>/dev/null | grep -qx hexdump && { _hs_hx="$_hs_b hexdump"; break; }
    done
  fi
  if [ -n "$_hs_hx" ]; then
    set -- $_hs_hx
    if [ "$cnt" -gt 0 ] 2>/dev/null; then
      [ -n "$file" ] && "$@" -v -s "$skip" -n "$cnt" -e '1/1 "%02x "' "$file" \
                     || "$@" -v -s "$skip" -n "$cnt" -e '1/1 "%02x "' -
    else
      [ -n "$file" ] && "$@" -v -s "$skip" -e '1/1 "%02x "' "$file" \
                     || "$@" -v -s "$skip" -e '1/1 "%02x "' -
    fi
    return 0
  fi
  # 退化：dd 逐字节取值（NUL 字节经 $() 变空串，判 0 即正确值）
  [ "$cnt" -gt 8192 ] 2>/dev/null && { echo "od 垫片: 无 hexdump 且请求超过 8192 字节" >&2; return 1; }
  _hs_i=0
  while [ "$cnt" -eq 0 ] || [ "$_hs_i" -lt "$cnt" ]; do
    if [ -n "$file" ]; then
      _hs_c=$(dd if="$file" bs=1 skip=$((skip + _hs_i)) count=1 2>/dev/null)
    else
      _hs_c=$(dd bs=1 count=1 2>/dev/null)
    fi
    [ -z "$_hs_c" ] && [ "$cnt" -eq 0 ] && break
    if [ -z "$_hs_c" ]; then printf '00 '
    else printf '%02x ' "$(printf '%d' "'$_hs_c")"; fi
    _hs_i=$((_hs_i + 1))
    [ "$cnt" -eq 0 ] && [ "$_hs_i" -ge 8192 ] && break
  done
  return 0
}
hex_stream | awk -v t="$type" '
  function h2d(s,  i,v,c) { v=0; s=tolower(s)
    for (i=1; i<=length(s); i++) { c=substr(s,i,1); v=v*16+index("0123456789abcdef",c)-1 }
    return v }
  { for (i=1; i<=NF; i++) b[++n]=h2d($i) }
  END {
    if (n == 0) exit
    if (t == "x1") { for (i=1; i<=n; i++) printf "%02x ", b[i]; print ""; exit }
    step = (t == "u2") ? 2 : 4
    for (i=1; i<=n; i+=step) {
      v = 0
      for (j=0; j<step; j++) v += (b[i+j]+0) * (256 ^ j)
      printf "%.0f ", v
    }
    print ""
  }'
SHIMEOF
  } > "$_od_target"
  chmod 755 "$_od_target" 2>/dev/null || { warn "无法写入 $_od_target"; return 1; }
  ok "已安装 od 适配器: $_od_target（hexdump 实现，内核下载 gzip/ELF 校验用）"
  return 0
}

ensure_usleep() {
  # usleep 垫片：busybox 精简版既无 usleep、sleep 又只认整数时，面板启动探测链
  # （usleep 20000 || sleep 0.02 || sleep 1）每轮都会退化成 sleep 1 —— 探测 100 轮
  # 就是约 100 秒假死（真机实测：uhttpd 一秒内就起来了，安装却"卡"在启动服务两分钟）。
  # 延时内核：系统 sleep 支持小数直接用；否则 read -t 小数 + 空 FIFO 硬等（busybox ash 实测 20ms 精确）。
  command -v usleep >/dev/null 2>&1 && return 0
  _us_target="$COMPAT_DIR/usleep"
  if [ -e "$_us_target" ] && ! grep -q "$SHIM_MARKER" "$_us_target" 2>/dev/null; then
    warn "$_us_target 已存在且非本脚本生成，跳过 usleep 适配器"
    return 1
  fi
  {
    echo "#!/bin/sh"
    echo "# $SHIM_MARKER-usleep: BusyBox-minimal usleep replacement (read -t fractional + empty FIFO)."
    cat <<'SHIMEOF'
us_n=${1:-0}
case "$us_n" in ''|*[!0-9]*) exit 1 ;; esac
us_t="$((us_n / 1000000)).$(printf '%06d' $((us_n % 1000000)))"
# 系统 sleep 支持小数时最快（busybox FANCY_SLEEP / GNU sleep）
sleep "$us_t" 2>/dev/null && exit 0
# 整数-only sleep：read -t 小数 + 以读写方式打开的空 FIFO（打开不阻塞，read 等满超时）
us_f=/tmp/.mihomo-usleep.fifo
[ -p "$us_f" ] || mkfifo "$us_f" 2>/dev/null
[ -p "$us_f" ] && read -t "$us_t" us_x <> "$us_f" 2>/dev/null
exit 0
SHIMEOF
  } > "$_us_target"
  chmod 755 "$_us_target" 2>/dev/null || { warn "无法写入 $_us_target"; return 1; }
  ok "已安装 usleep 适配器: $_us_target（微秒延时，消除面板探测循环百秒假死）"
  return 0
}

ensure_sleep() {
  # sleep 小数适配：busybox 精简版 sleep 只认整数，模块里 sleep 0.05/0.1/0.2/0.5
  # 的轮询/节拍全部报 "invalid number" 并空转（run_timeout 的限时校验也因此失准）。
  # 整数参数原样转交真 sleep；小数走 read -t + 空 FIFO（busybox ash 实测精确）。
  if sleep 0.01 2>/dev/null; then return 0; fi   # 真 sleep 支持小数则无需垫片
  _sl_real=""
  for _sl_c in /bin/sleep /usr/bin/sleep; do
    [ -x "$_sl_c" ] && { _sl_real=$_sl_c; break; }
  done
  [ -n "$_sl_real" ] || _sl_real="busybox sleep"
  _sl_target="$COMPAT_DIR/sleep"
  if [ -e "$_sl_target" ] && ! grep -q "$SHIM_MARKER" "$_sl_target" 2>/dev/null; then
    warn "$_sl_target 已存在且非本脚本生成，跳过 sleep 适配器"
    return 1
  fi
  {
    echo "#!/bin/sh"
    echo "# $SHIM_MARKER-sleep: fractional-capable sleep (integer passthrough; fraction via read -t + FIFO)."
    cat <<SHIMEOF
case "\$1" in
  ''|*[!0-9]*)
    case "\$1" in *.*) ;; *) exit 1 ;; esac
    _fs=\${1%%.*}; [ -n "\$_fs" ] || _fs=0
    _ff=\$(printf '%-6s' "\${1#*.}" | cut -c1-6 | tr ' ' '0')
    _fp=/tmp/.mihomo-usleep.fifo
    [ -p "\$_fp" ] || mkfifo "\$_fp" 2>/dev/null
    [ -p "\$_fp" ] && read -t "\$_fs.\$_ff" _x <> "\$_fp" 2>/dev/null
    exit 0 ;;
esac
exec $_sl_real "\$@"
SHIMEOF
  } > "$_sl_target"
  chmod 755 "$_sl_target" 2>/dev/null || { warn "无法写入 $_sl_target"; return 1; }
  ok "已安装 sleep 适配器: $_sl_target（小数秒支持，修复轮询报错与限时校验）"
  return 0
}

ensure_dlrewrite() {
  # 下载 URL 改写垫片（curl/wget）：mihomo.sh 的内核下载硬编码 Android 资产名
  # （android-arm64-v8 / android-amd64）。Android 构建动态链接 /system/bin/linker64，
  # OpenWrt 上一跑就是 "line N: core: not found"。发布页里 linux 构建与 Android 构建
  # 同 tag 同后缀，把 URL 里的资产名改写为 linux-* 即可拿到能跑的内核；
  # 其余 URL 原样透传。只此一处桥接，模块源码保持与 Android 一致。
  for _dw_cmd in curl wget; do
    _dw_real=$(command -v "$_dw_cmd" 2>/dev/null) || continue
    case "$_dw_real" in "$COMPAT_DIR"/*) continue ;; esac
    _dw_target="$COMPAT_DIR/$_dw_cmd"
    if [ -e "$_dw_target" ] && ! grep -q "$SHIM_MARKER" "$_dw_target" 2>/dev/null; then
      warn "$_dw_target 已存在且非本脚本生成，跳过 $_dw_cmd 下载改写垫片"
      continue
    fi
    {
      echo "#!/bin/sh"
      echo "# $SHIM_MARKER-dlrewrite: rewrite mihomo-android-* kernel assets to linux builds."
      cat <<SHIMEOF
_dw_r=0; _dw_n=\$#
while [ \$_dw_r -lt \$_dw_n ]; do
  _dw_a=\$1; shift
  case "\$_dw_a" in
    *mihomo-android-arm64-v8*) _dw_a=\$(printf '%s' "\$_dw_a" | sed 's/mihomo-android-arm64-v8/mihomo-linux-arm64/g') ;;
    *mihomo-android-amd64*)   _dw_a=\$(printf '%s' "\$_dw_a" | sed 's/mihomo-android-amd64/mihomo-linux-amd64/g') ;;
  esac
  set -- "\$@" "\$_dw_a"
  _dw_r=\$((_dw_r + 1))
done
exec $_dw_real "\$@"
SHIMEOF
    } > "$_dw_target"
    chmod 755 "$_dw_target" 2>/dev/null || { warn "无法写入 $_dw_target"; continue; }
    ok "已安装 $_dw_cmd 下载改写垫片: $_dw_target（Android 资产 → linux 构建）"
  done
  return 0
}

install_compat_shims() {
  step "系统兼容垫片（busybox 精简缺失项）"
  install_httpd_shim
  ensure_nohup
  ensure_base64
  ensure_od
  ensure_usleep
  ensure_sleep
  ensure_dlrewrite
  return 0
}

# 卸载时移除垫片（只删自己生成的，不碰系统原有文件）
remove_compat_shims() {
  for _hr_p in "$HTTPD_SHIM" "$COMPAT_DIR/nohup" "$COMPAT_DIR/base64" "$COMPAT_DIR/od" "$COMPAT_DIR/usleep" "$COMPAT_DIR/sleep" "$COMPAT_DIR/curl" "$COMPAT_DIR/wget" \
               $(command -v httpd 2>/dev/null) $(command -v nohup 2>/dev/null) $(command -v base64 2>/dev/null) $(command -v od 2>/dev/null) $(command -v usleep 2>/dev/null) $(command -v sleep 2>/dev/null) $(command -v curl 2>/dev/null) $(command -v wget 2>/dev/null); do
    [ -f "$_hr_p" ] || continue
    grep -q "$SHIM_MARKER" "$_hr_p" 2>/dev/null && rm -f "$_hr_p"
  done
  return 0
}

# HTTP 客户端自检（与 Android 版 customize.sh 相同：代理列表、切换节点都依赖它）
httpclient_check() {
  step "HTTP 客户端自检"
  _hc_line=$(sh "$INSTALL_DIR/scripts/mihomo.sh" httpclient </dev/null 2>/dev/null | head -1)
  case "$_hc_line" in
    OK:*) ok "读取内核数据用: ${_hc_line#OK: }" ;;
    *)    warn "未找到可用的 HTTP 客户端，代理页可能读不到数据（建议安装 curl 或 wget）" ;;
  esac
}

# ============================================================
# 安装 / 热更新主流程
# 判定与 Android 版一致：有完整上一版（scripts/mihomo.sh + module.prop）
# 且跑过安装（module-settings.conf 存在）才算热更新，否则按首次安装
# ============================================================
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

  FIRST=1
  if [ -f "$INSTALL_DIR/scripts/mihomo.sh" ] && [ -f "$INSTALL_DIR/module.prop" ] && \
     [ -f "$INSTALL_DIR/module-settings.conf" ]; then
    FIRST=0
  fi

  STAGE=$(mktemp -d /tmp/mihomo-box-install.XXXXXX 2>/dev/null) || {
    STAGE="/tmp/mihomo-box-install.$$"; rm -rf "$STAGE"; mkdir -p "$STAGE" || die "无法创建临时目录"; }
  trap 'rm -rf "$STAGE"' 0 1 2 15

  # ---- 1. 下载 + 解压安装包（镜像链，直连兜底；不含内核）----
  obtain_package
  step "解压安装包"
  extract_package "$PKG_FILE" "$STAGE/root" "$PKG_KIND" || die "安装包解压失败或结构异常"
  cleanup_pkg_root
  ok "安装包就绪: $PKG_ROOT"

  MODSH="$INSTALL_DIR/scripts/mihomo.sh"

  # ---- 2. 热更新：先停旧运行时（与 Android 版热更新同序）----
  if [ "$FIRST" = "0" ]; then
    step "检测到已安装，执行热更新"
    sh "$MODSH" switch-stop </dev/null >/dev/null 2>&1
    sh "$MODSH" webui-stop </dev/null >/dev/null 2>&1
    # 旧版本把 httpd pid 记在 run/webui.pid（现为 run/httpd.pid），兜底杀一次
    _old_wp=$(cat "$INSTALL_DIR/run/webui.pid" 2>/dev/null)
    [ -n "$_old_wp" ] && kill "$_old_wp" 2>/dev/null
    rm -f "$INSTALL_DIR/run/webui.pid" 2>/dev/null
  fi

  # ---- 3. 覆盖式同步模块文件（只新增与覆盖，用户数据不在包内、不受影响）----
  step "同步模块文件到 $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -af "$PKG_ROOT"/. "$INSTALL_DIR"/ 2>/dev/null
  stale_clean

  # ---- 4. 路径适配 + 工作目录 + 缓存打点 ----
  patch_paths
  setup_workdir
  stamp_panel_cache
  write_uninstall_helper

  # ---- 5. 系统依赖（TUN / Tproxy，opkg/apk 自动识别）----
  ensure_system_deps

  # ---- 6. 开机自启 + 系统兼容垫片（httpd/nohup/base64，按需生成）----
  write_initd
  install_compat_shims

  # ---- 7. 启动 / 重载运行时 ----
  # 子进程统一断开 stdin + 输出走文件捕获：curl|sh 时安装器脚本本身就在 stdin
  # 管道上，任何后代命令误读 stdin 都会把剩余脚本吃掉（输出戛然而止、无任何报错）；
  # 输出若用 管道/$() 捕获，后台常驻进程意外继承捕获端又会让这里永久挂住。
  if [ "$NO_START" = "1" ]; then
    warn "按 --no-start 跳过服务启动（重启后由 $INITD 自动拉起）"
  elif [ "$FIRST" = "0" ]; then
    step "重载运行时（无需重启）"
    sh "$MODSH" switch-start </dev/null >/dev/null 2>&1
    _wb_file="$INSTALL_DIR/run/.webui-restart.out"
    sh "$MODSH" webui-restart </dev/null > "$_wb_file" 2>&1
    _wb_out=$(cat "$_wb_file" 2>/dev/null)
    rm -f "$_wb_file"
    sh "$MODSH" syncdesc </dev/null >/dev/null 2>&1
    case "$_wb_out" in
      OK:*) ok "面板服务已按新版本重启（监听范围按你的设置恢复）" ;;
      *)    warn "面板服务未能启动："; printf '%s\n' "$_wb_out" | head -4 | while IFS= read -r _l; do [ -n "$_l" ] && info "$_l"; done ;;
    esac
  else
    step "启动服务（对应 Android 版开机流程，无需重启路由器）"
    _bt_file="$INSTALL_DIR/run/.boot.out"
    sh "$MODSH" boot </dev/null > "$_bt_file" 2>&1
    while IFS= read -r _l; do [ -n "$_l" ] && info "$_l"; done < "$_bt_file"
    rm -f "$_bt_file"
  fi

  httpclient_check

  # ---- 8. 收尾提示（对应 Android 版安装完成画面）----
  VER=$(grep -m1 '^version=' "$INSTALL_DIR/module.prop" 2>/dev/null | cut -d= -f2- | tr -d '\r')
  say ""
  say "─────────────────────────────"
  if [ "$FIRST" = "0" ]; then
    say "  ✅ Mihomo Box 热更新完成（无需重启）"
  else
    say "  ✅ Mihomo Box 首次安装完成（无需重启）"
  fi
  say "  版本: ${VER:-未知}    目录: $INSTALL_DIR"
  say "  ⚠ 安装脚本未下载 mihomo 内核（与 Android 版一致）"
  say "  ⚠ 请打开面板 WebUI 完成后续："
  say "  ·「内核管理」→ 下载内核（默认 jieluojun 分支）"
  say "  ·「主页」→ 开启总开关启动内核"
  say "  ·「工具」→ 面板服务：电脑 / 手机远程管理"
  say "  ·「内核管理」→ 下载加速镜像：国内建议选「自动优选」"
  if [ "$NO_START" != "1" ]; then
    _wi=$(sh "$MODSH" webui-info </dev/null 2>/dev/null)
    [ -n "$_wi" ] && { say "  ───────────────────────────"; printf '%s\n' "$_wi" | while IFS= read -r _l; do say "  $_l"; done; }
  fi
  if [ -x "$INITD" ]; then
    say "  开机自启: $INITD（enable 已开启）"
  fi
  say "  卸载:     sh $INSTALL_DIR/uninstall-openwrt.sh"
  say "─────────────────────────────"
  say "  提示: TUN / Tproxy 依赖已自动检查安装（kmod-tun / iptables 或 nftables tproxy 套件）"
  say "        与 TUN 相关的内核选项，详见面板「内核管理」页环境自检"
  say "─────────────────────────────"
}

do_uninstall() {
  say "─────────────────────────────"
  say "  Mihomo Box · OpenWrt 卸载"
  say "─────────────────────────────"
  if [ "$ASSUME_YES" != 1 ]; then
    printf "🛑 确认卸载全部数据？[y/N] "
    read -r _uninstall_ans || _uninstall_ans=""
    case "$_uninstall_ans" in
      y|Y|yes|YES) : ;;
      *) say "已取消卸载"; return 0 ;;
    esac
  fi
  [ -x "$INITD" ] && { "$INITD" stop </dev/null >/dev/null 2>&1; "$INITD" disable </dev/null >/dev/null 2>&1; }
  if [ -f "$INSTALL_DIR/scripts/mihomo.sh" ]; then
    step "停止服务（内核 / 开关监听 / 面板）"
    sh "$INSTALL_DIR/scripts/mihomo.sh" switch-stop </dev/null >/dev/null 2>&1
    sh "$INSTALL_DIR/scripts/mihomo.sh" stop </dev/null >/dev/null 2>&1
    sh "$INSTALL_DIR/scripts/mihomo.sh" webui-stop </dev/null >/dev/null 2>&1
  fi
  rm -f "$INITD"
  remove_compat_shims
  rm -rf "$INSTALL_DIR"
  # 兜底：stop 的后台清扫进程可能稍后才落盘，二次清理防止目录复活
  sleep 1
  rm -rf "$INSTALL_DIR" 2>/dev/null
  ok "已删除 $INSTALL_DIR 与开机自启 $INITD"
  say "─────────────────────────────"
  say "  ✅ Mihomo Box 已卸载"
  say "─────────────────────────────"
}

usage() {
  if [ -r "$0" ]; then
    sed -n '3,33p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
  else
    cat <<'EOF'
Mihomo Box · OpenWrt 一键安装脚本
用法：
  sh mihomo-box-openwrt-install.sh                # 安装 / 热更新
  sh mihomo-box-openwrt-install.sh uninstall      # 卸载
可选参数（install）：
  --zip <本地包>   用本地发布包安装（离线安装，支持 .zip）
  --url <地址>     指定安装包下载地址（.zip / .tar.gz）
  --no-start       安装后不立即启动服务
EOF
  fi
}

# ============================================================
# 入口
# ============================================================
CMD=install
ARG_ZIP=""
ARG_URL=""
NO_START=0
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    install|uninstall)
      CMD="$1" ;;
    --zip)
      shift; [ $# -ge 1 ] || die "--zip 缺少参数"
      ARG_ZIP="$1" ;;
    --url)
      shift; [ $# -ge 1 ] || die "--url 缺少参数"
      ARG_URL="$1" ;;
    --no-start)
      NO_START=1 ;;
    -y|--y|--yes|--force)
      ASSUME_YES=1 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      die "未知参数: $1（--help 查看用法）" ;;
  esac
  shift
done

case "$CMD" in
  uninstall) do_uninstall ;;
  *)         do_install ;;
esac
exit 0
