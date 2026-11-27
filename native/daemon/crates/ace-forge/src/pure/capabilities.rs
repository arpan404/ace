// SPDX-License-Identifier: Apache-2.0
//! Host adapter capability table (`forge-capabilities.ts`, ADR 0117).

use crate::pure::ForgeKind;

const GITHUB: &[&str] = &[
    "reviews.read",
    "reviews.files",
    "reviews.commits",
    "reviews.comments.read",
    "reviews.comments.write",
    "reviews.comments.reply",
    "reviews.approvals.read",
    "reviews.approvals.write",
    "reviews.reviewers.request",
    "reviews.checks",
    "reviews.checks.write",
    "reviews.create",
    "reviews.edit",
    "reviews.merge",
    "reviews.autoMerge",
    "reviews.stacks",
    "reviews.suggestions",
    "issues.read",
    "issues.write",
    "inbox",
    "reactions",
    "media",
];

const GITLAB: &[&str] = &[
    "reviews.read",
    "reviews.files",
    "reviews.commits",
    "reviews.comments.read",
    "reviews.comments.write",
    "reviews.comments.reply",
    "reviews.approvals.read",
    "reviews.approvals.write",
    "reviews.reviewers.request",
    "reviews.checks",
    "reviews.checks.write",
    "reviews.create",
    "reviews.edit",
    "reviews.merge",
    "reviews.autoMerge",
    "issues.read",
    "issues.write",
    "inbox",
];

const TEA: &[&str] = &[
    "reviews.read",
    "reviews.files",
    "reviews.commits",
    "reviews.comments.read",
    "reviews.comments.write",
    "reviews.approvals.read",
    "reviews.approvals.write",
    "reviews.checks",
    "reviews.merge",
    "issues.read",
    "issues.write",
];

const BITBUCKET: &[&str] = &[
    "reviews.read",
    "reviews.files",
    "reviews.commits",
    "reviews.comments.read",
    "reviews.comments.write",
    "reviews.comments.reply",
    "reviews.approvals.read",
    "reviews.approvals.write",
    "reviews.checks",
];

const ORIGIN: &[&str] = &["reviews.read", "reviews.files"];

/// Declared capabilities for `forge` (`forgeCapabilities[forge]`).
pub fn forge_capabilities(forge: ForgeKind) -> &'static [&'static str] {
    match forge {
        ForgeKind::Github => GITHUB,
        ForgeKind::Gitlab => GITLAB,
        ForgeKind::Gitea | ForgeKind::Forgejo => TEA,
        ForgeKind::Bitbucket => BITBUCKET,
        ForgeKind::Origin => ORIGIN,
        ForgeKind::Gitbucket => &[],
    }
}

/// Whether `forge` declares `capability` (`supports`).
pub fn supports(forge: ForgeKind, capability: &str) -> bool {
    forge_capabilities(forge).contains(&capability)
}
