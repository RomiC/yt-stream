# node@24.20.0-alpine@3.24
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

# System packages pinned to exact versions.
RUN apk add --no-cache \
    ffmpeg=8.1.2-r0 \
    streamlink=8.4.0-r0 \
    && rm -rf /var/cache/apk/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY src/ ./src/
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 8080
CMD ["node", "src/index.js"]
