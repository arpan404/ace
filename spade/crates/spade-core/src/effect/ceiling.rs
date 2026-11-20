//! A packaged bot's declared effects as a ceiling (ADR 0200 §3.4): the phone-permission model on
//! top of ADR 0171. A package lists the effects its bot may use beyond `read` and `write_local`,
//! each with a reason, and the person turns each on or off at install. A call whose effect is
//! outside what is left on is refused before any review, whatever the tool is called: the effect
//! is the gate's own reading, never the package's word about the call. Declaring an effect grants
//! nothing; the person-only effects still go to the person every time.

use super::Effect;

/// The effects a package may declare, in the words its manifest uses.
pub const DECLARABLE: [Effect; 5] = [
    Effect::Network,
    Effect::Publish,
    Effect::SendAsPerson,
    Effect::Pay,
    Effect::ChangeAccess,
];

/// A set of declarable effects.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Effects(u8);

impl Effects {
    pub const NONE: Self = Self(0);
    pub const ALL: Self = Self(0b1_1111);

    fn bit(effect: Effect) -> Option<u8> {
        DECLARABLE
            .iter()
            .position(|declared| *declared == effect)
            .map(|at| 1 << at)
    }

    /// The set with `effect` in it too; an effect no package declares changes nothing.
    #[must_use]
    pub fn with(self, effect: Effect) -> Self {
        Self(self.0 | Self::bit(effect).unwrap_or(0))
    }

    pub fn has(self, effect: Effect) -> bool {
        Self::bit(effect).is_some_and(|bit| self.0 & bit != 0)
    }

    /// What both sets hold: a worker under a packaged maker gets no more than its maker.
    #[must_use]
    pub fn and(self, other: Self) -> Self {
        Self(self.0 & other.0)
    }

    pub fn iter(self) -> impl Iterator<Item = Effect> {
        DECLARABLE
            .into_iter()
            .filter(move |effect| self.has(*effect))
    }
}

impl FromIterator<Effect> for Effects {
    fn from_iter<I: IntoIterator<Item = Effect>>(effects: I) -> Self {
        effects.into_iter().fold(Self::NONE, Self::with)
    }
}

/// The ceiling one call is held to: the effects left on for the packaged bot it runs for (the
/// nearest packaged bot up its tree, narrowed by every one above), and that bot's name for the
/// refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ceiling<'a> {
    pub bot: &'a str,
    pub allows: Effects,
}

/// The declared word a call's effect needs, if it needs one. A read and a change to the bot's
/// own things need none; a driving step acts outside the bot, so it needs `network` (its place
/// is granted one app or site at a time, under that word). A tool that declares nothing, or a
/// word Spade doesn't know, needs none here: it already goes to the person every time. A secret
/// was refused before this.
pub fn needs(effect: Option<Effect>) -> Option<Effect> {
    match effect? {
        Effect::Read | Effect::WriteLocal | Effect::Unknown | Effect::Credential => None,
        Effect::Drive => Some(Effect::Network),
        declared => Some(declared),
    }
}

/// Why `ceiling` refuses a call with `effect`, if it does.
pub fn refusal(ceiling: Option<Ceiling<'_>>, effect: Option<Effect>) -> Option<String> {
    let ceiling = ceiling?;
    let needed = needs(effect)?;
    if ceiling.allows.has(needed) {
        return None;
    }
    Some(format!(
        "{} doesn't declare {}.",
        ceiling.bot,
        gerund(needed)
    ))
}

/// The effect as the refusal says it: "doesn't declare publishing".
pub fn gerund(effect: Effect) -> &'static str {
    match effect {
        Effect::Network => "reaching outside its own folder",
        Effect::Publish => "publishing",
        Effect::SendAsPerson => "sending in your name",
        Effect::Pay => "spending money",
        Effect::ChangeAccess => "changing sign-ins or access",
        _ => "this",
    }
}
