import { Screen } from "@/features/shell/index.ts";
import { ProjectsEmptyState } from "@/features/projects/index.ts";
import { readDraft } from "@/features/thread/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { preparation, preparationKey } from "./preparations.ts";

/** Keep a removed project's saved work visible without granting another project its identity. */
export function UnavailablePreparation(props: {
  host: string;
  project: string;
  skill?: string | undefined;
  pullRequest?: string | undefined;
  issue?: string | undefined;
}) {
  const { storage } = useLayout();
  const key = preparationKey(
    props.host,
    props.project,
    props.skill,
    props.issue ?? props.pullRequest,
  );
  const content = readDraft(storage, key) ?? preparation(storage, props.host, key)?.discardRecovery;
  return (
    <Screen title="Project unavailable">
      <div className="px-5 py-6">
        <p role="alert" className="text-ui text-status-failed">
          This preparation's project is no longer registered. Add the project again to resume it.
          Your saved work is kept on this device.
        </p>
        <pre aria-label="Saved message" className="mt-4 whitespace-pre-wrap text-ui">
          {content?.text ?? ""}
        </pre>
        {!!content?.attachments.length && (
          <ul aria-label="Saved attachments" className="mt-3 text-ui">
            {content.attachments.map((file) => (
              <li key={`${file.sha256}:${file.name}`}>{file.name}</li>
            ))}
          </ul>
        )}
        <ProjectsEmptyState />
      </div>
    </Screen>
  );
}
