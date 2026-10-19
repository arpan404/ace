import Foundation

/// What a decoder is configured from: a keyframe's codec, coded size and description.
struct VideoDecoderConfig: Equatable, Sendable {
    let codec: String
    let codedWidth: Int
    let codedHeight: Int
    let description: Data?
}

/// Which chunks of a thread's video reach the decoder (ADR 0088), as a pure state machine the
/// renderer drives. A keyframe configures the decoder (again, when its codec, size or description
/// changed); deltas before a keyframe can't be decoded, so they are skipped and acknowledged at
/// once. A decode error forgets the decoder and asks the daemon for a keyframe, acknowledging
/// the newest chunk seen, so the daemon's window frees and the next keyframe starts again.
struct VideoChunkGate {
    enum Step: Equatable {
        /// Decode this chunk, first (re)configuring the decoder when `configure` is set.
        case decode(configure: VideoDecoderConfig?)
        /// Nothing to decode it against: acknowledge it and wait for a keyframe.
        case skip
    }
    private(set) var config: VideoDecoderConfig?
    /// The newest sequence seen since the last reset; -1 for none.
    private(set) var latest = -1

    mutating func admit(_ chunk: BrowserVideoChunk) -> Step {
        latest = max(latest, chunk.sequence)
        if chunk.key {
            let next = VideoDecoderConfig(codec: chunk.codec, codedWidth: chunk.codedWidth,
                                          codedHeight: chunk.codedHeight, description: chunk.description)
            if next == config { return .decode(configure: nil) }
            config = next
            return .decode(configure: next)
        }
        return config == nil ? .skip : .decode(configure: nil)
    }
    /// The decoder failed: the sequence to acknowledge with a keyframe request, if any was seen.
    mutating func failed() -> Int? {
        let newest = latest
        reset()
        latest = newest
        return newest >= 0 ? newest : nil
    }
    /// Forget the decoder's place (a new subscription, a tab switch, a JPEG frame): wait for a keyframe.
    mutating func reset() {
        config = nil
        latest = -1
    }
}
