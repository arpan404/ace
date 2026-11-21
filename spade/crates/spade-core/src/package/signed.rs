//! What the format fixes about a signed version manifest (ADR 0168 §6, ADR 0201 `distribution`):
//! the label it is signed behind. The checking itself is the runtime's (Spade's is
//! `spade-server`'s `packages::envelope`).

/// What a signed version manifest is signed behind, so a signature over anything else never
/// verifies as one: Ed25519 over this label, a newline, and the body's canonical JSON.
pub const MANIFEST_LABEL: &str = "ace-market-manifest-v1";
