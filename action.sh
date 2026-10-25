#!/system/bin/sh
# KernelSU 管理器「运行」按钮：切换内核运行状态
# 全部工作（确保开关监听/面板服务存活 → 启停内核 → 刷新模块描述）在一个脚本进程内完成：
# 以前这里串行拉起 6 次 mihomo.sh（每次都要重新解析整份脚本）外加 3 秒固定 sleep，
# 点一下要等四五秒；现在耗时只剩内核真正启停的时间。
MODDIR=${0%/*}
exec sh "$MODDIR/scripts/mihomo.sh" action-toggle
