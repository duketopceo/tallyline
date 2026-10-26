#!/usr/bin/env python3
"""Onboard Pace and Wisp onto a Tallyline instance and wire GlitchTip to it.

Dry-run by default: it only reads, then prints what it would change. Pass
--apply to act. Safe to re-run: every step checks current state first and a
second --apply makes no changes.

What --apply does
  1. Creates the PACE and WISP teams in the workspace when missing.
  2. Creates the workspace's GlitchTip integration when missing (or rotates
     its secret with --rotate) and keeps the project-name -> team map current.
  3. Gives every mapped GlitchTip project one alert recipient named "tallyline"
     that posts to the integration's webhook URL.

Credentials never touch the terminal or the disk. Tokens come from omaseal;
the integration URL (it embeds the secret, and Tallyline shows it only once)
is stored back in omaseal as `tallyline glitchtip-webhook`.

  Tallyline token : omaseal get tallyline personal      (--tally-secret svc/acct)
  GlitchTip token : omaseal get glitchtip api, falling back to
                    omaseal get glitchtip Personal      (--glitchtip-secret svc/acct, repeatable)

Usage
  python3 ops/glitchtip-onboard.py                 # dry-run
  python3 ops/glitchtip-onboard.py --apply         # make the changes
  python3 ops/glitchtip-onboard.py --apply --rotate
  python3 ops/glitchtip-onboard.py --map billing-cron=PACE --apply
  python3 ops/glitchtip-onboard.py --self-test     # offline check, no network
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field

DEFAULT_TALLY_URL = "https://api.tallyline.app"
DEFAULT_GLITCHTIP_URL = "https://errors.pacehq.io"
DEFAULT_TALLY_SECRET = ("tallyline", "personal")
DEFAULT_GLITCHTIP_SECRETS = [("glitchtip", "api"), ("glitchtip", "Personal")]
STORED_URL_REF = ("tallyline", "glitchtip-webhook")
ALERT_NAME = "tallyline"

# team key -> display name; only these are ever created
CREATABLE_TEAMS = {"PACE": "Pace", "WISP": "Wisp"}

# First matching rule wins. Matching is on whole words of the project's name or
# slug (split on anything that is not a letter or digit). A project that
# matches no rule is reported and skipped, never guessed.
RULES: list[tuple[str, set[str]]] = [
    ("WISP", {"wisp"}),
    ("PACE", {"pace", "portal", "ui", "strut", "relay", "sidecar", "tenant", "stackd", "pacehq"}),
    ("KATE", {"kate"}),  # mapped only when a KATE team already exists
]


class Abort(Exception):
    pass


# --------------------------------------------------------------------- output
class Out:
    """Prints, with every known secret value scrubbed as a last line of defence."""

    def __init__(self, quiet: bool = False) -> None:
        self.secrets: set[str] = set()
        self.lines: list[str] = []
        self.quiet = quiet

    def learn(self, value: str) -> None:
        if value and len(value) >= 8:
            self.secrets.add(value)

    def say(self, text: str = "") -> None:
        for s in self.secrets:
            text = text.replace(s, "***")
        self.lines.append(text)
        if not self.quiet:
            print(text)


def last4(value: str) -> str:
    return "..." + value[-4:]


# -------------------------------------------------------------------- secrets
class Omaseal:
    def get(self, service: str, account: str) -> str | None:
        r = subprocess.run(
            ["omaseal", "get", service, account], capture_output=True, text=True
        )
        value = r.stdout.strip()
        return value if r.returncode == 0 and value else None

    def set(self, service: str, account: str, value: str) -> None:
        r = subprocess.run(
            ["omaseal", "set", service, account],
            input=value,
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            raise Abort(f"omaseal set {service} {account} failed (exit {r.returncode})")


# ----------------------------------------------------------------------- http
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: the bearer token must only reach the host it was meant for."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def require_https(url: str, flag: str) -> str:
    if not url.lower().startswith("https://"):
        raise Abort(f"{flag} must be an https:// URL (tokens are sent with every request)")
    return url


class Http:
    def request(
        self, method: str, url: str, token: str, body: object | None = None
    ) -> tuple[int, object]:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "authorization": f"Bearer {token}",
                "content-type": "application/json",
                "accept": "application/json",
                "user-agent": "tallyline-glitchtip-onboard/1",
            },
        )
        try:
            with _OPENER.open(req, timeout=30) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            if 300 <= e.code < 400:
                raise Abort(f"{method} {url.split('?')[0]} answered a redirect (HTTP {e.code}); refusing to follow it with a token attached")
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"raw": raw[:200].decode("utf-8", "replace")}
        except urllib.error.URLError as e:
            raise Abort(f"network error calling {method} {url.split('?')[0]}: {e.reason}")


# ---------------------------------------------------------------- pure helpers
def words(text: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", text.lower()) if w}


def classify(name: str, slug: str, team_keys: set[str]) -> str | None:
    tokens = words(name) | words(slug)
    for team, keys in RULES:
        if tokens & keys:
            if team in CREATABLE_TEAMS or team in team_keys:
                return team
            return None
    return None


def error_text(data: object) -> str:
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            return f"{err.get('code', '')}: {err.get('message', '')}".strip(": ")
        if "detail" in data:
            return str(data["detail"])[:200]
        if "raw" in data:
            return str(data["raw"])
    return "unexpected response"


# --------------------------------------------------------------------- runner
@dataclass
class Ctx:
    http: Http
    secrets: Omaseal
    out: Out
    apply: bool
    rotate: bool
    tally_url: str
    glitchtip_url: str
    workspace: str | None
    tally_ref: tuple[str, str]
    glitchtip_refs: list[tuple[str, str]]
    overrides: dict[str, str]
    mutations: int = 0
    actions: list[str] = field(default_factory=list)

    def would(self, text: str) -> None:
        self.actions.append(text)
        self.out.say(("  do    " if self.apply else "  would ") + text)


def need(ctx: Ctx, status: int, data: object, what: str, ok: tuple[int, ...] = (200, 201)) -> object:
    if status not in ok:
        raise Abort(f"{what} failed: HTTP {status} {error_text(data)}")
    return data


def run(ctx: Ctx) -> int:
    out = ctx.out
    out.say(("APPLY" if ctx.apply else "DRY RUN (no changes; add --apply to act)"))

    # ---- credentials
    tally_tok = ctx.secrets.get(*ctx.tally_ref)
    if not tally_tok:
        raise Abort(f"no Tallyline token in omaseal ({ctx.tally_ref[0]} {ctx.tally_ref[1]})")
    out.learn(tally_tok)
    gt_tok = None
    for ref in ctx.glitchtip_refs:
        gt_tok = ctx.secrets.get(*ref)
        if gt_tok:
            out.say(f"GlitchTip token: omaseal {ref[0]} {ref[1]}")
            break
    if not gt_tok:
        tried = ", ".join(f"{s} {a}" for s, a in ctx.glitchtip_refs)
        raise Abort(f"no GlitchTip token in omaseal (tried {tried})")
    out.learn(gt_tok)

    T = require_https(ctx.tally_url, "--tally-url").rstrip("/")
    G = require_https(ctx.glitchtip_url, "--glitchtip-url").rstrip("/")

    # ---- Tallyline: who am I, which workspace, am I admin
    st, who = ctx.http.request("GET", f"{T}/v1/whoami", tally_tok)
    need(ctx, st, who, "Tallyline whoami")
    assert isinstance(who, dict)
    slug = ctx.workspace or who.get("workspaceSlug")
    if not slug:
        ms = who.get("memberships") or []
        if len(ms) == 1:
            slug = ms[0]["workspaceSlug"]
    if not slug:
        raise Abort("could not pick a workspace; pass --workspace SLUG")
    role = next(
        (m.get("role") for m in who.get("memberships") or [] if m.get("workspaceSlug") == slug),
        who.get("role"),
    )
    out.say(f"Tallyline workspace: {slug} (role: {role})")
    if role not in ("owner", "admin"):
        raise Abort("the Tallyline token must belong to a workspace owner or admin")
    W = f"{T}/v1/workspaces/{slug}"

    st, teams = ctx.http.request("GET", f"{W}/teams", tally_tok)
    need(ctx, st, teams, "list teams")
    team_keys = {t["key"] for t in (teams or {}).get("teams", [])}  # type: ignore[union-attr]
    out.say(f"Existing teams: {', '.join(sorted(team_keys)) or '(none)'}")

    # ---- GlitchTip: projects
    projects = glitchtip_projects(ctx, G, gt_tok)
    out.say(f"GlitchTip projects: {len(projects)}")

    desired: dict[str, str] = {}
    skipped: list[str] = []
    for p in projects:
        key = p["name"].strip().lower()
        team = ctx.overrides.get(key) or classify(p["name"], p["slug"], team_keys)
        if team:
            desired[key] = team
        else:
            skipped.append(f"{p['org']}/{p['slug']} ({p['name']})")
    for name, team in sorted(desired.items()):
        out.say(f"  map  {name} -> {team}")
    for s in skipped:
        out.say(f"  skip {s}: no rule matches (use --map NAME=TEAM)")
    missing_creatable = {t for t in desired.values() if t not in team_keys}
    for t in sorted(missing_creatable):
        if t not in CREATABLE_TEAMS:
            raise Abort(f"team {t} does not exist and this script only creates {', '.join(CREATABLE_TEAMS)}")

    # ---- 1. teams
    out.say("Teams")
    for key in sorted({"PACE", "WISP"} | missing_creatable):
        if key in team_keys:
            out.say(f"  ok   team {key} exists")
            continue
        ctx.would(f"create team {key} ({CREATABLE_TEAMS[key]})")
        if ctx.apply:
            st, d = ctx.http.request("POST", f"{W}/teams", tally_tok, {"key": key, "name": CREATABLE_TEAMS[key]})
            need(ctx, st, d, f"create team {key}")
            ctx.mutations += 1
            team_keys.add(key)

    # ---- 2. integration
    out.say("Integration")
    st, cur = ctx.http.request("GET", f"{W}/glitchtip", tally_tok)
    need(ctx, st, cur, "read GlitchTip integration")
    integ = (cur or {}).get("integration")  # type: ignore[union-attr]
    stored = ctx.secrets.get(*STORED_URL_REF)
    if stored:
        out.learn(stored)
    webhook_url: str | None = None
    prefix = f"{T}/webhooks/glitchtip/"

    def adopt(url: str) -> None:
        nonlocal webhook_url
        if not url.startswith(prefix):
            raise Abort(
                "the API returned a webhook URL that does not start with "
                f"{prefix} ; check API_BASE_URL on the server"
            )
        out.learn(url)
        webhook_url = url

    if integ is None:
        ctx.would(f"create the integration with {len(desired)} project mapping(s)")
        if ctx.apply:
            st, d = ctx.http.request("PUT", f"{W}/glitchtip", tally_tok, {"projectMap": desired})
            need(ctx, st, d, "create integration")
            ctx.mutations += 1
            assert isinstance(d, dict)
            url = d.get("webhookUrl")
            if not isinstance(url, str):
                raise Abort("create returned no webhook URL")
            out.learn(url)
            try:
                adopt(url)
                ctx.secrets.set(*STORED_URL_REF, url)
            except Abort:
                out.say("  !!   the integration exists but its URL could not be stored; rerun with --rotate")
                raise
            out.say(f"  ok   stored the webhook URL in omaseal ({STORED_URL_REF[0]} {STORED_URL_REF[1]}, {last4(url)})")
    else:
        merged = dict(integ.get("projectMap") or {})
        added = {k: v for k, v in desired.items() if k not in merged}
        conflicts = {k: (merged[k], v) for k, v in desired.items() if k in merged and merged[k] != v}
        for k, (have, want) in sorted(conflicts.items()):
            out.say(f"  keep {k} -> {have} (already set; rule would say {want})")
        if added:
            merged.update(added)
            ctx.would(f"add {len(added)} project mapping(s): {', '.join(sorted(added))}")
            if ctx.apply:
                st, d = ctx.http.request("PUT", f"{W}/glitchtip", tally_tok, {"projectMap": merged})
                need(ctx, st, d, "update project map")
                ctx.mutations += 1
        else:
            out.say("  ok   project map is current")
        tail = integ.get("tokenLast4")
        usable = bool(stored) and stored.startswith(prefix) and stored.endswith(str(tail))
        if ctx.rotate:
            ctx.would("rotate the secret (the old URL stops working immediately)")
            if ctx.apply:
                st, d = ctx.http.request("POST", f"{W}/glitchtip/rotate", tally_tok)
                need(ctx, st, d, "rotate secret")
                ctx.mutations += 1
                assert isinstance(d, dict)
                url = d.get("webhookUrl")
                if not isinstance(url, str):
                    raise Abort("rotate returned no webhook URL")
                out.learn(url)
                adopt(url)
                try:
                    ctx.secrets.set(*STORED_URL_REF, url)
                except Abort:
                    out.say("  !!   the secret was rotated on the server (the old URL is dead) but could not be stored in omaseal; rerun with --rotate to mint and store another")
                    raise
                out.say(f"  ok   stored the new webhook URL in omaseal ({last4(url)})")
        elif usable:
            adopt(stored)  # type: ignore[arg-type]
            out.say(f"  ok   using the stored webhook URL ({last4(stored)})")  # type: ignore[arg-type]
        else:
            raise Abort(
                "the integration exists but its webhook URL is not in omaseal "
                f"({STORED_URL_REF[0]} {STORED_URL_REF[1]}) or no longer matches the live secret. "
                "Tallyline shows the URL only once; rerun with --rotate to mint a new one."
            )

    # ---- 3. GlitchTip alerts
    out.say("GlitchTip alerts")
    for p in projects:
        key = p["name"].strip().lower()
        if key not in desired:
            continue
        label = f"{p['org']}/{p['slug']}"
        base = f"{G}/api/0/projects/{p['org']}/{p['slug']}/alerts/"
        st, alerts = ctx.http.request("GET", base, gt_tok)
        need(ctx, st, alerts, f"list alerts for {label}")
        mine = next((a for a in alerts if a.get("name") == ALERT_NAME), None) if isinstance(alerts, list) else None
        if webhook_url is None:
            # dry run before the integration exists, so there is no URL yet
            ctx.would(f"{'update' if mine else 'create'} alert '{ALERT_NAME}' on {label} -> tallyline webhook")
            continue
        recipient = {"recipientType": "webhook", "url": webhook_url, "tagsToAdd": []}
        if mine is None:
            ctx.would(f"create alert '{ALERT_NAME}' on {label}")
            if ctx.apply:
                body = {
                    "name": ALERT_NAME,
                    "timespanMinutes": 1,
                    "quantity": 1,
                    "uptime": False,
                    "environments": [],
                    "alertRecipients": [recipient],
                }
                st, d = ctx.http.request("POST", base, gt_tok, body)
                need(ctx, st, d, f"create alert on {label}")
                ctx.mutations += 1
            continue
        recs = mine.get("alertRecipients") or []
        has = any(r.get("recipientType") in ("webhook", "slack") and r.get("url") == webhook_url for r in recs)
        stale = [r for r in recs if "/webhooks/glitchtip/" in (r.get("url") or "") and r.get("url") != webhook_url]
        if has and not stale:
            out.say(f"  ok   {label}")
            continue
        ctx.would(f"update alert '{ALERT_NAME}' on {label} (point at the current webhook URL)")
        if ctx.apply:
            keep = [
                {"recipientType": r["recipientType"], "url": r.get("url", ""), "tagsToAdd": r.get("tagsToAdd") or []}
                for r in recs
                if "/webhooks/glitchtip/" not in (r.get("url") or "")
            ]
            body = {
                "name": ALERT_NAME,
                "timespanMinutes": mine.get("timespanMinutes") or 1,
                "quantity": mine.get("quantity") or 1,
                "uptime": bool(mine.get("uptime")),
                "environments": mine.get("environments") or [],
                "alertRecipients": keep + [recipient],
            }
            st, d = ctx.http.request("PUT", f"{base}{mine['id']}/", gt_tok, body)
            need(ctx, st, d, f"update alert on {label}")
            ctx.mutations += 1

    out.say("")
    if ctx.apply:
        out.say(f"Done: {ctx.mutations} change(s) made." if ctx.mutations else "Done: already in the desired state, nothing changed.")
    else:
        pending = len(ctx.actions)
        out.say(f"Dry run complete: {pending} change(s) pending." if pending else "Dry run complete: already in the desired state.")
    return 0


def glitchtip_projects(ctx: Ctx, G: str, token: str) -> list[dict[str, str]]:
    st, data = ctx.http.request("GET", f"{G}/api/0/projects/", token)
    need(ctx, st, data, "list GlitchTip projects")
    out: list[dict[str, str]] = []
    for p in data if isinstance(data, list) else []:
        org = p.get("organization")
        org_slug = org.get("slug") if isinstance(org, dict) else org
        if not org_slug or not p.get("slug"):
            continue
        out.append({"org": str(org_slug), "slug": str(p["slug"]), "name": str(p.get("name") or p["slug"])})
    return out


# ------------------------------------------------------------------ self test
class FakeSecrets:
    def __init__(self, values: dict[tuple[str, str], str]) -> None:
        self.values = dict(values)
        self.sets = 0

    def get(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def set(self, service: str, account: str, value: str) -> None:
        self.sets += 1
        self.values[(service, account)] = value


class FakeWorld(Http):
    """In-memory Tallyline + GlitchTip with the semantics the script relies on."""

    T = "https://api.test"
    G = "https://glitch.test"

    def __init__(self) -> None:
        self.teams = {"OPS": "Ops"}
        self.integration: dict | None = None
        self.token = ""
        self.alerts: dict[tuple[str, str], list[dict]] = {}
        self.next_alert = 1
        self.calls: list[tuple[str, str]] = []
        self.projects = [
            {"slug": "portal-ui", "name": "Portal UI", "organization": {"slug": "pace"}},
            {"slug": "strut", "name": "strut", "organization": {"slug": "pace"}},
            {"slug": "tenant-stackd", "name": "tenant-stackd", "organization": {"slug": "pace"}},
            {"slug": "wisp", "name": "Wisp", "organization": {"slug": "pace"}},
            {"slug": "kate", "name": "Kate", "organization": {"slug": "pace"}},
            {"slug": "billing-cron", "name": "billing-cron", "organization": {"slug": "pace"}},
        ]

    def _mint(self, n: int) -> str:
        self.token = f"tly_gt_FAKETOKEN{n:04d}XXXXXXXXXXXXXXXXXXXXXXXX"
        return f"{self.T}/webhooks/glitchtip/{self.token}"

    def request(self, method, url, token, body=None):  # type: ignore[override]
        self.calls.append((method, url))
        path = url.split(self.T)[1] if url.startswith(self.T) else url.split(self.G)[1]
        if url.startswith(self.T):
            if token != "TALLY-SECRET-TOKEN-0001":
                return 401, {"error": {"code": "UNAUTHENTICATED", "message": "no"}}
            if path == "/v1/whoami":
                return 200, {"workspaceSlug": "pace-ws", "role": "owner",
                             "memberships": [{"workspaceSlug": "pace-ws", "role": "owner"}]}
            base = "/v1/workspaces/pace-ws"
            if path == f"{base}/teams" and method == "GET":
                return 200, {"teams": [{"key": k, "name": n} for k, n in self.teams.items()]}
            if path == f"{base}/teams" and method == "POST":
                self.teams[body["key"]] = body["name"]
                return 201, body
            if path == f"{base}/glitchtip" and method == "GET":
                return 200, {"integration": self.integration}
            if path == f"{base}/glitchtip" and method == "PUT":
                if self.integration is None:
                    url = self._mint(len(self.calls))
                    self.integration = {"projectMap": body.get("projectMap", {}), "tokenLast4": self.token[-4:]}
                    return 201, {"integration": self.integration, "webhookUrl": url}
                self.integration["projectMap"] = body.get("projectMap", self.integration["projectMap"])
                return 200, {"integration": self.integration}
            if path == f"{base}/glitchtip/rotate":
                url = self._mint(len(self.calls))
                assert self.integration is not None
                self.integration["tokenLast4"] = self.token[-4:]
                return 200, {"integration": self.integration, "webhookUrl": url}
        else:
            if token != "GLITCH-SECRET-TOKEN-0002":
                return 401, {"detail": "bad token"}
            if path == "/api/0/projects/":
                return 200, self.projects
            m = re.match(r"/api/0/projects/([^/]+)/([^/]+)/alerts/(\d+/)?$", path)
            if m:
                key = (m.group(1), m.group(2))
                lst = self.alerts.setdefault(key, [])
                if method == "GET":
                    return 200, lst
                if method == "POST":
                    a = {**body, "id": self.next_alert}
                    self.next_alert += 1
                    lst.append(a)
                    return 201, a
                if method == "PUT":
                    aid = int(m.group(3).strip("/"))
                    for i, a in enumerate(lst):
                        if a["id"] == aid:
                            lst[i] = {**body, "id": aid}
                            return 200, lst[i]
        return 404, {"detail": "not found"}


def self_test() -> int:
    def ctx_for(world: FakeWorld, secrets, apply: bool, rotate: bool = False) -> Ctx:
        return Ctx(
            http=world, secrets=secrets, out=Out(quiet=True), apply=apply, rotate=rotate,
            tally_url=FakeWorld.T, glitchtip_url=FakeWorld.G, workspace=None,
            tally_ref=DEFAULT_TALLY_SECRET, glitchtip_refs=DEFAULT_GLITCHTIP_SECRETS,
            overrides={},
        )

    def mutating(world: FakeWorld) -> list[tuple[str, str]]:
        return [c for c in world.calls if c[0] != "GET"]

    base_secrets = {
        ("tallyline", "personal"): "TALLY-SECRET-TOKEN-0001",
        ("glitchtip", "Personal"): "GLITCH-SECRET-TOKEN-0002",  # `api` is absent: fallback order
    }

    # 0. rules against the real errors.pacehq.io project list (read 2026-10-25)
    real = {
        "pace-v2-api": "PACE", "pace-v2-frontend": "PACE", "pace-v2-inbox": "PACE",
        "pace-v2-messages": "PACE", "pace-v2-relay": "PACE", "pace-v2-sign": "PACE",
        "pace-v2-vault": "PACE", "pace-v2-workers": "PACE", "pace-id": "PACE",
        "pixel-tycoon": None, "bartlett-dashboard": None, "khanai-app": None,
        "orchestral-observatory": None, "portfolio-hub": None,
    }
    for slug, want in real.items():
        assert classify(slug.replace("-", " ").title(), slug, {"OPS"}) == want, slug
    assert classify("Wisp API", "wisp-api", {"OPS"}) == "WISP"
    assert classify("Kate", "kate", {"OPS"}) is None and classify("Kate", "kate", {"OPS", "KATE"}) == "KATE"

    # 1. dry run on a fresh instance writes nothing and stores nothing
    world, secrets = FakeWorld(), FakeSecrets(base_secrets)
    c = ctx_for(world, secrets, apply=False)
    assert run(c) == 0
    assert mutating(world) == [], mutating(world)
    assert secrets.sets == 0
    assert any("create team PACE" in a for a in c.actions) and any("create team WISP" in a for a in c.actions)
    assert any("create the integration" in a for a in c.actions)
    assert not any("kate" in a.lower() for a in c.actions if a.startswith("create team"))  # KATE never created
    assert any("billing-cron" in l and "skip" in l for l in c.out.lines)
    assert any("GlitchTip token: omaseal glitchtip Personal" in l for l in c.out.lines)

    # 2. apply: teams, integration, stored URL, one alert per mapped project
    world, secrets = FakeWorld(), FakeSecrets(base_secrets)
    c = ctx_for(world, secrets, apply=True)
    assert run(c) == 0
    assert {"PACE", "WISP"} <= set(world.teams) and "KATE" not in world.teams
    assert world.integration and world.integration["projectMap"] == {
        "portal ui": "PACE", "strut": "PACE", "tenant-stackd": "PACE", "wisp": "WISP",
    }, world.integration
    assert secrets.sets == 1
    url = secrets.values[STORED_URL_REF]
    assert url == f"{FakeWorld.T}/webhooks/glitchtip/{world.token}"
    mapped = {("pace", "portal-ui"), ("pace", "strut"), ("pace", "tenant-stackd"), ("pace", "wisp")}
    assert {k for k, v in world.alerts.items() if v} == mapped
    for k in mapped:
        (a,) = world.alerts[k]
        assert a["name"] == ALERT_NAME and a["alertRecipients"][0]["url"] == url
    text = "\n".join(c.out.lines)
    assert world.token not in text and url not in text and "TALLY-SECRET" not in text and "GLITCH-SECRET" not in text

    # 3. second apply is a no-op
    before = len(mutating(world))
    c2 = ctx_for(world, secrets, apply=True)
    assert run(c2) == 0
    assert len(mutating(world)) == before and secrets.sets == 1 and c2.mutations == 0, c2.actions

    # 4. stale alert URL is repaired, other recipients are kept
    key = ("pace", "strut")
    world.alerts[key][0]["alertRecipients"] = [
        {"recipientType": "email", "url": "", "tagsToAdd": []},
        {"recipientType": "webhook", "url": f"{FakeWorld.T}/webhooks/glitchtip/tly_gt_old", "tagsToAdd": []},
    ]
    c3 = ctx_for(world, secrets, apply=True)
    assert run(c3) == 0 and c3.mutations == 1
    recs = world.alerts[key][0]["alertRecipients"]
    assert [r["recipientType"] for r in recs] == ["email", "webhook"] and recs[1]["url"] == url

    # 5. integration exists but the URL is not stored: stop, point at --rotate, change nothing
    lost = FakeSecrets(base_secrets)
    before = len(mutating(world))
    try:
        run(ctx_for(world, lost, apply=True))
        raise AssertionError("expected Abort")
    except Abort as e:
        assert "--rotate" in str(e)
    assert len(mutating(world)) == before

    # 6. --rotate mints a new secret, stores it, repoints every alert
    old = world.token
    c4 = ctx_for(world, lost, apply=True, rotate=True)
    assert run(c4) == 0
    assert world.token != old and lost.values[STORED_URL_REF].endswith(world.token)
    for k in mapped:
        assert world.alerts[k][0]["alertRecipients"][-1]["url"].endswith(world.token)

    # 7. wrong server-side base URL is refused before anything is stored
    class BadBase(FakeWorld):
        def _mint(self, n: int) -> str:
            self.token = "tly_gt_ELSEWHERE0000000000000000000000"
            return f"http://localhost:4000/webhooks/glitchtip/{self.token}"

    bad, bad_secrets = BadBase(), FakeSecrets(base_secrets)
    try:
        run(ctx_for(bad, bad_secrets, apply=True))
        raise AssertionError("expected Abort")
    except Abort as e:
        assert "API_BASE_URL" in str(e)
    assert bad_secrets.sets == 0

    # 8. missing credentials fail with a clear message and no network call
    empty_world = FakeWorld()
    try:
        run(ctx_for(empty_world, FakeSecrets({}), apply=False))
        raise AssertionError("expected Abort")
    except Abort as e:
        assert "Tallyline token" in str(e)
    assert empty_world.calls == []

    # 10. plain http and redirects are refused
    for flag_kwargs in ({"tally_url": "http://api.test"}, {"glitchtip_url": "http://glitch.test"}):
        w = FakeWorld()
        cc = ctx_for(w, FakeSecrets(base_secrets), apply=False)
        for k, v in flag_kwargs.items():
            setattr(cc, k, v)
        try:
            run(cc)
            raise AssertionError("expected Abort")
        except Abort as e:
            assert "https://" in str(e)
        assert w.calls == []
    redir = urllib.error.HTTPError("https://x/y", 302, "Found", {}, None)  # type: ignore[arg-type]
    assert _NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://evil/") is None  # type: ignore[arg-type]
    assert redir.code == 302

    print("self-test ok: 10 scenarios")
    return 0


# ----------------------------------------------------------------------- main
def parse_ref(raw: str) -> tuple[str, str]:
    service, _, account = raw.partition("/")
    if not service or not account:
        raise argparse.ArgumentTypeError("expected SERVICE/ACCOUNT")
    return service, account


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="make the changes (default is a dry run)")
    ap.add_argument("--rotate", action="store_true", help="mint a new webhook secret and repoint every alert")
    ap.add_argument("--tally-url", default=DEFAULT_TALLY_URL)
    ap.add_argument("--workspace", help="workspace slug (default: from the token)")
    ap.add_argument("--glitchtip-url", default=DEFAULT_GLITCHTIP_URL)
    ap.add_argument("--tally-secret", type=parse_ref, default=DEFAULT_TALLY_SECRET, metavar="SERVICE/ACCOUNT")
    ap.add_argument("--glitchtip-secret", type=parse_ref, action="append", metavar="SERVICE/ACCOUNT")
    ap.add_argument("--map", action="append", default=[], metavar="PROJECT=TEAM",
                    help="force a GlitchTip project name onto a team key (repeatable)")
    ap.add_argument("--self-test", action="store_true", help="run the offline checks and exit")
    a = ap.parse_args(argv)

    if a.self_test:
        return self_test()

    overrides: dict[str, str] = {}
    for m in a.map:
        name, _, team = m.partition("=")
        if not name or not team:
            ap.error("--map expects PROJECT=TEAM")
        overrides[name.strip().lower()] = team.strip().upper()

    ctx = Ctx(
        http=Http(), secrets=Omaseal(), out=Out(), apply=a.apply, rotate=a.rotate,
        tally_url=a.tally_url, glitchtip_url=a.glitchtip_url, workspace=a.workspace,
        tally_ref=a.tally_secret, glitchtip_refs=a.glitchtip_secret or DEFAULT_GLITCHTIP_SECRETS,
        overrides=overrides,
    )
    try:
        return run(ctx)
    except Abort as e:
        ctx.out.say(f"error: {e}")
        return 1
    except Exception as e:  # unexpected response shapes must not dump a traceback with context
        ctx.out.say(f"error: unexpected {type(e).__name__} while talking to the servers; rerun to continue (the script is safe to re-run)")
        return 1


if __name__ == "__main__":
    sys.exit(main())
