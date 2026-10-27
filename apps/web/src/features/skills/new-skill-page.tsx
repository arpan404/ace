import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Screen } from "@/features/shell/index.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import {
  initialSkillAgents,
  isSkillAgent,
  nameTaken,
  newSkillPath,
  skillAgents,
} from "./library-model.ts";
import { SkillRequestError, useCreateSkill } from "./library-source.ts";
import { NewSkillForm } from "./new-skill-form.tsx";
import { SkillPageSkeleton } from "./skills-landing-screen.tsx";
import { useSkillLibrary } from "./skills-library.tsx";

/** Write a new skill; once the library lists it, its page opens. */
export function NewSkillPage() {
  const statuses = useProviderStatuses();
  const library = useSkillLibrary();
  const navigate = useNavigate();
  const create = useCreateSkill();
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<string>();
  const listed = !!created && !!library.entries?.some((entry) => entry.id === created);
  useEffect(() => {
    if (listed && created)
      void navigate({ to: "/skills/$skillId", params: { skillId: created }, replace: true });
  }, [listed, created, navigate]);
  // Agents start ticked when they are installed on the daemon's machine.
  const installed = statuses.data
    ? initialSkillAgents(
        statuses.data
          .filter((status) => status.state !== "not_installed")
          .map((status) => status.provider),
      )
    : statuses.isError
      ? skillAgents
      : undefined;
  return (
    <Screen title="Skills">
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-(--column) px-4 pt-6 pb-20 sm:px-8 sm:pt-11">
          <h2 className="text-2xl font-semibold tracking-title">New skill</h2>
          {!installed ? (
            <SkillPageSkeleton />
          ) : (
            <NewSkillForm
              project={library.project?.name}
              agents={skillAgents}
              initialAgents={installed}
              // Only the folder the daemon writes to counts; plugin and built-in names don't clash.
              taken={(name, scope) => nameTaken(library.entries, name, scope)}
              pathFor={newSkillPath}
              creating={create.isPending || !!created}
              error={error}
              onCancel={() => void navigate({ to: "/skills" })}
              onCreate={(skill) => {
                setError(undefined);
                const project = library.project;
                create.mutate(
                  {
                    name: skill.name,
                    description: skill.description,
                    body: skill.instructions,
                    scope:
                      skill.scope === "project" && project
                        ? { kind: "project", workspaceId: project.id }
                        : { kind: "personal" },
                    agents: skill.providers.filter(isSkillAgent),
                    manual: skill.manual,
                  },
                  {
                    onSuccess: (entry) => setCreated(entry.id),
                    onError: (failure) =>
                      setError(
                        failure instanceof SkillRequestError
                          ? `Couldn't create the skill. ${failure.message}`
                          : "Couldn't create the skill. Check your connection and try again.",
                      ),
                  },
                );
              }}
            />
          )}
        </div>
      </div>
    </Screen>
  );
}
