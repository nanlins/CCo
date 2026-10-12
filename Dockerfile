# CCo (anvil) —— 多阶段 Dockerfile
#
# 阶段 1（build）：安装全部依赖（含 dev）→ tsc 编译 src → dist
# 阶段 2（runtime）：仅生产依赖 + dist 精简运行镜像（非 root）
#
# 构建：docker build -t cco .
# 运行（MOCK 离线演示）：
#   docker run --rm -it -e MOCK=1 cco
# 运行（真实模型 + 挂载工作区）：
#   docker run --rm -it \
#     -e ANTHROPIC_API_KEY=sk-xxx \
#     -e MODEL_ID=deepseek-v4-flash \
#     -v $(pwd)/myworkspace:/workspace \
#     cco
#
# 说明：容器内工作区固定为 /workspace（CCO_CWD），会话/转录/记忆都落在该卷，
#       挂载宿主机目录即可持久化。Redis/PostgreSQL 等基础设施见 docker-compose.yml。
# 依赖安装使用 --ignore-scripts：构建器内无 .git 时跳过 husky/prepare 更稳，
#       编译由显式 `npm run build` 完成；npm registry 可用 --build-arg NPM_REGISTRY 覆盖。

# ---------- 阶段 1：构建 ----------
FROM node:22-alpine AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --registry=$NPM_REGISTRY
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 阶段 2：精简运行 ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --registry=$NPM_REGISTRY && npm cache clean --force
COPY --from=build /app/dist ./dist
# 工作区卷挂载点（非 root 可写）
RUN mkdir -p /workspace && chown -R node:node /workspace /app
USER node
WORKDIR /workspace
ENV CCO_CWD=/workspace
ENTRYPOINT ["node", "/app/dist/main.js"]
