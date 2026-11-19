/**
 * Top-level threads an agent started with `thread_start`, and who started each. Created here so
 * both the conversation journal and the upgrade step that reads it see the same table.
 */
export const agentConversationsTable = `CREATE TABLE IF NOT EXISTS agent_conversations (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      owner_thread TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      owner_agent TEXT NOT NULL, root_id TEXT NOT NULL, request_id TEXT NOT NULL, record TEXT NOT NULL,
      UNIQUE(owner_thread,request_id)
    ); CREATE INDEX IF NOT EXISTS agent_conversations_owner ON agent_conversations(owner_thread,thread_id);
    CREATE INDEX IF NOT EXISTS agent_conversations_root ON agent_conversations(root_id,thread_id);`;

/**
 * A thread `thread_start` opened names the thread that started it (`startedBy`). Threads opened
 * before the field existed get it from the conversation journal, which already recorded it.
 */
export const conversationStartedBy = `${agentConversationsTable}
  UPDATE threads SET transitions = json_set(COALESCE(transitions, '{}'), '$.startedBy',
      (SELECT owner_thread FROM agent_conversations c WHERE c.thread_id = threads.id))
    WHERE id IN (SELECT thread_id FROM agent_conversations)
      AND json_extract(transitions, '$.startedBy') IS NULL;`;
