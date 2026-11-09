FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --ignore-scripts
COPY apps/web apps/web
COPY packages/shared packages/shared
RUN npm run build

FROM node:24-bookworm-slim
# APT_MIRROR：在特定网络环境（如中国大陆 CVM 访问 deb.debian.org 缓慢）下替换 Debian 源。
# 留空则完全沿用镜像自带的官方源，保证在其他环境下的默认行为不变。
ARG APT_MIRROR=""
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi \
 && apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=3 update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages ./packages
COPY package.json ./
COPY apps/server ./apps/server
# 源码在开发机上若为 600 权限，COPY 会原样保留，导致非 root 的 node 用户读不到（EACCES）。
# 统一放开读/目录搜索权限，避免镜像行为随开发机 umask 漂移。
# 说明：.env 已被 .dockerignore 排除，密钥不会进入镜像。
RUN chmod -R a+rX /app/apps /app/packages
ENV NODE_ENV=production PORT=8787 FFMPEG_PATH=/usr/bin/ffmpeg DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/src/index.js"]
