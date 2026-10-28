# CLI design

The `tallyline` command is the friendly front door: someone who has never used a
terminal tool should be able to install it, sign in, see where things stand and
recover from a mistake without reading docs. The product behind it stays a
serious, dense issue tracker (see `DESIGN.md`); only the CLI gets this
ease-of-use treatment. Origin and mockups for every screen:
`docs/brainstorms/2026-10-28-self-hosted-linear-ios-agent-providers-cli-requirements.md`.

## Principles

1. **Say what is happening, then what to do next.** Screens end with a `Next` block of two or three commands.
2. **Plain language.** "You're not signed in yet", not `401 UNAUTHENTICATED`. Every failure says what happened, why it usually happens, and one thing to try. A short reference (`TLY-401-UNAUTHENTICATED`) is shown so a person can quote it when asking for help.
3. **Good defaults, few questions.** Enter accepts the default shown. Esc or Ctrl-C always leaves cleanly and says nothing was changed. Destructive confirmations default to No.
4. **Machine contract untouched.** Everything decorative is terminal-only.

## Output contract (what scripts can rely on)

| Situation | Behaviour |
|---|---|
| stdout is not a terminal (pipe, CI, redirect) | plain text, no colour, no prompts, no spinners; byte-identical to before the redesign (pinned by `src/golden.test.ts`) |
| `--json` | machine output only; never decorated |
| `NO_COLOR` set | no colour even on a terminal |
| `connect` needs a token | `--token-stdin`; tokens are never accepted as arguments (they would show in `ps`) |
| exit codes | 0 ok, 1 failure, 2 usage or bad request, 3 unauthenticated/forbidden, 4 not found, 5 conflict |
| `doctor` | exit 1 when any check fails, 0 otherwise (warnings do not fail) |

Prompts come from one seam (`src/ui/prompt.ts`, `Prompter`), backed by
`@clack/prompts` bundled at build time, so the published package has no runtime
dependencies and tests drive commands with scripted answers.

## Commands in this stage

| Command | What it does |
|---|---|
| `tallyline` (terminal, no arguments) | home: what needs you, what is in progress, next steps |
| `tallyline help` | commands grouped by what you are trying to do |
| `tallyline connect` | guided sign in (server, token, check, save); `--server`, `--token-stdin` for scripts |
| `tallyline status` / `disconnect` / `config` | who and where you are; forget the sign-in; view or change saved settings |
| `tallyline doctor [--fix]` | grouped health checks (your server, your sign-in, this computer), `--json` for scripts, `--fix` only tightens file permissions and asks first |

Where the token lives: macOS Keychain, else libsecret (`secret-tool`), else a
private file (`~/.config/tallyline/credentials.json`, mode 0600) that `doctor`
points out. It never goes in `config.json`, argv or logs. `TALLYLINE_KEYCHAIN=off`
forces the file (CI, tests).

## Error catalogue

| API code or status | Title shown | Suggested next step |
|---|---|---|
| `UNAUTHENTICATED` | Tallyline didn't accept your sign-in | `tallyline connect` |
| `FORBIDDEN` | You don't have permission to do that | ask an admin, or sign in as another account |
| `FORBIDDEN_AGENT` | Agents can't do that part | move to in_review and comment; a person decides |
| `FORBIDDEN_SCOPE` | This key can only read | use a key with write access |
| `NOT_FOUND` | Couldn't find that | `tallyline list --search <words>` |
| `INVALID_TRANSITION` | That issue can't move there yet | `tallyline show <KEY>` |
| `STALE_DIFF` | The plan changed since you previewed it | run the import again |
| `RATE_LIMITED`, 429 | That's a lot of requests at once | wait a few seconds |
| `NETWORK` (no response) | Couldn't reach your Tallyline server | `tallyline doctor` |
| 500 / 502 / 503 | Something went wrong on the server / isn't answering / is busy | try again; `tallyline doctor` |

The catalogue lives in `tools/cli/src/ui/errors.ts`; the table above is
checked by eye in review, the strings by `src/ui/ui.test.ts`.

## Terminal mark (proposal, needs sign-off)

Sampled from `assets/brand/mark.svg` (four strokes, one rising strike), not
redrawn by hand: `assets/brand/terminal-mark.txt`. Strokes use the ink colour
and the strike uses the azure accent when colour is on.

```text
  ▄▄ ▄▄ ▄▄ ▄▄
  ██ ██ ██ █▀ ▄
  ██ ██ ▀▀ ▄███▀
  ██ ▀ ▄▄███▀
   ▄▄███▀▀ ▄█
▄███▀▀▄ ██ ██
 ▀▄▄ ██ ██ ██
  ▀▀ ▀▀ ▀▀ ▀▀
```

The shipped banner (`✦ tallyline` and the `||||` tally) is unchanged until the
mark is approved.

## Demo recording

`tools/cli/docs/demo/` holds a fake server (`server.mjs`, fake data only), an
environment script and a [vhs](https://github.com/charmbracelet/vhs) tape.

```sh
pnpm --filter @tallyline/cli build
cd tools/cli/docs/demo && vhs demo.tape   # writes demo.gif
```
