// SPDX-License-Identifier: Apache-2.0
//! Kind-specific metadata. Encoders write caller storage; decoders borrow wire bytes.
use std::{fmt, str};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Short,
    Length,
    Text,
    Invalid,
    Space,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "stream header {self:?}")
    }
}
impl std::error::Error for Error {}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Video<'a> {
    pub sequence: f64,
    pub timestamp: f64,
    pub width: u32,
    pub height: u32,
    pub coded_width: u16,
    pub coded_height: u16,
    pub key: bool,
    pub codec: &'a str,
    pub description: &'a [u8],
    pub thread_id: &'a str,
    pub tab_id: Option<&'a str>,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Audio<'a> {
    pub sequence: f64,
    pub timestamp: f64,
    pub sample_rate: u32,
    pub channels: u8,
    pub codec: &'a str,
    pub thread_id: &'a str,
    pub tab_id: Option<&'a str>,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Picture<'a> {
    pub sequence: f64,
    pub timestamp: f64,
    pub width: u16,
    pub height: u16,
    /// Six significant decimal digits, as in the TypeScript decoder.
    pub scale: f64,
    pub rotation: u16,
    pub key: bool,
    pub still: bool,
    pub codec: &'a str,
    pub source_id: &'a str,
    pub stream_id: &'a str,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self.at.checked_add(n).ok_or(Error::Short)?;
        let bytes = self.bytes.get(self.at..end).ok_or(Error::Short)?;
        self.at = end;
        Ok(bytes)
    }
    fn array<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        self.take(N)?.try_into().map_err(|_| Error::Short)
    }
    fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.array::<1>()?[0])
    }
    fn u16(&mut self) -> Result<u16, Error> {
        Ok(u16::from_be_bytes(self.array()?))
    }
    fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_be_bytes(self.array()?))
    }
    fn f64(&mut self) -> Result<f64, Error> {
        Ok(f64::from_be_bytes(self.array()?))
    }
    fn part(&mut self) -> Result<&'a [u8], Error> {
        let n = self.u16()? as usize;
        self.take(n)
    }
    fn codec(&mut self) -> Result<&'a str, Error> {
        let n = self.u8()? as usize;
        text(self.take(n)?)
    }
    fn end(self) -> Result<(), Error> {
        if self.at == self.bytes.len() {
            Ok(())
        } else {
            Err(Error::Length)
        }
    }
}
fn text(bytes: &[u8]) -> Result<&str, Error> {
    // TextDecoder removes a leading UTF-8 BOM.
    str::from_utf8(bytes.strip_prefix(&[239, 187, 191]).unwrap_or(bytes)).map_err(|_| Error::Text)
}
fn tab(s: &str) -> Option<&str> {
    if s.is_empty() { None } else { Some(s) }
}
fn sequence(n: f64) -> bool {
    n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0
}
fn codec(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
}
fn tab_valid(s: Option<&str>) -> bool {
    s.is_none_or(|s| (1..=128).contains(&s.encode_utf16().count()))
}
fn screen(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn device(s: &str) -> bool {
    if let Some(s) = s.strip_prefix("ios:") {
        s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
    } else if let Some(s) = s.strip_prefix("android:") {
        (1..=200).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    } else {
        false
    }
}

pub fn decode_video<'a>(meta: &'a [u8], payload: &[u8]) -> Result<Video<'a>, Error> {
    if meta.len() < 36 {
        return Err(Error::Short);
    }
    let mut r = Reader { bytes: meta, at: 0 };
    let sequence = r.f64()?;
    let timestamp = r.f64()?;
    let width = r.u32()?;
    let height = r.u32()?;
    let coded_width = r.u16()?;
    let coded_height = r.u16()?;
    let key = r.u8()? & 1 != 0;
    let codec = r.codec()?;
    let description = r.part()?;
    let thread_id = text(r.part()?)?;
    let tab_id = tab(text(r.part()?)?);
    r.end()?;
    let v = Video {
        sequence,
        timestamp,
        width,
        height,
        coded_width,
        coded_height,
        key,
        codec,
        description,
        thread_id,
        tab_id,
    };
    if !v.valid() || payload.is_empty() {
        return Err(Error::Invalid);
    }
    Ok(v)
}
impl Video<'_> {
    fn valid(&self) -> bool {
        sequence(self.sequence)
            && self.timestamp.is_finite()
            && (100..=4096).contains(&self.width)
            && (100..=4096).contains(&self.height)
            && (2..=8192).contains(&self.coded_width)
            && (2..=8192).contains(&self.coded_height)
            && codec(self.codec)
            && !self.thread_id.is_empty()
            && tab_valid(self.tab_id)
    }
    pub fn encode(&self, out: &mut [u8]) -> Result<usize, Error> {
        let mut w = Writer { out, at: 0 };
        w.put(&self.sequence.to_be_bytes())?;
        w.put(&self.timestamp.to_be_bytes())?;
        w.put(&self.width.to_be_bytes())?;
        w.put(&self.height.to_be_bytes())?;
        w.put(&self.coded_width.to_be_bytes())?;
        w.put(&self.coded_height.to_be_bytes())?;
        w.put(&[u8::from(self.key)])?;
        w.codec(self.codec)?;
        w.part(self.description)?;
        w.part(self.thread_id.as_bytes())?;
        w.part(self.tab_id.unwrap_or("").as_bytes())?;
        w.finish()
    }
}
pub fn decode_audio<'a>(meta: &'a [u8], payload: &[u8]) -> Result<Audio<'a>, Error> {
    if meta.len() < 26 {
        return Err(Error::Short);
    }
    let mut r = Reader { bytes: meta, at: 0 };
    let sequence = r.f64()?;
    let timestamp = r.f64()?;
    let sample_rate = r.u32()?;
    let channels = r.u8()?;
    let codec = r.codec()?;
    let thread_id = text(r.part()?)?;
    let tab_id = tab(text(r.part()?)?);
    r.end()?;
    if !self::sequence(sequence)
        || !timestamp.is_finite()
        || !(8000..=192000).contains(&sample_rate)
        || !(1..=8).contains(&channels)
        || !self::codec(codec)
        || thread_id.is_empty()
        || !tab_valid(tab_id)
        || payload.is_empty()
    {
        return Err(Error::Invalid);
    }
    Ok(Audio {
        sequence,
        timestamp,
        sample_rate,
        channels,
        codec,
        thread_id,
        tab_id,
    })
}
impl Audio<'_> {
    pub fn encode(&self, out: &mut [u8]) -> Result<usize, Error> {
        let mut w = Writer { out, at: 0 };
        w.put(&self.sequence.to_be_bytes())?;
        w.put(&self.timestamp.to_be_bytes())?;
        w.put(&self.sample_rate.to_be_bytes())?;
        w.put(&[self.channels])?;
        w.codec(self.codec)?;
        w.part(self.thread_id.as_bytes())?;
        w.part(self.tab_id.unwrap_or("").as_bytes())?;
        w.finish()
    }
}
pub fn decode_picture<'a>(kind: u8, meta: &'a [u8], payload: &[u8]) -> Result<Picture<'a>, Error> {
    if meta.len() < 32 {
        return Err(Error::Short);
    }
    let mut r = Reader { bytes: meta, at: 0 };
    let sequence = r.f64()?;
    let timestamp = r.f64()?;
    let width = r.u16()?;
    let height = r.u16()?;
    let raw_scale = f32::from_be_bytes(r.array()?) as f64;
    let scale = significant_six(raw_scale);
    let rotation = r.u16()?;
    let flags = r.u8()?;
    let codec = r.codec()?;
    let source_id = text(r.part()?)?;
    let stream_id = text(r.part()?)?;
    r.end()?;
    let picture_codec = codec == "jpeg"
        || codec
            .strip_prefix("avc1.")
            .is_some_and(|s| s.len() == 6 && s.bytes().all(|b| b.is_ascii_hexdigit()));
    let source_valid = match kind {
        4 => device(source_id),
        5 => screen(source_id),
        _ => false,
    };
    if !self::sequence(sequence)
        || !timestamp.is_finite()
        || timestamp < 0.0
        || !(1..=8192).contains(&width)
        || !(1..=8192).contains(&height)
        || !scale.is_finite()
        || scale <= 0.0
        || scale > 64.0
        || ![0, 90, 180, 270].contains(&rotation)
        || !picture_codec
        || !source_valid
        || !screen(stream_id)
        || payload.is_empty()
    {
        return Err(Error::Invalid);
    }
    Ok(Picture {
        sequence,
        timestamp,
        width,
        height,
        scale,
        rotation,
        key: codec == "jpeg" || flags & 1 != 0,
        still: flags & 2 != 0,
        codec,
        source_id,
        stream_id,
    })
}
fn significant_six(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    let factor = 10_f64.powi(5 - value.abs().log10().floor() as i32);
    (value * factor).round() / factor
}
impl Picture<'_> {
    pub fn encode(&self, out: &mut [u8]) -> Result<usize, Error> {
        let mut w = Writer { out, at: 0 };
        w.put(&self.sequence.to_be_bytes())?;
        w.put(&self.timestamp.to_be_bytes())?;
        w.put(&self.width.to_be_bytes())?;
        w.put(&self.height.to_be_bytes())?;
        w.put(&(self.scale as f32).to_be_bytes())?;
        w.put(&self.rotation.to_be_bytes())?;
        w.put(&[u8::from(self.key) | (u8::from(self.still) << 1)])?;
        w.codec(self.codec)?;
        w.part(self.source_id.as_bytes())?;
        w.part(self.stream_id.as_bytes())?;
        w.finish()
    }
}
struct Writer<'a> {
    out: &'a mut [u8],
    at: usize,
}
impl Writer<'_> {
    fn put(&mut self, bytes: &[u8]) -> Result<(), Error> {
        let end = self.at.checked_add(bytes.len()).ok_or(Error::Space)?;
        self.out
            .get_mut(self.at..end)
            .ok_or(Error::Space)?
            .copy_from_slice(bytes);
        self.at = end;
        Ok(())
    }
    fn part(&mut self, bytes: &[u8]) -> Result<(), Error> {
        let len = u16::try_from(bytes.len()).map_err(|_| Error::Length)?;
        self.put(&len.to_be_bytes())?;
        self.put(bytes)
    }
    fn codec(&mut self, s: &str) -> Result<(), Error> {
        let len = u8::try_from(s.len()).map_err(|_| Error::Length)?;
        self.put(&[len])?;
        self.put(s.as_bytes())
    }
    fn finish(self) -> Result<usize, Error> {
        if self.at > u16::MAX as usize {
            Err(Error::Length)
        } else {
            Ok(self.at)
        }
    }
}
