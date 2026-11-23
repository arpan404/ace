import CoreGraphics

/// A bar from the shared usage rail. Its height is in percentage points.
struct UsageHeadroomBar: Decodable, Equatable, Sendable {
    enum Tone: String, Decodable, Sendable { case ok, low, out }

    let key: String
    let label: String
    let left: Double
    let tone: Tone
    let span: String

    var spoken: String {
        switch tone {
        case .ok: "\(label) \(Int(left.rounded()))% left for the \(span)"
        case .low: "\(label) low, \(Int(left.rounded()))% left for the \(span)"
        case .out: "\(label) out for the \(span)"
        }
    }
}

/// Geometry in the web rail's 20-point coordinate space.
enum UsageBarGeometry {
    static let width: CGFloat = 3
    static let gap: CGFloat = 2
    static let top: CGFloat = 2
    static let trackHeight: CGFloat = 16

    static func tracks(_ bars: [UsageHeadroomBar]) -> [(track: CGRect, fill: CGRect?)] {
        let count = bars.isEmpty ? 3 : bars.count
        let start = (20 - CGFloat(count) * width - CGFloat(count - 1) * gap) / 2
        return (0..<count).map { index in
            let track = CGRect(x: start + CGFloat(index) * (width + gap),
                               y: top, width: width, height: trackHeight)
            guard !bars.isEmpty else { return (track, nil) }
            let bar = bars[index]
            let height = max(bar.tone == .out ? 2 : width, trackHeight * min(100, CGFloat(bar.left)) / 100)
            return (track, CGRect(x: track.minX, y: track.maxY - height, width: width, height: height))
        }
    }
}

/// An account the person can put in the Usage glyph, or leave out: the shared rail's choice.
struct UsageChoice: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let left: Double
    let tone: UsageHeadroomBar.Tone
    let span: String
    let shown: Bool

    /// "Claude Code · Personal, 59% left for the session", and "low" or "out" when they are.
    var spoken: String {
        UsageHeadroomBar(key: id, label: label, left: left, tone: tone, span: span).spoken
    }
}

/// The accounts the Usage glyph draws on this phone, by account id, in order, kept for each
/// machine (an account id is its machine's). The same choice as the web's rail pins, which is
/// also a setting of the device it's made on. Empty means the default: the accounts used most.
enum UsagePins {
    /// The glyph's room.
    static let limit = 4
    static func key(_ hostId: String) -> String { "ace.usage.railPins.\(hostId)" }

    static func read(_ hostId: String, in defaults: UserDefaults = .standard) -> [String] {
        defaults.stringArray(forKey: key(hostId)) ?? []
    }

    static func write(_ ids: [String], _ hostId: String, in defaults: UserDefaults = .standard) {
        if ids.isEmpty { defaults.removeObject(forKey: key(hostId)) } else { defaults.set(Array(ids.prefix(limit)), forKey: key(hostId)) }
    }
}
