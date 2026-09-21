# 手搓 Claude Code (Anvil) —— 多阶段 Dockerfile
#
# 阶段 1（build）：安装全部依赖（含 dev）→ tsc 编译 src → dist
# 阶段 2（runtime）：仅生产依赖 + dist 精简运行镜像（非 root）
#
# 构建：docker build -t claudecode-anvil .
# 运行（MOCK 离线演示）：
#   docker run --rm -it claudecode-anvil
# 运行（真实模型 + 挂载工作区）：
#   docker run --rm -it \
#     -e ANTHROPIC_API_KEY=sk-xxx \
#     -e MODEL_ID=deepseek-v4-flash \
#     -v $(pwd)/myworkspace:/workspace \
#     claudecode-anvil
#
# 说明：容器内工作区固定为 /workspace（HARNESS_CWD），会话/转录/记忆都落在该卷，
#       挂载宿主机目录即可持久化。Redis/PostgreSQL 等基础设施见 docker-compose.yml。

# ---------- 阶段 1：构建 ----------
FROM node:22-alpine AS build
WORKDIR /app
# 国内网络加速（可删）
RUN npm config set registry https://registry.npmmirror.com
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 阶段 2：精简运行 ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN npm config set registry https://registry.npmmirror.com
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# 工作区卷挂载点（非 root 可写）
RUN mkdir -p /workspace && chown -R node:node /workspace /app
USER node
WORKDIR /workspace
ENV HARNESS_CWD=/workspace
ENTRYPOINT ["node", "/app/dist/main.js"]
