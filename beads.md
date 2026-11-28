# Beads

Issues deferred from a slice to be handled in a later spec.

## Open

### Broadcast-before-response ordering in transaction routes

- **Status:** open
- **Filed from:** slice 06 (deposit and withdraw)
- **Area:** `src/server/http/routes/transactions.ts`

**Context.** In slice 06 the transaction routes broadcast `account`/`activity` and *then* send the HTTP response (`res.json`), so peers are notified before the initiating client's request completes:

```ts
broadcastAccount(result.account);
broadcastActivity(result.entry);
res.json({ account: result.account });
```

**Problem.** If a broadcast throws, Express returns `500` even though the transaction already committed, so the caller sees an error for money that did move. The alternative (respond, then broadcast) is worse: a throw after `res.json` is silent to peers and cannot be reported. Socket.IO `emit` is synchronous and does not throw in practice, so the window is theoretical, but the contract is untested and unspecified.

**Options.**

1. Make broadcasts explicitly non-throwing: wrap each `broadcast*` call in `try/catch` and log, so a failure never turns a committed transaction into an HTTP error.
2. Define a documented ordering contract in a later spec (e.g. "broadcasts are best-effort; the response reflects the committed state") and add a test that spies on the realtime module to assert call order relative to `res.json`.
3. Move broadcasts out of the request path entirely (e.g. an async post-commit hook), so the response is always the source of truth for the caller and broadcasts cannot affect status.

**Recommendation.** Option 2 for the spec (document the contract), plus option 1 as a defensive guard. Revisit in slice 07 if lock broadcasts hit the same path.