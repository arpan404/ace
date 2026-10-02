# Mutation verification

Each production mutation below caused its selected public behavior test to fail. All mutations were reverted before the final full check. Run from the repo root with `node packages/client/tools/mutations.ts`.

- result-type decoder bypassed: killed by "a correlated response of the wrong result type".
- daemon identity guard removed: killed by "a reconnect to a different daemon identity".
- incremental entity cap removed: killed by "incremental entity overflow".
- snapshot item-count cap removed: killed by "a snapshot exceeding the wire item budget".
- retry cap removed: killed by "retry ceilings double".
- resume cursor omitted: killed by "reconnect mid-stream".
- duplicate coverage resyncs: killed by "reconnect mid-stream".
- missing coverage ignored: killed by "a dropped frame".
- request deadline reports abort: killed by "a request deadline".
- abort reports timeout: killed by "abort cancels".
- first release unsubscribes: killed by "two views keep".
- MRU eviction replaces LRU: killed by "LRU retains".
- fatal auth accepts network retries: killed by "an auth rejection".
- restart drops pending replay: killed by "a persisted outbox".
- delta mutates prior selected item: killed by "only the changed item".
- send precedes durable write: killed by "a failed persistence write".
