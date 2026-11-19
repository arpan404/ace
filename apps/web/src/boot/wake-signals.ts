/**
 * The moments this page may have been away from its daemon: the computer woke from sleep or was
 * unlocked (the desktop app says so), the network came back, the window was shown again, or the
 * page came back from the back/forward cache. At each the connection checks its socket at once
 * and runs a waiting reconnect now (`ClientApi.wake`), instead of finding out on its next
 * heartbeat or after its backoff. Sleep hides nothing here: these are cues, not clocks.
 */
export function watchWakes(wake: () => void, scope: object = globalThis): () => void {
  const stops: (() => void)[] = [];
  const listen = (target: unknown, type: string, listener: (event: Event) => void) => {
    const add: unknown = target && Reflect.get(target, "addEventListener");
    const remove: unknown = target && Reflect.get(target, "removeEventListener");
    if (typeof add !== "function" || typeof remove !== "function") return;
    Reflect.apply(add, target, [type, listener]);
    stops.push(() => Reflect.apply(remove, target, [type, listener]));
  };
  const cue = () => wake();
  listen(scope, "online", cue);
  // Shown from the back/forward cache: its socket was closed or frozen meanwhile.
  listen(scope, "pageshow", (event) => {
    if (Reflect.get(event, "persisted") === true) wake();
  });
  const document: unknown = Reflect.get(scope, "document");
  listen(document, "visibilitychange", () => {
    if (document && Reflect.get(document, "visibilityState") === "visible") wake();
  });
  const bridge: unknown = Reflect.get(scope, "ace");
  const resumed: unknown = bridge && Reflect.get(bridge, "onSystemResumed");
  if (typeof resumed === "function") {
    const stop: unknown = Reflect.apply(resumed, bridge, [cue]);
    if (typeof stop === "function") stops.push(() => Reflect.apply(stop, undefined, []));
  }
  return () => {
    for (const stop of stops.splice(0)) stop();
  };
}
