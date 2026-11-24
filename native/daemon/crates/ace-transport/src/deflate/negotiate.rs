// SPDX-License-Identifier: Apache-2.0
//! `Sec-WebSocket-Extensions` as `ws` 8.22 reads it for `perMessageDeflate`
//! (`extension.js`'s parser, `permessage-deflate.js:246`–`:292`'s parameter
//! rules, `:161`–`:199`'s `acceptAsServer` with ace's options, and
//! `extension.js:179`–`:201`'s formatting). Pure: header bytes in, the agreement
//! or a malformed offer out. The caller turns a malformed offer into ws's `400`.

/// One `permessage-deflate` parameter, normalized: a flag has no value, a window
/// has decimal bits. `client_max_window_bits` with no value is ws's `true`, which
/// the answer drops.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Param {
    ServerNoContextTakeover,
    ClientNoContextTakeover,
    ServerMaxWindowBits(u8),
    ClientMaxWindowBits(u8),
    /// `client_max_window_bits` without a value: valid in an offer, removed from
    /// the answer (`permessage-deflate.js:196`–`:198`).
    ClientMaxWindowBitsUnset,
}

/// A negotiated `permessage-deflate`: the parameters the answer names, in its
/// order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deflate {
    params: Vec<Param>,
}

impl Deflate {
    /// The offer's `server_max_window_bits`, if it named one.
    pub fn server_max_window_bits(&self) -> Option<u8> {
        self.params.iter().find_map(|param| match param {
            Param::ServerMaxWindowBits(bits) => Some(*bits),
            _ => None,
        })
    }

    /// The offer's `client_max_window_bits`, if it named a value.
    pub fn client_max_window_bits(&self) -> Option<u8> {
        self.params.iter().find_map(|param| match param {
            Param::ClientMaxWindowBits(bits) => Some(*bits),
            _ => None,
        })
    }

    /// The `Sec-WebSocket-Extensions` value of the `101`.
    pub fn header(&self) -> String {
        let mut answer = String::from("permessage-deflate");
        for param in &self.params {
            answer.push_str("; ");
            match param {
                Param::ServerNoContextTakeover => answer.push_str("server_no_context_takeover"),
                Param::ClientNoContextTakeover => answer.push_str("client_no_context_takeover"),
                Param::ServerMaxWindowBits(bits) => {
                    answer.push_str(&format!("server_max_window_bits={bits}"));
                }
                Param::ClientMaxWindowBits(bits) => {
                    answer.push_str(&format!("client_max_window_bits={bits}"));
                }
                Param::ClientMaxWindowBitsUnset => {}
            }
        }
        answer
    }
}

/// An offer the header made, before its parameters are checked: the extension's
/// name and its parameters in the order they were written.
struct Offered {
    name: String,
    params: Vec<(String, Option<String>)>,
}

/// What the header decided: the agreement, nothing when `permessage-deflate` was
/// not offered, or `None` for a header `ws` refuses.
pub fn negotiate(header: Option<&[u8]>) -> Result<Option<Deflate>, Malformed> {
    let Some(header) = header else {
        return Ok(None);
    };
    let offers = parse(header).ok_or(Malformed)?;
    let deflate: Vec<&Offered> = offers
        .iter()
        .filter(|offer| offer.name == "permessage-deflate")
        .collect();
    if deflate.is_empty() {
        return Ok(None);
    }
    // ws normalizes every `permessage-deflate` offer before it picks one, so a bad
    // parameter in a later offer refuses the upgrade all the same.
    let mut normalized: Vec<Vec<Param>> = deflate
        .iter()
        .map(|offer| normalize(offer))
        .collect::<Option<_>>()
        .ok_or(Malformed)?;
    let accepted = normalized.remove(0);
    Ok(Some(accept(accepted)))
}

/// The answer's parameters: the accepted offer's own order, `client_max_window_bits`
/// without a value dropped, then both no-context-takeover flags ace's options
/// impose (`permessage-deflate.js:184`–`:199`).
fn accept(mut params: Vec<Param>) -> Deflate {
    params.retain(|param| *param != Param::ClientMaxWindowBitsUnset);
    if !params.contains(&Param::ServerNoContextTakeover) {
        params.push(Param::ServerNoContextTakeover);
    }
    if !params.contains(&Param::ClientNoContextTakeover) {
        params.push(Param::ClientNoContextTakeover);
    }
    Deflate { params }
}

/// One offer's parameters checked and normalized (`permessage-deflate.js:246`–`:292`):
/// an unknown name, a repeated one, or a value outside its shape is malformed.
fn normalize(offer: &Offered) -> Option<Vec<Param>> {
    let mut normalized: Vec<Param> = Vec::new();
    for (name, value) in &offer.params {
        if offer
            .params
            .iter()
            .filter(|(other, _)| other == name)
            .count()
            > 1
        {
            return None;
        }
        let param = match name.as_str() {
            "server_no_context_takeover" => flag(value, Param::ServerNoContextTakeover)?,
            "client_no_context_takeover" => flag(value, Param::ClientNoContextTakeover)?,
            "server_max_window_bits" => Param::ServerMaxWindowBits(bits(value.as_deref()?)?),
            "client_max_window_bits" => match value {
                Some(value) => Param::ClientMaxWindowBits(bits(value)?),
                None => Param::ClientMaxWindowBitsUnset,
            },
            _ => return None,
        };
        normalized.push(param);
    }
    Some(normalized)
}

/// A `*_no_context_takeover` flag: ws requires its value to be absent (`true`).
fn flag(value: &Option<String>, param: Param) -> Option<Param> {
    value.is_none().then_some(param)
}

/// A window's bits: decimal digits only, 8 to 15 (`permessage-deflate.js:278`–`:288`).
/// `ws` reads the string with JavaScript's `+value`, so `0x0a`, `1e1`, `10.0` and
/// `+10` pass there and are a `400` here (behaviour.md §2's recorded difference).
fn bits(value: &str) -> Option<u8> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    match value.parse::<u8>() {
        Ok(bits) if (8..=15).contains(&bits) => Some(bits),
        _ => None,
    }
}

/// A header `ws` answers with its `400`: a syntax error, an unknown or repeated
/// parameter, or a value outside its shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Malformed;

/// The `Sec-WebSocket-Extensions` grammar of RFC 6455 §9.1, as `extension.js`
/// parses it: comma-separated extensions, each a token with `;`-separated
/// parameters, a parameter's value a token or a quoted token string.
fn parse(header: &[u8]) -> Option<Vec<Offered>> {
    let mut offers: Vec<Offered> = Vec::new();
    let mut at = 0;
    loop {
        skip_ows(header, &mut at);
        let name = token(header, &mut at)?;
        let mut params = Vec::new();
        loop {
            skip_ows(header, &mut at);
            match header.get(at) {
                None => {
                    offers.push(Offered { name, params });
                    return Some(offers);
                }
                Some(b',') => {
                    at += 1;
                    offers.push(Offered { name, params });
                    break;
                }
                Some(b';') => {
                    at += 1;
                    skip_ows(header, &mut at);
                    let param = token(header, &mut at)?;
                    // ws's parser refuses a space before `=` (the name's end is
                    // already set), so the `=` must follow the token directly.
                    let value = match header.get(at) {
                        Some(b'=') => {
                            at += 1;
                            Some(value(header, &mut at)?)
                        }
                        _ => None,
                    };
                    params.push((param, value));
                }
                Some(_) => return None,
            }
        }
    }
}

fn skip_ows(header: &[u8], at: &mut usize) {
    while matches!(header.get(*at), Some(b' ' | b'\t')) {
        *at += 1;
    }
}

/// A run of token characters, at least one.
fn token(header: &[u8], at: &mut usize) -> Option<String> {
    let start = *at;
    while header.get(*at).is_some_and(|byte| is_token(*byte)) {
        *at += 1;
    }
    (*at > start).then(|| latin1(&header[start..*at]))
}

/// A parameter's value: a token, or a quoted string whose content and escaped
/// characters are token characters too (`extension.js:270`–`:283`).
fn value(header: &[u8], at: &mut usize) -> Option<String> {
    if header.get(*at) == Some(&b'"') {
        *at += 1;
        let mut text = String::new();
        loop {
            let byte = *header.get(*at)?;
            *at += 1;
            match byte {
                b'"' => return Some(text),
                b'\\' => {
                    let escaped = *header.get(*at)?;
                    *at += 1;
                    if !is_token(escaped) {
                        return None;
                    }
                    text.push(char::from(escaped));
                }
                _ if is_token(byte) => text.push(char::from(byte)),
                _ => return None,
            }
        }
    }
    token(header, at)
}

/// One byte of a header value as Node decodes it.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

/// An RFC 9110 token character, `ws`'s `tokenChars`.
fn is_token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}
