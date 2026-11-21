import { option } from "../args.ts";
import { CliFailure } from "../output.ts";
import { spadeProgramOrRefuse } from "./bot-kit.ts";
import { withSession, type CommandContext, type Handlers } from "./context.ts";

/* `ace org audit export|verify` (ADR 0206 §4.2): the org host's audit log. */

async function exportLog(context: CommandContext): Promise<void> {
  const { exportAudit, moment } = await import("../org-audit.ts");
  const span = {
    from: moment(option(context.args, "from"), "--from"),
    to: moment(option(context.args, "to"), "--to"),
  };
  const { spadeExchanger } = await import("../spade-call.ts");
  let text = "";
  await withSession(context, context.args, async ({ client, signal }) => {
    text = await exportAudit(await spadeExchanger(client, signal), span);
  });
  const out = option(context.args, "out");
  if (!out) {
    process.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
    return;
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(out, text, { mode: 0o600 });
  const { emit } = await import("../io.ts");
  const lines = text.split("\n").filter((line) => line.trim() !== "").length;
  await emit(
    context.args,
    { path: out, lines },
    { human: (value) => [`Wrote ${value.lines} lines to ${value.path}.`], quiet: (v) => [v.path] },
  );
}

async function verify(context: CommandContext): Promise<void> {
  const file = context.args.words[0] ?? "";
  const { ownAuditKey, verifyAudit } = await import("../org-audit.ts");
  let key = option(context.args, "key");
  if (!key) {
    const { spadeExchanger } = await import("../spade-call.ts");
    await withSession(context, context.args, async ({ client, signal }) => {
      key = await ownAuditKey(await spadeExchanger(client, signal));
    });
  }
  if (!key)
    throw new CliFailure("failed", "No audit key to check with.", undefined, {
      code: "failed",
    });
  const verdict = await verifyAudit(await spadeProgramOrRefuse(context), file, key);
  const { emit } = await import("../io.ts");
  await emit(context.args, verdict, { human: (value) => [value.said], quiet: () => [] });
  if (!verdict.verified)
    throw new CliFailure("failed", "The audit log doesn't verify.", undefined, {
      code: "check_failed",
    });
}

export const orgHandlers: Handlers = {
  "org.audit.export": exportLog,
  "org.audit.verify": verify,
  "org.registry.key": async (context) => {
    const { registryKeyCommand } = await import("../org-registry.ts");
    await registryKeyCommand(context.args);
  },
  "org.registry.sign": async (context) => {
    const { registrySignCommand } = await import("../org-registry.ts");
    await registrySignCommand(context.args);
  },
};
