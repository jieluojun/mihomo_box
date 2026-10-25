# Browser application metadata

`AppInfo.java` is a read-only Android `app_process` helper. It resolves supplied
package names using the system context's PackageManager (primary user), obtains
localized labels, draws each icon on a 48×48 bitmap (first from the app's own
icon resource, adaptive icons composed layer by layer; the system-provided icon
is only a fallback, and solid-colour results are retried with the next method), and writes PNG data URIs and labels as JSON to stdout. It neither enumerates
nor changes the UI's installed-package list. Individual resource failures retain
the package name; whole-process errors allow the UI to fall back.

`sh tools/app-info/build-helper.sh` rebuilds the bundled `scripts/app-info.dex`
with JDK 11+, Android compile stubs and D8. Build dependencies are cached only on
the host and are not shipped. Android supplies the referenced framework and
org.json classes. `helper.sha256` ties the bundled source and executable to the
regression checks. Run the normal `sh build.sh` after rebuilding.

The browser reuses the existing authenticated CGI execution bridge. Label-only requests contain at most 1024 names and do not draw images.
Icon requests contain at most 96 names; app_process has a 25-second timeout. Icons and labels
are cached in browser memory for 10 minutes, not in a new on-disk icon directory.
Device runtime behavior (hidden system-context APIs, ROM resource handling) still
needs Android testing; host tests cannot execute the Android framework.
