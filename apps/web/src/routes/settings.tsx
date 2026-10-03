import { createFileRoute } from "@tanstack/react-router";
import { AppearanceForm } from "@/features/settings/appearance-form.tsx";
import { DaemonHealth } from "@/features/settings/daemon-health.tsx";

export const Route = createFileRoute("/settings")({ component: Settings });

function Settings() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-8 overflow-y-auto p-6">
      <h1 className="text-lg font-medium">Settings</h1>
      <section aria-labelledby="appearance" className="flex flex-col gap-4">
        <h2 id="appearance" className="text-sm font-medium">
          Appearance
        </h2>
        <AppearanceForm />
      </section>
      <section aria-labelledby="health" className="flex flex-col gap-4">
        <h2 id="health" className="text-sm font-medium">
          Daemon
        </h2>
        <DaemonHealth />
      </section>
    </div>
  );
}
