// ============================================================
// Mihomo Box WebUI — Service Worker（无版本号版）
//
// 目标不变：面板能装成 PWA，弱网/断网时仍能打开界面。
// 换代方式：SW 侧靠 INSTALL_STAMP 指纹（刷入一次变一次 → install/activate 重跑）；
// 资源 URL 侧带 ?v= 版本戳（index.html 由 build.sh 烘焙、customize.sh 每次刷入重写），
// 让管理器 WebView（不注册 SW）的 HTTP 缓存也无法复用上一版 JS/CSS。
// 「刷入即用当前版本面板」改由两个现场指纹驱动（都由 customize.sh 在刷入时写入）：
//   1) 本文件的 INSTALL_STAMP：刷入一次改一次，sw.js 字节随之变化，
//      浏览器据此认定 SW 有更新 → install/activate 重跑；
//   2) webroot/install.stamp：前端每次进页面比对，不一致就清缓存并重载一次
//      （管理器 WebView 不注册 SW，靠这条兜底）。
// activate 里无条件清空全部 Cache Storage，再用磁盘上此刻的文件重建 ——
// 旧版 shell 缓存、上一代 mihomo-box-vNN、半截实验缓存一并消失。
//
// 两条硬性约束（沿用旧版）：
//  1) 绝不拦截 /cgi-bin/ —— 那是 root 执行桥，全是 POST 且结果实时。
//  2) 静态资源「网络优先、失败回退缓存」—— 模块重刷后文件会变，缓存优先会一直看旧界面。
// ============================================================

// INSTALL_STAMP 由 customize.sh 在每次刷入模块时改写为本次模块版本戳。
// 它只用于让本文件字节随刷入改变（触发浏览器更新检查），不参与缓存命名，
// 也无需人工维护 —— 请勿在源码里手填成固定值以外的东西。
const INSTALL_STAMP = 'dev';

// 缓存名固定：不带版本号。换代清扫不再靠「名字不同」，而是靠 activate 全清。
const CACHE = 'mihomo-box-shell';

// 首屏必需资源。全部为裸路径（不带 ?v= 版本查询串 —— 页面实际请求带戳 URL，
// 首次未命中会走网络并按完整 URL 存入缓存；这里预热的裸路径用于离线兜底）。
// 面板自身的全部 JS 一并预缓存：远程访问 / 已安装的 PWA 再次进入时，
// 外壳与代码直接命中缓存（弱网、热点刚起、httpd 刚重启都不必等网络），
// 首屏骨架立刻可画，设备数据回来后再换成真实内容。
// 新增 js 文件时请同步这里 —— dev-tests/bundle-hygiene-test.mjs 会按 js/ 目录逐一对账。
const PRECACHE = [
  '.',
  'index.html',
  'css/style.css',
  'img/icon-192.png',
  'img/icon-512.png',
  'js/vendor/js-yaml.min.js',
  'js/app.js',
  'js/config-references.js',
  'js/controller-client.js',
  'js/core.js',
  'js/executor.js',
  'js/fields.js',
  'js/kernelsu.js',
  'js/log-redaction.js',
  'js/mihomo-api.js',
  'js/page-proxies.js',
  'js/pages-config.js',
  'js/pages-core.js',
  'js/pages-flow.js',
  'js/proxy-uri-sheet.js',
  'js/proxy-uri.js',
  'js/qr.js',
  'js/reference-delete.js',
  'js/subscription-actions.js',
];

// 一律绕过浏览器 HTTP 缓存取源：去掉 ?v= 查询串之后，不能再让 disk cache 把旧文件递上来
function reloadReq(u) {
  try { return new Request(u, { cache: 'reload' }); } catch (e) { return u; }
}

async function precache() {
  const c = await caches.open(CACHE);
  // 逐个 add，单个资源 404 不至于让整个安装失败
  await Promise.all(PRECACHE.map(u => c.add(reloadReq(u)).catch(() => {})));
}

// 清空本源全部缓存（含旧版本留下的任何命名）
async function purgeAll() {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await precache();
    self.skipWaiting();     // 不等旧页面全部关闭，立即接管
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 刷入即清：把 Cache Storage 清空，再按当前磁盘文件重建。
    // 这一步是「每次刷入都用当前版本面板」的落点 —— 与版本号无关，只看刷入动作。
    await purgeAll();
    await precache();
    await self.clients.claim();
  })());
});

// 前端可主动请求清缓存（例如用户点了「清理缓存」）
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'PURGE') {
    e.waitUntil((async () => { await purgeAll(); await precache(); })());
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // 只管 GET；POST（执行桥）一律放行
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // 跨域不管
  if (url.pathname.includes('/cgi-bin/')) return;       // 执行桥不缓存
  // manifest 必须始终取最新：浏览器靠比对它决定是否更新已安装应用的名称/图标/主题色
  if (url.pathname.endsWith('.webmanifest')) return;
  // 刷入指纹文件：永远直连网络，绝不能拿到缓存里的旧值（否则比对失真）
  if (url.pathname.endsWith('/install.stamp')) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // 静态资源（JS / CSS / 图片 / 字体）：缓存优先，0ms 极速直出
    if (req.mode !== 'navigate') {
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200 && fresh.type === 'basic') {
          e.waitUntil(cache.put(req, fresh.clone()).catch(() => {}));
        }
        return fresh;
      } catch (err) {
        throw err;
      }
    }

    // 导航请求（打开/刷新页面）：先给网络尝试，失败回退缓存
    const attempts = 2;
    for (let i = 0; i < attempts; i++) {
      try {
        const fresh = await fetch(reloadReq(req));
        if (fresh && fresh.status === 200 && fresh.type === 'basic') {
          e.waitUntil(cache.put(req, fresh.clone()).catch(() => {}));
        }
        return fresh;
      } catch (err) {
        if (i < attempts - 1) continue;
        const hit = await cache.match(req);
        if (hit) return hit;
        const shell = await cache.match('index.html') || await cache.match('.');
        if (shell) return shell;
        throw err;
      }
    }
  })());
});
