import {
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
  FolderSimpleStarIcon,
  GitBranchIcon,
} from "@phosphor-icons/react";
import {
  choosePath,
  displayPath,
  parentFolder,
  pathInput,
  rowPath,
  startText,
  stepHighlight,
  type PathIntent,
} from "@ace/ui-core";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  CommandOption,
  CommandStepFooter,
  CommandStepRow,
  commandStepField,
  stepFieldKey,
} from "@/components/ui/command-step.tsx";
import { backHint, escapeHint, navigateHint } from "@/components/ui/key-hints.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { LongRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { applePlatform } from "@/lib/keymap.ts";
import type { Machine } from "@/lib/machines.ts";
import type { PaletteStart } from "@/lib/layout.tsx";
import { AllowFolder } from "./allow-folder.tsx";
import { AllowedPlaces, Badge, Notice, RefusedNotice, offlineIcon } from "./folder-notices.tsx";
import { Problem } from "./form-parts.tsx";
import { useNativePicker } from "./native-picker.ts";
import { useAddFolder } from "./use-add-folder.ts";
import { useHostHome, useRecentFolders } from "./use-folders.ts";
import { useLocalFolder, type LocalRow } from "./use-local-folder.ts";

/** Rows of a folder this long and longer mount only near the viewport. */
const virtualAbove = 120;

/**
 * Add project › Local folder: a path field over the machine's folders, starting beside the most
 * recent project (or at `~/`). Typing lists the folders inside the typed folder that match what
 * follows the last slash. ↑ ↓ move; Enter, → or a click goes into the highlighted folder; ⌘Enter
 * adds it; Enter with nothing highlighted adds the typed folder. A folder that doesn't exist is
 * made only from its own "Create … and add" row. A row the pointer highlights stops being
 * highlighted once the pointer leaves the list, so the Add button, reached past the rows, adds
 * the folder the field names rather than whichever row the pointer last crossed.
 */
export function LocalFolderStep(props: {
  machine: Machine;
  attempt: PaletteStart["attempt"];
  onBack: (() => void) | undefined;
  close(): void;
  trailing?: ReactNode;
}) {
  const { machine } = props;
  const [typed, setTyped] = useState<string>();
  const [active, setActive] = useState<number>();
  // Whether the highlight came from the pointer rather than the keys.
  const [pointed, setPointed] = useState(false);
  const listId = useId();
  const virtual = useRef<VirtualRowsHandle>(null);
  // A refused attempt shows why, and the field starts in the folder it was in.
  const [attempt] = useState(props.attempt);
  const added = useAddFolder(
    machine,
    props.close,
    attempt && {
      path: attempt.path,
      message: attempt.problem,
      denied: true,
      canAllow: attempt.canAllow ?? false,
    },
  );
  const native = useNativePicker(machine.primary);
  const hostHome = useHostHome(machine).data;
  const homeFolder = hostHome?.path;
  const only = useMemo(() => [machine], [machine]);
  const recent = useRecentFolders(only).folders;
  const peek = attempt ? parentFolder(attempt.path) : undefined;
  const start = peek
    ? pathInput(peek, homeFolder)
    : startText(
        recent.map((each) => each.path),
        homeFolder,
        hostHome?.start,
      );
  const text = typed ?? start;
  const folder = useLocalFolder(machine, text);
  const { rows, home } = folder;
  const current = active !== undefined && active < rows.length ? active : undefined;
  const highlighted = current === undefined ? undefined : rows[current];
  const offline = machine.client === undefined;

  useEffect(() => {
    if (current === undefined) return;
    const element = document.getElementById(`${listId}-${current}`);
    if (element) element.scrollIntoView?.({ block: "nearest" });
    else virtual.current?.scrollToIndex(current);
  }, [current, listId]);

  const type = (next: string) => {
    setTyped(next);
    setActive(undefined);
  };
  const point = (at: number) => {
    setActive(at);
    setPointed(true);
  };
  const leaveList = () => {
    if (pointed) setActive(undefined);
    setPointed(false);
  };
  const act = (intent: PathIntent) => {
    if (intent.kind === "browse") type(pathInput(intent.path, home?.path));
    else if (intent.kind === "add") added.add(intent.path);
    else if (intent.kind === "create") added.create(intent.path);
  };
  const choose = (row: LocalRow | undefined, how: "open" | "add") =>
    act(choosePath(row, how, folder.typed));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (stepFieldKey(event, { text, onBack: props.onBack, onClear: () => type("") })) return;
    const mod = applePlatform ? event.metaKey : event.ctrlKey;
    const atEnd = event.currentTarget.selectionStart === text.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      setActive(stepHighlight(current, event.key === "ArrowDown" ? 1 : -1, rows.length));
      setPointed(false);
    } else if (event.key === "Enter") {
      if (!added.adding) choose(highlighted, mod ? "add" : "open");
    } else if (event.key === "ArrowRight" && atEnd && highlighted && highlighted.kind !== "create")
      choose(highlighted, "open");
    else if (event.key === "Tab" && !event.shiftKey) {
      const inside = rows.filter((row) => row.kind === "folder");
      const into =
        highlighted?.kind === "folder" ? highlighted : inside.length === 1 ? inside[0] : undefined;
      if (!into) return;
      choose(into, "open");
    } else return;
    event.preventDefault();
  };

  // What the primary action adds: the highlighted row, else the typed folder.
  const target = highlighted ? rowPath(highlighted) : folder.typed;
  const creating = highlighted?.kind === "create";
  const problem = added.problem;
  let state: ReactNode = null;
  if (offline)
    state = (
      <Notice icon={offlineIcon}>
        {machine.name} isn't connected. Folders come back once it is.
      </Notice>
    );
  else if (folder.failure)
    state = (
      <RefusedNotice
        problem={folder.failure}
        roots={home?.roots ?? []}
        home={home?.path}
        onGo={(path) => type(pathInput(path, home?.path))}
        onRetry={folder.retry}
        allow={
          folder.failure.canAllow && folder.directory ? (
            <AllowFolder
              client={machine.client}
              path={folder.directory}
              roots={home?.roots ?? []}
              onAllowed={folder.retry}
            />
          ) : undefined
        }
      />
    );
  else if (!rows.length && folder.loading)
    state = <ListSkeleton label="folders" shape="row" rows={6} />;

  return (
    <>
      <CommandStepRow onBack={props.onBack}>
        <input
          role="combobox"
          aria-label="Folder path"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={highlighted ? `${listId}-${current}` : undefined}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- A palette step opens to its field.
          autoFocus
          value={text}
          placeholder="~/ or a path"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          onChange={(event) => type(event.target.value)}
          onKeyDown={onKeyDown}
          className={`${commandStepField} font-mono text-sm`}
        />
        {props.trailing}
      </CommandStepRow>
      <div className="h-[min(320px,46dvh)] overflow-y-auto overscroll-contain p-1">
        {state}
        <div
          id={listId}
          role="listbox"
          aria-label="Folders"
          hidden={state !== null}
          onPointerLeave={leaveList}
        >
          <LongRows
            items={rows}
            rowKey={(row) => `${row.kind}\u0000${rowPath(row)}`}
            estimate={36}
            virtualAbove={virtualAbove}
            handle={virtual}
            render={(row, at) => (
              <FolderRow
                id={`${listId}-${at}`}
                row={row}
                home={home?.path}
                active={at === current}
                onPoint={() => point(at)}
                onPick={() => choose(row, "open")}
              />
            )}
          />
          {!rows.length && !folder.loading && (
            <div role="status" className="py-8 text-center text-ui text-muted-foreground">
              No folders here
            </div>
          )}
        </div>
      </div>
      {problem && (
        <div className="px-3 pb-2">
          <Problem
            action={
              problem.canAllow ? (
                <Button
                  size="sm"
                  disabled={added.adding}
                  onClick={() => added.allowAndAdd(problem.path, home?.roots ?? [])}
                >
                  Allow and add
                </Button>
              ) : undefined
            }
          >
            <span className="font-mono text-xs break-all">
              {displayPath(problem.path, home?.path)}
            </span>{" "}
            {problem.message}
            {problem.denied && !problem.canAllow && (
              <AllowedPlaces
                className="mt-1 justify-start"
                roots={home?.roots ?? []}
                home={home?.path}
                onGo={(path) => type(pathInput(path, home?.path))}
              />
            )}
          </Problem>
        </div>
      )}
      <CommandStepFooter
        note={target ? displayPath(target, home?.path) : undefined}
        hints={[
          ...(rows.length ? [navigateHint] : []),
          ...(creating
            ? [{ keys: ["enter"], label: "Create and add" }]
            : highlighted
              ? [
                  { keys: ["enter", "arrowright"], label: "Open" },
                  { keys: ["mod+enter"], label: "Add" },
                ]
              : target
                ? [{ keys: ["enter"], label: "Add" }]
                : []),
          ...(props.onBack ? [backHint] : []),
          escapeHint(text),
        ]}
      >
        {native && (
          <Button
            variant="ghost"
            disabled={offline || added.adding}
            onClick={() =>
              void native.choose().then((chosen) => {
                if (chosen) added.add(chosen);
              })
            }
          >
            Browse…
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!target || added.adding || offline}
          onClick={() => choose(highlighted, "add")}
        >
          {added.adding
            ? creating
              ? "Creating…"
              : "Adding…"
            : creating
              ? "Create and add"
              : "Add"}
        </Button>
      </CommandStepFooter>
    </>
  );
}

function FolderRow(props: {
  id: string;
  row: LocalRow;
  home: string | undefined;
  active: boolean;
  onPoint(): void;
  onPick(): void;
}) {
  const { row } = props;
  if (row.kind === "create")
    return (
      <CommandOption
        id={props.id}
        active={props.active}
        label={`Create ${displayPath(row.path, props.home)} and add`}
        onPoint={props.onPoint}
        onPick={props.onPick}
      >
        <Icon icon={FolderPlusIcon} />
        <span className="min-w-0 flex-1 truncate">
          Create <span className="font-mono text-sm">{displayPath(row.path, props.home)}</span> and
          add
        </span>
      </CommandOption>
    );
  if (row.kind === "up")
    return (
      <CommandOption
        id={props.id}
        active={props.active}
        label=".."
        onPoint={props.onPoint}
        onPick={props.onPick}
      >
        <Icon icon={FolderOpenIcon} />
        <span className="min-w-0 flex-1 truncate font-mono text-sm">..</span>
      </CommandOption>
    );
  const { entry } = row;
  return (
    <CommandOption
      id={props.id}
      active={props.active}
      label={entry.name}
      onPoint={props.onPoint}
      onPick={props.onPick}
    >
      <Icon icon={entry.project ? FolderSimpleStarIcon : FolderSimpleIcon} />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.project && <Badge>Project</Badge>}
      {entry.git && <Badge icon={GitBranchIcon}>Git</Badge>}
    </CommandOption>
  );
}
