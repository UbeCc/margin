# Margin Linux dev/build/CI image: Tauri v2 (WebKitGTK 4.1) + Rust stable + Node 24
# + Playwright (Chromium, WebKit) + Xvfb for headless smoke runs.
#
#   docker build -t margin-linux:24.04 docker/linux
#   docker build --build-arg BASE=ubuntu:22.04 -t margin-linux:22.04 docker/linux
#
# Proxies are optional: --build-arg http_proxy=... --build-arg https_proxy=...
# (predefined args, not persisted in the image). All the work is in provision.sh so
# hosts without a build API can do run + exec + commit instead
# (`scripts/linux-docker.sh image`).
ARG BASE=ubuntu:24.04
FROM ${BASE}

ARG NODE_VERSION=24.11.0
ARG PLAYWRIGHT_VERSION=1.64.1
ARG RUST_TOOLCHAIN=stable

COPY provision.sh /tmp/provision.sh
RUN NODE_VERSION=${NODE_VERSION} PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION} \
    RUST_TOOLCHAIN=${RUST_TOOLCHAIN} bash /tmp/provision.sh

# Same values as /etc/margin-ci.env written by provision.sh.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CARGO_BUILD_JOBS=16 \
    CARGO_TERM_COLOR=never \
    CARGO_INCREMENTAL=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    NO_AT_BRIDGE=1 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /work
CMD ["sleep", "infinity"]
