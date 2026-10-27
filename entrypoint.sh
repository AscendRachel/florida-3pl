#!/bin/sh
# Starts the app. A folder mounted from the host is usually owned by root, and the app runs as a normal user,
# so give the app user that folder first. If that is not possible (some network drives), run as root instead of crashing.
set -e
mkdir -p /app/data
if [ "$(id -u)" = "0" ]; then
  chown -R app:app /app/data 2>/dev/null || true
  if setpriv --reuid=app --regid=app --init-groups test -w /app/data; then
    exec setpriv --reuid=app --regid=app --init-groups "$@"
  fi
  echo "warning: /app/data is not writable by the app user, running as root" >&2
fi
exec "$@"
