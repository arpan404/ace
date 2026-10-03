import { ClockIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useWorkspaces } from "@/features/activity/use-workspaces.ts";
import { Page, PageTitle, Screen } from "@/features/shell/screen.tsx";
import { AutomationEditor } from "./automation-form.tsx";
import { automationFromForm, blankForm, formFromAutomation } from "./automation-values.ts";
import { localTimeZone } from "./schedule.ts";
import { useAutomation, useAutomationActions } from "./use-automations.ts";

/** /automations/new: a blank form; saving opens the new automation. */
export function NewAutomationScreen() {
  const workspaces = useWorkspaces();
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
          initial={blankForm(workspaces[0] ?? "")}
          workspaces={workspaces}
          submitLabel="Create automation"
          cancel={
            <Link to="/automations" className={buttonVariants({ variant: "ghost" })}>
              Cancel
            </Link>
          }
          onSave={async (form) => {
            const automation = automationFromForm(form, {
              id: `auto-${crypto.randomUUID()}`,
              now: Date.now(),
              timezone: localTimeZone(),
            });
            await save(automation);
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
  const { entry, pending } = useAutomation(props.id);
  const workspaces = useWorkspaces();
  const { save } = useAutomationActions();
  const navigate = useNavigate();
  if (!entry)
    return (
      <Screen title="Edit automation">
        <EmptyState
          icon={ClockIcon}
          title={pending ? "Loading automation" : "Automation not found"}
        />
      </Screen>
    );
  const previous = entry.automation;
  const back = { to: "/automations/$automationId", params: { automationId: previous.id } } as const;
  return (
    <Screen title={previous.title} subtitle="Edit automation">
      <Page>
        <PageTitle title="Edit automation" />
        <AutomationEditor
          initial={formFromAutomation(previous)}
          workspaces={workspaces}
          submitLabel="Save changes"
          cancel={
            <Link {...back} className={buttonVariants({ variant: "ghost" })}>
              Cancel
            </Link>
          }
          onSave={async (form) => {
            await save(
              automationFromForm(form, {
                id: previous.id,
                now: Date.now(),
                timezone: localTimeZone(),
                previous,
              }),
            );
            await navigate(back);
          }}
        />
      </Page>
    </Screen>
  );
}
