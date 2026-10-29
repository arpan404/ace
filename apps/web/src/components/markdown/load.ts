/**
 * The markdown renderer's code. `Prose` waits for it; opening a thread starts it early, so the
 * transcript's first paint has it and shows messages rather than a skeleton per message.
 */
export const loadMarkdown = () => import("./markdown.tsx");

/**
 * The markit renderer's code, split the same way: agent prose waits for it, and opening a
 * thread starts it early. Forge text never loads it.
 */
export const loadMarkitProse = () => import("./markit-prose.tsx");
