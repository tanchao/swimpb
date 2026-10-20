#!/bin/sh
# Copy the static site into dist/ for Cloudflare Pages.
# The Pages Function stays at functions/ and is not part of this output.
set -eu
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
cp index.html dist/index.html
cp -R app dist/app
cp pages/_headers dist/_headers
