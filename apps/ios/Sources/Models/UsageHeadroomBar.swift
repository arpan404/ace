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
