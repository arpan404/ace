// SPDX-License-Identifier: Apache-2.0
//! What a command line carries after parsing: its flags, each with one value or none.

/// One flag's value: a switch was given, or a value was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlagValue<'a> {
    Switch,
    Value(&'a str),
}

/// The flags a run was given, in the order they appeared. Small: a command has a handful.
#[derive(Debug, Default)]
pub struct Flags<'a> {
    entries: Vec<(&'static str, FlagValue<'a>)>,
}

impl<'a> Flags<'a> {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The value recorded for a flag, switch or value.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<FlagValue<'a>> {
        self.entries
            .iter()
            .find(|(flag, _)| *flag == name)
            .map(|(_, value)| *value)
    }

    /// The flag's value when it took one.
    #[must_use]
    pub fn value(&self, name: &str) -> Option<&'a str> {
        match self.get(name) {
            Some(FlagValue::Value(value)) => Some(value),
            _ => None,
        }
    }

    /// Whether the flag was given at all, whatever its value.
    #[must_use]
    pub fn has(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    /// Whether the flag reads as on: given, as a switch or with a value (as TypeScript's
    /// truthiness did).
    #[must_use]
    pub fn on(&self, name: &str) -> bool {
        self.has(name)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&'static str, FlagValue<'a>)> + '_ {
        self.entries.iter().copied()
    }

    /// Records a flag, replacing an earlier value in place as an object assignment would.
    pub fn set(&mut self, name: &'static str, value: FlagValue<'a>) {
        if let Some(entry) = self.entries.iter_mut().find(|(flag, _)| *flag == name) {
            entry.1 = value;
        } else {
            self.entries.push((name, value));
        }
    }
}
