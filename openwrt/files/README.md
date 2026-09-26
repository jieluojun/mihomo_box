# Mihomo Box · OpenWrt 版

在 OpenWrt 路由器上一键部署 **mihomo 内核 + 网页面板**（含 procd 开机自启）。
面板与 Android 版是同一份 WebUI、同一个控制脚本，安装目录固定为 `/etc/mihomo_box`。

## 一键安装

```sh
# 在线（安装器自带自举：会自己拉程序包，失败可加 --mirror auto）
curl -fsSL https://raw.githubusercontent.com/jieluojun/mihomo_box/main/openwrt/install.sh | sh

# 离线：把 mihomo-box-openwrt-<版本>.tar.gz 传上路由器
tar -xzf mihomo-box-openwrt-<版本>.tar.gz -C /tmp && sh /tmp/install.sh
```

安装器会：按 CPU 架构从官方 release 下载 mihomo 内核 → 写默认配置 → 装面板 →
注册 `/etc/init.d/mihomo_box` 开机自启 → 启动服务 → 打印带令牌的面板地址。

常用参数：

| 参数 | 说明 |
|------|------|
| `--dir <路径>` | 安装目录（默认 `/etc/mihomo_box`） |
| `--port <端口>` | 面板端口（默认 `55555`） |
| `--token <字符串>` | 指定面板访问令牌（默认随机；`--no-auth` 关闭校验） |
| `--core <文件\|URL>` | 用本地 / 指定直链的内核（`.gz` 或裸 ELF） |
| `--core-version <v>` | 指定内核版本（如 `v1.19.31`），默认最新正式版 |
| `--variant <变体>` | `amd64`: compatible/v2/v3；`mips`/`mipsle`: softfloat/hardfloat；`loong64`: abi1/abi2 |
| `--mirror <前缀>` | GitHub 加速前缀（如 `https://ghfast.top/`）；`auto` 用内置镜像列表 |
| `--install-tun` | 顺带装 `kmod-tun`（配置里用 TUN 接管流量时需要） |
| `--no-core` | 只装面板与命令行，内核稍后自备 |
| `--no-start` | 安装完不启动服务 |
| `--uninstall [--purge]` | 卸载（默认保留 `config.yaml` 与内核） |

## 目录结构

```
/etc/mihomo_box/
├── config.yaml              主配置（面板里也能改，两边同一个文件）
├── module-settings.conf     模块设置：面板端口 / 令牌开关 / 自启 / 下载镜像
├── core/mihomo-official     内核（官方 release，按架构自动选）
├── scripts/mihomo-module.sh 模块控制脚本（与 Android 端同一份，路由器命令在下一层）
├── scripts/mihomo.sh        调度器 —— 面板前端固定调用的入口，等价 box.sh
├── scripts/box.sh           命令行入口（软链为 /usr/bin/mihomo-box）
├── scripts/lib/common.sh    公共库：镜像 / 版本探测 / 按架构装内核
├── webroot/ui/…             面板 WebUI（含 cgi-bin 执行桥）
├── webroot/index.html       跳转页
└── run/…                    pid / 日志 / 访问令牌 / 状态缓存
```

## 命令行

```sh
mihomo-box help                 # 全部命令
mihomo-box info                 # 面板 + 内核状态摘要（人看的）
mihomo-box status               # 原始状态 JSON（面板前端就是解析它，别改成人类可读）
mihomo-box panel-url            # 打印带令牌的面板地址（多网卡都会列出）
mihomo-box logs                 # 内核日志（logs-clear 清空）
mihomo-box test                 # 用当前配置做一次 mihomo -t 校验
mihomo-box update-core          # 按 CPU 架构更新内核到最新正式版
mihomo-box core-import /tmp/mihomo.gz    # 用本地文件换内核
mihomo-box check-env            # 环境自检：架构 / TUN / curl / 端口 / 空间 …
mihomo-box restart | start | stop
mihomo-box uninstall [--purge]
```

`get` / `set` / `api` / `webui-*` / `logs` 等命令与 Android 端语义一致，直接透传给
模块控制脚本。面板「设置 → 开机自启」开关写的是 procd（UCI `enabled` +
`/etc/init.d/mihomo_box enable|disable`），不是只写一个模块设置键。

## 面板上的平台差异

面板会自动识别平台（后端 `status` 的 `platform` 字段），路由器上：

* 「内核」页只保留**一个**上游内核卡片：更新到最新版 / 刷新信息 / 本地导入（目录选择器
  默认从 `/tmp` 开始）；分支内核（Smart 策略组 / eBPF 入站）不提供。
* 隐藏 Android 专有功能：热点共享代理、系统 IPv6、Tproxy 一键接管、应用级代理、网络匹配。
* 「关于」卡片只列官方内核。

## 服务

```sh
/etc/init.d/mihomo_box start|stop|restart|enable|disable
uci set mihomo_box.main.enabled=0 && uci commit mihomo_box   # 临时停用服务
```

procd 监督的是 `box.sh supervise`：开机按设置拉起内核、面板 httpd 掉线自动拉起
（每 20s 检查）。**内核不自动重启** —— 面板上点了「停止」就该是停止。

## 关于接管流量

* **TUN 模式**（推荐）：`config.yaml` 里 `tun: {enable: true, stack: system}`，
  需要 `/dev/net/tun`（`--install-tun` 或 `opkg install kmod-tun`）。
* **TPROXY**：本包**不改动系统防火墙**，需要的话按 mihomo 文档自行配置 nftables
  （OpenWrt 22.03+ 是 fw4/nft）。
* 局域网直连规则已经在默认配置里写好，别删掉，否则内网流量会绕代理。

## 卸载

```sh
mihomo-box uninstall            # 停服务、删程序与面板，保留 config.yaml 与内核
mihomo-box uninstall --purge    # 连配置与内核一起删
```

## 常见问题

**装完面板打不开？** `mihomo-box check-env` 看面板是否在跑、端口是否被占；
`mihomo-box panel-url` 会打印完整地址（含令牌）。

**提示没有 curl？** 面板能用，但「订阅更新」和部分写入操作会失败。装一下：
`opkg update && opkg install curl ca-bundle`（25.x 是 `apk add curl ca-bundle`）。

**闪存太小装不下？** 内核解压后约 25–35 MB。装到有大分区的位置：
`sh install.sh --dir /mnt/sda1/mihomo_box`（`/etc/mihomo_box` 也可以做成软链指过去）。

**面板令牌？** 路由器是网络设备，安装默认**开启**令牌校验，随机生成并打印链接；
不想用可以 `mihomo-box set webui_auth false`（面板「工具 → 面板服务」里也能改）。

**和 Android 版的关系？** 同一份控制脚本与面板源码，两处差异：安装路径，以及
路由器上不提供 Android 专有功能（应用级代理 / eBPF / 热点共享 / TPROXY 一键接管 /
网络匹配），面板里这些入口会自动隐藏。
