import Foundation

/// Which of the page's audio chunks may play (ADR 0088 › Audio, ADR 0147: audio follows the
/// video's epochs). Pure; the renderer drives it on its queue, in order with its pictures.
///
/// Sound plays only for the current delivery, by the media socket it settled on. When the stream
/// starts over (a new subscribe, another tab, a resubscribe), nothing plays until the first
/// picture of the new stream decodes, and sound captured before that picture, or for a tab other
/// than the one it shows, is stale and dropped.
struct AudioGate {
    /// The settled delivery's media socket; nil while none is.
    private var path: String?
    /// The first picture's capture time since the stream started over; nil until one decoded.
    private var floor: Double?
    private var tabId: String?

    /// The delivery changed; `reset` when the stream starts over.
    mutating func delivery(path: String?, reset: Bool) {
        self.path = path
        if reset { self.reset() }
    }
    /// A picture captured at `timestamp` (stream ms) decoded, for `tabId`.
    mutating func shown(timestamp: Double, tabId: String?) {
        if floor == nil { floor = timestamp }
        if let tabId { self.tabId = tabId }
    }
    /// The stream starts over: wait for its first picture.
    mutating func reset() {
        floor = nil
        tabId = nil
    }
    func admits(_ chunk: BrowserAudioChunk, path: String) -> Bool {
        guard let current = self.path, current == path, let floor, chunk.timestamp >= floor else { return false }
        if let tabId, let tab = chunk.tabId, tab != tabId { return false }
        return true
    }
}

/// When to play each piece of the page's sound so it lines up with the video (ADR 0088 › Audio),
/// as web's `av-sync.ts` decides it. Pure: times are passed in, in ms. Everything is kept as
/// offsets, local time minus stream time.
///
/// Pictures show as soon as they decode; sound plays a little behind its quickest recent arrival
/// (a jitter buffer), or later to wait for pictures that run late, but at most `maxWait` beyond
/// its own buffer. The schedule holds while the target moves less than `resync`, so packets play
/// back to back; a larger move, or a packet that would start in the past, starts it again.
struct AudioPlayout {
    static let buffer = 60.0
    static let resync = 60.0
    static let maxWait = 500.0
    private var video: Double?
    private var arrival: Double?
    private var playout: Double?

    /// A picture captured at `timestamp` showed at local time `shownAt`.
    mutating func shown(timestamp: Double, at shownAt: Double) {
        let offset = shownAt - timestamp
        // Smoothed: one picture that decoded slowly doesn't move the sound.
        video = video.map { $0 + (offset - $0) * 0.1 } ?? offset
    }
    /// Sound captured at `timestamp`, `duration` long, decoded at local time `now`: the local time to
    /// start it, or nil when it is over already (drop it).
    mutating func schedule(timestamp: Double, duration: Double, now: Double) -> Double? {
        let arrived = now - timestamp
        // Rises at once with a late arrival; falls back slowly as arrivals speed up again.
        let quickest = arrival.map { max(arrived, $0 + (arrived - $0) * 0.02) } ?? arrived
        arrival = quickest
        let own = quickest + Self.buffer
        let target = video.map { max(own, min($0, own + Self.maxWait)) } ?? own
        if playout.map({ abs(target - $0) > Self.resync }) ?? true { playout = target }
        var at = timestamp + (playout ?? target)
        if at < now {
            playout = target
            at = timestamp + target
        }
        return at + duration <= now ? nil : max(at, now)
    }
    /// The stream starts over: forget every offset.
    mutating func reset() {
        video = nil
        arrival = nil
        playout = nil
    }
}
