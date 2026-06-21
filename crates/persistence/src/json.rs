use serde::Serialize;

pub(crate) fn json<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    serde_json::to_string(value)
}

pub(crate) fn decode_json<T: serde::de::DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_str(&value)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}
