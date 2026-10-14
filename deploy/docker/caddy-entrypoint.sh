#!/bin/sh
# Derives what the Caddyfile needs from WILLCORD_SITE (host:port).
#  - WILLCORD_HOST: behind Docker's port mapping Caddy sees a container
#    address, not the one in WILLCORD_SITE, so for clients that send no SNI
#    (browsers, for an IP address) it cannot pick a certificate; default_sni
#    names the host to serve instead.
#  - WILLCORD_ORIGIN: the PUBLIC_BASE_URL origin.
set -eu
site=$WILLCORD_SITE
host=${site%:*}
port=${site##*:}
export WILLCORD_HOST=${host#\[}
WILLCORD_HOST=${WILLCORD_HOST%\]}
origin=https://$site
[ "$port" != 443 ] || origin=https://$host
export WILLCORD_ORIGIN=$origin
export WILLCORD_PORT=$port
export WILLCORD_UPSTREAM=${WILLCORD_UPSTREAM:-main:3000}
export WILLCORD_WEB_ROOT=${WILLCORD_WEB_ROOT:-/srv/web}
export WILLCORD_CA_ROOT=${WILLCORD_CA_ROOT:-/data/caddy/pki/authorities/local}
exec "$@"
