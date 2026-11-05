# @tallyline/cli

Command line for [Tallyline](https://github.com/duketopceo/tallyline). Installs
`tallyline` and the short alias `tly`.

```
npm i -g @tallyline/cli
tallyline help
```

```
tallyline connect     # sign in once, in your browser; the token goes to your keychain
tallyline             # see where things stand
tallyline doctor      # check everything is healthy
```

![tallyline connect, home and doctor](docs/demo/demo.gif)

Scripts and CI can skip `connect` and set `TALLYLINE_API_URL`, `TALLYLINE_TOKEN`
and `TALLYLINE_WORKSPACE`, or run `tallyline connect --server URL --token-stdin`.

`tallyline connect` offers to sign you in through your browser: it shows a short code, opens
the approval page, and waits. Over SSH or on a computer with no browser, run
`tallyline connect --browser` and open the address it prints on any device. `--paste` goes
straight to pasting a token. Browser sign-in needs a workspace admin or owner and a server
that has the device endpoints (this release); older servers fall back to pasting automatically.

## What you see

On a terminal, `tallyline` with no arguments shows where things stand (what
needs your review, what is being worked on) and the next commands to try.
`tallyline help` groups every command, and errors are written in plain language
with one suggested next step and a short reference you can quote when asking
for help. Design notes and the full error catalogue: [docs/design/cli.md](../../docs/design/cli.md).

Anything that is not a terminal (pipes, CI, `--json`) keeps the original plain
output and exit codes, byte for byte. `NO_COLOR` turns colour off.

## Teams, links and conflicts

```
tallyline move-team ENG-12 OPS   # move to another team (key or name); prints the new key
tallyline link ENG-12            # prints the issue's url, exactly as the server returns it
```

Both accept `--json`. Writes send an `Idempotency-Key` header (a retry is a no-op) and
an `If-Match` header with the version you read. If the issue changed since, the server
answers `409 STALE_WRITE`: the CLI prints the server's current value and exits `6`
(with `--json`, a `{ "error": { "code": "STALE_WRITE" }, "current": … }` document on
stdout). Re-run the command to apply it on top of the current version.
`link` exits `1` with a message if the server predates the link API; `move-team`
exits `4` if no team matches.

Exit codes: 0 ok · 1 error · 2 usage/config · 3 unauthorized/forbidden · 4 not found ·
5 conflict · 6 stale write.

## Doctor checks for hosted servers

`tallyline doctor` also reports, in the Your server group: whether the server advertises
Sign in with Apple in `/v1/auth/methods`, and whether it supports the write contract
(the `STALE_WRITE` schema in `/openapi.json`; no capability flag exists yet). Under
This computer it compares your clock with the server's HTTP `Date` header and warns past
60 seconds. A server that lacks either capability gets a warning (with the fix on the
next line), not a failure, so self-hosted and older servers still exit 0.
