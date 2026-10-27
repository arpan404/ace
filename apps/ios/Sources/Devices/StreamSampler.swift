import Foundation

/// What a live device stream did, counted natively while its stats show: each picture as it
/// arrives (on the decoding queue) and as it is drawn (on the display link), and each keyframe
/// the decoder asked for. About once a second the screen drains a batch for the bridge, which
/// words it as the web does (`bridge/device-stats.ts`). Off, it counts nothing; bounded either way.
final class StreamSampler: @unchecked Sendable {
    struct Batch: Sendable {
        let drawn: [[Double]]
        let received: [[Double]]
        let keyframes: [Double]
    }
    /// At most this many of each between drains (ten seconds at 60 fps).
    static let limit = 600
    private let lock = NSLock()
    private var on = false
    private var drawn: [[Double]] = []
    private var received: [[Double]] = []
    private var keyframes: [Double] = []
    private let now: @Sendable () -> Double

    init(now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) { self.now = now }

    var enabled: Bool {
        get { lock.withLock { on } }
        set { lock.withLock { on = newValue; if !newValue { drawn = []; received = []; keyframes = [] } } }
    }
    func arrived(bytes: Int) {
        let at = now()
        lock.withLock { if on, received.count < Self.limit { received.append([at, Double(bytes)]) } }
    }
    /// A picture captured at `captured` (the daemon's clock) reached the screen now.
    func shown(captured: Double) {
        let at = now()
        lock.withLock { if on, drawn.count < Self.limit { drawn.append([captured, at]) } }
    }
    func keyframeAsked() {
        let at = now()
        lock.withLock { if on, keyframes.count < Self.limit { keyframes.append(at) } }
    }
    /// What happened since the last drain, and the time it was taken.
    func drain() -> (batch: Batch, now: Double) {
        let at = now()
        return lock.withLock {
            defer { drawn = []; received = []; keyframes = [] }
            return (Batch(drawn: drawn, received: received, keyframes: keyframes), at)
        }
    }
}
