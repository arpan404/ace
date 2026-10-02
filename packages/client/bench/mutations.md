# Mutation cases

Final revision status: not executed (tests run at merge). Each case names the public behavior test designed to detect it. The four review survivors are listed first. Earlier fix-round runs caught all 16 mutations and restored production code, before the owner prohibited further execution. That historical result does not verify the final revision. Runtime verification needs run at merge. The runner is retained for the merge-time verification workflow.

- result-type decoder bypassed: covered by "a correlated response of the wrong result type"; not executed (tests run at merge).
- daemon identity guard removed: covered by "a reconnect to a different daemon identity"; not executed (tests run at merge).
- incremental entity cap removed: covered by "incremental entity overflow"; not executed (tests run at merge).
- snapshot item-count cap removed: covered by "a snapshot exceeding the wire item budget"; not executed (tests run at merge).
- retry cap removed: covered by "retry ceilings double"; not executed (tests run at merge).
- resume cursor omitted: covered by "reconnect mid-stream"; not executed (tests run at merge).
- duplicate coverage resyncs: covered by "reconnect mid-stream"; not executed (tests run at merge).
- missing coverage ignored: covered by "a dropped frame"; not executed (tests run at merge).
- request deadline reports abort: covered by "a request deadline"; not executed (tests run at merge).
- abort reports timeout: covered by "abort cancels"; not executed (tests run at merge).
- first release unsubscribes: covered by "two views keep"; not executed (tests run at merge).
- MRU eviction replaces LRU: covered by "LRU retains"; not executed (tests run at merge).
- fatal auth accepts network retries: covered by "an auth rejection"; not executed (tests run at merge).
- restart drops pending replay: covered by "a persisted outbox"; not executed (tests run at merge).
- delta mutates prior selected item: covered by "only the changed item"; not executed (tests run at merge).
- send precedes durable write: covered by "a failed persistence write"; not executed (tests run at merge).
