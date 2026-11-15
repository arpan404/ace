// SPDX-License-Identifier: Apache-2.0
use media_wire::media_link::{
    ClientMessage, HELLO_BYTES, ServerMessage, TICKET_BYTES, hello, hello_ticket,
};
use serde_json::Value;
use std::{fs, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/media-link")
}

fn hex(s: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    (0..s.len())
        .step_by(2)
        .map(|i| Ok(u8::from_str_radix(&s[i..i + 2], 16)?))
        .collect()
}

#[test]
fn a_hello_carries_exactly_one_ticket_and_every_other_shape_is_refused()
-> Result<(), Box<dyn std::error::Error>> {
    let vector: Value = serde_json::from_slice(&fs::read(root().join("hello.json"))?)?;
    let ticket = hex(vector["ticketHex"].as_str().ok_or("ticket")?)?;
    let bytes = hex(vector["hex"].as_str().ok_or("hex")?)?;
    assert_eq!(bytes.len(), HELLO_BYTES);
    assert_eq!(hello_ticket(&bytes), Ok(ticket.as_slice()));
    let fixed: [u8; TICKET_BYTES] = ticket.as_slice().try_into()?;
    assert_eq!(hello(&fixed).as_slice(), bytes.as_slice());
    for refused in vector["refused"].as_array().ok_or("refused")? {
        let bad = hex(refused["hex"].as_str().ok_or("hex")?)?;
        assert!(hello_ticket(&bad).is_err(), "{}", refused["why"]);
    }
    Ok(())
}

#[test]
fn a_media_connection_takes_acks_and_pings_and_nothing_else()
-> Result<(), Box<dyn std::error::Error>> {
    let vectors: Vec<Value> = serde_json::from_slice(&fs::read(root().join("messages.json"))?)?;
    for vector in vectors {
        let message = &vector["message"];
        let valid = vector["valid"].as_bool().ok_or("valid")?;
        if vector["direction"] == "client" {
            let parsed = ClientMessage::parse(&message.to_string());
            assert_eq!(parsed.is_some(), valid, "{message}");
            if let Some(parsed) = parsed {
                let expected = vector.get("parsed").unwrap_or(message);
                assert_eq!(serde_json::to_value(&parsed)?, *expected);
            }
        } else {
            let parsed: ServerMessage = serde_json::from_value(message.clone())?;
            assert_eq!(serde_json::to_value(&parsed)?, *message);
        }
    }
    Ok(())
}
