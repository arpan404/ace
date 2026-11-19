//! The person's consent never crosses machines (ADR 0187). A bot's security settings arrive
//! with every grant gone (folders, toolchains, pushes, comments, tools, apps and sites it may
//! drive) and set to the auto-review, explicitly and unconfirmed: never left to follow this
//! machine's default, which may be Full access. What only narrows it (its network and where its
//! commands run) stays. Each thing dropped is named for the person.

use spade_core::grant::{Grant, Scope};

use crate::security::settings::BotSecurity;

/// One grant in the person's words.
fn grant_words(grant: &Grant) -> String {
    match &grant.scope {
        Scope::Folder { path, write: true } => format!("the folder {path}, to change"),
        Scope::Folder { path, write: false } => format!("the folder {path}, to read"),
        Scope::GitPush { repo, branch } => format!("pushing to {repo} ({branch})"),
        Scope::PrComment { repo, .. } => format!("commenting on pull requests in {repo}"),
        Scope::Tool { tool, .. } => format!("running {tool} without asking"),
        Scope::DriveApp { app } => format!("driving {app}"),
        Scope::DriveSite { host } => format!("driving {host}"),
    }
}

/// The settings as they arrive, and what of the person's consent stayed behind. Settings that
/// don't read are dropped whole.
pub(super) fn reset(text: &str) -> (String, Vec<String>) {
    let (mut settings, unread) = match serde_json::from_str::<BotSecurity>(text) {
        Ok(settings) => (settings, None),
        Err(_) => (
            BotSecurity::default(),
            Some("its security settings, which this machine couldn't read".to_owned()),
        ),
    };
    let mut dropped: Vec<String> = settings.grants.iter().map(grant_words).collect();
    dropped.extend(unread);
    dropped.extend(
        settings
            .toolchains
            .iter()
            .map(|path| format!("the toolchain {path}")),
    );
    if settings.autonomy == Some(spade_core::autonomy::Mode::FullAccess) {
        dropped.push("Full access".to_owned());
    }
    settings.grants.clear();
    settings.toolchains.clear();
    settings.autonomy = Some(spade_core::autonomy::Mode::AutoReview);
    settings.full_access_confirmed = false;
    (
        serde_json::to_string(&settings).unwrap_or_else(|_| "{}".to_owned()),
        dropped,
    )
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::reset;

    #[test]
    fn every_grant_and_full_access_stay_behind_and_are_named_while_limits_stay() {
        let text = json!({
            "network": { "mode": "off" },
            "autonomy": "full_access",
            "full_access_confirmed": true,
            "toolchains": ["/opt/rust"],
            "grants": [
                { "id": "g1", "kind": "folder", "path": "/srv/app", "write": true, "by": "person", "created_at": 1 },
                { "id": "g2", "kind": "git_push", "repo": "o/r", "branch": "main", "by": "person", "created_at": 1 },
                { "id": "g3", "kind": "pr_comment", "repo": "o/r", "by": "person", "created_at": 1 },
                { "id": "g4", "kind": "tool", "tool": "deploy", "by": "person", "created_at": 1 },
                { "id": "g5", "kind": "drive_app", "app": "com.apple.TextEdit", "by": "person", "created_at": 1 },
                { "id": "g6", "kind": "drive_site", "host": "github.com", "by": "person", "created_at": 1 },
            ],
        })
        .to_string();
        let (kept, dropped) = reset(&text);
        let kept: Value = serde_json::from_str(&kept).unwrap_or_default();
        assert_eq!(kept["grants"], json!([]));
        assert_eq!(kept["toolchains"], json!([]));
        assert_eq!(
            kept["autonomy"], "auto_review",
            "explicit, never the machine's default"
        );
        assert!(kept.get("full_access_confirmed").is_none_or(|v| v == false));
        assert_eq!(kept["network"]["mode"], "off", "a limit it had stays");
        assert_eq!(dropped.len(), 8, "{dropped:?}");
        assert!(dropped.contains(&"Full access".to_owned()));
        assert!(dropped.iter().any(|d| d.contains("/srv/app")));
    }

    #[test]
    fn settings_that_dont_read_or_none_at_all_arrive_on_the_auto_review() {
        for text in ["{\"grants\": 7}", "{}"] {
            let (kept, _) = reset(text);
            let kept: Value = serde_json::from_str(&kept).unwrap_or_default();
            assert_eq!(kept["autonomy"], "auto_review", "{text}");
            assert_eq!(kept["grants"], json!([]));
        }
        assert_eq!(reset("{\"grants\": 7}").1.len(), 1);
        assert!(reset("{}").1.is_empty());
    }
}
