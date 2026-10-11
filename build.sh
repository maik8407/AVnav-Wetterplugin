#! /bin/sh
# creates radaroverlay-<version>.zip for upload via AvNav Plugins page -> Upload
cd `dirname $0` || exit 1
base="radaroverlay"
version=`sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$base/plugin.json"`
name="$base-$version.zip"

echo "creating $name"
mkdir -p dist && rm -f dist/*.zip
zip -q "dist/$name" -r "$base" || exit 1
