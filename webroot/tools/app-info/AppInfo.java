import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Paint;
import android.graphics.Canvas;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.os.Looper;
import android.util.Base64;
import android.util.TypedValue;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.lang.reflect.Method;
import java.util.HashSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Read-only metadata helper. No list enumeration or package/config modification. */
public final class AppInfo {
    private static final int SIZE = 48;
    private static String tfState = "tf?";

    /** 断点记录：native 断言会直接杀进程、来不及输出任何东西，所以每步先把位置写进文件，由外层脚本在失败时读出。 */
    private static void trace(String step) {
        String path = System.getenv("APPINFO_TRACE");
        if (path == null || path.length() == 0) return;
        try {
            FileOutputStream f = new FileOutputStream(path, false);
            try { f.write((tfState + " " + step).getBytes("UTF-8")); } finally { f.close(); }
        } catch (Throwable ignored) { }
    }

    /** 自适应图标的图层是 108dp，可见区域是中间 72dp；按 48px 画布折算：图层 72px，四周各溢出 12px。 */
    private static boolean drawAdaptive(Drawable icon, Canvas canvas) {
        try {
            Class<?> type = Class.forName("android.graphics.drawable.AdaptiveIconDrawable");
            if (!type.isInstance(icon)) return false;
            Drawable bg = (Drawable) type.getMethod("getBackground").invoke(icon);
            Drawable fg = (Drawable) type.getMethod("getForeground").invoke(icon);
            if (bg == null && fg == null) return false;
            int layer = SIZE * 108 / 72, pad = (layer - SIZE) / 2;
            Drawable[] layers = new Drawable[] { bg, fg };
            for (Drawable d : layers) {
                if (d == null) continue;
                Rect old = new Rect(d.getBounds());
                try {
                    if (d instanceof ColorDrawable) {
                        // 纯色图层直接填色，不经过 Drawable.draw（ROM 可能替换/改写它）
                        canvas.drawColor(((ColorDrawable) d).getColor());
                    } else {
                        d.setBounds(-pad, -pad, layer - pad, layer - pad);
                        d.draw(canvas);
                    }
                } finally {
                    d.setBounds(old);
                }
            }
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 画到 48x48；成功返回位图（调用方回收）。自适应图标按图层手动合成，绕开 AdaptiveIconDrawable 内部的遮罩/着色器路径。 */
    private static Bitmap render(Drawable icon) throws Throwable {
        Bitmap bitmap = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888);
        try {
            Canvas canvas = new Canvas(bitmap);
            if (drawAdaptive(icon, canvas)) return bitmap;
            Rect old = new Rect(icon.getBounds());
            try {
                icon.setBounds(0, 0, SIZE, SIZE);
                icon.draw(canvas);
            } catch (Throwable drawErr) {
                // 硬件位图（Software rendering doesn't support hardware bitmaps）：拷成软件位图再画
                if (icon instanceof BitmapDrawable && ((BitmapDrawable) icon).getBitmap() != null) {
                    Bitmap soft = ((BitmapDrawable) icon).getBitmap().copy(Bitmap.Config.ARGB_8888, false);
                    if (soft == null) throw drawErr;
                    bitmap.eraseColor(0);
                    canvas.drawBitmap(soft, null, new Rect(0, 0, SIZE, SIZE), null);
                    soft.recycle();
                } else {
                    throw drawErr;
                }
            } finally {
                icon.setBounds(old);
            }
            return bitmap;
        } catch (Throwable t) {
            bitmap.recycle();
            throw t;
        }
    }

    /**
     * 只挂应用自己的 APK、不带任何 RRO 叠加层的 Resources。
     * ROM 的图标包/主题（通常以叠加层或资源重定向实现）会把应用的 android:icon 换成别的东西：
     * 自适应图标的背景被换成半透明白（近乎全白块），有的被换成 ROM 自己的 SymbolDrawable
     * （draw() 里画文字，在本进程里 native 断言中止）。绕开叠加层才能读到应用自己的图标。
     */
    private static Resources plainResources(PackageManager pm, ApplicationInfo app) {
        try {
            Resources base = pm.getResourcesForApplication(app);
            AssetManager am = AssetManager.class.getDeclaredConstructor().newInstance();
            Method add = AssetManager.class.getMethod("addAssetPath", String.class);
            Object cookie = add.invoke(am, app.sourceDir);
            if (!(cookie instanceof Integer) || ((Integer) cookie) == 0) return null;
            return new Resources(am, base.getDisplayMetrics(), base.getConfiguration());
        } catch (Throwable t) {
            return null;
        }
    }

    private static String rawErr = "";

    private static Bitmap scaleTo48(Bitmap src) {
        Bitmap out = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888);
        new Canvas(out).drawBitmap(src, null, new Rect(0, 0, SIZE, SIZE), new Paint(Paint.FILTER_BITMAP_FLAG));
        return out;
    }

    /** 直接解码应用 APK 里的图标文件（PNG/WebP/JPEG），不经过 Drawable 体系；XML 图标或解不出来返回 null，原因记在 rawErr。 */
    private static Bitmap decodeRaw(Resources res, ApplicationInfo app) {
        rawErr = "";
        if (app.icon == 0) { rawErr = "noicon"; return null; }
        // 方式一：openRawResource（按当前配置选最合适的那份文件）
        InputStream in = null;
        Bitmap src = null;
        try {
            in = res.openRawResource(app.icon);
            src = BitmapFactory.decodeStream(in);
            if (src != null) return scaleTo48(src);
            rawErr = "stream=null";
        } catch (Throwable t) {
            rawErr = "raw:" + t;
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignored) { }
            if (src != null) src.recycle();
            src = null;
        }
        // 方式二：查出资源文件在 APK 里的路径，直接从 zip 里读
        ZipFile zf = null;
        try {
            TypedValue tv = new TypedValue();
            res.getValue(app.icon, tv, true);
            String path = tv.string == null ? null : tv.string.toString();
            if (path == null) { rawErr += " path=null"; return null; }
            if (path.endsWith(".xml")) { rawErr += " xml"; return null; }
            zf = new ZipFile(app.sourceDir);
            ZipEntry e = zf.getEntry(path);
            if (e == null) { rawErr += " nozip:" + path; return null; }
            in = zf.getInputStream(e);
            src = BitmapFactory.decodeStream(in);
            if (src == null) { rawErr += " zip-decode=null"; return null; }
            return scaleTo48(src);
        } catch (Throwable t) {
            rawErr += " zip:" + t;
            return null;
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignored) { }
            try { if (zf != null) zf.close(); } catch (Throwable ignored) { }
            if (src != null) src.recycle();
        }
    }

    /** 近乎全白（不透明且 RGB≥235 的像素占比）——白块的另一种形态（纯白底+白图案时不是严格同色）。 */
    private static boolean pale(Bitmap bitmap) {
        int[] px = new int[SIZE * SIZE];
        bitmap.getPixels(px, 0, SIZE, 0, 0, SIZE, SIZE);
        int n = 0;
        for (int p : px) {
            if (((p >>> 24) & 0xff) >= 200 && ((p >> 16) & 0xff) >= 235 && ((p >> 8) & 0xff) >= 235 && (p & 0xff) >= 235) n++;
        }
        return n * 100 >= px.length * 92;
    }

    private static String describe(Drawable icon, Bitmap bitmap) {
        StringBuilder sb = new StringBuilder(icon.getClass().getSimpleName());
        try {
            Class<?> type = Class.forName("android.graphics.drawable.AdaptiveIconDrawable");
            if (type.isInstance(icon)) {
                Drawable bg = (Drawable) type.getMethod("getBackground").invoke(icon);
                Drawable fg = (Drawable) type.getMethod("getForeground").invoke(icon);
                sb.append(" bg=").append(bg == null ? "null" : bg.getClass().getSimpleName());
                if (bg instanceof ColorDrawable) sb.append("#").append(Integer.toHexString(((ColorDrawable) bg).getColor()));
                sb.append(" fg=").append(fg == null ? "null" : fg.getClass().getSimpleName());
            }
        } catch (Throwable ignored) { }
        sb.append(" px=").append(Integer.toHexString(bitmap.getPixel(2, 2))).append("/").append(Integer.toHexString(bitmap.getPixel(SIZE / 2, SIZE / 2)));
        return sb.toString();
    }

    /** 整张图是同一种颜色（纯白 / 纯透明）——多半是没画出内容，换下一种取法再试。 */
    private static boolean uniform(Bitmap bitmap) {
        int[] px = new int[SIZE * SIZE];
        bitmap.getPixels(px, 0, SIZE, 0, 0, SIZE, SIZE);
        for (int i = 1; i < px.length; i++) if (px[i] != px[0]) return false;
        return true;
    }

    private static String encode(Bitmap bitmap) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes);
        if (bytes.size() > 32768) return null;
        return "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
    }

    public static void main(String[] args) {
        try {
            if (Looper.myLooper() == null) Looper.prepareMainLooper();
            Class<?> type = Class.forName("android.app.ActivityThread");
            Method systemMain = type.getDeclaredMethod("systemMain");
            systemMain.setAccessible(true);
            Object thread = systemMain.invoke(null);
            Method getContext = type.getDeclaredMethod("getSystemContext");
            getContext.setAccessible(true);
            Context context = (Context) getContext.invoke(thread);
            PackageManager pm = context.getPackageManager();
            OutputStreamWriter out = new OutputStreamWriter(System.out, "UTF-8");
            out.write("[");
            boolean labelsOnly = args.length > 0 && "--labels".equals(args[0]);
            boolean iconsOnly = args.length > 0 && "--icons".equals(args[0]);
            if (!labelsOnly) {
                // app_process 不是 zygote，Typeface 没被预加载：ROM 的图标处理（或任何画文字的图标）
                // 一碰到默认字体就会 native 断言中止整个进程（Assertion failed: gDefaultTypeface == nullptr）。
                // 先触发一次 Typeface 的静态初始化。
                try {
                    tfState = Typeface.DEFAULT != null ? "tf=ok" : "tf=null";
                } catch (Throwable e) {
                    String m = String.valueOf(e);
                    tfState = "tf=ERR " + (m.length() > 60 ? m.substring(0, 60) : m);
                }
                trace("start");
            }
            boolean first = true;
            HashSet<String> seen = new HashSet<String>();
            for (String name : args) {
                if (!name.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)*") || !seen.add(name)) continue;
                JSONObject row = new JSONObject();
                row.put("packageName", name);
                if (!iconsOnly) row.put("appLabel", name);
                try {
                    ApplicationInfo app;
                    try {
                        app = pm.getApplicationInfo(name, 0);
                    } catch (Throwable notFound) {
                        // 被停用/冻结的应用：flag 0 查不到，带上 MATCH_DISABLED_COMPONENTS|MATCH_UNINSTALLED_PACKAGES 再试
                        app = pm.getApplicationInfo(name, 0x200 | 0x2000);
                    }
                    row.put("uid", app.uid);
                    if (!iconsOnly) {
                        CharSequence label = pm.getApplicationLabel(app);
                        if (label != null && label.length() > 0) row.put("appLabel", label.toString());
                    }
                    if (!labelsOnly) {
                        String iconErr = null, fallbackIcon = null, notes = "";
                        // 0：直接读应用自己的图标资源——绕开 ROM 对图标的二次加工（主题换肤/套底板，
                        //    有的 ROM 会把自适应图标处理成纯白块，或在这一步画文字而崩溃）；
                        // 1~3：系统 PackageManager 的几种取法，作兜底。
                        for (int attempt = 0; attempt < 5; attempt++) {
                            Bitmap bitmap = null;
                            try {
                                trace(name + " a" + attempt + " load");
                                Drawable icon;
                                Resources useRes = null;
                                if (attempt <= 1) {
                                    if (app.icon == 0) { iconErr = "no icon resource"; if (attempt == 0) notes += "a0:noicon "; continue; }
                                    if (attempt == 0) {
                                        useRes = plainResources(pm, app);
                                        if (useRes == null) { notes += "a0:noplain "; continue; }
                                    } else useRes = pm.getResourcesForApplication(app);
                                    icon = useRes.getDrawableForDensity(app.icon, 320);
                                } else {
                                    useRes = pm.getResourcesForApplication(app);
                                    if (attempt == 2) icon = pm.getApplicationIcon(app);
                                    else if (attempt == 3) icon = pm.getApplicationIcon(name);
                                    else icon = app.loadIcon(pm);
                                }
                                if (icon == null) { iconErr = "icon=null"; continue; }
                                trace(name + " a" + attempt + " render " + icon.getClass().getSimpleName());
                                String cls = icon.getClass().getName();
                                if (!cls.startsWith("android.graphics.drawable.")) {
                                    // ROM 自定义的 Drawable（如 HyperOS 的 SymbolDrawable 会在 draw() 里画文字，
                                    // 在本进程里直接 native 断言中止）：先直接解码 APK 里的图标文件，绕开它
                                    bitmap = decodeRaw(useRes, app);
                                    if (bitmap != null) notes += "a" + attempt + ":raw(" + icon.getClass().getSimpleName() + ") ";
                                    else if (cls.contains("Symbol")) {
                                        // 连系统的 getApplicationIcon 也会走到同一处崩溃，后备取法都不能再试
                                        notes += "a" + attempt + ":skip(" + icon.getClass().getSimpleName() + " " + rawErr + ") ";
                                        iconErr = "skip " + icon.getClass().getSimpleName() + ": " + rawErr;
                                        break;
                                    }
                                }
                                if (bitmap == null) bitmap = render(icon);
                                trace(name + " a" + attempt + " encode");
                                String data = encode(bitmap);
                                if (data == null) { iconErr = "png too large"; continue; }
                                if (uniform(bitmap) || pale(bitmap)) {
                                    // 纯色块：先留作最后的兜底，继续换取法
                                    if (fallbackIcon == null) fallbackIcon = data;
                                    iconErr = "uniform color (attempt " + attempt + ")";
                                    notes += "a" + attempt + ":uniform(" + describe(icon, bitmap) + ") ";
                                    continue;
                                }
                                row.put("icon", data);
                                iconErr = null;
                                if (attempt > 0) notes += "a" + attempt + ":ok";
                                break;
                            } catch (Throwable t) {
                                String m = String.valueOf(t);
                                iconErr = "attempt " + attempt + ": " + (m.length() > 100 ? m.substring(0, 100) : m);
                                notes += "a" + attempt + ":" + (m.length() > 50 ? m.substring(0, 50) : m) + " ";
                            } finally {
                                if (bitmap != null) bitmap.recycle();
                            }
                        }
                        if (!row.has("icon") && fallbackIcon != null) { row.put("icon", fallbackIcon); iconErr = null; }
                        if (iconErr != null) row.put("iconErr", iconErr);
                        if (notes.length() > 0) row.put("iconNote", notes.trim());
                    }
                } catch (Throwable ignored) {
                    // Package may have been uninstalled since the list was read.
                }
                if (!first) out.write(",");
                first = false;
                out.write(row.toString());
                out.flush();
            }
            out.write("]");
            out.flush();
            System.exit(0);
        } catch (Throwable error) {
            System.err.println("App metadata unavailable: " + error);
            System.exit(1);
        }
    }
}
