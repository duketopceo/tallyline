#!/usr/bin/env bash
# Fails when a tracked file carries personal details: home directories, macOS
# temp paths, private-network host names, personal mail domains, or any term in
# PRIVACY_DENYLIST (newline-separated, case-insensitive, set as a repo secret so
# the terms themselves never land in this public repo).
#
# Output names the file, line and rule only, never the matched text, so a
# denylisted term is not echoed into public CI logs.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

rules=(
  'home directory|/Users/[A-Za-z][A-Za-z0-9._-]+'
  'macOS temp path|/var/folders/[a-z0-9_]{2}/'
  'tailnet host|[A-Za-z0-9-]+\.ts\.net\b'
  'mDNS host name|(^|[^.@A-Za-z0-9_-])[A-Za-z0-9-]+\.local\b'
  'personal mail domain|[A-Za-z0-9._%+-]+@(gmail|icloud|me|hotmail|outlook|yahoo|proton|protonmail)\.(com|me)\b'
)
# example values in docs and tests that look personal but are not
allow='(/Users/(you|me|name|example|USER|runner)\b|example\.local|printer\.local|myserver\.local|a@gmail\.com)'

files=()
while IFS= read -r -d '' f; do files+=("$f"); done < <(git ls-files -z -- . \
  ':!pnpm-lock.yaml' ':!*.png' ':!*.jpg' ':!*.gif' ':!*.ico' ':!*.woff2' ':!*.car' ':!tools/ci/privacy-scan.sh')

fail=0
for r in "${rules[@]}"; do
  name="${r%%|*}"; re="${r#*|}"
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    echo "privacy: ${hit%%:*}:$(cut -d: -f2 <<<"$hit") ($name)"
    fail=1
  done < <(grep -nIEo -- "$re" "${files[@]}" 2>/dev/null | grep -vE -- "$allow" | cut -d: -f1,2 | sort -u || true)
done

if [ -n "${PRIVACY_DENYLIST:-}" ]; then
  i=0
  while IFS= read -r term; do
    term="${term%$'\r'}"; [ -z "$term" ] && continue
    i=$((i + 1))
    while IFS= read -r loc; do
      [ -z "$loc" ] && continue
      echo "privacy: $loc (denylist term #$i)"
      fail=1
    done < <(grep -nIiF -- "$term" "${files[@]}" 2>/dev/null | cut -d: -f1,2 | sort -u || true)
  done <<<"$PRIVACY_DENYLIST"
else
  echo "privacy: PRIVACY_DENYLIST not set; generic rules only"
fi

if [ "$fail" != 0 ]; then
  echo "privacy: remove the personal details above (see CONTRIBUTING.md)"
  exit 1
fi
echo "privacy: clean"
