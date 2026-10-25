#!/system/bin/sh
# 开机启动服务（由 KernelSU/Magisk 在 boot_completed 后执行，运行在后台，
# 不受管理器 App 生命周期影响；无守护进程，仅按自启设置决定是否启动内核）
# 面板 HTTP 服务随开机常驻（管理器界面与浏览器共用它，由 boot 拉起）。
#
# 整条开机链只调用一次 mihomo.sh（boot 内部依次完成：面板 → 网络门槛 → 内核
# → 开关监听 → 就绪保障）。以前这里串行拉起 3 次脚本、还夹一个固定 sleep 3，
# 每次调用都要重新解析一份 9000+ 行的脚本（慢设备 100~200ms/次），固定 sleep
# 更是纯等待 —— 参考 Mishka 的启动链：就绪由「便宜的本机事实」判定（端口/
# 路由表），不再靠固定时长的盲等。
MODDIR=${0%/*}
WORKDIR=/data/adb/mihomo_box

# 等待系统启动完成。轮询粒度 0.5s：用 2s 粒度时，boot_completed 置位后平均
# 还要白等 1s 才进 boot（面板/内核整条链都被推后）；0.5s 的代价只是开机最后
# 这段时间里多 fork 几次 getprop，收益是启动链提前最多 1.5s。
# 极少数 sleep 只认整秒的实现回退 1s，行为与旧版一致。
until [ "$(getprop sys.boot_completed)" = "1" ]; do
  sleep 0.5 2>/dev/null || sleep 1
done

# 面板先行、网络门槛、内核启动全在 boot 内部按顺序完成：
#   · 面板不依赖网络与内核，先拉起，开机后立刻能打开（旧路径先等网络，
#     最长 90 秒内打开管理器只能撞连接拒绝）；
#   · 网络门槛已改为「默认路由出现即放行」（读 /proc/net/route，毫秒级），
#     不再 ping 循环 90 秒；
#   · 内核对齐就绪判据后，真机上通常 0.6~1.5 秒返回，不再固定等 3 秒。
sh "$MODDIR/scripts/mihomo.sh" boot
exit 0
