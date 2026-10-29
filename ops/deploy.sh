#!/usr/bin/env bash
# Tallyline deploy: the only sanctioned way to change what runs on the host.
#
#   ops/deploy.sh [--dry-run] [--rollback] [--assume-running SHA] [--skip-backup] [TARGET]
#
# TARGET is a commit on origin/main (default: origin/main). The script
#   1. takes an exclusive flock so only one deploy runs at a time,
#   2. refuses a dirty tracked tree,
#   3. refuses a target that is not on origin/main, or that is older than the commit
#      now running (the api image's org.opencontainers.image.revision label),
#   4. runs the backup (ops/backup.sh) unless --skip-backup,
#   5. builds api, web and mcp-server with a revision label (always with --profile mcp,
#      so the mcp image can no longer lag silently), starts them, and polls /health on all three,
#   6. appends commit, time and actor to a deploy log.
# If a health check fails the script exits non-zero, prints the previous SHA and the exact
# command that redeploys it (--rollback). Migrations are additive and run at API boot, so
# containers are not kept running on failure.
#
# The first run on a host whose images carry no revision label needs the operator's deploy
# record: --assume-running <sha>.
#
# Environment (all optional)
#   DEPLOY_APP_DIR        repo checkout to deploy (default: the repo this script lives in)
#   DEPLOY_COMPOSE_FILE   compose file (default: docker-compose.selfhost.yml)
#   DEPLOY_LOCK_FILE      lock file (default: $DEPLOY_APP_DIR/.deploy.lock)
#   DEPLOY_LOG            append-only log (default: $DEPLOY_APP_DIR/deploy.log)
#   DEPLOY_BACKUP_ENV     env file sourced for backup.sh, readable by the deployer only
#   DEPLOY_HEALTH_TIMEOUT seconds to wait for the three health endpoints (default: 180)
#   DEPLOY_REMOTE         git remote holding main (default: origin); DEPLOY_NO_FETCH=1 skips the fetch
#   API_PUBLISH_PORT / WEB_PUBLISH_PORT / MCP_PUBLISH_PORT   as in docs/deploy.md
set -Eeuo pipefail

log() { printf '%s deploy: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }


# Everything runs inside main(), and the file ends with a single `main; exit` line, so bash has
# parsed the whole script before `git checkout` swaps ops/deploy.sh underneath it.
main() {
dry_run=0 rollback=0 skip_backup=0 assume_running="" target_arg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --rollback) rollback=1 ;;
    --skip-backup) skip_backup=1 ;;
    --assume-running) shift; assume_running="${1:-}"; [ -n "$assume_running" ] || die "--assume-running needs a sha" ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown flag: $1" ;;
    *) [ -z "$target_arg" ] || die "only one target allowed"; target_arg="$1" ;;
  esac
  shift
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="${DEPLOY_APP_DIR:-$(cd "$here/.." && pwd)}"
compose_file="${DEPLOY_COMPOSE_FILE:-docker-compose.selfhost.yml}"
lock_file="${DEPLOY_LOCK_FILE:-$app_dir/.deploy.lock}"
deploy_log="${DEPLOY_LOG:-$app_dir/deploy.log}"
remote="${DEPLOY_REMOTE:-origin}"
health_timeout="${DEPLOY_HEALTH_TIMEOUT:-180}"
actor="${SUDO_USER:-$(id -un)}"

cd "$app_dir"
git rev-parse --git-dir >/dev/null 2>&1 || die "$app_dir is not a git checkout"

# 1. lock — one deployer at a time; the loser learns who holds it
exec 9>>"$lock_file"
if ! flock -n 9; then
  holder="$(tr '\n' ' ' <"$lock_file" 2>/dev/null | tail -c 200)"
  die "another deploy is running (${holder:-holder unknown}); wait for it to finish"
fi
: >"$lock_file"
printf 'pid=%s actor=%s since=%s\n' "$$" "$actor" "$(date -u +%FT%TZ)" >&9

# 2. clean tracked tree (untracked files such as .env are fine)
if ! git diff --quiet HEAD -- || ! git diff --cached --quiet --; then
  die "tracked files have uncommitted changes; deploy only what is on origin/main"
fi

# 3. resolve target and check it is on origin/main
if [ "${DEPLOY_NO_FETCH:-0}" != "1" ]; then
  git fetch --quiet "$remote" main || die "could not fetch $remote main"
fi
main_ref="$remote/main"
git rev-parse --verify --quiet "$main_ref^{commit}" >/dev/null || die "$main_ref does not exist"
target="$(git rev-parse --verify --quiet "${target_arg:-$main_ref}^{commit}")" || die "unknown target: ${target_arg}"
git merge-base --is-ancestor "$target" "$main_ref" || die "target ${target:0:12} is not on $main_ref"

last_good() {
  [ -f "$deploy_log" ] || return 0
  awk -F'\t' '$5=="ok"{sha=$4} END{if(sha)print sha}' "$deploy_log"
}

# running commit = revision label on the running api container's image
running=""
cid="$(docker compose -f "$compose_file" --profile mcp ps -q api 2>/dev/null | head -n1 || true)"
if [ -n "$cid" ]; then
  running="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$cid" 2>/dev/null || true)"
  case "$running" in "<no value>"|unknown) running="" ;; esac
fi
if [ -z "$running" ] && [ -n "$assume_running" ]; then
  running="$(git rev-parse --verify --quiet "$assume_running^{commit}")" || die "--assume-running ${assume_running} is not a known commit"
elif [ -z "$running" ]; then
  if [ -n "$cid" ]; then
    die "the running api image has no revision label (first run on this host); pass --assume-running <sha> from the deploy record"
  fi
  log "no api container is running; treating this as a fresh install"
fi

# 4. never go backwards, except to the last commit that passed its health checks
if [ -n "$running" ] && [ "$running" != "$target" ]; then
  if [ "$rollback" = 1 ]; then
    [ "$target" = "$(last_good)" ] || die "--rollback only redeploys the last healthy commit ($(last_good | cut -c1-12)), not ${target:0:12}"
  elif ! git merge-base --is-ancestor "$running" "$target"; then
    die "target ${target:0:12} is older than or diverges from the running commit ${running:0:12}; refusing. After a failed deploy use --rollback"
  fi
fi

api_port="${API_PUBLISH_PORT:-4000}" web_port="${WEB_PUBLISH_PORT:-3100}" mcp_port="${MCP_PUBLISH_PORT:-3101}"
health_urls=("http://localhost:${api_port}/health" "http://localhost:${web_port}/" "http://localhost:${mcp_port}/health")

if [ "$dry_run" = 1 ]; then
  log "dry run; nothing will be changed"
  printf 'actor:     %s\nrunning:   %s\ntarget:    %s\ncommits:   %s\n' "$actor" "${running:-none}" "$target" \
    "$( [ -n "$running" ] && git rev-list --count "$running..$target" 2>/dev/null || echo n/a )"
  printf 'plan:\n'
  [ "$skip_backup" = 1 ] || printf '  1. backup (ops/backup.sh)\n'
  printf '  2. git checkout --detach %s\n  3. docker compose --profile mcp build api web mcp-server (revision label %s)\n' "${target:0:12}" "${target:0:12}"
  printf '  4. docker compose --profile mcp up -d\n  5. poll %s\n  6. append to %s\n' "${health_urls[*]}" "$deploy_log"
  exit 0
fi

record() { # record <result> ; tab-separated: time actor from to result
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$actor" "${running:-none}" "$target" "$1" >>"$deploy_log"
}

fail() {
  record "failed"
  log "FAILED: $1"
  if [ -n "$running" ]; then
    log "previous commit: $running"
    lg="$(last_good)"
    if [ -n "$lg" ]; then log "to go back:      ops/deploy.sh --rollback $lg"; fi
  fi
  exit 1
}

# 5. backup, build, start, verify
if [ "$skip_backup" = 1 ]; then
  log "--skip-backup: not running the backup"
else
  log "running backup"
  (
    if [ -n "${DEPLOY_BACKUP_ENV:-}" ]; then set -a; . "$DEPLOY_BACKUP_ENV"; set +a; fi
    "$here/backup.sh"
  ) || fail "backup failed; nothing was changed"
fi

log "checking out ${target:0:12}"
git checkout -q --detach "$target" || fail "checkout failed"

export GIT_SHA="$target"
dc=(docker compose -f "$compose_file" --profile mcp)
log "building api, web, mcp-server"
"${dc[@]}" build api web mcp-server || fail "build failed"
log "starting"
"${dc[@]}" up -d || fail "compose up failed"

log "waiting up to ${health_timeout}s for health"
deadline=$(( $(date +%s) + health_timeout ))
for url in "${health_urls[@]}"; do
  until curl -fsS -m 5 -o /dev/null "$url" 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "health check did not pass: $url"
    sleep 3
  done
  log "healthy: $url"
done

# labels read back the exact SHA, so a lagging image is caught now, not months later
for svc in api web mcp-server; do
  c="$("${dc[@]}" ps -q "$svc" | head -n1)"
  [ -n "$c" ] || fail "$svc container not found after start"
  got="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$c")"
  [ "$got" = "$target" ] || fail "$svc image revision label is '${got}', expected ${target}"
done

record "ok"
log "deployed ${target:0:12} (was ${running:-none})"
}

main "$@"; exit $?
