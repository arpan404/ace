// SPDX-License-Identifier: Apache-2.0
//! `agent-env.ts`: the variables ace gives every agent session it starts (ADR 0178 §10). Hints for
//! an honest caller, never a security boundary. Moved cases: `agent-env.test.ts` (2).

use crate::ThreadId;

/// The environment ace adds to a provider process: its own thread, never to prompt, and the home
/// its daemon uses when it has one.
pub fn agent_session_env(thread_id: &ThreadId, home: Option<&str>) -> Vec<(String, String)> {
    let mut env = vec![
        ("ACE_THREAD_ID".to_owned(), thread_id.clone()),
        ("ACE_NO_INPUT".to_owned(), "1".to_owned()),
    ];
    if let Some(home) = home {
        env.push(("ACE_HOME".to_owned(), home.to_owned()));
    }
    env
}
