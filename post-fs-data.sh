#!/system/bin/sh
# 早期启动阶段：确保运行目录存在
WORKDIR=/data/adb/mihomo_box
if [ -d "$WORKDIR" ]; then
  mkdir -p "$WORKDIR/run" 2>/dev/null

  # ⚠ 重启后上一次会话的「已装规则」状态全部失效：内核的 iptables / ip rule /
  # sysctl 已回到出厂态，但 run/ 里的状态文件还在。对账逻辑（_tunhs_sync_body /
  # _tproxy_sync_body）看到 ver=3 的旧状态、且网卡名/参数恰好没变时会「无变化
  # 早退」——于是 rp_filter=2、ip_forward=1、FORWARD 放行一条都装不上。
  # 开机自启路径（service.sh → boot → start_core）就带着这套半残接管环境进入
  # 飞行模式：飞行模式后 netd 整块重建蜂窝网卡（rp_filter/disable_ipv6 一并重置，
  # 新网卡按 conf/default 模板出生），而监听循环的周期对账已被精简掉，没人再把
  # rp_filter=2 追回来——严格反查 + TUN auto-route 的「from all not iif lo lookup
  # <tun>」把蜂窝回程包在入站就丢掉，表现就是：无网络、状态栏 x、
  # 高清通话(VoLTE/IMS)无服务、收不到短信，只能重启手机。
  # 手动 action.sh 启动之所以没事：上一步「关闭模块」走了 stop_core 全量拆除、
  # 状态文件已清，三角形启动是一次全新安装，sysctls 正常落地。
  # 这里在每次开机把状态清掉，让开机后的第一次对账走全量安装，两条路径等价。
  rm -f "$WORKDIR/run/tunhs.state" "$WORKDIR/run/tunhs.rp" \
        "$WORKDIR/run/tunhs.miss" "$WORKDIR/run/tunhs.pickfail" \
        "$WORKDIR/run/tproxy.state" "$WORKDIR/run/tproxy.cfg" \
        "$WORKDIR/run/tproxy.miss" "$WORKDIR/run/tproxy.fail" \
        "$WORKDIR/run/ipv6.want" "$WORKDIR/run/ipv6.net" "$WORKDIR/run/ipv6.last" \
        2>/dev/null
  # 同理清掉全部 pid / 启动中标记：run/ 在 /data 上跨重启保留，而上一会话的
  # 进程早已不存在，这些 pid 数字会被本轮开机的无关进程复用。各判活函数若
  # 只看 kill -0，就会把复用者误认成自己的进程 —— httpd.pid 中招时
  # web_start 以为「面板已在运行」直接短路，面板整个开机周期都起不来
  # （页面靠 Service Worker 缓存打开，请求全是 Failed to fetch），且概率性
  # 发生（取决于旧 pid 是否恰好被复用）。post-fs-data 是开机最早的落点，
  # 在这里清掉，各服务后续写下的都是本会话的真 pid。
  # ⚠ 例外：热重启（软重启）不满足「上一会话的进程早已不存在」——冷重启进程
  # 必死，热重启只重启框架层，detach 到根 cgroup 的内核/httpd/监听循环都活着。
  # 这里的 pid 清理只管「pid 数字被复用」的误判问题；活着的残留内核由
  # start_core/stop_core 的 core_sweep_stale（按 core/ 路径扫 /proc）负责清掉，
  # httpd 由 web_kill_port_holder、监听循环由 switch_sweep 各自防重入。
  # netmatch.state 同理必须按会话清理：网络匹配的 tick 按「上轮状态 ≠ 本轮状态」
  # 决定是否动作，而开机自启不看网络匹配、无条件拉起内核。若上一会话停在
  # 「matched」（如 WiFi 下停止了内核），状态文件跨重启残留会让开机后第一拍
  # 误判「无变迁」，WiFi → 停止服务 永远不执行。netmatch_tick 内另有 boot_id
  # 兜底（旧格式文件/非 Android 平台也能自愈），这里清掉属于双保险。
  rm -f "$WORKDIR/run/httpd.pid" "$WORKDIR/run/switch.pid" \
        "$WORKDIR/run/core.pid" "$WORKDIR/run/starting" \
        "$WORKDIR/run/live/lived.pid" "$WORKDIR/run/cpu.sample" \
        "$WORKDIR/run/dl.pid" "$WORKDIR/run/dl.fetch.pid" \
        "$WORKDIR/run/geo.pid" "$WORKDIR/run/geo.fetch.pid" \
        "$WORKDIR/run/us.pid" \
        "$WORKDIR/run/netmatch.state" \
        2>/dev/null
  # CGI 执行桥的残留请求目录：上一会话被 httpd 掐死（SIGKILL/SIGPIPE）的
  # webui.cgi.* 目录来不及走 trap 清理，开机时一并清掉（此刻必无活 CGI）。
  rm -rf "$WORKDIR/run"/webui.cgi.* 2>/dev/null
  # apn4 查询目录的同款残留（.apn4q.<pid>）：被杀的 apn4_rows 来不及走 EXIT
  # trap，开机时一并清掉（与 webui.cgi.* 同款逻辑；此刻必无活查询）。
  rm -rf "$WORKDIR/run"/.apn4q.* 2>/dev/null
  # 资源采样文件的同款残留（cpu.sample.<pid>）：res 热路径写一半被杀漏下的，
  # 一并清掉（run/cpu.sample 本体本就在上方清理清单里）。
  rm -f "$WORKDIR/run"/cpu.sample.* 2>/dev/null
fi
exit 0
