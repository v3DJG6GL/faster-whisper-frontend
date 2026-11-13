#!/usr/bin/env bash
# Build the Arch package inside an archlinux:base-devel container, as root.
# Used by release.yml's `arch` job; also runs locally from the repo root:
#   docker run --rm -v "$PWD:/src" -w /src archlinux:base-devel packaging/arch/ci-build.sh
# Output: packaging/arch/faster-whisper-frontend-<ver>-<rel>-x86_64.pkg.tar.zst
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

# git/jq for this script, namcap for the lint. --needed keeps re-runs quick; -Syu
# because a partial upgrade (-Sy without -u) is unsupported on Arch.
pacman -Syu --noconfirm --needed git jq namcap
# depends= and makedepends=, so makepkg (run without --syncdeps, it has no
# root) finds them.
# shellcheck disable=SC1091
deps=$(source packaging/arch/PKGBUILD && printf '%s\n' "${depends[@]}" "${makedepends[@]}")
# shellcheck disable=SC2086
pacman -S --noconfirm --needed $deps

ver=$(jq -r .version src-tauri/tauri.conf.json)
pkgname=faster-whisper-frontend
echo "packaging $pkgname $ver"

# The checkout may belong to another uid (bind mount, runner workspace).
git config --global --add safe.directory "$root"
rm -f "packaging/arch/$pkgname-"*.tar.gz "packaging/arch/$pkgname-"*.pkg.tar.zst
git archive --prefix="$pkgname-$ver/" -o "packaging/arch/$pkgname-$ver.tar.gz" HEAD

# makepkg refuses to run as root.
id builder >/dev/null 2>&1 || useradd -m builder
work=$(mktemp -d)
cp packaging/arch/PKGBUILD "packaging/arch/$pkgname-$ver.tar.gz" "$work/"
chown -R builder: "$work"
sed -i "s/^pkgver=.*/pkgver=$ver/" "$work/PKGBUILD"
# HOME stays the builder's: pnpm's store and the downloaded pnpm itself land
# there, CARGO_HOME is set inside the PKGBUILD.
su builder -c "cd '$work' && makepkg --noconfirm --cleanbuild"

pkg=$(find "$work" -maxdepth 1 -name "$pkgname-$ver-*-x86_64.pkg.tar.zst" -print -quit)
[ -n "$pkg" ] || { echo "makepkg produced no package" >&2; exit 1; }
# Lint only: namcap's dependency hints are advice, not a gate.
namcap "$work/PKGBUILD" "$pkg" || true
cp "$pkg" packaging/arch/
ls -l packaging/arch/*.pkg.tar.zst
