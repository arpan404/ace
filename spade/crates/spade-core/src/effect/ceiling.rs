//! A packaged bot's declared effects as a ceiling (ADR 0200 §3.4): the phone-permission model on
//! top of ADR 0171. A package lists the effects its bot may use beyond `read` and `write_local`,
//! each with a reason, and the person turns each on or off at install. A call whose effect is
//! outside what is left on is refused before any review, whatever the tool is called: the effect
//! is the gate's own reading, never the package's word about the call. Declaring an effect grants
//! nothing; the person-only effects still go to the person every time.

use super::Effect;
use crate::autonomy::{Class, Sensitive};

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

/// What the ceiling reads a call as: the gate's reading of its effect, raised by what the shell
/// classifier read in a command that runs (or asks to run) outside the sandbox. A command's tool
/// is a local write, but what it runs outside the box can publish or send: that is the call's
/// effect here. `None`: the tool declares nothing.
pub fn reading(effect: Option<Effect>, command: Option<Class>) -> Option<Effect> {
    let effect = effect?;
    Some(command.map_or(effect, |class| effect.max(command_effect(class))))
}

/// What a command the classifier read does, in effect words. A command it can't read whole, or
/// a script it can't show, is [`Effect::Unknown`]: unresolved.
pub fn command_effect(class: Class) -> Effect {
    match class {
        Class::Inside => Effect::WriteLocal,
        Class::Outward => Effect::Network,
        Class::Sensitive(kind) => match kind {
            Sensitive::Payment => Effect::Pay,
            Sensitive::MessageAsPerson => Effect::SendAsPerson,
            Sensitive::Publish | Sensitive::RemoteChange => Effect::Publish,
            Sensitive::Credentials => Effect::ChangeAccess,
            Sensitive::Network
            | Sensitive::DeleteOutside
            | Sensitive::WriteOutside
            | Sensitive::Admin
            | Sensitive::TaintedRoutine => Effect::Network,
            // Driving other apps acts outside the bot, as a driving step does.
            Sensitive::Automation => Effect::Drive,
            Sensitive::Unknown | Sensitive::Unclear | Sensitive::UnseenScript => Effect::Unknown,
        },
    }
}

/// The declared word a call's effect needs, if it needs one. A read and a change to the bot's
/// own things need none; a driving step acts outside the bot, so it needs `network` (its place
/// is granted one app or site at a time, under that word). An unresolved effect is decided by
/// [`refusal`] on where it runs, and a secret was refused before this.
pub fn needs(effect: Option<Effect>) -> Option<Effect> {
    match effect? {
        Effect::Read | Effect::WriteLocal | Effect::Unknown | Effect::Credential => None,
        Effect::Drive => Some(Effect::Network),
        declared => Some(declared),
    }
}

/// Whether a packaged bot's call with `effect` needs the person's own answer every time, however
/// they answered before: a send, a payment, an access change, or something Spade can't name. No
/// Always allow, typed grant or answer kept for the tool carries to it (ADR 0200 §3.4).
pub fn fresh_each_time(effect: Option<Effect>) -> bool {
    matches!(
        effect,
        None | Some(Effect::SendAsPerson | Effect::Pay | Effect::ChangeAccess | Effect::Unknown)
    )
}

/// Why `ceiling` refuses a call with `effect` (as [`reading`] reads it), if it does. `confined`:
/// it runs in the bot's sandbox, which holds its files and network, with nothing that reaches a
/// server. A packaged bot may do only what its package declared, so a call whose effect Spade
/// can't resolve is refused unless it is confined that way.
pub fn refusal(
    ceiling: Option<Ceiling<'_>>,
    effect: Option<Effect>,
    confined: bool,
) -> Option<String> {
    let ceiling = ceiling?;
    if matches!(effect, None | Some(Effect::Unknown)) {
        return (!confined).then(|| {
            format!(
                "Spade can't tell what this does, and {} may only do what its package declares.",
                ceiling.bot
            )
        });
    }
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
