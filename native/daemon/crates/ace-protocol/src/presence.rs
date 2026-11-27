// SPDX-License-Identifier: Apache-2.0
//! Presence that `serde`'s `Option` alone cannot state: an optional nullable object key is
//! `Option<Option<T>>`, because `null` and an absent key are different values to Zod. Serde
//! reads both as the outer `None`; the generated field's `deserialize_with` wrapper keeps a
//! present `null` as `Some(None)`.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Read a present `null` as `Some(None)` and a present value as `Some(Some(value))`; an absent
/// key stays `None` through the field's `#[serde(default)]`.
pub fn some_or_none<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// A loose object's unnamed keys, flattened into a generated struct. `ace_json::Map` serializes
/// as one pre-written value, which `serde`'s flatten cannot take; this wrapper writes it as the
/// map it is, and reads the leftover entries back as one.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Extra(pub ace_json::Map);

impl Serialize for Extra {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Extra {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        ace_json::Map::deserialize(deserializer).map(Extra)
    }
}
