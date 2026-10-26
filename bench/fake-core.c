/* ============================================================
 * bench/fake-core.c —— 启动/重载基准用的假内核
 *
 * 只为测量「脚本这一层」的启停关键路径，模拟真内核的两个关键时序：
 *   · `-t` 配置校验的耗时（真机上大配置 1~3 秒，见 FAKE_TEST_MS）
 *   · 从 exec 到控制器端口 LISTEN 的耗时（真机 0.3~0.6 秒，见 FAKE_LISTEN_MS）
 * 正常启动后监听 --port 指定的端口（默认 19090），收到 SIGTERM 立即退出——
 * 与 mihomo 的行为一致，便于测「重启」链路。
 *
 * 编译： gcc -O2 -o mihomo-jieluojun bench/fake-core.c
 * （bench/bench-startup.sh 会自动完成编译与摆放，不需要手工操作）
 * ============================================================ */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <time.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <netinet/in.h>

static void msleep(int ms) {
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (long)(ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
}

static int env_int(const char *k, int def) {
    const char *v = getenv(k);
    if (!v || !*v) return def;
    int n = atoi(v);
    return n < 0 ? def : n;
}

/* 从配置里取 external-controller 的端口（真内核也这么读配置）。
 * 只做最小解析：找到 external-controller 行，取最后一个冒号后的数字。 */
static int port_from_config(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    char line[512];
    int port = 0;
    while (fgets(line, sizeof line, f)) {
        char *p = strstr(line, "external-controller:");
        if (!p || p != line) continue;
        char *colon = strrchr(p, ':');
        if (!colon) continue;
        port = atoi(colon + 1);
        if (port > 0) break;
    }
    fclose(f);
    return port;
}

int main(int argc, char **argv) {
    int port = 0, testonly = 0;
    const char *conf = NULL;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-t")) testonly = 1;
        if (!strcmp(argv[i], "-f") && i + 1 < argc) conf = argv[i + 1];
        if (!strcmp(argv[i], "--port") && i + 1 < argc) port = atoi(argv[i + 1]);
    }
    if (port <= 0 && conf) port = port_from_config(conf);
    if (port <= 0) port = 19090;

    if (testonly) {
        msleep(env_int("FAKE_TEST_MS", 1500));
        /* FAKE_TEST_FAIL=1 模拟「配置不合法」：内核 -t 失败 */
        if (env_int("FAKE_TEST_FAIL", 0) == 1) {
            fprintf(stderr, "test failed: parse config error\n");
            return 1;
        }
        printf("configuration file test is successful\n");
        return 0;
    }

    msleep(env_int("FAKE_LISTEN_MS", 400));
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 1;
    int one = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = htons((unsigned short)port);
    if (bind(s, (struct sockaddr *)&a, sizeof a) != 0) {
        perror("bind");
        return 1;
    }
    listen(s, 16);
    for (;;) pause();
    return 0;
}
