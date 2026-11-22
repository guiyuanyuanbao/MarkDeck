#!/bin/sh
# Fix ownership of the data directory when the host-mounted volume belongs
# to a different uid (common with ./data bind mounts), then drop privileges.
set -e

DATA_DIR="${MARKDECK_DATA:-/data}"

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA_DIR"
    chown -R markdeck:markdeck "$DATA_DIR"
    exec su-exec markdeck:markdeck /usr/local/bin/markdeck
fi

# already non-root: just ensure the dir exists
mkdir -p "$DATA_DIR"
exec /usr/local/bin/markdeck
