import { AppWindowIcon } from "@phosphor-icons/react";
import { folderName, parentFolder } from "@ace/ui-core";
import { useEffect, useRef, useState } from "react";
import { desktopFolders } from "@/boot/desktop-folders.ts";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import type { Machine } from "@/lib/machines.ts";
import { AllowFolder } from "./allow-folder.tsx";
import { AllowedPlaces } from "./folder-notices.tsx";
import { FolderSearchBox } from "./folder-search.tsx";
import { Footer, Offer, Problem } from "./form-parts.tsx";
import type { LandMode } from "./land.ts";
import { projectFailure, useProjectCommandsOn, type Added } from "./project-commands.ts";
import type { FolderAttempt } from "./requests.ts";
import { useFolderInspection } from "./use-folders.ts";
import { useFolderSearch, type FolderRow } from "./use-folder-search.ts";

/**
 * Open folder: one search box over the chosen machine's folders and every machine's recent
 * projects (or, in the desktop app with a daemon on this computer, the system's folder picker
 * too). Enter opens the highlighted folder, ⌘Enter opens it in a new thread. A folder inside a
 * repository offers the repository's root; it's added only if chosen.
 */
export function OpenFolderTab(props: {
  machine: Machine;
  machines: readonly Machine[];
  attempt: FolderAttempt | undefined;
  onAdded(result: Added, mode: LandMode, machine: Machine): void;
}) {
  const { machine } = props;
  const [text, setText] = useState(() => {
    const parent = props.attempt ? parentFolder(props.attempt.path) : undefined;
    return parent ? `${parent.replace(/\/+$/, "")}/` : "";
  });
  const [highlighted, setHighlighted] = useState<FolderRow>();
  const [problem, setProblem] = useState<
    { key: string; message: string; denied: boolean; canAllow?: boolean | undefined } | undefined
  >(
    () =>
      props.attempt && {
        key: `${machine.id}\u0000${props.attempt.path}`,
        message: props.attempt.problem,
        denied: true,
        canAllow: props.attempt.canAllow,
      },
  );
  const [adding, setAdding] = useState(false);
  const pending = useRef(false);
  // What was typed carries over to another machine; a problem stays with its own.
  const [shownFor, setShownFor] = useState(machine.id);
  if (shownFor !== machine.id) {
    setShownFor(machine.id);
    setProblem(undefined);
  }
  const search = useFolderSearch({ machine, machines: props.machines, text, mode: "open" });
  const native = useNativePicker();
  const target = highlighted;
  const on = target?.machine ?? machine;
  const commandsOn = useProjectCommandsOn();
  const inspection = useFolderInspection(on, target?.path).data;
  const root = inspection?.suggestedRepoRoot;
  const offline = machine.client === undefined;

  const add = async (path: string, mode: LandMode, where: Machine) => {
    if (pending.current) return;
    pending.current = true;
    setAdding(true);
    setProblem(undefined);
    try {
      props.onAdded(await commandsOn(where).add(path), mode, where);
    } catch (error) {
      const failure = projectFailure(error);
      pending.current = false;
      setProblem({
        key: `${where.id}\u0000${path}`,
        message: failure.message,
        denied: failure.denied ?? false,
        canAllow: failure.canAllow,
      });
    } finally {
      setAdding(false);
    }
  };
  const open = (row: FolderRow | undefined, newThread: boolean) => {
    if (!row || adding) return;
    void add(row.path, newThread ? "thread" : "open", row.machine);
  };

  const shownProblem = problem && target && problem.key === target.key ? problem : undefined;
  return (
    <div className="grid gap-3">
      <FolderSearchBox
        label="Search folders"
        listLabel="Folders"
        placeholder="Search folders, or type a path: / ~ ./"
        search={search}
        text={text}
        onText={setText}
        mode="open"
        several={props.machines.length > 1}
        onChoose={(row, how) => open(row, how.newThread)}
        onHighlight={setHighlighted}
        autoFocus
        trailing={
          native &&
          machine.primary && (
            <IconButton
              icon={AppWindowIcon}
              label="Choose a folder…"
              size="sm"
              disabled={offline || adding}
              onClick={() =>
                void native.choose().then((chosen) => {
                  if (chosen) void add(chosen, "open", machine);
                })
              }
            />
          )
        }
      />
      {shownProblem ? (
        <Problem>
          {shownProblem.message}
          {shownProblem.canAllow && target && (
            <AllowFolder
              client={on.client}
              path={target.path}
              onAllowed={() => void add(target.path, "open", on)}
            />
          )}
          {shownProblem.denied && (
            <AllowedPlaces
              className="mt-1 justify-start"
              roots={search.home?.roots ?? []}
              home={search.home?.path}
              onGo={(path) => setText(`${path.replace(/\/+$/, "")}/`)}
            />
          )}
        </Problem>
      ) : root && target && !target.self ? (
        <Offer
          action={
            <Button
              size="sm"
              disabled={adding || offline}
              onClick={() => void add(root, "open", on)}
            >
              Add {folderName(root)}
            </Button>
          }
        >
          {target.name} is inside the {folderName(root)} repository. Add the repository to work on
          all of it, or add just this folder.
        </Offer>
      ) : null}
      <Footer>
        <Button
          variant="ghost"
          disabled={!target || adding || on.client === undefined}
          onClick={() => open(target, true)}
        >
          New thread
        </Button>
        <Button
          variant="primary"
          disabled={!target || adding || on.client === undefined}
          onClick={() => open(target, false)}
        >
          {adding ? "Opening…" : target ? `Open ${target.name}` : "Select a folder"}
        </Button>
      </Footer>
    </div>
  );
}

/** The desktop app's folder picker, when the daemon runs on this computer. */
function useNativePicker() {
  const [picker] = useState(() => desktopFolders());
  const [local, setLocal] = useState(false);
  useEffect(() => {
    if (!picker) return;
    let current = true;
    void picker.local().then((value) => {
      if (current) setLocal(value);
    });
    return () => {
      current = false;
    };
  }, [picker]);
  return picker && local ? picker : undefined;
}
