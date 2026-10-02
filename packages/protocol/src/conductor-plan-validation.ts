interface Workstream {
  id: string;
  dependencies: string[];
  brief: { files: string[]; packages: string[] };
}
interface OwnershipNode {
  owners: Set<string>;
  descendants: Set<string>;
  children: Map<string, OwnershipNode>;
}
function ownershipNode(): OwnershipNode {
  return { owners: new Set(), descendants: new Set(), children: new Map() };
}

/** Used only inside plan schema parsing. Work is proportional to paths and
 * their overlapping owners, rather than every pair of ownership strings. */
export function validatePlan(
  workstreams: readonly Workstream[],
  caseSensitivity: "sensitive" | "insensitive",
  error: (message: string) => void,
): void {
  const nodes = new Map(workstreams.map((w) => [w.id, w]));
  if (nodes.size !== workstreams.length) {
    error("duplicate workstream id");
    return;
  }
  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  let invalid = false;
  const report = (message: string) => {
    invalid = true;
    error(message);
  };
  const visit = (id: string): Set<string> => {
    const cached = ancestors.get(id);
    if (cached) return cached;
    if (visiting.has(id)) {
      report("dependency cycle");
      return new Set();
    }
    visiting.add(id);
    const result = new Set<string>(),
      node = nodes.get(id);
    if (!node) report(`unknown dependency ${id}`);
    for (const dep of node?.dependencies ?? []) {
      result.add(dep);
      for (const ancestor of visit(dep)) result.add(ancestor);
    }
    visiting.delete(id);
    ancestors.set(id, result);
    return result;
  };
  for (const stream of workstreams) {
    if (new Set(stream.dependencies).size !== stream.dependencies.length)
      report("duplicate dependency");
    visit(stream.id);
  }
  if (invalid) return;
  const tree = ownershipNode();
  const ordered = (a: string, b: string) =>
    a === b || ancestors.get(a)?.has(b) || ancestors.get(b)?.has(a);
  const check = (owners: Set<string>, id: string) => {
    for (const owner of owners)
      if (!ordered(owner, id)) error(`unordered ownership overlap: ${owner}, ${id}`);
  };
  for (const stream of workstreams)
    for (const path of [...stream.brief.files, ...stream.brief.packages]) {
      const normalized = path.normalize("NFC");
      // A conservative casing closure catches non-lowercase aliases such as
      // final sigma and long s; lowering first also collapses capital sharp s.
      // It may merge more names than a particular volume, so those owners must
      // be dependency-ordered. Never use locale-dependent casing here.
      const canonical =
        caseSensitivity === "insensitive" ? normalized.toLowerCase().toUpperCase() : normalized;
      const segments = canonical === "." ? [] : canonical.split("/");
      let node = tree;
      const prefixes = [node];
      for (const segment of segments) {
        check(node.owners, stream.id);
        let child = node.children.get(segment);
        if (!child) {
          child = ownershipNode();
          node.children.set(segment, child);
        }
        node = child;
        prefixes.push(node);
      }
      check(node.descendants, stream.id);
      node.owners.add(stream.id);
      for (const prefix of prefixes) prefix.descendants.add(stream.id);
    }
}
