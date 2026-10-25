#!/system/bin/sh
# 开机启动服务（由 KernelSU/Magisk 在 boot_completed 后执行，运行在后台，
# 不受管理器 App 生命周期影响；无守护进程，仅按自启设置决定是否启动内核）
# 面板 HTTP 服务随开机常驻（管理器界面与浏览器共用它，由 boot 拉起）。
MODDIR=${0%/*}
WORKDIR=/data/adb/mihomo_box

# 等待系统启动完成
until [ "$(getprop sys.boot_completed)" = "1" ]; do
  sleep 5
done
# 面板先行：httpd 只是本机 HTTP 服务，不依赖网络，没理由排在 wait-net
# 后面。以前 wait-net 最长等约 90 秒（网络差/ICMP 被拦时必满额），这段
# 时间里打开管理器只能撞连接拒绝、或靠 Service Worker 缓存打开一个所有
# 请求都 Failed to fetch 的空壳，极像「面板坏了」。先把面板拉起来，后面
# boot 里的 web_start 会验明身份后短路复用，不会重复启动。
sh "$MODDIR/scripts/mihomo.sh" webui-start >/dev/null 2>&1
# 等待网络基本就绪（失败也不阻塞启动）
sh "$MODDIR/scripts/mihomo.sh" wait-net >/dev/null 2>&1
sleep 3

sh "$MODDIR/scripts/mihomo.sh" boot
exit 0
