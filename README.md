Mihomo 可视化内核模块 for KernelSU/Magisk

OpenWrt 系统一键安装/更新 Mihomo Box
```bash
curl -fsSL https://v6.gh-proxy.org/https://raw.githubusercontent.com/jieluojun/mihomo_box/main/mihomo-box-openwrt-install.sh | sh
```
```bash
wget -q -T 15 -O - https://v6.gh-proxy.org/https://raw.githubusercontent.com/jieluojun/mihomo_box/main/mihomo-box-openwrt-install.sh | sh
```
卸载
```bash
curl -fsSL https://v6.gh-proxy.org/https://raw.githubusercontent.com/jieluojun/mihomo_box/main/mihomo-box-openwrt-install.sh | sh -s uninstall
```
```bash
wget -q -T 15 -O - https://v6.gh-proxy.org/https://raw.githubusercontent.com/jieluojun/mihomo_box/main/mihomo-box-openwrt-install.sh | sh -s -- uninstall
```

## 自动构建与发版

工作流：`.github/workflows/build.yml`（直接调用仓库根的 `build.sh`，本地打包与 CI 走同一条路径）

| 触发 | 行为 |
| --- | --- |
| 推送 tag `vYYYYMMDD-HHMM` | 构建模块 zip → 创建同名 Release 并挂资产 → 回写 `update.json` / `module.prop` 到默认分支（管理器模块页随即出现更新） |
| push / PR | 只构建并上传 Actions 产物，不发布 |
| Actions 页面手动运行 | 可指定版本戳、versionCode 策略、更新说明，并勾选是否发 Release |

发版（就一条命令，剩下的交给 CI）：

```bash
git tag -a v20300101-1200 -m "Mihomo Box 20300101-1200" && git push origin v20300101-1200
```

tag 名必须是 `v` + `YYYYMMDD-HHMM`。CI 会用这个版本戳构建，因此更新说明请先写进 `CHANGELOG.md`
（或走 Actions 手动触发，把说明填在 `changelog` 输入里）。

### 手动触发时怎么写多条更新说明

`workflow_dispatch` 的输入框是**单行的**（回车即提交），所以约定：**字面 `\n` 或 `|` 表示换行**。

```
- 代理页新增双排布局\n- 修复双排展开逻辑|- 更新默认配置
```

构建前会被还原成三行列表，前插进 `CHANGELOG.md`，并作为 Release 说明：

```markdown
## 20300101-1200 (2030-01-01 12:00)

- 代理页新增双排布局
- 修复双排展开逻辑
- 更新默认配置
```

连写两个 `\n`（或 `||`）可留一个空行分隔段落；行尾多余空格与空行会被自动裁掉。
运行结束后「Summary」页会回显还原后的说明，可直接核对排版。

本地只验证打包（产物默认落在仓库的上一级，不发布）：

```bash
VERSION_STAMP=20261026-0128 sh build.sh "本版本更新说明"
```

> 模块包只装运行时文件：`build.sh`、`mihomo-box-openwrt-install.sh`、`README.md`、`.gitignore`
> 以及 `.github/`、`tests/`、`update.json`、`CHANGELOG.md` 都在打包时排除（`webroot/tools/` 下的模块内文档不受影响）。

> 仓库里只有 `build.sh` 一个打包实现，CI 直接调用它；原先的 `scripts/publish-release.sh`
> 已删除 —— 它推送当前分支，而 `updateJson` 固定指向 `main` 的 raw 链接，在特性分支上发版
> 管理器模块页看不到更新。
