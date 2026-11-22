/** A support bundle's id says whether it holds conversations, from the moment it is made. */
export const conversationBundle = (artifactId: string): boolean =>
  artifactId.startsWith("local-support-");
