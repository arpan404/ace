import { ClockIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Page, PageTitle, Screen } from "@/features/shell/index.ts";
import { useProjectChoices } from "@/lib/projects.ts";
import { AutomationEditor } from "./automation-form.tsx";
import { automationFromForm, blankForm, formFromAutomation } from "./automation-values.ts";
import { localTimeZone } from "./schedule.ts";
import { useAutomation, useAutomationActions } from "./use-automations.ts";

/** /automations/new: a blank form; saving opens the new automation. */
export function NewAutomationScreen() {
  const { ids: workspaces, name: workspaceName } = useProjectChoices();
  const { save } = useAutomationActions();
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <Screen title="New automation" subtitle="Automation">
      <Page>
        <PageTitle
          title="New automation"
          lede="A prompt that runs by itself, on a schedule or when something happens in a repository. Results land in Activity."
        />
        <AutomationEditor
          initial={blankForm(workspaces[0] ?? "", localTimeZone())}
          workspaces={workspaces}
          workspaceName={workspaceName}
          submitLabel="Create automation"
          cancel={
            <Link to="/automations" className={buttonVariants({ variant: "ghost" })}>
              Cancel
            </Link>
          }
          onSave={async (form, committed) => {
            const automation = automationFromForm(form, {
              id: `auto-${crypto.randomUUID()}`,
              now: Date.now(),
            });
            await save(automation);
            committed();
            toast.add({ title: `Created · ${automation.title}` });
            await navigate({
              to: "/automations/$automationId",
              params: { automationId: automation.id },
            });
          }}
        />
      </Page>
    </Screen>
  );
}

/** /automations/$id/edit: the same form over an existing definition. */
export function EditAutomationScreen(props: { id: string }) {
  const { entry, pending, error, retry } = useAutomation(props.id);
  const { ids: workspaces, name: workspaceName } = useProjectChoices();
  const { save } = useAutomationActions();
  const navigate = useNavigate();
  const toast = useToast();
  const previous = entry?.automation;
  if (!previous)
    return (
      <Screen title="Edit automation">
        {pending ? (
          <Page>
            <LoadingRegion label="automation" className="flex flex-col gap-4">
              <Skeleton className="h-6 w-56" />
              <Skeleton className="mt-4 h-9" />
              <Skeleton className="h-28" />
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </LoadingRegion>
          </Page>
        ) : (
          <EmptyState
            icon={ClockIcon}
            title={error ? "Couldn't load this automation" : "Automation not found"}
            description={
              error
                ? "ace didn't answer. It will be read again once the connection is back."
                : "It may have been deleted on another device."
            }
            action={
              error ? (
                <Button size="sm" onClick={retry}>
                  Try again
                </Button>
              ) : undefined
            }
          />
        )}
      </Screen>
    );
  const back = { to: "/automations/$automationId", params: { automationId: previous.id } } as const;
  return (
    <Screen title={previous.title} subtitle="Edit automation">
      <Page>
        <PageTitle title="Edit automation" />
        <AutomationEditor
          initial={formFromAutomation(previous, localTimeZone())}
          workspaces={workspaces}
          workspaceName={workspaceName}
          submitLabel="Save changes"
          requireChanges
          cancel={
            <Link {...back} className={buttonVariants({ variant: "ghost" })}>
              Cancel
            </Link>
          }
          onSave={async (form, committed) => {
            const automation = automationFromForm(form, {
              id: previous.id,
              now: Date.now(),
              previous,
            });
            await save(automation);
            committed();
            toast.add({ title: `Saved · ${automation.title}` });
            await navigate(back);
          }}
        />
      </Page>
    </Screen>
  );
}
