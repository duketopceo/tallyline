#!/usr/bin/env bash
# Tests for ops/deploy.sh against a throwaway git repo and stub docker/curl binaries.
# No Docker, network or real deploy is involved.  Run: bash ops/deploy.test.sh
set -uo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.sh"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
pass=0; failn=0
ok() { pass=$((pass+1)); printf 'ok   %s\n' "$1"; }
bad() { failn=$((failn+1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
mkdir -p "$work/bin" "$work/state"
export STUB_STATE="$work/state"
# docker stub: `compose ... ps -q <svc>`, `compose ... build`, `compose ... up -d`, `inspect`
cat >"$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_STATE/calls"
if [ "$1" = inspect ]; then
  svc="${*: -1}"; svc="${svc#cid-}"
  [ -f "$STUB_STATE/label_$svc" ] && cat "$STUB_STATE/label_$svc" || echo "<no value>"
  exit 0
fi
args=" $* "
case "$args" in
  *" ps -q "*) svc="${*: -1}"; [ -f "$STUB_STATE/up" ] && echo "cid-$svc"; exit 0 ;;
  *" build "*) [ -f "$STUB_STATE/build_fail" ] && exit 1
               echo "$GIT_SHA" >"$STUB_STATE/pending"; exit 0 ;;
  *" up "*) for s in api web mcp-server; do
              if [ -f "$STUB_STATE/stale_mcp" ] && [ "$s" = mcp-server ]; then continue; fi
              cp "$STUB_STATE/pending" "$STUB_STATE/label_$s"
            done; touch "$STUB_STATE/up"; exit 0 ;;
esac
STUB
cat >"$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
[ -f "$STUB_STATE/unhealthy" ] && exit 22 || exit 0
STUB
chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH"

origin="$work/origin.git"; repo="$work/app"
git init -q --bare -b main "$origin"
git clone -q "$origin" "$repo" 2>/dev/null
cd "$repo"
git checkout -q -b main
mkdir -p ops
cp "$src" ops/deploy.sh
printf '#!/usr/bin/env bash\necho backup-ran >>"$STUB_STATE/calls"\n[ -f "$STUB_STATE/backup_fail" ] && exit 1 || exit 0\n' >ops/backup.sh
chmod +x ops/deploy.sh ops/backup.sh
: >docker-compose.selfhost.yml
printf 'deploy.log\n.deploy.lock\n' >.gitignore
git add -A; git commit -q -m c1; c1=$(git rev-parse HEAD)
echo 2 >f; git add f; git commit -q -m c2; c2=$(git rev-parse HEAD)
echo 3 >f; git add f; git commit -q -m c3; c3=$(git rev-parse HEAD)
git push -q origin main 2>/dev/null
git checkout -q -b side "$c1"; echo side >s; git add s; git commit -q -m side; side=$(git rev-parse HEAD); git checkout -q main
export DEPLOY_HEALTH_TIMEOUT=2
reset() { rm -f "$STUB_STATE"/* "$repo/deploy.log"; git -C "$repo" checkout -q main; }
run() { out="$(bash ops/deploy.sh "$@" 2>&1)"; rc=$?; }
has() { grep -q -- "$1" <<<"$out"; }

reset; run --dry-run
{ [ $rc = 0 ] && has "dry run" && has "$c3"; } && ok "dry run prints the plan and exits 0" || bad "dry run" "$out"
[ ! -f "$STUB_STATE/calls" ] || ! grep -q "build" "$STUB_STATE/calls" && ok "dry run builds nothing" || bad "dry run builds" "$(cat "$STUB_STATE/calls")"

reset; run "$c2"
{ [ $rc = 0 ] && has "fresh install"; } && ok "fresh host (no container) deploys without a record" || bad "fresh" "rc=$rc $out"
git checkout -q main

reset; touch "$STUB_STATE/up"; echo "<no value>" >"$STUB_STATE/label_api"; rm "$STUB_STATE/label_api"
run "$c3"
{ [ $rc != 0 ] && has "no revision label"; } && ok "unlabelled running image needs --assume-running" || bad "unlabelled" "rc=$rc $out"

reset; touch "$STUB_STATE/up"
run --assume-running "$c1" "$c3"
{ [ $rc = 0 ] && cut -f4,5 deploy.log | grep -q "^$c3.ok$"; } && ok "deploy with --assume-running logs commit and ok" || bad "assume-running" "rc=$rc $out"
[ "$(git rev-parse HEAD)" = "$c3" ] && ok "checkout is at the target" || bad "checkout" "$(git rev-parse HEAD)"
grep -q "backup-ran" "$STUB_STATE/calls" && ok "backup ran before the build" || bad "backup" "$(cat "$STUB_STATE/calls")"
[ "$(cut -f2 deploy.log | head -1)" = "$(id -un)" ] && ok "log records the actor" || bad "actor" "$(cat deploy.log)"
grep -q -- "--profile mcp" "$STUB_STATE/calls" && ok "every compose call carries --profile mcp" || bad "profile" "$(cat "$STUB_STATE/calls")"

reset; run "$c3"; run "$c2"
{ [ $rc != 0 ] && has "older than"; } && ok "older target is refused" || bad "older" "rc=$rc $out"

reset; run --assume-running "$c1" "$side"
{ [ $rc != 0 ] && has "not on origin/main"; } && ok "target off origin/main is refused" || bad "off main" "rc=$rc $out"

reset; echo dirty >>f; run --assume-running "$c1" "$c3"
{ [ $rc != 0 ] && has "uncommitted changes"; } && ok "dirty tracked tree is refused" || bad "dirty" "rc=$rc $out"
git checkout -q -- f 2>/dev/null; git reset -q --hard

reset; touch "$STUB_STATE/up" "$STUB_STATE/unhealthy"
run --assume-running "$c1" "$c3"
{ [ $rc != 0 ] && has "health check did not pass" && has "previous commit: $c1" && cut -f5 deploy.log | grep -q failed; } && ok "failing health check exits non-zero, names the previous SHA, logs failed" || bad "health" "rc=$rc $out"

reset; touch "$STUB_STATE/up" "$STUB_STATE/backup_fail"
run --assume-running "$c1" "$c3"
{ [ $rc != 0 ] && has "backup failed" && ! grep -q build "$STUB_STATE/calls"; } && ok "failed backup stops before any build" || bad "backup fail" "rc=$rc $out"

reset; touch "$STUB_STATE/up" "$STUB_STATE/stale_mcp"; echo "$c1" >"$STUB_STATE/label_mcp-server"
run --assume-running "$c1" "$c3"
{ [ $rc != 0 ] && has "mcp-server image revision label"; } && ok "a lagging mcp image fails the deploy" || bad "stale mcp" "rc=$rc $out"

# rollback: deploy c2 ok, then c3 fails, then --rollback c2 works but --rollback c1 does not
reset; touch "$STUB_STATE/up"
run --assume-running "$c1" "$c2"; [ $rc = 0 ] || bad "setup c2" "$out"
touch "$STUB_STATE/unhealthy"; run "$c3"
rm "$STUB_STATE/unhealthy"
run "$c2"
{ [ $rc != 0 ] && has "older than"; } && ok "plain redeploy of an older commit is refused" || bad "no-rollback" "rc=$rc $out"
run --rollback "$c1"
{ [ $rc != 0 ] && has "only redeploys the last healthy"; } && ok "--rollback only to the last healthy commit" || bad "rollback other" "rc=$rc $out"
run --rollback "$c2"
{ [ $rc = 0 ] && tail -1 deploy.log | cut -f4,5 | grep -q "^$c2.ok$"; } && ok "--rollback to the last healthy commit succeeds" || bad "rollback" "rc=$rc $out"

reset; touch "$STUB_STATE/up"
( exec 9>>.deploy.lock; flock -n 9; echo "pid=1 actor=someone since=now" >.deploy.lock; sleep 4 ) &
holder=$!; sleep 1
run --assume-running "$c1" "$c3"
{ [ $rc != 0 ] && has "another deploy is running" && has "actor=someone"; } && ok "second concurrent deploy exits naming the lock holder" || bad "lock" "rc=$rc $out"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null

printf '\n%d passed, %d failed\n' "$pass" "$failn"
[ "$failn" = 0 ]
