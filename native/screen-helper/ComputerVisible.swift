import CoreGraphics

/// Where an element sits relative to what its window or scroll area shows.
enum CUVisibility: Equatable {
    case visible
    case above
    case below
    /// Beside the visible area (scrolled sideways, or outside the window).
    case beside
}

/// Elements without a frame, or with an empty one, are never clipped: they may still hold
/// visible children.
func cuVisibility(of frame: CGRect?, in visible: CGRect) -> CUVisibility {
    guard let frame, frame.width > 0, frame.height > 0, !visible.isNull, visible.width > 0, visible.height > 0 else { return .visible }
    if frame.maxY <= visible.minY + 1 { return .above }
    if frame.minY >= visible.maxY - 1 { return .below }
    if frame.maxX <= visible.minX + 1 || frame.minX >= visible.maxX - 1 { return .beside }
    return .visible
}

/// The slice of a long, top-to-bottom list that shows in `visible`, found with a binary search
/// so a 10,000-row list costs a few frame reads instead of 10,000. Nil when frames can't be read
/// (the caller then falls back to the start of the list). At most `limit` items.
func cuVisibleRange(count: Int, visible: CGRect, limit: Int, frameAt: (Int) -> CGRect?) -> Range<Int>? {
    guard count > 0 else { return 0..<0 }
    var low = 0, high = count
    while low < high {
        let middle = (low + high) / 2
        guard let frame = frameAt(middle) else { return nil }
        if frame.maxY <= visible.minY + 1 { low = middle + 1 } else { high = middle }
    }
    var end = low
    while end < count, end - low < limit {
        guard let frame = frameAt(end) else { break }
        if frame.minY >= visible.maxY - 1 { break }
        end += 1
    }
    return low..<end
}

/// One line telling the model there is more to scroll to, or nil when nothing was hidden.
func cuScrolledOutSummary(above: Int, below: Int) -> String? {
    switch (above, below) {
    case (0, 0): return nil
    case (_, 0): return "\(above) more item\(above == 1 ? "" : "s") above, scrolled out of view"
    case (0, _): return "\(below) more item\(below == 1 ? "" : "s") below, scrolled out of view"
    default: return "\(above) more items above and \(below) below, scrolled out of view"
    }
}

/// The geometry of the latest screenshot of a window: which window, its size in points and
/// image pixels per point. Pixel coordinates are only meaningful against this.
struct CUShotGeometry: Equatable {
    let window: UInt32
    let size: CGSize
    let scale: Double
}

/// Maps screenshot pixels to a global screen point in the window's current frame. The window
/// may have moved since the screenshot (the frame is current), but if another window is
/// chosen or this one was resized, the pixels no longer describe it.
func cuMapPixel(_ pixel: CGPoint, shot: CUShotGeometry?, window: UInt32?, frame: CGRect) throws -> CGPoint {
    guard let shot, let window, shot.window == window, shot.scale > 0,
          abs(shot.size.width - frame.width) <= 1, abs(shot.size.height - frame.height) <= 1 else {
        throw CUError("no_screenshot", "Take a new screenshot of this window first; coordinates are pixels of the latest screenshot.")
    }
    let point = CGPoint(x: frame.minX + pixel.x / shot.scale, y: frame.minY + pixel.y / shot.scale)
    guard pixel.x >= 0, pixel.y >= 0, frame.contains(point) else {
        throw CUError("outside_window", "(\(Int(pixel.x)), \(Int(pixel.y))) is outside the screenshot (\(Int(frame.width * shot.scale))×\(Int(frame.height * shot.scale))).")
    }
    return point
}

/// Long values are cut with a marker saying how long they really are.
func cuClipValue(_ text: String, limit: Int) -> String {
    let count = text.count
    guard count > limit else { return text }
    return String(text.prefix(limit)) + "…(\(count) chars)"
}
