//! Against a real local ace daemon, run by hand only:
//!
//! ```sh
//! SPADE_ACE_MCP_URL=… SPADE_ACE_MCP_TOKEN=… SPADE_ACE_URL=… SPADE_ACE_TOKEN=… \
//!   cargo test -p spade-ace --test real_daemon -- --ignored --nocapture
//! ```
//!
//! It only reads: it lists tools and skills and reads the first skill. No tool is called.

use spade_ace::{AceConfig, AceSkills, AceTools};

#[tokio::test]
#[ignore = "needs a running ace daemon and its credentials"]
async fn lists_a_real_daemons_tools_and_skills() {
    let config =
        AceConfig::from_env(|name| std::env::var(name).ok()).unwrap_or_else(|e| panic!("{e}"));
    let tools = AceTools::new(config.tools).tools().await;
    let tools = tools.unwrap_or_else(|e| panic!("tools: {e}"));
    for tool in &tools {
        println!("tool {} {:?}", tool.name, tool.risk);
    }
    assert!(!tools.is_empty());

    let skills = AceSkills::new(config.skills);
    let listed = skills
        .list(None)
        .await
        .unwrap_or_else(|e| panic!("skills: {e}"));
    println!("{} skills", listed.skills.len());
    if let Some(first) = listed.skills.first() {
        let read = skills.read(&first.id, None).await;
        let read = read.unwrap_or_else(|e| panic!("read {}: {e}", first.id));
        println!("{}: {} bytes", read.skill.name, read.text.len());
    }
}
