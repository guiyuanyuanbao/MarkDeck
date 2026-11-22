# ---- frontend build ----
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- go build (embeds the built UI) ----
# arm64 uses native Go cross-compilation instead of qemu emulation, which is
# ~10x faster and avoids the qemu+GOTOOLCHAIN deadlock.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY server/ ./server/
COPY --from=web /src/server/internal/webapp/dist ./server/internal/webapp/dist
RUN cd server && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/markdeck ./cmd/markdeck

# ---- runtime ----
FROM alpine:3.20
RUN adduser -D -H -u 1000 markdeck \
    && apk add --no-cache ca-certificates tzdata su-exec
COPY --from=build /out/markdeck /usr/local/bin/markdeck
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
WORKDIR /data
VOLUME /data
EXPOSE 8990
ENV MARKDECK_ADDR=0.0.0.0:8990 MARKDECK_DATA=/data
# start as root to fix host-mounted volume ownership, then drop to markdeck
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
