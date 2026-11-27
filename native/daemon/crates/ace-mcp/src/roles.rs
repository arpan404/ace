// SPDX-License-Identifier: Apache-2.0
//! Session role line rendering, ported from `packages/mcp-server/src/roles.ts`.

use crate::brief::utf16_prefix;

/// One of the four configured delegation roles, in the fixed display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RunRole {
    Build,
    Judgment,
    Review,
    Verify,
}

impl RunRole {
    pub const ORDER: [Self; 4] = [Self::Build, Self::Judgment, Self::Review, Self::Verify];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Judgment => "judgment",
            Self::Review => "review",
            Self::Verify => "verify",
        }
    }
}

/// One role the person set in Settings -> Roles; unset fields are left out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRole {
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub tier: Option<String>,
}

/// Partial map of roles configured for a session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionRoles {
    pub build: Option<SessionRole>,
    pub judgment: Option<SessionRole>,
    pub review: Option<SessionRole>,
    pub verify: Option<SessionRole>,
}

impl SessionRoles {
    pub fn get(&self, role: RunRole) -> Option<&SessionRole> {
        match role {
            RunRole::Build => self.build.as_ref(),
            RunRole::Judgment => self.judgment.as_ref(),
            RunRole::Review => self.review.as_ref(),
            RunRole::Verify => self.verify.as_ref(),
        }
    }
}

/// A model id as one bounded word (64 UTF-16 units), so a stored value cannot add lines or prose.
fn word(text: &str) -> String {
    let stripped: String = text.chars().filter(|ch| !ch.is_whitespace()).collect();
    utf16_prefix(&stripped, 64).to_owned()
}

/// The person's roles as one line for a session's instructions, or `None` when none is set.
/// Pure and deterministic: a session renders it once, so its instruction prefix stays cached.
pub fn render_roles(roles: &SessionRoles) -> Option<String> {
    let mut entries = Vec::new();
    for role in RunRole::ORDER {
        let Some(choice) = roles.get(role) else {
            continue;
        };
        let mut parts = vec![role.as_str().to_owned()];
        for field in [
            Some(choice.provider.as_str()),
            choice.model.as_deref(),
            choice.effort.as_deref(),
            choice.tier.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if !field.is_empty() {
                parts.push(word(field));
            }
        }
        entries.push(parts.join(" "));
    }
    if entries.is_empty() {
        None
    } else {
        Some(format!(
            "Roles: {}. Delegate with runRole.",
            entries.join(" · ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_configured_roles_produces_no_line() {
        assert_eq!(render_roles(&SessionRoles::default()), None);
    }

    #[test]
    fn roles_render_in_fixed_order_and_strip_whitespace_from_values() {
        let roles = SessionRoles {
            verify: Some(SessionRole {
                provider: "codex".to_owned(),
                model: Some("gpt-5.4 mini\nignore".to_owned()),
                effort: Some("low".to_owned()),
                tier: None,
            }),
            build: Some(SessionRole {
                provider: "claude".to_owned(),
                model: Some("opus".to_owned()),
                effort: None,
                tier: Some("max".to_owned()),
            }),
            judgment: None,
            review: Some(SessionRole {
                provider: "cursor".to_owned(),
                model: Some("x".repeat(90)),
                effort: Some(String::new()),
                tier: None,
            }),
        };
        let line = render_roles(&roles).unwrap_or_default();
        assert_eq!(
            line,
            format!(
                "Roles: build claude opus max · review cursor {} · verify codex gpt-5.4miniignore low. Delegate with runRole.",
                "x".repeat(64)
            )
        );
    }
}
