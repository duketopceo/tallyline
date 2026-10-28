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
