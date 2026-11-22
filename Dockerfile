# ---- frontend build ----
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- go build (embeds the built UI) ----
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY server/ ./server/
COPY --from=web /src/server/internal/webapp/dist ./server/internal/webapp/dist
RUN cd server && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/markdeck ./cmd/markdeck

# ---- runtime ----
FROM alpine:3.20
RUN adduser -D -H markdeck && apk add --no-cache ca-certificates tzdata
COPY --from=build /out/markdeck /usr/local/bin/markdeck
USER markdeck
WORKDIR /data
VOLUME /data
EXPOSE 8990
ENV MARKDECK_ADDR=0.0.0.0:8990 MARKDECK_DATA=/data
ENTRYPOINT ["markdeck"]
