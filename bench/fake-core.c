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

/* 取配置里的一个整数键（如 tproxy-port）。真内核会把 tproxy-port 实际绑起来，
 * 假内核只需要让脚本/面板在 `GET /configs` 里读到同一个值。 */
static int int_key_from_config(const char *path, const char *key) {
    if (!path) return 0;
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    char line[512];
    int v = 0;
    size_t klen = strlen(key);
    while (fgets(line, sizeof line, f)) {
        if (strncmp(line, key, klen) != 0) continue;
        char *colon = strchr(line, ':');
        if (!colon) continue;
        v = atoi(colon + 1);
        if (v > 0) break;
    }
    fclose(f);
    return v;
}

int main(int argc, char **argv) {
    int port = 0, testonly = 0;
    const char *conf = NULL;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-t")) testonly = 1;
        if (!strcmp(argv[i], "-f") && i + 1 < argc) conf = argv[i + 1];
        if (!strcmp(argv[i], "--port") && i + 1 < argc) port = atoi(argv[i + 1]);
    }
    int tproxy_port = int_key_from_config(conf, "tproxy-port");
    {
        const char *e = getenv("FAKE_TPROXY_PORT");
        if (e && *e) tproxy_port = atoi(e);
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
    /* 真内核在 tproxy-port 上同时开 TCP/UDP 透明代理入站；这里只需要「端口在听」，
     * 让脚本的端口就绪判定与 tproxy_port_listening 走真实路径。 */
    if (tproxy_port > 0 && tproxy_port != port) {
        int ts = socket(AF_INET, SOCK_STREAM, 0);
        if (ts >= 0) {
            setsockopt(ts, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
            struct sockaddr_in ta;
            memset(&ta, 0, sizeof ta);
            ta.sin_family = AF_INET;
            ta.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            ta.sin_port = htons((unsigned short)tproxy_port);
            if (bind(ts, (struct sockaddr *)&ta, sizeof ta) == 0) listen(ts, 16);
        }
    }
    /* 最小 RESTful 模拟：只回 GET /configs（脚本的「免重启接管」判定和面板的
     * mode 回读都只用这一个端点）。其它路径回 404，行为与真内核一致地「有响应
     * 但不是我们要的数据」，便于测回退分支。 */
    char body[512];
    int blen = snprintf(body, sizeof body,
        "{\"port\":0,\"socks-port\":0,\"redir-port\":0,\"tproxy-port\":%d,"
        "\"mixed-port\":0,\"allow-lan\":false,\"bind-address\":\"*\","
        "\"mode\":\"rule\",\"log-level\":\"info\",\"ipv6\":false,"
        "\"tun\":{\"enable\":false,\"device\":\"\",\"stack\":\"mixed\"}}",
        tproxy_port > 0 ? tproxy_port : 0);
    for (;;) {
        int c = accept(s, NULL, NULL);
        if (c < 0) continue;
        char req[1024];
        ssize_t n = read(c, req, sizeof req - 1);
        if (n <= 0) { close(c); continue; }
        req[n] = 0;
        int ok = strstr(req, "GET /configs") != NULL;
        char head[256];
        int hlen = snprintf(head, sizeof head,
            "HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n"
            "Connection: close\r\n\r\n",
            ok ? "200 OK" : "404 Not Found", ok ? blen : 2);
        if (write(c, head, hlen) < 0) { close(c); continue; }
        if (write(c, ok ? body : "{}", ok ? blen : 2) < 0) { close(c); continue; }
        close(c);
    }
    return 0;
}
