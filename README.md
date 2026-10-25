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

本地只验证打包（产物默认落在仓库的上一级，不发布）：

```bash
VERSION_STAMP=20261026-0128 sh build.sh "本版本更新说明"
```

> 仓库里只有 `build.sh` 一个打包实现，CI 直接调用它；原先的 `scripts/publish-release.sh`
> 已删除 —— 它推送当前分支，而 `updateJson` 固定指向 `main` 的 raw 链接，在特性分支上发版
> 管理器模块页看不到更新。
