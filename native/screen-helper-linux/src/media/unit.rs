//! One encoded unit as the daemon's socket carries it (the legacy route): the v2 frame header,
//! with the v1 names the daemon's recordings still read, then the Annex B bytes. The unit
//! itself and its MediaFrame for ace-media are `media_ingest`'s. Pure.
use media_ingest::VideoUnit;
use serde_json::json;

pub fn legacy_packet(
    unit: &VideoUnit,
    session: &str,
    generation: Option<u64>,
) -> crate::protocol::Result<Vec<u8>> {
    let mut header = json!({
        "version": 2, "sessionId": session,
        "sequence": unit.sequence, "seq": unit.sequence,
        "timestamp": unit.timestamp_ms, "ts": unit.timestamp_ms,
        "width": unit.width, "height": unit.height, "scale": unit.scale,
        "codec": "h264", "keyframe": unit.key, "bytes": unit.payload.len(),
    });
    if let Some(codec) = &unit.codec {
        header["videoCodec"] = json!(codec);
    }
    if let Some(generation) = generation {
        header["captureGeneration"] = json!(generation);
    }
    crate::protocol::packet(&header, &unit.payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_legacy_packet_is_the_header_the_daemon_reads_then_the_bytes() {
        let unit = VideoUnit {
            sequence: 41,
            timestamp_ms: 1_700_000_000_123.5,
            scale: 1.5,
            width: 1920,
            height: 1080,
            key: true,
            codec: Some("avc1.640028".into()),
            epoch: 7,
            captured_us: 1_000,
            payload: vec![0, 0, 0, 1, 0x65, 1, 2, 3],
        };
        let packet = legacy_packet(&unit, "s1", Some(3)).unwrap();
        let length = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&packet[4..4 + length]).unwrap();
        assert_eq!(header["codec"], "h264");
        assert_eq!(
            (header["seq"].clone(), header["sequence"].clone()),
            (41.into(), 41.into())
        );
        assert_eq!(header["keyframe"], true);
        assert_eq!(header["videoCodec"], "avc1.640028");
        assert_eq!(header["captureGeneration"], 3);
        assert_eq!(&packet[4 + length..], unit.payload.as_slice());
    }
}
