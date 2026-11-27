// SPDX-License-Identifier: Apache-2.0
//! Reading one JavaScript frame's envelope fields (E5.2 step 2). The frame object stays
//! JavaScript's: the shell holds it under a handle and its translator reads it, so Rust reads
//! only the fields `frameEnvelopeError` needs and classifies their JavaScript types.

use ace_engine::frames::envelope::{AccountField, Envelope, Field, PayloadField};
use napi::ValueType;
use napi::bindgen_prelude::Unknown;
use napi::bindgen_prelude::{JsObjectValue, Object};

/// `frameEnvelopeError`'s fields, classified from the JavaScript object's own properties.
pub fn read_envelope(object: &Object, is_object: bool, certified: bool) -> napi::Result<Envelope> {
    let mut envelope = Envelope {
        is_object,
        seq: Field::Absent,
        t: Field::Absent,
        dir: Field::Absent,
        channel: Field::Absent,
        payload: PayloadField::Absent,
        usage_account: AccountField::Absent,
    };
    if !is_object {
        return Ok(envelope);
    }
    envelope.seq = classify(object, "seq")?;
    envelope.t = classify(object, "t")?;
    envelope.dir = classify(object, "dir")?;
    envelope.channel = classify(object, "channel")?;
    if let Ok(payload) = object.get_named_property::<Unknown>("payload") {
        envelope.payload = match payload.get_type()? {
            ValueType::Undefined => PayloadField::Absent,
            // `ProviderPayload.is` is the shell's JavaScript brand check; `certified` is its
            // answer, computed once beside the measure.
            ValueType::Object if certified => PayloadField::Certified,
            ValueType::Object => PayloadField::NotCertified,
            _ => PayloadField::NotCertified,
        };
    }
    if let Ok(account) = object.get_named_property::<Unknown>("usageAccount") {
        envelope.usage_account = match account.get_type()? {
            ValueType::Undefined => AccountField::Absent,
            ValueType::Object => {
                let account: Object = object
                    .get_named_property("usageAccount")
                    .map_err(|_| napi::Error::from_reason("usageAccount is not an object"))?;
                let id = classify(&account, "id")?;
                let billing_mode = classify(&account, "billingMode")?;
                AccountField::Object { id, billing_mode }
            }
            _ => AccountField::NotObject,
        };
    }
    Ok(envelope)
}

fn classify(object: &Object, name: &str) -> napi::Result<Field> {
    let Ok(value) = object.get_named_property::<Unknown>(name) else {
        return Ok(Field::Absent);
    };
    Ok(match value.get_type()? {
        ValueType::Undefined => Field::Absent,
        ValueType::Null => Field::Null,
        ValueType::Number => {
            Field::Number(object.get_named_property::<f64>(name).unwrap_or(f64::NAN))
        }
        ValueType::String => match object.get_named_property::<String>(name) {
            Ok(text) => Field::String(ace_json::JsString::from(text.as_str())),
            Err(_) => Field::Other,
        },
        ValueType::Object => Field::Object,
        _ => Field::Other,
    })
}

/// A string property of a JavaScript object, when it has one.
pub fn string_property(object: &Object, name: &str) -> Option<String> {
    object.get_named_property::<String>(name).ok()
}
