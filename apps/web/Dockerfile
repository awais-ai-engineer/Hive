FROM node:22-bookworm-slim

WORKDIR /workspace

RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WEB_URL
ARG NEXT_PUBLIC_GOOGLE_LOGIN_ENABLED=false
ARG NEXT_PUBLIC_AUTH_PROXY=1
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_WEB_URL=${NEXT_PUBLIC_WEB_URL} \
    NEXT_PUBLIC_GOOGLE_LOGIN_ENABLED=${NEXT_PUBLIC_GOOGLE_LOGIN_ENABLED} \
    NEXT_PUBLIC_AUTH_PROXY=${NEXT_PUBLIC_AUTH_PROXY} \
    NODE_ENV=production

RUN pnpm --filter @hive/shared build && pnpm --filter @hive/web build

EXPOSE 3000
CMD ["pnpm", "--filter", "@hive/web", "exec", "next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
