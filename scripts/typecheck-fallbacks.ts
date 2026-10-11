import { sep } from "node:path";
import type { Project } from "typescript/unstable/sync";
import {
  isCallExpression,
  isObjectLiteralExpression,
  isNewExpression,
  isTypeParameterDeclaration,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

function containsObject(node: Node): boolean {
  // Object literals behind another call or a function body do not receive this
  // call's const-generic contextual type. Inspect those calls separately instead.
  if (
    isCallExpression(node) ||
    isNewExpression(node) ||
    node.kind === SyntaxKind.ArrowFunction ||
    node.kind === SyntaxKind.FunctionExpression
  )
    return false;
  return isObjectLiteralExpression(node) || Boolean(node.forEachChild(containsObject));
}

function hasConstParameter(node: Node): boolean {
  return (
    isTypeParameterDeclaration(node) &&
    Boolean(node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ConstKeyword))
  );
}

/** Contextual checks and known lossy inference must retain the entire original source graph. */
export function needsSourceCheck(
  project: Project,
  source: SourceFile,
  workspaceDirectories: string[],
  root: string,
): boolean {
  const inWorkspace = (file: string): boolean =>
    workspaceDirectories.some((directory) => file.startsWith(`${directory}${sep}`));
  const local =
    source.fileName.startsWith(`${root}${sep}`) &&
    !source.fileName.includes(`${sep}node_modules${sep}`);
  // Every reachable augmentation can change dependency implementations, including
  // global/module augmentations supplied only by external declaration packages.
  if (source.moduleAugmentations.length || source.ambientModuleNames.length) return true;
  if (local && !source.externalModuleIndicator) return true;
  if (!inWorkspace(source.fileName)) return false;
  if (source.isDeclarationFile) return false;

  function visit(node: Node): boolean {
    if ((isCallExpression(node) || isNewExpression(node)) && node.arguments?.some(containsObject)) {
      const declaration = project.checker.getResolvedSignature(node)?.declaration?.resolve();
      // Synthetic/unresolved signatures cannot establish that declaration inference is safe.
      if (!declaration) return true;
      const constant = declaration.forEachChild(hasConstParameter);
      const constructorConstant =
        declaration.kind === SyntaxKind.Constructor &&
        declaration.parent.forEachChild(hasConstParameter);
      if (constant || constructorConstant) return true;
    }
    return Boolean(node.forEachChild(visit));
  }
  // TS #64059 loses nested readonly during const-generic declaration inference.
  // Inspect resolved call signatures, including helpers imported from external .d.ts files.
  return visit(source);
}
