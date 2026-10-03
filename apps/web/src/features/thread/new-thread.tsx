import type { SidebarReader } from "@ace/client";
import { arrayEqual, useClient, useSidebar } from "@ace/client-react";
import { WorkspaceId } from "@ace/protocol";
import { CaretDownIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/screen.tsx";
import { Composer, type Draft } from "./composer/composer.tsx";
import { ModelPicker, defaultChoice, useModelChoices } from "./composer/model-picker.tsx";
import type { ModelChoice } from "./sources/model-source.ts";

/** Projects with threads on this host, most recently active first. */
function readProjects(reader: SidebarReader): string[] {
  const latest = new Map<string, number>();
  for (const id of reader.ids) {
    const entry = reader.thread(id);
    if (entry)
      latest.set(entry.workspaceId, Math.max(latest.get(entry.workspaceId) ?? 0, entry.updatedAt));
  }
  return [...latest].toSorted((a, b) => b[1] - a[1]).map(([workspace]) => workspace);
}
const readIds = (reader: SidebarReader) => reader.ids;
const none: readonly string[] = [];

/** The title a thread starts with: the first line of the ask, trimmed to a header's length. */
export function titleFrom(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line || "New thread";
}

/**
 * ⌘N. Pick a project and a model, describe the work; the thread is created when you send and
 * the view moves to it as soon as the daemon reports it.
 */
export function NewThread() {
  const client = useClient();
  const toast = useToast();
  const navigate = useNavigate();
  const projects = useSidebar(["ids"], readProjects, arrayEqual) ?? none;
  const ids = useSidebar(["ids"], readIds, arrayEqual) ?? none;
  const choices = useModelChoices();
  const [project, setProject] = useState<string>();
  const [model, setModel] = useState<ModelChoice>();
  const [waiting, setWaiting] = useState<{
    title: string;
    workspace: string;
    known: Set<string>;
  }>();
  const workspace = project ?? projects[0];
  const choice = model ?? defaultChoice(choices, "claude");
  const thread = useMemo(
    () => ({ id: "new", workspaceId: workspace ?? "", title: "" }),
    [workspace],
  );
  const findCreated = useCallback(
    (reader: SidebarReader) =>
      waiting
        ? reader.ids.find(
            (id) =>
              !waiting.known.has(id) &&
              reader.thread(id)?.title === waiting.title &&
              reader.thread(id)?.workspaceId === waiting.workspace,
          )
        : undefined,
    [waiting],
  );
  const created = useSidebar(["ids"], findCreated);
  useEffect(() => {
    if (created) void navigate({ to: "/t/$threadId", params: { threadId: created } });
  }, [created, navigate]);

  const submit = async (draft: Draft) => {
    if (!workspace || !choice) return false;
    const title = titleFrom(draft.text);
    try {
      setWaiting({ title, workspace, known: new Set(ids) });
      await client.enqueue({
        type: "thread.create",
        workspaceId: WorkspaceId.parse(workspace),
        provider: choice.provider,
        model: choice.model,
        title,
        input: [{ type: "text", text: draft.text || "See the attached files." }],
        context: { mentions: draft.mentions, attachments: draft.attachments },
      });
      return true;
    } catch {
      setWaiting(undefined);
      toast.add({ title: "Couldn't start the thread", description: "It is back in the composer." });
      return false;
    }
  };

  return (
    <Screen title="New thread" subtitle={workspace}>
      <div className="flex h-full flex-col items-center justify-center px-8 pb-[12vh]">
        <div className="w-full max-w-(--column)">
          <h2 className="mb-1 text-center text-2xl font-semibold tracking-title">
            What should the agents work on?
          </h2>
          <p className="mb-6 text-center text-base text-muted-foreground">
            The thread is created when you send.
          </p>
          <Composer
            thread={thread}
            busy={false}
            onSubmit={submit}
            autoFocus
            placeholder="Describe the work, @ to mention a file"
            controls={<ModelPicker choices={choices} value={choice} onChange={setModel} />}
          />
          <div className="flex h-8 items-center px-2.5 pt-2 text-[12px] text-subtle-foreground">
            <Menu>
              <MenuTrigger
                aria-label={`Project: ${workspace ?? "none"}`}
                className="inline-flex h-6 items-center gap-[5px] rounded-sm px-[7px] outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground aria-expanded:bg-accent"
              >
                <FolderSimpleIcon aria-hidden size={14} />
                {workspace ?? "No projects yet"}
                <CaretDownIcon aria-hidden size={12} />
              </MenuTrigger>
              <MenuContent side="top">
                <MenuRadioGroup
                  value={workspace ?? ""}
                  onValueChange={(value: string) => setProject(value)}
                >
                  {projects.map((name) => (
                    <MenuRadioItem key={name} value={name}>
                      {name}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
          </div>
        </div>
      </div>
    </Screen>
  );
}
