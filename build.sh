#!/system/bin/sh
# ============================================================
# 打包脚本：版本号一律取「当前时间」，不再手工维护
#
#   module.prop 的 version    = YYYYMMDD-HHMM（Asia/Shanghai）
#   module.prop 的 versionCode = 递增整数（沿用下方 +1 策略，供管理器判断新旧；
#   必须落在 Int32 内：管理器用 org.json optInt 解析，YYMMDDHHMM 自 2022 年即溢出）
#   产物文件名                 = mihomo-box-<version>.zip
#
# 面板缓存：ui/index.html 里 JS/CSS 的资源 URL 带 ?v= 版本戳 —— 源码中是
# __PANEL_VER__ 占位，本脚本打包前烘焙为本次 $STAMP；customize.sh 刷入时还会
# 重写为「版本戳.刷入时刻」。URL 每次发包/刷入全变，浏览器与管理器 WebView
# （不注册 SW）的 HTTP 缓存都不可能再把上一版 JS/CSS 递上来。
# 另有两个现场指纹配合（sw.js 的 INSTALL_STAMP + ui/install.stamp）：
# 刷一次变一次，不存在版本号脱节或忘记递增的问题。
# 本脚本自检：__PANEL_VER__ 占位还在、sw.js 的指纹占位行还在；并剔除历史
# 单文件打包产物 app.bundle.js（已废弃 —— 设备必须直接运行源码文件）。
#
# 用法：  sh build.sh ["本版本更新说明"]
#   带更新说明时会前插到 CHANGELOG.md（管理器更新弹窗展示的 changelog 链接即该文件）
#
# —— 在线更新（root 管理器模块页）——
# KernelSU / Magisk Delta / APatch 等管理器读取 module.prop 的 updateJson 字段，
# 拉取 update.json 比对 versionCode，有新版本即在模块页显示「更新」，下载 zipUrl
# 指向的 Release 资产刷入。
# 发布只走 CI（.github/workflows/build.yml）：本脚本只负责「打包」，
#   git tag vYYYYMMDD-HHMM && git push origin vYYYYMMDD-HHMM
# 由 Actions 构建、建 Release（zip + sha256）、并把 update.json / module.prop /
# CHANGELOG.md 回写到默认分支。本地不再提供一键发布脚本：它推送的是当前分支，
# 而 updateJson 固定指向 main 的 raw 链接，在特性分支上发版管理器看不到更新。
# ============================================================
set -e
cd "$(dirname "$0")"

# —— GitHub 仓库配置（换仓库/分支只改这两行：updateJson 与 update.json 链接自动跟随）——
GITHUB_REPO="jieluojun/mihomo_box"
GITHUB_BRANCH="main"
CHANGELOG_TEXT="${1:-}"

# —— 时间版本号（固定用北京时间，避免设备时区不同导致版本忽大忽小）——
#   VERSION_STAMP=YYYYMMDD-HHMM 可指定版本戳（CI 按 tag 发布时必须与 tag 一致），
#   缺省取当前北京时间。产物名 / update.json / CHANGELOG 条目都用它。
STAMP="${VERSION_STAMP:-$(TZ='CST-8' date '+%Y%m%d-%H%M')}"
case "$STAMP" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]) : ;;
  *)
    echo "错误：VERSION_STAMP 格式应为 YYYYMMDD-HHMM，当前为「$STAMP」"
    exit 1
    ;;
esac
# versionCode 策略（用户要求：跳过 106/107，从 108 开始递增）：
#   - VERSION_CODE=<数字> 强制指定（写多少就是多少）
#   - VERSION_CODE=keep 沿用 module.prop 现有值（同一版本的重新打包：保住当前号，
#     不因为「重新打了一遍」就跳号）
#   - 否则读取 module.prop 现有 versionCode：
#       107 及更早（含 <=105 的旧值）→ 108（本次发布就是 108）
#       >=108 且 <100000 → +1 递增（108 之后逐版 +1）
#       其他（旧时间戳等）→ 108
# 必须落在 Int32 内（管理器用 optInt）
if [ "$VERSION_CODE" = "keep" ]; then
  CODE=$(grep -E '^versionCode=' module.prop 2>/dev/null | cut -d= -f2 | tr -d '\r' | head -n1)
  case "$CODE" in ''|*[!0-9]*) CODE=108 ;; esac
elif [ -n "$VERSION_CODE" ]; then
  CODE=$VERSION_CODE
else
  EXISTING=$(grep -E '^versionCode=' module.prop 2>/dev/null | cut -d= -f2 | tr -d '\r' | head -n1)
  if [ "$EXISTING" -ge 108 ] 2>/dev/null && [ "$EXISTING" -lt 100000 ] 2>/dev/null; then
    CODE=$((EXISTING + 1))
  else
    CODE=108
  fi
fi

echo "版本: $STAMP  (versionCode=$CODE)"
echo "缓存: 无版本号（刷入时按 $STAMP 打指纹，打开面板即清旧缓存）"

# 写回 module.prop（版本号 + 在线更新入口 updateJson）
UPDATE_JSON_URL="https://raw.githubusercontent.com/$GITHUB_REPO/$GITHUB_BRANCH/update.json"
if [ -f module.prop ]; then
  sed -i "s/^version=.*/version=$STAMP/; s/^versionCode=.*/versionCode=$CODE/" module.prop
  if grep -q '^updateJson=' module.prop; then
    sed -i "s|^updateJson=.*|updateJson=$UPDATE_JSON_URL|" module.prop
  elif grep -q '^versionCode=' module.prop; then
    sed -i "/^versionCode=/a updateJson=$UPDATE_JSON_URL" module.prop
  else
    printf 'updateJson=%s\n' "$UPDATE_JSON_URL" >> module.prop
  fi
fi

# 自检 1：ui/index.html 必须保留 __PANEL_VER__ 占位（打包时烘焙成资源 ?v= 版本戳）
# 注意查「?v=__PANEL_VER__」完整形式：只查裸 __PANEL_VER__ 会被注释里的字样骗过
# （源码若来自解包的 Release zip，URL 里是烘焙死的旧戳、占位符只出现在注释里）
grep -q '?v=__PANEL_VER__' webroot/ui/index.html 2>/dev/null \
  || echo "  ⚠ ui/index.html 缺少 ?v=__PANEL_VER__ 占位（?v= 版本戳无法烘焙，请检查是否被改成固定值）"

# 自检 1a：index.html 的 importmap 必须覆盖 js/ 下每一个模块。
# 漏一个 = 该模块的 import 走裸路径（不带版本戳），更新后会被缓存按旧 URL 命中，
# 出现「新 app.js + 旧模块」的新旧混搭（更新后第一次进面板是旧版、重进才新）。
for _jsf in webroot/ui/js/*.js; do
  _jsb=${_jsf##*/}
  grep -q "\"./js/$_jsb\": \"./js/$_jsb?v=" webroot/ui/index.html 2>/dev/null || {
    echo "  ✗ ui/index.html 的 importmap 缺少 js/$_jsb（新增 js 文件需同步登记，否则更新后会用到缓存里的旧模块）"; exit 1; }
done

# 自检 1b：单文件打包（app.bundle.js）已废弃 —— 设备必须直接运行源码文件，
#          否则源码修复到不了设备（历史教训：旧打包文件让面板一直跑已撤销的逻辑）
if [ -f webroot/ui/js/app.bundle.js ]; then
  rm -f webroot/ui/js/app.bundle.js
  echo "  已剔除历史产物 webroot/ui/js/app.bundle.js"
fi

# 自检 2：sw.js 必须保留 INSTALL_STAMP 占位行，否则刷入时打不上指纹
grep -q "^const INSTALL_STAMP = 'dev';" webroot/ui/sw.js 2>/dev/null \
  || echo "  ⚠ sw.js 缺少 INSTALL_STAMP 占位行（刷入时无法标记指纹，请检查是否被改成固定值）"

# 自检 3：打包产物里不带 install.stamp —— 它只在刷入时由 customize.sh 现场生成
rm -f webroot/ui/install.stamp 2>/dev/null

# 自检 4：webroot/ 下为面板根目录，包含跳转页 index.html + ui/ + tools/
# 旧版要求仅 index.html，现 ui/tools 已移入 webroot，允许这三项
if [ ! -f webroot/index.html ] || [ ! -d webroot/ui ] || [ ! -d webroot/tools ]; then
  echo "  ⚠ webroot/ 结构异常，期望包含 index.html、ui/、tools/，当前：$(ls -A webroot 2>/dev/null | tr '\n' ' ')"
fi
# 额外检查：webroot 根下不应直接出现面板文件（js/css/cgi-bin 等），避免双份
if [ -d webroot/js ] || [ -d webroot/css ] || [ -d webroot/cgi-bin ]; then
  echo "  ⚠ webroot/ 根下不应直接包含 js/css/cgi-bin，面板文件应在 webroot/ui/ 下"
fi

# 跳转页烘焙：包里的 webroot/index.html 永远从脚本模板现场生成（出厂默认端口），
# 保证它和运行时 web_sync_webroot() 写出来的同源，不会漂移。
if sh scripts/mihomo.sh webroot-render 55555 "" > webroot/index.html.new 2>/dev/null && [ -s webroot/index.html.new ]; then
  mv webroot/index.html.new webroot/index.html
else
  rm -f webroot/index.html.new
  echo "  ⚠ 跳转页渲染失败，保留现有 webroot/index.html"
fi

# （前端 JS 单文件打包 app.bundle.js 已移除：面板直接加载 js/ 源码文件，
#   修源码即生效，不会再出现「设备跑着旧打包逻辑」的错位。）

# 全部自有 shell/JS 做语法检查；不在构建机执行 Android 控制脚本。
for file in ./*.sh scripts/*.sh webroot/ui/cgi-bin/*.sh; do sh -n "$file"; done
for file in webroot/ui/js/*.js webroot/ui/js/vendor/*.js webroot/ui/sw.js; do
  node --input-type=module --check < "$file"
done
# 缺少依赖也是失败；只允许操作者显式跳过，不再把失败包装成成功。
if [ "${SKIP_TESTS:-0}" = "1" ] || [ ! -d tests ]; then
  echo "提示：未执行回归测试（SKIP_TESTS=1 或 tests 目录不存在）"
else
  (cd tests && node -e "require('jsdom')" 2>/dev/null) || { echo "  缺少 jsdom：请先 cd tests && npm install"; exit 1; }
  node tests/http-transport.mjs
  node tests/lifecycle.mjs
  node tests/app-info.mjs
  node tests/app-metadata-unified.mjs
  node tests/packages.mjs
  node tests/proxy-mode-groups.mjs
  node tests/proxy-group-icons.mjs
  node tests/proxy-health.mjs
  node tests/proxy-layout-stability.mjs
  node tests/controller-direct-reads.mjs
  node tests/controller-api.mjs
  node tests/subscription-progress.mjs
  node tests/dashboard-header.mjs
  node tests/theme-boot.mjs
  node tests/sw-precache.mjs
  node tests/e2e-boot.mjs
  node tests/dashboard-skeleton.mjs
  node tests/dashboard-logbox-blank-card.mjs
  node tests/smoke-all-pages.mjs
  node tests/service-restart-on-save.mjs
  node tests/status-invalidate.mjs
  node tests/tun-card.mjs
  node tests/ebpf-fields.mjs
  node tests/ebpf-enable-switch.mjs
  node tests/ebpf-inbound-listener.mjs
  node tests/ebpf-env-check.mjs
  node tests/tproxy-status.mjs
  node tests/source-sheet.mjs
  node tests/wrap-chip-drag.mjs
  node tests/sheet-grab.mjs
  node tests/config-test-feedback.mjs
  node tests/proxy-uri.mjs
  node tests/proxy-uri-layout.mjs
  node tests/proxy-invalidate.mjs
  node tests/core-lifecycle-api.mjs
  node tests/api-error-body.mjs
  node tests/ui-log-levels.mjs
  node tests/interaction-idle.mjs
  node tests/panel-background.mjs
  node tests/webui-addr-autoscan.mjs
  node tests/config-references.mjs
  node tests/outbound-flow.mjs
  python3 tests/backend-safety.py
  python3 tests/live-cache.py
  python3 tests/switch-loop-idle.py
  python3 tests/switch-transitions.py
  python3 tests/webui-addrs.py
  python3 tests/webui-port-guard.py
  python3 tests/ipv6-apply.py
  python3 tests/webroot-jump.py
  python3 tests/tproxy-applist.py
  python3 tests/ebpf-enabled-backend.py
  python3 tests/http-client-memory.py
  python3 tests/gzip-compat.py
  python3 tests/core-import.py
  python3 tests/customize-install-action.py
  python3 tests/customize-first-install.py
  node tests/core-import-ui.mjs
fi
OUTDIR=${OUTDIR:-..}
mkdir -p "$OUTDIR"
OUTDIR=$(cd "$OUTDIR" && pwd)
case "$OUTDIR/" in
  "$(pwd)/"*) echo "错误：产物目录不能位于源码目录内"; exit 1 ;;
esac
OUT="$OUTDIR/mihomo-box-$STAMP.zip"
# —— 面板资源版本戳烘焙：index.html 里的 __PANEL_VER__ → 本次版本戳 ——
# 打进包里的 index.html 因此带 ?v=$STAMP；刷入时 customize.sh 还会按
# 「版本戳.刷入时刻」再重写一次（同一包反复刷也作废旧缓存）。
# 第二条模式兜底：源码若来自解包的 Release zip，URL 里是烘焙死的旧版本戳
# （如 ?v=20261014-1101）而非占位符——一并归一成本次戳，不让包里带旧戳。
# （刷入时的重写让旧戳对用户无实际影响，但包内状态应与源码树一致。）
sed -i "s/?v=__PANEL_VER__/?v=$STAMP/g; s/?v=[0-9]\{8\}-[0-9]\{4\}/?v=$STAMP/g" webroot/ui/index.html

rm -f "$OUT"
# 打包排除：CI 配置、依赖与缓存、回归测试、发布描述文件、构建脚本自身，
# 以及本地/CI 运行残留（core/ run/ 是 scripts/mihomo.sh 在源码树上跑一次就会
# mkdir 出来的空目录，打进包里会变成模块目录中的空壳，刷入日志看着像缺文件）。
# build.sh 是开发机的打包脚本（依赖 sh/node/zip），设备上永远用不到，
# 留在包里只会被误当模块组件；发版走 CI 时同样靠这条排除。
rm -rf core run 2>/dev/null
zip -r -q "$OUT" . \
  -x '*.zip' 'node_modules/*' '*/node_modules/*' '.git/*' '*/.git/*' \
     '.github/*' '*/__pycache__/*' '*.pyc' \
     'tests/*' 'tests/node_modules/*' \
     'update.json' 'CHANGELOG.md' 'UPDATE.md' \
     'build.sh' \
     'core/*' 'run/*' '.DS_Store' '*.swp'
echo "产物: $OUT"

# 源码还原占位，下次打包继续烘焙（保持源码里永远是占位符，不落固定值）
sed -i "s/?v=$STAMP/?v=__PANEL_VER__/g" webroot/ui/index.html

# —— 生成 update.json：管理器在线更新的描述文件（仓库根目录随分支发布，不进模块包）——
TAG="v$STAMP"
cat > update.json <<EOF
{
  "version": "$STAMP",
  "versionCode": $CODE,
  "zipUrl": "https://github.com/$GITHUB_REPO/releases/download/$TAG/mihomo-box-$STAMP.zip",
  "changelog": "https://raw.githubusercontent.com/$GITHUB_REPO/$GITHUB_BRANCH/CHANGELOG.md"
}
EOF
echo "更新描述: update.json（tag=$TAG）"

# —— 更新日志：本版本条目前插到 CHANGELOG.md（管理器更新弹窗展示该文件的链接）——
if [ -n "$CHANGELOG_TEXT" ]; then
  {
    printf '## %s (%s)\n\n' "$STAMP" "$(TZ='CST-8' date '+%Y-%m-%d %H:%M')"
    printf '%s\n\n' "$CHANGELOG_TEXT"
    [ -f CHANGELOG.md ] && cat CHANGELOG.md
  } > CHANGELOG.md.tmp
  mv CHANGELOG.md.tmp CHANGELOG.md
  echo "更新日志: CHANGELOG.md 已前插 $STAMP 条目"
fi

cat <<EOF

—— 发布在线更新（管理器模块页出现「更新」按钮）——
  只在本地打了包、还没发布时，按下面一条命令交给 CI 完成剩余全部步骤：
      git tag -a $TAG -m "Mihomo Box $STAMP" && git push origin $TAG
  CI 会：构建同样的包 → 创建 Release $TAG 并挂 zip/sha256 → 把 update.json、
  module.prop、CHANGELOG.md 回写到 $GITHUB_BRANCH 分支。
  注意：本地产物 $OUT 不参与发布（CI 在自己那边重建，保证可复现）。
  若只想在本地验证打包结果，到此为止即可。
EOF
ls -la "$OUT"
