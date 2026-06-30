use ace_runtime::threads::{RealtimeAudioRecord, RealtimeTranscriptRecord};

const DESKTOP_REALTIME_TRANSCRIPT_LIMIT: usize = 128 * 1024;
const DESKTOP_REALTIME_AUDIO_CHUNK_LIMIT: usize = 1024;

pub(super) fn trim_realtime_transcript(record: &mut RealtimeTranscriptRecord) {
    if record.text.len() <= DESKTOP_REALTIME_TRANSCRIPT_LIMIT {
        return;
    }
    let overflow = record.text.len() - DESKTOP_REALTIME_TRANSCRIPT_LIMIT;
    let mut start = overflow;
    while !record.text.is_char_boundary(start) {
        start += 1;
    }
    record.text.drain(..start);
    record.truncated_bytes = record.truncated_bytes.saturating_add(start);
}

pub(super) fn trim_realtime_audio(record: &mut RealtimeAudioRecord) {
    if record.chunks.len() <= DESKTOP_REALTIME_AUDIO_CHUNK_LIMIT {
        return;
    }
    let overflow = record.chunks.len() - DESKTOP_REALTIME_AUDIO_CHUNK_LIMIT;
    record.chunks.drain(0..overflow);
    record.truncated_chunks = record.truncated_chunks.saturating_add(overflow);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_trim_preserves_utf8_boundary_and_tracks_bytes() {
        let prefix = "é".repeat(8);
        let suffix = "a".repeat(DESKTOP_REALTIME_TRANSCRIPT_LIMIT);
        let mut record = RealtimeTranscriptRecord {
            provider: "codex".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            text: format!("{prefix}{suffix}"),
            truncated_bytes: 5,
        };

        trim_realtime_transcript(&mut record);

        assert!(record.text.is_char_boundary(0));
        assert!(record.text.starts_with('é') || record.text.starts_with('a'));
        assert!(record.text.len() <= DESKTOP_REALTIME_TRANSCRIPT_LIMIT);
        assert!(record.truncated_bytes > 5);
    }

    #[test]
    fn audio_trim_keeps_latest_chunks_and_tracks_dropped_count() {
        let mut record = RealtimeAudioRecord {
            provider: "codex".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            chunks: (0..(DESKTOP_REALTIME_AUDIO_CHUNK_LIMIT + 3))
                .map(|index| format!("chunk-{index}"))
                .collect(),
            truncated_chunks: 7,
        };

        trim_realtime_audio(&mut record);

        assert_eq!(record.chunks.len(), DESKTOP_REALTIME_AUDIO_CHUNK_LIMIT);
        assert_eq!(record.chunks.first().map(String::as_str), Some("chunk-3"));
        assert_eq!(record.truncated_chunks, 10);
    }
}
