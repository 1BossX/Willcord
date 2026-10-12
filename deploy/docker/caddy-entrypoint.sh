#!/bin/sh
# Browsers send no SNI for an IP address, and behind Docker's port mapping
# Caddy sees a container address rather than the one in WILLCORD_SITE, so it
# cannot pick a certificate. default_sni names the host to serve instead.
set -eu
host=${WILLCORD_SITE%:*}
host=${host#\[}
host=${host%\]}
export WILLCORD_HOST=$host
exec "$@"
