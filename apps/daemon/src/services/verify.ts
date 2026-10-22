import { join } from "node:path";
import { logError } from "@ace/diagnostics";
import { VerifyRequest, type VerifyResult } from "@ace/protocol";
import { runSetupScript } from "../creation-setup.ts";
import { supervisedCheckShell } from "../verify/check-process.ts";
import { workspaceVerifyForge } from "../verify/forge-port.ts";
import { projectCheck } from "../verify/project-check.ts";
import { Verify } from "../verify/verify-service.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/** A check command that runs past this is stopped and fails. */
const checkTimeoutMs = 60 * 60 * 1000;

export function startVerify({
  store,
  services,
  config,
  now,
  id,
  log,
  resources,
}: ServiceContext): void {
  const runtime = services.workspaceActions;
  if (!runtime) throw new Error("Verify needs workspace actions");
  const verify = new Verify({
    store,
    git: runtime.git,
    forge: workspaceVerifyForge(runtime),
    shell: supervisedCheckShell({ timeoutMs: checkTimeoutMs }),
    setup: ({ path, signal, output, started }) =>
      runSetupScript(runtime.git, path, signal, { stderr: output }, started),
    root: join(config.dataDir, "verify"),
    now,
    id,
    project: (workspaceId) => projectCheck(store, workspaceId),
    log: (message, error) => log.log("warn", message, logError(error)),
  });
  services.verify = verify;
  resources.own(() => verify.close(), "verify");
  void verify.recover();
}

/**
 * `verify.request`: list and log need read scope, start and cancel operate scope. Every
 * change to a run reaches each socket allowed to read.
 */
export function createVerifySession({
  options,
  authorize,
  authorityLease,
  connected,
  send,
}: SocketContext): SocketService {
  let stop: (() => void) | undefined;
  return {
    authenticated() {
      stop = options.verify?.subscribe((change) => {
        if (connected() && authorize("read")) send(change);
      });
    },
    close() {
      stop?.();
    },
    async handle(message) {
      if (message.type !== "verify.request") return false;
      const request = VerifyRequest.parse(message);
      const reply = (result: Omit<VerifyResult, "type" | "requestId">) =>
        send({ type: "verify.result", requestId: request.requestId, ...result });
      const verify = options.verify;
      const op = request.op;
      const scope = op.action === "list" || op.action === "log" ? "read" : "operate";
      const permitted = authorize(scope);
      if (!permitted || !verify) {
        reply({ ok: false, error: permitted ? "unavailable" : "forbidden" });
        return true;
      }
      if (op.action === "list") {
        const listed = await verify.list(op.workspaceId);
        reply(
          listed.ok
            ? { ok: true, runs: listed.runs, command: listed.command }
            : { ok: false, error: listed.error },
        );
      } else if (op.action === "log") {
        const log = verify.log(op.runId);
        reply(log ? { ok: true, log } : { ok: false, error: "not_found" });
      } else {
        const answer =
          op.action === "start"
            ? await verify.start(
                op.workspaceId,
                op.target,
                authorityLease?.("operate") ?? (() => authorize("operate")),
              )
            : await verify.cancel(op.runId);
        reply(answer.ok ? { ok: true, run: answer.run } : { ok: false, error: answer.error });
      }
      return true;
    },
  };
}
