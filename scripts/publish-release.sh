#!/system/bin/sh
# ============================================================
# 在线更新一键发布：git 提交推送 + 打 tag + GitHub Release 挂模块 zip
#
# 前置条件：
#   - 在模块 git 仓库工作目录内执行（仓库根有 .git / build.sh / module.prop）
#   - 已先执行 sh build.sh ["更新说明"]（产物 zip、update.json、CHANGELOG.md 就位）
#   - 已安装 gh CLI 并登录（gh auth login）；git 可直接 push
#
# 用法： sh scripts/publish-release.sh [版本戳]
#   版本戳缺省 = module.prop 的 version 字段（即最近一次 build.sh 的版本）
#
# 发布完成后：管理器模块页拉取 update.json 比对 versionCode，
# 出现「更新」按钮，点击即下载 Release 资产刷入。
# ============================================================
set -e
cd "$(dirname "$0")/.."

STAMP="${1:-$(sed -n 's/^version=//p' module.prop | head -1)}"
[ -n "$STAMP" ] || { echo "错误：无法确定版本戳（请传参，或先跑 sh build.sh）"; exit 1; }
TAG="v$STAMP"
ZIP="../mihomo-box-$STAMP.zip"
[ -f "$ZIP" ] || { echo "错误：未找到 $ZIP —— 请先执行 sh build.sh"; exit 1; }
[ -f update.json ] || { echo "错误：未找到 update.json —— 请先执行 sh build.sh"; exit 1; }

command -v git >/dev/null 2>&1 || { echo "错误：缺少 git"; exit 1; }
[ -d .git ] || { echo "错误：当前目录不是 git 仓库（.git 不存在）"; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "错误：缺少 gh CLI（https://cli.github.com）。也可按 build.sh 末尾提示手动发布"; exit 1; }

# 防发错：update.json 必须与本次版本戳一致（避免推了旧描述文件）
grep -q "\"version\": \"$STAMP\"" update.json || { echo "错误：update.json 的版本不是 $STAMP —— 请重新执行 sh build.sh"; exit 1; }

# 取 CHANGELOG.md 里本版本条目做 Release 说明（取不到用兜底文案）
NOTES=$(sed -n "/^## $STAMP /,/^## /{/^## $STAMP /d;/^## /q;p;}" CHANGELOG.md 2>/dev/null)
[ -n "$NOTES" ] || NOTES="详见 CHANGELOG.md"

echo "→ 提交并推送源码与更新描述（update.json / CHANGELOG.md / module.prop）..."
git add -A
git commit -m "release: $STAMP" >/dev/null 2>&1 || echo "  （无新改动，跳过 commit）"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push origin "$BRANCH"

echo "→ 打 tag $TAG ..."
git tag -f "$TAG" >/dev/null
git push -f origin "$TAG" >/dev/null 2>&1 || git push origin "$TAG"

echo "→ 创建 Release 并上传 $ZIP ..."
if gh release create "$TAG" "$ZIP" --title "Mihomo Box $STAMP" --notes "$NOTES"; then
  echo "  Release $TAG 已创建"
else
  echo "  Release $TAG 已存在，改传资产（覆盖同名文件）"
  gh release upload "$TAG" "$ZIP" --clobber
fi

echo ""
echo "✅ 发布完成：管理器 模块页 → Mihomo Box 即可看到更新（updateJson 拉取 $BRANCH 分支的 update.json）"
