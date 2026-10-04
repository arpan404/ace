import { unwrapShellCommand } from "@ace/provider-kit/shell-command";
import type { ItemDraft, ToolDetailDraft } from "@ace/core";
import { list, obj, str, type Obj } from "./native.ts";

export function commandDetail(item: Obj): ToolDetailDraft {
  const actions = list(item["commandActions"]);
  const rawCommand = str(item["command"]);
  // Decode once; action fallback is O(1), even for large action arrays.
  const decoded = unwrapShellCommand(rawCommand)?.inner ?? rawCommand;
  const command = actions.length
    ? actions.map((value) => str(obj(value)["command"], decoded)).join(" && ")
    : decoded;
  return (
    (actions.length === 1 ? actionDetail(obj(actions[0])) : undefined) ?? {
      kind: "shell",
      command,
      ...(command !== rawCommand ? { rawCommand } : {}),
      cwd: str(item["cwd"]),
      ...(typeof item["exitCode"] === "number" ? { exitCode: item["exitCode"] } : {}),
    }
  );
}
function actionDetail(action: Obj): ToolDetailDraft | undefined {
  if (action["type"] === "read") return { kind: "file.read", path: str(action["path"]) };
  if (action["type"] === "search" || action["type"] === "listFiles")
    return {
      kind: "search",
      query: str(action["query"], str(action["command"])),
      ...(typeof action["path"] === "string" ? { path: action["path"] } : {}),
    };
  return undefined;
}
/** Each parsed read/search gets its own structured detail; the parent retains executable evidence. */
export function commandActionItems(
  item: Obj,
  complete: boolean,
): { key: string; draft: ItemDraft }[] {
  const actions = list(item["commandActions"]);
  if (actions.length < 2) return [];
  return actions.flatMap((value, index) => {
    const action = obj(value),
      detail = actionDetail(action);
    return detail
      ? [
          {
            key: `${str(item["id"])}:action:${index}`,
            draft: {
              type: "tool_call",
              complete,
              call: {
                kind: detail.kind,
                title: str(action["command"]),
                detail,
                status: !complete
                  ? "running"
                  : item["status"] === "failed"
                    ? "failed"
                    : "succeeded",
                raw: [{ type: "commandAction", data: action }],
              },
            },
          },
        ]
      : [];
  });
}
