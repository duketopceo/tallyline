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
