# @tallyline/cli

Command line for [Tallyline](https://github.com/duketopceo/tallyline). Installs
`tallyline` and the short alias `tly`.

```
npm i -g @tallyline/cli
tallyline help
```

Needs `TALLYLINE_API_URL`, `TALLYLINE_TOKEN` and `TALLYLINE_WORKSPACE`.

## What you see

On a terminal, `tallyline` with no arguments shows where things stand (what
needs your review, what is being worked on) and the next commands to try.
`tallyline help` groups every command, and errors are written in plain language
with one suggested next step and a short reference you can quote when asking
for help.

Anything that is not a terminal (pipes, CI, `--json`) keeps the original plain
output and exit codes, byte for byte. `NO_COLOR` turns colour off.
