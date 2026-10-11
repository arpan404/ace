/** Authorize a selected daemon before its pairing fetch, worker or socket can start. */
export async function authorizeDaemonUrl(input: string, scope: object = globalThis): Promise<void> {
  const ace: unknown = Reflect.get(scope, "ace");
  if (typeof ace !== "object" || ace === null || !("daemon" in ace)) return;
  const daemon: unknown = ace.daemon;
  if (typeof daemon !== "object" || daemon === null || !("authorize" in daemon)) return;
  const authorize: unknown = daemon.authorize;
  if (typeof authorize !== "function") return;
  const url = new URL(input);
  url.protocol =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  await Reflect.apply(authorize, daemon, [url.toString()]);
}
