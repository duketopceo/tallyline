#!/usr/bin/env bash
# Tallyline nightly backup: pg_dump -> gzip -> age (public-key encrypt) -> S3-compatible
# bucket (Cloudflare R2). The private key never needs to exist on this host.
#
# Required env
#   BACKUP_AGE_RECIPIENT   age public key ("age1...") — generate with `age-keygen`, keep the
#                          private half OFF this box (password manager / second machine)
#   one of:
#     BACKUP_PG_CONTAINER  docker container running postgres (e.g. tallyline-postgres-1)
#       [BACKUP_PG_USER=postgres] [BACKUP_PG_DB=tallyline]
#     DATABASE_URL         connection string, dumped with the host's pg_dump
# Upload (skipped when BACKUP_SKIP_UPLOAD=1)
#   BACKUP_S3_BUCKET       bucket name
#   BACKUP_S3_ENDPOINT     e.g. https://<accountid>.r2.cloudflarestorage.com
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   (R2 API token scoped to the bucket)
#   [BACKUP_S3_PREFIX=tallyline/]  [AWS_DEFAULT_REGION=auto]
# Local
#   [BACKUP_OUT_DIR=/var/backups/tallyline]  encrypted file is kept here (default: mktemp, removed after upload)
#   [BACKUP_HEALTHCHECK_URL]  pinged on success (healthchecks.io); `/fail` appended on failure
#   [BACKUP_MARKER_FILE]      touched after a successful run; mount it read-only into the api container and
#                             set TALLYLINE_BACKUP_MARKER to its path so the setup checklist can show backup age
set -Eeuo pipefail

log() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

: "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT to an age public key (age1...)}"
case "$BACKUP_AGE_RECIPIENT" in
  age1*) ;;
  AGE-SECRET-KEY-*) die "BACKUP_AGE_RECIPIENT looks like a PRIVATE key — use the public key (age1...)";;
  *) die "BACKUP_AGE_RECIPIENT must be an age public key (age1...)";;
esac
for bin in age gzip; do command -v "$bin" >/dev/null || die "missing dependency: $bin"; done

ping_hc() { [ -n "${BACKUP_HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 -o /dev/null "${BACKUP_HEALTHCHECK_URL}${1:-}" || true; }
trap 'log "FAILED"; ping_hc /fail' ERR

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="tallyline-${stamp}.dump.gz.age"
if [ -n "${BACKUP_OUT_DIR:-}" ]; then
  mkdir -p "$BACKUP_OUT_DIR"; out_dir="$BACKUP_OUT_DIR"; keep=1
else
  out_dir="$(mktemp -d)"; keep=0
fi
out="$out_dir/$name"
umask 077

dump() {
  if [ -n "${BACKUP_PG_CONTAINER:-}" ]; then
    docker exec "$BACKUP_PG_CONTAINER" pg_dump -U "${BACKUP_PG_USER:-postgres}" -Fc -Z 0 "${BACKUP_PG_DB:-tallyline}"
  elif [ -n "${DATABASE_URL:-}" ]; then
    pg_dump -Fc -Z 0 "$DATABASE_URL"
  else
    die "set BACKUP_PG_CONTAINER or DATABASE_URL"
  fi
}

log "dumping"
# pipefail makes a failed pg_dump fail the whole pipeline (no silent empty backups)
dump | gzip -9 | age -r "$BACKUP_AGE_RECIPIENT" -o "$out"
size="$(wc -c <"$out")"
[ "$size" -gt 200 ] || die "backup suspiciously small (${size} bytes)"
( cd "$out_dir" && sha256sum "$name" >"$name.sha256" )
log "wrote $name (${size} bytes)"

if [ "${BACKUP_SKIP_UPLOAD:-0}" = "1" ]; then
  log "BACKUP_SKIP_UPLOAD=1 — not uploading; file at $out"
else
  : "${BACKUP_S3_BUCKET:?set BACKUP_S3_BUCKET}" "${BACKUP_S3_ENDPOINT:?set BACKUP_S3_ENDPOINT}"
  command -v aws >/dev/null || die "missing dependency: aws (AWS CLI v2)"
  prefix="${BACKUP_S3_PREFIX-tallyline/}"
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
  for f in "$name" "$name.sha256"; do
    aws s3 cp --only-show-errors --endpoint-url "$BACKUP_S3_ENDPOINT" \
      "$out_dir/$f" "s3://${BACKUP_S3_BUCKET}/${prefix}${f}"
  done
  log "uploaded s3://${BACKUP_S3_BUCKET}/${prefix}${name}"
fi

[ "$keep" = 1 ] || rm -rf "$out_dir"
if [ -n "${BACKUP_MARKER_FILE:-}" ]; then mkdir -p "$(dirname "$BACKUP_MARKER_FILE")" && touch "$BACKUP_MARKER_FILE"; fi
trap - ERR
ping_hc
log "ok"
