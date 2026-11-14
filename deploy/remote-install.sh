#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $(id -u) -ne 0 ]]; then exec sudo bash "$0" "$@"; fi
ARCHIVE=${1:?An uploaded release archive is required}
[[ -f "$ARCHIVE" ]] || { echo 'Release archive missing.' >&2; exit 1; }
GATEWAY=false
case ${2:-} in
  --nginx-gateway) GATEWAY=true ;;
  '') ;;
  *) echo 'Unknown deployment option.' >&2; exit 2 ;;
esac
BASE=/opt/knovid
RELEASE_ID=$(date -u +%Y%m%dT%H%M%SZ)
RELEASE="$BASE/releases/$RELEASE_ID"
PROJECT=knovid-art
GATEWAY_CONF=/etc/nginx/conf.d/knovid.art.conf
PREVIOUS_GATEWAY=$(readlink "$GATEWAY_CONF" || true)
if [[ "$PREVIOUS_GATEWAY" == "$BASE"/releases/*/deploy/host-nginx.conf ]]; then GATEWAY=true; fi

echo 'Checking the host and existing listeners.'
uname -m
free -h
df -h /opt
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  . /etc/os-release
  case "$ID" in ubuntu|debian) ;; *) echo 'Install Docker Engine and Docker Compose v2 on this host, then rerun.' >&2; exit 1;; esac
  apt-get update
  PACKAGES=(ca-certificates curl python3)
  command -v docker >/dev/null || PACKAGES+=(docker.io)
  if ! docker compose version >/dev/null 2>&1; then
    if apt-cache show docker-compose-v2 >/dev/null 2>&1; then PACKAGES+=(docker-compose-v2)
    elif apt-cache show docker-compose-plugin >/dev/null 2>&1; then PACKAGES+=(docker-compose-plugin)
    else echo 'Install Docker Compose v2 from the official Docker repository, then rerun.' >&2; exit 1; fi
  fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${PACKAGES[@]}"
fi
command -v curl >/dev/null && command -v python3 >/dev/null || {
  echo 'curl and python3 are required on the server.' >&2; exit 1;
}
systemctl enable --now docker
docker info >/dev/null
OWN_WEB=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.service=web')
if $GATEWAY; then
  if ! command -v nginx >/dev/null || ! systemctl is-active --quiet nginx; then
    echo 'Gateway mode requires an active host Nginx service.' >&2
    exit 1
  fi
  if [[ -e "$GATEWAY_CONF" || -L "$GATEWAY_CONF" ]] && [[ "$PREVIOUS_GATEWAY" != "$BASE"/releases/*/deploy/host-nginx.conf ]]; then
    echo "A gateway configuration already exists at $GATEWAY_CONF." >&2
    exit 1
  fi
  if [[ -n $(ss -H -ltn 'sport = :18443') ]]; then
    if [[ -z "$OWN_WEB" ]] || [[ $(docker port "$OWN_WEB" 443/tcp 2>/dev/null) != 127.0.0.1:18443 ]]; then
      echo 'The loopback port 18443 is already occupied.' >&2
      exit 1
    fi
  fi
  nginx -t
elif [[ -z "$OWN_WEB" ]] && [[ -n $(ss -H -ltn '( sport = :80 or sport = :443 )') ]]; then
  echo 'Ports 80/443 are already occupied. Existing services were left running.' >&2
  echo 'Integrate the supplied nginx.conf with the current gateway before continuing.' >&2
  exit 1
fi

install -d -m 700 "$BASE/shared/certs" "$BASE/shared/backups" "$BASE/releases"
mkdir "$RELEASE"
tar -xzf "$ARCHIVE" -C "$RELEASE"
if [[ -f "$BASE/shared/.env" ]]; then
  rm "$RELEASE/deploy/.env"
  echo 'Keeping the existing production environment and database credentials.'
else
  mv "$RELEASE/deploy/.env" "$BASE/shared/.env"
  chmod 600 "$BASE/shared/.env"
fi
if [[ -f "$BASE/shared/certs/knovid.art.pem" ]]; then
  cp -a "$BASE/shared/certs" "$BASE/shared/backups/certs-$RELEASE_ID"
fi
install -m 600 "$RELEASE/deploy/certs/knovid.art.pem" "$BASE/shared/certs/knovid.art.pem"
install -m 600 "$RELEASE/deploy/certs/knovid.art.key" "$BASE/shared/certs/knovid.art.key"
rm -rf "$RELEASE/deploy/certs"
ln -s "$BASE/shared/certs" "$RELEASE/deploy/certs"
ln -s "$BASE/shared/.env" "$RELEASE/deploy/.env"
export KNOVID_RELEASE="$RELEASE_ID"
cd "$RELEASE/deploy"
COMPOSE=(docker compose -p "$PROJECT" --env-file "$BASE/shared/.env" -f compose.yaml)
if $GATEWAY; then COMPOSE+=(-f compose.gateway.yaml); fi
"${COMPOSE[@]}" config --quiet

POSTGRES=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.service=postgres')
if [[ -n "$POSTGRES" ]]; then
  echo 'Backing up the account database before updating.'
  docker exec "$POSTGRES" pg_dump -U knovid -d knovid | gzip > "$BASE/shared/backups/accounts-$RELEASE_ID.sql.gz"
fi
echo 'Building application images. The current release remains online during the build.'
"${COMPOSE[@]}" --progress plain build
"${COMPOSE[@]}" --progress plain up -d --wait --wait-timeout 240
"${COMPOSE[@]}" exec -T web nginx -t

check_site() {
  local route
  echo 'Checking HTTPS, production API and account database through the gateway.'
  for route in / /api/healthz /api/account-health /api/v1/access; do
    curl --fail --silent --show-error --noproxy '*' --max-time 20 --resolve knovid.art:443:127.0.0.1 "https://knovid.art$route" --output /dev/null || return 1
  done
}

if $GATEWAY; then
  curl --fail --silent --show-error --noproxy '*' --max-time 20 --connect-to knovid.art:443:127.0.0.1:18443 https://knovid.art/ --output /dev/null
  ln -sfn "$RELEASE/deploy/host-nginx.conf" "$GATEWAY_CONF"
  # systemctl returns after signaling Nginx, before the new workers accept connections.
  if ! nginx -t || ! systemctl reload nginx ||
    ! curl --fail --silent --show-error --noproxy '*' --max-time 5 --retry 8 --retry-delay 1 --retry-all-errors \
      --resolve knovid.art:443:127.0.0.1 https://knovid.art/ --output /dev/null ||
    ! check_site; then
    if [[ -n "$PREVIOUS_GATEWAY" ]]; then
      ln -sfn "$PREVIOUS_GATEWAY" "$GATEWAY_CONF"
    else
      rm -f "$GATEWAY_CONF"
    fi
    nginx -t && systemctl reload nginx
    exit 1
  fi
else
  check_site
fi
CURRENT=$(readlink "$BASE/current" || true)
if [[ -n "$CURRENT" ]]; then ln -sfn "$CURRENT" "$BASE/previous"; fi
ln -sfn "$RELEASE" "$BASE/current"
printf '%s\n' "$RELEASE_ID" > "$BASE/shared/current-release"
"${COMPOSE[@]}" ps
rm -f "$ARCHIVE" "$(dirname "$ARCHIVE")/remote-install.sh"
rmdir "$(dirname "$ARCHIVE")" || true
echo 'HTTPS and both APIs passed local server checks.'
if curl --fail --silent --show-error --max-time 20 https://knovid.art/api/account-health --output /dev/null; then
  echo 'Public domain check passed: https://knovid.art/'
else
  echo 'Host checks passed; public DNS or inbound ports 80/443 still need verification.' >&2
  exit 1
fi
