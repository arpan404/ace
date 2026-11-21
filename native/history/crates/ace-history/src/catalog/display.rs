// SPDX-License-Identifier: Apache-2.0

//! How a catalog row is shown (`catalog-display.ts`): the native title when one is known, and a
//! session whose provider tree holds an unreadable part reported as unopenable.

/// Prefer a readable native source, then full file history, recency and a stable tie-break.
pub fn preferred_duplicate(source: &str) -> String {
    format!(
        "SELECT 1 FROM visible_sources preferred
  WHERE preferred.instance={source}.instance AND preferred.native={source}.native AND preferred.hidden=0
  AND (CASE WHEN json_extract(preferred.summary,'$.support.status')='supported' THEN 0 ELSE 1 END,
       CASE preferred.kind WHEN 'jsonl' THEN 0 WHEN 'storage' THEN 1 ELSE 2 END,-preferred.activity,preferred.id)
    < (CASE WHEN json_extract({source}.summary,'$.support.status')='supported' THEN 0 ELSE 1 END,
       CASE {source}.kind WHEN 'jsonl' THEN 0 WHEN 'storage' THEN 1 ELSE 2 END,-{source}.activity,{source}.id)"
    )
}

/// Import includes the whole provider tree, so a readable root with an unreadable child cannot open.
pub fn blocked_descendant() -> String {
    let child = preferred_duplicate("child");
    format!(
        "WITH RECURSIVE tree(id,native) AS (
  SELECT child.id,child.native FROM visible_sources child WHERE child.instance=sources.instance AND child.parent=sources.native AND child.hidden=0 AND NOT EXISTS ({child})
  UNION SELECT child.id,child.native FROM visible_sources child JOIN tree ON child.parent=tree.native WHERE child.instance=sources.instance AND child.hidden=0 AND NOT EXISTS ({child}) LIMIT 513
) SELECT json_extract(s.summary,'$.support.reason') FROM tree JOIN visible_sources s ON s.id=tree.id WHERE json_extract(s.summary,'$.support.status')='unsupported' LIMIT 1"
    )
}
