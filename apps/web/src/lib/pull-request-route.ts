import { ForgeRepository } from "@ace/protocol";
import { repositoryFromRemote } from "@ace/forge/remote";

/** GitHub keeps its existing page addresses; other forges carry their provider explicitly. */
export function repositoryParam(repository: ForgeRepository): string {
  const path = `${repository.host}/${repository.owner}/${repository.name}`;
  return repository.forge === "github" ? path : `${repository.forge}@${path}`;
}

export function repositoryFromParam(value: string | undefined): ForgeRepository | undefined {
  if (!value) return undefined;
  const separator = value.indexOf("@");
  const forge = separator < 0 ? undefined : value.slice(0, separator);
  const parts = (separator < 0 ? value : value.slice(separator + 1)).split("/");
  const host = parts.shift();
  const name = parts.pop();
  if (!host || !name || parts.length === 0) return undefined;
  if (forge !== undefined) {
    const parsed = ForgeRepository.safeParse({ forge, host, owner: parts.join("/"), name });
    return parsed.success ? parsed.data : undefined;
  }
  try {
    // Preserve existing Enterprise GitHub links; public hosts retain their known identity.
    return repositoryFromRemote(`https://${host}/${parts.join("/")}/${name}.git`, {
      [host]: "github",
    });
  } catch {
    return undefined;
  }
}
