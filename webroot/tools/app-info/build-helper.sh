#!/bin/sh
# Host-only build: JDK 11+, curl, sha256sum. Never run by module installation.
set -eu
cd "$(dirname "$0")/../../.."
ROOT=$(pwd)
CACHE=${APP_INFO_BUILD_CACHE:-$HOME/.cache/mihomo-app-info-build}
mkdir -p "$CACHE/classes" "$CACHE/dex"
fetch() { [ -s "$CACHE/$1" ] || curl -fL --max-time 120 "$2" -o "$CACHE/$1"; }
fetch android.jar https://repo.maven.apache.org/maven2/com/google/android/android/4.1.1.4/android-4.1.1.4.jar
fetch json.jar https://repo.maven.apache.org/maven2/org/json/json/20090211/json-20090211.jar
fetch r8.jar https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.3.37/r8-8.3.37.jar
javac -encoding UTF-8 -source 8 -target 8 -cp "$CACHE/android.jar:$CACHE/json.jar" -d "$CACHE/classes" webroot/tools/app-info/AppInfo.java
java -cp "$CACHE/r8.jar" com.android.tools.r8.D8 --min-api 23 --lib "$CACHE/android.jar" --lib "$CACHE/json.jar" --output "$CACHE/dex" "$CACHE/classes/AppInfo.class"
cp "$CACHE/dex/classes.dex" scripts/app-info.dex
sha256sum webroot/tools/app-info/AppInfo.java scripts/app-info.dex > webroot/tools/app-info/helper.sha256
