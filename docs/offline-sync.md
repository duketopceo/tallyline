# Offline clients: delta reads and safe retries

What an offline-capable client (the iOS app first) needs from the API. Both parts
work for any client.

## Delta reads: `updatedSince`

`GET /v1/workspaces/{ws}/issues?updatedSince=<ISO instant>&limit=200` returns the
issues changed at or after that instant, oldest change first, with a `nextCursor`
until the page is the last one. The cursor only works with `updatedSince` (a
newest-first cursor is refused with `BAD_CURSOR`, and the other way round).

A sync loop:

1. First run: page the normal listing and remember the largest `updatedAt` seen.
2. Later: call with `updatedSince=<that value>` and page to the end; remember the
   new largest `updatedAt`.
3. Upsert by `id`. The bound is inclusive and two changes can share a
   millisecond, so the boundary row comes back again and must not double-apply.

Ordering is by the change time truncated to the millisecond a JSON timestamp can
carry, then by id, so paging never skips or loops on rows that differ only in
microseconds. Issues are never deleted (they move to `canceled` or `duplicate`),
so this listing needs no tombstones. Comments, labels, projects, cycles and
notifications do not have delta reads yet.

## Safe retries: `Idempotency-Key`

Send `Idempotency-Key: <8-128 chars of letters, digits and . _ ~ : ->` on
`POST /issues`, `PATCH /issues/{key}` and `POST /issues/{key}/comments`.

| Situation | Result |
|---|---|
| first request | runs normally; a successful (2xx) response is stored for 24 hours |
| retry, same key and same request | the stored response, with `Idempotent-Replayed: true`; nothing is written again |
| same key, different method, path or body | `422 IDEMPOTENCY_KEY_REUSED` |
| retry while the first is still running | `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1` |
| first request failed (any non-2xx) | the key is released; fix the request and reuse it |
| another caller sends the same string | their own entry (keys are scoped to workspace and caller) |
| malformed key | `400 BAD_IDEMPOTENCY_KEY` |

A claim that never finished (the server died mid-request) is treated as abandoned
after a minute and can be taken over. Authorization runs before any stored
response is replayed, so a key never leaks a response to someone who could not
have made the request.

## Stale writes: `version` and `If-Match`

Every issue carries an integer `version` on every read (create, detail, list,
delta list) and every patch response. It starts at 1 and rises by one on every
update to the row, whoever makes it. It is a separate counter from `updatedAt`:
the delta cursor still orders by `updatedAt`, so `updatedSince` paging is
unchanged.

To make an edit safe against a change made elsewhere, send the version you read:

`PATCH /issues/{key}` with `If-Match: <version>` (a bare integer; the quoted form
`"7"` is accepted too).

| Situation | Result |
|---|---|
| `If-Match` equals the current version | the patch runs; the response carries the new `version` |
| `If-Match` is behind | `409 STALE_WRITE`, nothing is written (not even a state change) |
| no `If-Match` | no precondition, the patch runs (clients that predate this contract) |
| `If-Match` is not an integer | `400 BAD_IF_MATCH` |
| replay of a patch with the same `Idempotency-Key` | the stored first response, never `STALE_WRITE`: the replay is checked before the precondition |

The `STALE_WRITE` body reuses the `STALE_DIFF` shape, an `error` plus the current
server state:

```json
{ "error": { "code": "STALE_WRITE", "message": "..." }, "issue": { "key": "ENG-1", "version": 7, "...": "..." } }
```

`issue` is the current server issue (the same row a patch returns). A
`STALE_WRITE` is not stored under the `Idempotency-Key`, so after the person
chooses, the resend can reuse the key.

The only other `409` on these routes is `IDEMPOTENCY_IN_PROGRESS` (and an illegal
state transition on patch). Clients must branch on `error.code`, never on the
status alone: `IDEMPOTENCY_IN_PROGRESS` is retried, `STALE_WRITE` is not.

Creates and comments are append-only, so they carry an `Idempotency-Key` but no
version precondition.

### What clients do

- **Keep the version you read.** Send it as `If-Match` with the edit. Several
  edits queued offline against one issue were all made against the same version:
  after the first succeeds, move the rest to the version it returned (the
  response's `version`), otherwise they would conflict with the user's own write.
- **On `STALE_WRITE`, never retry silently.** Roll back the optimistic value and
  ask once: *Keep mine* resends the edit with `If-Match` set to `issue.version`
  from the response (it overwrites the other change knowingly); *Use theirs*
  drops the local edit and shows the server's issue.
- **iOS** (`TallylineCore`): `OutboxEntry.baseVersion`, `OutboxFailure.conflict`,
  status `needsDecision`, `Outbox.keepMine` / `Outbox.useTheirs`. `needsDecision`
  entries show as `parked`.
- **Web**: `apps/web/lib/write-contract.ts` (`sendIssuePatch`) behind the shared
  issue store (`components/app/issue-store.tsx`); the prompt is a toast with
  Keep mine / Use theirs.

The check and the write are two statements, not one transaction, so two writers
that both pass the check within the same few milliseconds can still both apply;
the contract stops edits made against a version someone has already replaced,
which is the case an offline client creates.
