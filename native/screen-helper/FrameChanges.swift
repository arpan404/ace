import CoreVideo
import CoreGraphics

/** Pure damage decision. A missing platform signal uses one bounded fingerprint. */
public struct FrameChanges {
    private var previous: UInt64?
    public init() {}
    public mutating func changed(initial: Bool, dirtyRects: [CGRect]?, fingerprint: () -> UInt64?) -> Bool {
        if let dirtyRects { previous = nil; return initial || !dirtyRects.isEmpty }
        let current = fingerprint()
        defer { previous = current }
        return initial || current == nil || current != previous
    }
}

// Fallback only: hash the BGRA words in-place without copying a frame or retaining tiles.
func pixelFingerprint(_ image: CVPixelBuffer) -> UInt64? {
    guard CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(image) else { return nil }
    let stride = CVPixelBufferGetBytesPerRow(image), bytes = CVPixelBufferGetWidth(image) * 4
    var hash: UInt64 = 14695981039346656037
    for y in 0..<CVPixelBufferGetHeight(image) {
        let row = UnsafeRawBufferPointer(start: base.advanced(by: y * stride), count: bytes)
        var x = 0
        while x + 8 <= bytes { hash = (hash ^ row.loadUnaligned(fromByteOffset: x, as: UInt64.self)) &* 1099511628211; x += 8 }
        while x < bytes { hash = (hash ^ UInt64(row[x])) &* 1099511628211; x += 1 }
    }
    return hash
}
