import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { toolchainNames, useToolchains } from "@/features/diagnostics/index.ts";

/** The machine's tools agents rely on, each Ready or how to get it. */
export function ToolchainSection() {
  const tools = useToolchains();
  return (
    <SettingSection label="Tools on this machine">
      {tools.isError ? (
        <SettingNote role="alert">
          Couldn't check the tools.{" "}
          <Button variant="ghost" size="sm" onClick={() => void tools.refetch()}>
            Try again
          </Button>
        </SettingNote>
      ) : !tools.data ? (
        <SettingRow title="Git">
          <Skeleton className="h-5 w-20 rounded-md" />
        </SettingRow>
      ) : (
        tools.data.map((tool) => (
          <SettingRow
            key={tool.id}
            title={toolchainNames[tool.id]}
            description={tool.available ? undefined : tool.hint}
            inline
          >
            <StatusLabel
              tone={tool.available ? "done" : "idle"}
              label={tool.available ? "Ready" : "Not installed"}
            />
          </SettingRow>
        ))
      )}
    </SettingSection>
  );
}
