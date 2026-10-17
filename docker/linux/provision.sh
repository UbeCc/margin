#!/usr/bin/env bash
# Provision an Ubuntu 22.04/24.04 root filesystem for building, testing and
# smoke-running Margin (Tauri v2 / WebKitGTK 4.1). Used by the Dockerfile, and by
# `scripts/linux-docker.sh image` directly (run + exec + commit) on Docker hosts
# without a build API.
set -euxo pipefail

NODE_VERSION="${NODE_VERSION:-24.11.0}"
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.64.1}"
RUST_TOOLCHAIN="${RUST_TOOLCHAIN:-stable}"
export DEBIAN_FRONTEND=noninteractive

# Tauri v2 Linux prerequisites + build tools + headless X + screenshot tools + CJK fonts.
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl wget git file xz-utils unzip rsync jq sudo util-linux \
  build-essential pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  libxdo-dev patchelf desktop-file-utils xdg-utils shared-mime-info \
  xvfb xauth dbus-x11 x11-utils xdotool imagemagick \
  at-spi2-core fonts-dejavu-core fonts-noto-cjk

# Node (official tarball; the distro's node is too old).
case "$(dpkg --print-architecture)" in amd64) n=x64 ;; arm64) n=arm64 ;; *) exit 1 ;; esac
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${n}.tar.xz" \
  | tar -xJ -C /usr/local --strip-components=1
node --version

# Rust, system-wide; proxies symlinked into /usr/local/bin so no ENV is required
# (images made with `docker commit` cannot carry ENV on some Docker proxies).
export RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
  --default-toolchain "$RUST_TOOLCHAIN" -c clippy -c rustfmt
for b in /usr/local/cargo/bin/*; do ln -sf "$b" "/usr/local/bin/$(basename "$b")"; done
chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"

# Defaults for every shell / docker exec. Docker-level ENV in the Dockerfile and
# --env-file at `docker run` time say the same thing.
cat >/etc/margin-ci.env <<'EOF'
RUSTUP_HOME=/usr/local/rustup
CARGO_HOME=/usr/local/cargo
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
CARGO_BUILD_JOBS=16
CARGO_TERM_COLOR=never
CARGO_INCREMENTAL=1
NPM_CONFIG_UPDATE_NOTIFIER=false
NPM_CONFIG_FUND=false
APPIMAGE_EXTRACT_AND_RUN=1
NO_AT_BRIDGE=1
WEBKIT_DISABLE_COMPOSITING_MODE=1
LANG=C.UTF-8
LC_ALL=C.UTF-8
EOF
sed 's/^/export /' /etc/margin-ci.env >/etc/profile.d/margin-ci.sh
rustc --version && cargo --version

# Playwright browsers + their system deps (version must match package-lock).
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium webkit
chmod -R a+rx /ms-playwright

mkdir -p /work /ci /cache/npm /cache/target
rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*
