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
    var hash: UInt64 = 14695981039346656037
    func rows(_ base: UnsafeMutableRawPointer, stride: Int, bytes: Int, height: Int) {
        for y in 0..<height {
            let row = UnsafeRawBufferPointer(start: base.advanced(by: y * stride), count: bytes)
            var x = 0
            while x + 8 <= bytes { hash = (hash ^ row.loadUnaligned(fromByteOffset: x, as: UInt64.self)) &* 1099511628211; x += 8 }
            while x < bytes { hash = (hash ^ UInt64(row[x])) &* 1099511628211; x += 1 }
        }
    }
    if CVPixelBufferIsPlanar(image) {
        // NV12 while streaming video: luma, then the interleaved chroma plane.
        for plane in 0..<CVPixelBufferGetPlaneCount(image) {
            guard let base = CVPixelBufferGetBaseAddressOfPlane(image, plane) else { return nil }
            rows(base, stride: CVPixelBufferGetBytesPerRowOfPlane(image, plane), bytes: CVPixelBufferGetWidthOfPlane(image, plane) * (plane == 0 ? 1 : 2), height: CVPixelBufferGetHeightOfPlane(image, plane))
        }
        return hash
    }
    guard let base = CVPixelBufferGetBaseAddress(image) else { return nil }
    rows(base, stride: CVPixelBufferGetBytesPerRow(image), bytes: CVPixelBufferGetWidth(image) * 4, height: CVPixelBufferGetHeight(image))
    return hash
}
