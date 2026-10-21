import { useState } from "react";
import type { DiagnosticReport } from "@ace/protocol";
import { Page, PageTitle } from "@/features/shell/index.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.tsx";
import { TriageForm } from "./triage-form.tsx";
export function TriagePage() {
  return (
    <Page>
      <div className="mx-auto max-w-(--settings-column) space-y-6">
        <PageTitle
          title="ace triage"
          lede="Describe an issue, review a prompt, and open it in your coding CLI."
        />
        <TriageForm />
      </div>
    </Page>
  );
}
export function DoctorTriage(props: { report: DiagnosticReport }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Investigate with a CLI
      </Button>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>ace triage</DialogTitle>
          <DialogDescription>
            Review the diagnostic prompt before opening your CLI.
          </DialogDescription>
        </DialogHeader>
        <TriageForm report={props.report} />
      </DialogContent>
    </Dialog>
  );
}
