FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

# System packages pinned to exact versions.
RUN apk add --no-cache \
    ffmpeg=8.1.2-r0 \
    yt-dlp=2026.07.04-r0 \
    curl=8.21.0-r0 \
    && rm -rf /var/cache/apk/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY src/ ./src/
RUN mkdir -p /app/data

EXPOSE 8080
CMD ["node", "src/index.js"]
