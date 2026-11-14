#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET=${KNOVID_SSH_TARGET:-}
CERT_DIR=${KNOVID_CERT_DIR:-$ROOT/deploy/certs}
CHECK_ONLY=false
GATEWAY_ARG=
case ${1:-} in
  --check) CHECK_ONLY=true ;;
  --nginx-gateway) GATEWAY_ARG=--nginx-gateway ;;
  '') ;;
  *) echo 'Usage: bash deploy/deploy.sh [--check|--nginx-gateway]' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo 'Expected at most one deployment option.' >&2; exit 2; }
if ! $CHECK_ONLY && [[ -z "$TARGET" ]]; then
  echo 'Set KNOVID_SSH_TARGET to your deployment SSH account and host.' >&2
  exit 1
fi
for binary in node npm python3 openssl tar ssh scp; do
  command -v "$binary" >/dev/null || { echo "Missing command: $binary" >&2; exit 1; }
done
[[ -f "$ROOT/backend/.env" ]] || { echo 'Create backend/.env with the model credentials first.' >&2; exit 1; }
[[ -f "$CERT_DIR/knovid.art.pem" && -f "$CERT_DIR/knovid.art.key" ]] || {
  echo "Certificate files are missing in $CERT_DIR" >&2; exit 1;
}
openssl x509 -in "$CERT_DIR/knovid.art.pem" -noout -checkhost knovid.art
openssl x509 -in "$CERT_DIR/knovid.art.pem" -noout -checkhost www.knovid.art
openssl x509 -in "$CERT_DIR/knovid.art.pem" -noout -checkend 86400
CERT_PUB=$(openssl x509 -in "$CERT_DIR/knovid.art.pem" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)
KEY_PUB=$(openssl pkey -in "$CERT_DIR/knovid.art.key" -pubout -outform DER | openssl dgst -sha256)
[[ "$CERT_PUB" == "$KEY_PUB" ]] || { echo 'Certificate and private key do not match.' >&2; exit 1; }

STAGE=$(mktemp -d /tmp/knovid-deploy.XXXXXX)
SOCKET="$STAGE/ssh"
REMOTE=
cleanup() {
  if [[ "$REMOTE" =~ ^/[a-zA-Z0-9_./-]+/knovid-upload\.[a-zA-Z0-9]+$ && -S "$SOCKET" ]]; then
    ssh -S "$SOCKET" "$TARGET" "rm -f '$REMOTE/knovid.tar.gz' '$REMOTE/remote-install.sh'; if test -d '$REMOTE'; then rmdir '$REMOTE'; fi" >/dev/null 2>&1 || true
  fi
  if [[ -S "$SOCKET" ]]; then ssh -S "$SOCKET" -O exit "$TARGET" >/dev/null 2>&1 || true; fi
  rm -rf "$STAGE"
}
trap cleanup EXIT
RELEASE="$STAGE/release"
mkdir -p "$RELEASE"/{backend,database,frontend,deploy/certs}
(cd "$ROOT/frontend" && VITE_API_BASE_URL=/api npm run build)
cp -R "$ROOT/frontend/dist" "$RELEASE/frontend/"
for file in Dockerfile Dockerfile.temporal package.json package-lock.json openapi.json; do
  cp "$ROOT/backend/$file" "$RELEASE/backend/"
done
for directory in src assets fixtures; do cp -R "$ROOT/backend/$directory" "$RELEASE/backend/"; done
cp "$ROOT/database/package.json" "$ROOT/database/package-lock.json" "$RELEASE/database/"
cp -R "$ROOT/database/src" "$ROOT/database/migrations" "$RELEASE/database/"
for file in compose.yaml compose.gateway.yaml Dockerfile.account Dockerfile.web nginx.conf host-nginx.conf; do
  cp "$ROOT/deploy/$file" "$RELEASE/deploy/"
done
cp "$ROOT/deploy/build.dockerignore" "$RELEASE/.dockerignore"
node "$ROOT/deploy/prepare-env.mjs" "$ROOT/backend/.env" "$RELEASE/deploy/.env"
cp "$CERT_DIR/knovid.art.pem" "$CERT_DIR/knovid.art.key" "$RELEASE/deploy/certs/"
chmod 600 "$RELEASE/deploy/certs/"* "$RELEASE/deploy/.env"

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  (cd "$RELEASE/deploy" && docker compose -p knovid-art --env-file .env config --quiet)
  (cd "$RELEASE/deploy" && docker compose -p knovid-art --env-file .env -f compose.yaml -f compose.gateway.yaml config --quiet)
fi
if $CHECK_ONLY; then
  echo 'Local checks passed: frontend build, TLS key match, model configuration, deployment files.'
  echo 'No server changes were made.'
  exit 0
fi

COPYFILE_DISABLE=1 tar -czf "$STAGE/knovid.tar.gz" -C "$RELEASE" .
echo "Connecting to $TARGET. SSH/sudo may ask for your password; it is not stored."
ssh -M -S "$SOCKET" -o ControlPersist=600 -o ConnectTimeout=15 -fN "$TARGET"
REMOTE=$(ssh -S "$SOCKET" "$TARGET" 'umask 077; mktemp -d "$HOME/knovid-upload.XXXXXX"')
[[ "$REMOTE" =~ ^/[a-zA-Z0-9_./-]+/knovid-upload\.[a-zA-Z0-9]+$ ]] || { echo 'Unexpected remote staging path.' >&2; exit 1; }
scp -o "ControlPath=$SOCKET" "$STAGE/knovid.tar.gz" "$ROOT/deploy/remote-install.sh" "$TARGET:$REMOTE/"
ssh -tt -S "$SOCKET" "$TARGET" "bash '$REMOTE/remote-install.sh' '$REMOTE/knovid.tar.gz' $GATEWAY_ARG"
echo 'Deployment finished. Open https://knovid.art/'
