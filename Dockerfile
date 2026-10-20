# syntax=docker/dockerfile:1.7
# 需要 BuildKit（Docker 23+ 默认开启）：依赖安装用缓存挂载，改源码后重建不必重新下载依赖。

# slim 版比完整版小约 70MB，自带 apt，能装 git；sharp 的预编译包在 glibc 上直接可用
ARG BUN_IMAGE=oven/bun:1.4.3-slim
FROM ${BUN_IMAGE} AS base
WORKDIR /app

# 只放各 workspace 的 package.json：依赖层只在依赖清单变化时失效，改源码不会触发重新安装
FROM base AS manifests
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/shared/package.json packages/shared/package.json

# 完整依赖：构建前端用
FROM manifests AS dependencies
RUN --mount=type=cache,id=nobot-bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# 只有生产依赖：运行时用（不含 vite、drizzle-kit、类型包等）
FROM manifests AS production-dependencies
RUN --mount=type=cache,id=nobot-bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN bun run build

FROM base AS runtime
ARG DEBIAN_MIRROR=deb.debian.org
# 扩展管理需要 Git；SSH 客户端用于用户自行配置的私有扩展仓库。放在最前面，后面的层变化时不用重装。
RUN --mount=type=cache,id=nobot-apt,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=nobot-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
        git openssh-client ca-certificates

# 生产依赖：整个目录拷过来（含各 workspace 自己的 node_modules 和 @nobot/* 链接）
COPY --from=production-dependencies /app ./
# 源码只拷运行需要的部分；不能整目录拷构建阶段的 apps/server、packages，否则会带上开发依赖的 node_modules 覆盖掉上面的生产依赖
COPY tsconfig.base.json package.json LICENSE ./
COPY packages/core/src packages/core/src
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
COPY apps/server/drizzle-system apps/server/drizzle-system
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY --from=build /app/apps/web/dist apps/web/dist

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
RUN mkdir -p /app/data && chown bun:bun /app/data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD bun -e "const r = await fetch('http://127.0.0.1:3000/api/health'); if (!r.ok || !(await r.json()).ok) process.exit(1)"
CMD ["bun", "apps/server/src/index.ts"]
