#!/system/bin/sh
# mihomo_box 安装脚本 (KernelSU / Magisk 兼容)

WORKDIR=/data/adb/mihomo_box

ARCH=$(getprop ro.product.cpu.abi 2>/dev/null)
case "$ARCH" in
  arm64-v8a|x86_64) : ;;
  *)
    ui_print "! ❌ 未支持的 CPU 架构: $ARCH"
    ui_print "! 本模块内核仅支持 arm64-v8a / x86_64"
    abort
    ;;
esac

ui_print "- 设备架构: $ARCH"

# ---------- 识别当前 root 方案，并改写 module.prop 的 description ----------
# 判定优先级：安装器环境变量（最可靠）→ 文件特征。
# 注意：原版 KernelSU 与 KernelSU Next 都会创建 /data/adb/ksu/bin（busybox 目录），
# 绝不能仅凭该目录判定为 Next；只有 Next 的 ksud 才位于 ksu/bin/ksud，
# 原版的 ksud 在 /data/adb/ksud —— 旧逻辑凭目录存在就判 Next，原版会被误判。
detect_root_impl() {
  # 1) 环境变量（由刷机时的管理器进程注入；Next 排在通用 KSU 之前，
  #    因为 Next 为兼容可能同时设置 KSU=true）
  if [ "$KSU_NEXT" = "true" ]; then
    echo "KernelSU Next"; return
  fi
  if [ "$APATCH" = "true" ]; then
    echo "APatch"; return
  fi
  if [ "$KSU" = "true" ]; then
    echo "KernelSU"; return
  fi
  if [ -n "$MAGISK_VER_CODE" ]; then
    echo "Magisk"; return
  fi
  # 2) 文件特征兜底（环境变量缺失时）
  if [ -d /data/adb/ap ] || [ -f /data/adb/apd ]; then
    echo "APatch"; return
  fi
  if [ -f /data/adb/ksu/bin/ksud ]; then
    echo "KernelSU Next"; return
  fi
  if [ -f /data/adb/ksud ]; then
    echo "KernelSU"; return
  fi
  if [ -d /data/adb/ksu ]; then
    # 仅有目录、两处 ksud 文件都不存在：Next 不可能缺自己的 ksud，
    # 故判为原版 KernelSU（残留目录场景）
    echo "KernelSU"; return
  fi
  if [ -d /data/adb/magisk ] || [ -f /data/adb/magisk/magiskinit ]; then
    echo "Magisk"; return
  fi
  echo ""
}

ROOT_IMPL=$(detect_root_impl)

if [ -n "$ROOT_IMPL" ]; then
  # 原地替换 description 行里的 "for <旧工具名>"，其余说明文字不动。
  # 表达式里 "KernelSU Next" 必须排在 "KernelSU" 前面，否则 "for KernelSU Next"
  # 只会被匹配前半截、残留 " Next"（从 Next 换回原版时会清不干净）。
  if [ -f "$MODPATH/module.prop" ]; then
    if grep -qE "^description=.*for (KernelSU Next|KernelSU|APatch|Magisk)" "$MODPATH/module.prop" 2>/dev/null; then
      sed -i -E "/^description=/ s/for (KernelSU Next|KernelSU|APatch|Magisk)/for $ROOT_IMPL/" "$MODPATH/module.prop"
      ui_print "- 已识别 root 方案: $ROOT_IMPL（模块描述已同步）"
    else
      sed -i "s|^description=\(.*\)$|description=\1 for $ROOT_IMPL|" "$MODPATH/module.prop"
      ui_print "- 已识别 root 方案: $ROOT_IMPL（模块描述已同步）"
    fi
  fi
else
  ui_print "- 未能识别 root 方案，保持默认描述"
fi

# ---------------------------------------------------------------------------
# 本次刷入的性质判定：首次安装 or 热更新
# （tests/customize-install-action.py 会切这一段在临时目录里跑）
# ---------------------------------------------------------------------------
# 「活动目录里有文件」并不等于「装过」，下面三种都会被旧判据（目录里有 module.prop
# 或脚本）误判成热更新：
#   1. 上次卸载留下的目录 —— ksud / 管理器要等重启才真正删除，期间 module.prop 和
#      脚本都还在，而且带着 remove 标记；
#   2. 上次刷入中断留下的半截目录（只有 module.prop，没有脚本，压根没跑起来过）；
#   3. 就地展开安装（Recovery 直装等，$MODPATH == $INSTDIR）—— 安装器已把本次的新
#      文件铺进活动目录，目录内容永远「像装过」。
# 误判的后果不只是日志难看：首装会打印「已热更新…本次升级无需重启」，而实际文件
# 还在 modules_update 暂存目录里，重启后才提交生效。
# 真正的热更新 = 之前存在一份完整、可运行、且未被标记删除的安装；第 3 种情形目录
# 本身分不清新旧，再用「上次安装留下的模块设置」作第二证据（首装时它还不存在，
# uninstall.sh 会连工作目录一起删掉，所以卸载后重装也算首装）。
INSTDIR=/data/adb/modules/mihomo_box
_prev_settings=0
[ -f "$WORKDIR/module-settings.conf" ] && _prev_settings=1
_prev_installed=0
if [ -f "$INSTDIR/scripts/mihomo.sh" ] && [ -f "$INSTDIR/module.prop" ] &&
   grep -q '^id=' "$INSTDIR/module.prop" 2>/dev/null &&
   [ ! -f "$INSTDIR/remove" ]; then
  _prev_installed=1
fi
# 部分安装器（例如 Recovery 直装）会把新文件直接落到活动目录，此时 $MODPATH 与
# $INSTDIR 指向同一个目录；这种情况不能做「目录内复制」。
_SAME_PATH=0
[ "$(echo "$INSTDIR" | sed 's#/*$##')" = "$(echo "$MODPATH" | sed 's#/*$##')" ] && _SAME_PATH=1
# 两个证据同时成立才算升级：活动目录里有一份完整可用的上一版，且上一次安装确实
# 跑过（留下了 module-settings.conf）。后者能挡住「就地展开安装时目录里全是本次
# 新文件」和「上次刷入中断」两种假象。
if [ "$_prev_installed" = "1" ] && [ "$_prev_settings" = "1" ]; then
  _act=update
else
  _act=install
fi

ui_print "- 创建工作目录 $WORKDIR"

mkdir -p "$WORKDIR/core" "$WORKDIR/run" "$WORKDIR/backup" "$WORKDIR/proxies" "$WORKDIR/rules"

# 首次安装写入默认配置（升级保留用户配置）
if [ ! -f "$WORKDIR/config.yaml" ]; then
  cp "$MODPATH/data/config.yaml" "$WORKDIR/config.yaml"
  ui_print "- 已写入默认配置 config.yaml"
else
  ui_print "- 检测到已有配置，保留 config.yaml"
fi

if [ ! -f "$WORKDIR/module-settings.conf" ]; then
  cat > "$WORKDIR/module-settings.conf" <<EOF
core=jieluojun
autostart=true
mirror=direct
webui=true
EOF
  ui_print "- 已写入默认模块设置（远程访问默认开启：监听 0.0.0.0）"
else
  ui_print "- 检测到已有模块设置，保留"
  # 老版本升级上来时配置里没有 webui 项，补上默认值。
  # 只在「键完全不存在」时补，用户手动关过就不覆盖他的选择。
  # （webui=false 的老用户：升级后面板服务仍会常驻，但只监听 127.0.0.1，
  # 局域网依旧不可见，管理器界面反而能用了——以前关掉是连管理器一起断。）
  if ! grep -qE '^webui=' "$WORKDIR/module-settings.conf" 2>/dev/null; then
    echo "webui=true" >> "$WORKDIR/module-settings.conf"
    ui_print "- 已为旧配置补上远程访问默认值"
  fi
fi

chmod 755 "$MODPATH/scripts/mihomo.sh" 2>/dev/null
chmod 755 "$MODPATH/webroot/ui/cgi-bin/exec.sh" 2>/dev/null
chmod 644 "$WORKDIR/config.yaml" "$WORKDIR/module-settings.conf" 2>/dev/null

# 清理模块描述状态缓存（热更新必需，非残留清理）：
# 本次刷入的 module.prop 是干净的（无 [状态] 前缀），描述正文也可能随版本更新；
# 旧 modstate.prev 会让 syncdesc 判定「状态没变」而跳过写入，导致热更新后
# 模块界面的运行状态前缀 [🟢]/[🔴]/[⚪] 丢失；旧 desc.base / prop.tpl 则可能
# 缓存着上一版的描述正文。清掉后由收尾的 syncdesc 按新 module.prop 重建。
rm -f "$WORKDIR/run/modstate.prev" "$WORKDIR/run/desc.base" "$WORKDIR/run/prop.tpl" 2>/dev/null
rmdir "$WORKDIR/run/desc.lock" 2>/dev/null

# ---------------------------------------------------------------------------
# 热更新：重复刷入（升级）后无需重启手机 —— 对所有 Root 方案统一生效
# ---------------------------------------------------------------------------
# KernelSU / KernelSU Next / APatch，以及「管理器内安装」的 Magisk，都用
# modules_update「暂存→开机提交」机制：刷入时新文件在 /data/adb/modules_update/<id>，
# 下次开机才提交到活动模块目录 /data/adb/modules/<id>。这意味着：
#   * 首次刷入：文件在暂存目录，重启后才变为活动模块；
#   * 再次刷入（升级）：暂存目录是新文件，但活动目录里仍是上一版脚本在跑，
#     所以升级后看到的还是旧行为。
# 为了让「再次刷入」立即生效，这里把本次包的新文件同步进活动目录，再重载运行时
# （模块开关监听 + 面板 HTTP 服务）。内核与用户配置位于 /data/adb/mihomo_box，
# 不随模块包升级改动，因此不重启内核，避免中断正在运行的代理。
MODSH="$INSTDIR/scripts/mihomo.sh"

# 只有「之前确实装过一份可用的」才同步进活动目录并热重载运行时。
# 首次安装绝不能碰活动目录：一旦在里面创建了文件（哪怕只是 module.prop），
# ksud / 管理器就会认为模块已安装 —— 于是首装也长出「打开 / 执行」按钮、模块开关
# 也能拨，与普通模块（如 koloader）首装时「无按钮、开关不可用、等重启提交」的
# 正常状态不一致。收尾的 syncdesc 更会直接写 $MODDIR/module.prop，等于凭空造出
# 一个活动模块，所以首装时它同样必须跳过。
if [ "$_act" = "update" ]; then
  ui_print "- [热更新] 同步新模块文件到活动目录 $INSTDIR…"
  # 记录模块级标记，避免同步时丢失（禁用 / 待移除）
  _had_disable=0; [ -f "$INSTDIR/disable" ] && _had_disable=1
  _had_remove=0 ; [ -f "$INSTDIR/remove" ]  && _had_remove=1

  # 先停掉在用旧脚本跑的运行时（仅在已存在时）。
  # 注意：webui-stop 不再改写 webui 设置（那是用户的监听范围意愿），
  # 稍后的 webui-restart 会按原设置恢复监听范围，无需记录与恢复。
  if [ -f "$MODSH" ]; then
    sh "$MODSH" switch-stop >/dev/null 2>&1
    sh "$MODSH" webui-stop  >/dev/null 2>&1
  fi

  # 旧版本把 httpd 的 pid 记在 run/webui.pid（现已改名 run/httpd.pid）：
  # 万一上面的 webui-stop 没停干净，这里按旧文件兜底杀一次，避免升级后残留一个占着端口的 httpd
  _old_wp=$(cat "$WORKDIR/run/webui.pid" 2>/dev/null)
  [ -n "$_old_wp" ] && kill "$_old_wp" 2>/dev/null
  rm -f "$WORKDIR/run/webui.pid" 2>/dev/null

  mkdir -p "$INSTDIR"
  if [ "$_SAME_PATH" != "1" ]; then
    # 覆盖式同步：只新增与覆盖，不重建目录，保留既有目录的 SELinux 上下文。
    # 「包里没有的旧文件」不再靠这里做顶层比对删除——下方的递归清残（逐文件对照
    # MODPATH 树）已完全覆盖并细化了那段逻辑（顶层循环曾有误删 disable 标记之险）。
    cp -af "$MODPATH"/. "$INSTDIR/" 2>/dev/null
  fi

  # —— 递归清残：对比「本次包内容」与目录内文件，删除包里没有的旧残留 ——
  # 上面的顶层清理只比对目录一级条目：ui/ 在新包里存在就不动它，子目录内部
  # （如已删的 ui/img/icon-96.png）会被 cp -af 的合并语义永久保留。这里递归到文件级。
  # 两种情形两个事实源：
  #  * 常规刷入：MODPATH 就是安装器解出来的本次新包 → 目录里任何文件，只要 MODPATH
  #    没有同名相对路径，即为残留，删。（比清单文件更诚实：永远不会和包漂移。）
  #  * 就地展开安装（Recovery 直装，$_SAME_PATH=1）：MODPATH==INSTDIR，包与目录不可分辨
  #    → 改用 $ZIPFILE 的 unzip -l 列表当事实源；列表不可信（无 zip/unzip/结构缺行）则整段
  #    跳过——宁可不删，不可误删。
  # 前缀剥离用无引号模式（${_f#$INSTDIR/}）——引号嵌在 ${#} 里是 bashism，
  # dash/mksh 会当字面量导致剥不掉前缀、把该留的文件也误删；本模块路径无空格，安全。
  # 只删文件不拆非空目录（SELinux 上下文与权限保持稳定），塌空的目录收掉；
  # ksud 标记文件白名单保护。1228 版遗留的 module.files 在新包已不存在，会被这条规则自动清掉。
  if [ "$_SAME_PATH" != "1" ]; then
    _stale=0
    for _f in $(find "$INSTDIR" -type f 2>/dev/null); do
      _r=${_f#$INSTDIR/}
      case "$_r" in disable|remove|update|skip_test|update/*) continue ;; esac
      [ -e "$MODPATH/$_r" ] || { rm -f "$_f" 2>/dev/null; _stale=$((_stale+1)); }
    done
    find "$INSTDIR" -mindepth 1 -type d -empty -delete 2>/dev/null
    if [ "$_stale" -gt 0 ]; then
      ui_print "- [清残] 已删除活动目录中不在本次包内的旧文件 ${_stale} 个（含 ui 子目录残留）"
    fi
  else
    _zl="${TMPDIR:-/dev/tmp}/mihomo-box-zl.$$"
    rm -f "$_zl" 2>/dev/null
    if [ -n "$ZIPFILE" ] && [ -f "$ZIPFILE" ]; then
      # unzip -l 表头/分隔线/汇总行都靠 NF>=4 与 $4!=Name 过滤；目录条目（以 / 结尾）跳过
      unzip -l "$ZIPFILE" 2>/dev/null | sed -e "s/\r$//" | awk 'NF>=4 && $4!="Name" {
        name=$4; for (i=5; i<=NF; i++) name=name" "$i
        if (name !~ /\/$/) print name }' > "$_zl" 2>/dev/null || true
      # 注：'|| true' 兜 recovery 缺 awk 时 127 经 set -e 打断整个安装脚本；
      # 列表取不到 → 下面 -s 防呆自然跳过
    fi
    if [ -s "$_zl" ] && grep -qx customize.sh "$_zl" && grep -qx module.prop "$_zl"; then
      _stale=0
      for _f in $(find "$MODPATH" -type f 2>/dev/null); do
        _r=${_f#$MODPATH/}
        case "$_r" in disable|remove|update|skip_test|update/*) continue ;; esac
        grep -qxF "$_r" "$_zl" 2>/dev/null || { rm -f "$_f" 2>/dev/null; _stale=$((_stale+1)); }
      done
      find "$MODPATH" -mindepth 1 -type d -empty -delete 2>/dev/null
      if [ "$_stale" -gt 0 ]; then
        ui_print "- [清残] 已删除活动目录中不在本次包内的旧文件 ${_stale} 个（含 ui 子目录残留）"
      fi
    else
      ui_print "- [清残] 当前安装环境读不到包内文件清单，已跳过旧文件清理（不影响本次更新，仅旧残留仍在）"
    fi
    rm -f "$_zl" 2>/dev/null
  fi

  chmod 755 "$INSTDIR/scripts/mihomo.sh" 2>/dev/null
  chmod 755 "$INSTDIR/webroot/ui/cgi-bin/exec.sh" 2>/dev/null
  chmod 644 "$INSTDIR/module.prop" 2>/dev/null
  chmod 755 "$INSTDIR/service.sh" "$INSTDIR/post-fs-data.sh" 2>/dev/null
  chmod 755 "$INSTDIR/action.sh" "$INSTDIR/uninstall.sh" 2>/dev/null

  # 恢复模块级标记：disable 是用户意图，跨刷入保留；remove 绝不保留 ——
  # 它的语义是「下次开机删除本模块」，全新安装盖在卸载残留目录上时把它恢复回去，
  # 等于让 ksud / 管理器在重启后把刚装好的模块删掉。
  [ "$_had_disable" = "1" ] && touch "$INSTDIR/disable"
  if [ "$_had_remove" = "1" ]; then
    rm -f "$INSTDIR/remove" 2>/dev/null
    ui_print "- [清理] 已清除上次卸载遗留的 remove 标记（否则重启后刚装好的模块会被删除）"
  fi

  # 确保面板目录与跳转页就位：ksud 以「活动模块目录中存在 webroot」作为 hasWebUi 依据，
  # 管理器据此才显示「<> 打开（模块界面）」按钮。热更新已把 ui/ 与 webroot/ 同步过来，
  # 这里再显式兜底一次，避免个别安装器只复制 module.prop 而漏掉面板文件。
  if [ "$_SAME_PATH" != "1" ]; then
    [ -d "$MODPATH/webroot" ] && cp -af "$MODPATH/webroot" "$INSTDIR/" 2>/dev/null
    chmod 755 "$INSTDIR/webroot/ui/cgi-bin/exec.sh" 2>/dev/null
    chmod 755 "$INSTDIR/webroot/ui" "$INSTDIR/webroot" 2>/dev/null
  fi
  _TARGET_UI="$INSTDIR/webroot/ui"
  _TARGET_WEBROOT="$INSTDIR/webroot"
  _TARGET_SH="$INSTDIR/scripts/mihomo.sh"
  _TARGET_PROP="$INSTDIR/module.prop"
else
  ui_print "- [首次安装] 不改动活动模块目录：重启后由 ksud / 管理器提交生效"
  ui_print "             （此时管理器不显示「打开 / 执行」按钮、模块开关不可用，与普通模块一致）"
  # 首装时后续步骤改为操作暂存副本：重启提交后带进活动目录
  _TARGET_UI="$MODPATH/webroot/ui"
  _TARGET_WEBROOT="$MODPATH/webroot"
  _TARGET_SH="$MODPATH/scripts/mihomo.sh"
  _TARGET_PROP="$MODPATH/module.prop"
fi

# ---------------------------------------------------------------------------
# 面板缓存：每次刷入都作废旧缓存，强制使用本次刷入的面板文件
# ---------------------------------------------------------------------------
# 源码不写死任何缓存版本号：index.html 的资源 URL 带的是 __PANEL_VER__ 占位
# （打包时烘焙为本次版本戳），SW 缓存名也不带 vNNN。
# 「刷入即清缓存」由现场写入的指纹实现，值 = 模块版本戳 + 刷入时刻：
#   * ui/index.html 的 ?v= 资源戳 —— 刷入一次改一次，JS/CSS 的 URL 全变，
#     浏览器/管理器 WebView（不注册 SW）的 HTTP 缓存都不可能复用上一版文件；
#   * ui/sw.js 的 INSTALL_STAMP —— sw.js 字节随刷入改变，浏览器据此认定
#     Service Worker 有更新 → install/activate 重跑 → activate 里清空全部
#     Cache Storage 并用当前磁盘文件重建缓存（浏览器端，含已安装的 PWA）；
#   * ui/install.stamp —— 前端每次进页面比对（见 app.js checkInstallStamp），
#     不一致就清缓存并重载一次；不注册 SW 的 WebView 靠这条兜底。
# 带刷入时刻而不是只用版本戳：反复刷同一个包（版本戳相同）也算一次刷入，
# 同样要把上一份缓存作废，不能因为版本号没变就跳过。
_uidir="$_TARGET_UI"
_ver=$(grep -m1 '^version=' "$_TARGET_PROP" 2>/dev/null | cut -d= -f2- | tr -d '\r')
[ -n "$_ver" ] || _ver=$(date '+%Y%m%d-%H%M')
_stamp="$_ver.$(date '+%Y%m%d%H%M%S')"
if [ -f "$_uidir/index.html" ]; then
  sed -i "s/?v=[0-9A-Za-z._-]*/?v=$_stamp/g" "$_uidir/index.html" 2>/dev/null
  chmod 644 "$_uidir/index.html" 2>/dev/null
fi
if [ -f "$_uidir/sw.js" ]; then
  sed -i "s|^const INSTALL_STAMP = .*|const INSTALL_STAMP = '$_stamp';|" "$_uidir/sw.js" 2>/dev/null
  chmod 644 "$_uidir/sw.js" 2>/dev/null
fi
printf '%s\n' "$_stamp" > "$_uidir/install.stamp" 2>/dev/null
chmod 644 "$_uidir/install.stamp" 2>/dev/null
ui_print "- [面板] 刷入指纹 $_stamp（旧缓存将在下次打开面板时自动清除）"

# 静态文件 mtime 归零到刷入时刻：busybox httpd 无自定义响应头能力，浏览器对
# 不带缓存头的静态响应按 Last-Modified 的 10% 估算启发式新鲜期——包里/上次
# 拷贝带来的旧时间戳，会让陈旧 index.html 在数小时内连一次重新验证都不做，
# 更新后端后跑的仍是旧面板（「老面板 download-core liuran 打到新后端 → ERR:
# 未知内核来源」即此所致）。touch 后所有面板文件年龄随本次刷入归零，下次访问
# 必然带 If-Modified-Since 重新验证拿到新文件；与每次刷入变化的 ?v= 资源戳、
# install.stamp / sw.js 指纹三面合围。
find "$_uidir" -type f -exec touch {} + 2>/dev/null
[ -d "$_TARGET_WEBROOT" ] && find "$_TARGET_WEBROOT" -maxdepth 1 -type f -exec touch {} + 2>/dev/null

# HTTP 客户端自检：代理列表、切换节点全都依赖它。
# 部分 ROM 的 wget 是指向 toybox 的软链接、而那份 toybox 没编译 wget
# （执行只吐 "Unknown command wget"），表现为代理页读不到任何数据。
# 刷入时就地报一次，省得事后对着面板猜原因。
rm -f "$WORKDIR/run/api.httpclient" 2>/dev/null   # 旧缓存可能指向已经不存在的客户端
# 旧版候选列表已改为内存实现；仅清理数字 PID 后缀的普通残留文件。
# 不清理其他 run 状态文件、目录或符号链接。
for _legacy_client_file in "$WORKDIR"/run/api.clients.*; do
  _legacy_client_pid=${_legacy_client_file##*/api.clients.}
  case "$_legacy_client_pid" in ''|*[!0-9]*) continue ;; esac
  if [ -f "$_legacy_client_file" ] && [ ! -L "$_legacy_client_file" ]; then
    rm -f "$_legacy_client_file" 2>/dev/null
  fi
done
unset _legacy_client_file _legacy_client_pid

if [ -f "$_TARGET_SH" ]; then
  _hc_line=$(sh "$_TARGET_SH" httpclient 2>/dev/null | head -1)
  case "$_hc_line" in
    OK:*) ui_print "- [HTTP] 读取内核数据用: ${_hc_line#OK: }" ;;
    *)    ui_print "- [HTTP] ⚠ 未找到可用的 HTTP 客户端，代理页可能读不到数据"
          ui_print "         （建议安装 Busybox 模块后重启）" ;;
  esac
fi

# 清理「待重启」标记，让模块界面（WebUI）可立即打开。
# KernelSU / Magisk 的安装器会在 customize.sh 返回后立刻重建 <id>/update，
# 表示「有更新等待重启后提交」。但既然我们已把新文件同步到活动目录（热更新），
# 该标记已无意义：它会让管理器开关灰显（Material），并在 Miuix 主题下隐藏
# 「执行 / 打开(WebUI)」按钮，导致热更新后 WebUI 打不开。
# 这里延迟几秒，等安装器建立该标记后再清除，使模块立即显示为「已安装、无待重启更新」。
# 首装时这个标记正是「待重启提交」的正常状态，删了管理器就会当成已安装。
if [ "$_act" = "update" ] && [ "$_SAME_PATH" != "1" ]; then
  # 安装器在 customize.sh 返回后才写 update，部分机型会晚于 4s 或写不止一次。
  # 多清一会儿，避免标记残留导致管理器一直要重启。
  _rmu="i=0; while [ \$i -lt 15 ]; do rm -f '$INSTDIR/update'; sleep 2; i=\$((i+1)); done"
  if command -v setsid >/dev/null 2>&1; then
    setsid sh -c "$_rmu" >/dev/null 2>&1 &
  elif command -v nohup >/dev/null 2>&1; then
    nohup sh -c "$_rmu" >/dev/null 2>&1 &
  else
    ( i=0; while [ "$i" -lt 15 ]; do rm -f "$INSTDIR/update"; sleep 2; i=$((i+1)); done ) >/dev/null 2>&1 &
  fi
fi

# 用新脚本重载开关监听驱动（管理器模块页开关秒级控制内核）
if [ "$_act" = "update" ]; then
  sh "$_TARGET_SH" switch-start >/dev/null 2>&1
  ui_print "- ✅ 已热更新：开关监听 / 面板服务已按新版本重载，本次升级无需重启"
else
  ui_print "- ✅ 首次安装完成：重启后由 service.sh 启动内核与开关监听"
fi

# 面板 HTTP 服务：热更新后一律按新版本重建（管理器界面与浏览器共用它，
# 不重启就还是旧 httpd + 旧页面）。
#
# 这里必须用 restart 而不是 start：web_start() 开头有「已在运行就直接返回」的短路，
# 更新前若 httpd 还活着（webui-stop 未生效 / pid 文件丢失），start 会原样复用旧进程，
# 于是新版本的 httpd.conf（MIME、CGI 解释器声明）与新 ui/ 都不会被重新加载 ——
# 表现就是「更新模块后打开还是旧样子」。
# 监听范围（webui 设置）在 stop/start 全程保持不动，重启后按用户原设置恢复。
if [ "$_act" = "update" ] && [ -f "$_TARGET_SH" ]; then
  _wb_out=$(sh "$_TARGET_SH" webui-restart 2>&1)
  case "$_wb_out" in
    OK:*)
      ui_print "- 面板服务已按新版本重启（监听范围按你的设置恢复）"
      printf '%s\n' "$_wb_out" | grep -E '^  \[' | while IFS= read -r _l; do ui_print "  $_l"; done
      ;;
    *)
      # 以前失败只说「将在重启后生效」，看不出是端口被占还是缺 busybox，
      # 只能靠猜。这里把真实原因打出来。
      ui_print "- ⚠ 面板服务未能启动，请按下方提示处理："
      printf '%s\n' "$_wb_out" | head -4 | while IFS= read -r _l; do
        [ -n "$_l" ] && ui_print "  $_l"
      done
      ;;
  esac
fi

if [ "$_act" = "update" ]; then
  # 刷新模块描述里的运行状态（热更新后必须立即恢复 [🟢]/[🔴]/[⚪] 前缀）
  sh "$_TARGET_SH" syncdesc >/dev/null 2>&1
  # 暂存目录同步：管理器在 update 标记存在期可能读取 $MODPATH 的 module.prop
  if [ "$_SAME_PATH" != "1" ] && [ -f "$MODPATH/module.prop" ] && grep -q '^description=\[' "$INSTDIR/module.prop" 2>/dev/null; then
    _prefixed=$(grep '^description=' "$INSTDIR/module.prop" 2>/dev/null | head -1)
    _esc=$(printf '%s' "$_prefixed" | sed 's/[&/]/\\&/g')
    sed -i "s/^description=.*/$_esc/" "$MODPATH/module.prop" 2>/dev/null
    rm -f "$MODPATH/update" 2>/dev/null
  fi
  rm -f "$INSTDIR/update" 2>/dev/null
fi

ui_print "─────────────────────────────"
if [ "$_act" = "update" ]; then
  ui_print "  ✅ Mihomo Box 热更新完成（无需重启）"
  ui_print "  ⚠ 模块包内未包含代理内核"
  ui_print "  ⚠ 请在 KernelSU 管理器中打开本模块 WebUI"
  ui_print "  ·「内核管理」→ 下载内核（默认 jieluojun 分支）"
  ui_print "  ·「主页」→ 开启总开关启动内核"
  ui_print "  ·「工具」→ 面板服务：电脑 / 热点设备远程管理"
else
  ui_print "  ✅ Mihomo Box 首次安装完成"
  ui_print "  ⚠ 请先重启手机：模块与普通模块一样，重启后才被管理器接管"
  ui_print "     （重启前没有「打开 / 执行」按钮、开关不可用，这是正常状态）"
  ui_print "  ⚠ 模块包内未包含代理内核，重启后在管理器里打开本模块 WebUI："
  ui_print "  ·「内核管理」→ 下载内核（默认 jieluojun 分支）"
  ui_print "  ·「主页」→ 开启总开关启动内核"
  ui_print "  ·「工具」→ 面板服务：电脑 / 热点设备远程管理"
fi
ui_print "─────────────────────────────"
