import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

const names = { git: "Git", xcode: "iOS Simulator", android: "Android emulators" };

/** Uses the connected computer's tools, including when this app runs in a browser. */
export function ToolchainHints({ devices = false }: { devices?: boolean }) {
  const tools = useDaemonQuery({
    queryKey: ["diagnostics", "toolchains"],
    read: async (client, signal) => {
      const reply = await client.request(
        { type: "diagnostics.request", operation: "toolchains" },
        { signal },
      );
      if (!reply.toolchains || reply.error)
        throw new Error("Tools couldn't be checked. Try again.");
      return reply.toolchains;
    },
  });
  return (
    <section aria-label="Computer tools" className="text-left">
      <h3 className="text-sm font-medium text-muted-foreground">
        {devices ? "Device tools" : "Computer tools"}
      </h3>
      {tools.isError ? (
        <p className="text-sm text-muted-foreground">
          Tools couldn't be checked.{" "}
          <Button variant="ghost" size="sm" onClick={() => void tools.refetch()}>
            Try again
          </Button>
        </p>
      ) : (
        <ul className="divide-y">
          {tools.data
            ?.filter((tool) => !devices || tool.id !== "git")
            .map((tool) => (
              <li key={tool.id}>
                <div className="flex h-8 items-center justify-between gap-2 text-sm">
                  <span>{names[tool.id]}</span>
                  <StatusLabel
                    tone={tool.available ? "done" : "idle"}
                    label={tool.available ? "Ready" : "Not installed"}
                  />
                </div>
                {!tool.available && (
                  <p className="pb-2 text-sm text-muted-foreground break-words">{tool.hint}</p>
                )}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
