import CoreVideo
import CoreGraphics

/// Fixed-size samples avoid scanning or retaining full-resolution capture buffers.
struct MeasurementPixels {
    let width: Int
    let height: Int
    let rgb: [UInt8]
    static func sample(_ image: CVPixelBuffer) -> Self? {
        guard CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(image) else { return nil }
        let sourceWidth = CVPixelBufferGetWidth(image), sourceHeight = CVPixelBufferGetHeight(image)
        let width = min(96, sourceWidth), height = min(64, sourceHeight)
        guard width > 0, height > 0 else { return nil }
        let stride = CVPixelBufferGetBytesPerRow(image)
        var rgb = [UInt8](repeating: 0, count: width * height * 3)
        for y in 0..<height {
            let row = base.advanced(by: y * sourceHeight / height * stride).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                let offset = x * sourceWidth / width * 4, destination = (y * width + x) * 3
                for channel in 0..<3 { rgb[destination + channel] = row[offset + channel] }
            }
        }
        return Self(width: width, height: height, rgb: rgb)
    }
    func difference(from previous: Self) -> CGRect? {
        guard width == previous.width, height == previous.height else { return CGRect(x: 0, y: 0, width: 1, height: 1) }
        var changed = CGRect.null
        for y in 0..<height {
            for x in 0..<width {
                let offset = (y * width + x) * 3
                if (0..<3).contains(where: { abs(Int(rgb[offset + $0]) - Int(previous.rgb[offset + $0])) > 8 }) {
                    changed = changed.union(CGRect(x: x, y: y, width: 1, height: 1))
                }
            }
        }
        guard !changed.isNull else { return nil }
        return CGRect(x: changed.minX / Double(width), y: changed.minY / Double(height), width: changed.width / Double(width), height: changed.height / Double(height))
    }
    func changed(near point: CGPoint, from previous: Self) -> Bool {
        guard width == previous.width, height == previous.height else { return true }
        let radius = 0.12
        for y in 0..<height where abs(Double(y) / Double(height) - point.y) <= radius {
            for x in 0..<width where abs(Double(x) / Double(width) - point.x) <= radius {
                let offset = (y * width + x) * 3
                if (0..<3).contains(where: { abs(Int(rgb[offset + $0]) - Int(previous.rgb[offset + $0])) > 8 }) { return true }
            }
        }
        return false
    }
}

struct MeasurementCandidate {
    let atMs: Double
    let image: CGImage
    let damage: CGRect?
    var hitch = false
}

/// Retain the endpoints of three worst active gaps plus representative animation frames.
struct MeasurementCandidates {
    private(set) var before: MeasurementCandidate?
    private(set) var first: MeasurementCandidate?
    private(set) var last: MeasurementCandidate?
    private var representative: [MeasurementCandidate] = []
    private var gaps: [(duration: Double, before: MeasurementCandidate, after: MeasurementCandidate)] = []
    mutating func receive(_ frame: MeasurementCandidate, intervalMs: Double, windowMs: Double) {
        defer { last = frame }
        guard let previous = last else { before = frame; return }
        if first == nil { first = frame; return }
        if representative.count < 6 && (representative.last.map { frame.atMs - $0.atMs >= windowMs / 6 } ?? true) { representative.append(frame) }
        let gap = frame.atMs - previous.atMs
        if gap > intervalMs * 1.5, gap < 250 {
            var left = previous, right = frame; left.hitch = true; right.hitch = true
            gaps.append((gap, left, right)); gaps.sort { $0.duration > $1.duration }
            if gaps.count > 3 { gaps.removeLast() }
        }
    }
    func selected() -> [MeasurementCandidate] {
        var frames = [before, first, last].compactMap { $0 } + gaps.prefix(2).flatMap { [$0.before, $0.after] }
        for frame in representative where frames.count < 8 { frames.append(frame) }
        var unique: [MeasurementCandidate] = []
        for frame in frames.sorted(by: { $0.atMs < $1.atMs }) where !unique.contains(where: { $0.atMs == frame.atMs }) { unique.append(frame) }
        return Array(unique.prefix(8))
    }
}
