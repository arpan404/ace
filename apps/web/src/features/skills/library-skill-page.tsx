import type { SkillEntry } from "@ace/protocol";
import { ArrowSquareOutIcon, FolderSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Icon } from "@/components/icon.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { SettingNote, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/index.ts";
import { instructionsShown, skillBody } from "./library-model.ts";
import { SkillRequestError, useDeleteSkill, useEditSkill, useSkillFile } from "./library-source.ts";
import { SkillDetails } from "./skill-details.tsx";
import { SkillEditForm, type SkillDraft } from "./skill-edit-form.tsx";
import { useSkillFileActions } from "./skill-file-actions.ts";
import { SkillHeading, UseInThread } from "./skill-parts.tsx";
import { useSkillLibrary } from "./skills-library.tsx";
import { skillTitle } from "./skills-model.ts";

/**
 * A skill from the agents' own folders: who loads it, where it lives, when it runs, how often
 * it was used, and its instructions, which the person can edit when the skill is theirs.
 */
export function LibrarySkillPage(props: { entry: SkillEntry }) {
  const { entry } = props;
  const library = useSkillLibrary();
  const workspaceId = entry.scope === "project" ? library.project?.id : undefined;
  const file = useSkillFile(entry.id, workspaceId, entry.hash);
  const edit = useEditSkill();
  const remove = useDeleteSkill();
  const actions = useSkillFileActions(entry);
  const toast = useToast();
  const navigate = useNavigate();
  // What an edit started from: its hash (a save after a change elsewhere is a conflict) and
  // its text, which a refreshed read must not swap out under the person's typing.
  const [editing, setEditing] = useState<{ hash: string; initial: SkillDraft }>();
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [confirming, setConfirming] = useState<Confirming>();
  const title = skillTitle(entry);
  const text = file.data?.text;
  const save = (draft: SkillDraft) => {
    setConflict(false);
    setSaveError(undefined);
    edit.mutate(
      {
        id: entry.id,
        workspaceId,
        // The hash of the text the draft started from: a change since then is a conflict.
        expectedHash: editing?.hash ?? entry.hash,
        ...draft,
      },
      {
        onSuccess: () => setEditing(undefined),
        onError: (error) => {
          if (error instanceof SkillRequestError && error.code === "conflict") setConflict(true);
          else
            setSaveError(
              `Couldn't save ${title}. ${error instanceof SkillRequestError ? error.message : "Check your connection and try again."}`,
            );
        },
      },
    );
  };
  const setRuns = (manual: boolean) => {
    if (text === undefined) return;
    edit.mutate(
      {
        id: entry.id,
        workspaceId,
        expectedHash: file.data?.entry.hash ?? entry.hash,
        description: entry.description,
        body: skillBody(text),
        manual,
      },
      {
        onError: (error) =>
          toast.error({
            title: `Couldn't change when ${title} runs`,
            description:
              error instanceof SkillRequestError
                ? error.message
                : "Check your connection and try again.",
          }),
      },
    );
  };
  const startEditing = (data: { entry: SkillEntry; text: string }) =>
    setEditing({
      hash: data.entry.hash,
      initial: {
        description: data.entry.description,
        body: skillBody(data.text),
        manual: data.entry.manual,
      },
    });
  const askDelete = () =>
    setConfirming({
      title: `Delete ${title}?`,
      body: `This deletes ${entry.path} and its files. Agents stop seeing it.`,
      confirm: "Delete skill",
      run: () =>
        remove.mutate(
          { id: entry.id, workspaceId, expectedHash: entry.hash },
          {
            onSuccess: () => {
              toast.add({ title: `Deleted ${title}` });
              void navigate({ to: "/skills", replace: true });
            },
            onError: (error) =>
              toast.error({
                title: `Couldn't delete ${title}`,
                description:
                  error instanceof SkillRequestError
                    ? error.message
                    : "Check your connection and try again.",
              }),
          },
        ),
    });
  const menu =
    actions.open || actions.reveal || entry.editable ? (
      <>
        {actions.open && (
          <MenuItem icon={<Icon icon={ArrowSquareOutIcon} />} onClick={() => void actions.open?.()}>
            Open in editor
          </MenuItem>
        )}
        {actions.reveal && (
          <MenuItem icon={<Icon icon={FolderSimpleIcon} />} onClick={() => void actions.reveal?.()}>
            Reveal in Finder
          </MenuItem>
        )}
        {entry.editable && (
          <>
            {(actions.open || actions.reveal) && <MenuSeparator />}
            <MenuItem danger icon={<Icon icon={TrashIcon} />} onClick={askDelete}>
              Delete skill…
            </MenuItem>
          </>
        )}
      </>
    ) : undefined;
  return (
    <Screen title="Skills" menu={menu}>
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-(--column) px-4 pt-6 pb-20 sm:px-8 sm:pt-11">
          <SkillHeading title={title} description={editing ? "" : entry.description}>
            {!editing && <UseInThread name={entry.name} project={workspaceId} />}
          </SkillHeading>
          {editing ? (
            <SkillEditForm
              key={editing.hash}
              initial={editing.initial}
              saving={edit.isPending}
              conflict={conflict}
              error={saveError}
              onCancel={() => {
                setEditing(undefined);
                setConflict(false);
                setSaveError(undefined);
              }}
              onReload={() => {
                setConflict(false);
                void file.refetch().then((read) => read.data && startEditing(read.data));
              }}
              onSave={save}
            />
          ) : (
            <div className="mt-8">
              <SkillDetails
                entry={entry}
                workspaceId={workspaceId}
                project={library.project?.name}
                open={actions.open && (() => void actions.open?.())}
                runsPending={edit.isPending}
                onRunsChange={text === undefined ? undefined : setRuns}
              />
              <SettingSection
                label="Instructions"
                actions={
                  entry.editable && text !== undefined ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => file.data && startEditing(file.data)}
                    >
                      Edit
                    </Button>
                  ) : undefined
                }
              >
                {file.isError ? (
                  <SettingNote>
                    Couldn't read the instructions.{" "}
                    <Button variant="secondary" size="sm" onClick={() => void file.refetch()}>
                      Try again
                    </Button>
                  </SettingNote>
                ) : text === undefined ? (
                  <SkeletonText lines={6} className="py-3" />
                ) : (
                  <Prose className="py-3" text={instructionsShown(text, title)} />
                )}
              </SettingSection>
            </div>
          )}
        </div>
      </div>
    </Screen>
  );
}
