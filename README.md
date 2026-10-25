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

本地同样可以手工打包（产物默认落在仓库的上一级）：

```bash
VERSION_STAMP=20261026-0128 sh build.sh "本版本更新说明"
```
