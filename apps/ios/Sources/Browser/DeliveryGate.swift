import Foundation

/// A source's current delivery as the shared script last set it (`media.delivery`, ADR 0147 §4):
/// the generation of its latest subscribe and the way its pictures come, `"channel"` or a media
/// socket's id, or nil while that subscribe's reply is pending. Swift decides nothing about it.
struct MediaDelivery: Equatable, Sendable {
    let generation: Int
    let path: String?
    static let channel = "channel"
}

/// Which live view a delivery is for, and its source there (a thread, a screen session, a device).
struct DeliveryKey: Hashable, Sendable {
    let view: String
    let source: String
}

/// What the gate needs of a picture.
protocol GatedPicture {
    var key: Bool { get }
    var byteCount: Int { get }
}
extension DeviceFrameChunk: GatedPicture { var byteCount: Int { bytes.count } }
extension BrowserVideoChunk: GatedPicture { var byteCount: Int { bytes.count } }

/// One source's pictures held to its current delivery. A picture that comes the current way is
/// shown with the generation it came for; one that comes another way is dropped. While the reply
/// is pending, each way keeps its newest keyframe and the deltas after it, at most 4 MB or 2 s of
/// arrivals; the way the reply settles on is released, the rest dropped. Before the script has set
/// any delivery, pictures pass unstamped, as they did before generations. Pure.
struct DeliveryGate<Picture: GatedPicture> {
    enum Arrival { case show(generation: Int?), hold, drop }
    /// What a new delivery does: start the decoder over, show what was held, ask for a keyframe.
    struct Change {
        var reset = false
        var released: [Picture] = []
        /// Past the bounds while pending: a fresh keyframe is due, asked in this picture's name.
        var keyframe: Picture?
    }
    static var limits: (bytes: Int, seconds: TimeInterval) { (4 * 1024 * 1024, 2) }

    private struct Way {
        var pictures: [Picture] = []
        var bytes = 0
        var first: TimeInterval = 0
        var overflowed = false
        var ask: Picture?
    }
    private(set) var delivery: MediaDelivery?
    private var ways: [String: Way] = [:]

    mutating func arrive(_ picture: Picture, path: String, at now: TimeInterval) -> Arrival {
        guard let delivery else { return .show(generation: nil) }
        guard let current = delivery.path else {
            hold(picture, path: path, at: now)
            return .hold
        }
        return current == path ? .show(generation: delivery.generation) : .drop
    }

    mutating func set(_ next: MediaDelivery) -> Change {
        let previous = delivery
        delivery = next
        // A new subscribe: everything of the old one is stale, held or decoding.
        guard let previous, previous.generation == next.generation else {
            ways.removeAll()
            return Change(reset: previous != nil)
        }
        guard previous.path != next.path, let settled = next.path else { return Change() }
        // The pending subscribe settled: the way it named is released, the others dropped.
        guard previous.path == nil else {
            // Settled once, then another way (a late reply after a timeout): start over on it.
            ways.removeAll()
            return Change(reset: true)
        }
        let way = ways[settled]
        ways.removeAll()
        guard let way else { return Change() }
        return Change(released: way.pictures, keyframe: way.overflowed ? way.ask : nil)
    }

    private mutating func hold(_ picture: Picture, path: String, at now: TimeInterval) {
        let limits = Self.limits
        if picture.key {
            // Too large to hold: only a fresh keyframe can follow it.
            ways[path] = picture.byteCount > limits.bytes
                ? Way(first: now, overflowed: true, ask: picture)
                : Way(pictures: [picture], bytes: picture.byteCount, first: now)
            return
        }
        // A delta with no keyframe before it can't be shown; past the bounds, the gap stays open.
        guard var way = ways[path], !way.overflowed, let first = way.pictures.first else { return }
        let bytes = way.bytes + picture.byteCount
        if bytes > limits.bytes || now - way.first > limits.seconds {
            way.pictures = [first]
            way.bytes = first.byteCount
            way.overflowed = true
            way.ask = first
        } else {
            way.pictures.append(picture)
            way.bytes = bytes
        }
        ways[path] = way
    }
}
