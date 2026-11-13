FROM node:22-alpine AS builder
WORKDIR /app

# 构建时注入环境变量（NEXT_PUBLIC_ 变量必须在构建时传入）
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}

# 清理旧的构建缓存
RUN rm -rf .next node_modules

COPY package*.json ./
RUN npm ci
COPY . .

# 删除本地配置文件，确保使用 ARG 传入的环境变量
RUN rm -f .env.local .env

# 构建应用
RUN npm run build

FROM node:22-alpine AS production
WORKDIR /app
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001
COPY --from=builder --chown=appuser:appgroup /app/.next/standalone ./
COPY --from=builder --chown=appuser:appgroup /app/.next/static ./.next/static
COPY --from=builder --chown=appuser:appgroup /app/public ./public
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000 || exit 1
CMD ["node", "server.js"]
