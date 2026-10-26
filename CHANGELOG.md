# Change notes

## 2026-10-26 — Real-time click synchronization

Implemented fixes from the **Astra Max code review**.

- Send one atomic Firebase update per click for the global total, the original nickname's score, and its server timestamp.
- Keep individual writes paced at 60 ms, with up to eight outstanding writes so normal clicking does not wait for every acknowledgment. No click batching interval is used.
- Track retries per click with backoff. A burst of rejected requests no longer clears unrelated pending clicks, and changing nicknames cannot redirect queued clicks or retries.
- Keep the global count and leaderboard responsive by displaying queued clicks immediately, without counting Firebase's own optimistic updates twice.
- Hold new writes while disconnected. Persistent rejection pauses synchronization with a Retry syncing button and retains the waiting clicks.

Validation:

- `node --test tests/click-sync.test.cjs`: eight regression tests passed.
- Firebase SDK 8.10.1 and Realtime Database emulator 4.11.2, using the supplied security rules: atomic success/rejection, reconnect/rename handling, and recovery of all 20 clicks after seven rejected attempts passed.
- Chromium page checks: immediate counts, updates in a second browser, offline nickname changes, paused-sync recovery, local reset, and mobile layout passed with no JavaScript errors. App Check was substituted only in the local emulator test environment.

Operational notes: the existing Firebase rules and production App Check initialization are retained. Pending clicks are held for the current page session; keep the tab open until syncing completes. The page requests a navigation warning while clicks remain pending. Existing differences between historical global and leaderboard totals are not reconciled by this change.
