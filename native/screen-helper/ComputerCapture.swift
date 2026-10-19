import AppKit
import ScreenCaptureKit

struct CUScreenshot {
    let jpeg: Data
    let width: Int
    let height: Int
    /// Image pixels per window point.
    let scale: Double
}

/// The image size models see without being resized again: about 1.15 megapixels and at most
/// 1568 pixels on the long edge, never larger than the window at 2x.
func cuScreenshotScale(points: CGSize, backing: Double) -> Double {
    guard points.width > 0, points.height > 0 else { return 1 }
    let byEdge = 1568 / max(points.width, points.height)
    let byArea = (1_150_000 / (points.width * points.height)).squareRoot()
    return max(0.1, min(backing, byEdge, byArea))
}

/// A display in global top-left coordinates with its backing scale.
struct CUDisplay: Equatable {
    let frame: CGRect
    let scale: Double
}

/// The backing scale of the display showing most of the window (the primary display's
/// when the window is on none, e.g. on another Space at a position no display covers).
func cuBackingScale(window: CGRect, displays: [CUDisplay]) -> Double {
    let best = displays.max { lhs, rhs in
        let a = lhs.frame.intersection(window), b = rhs.frame.intersection(window)
        return (a.isNull ? 0 : a.width * a.height) < (b.isNull ? 0 : b.width * b.height)
    }
    guard let best, !best.frame.intersection(window).isNull else { return displays.first?.scale ?? 2 }
    return best.scale
}

/// The Mac's displays, converted from AppKit's bottom-left coordinates to the top-left
/// coordinates accessibility frames use.
@MainActor func cuDisplays() -> [CUDisplay] {
    let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
    return NSScreen.screens.map { screen in
        let frame = screen.frame
        return CUDisplay(frame: CGRect(x: frame.minX, y: primaryHeight - frame.maxY, width: frame.width, height: frame.height), scale: Double(screen.backingScaleFactor))
    }
}

/// True for a frame with nothing drawn: fully transparent, or one flat colour with no
/// alpha (what ScreenCaptureKit returns for a window that is not being drawn).
func cuImageLooksBlank(_ image: CGImage) -> Bool {
    let side = 16
    guard let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let data = context.data else { return false }
    context.interpolationQuality = .low
    context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
    let pixels = data.bindMemory(to: UInt8.self, capacity: side * side * 4)
    var transparent = true, black = true
    for index in 0..<(side * side) {
        let red = pixels[index * 4], green = pixels[index * 4 + 1], blue = pixels[index * 4 + 2], alpha = pixels[index * 4 + 3]
        if alpha > 8 { transparent = false }
        if red > 8 || green > 8 || blue > 8 { black = false }
        if !transparent && !black { return false }
    }
    return true
}

/// Captures one window on any Space, even when covered, without its shadow. `frame` is the
/// window's AX frame in points. `marks` tags elements with their outline ids so the picture and
/// the outline line up.
@MainActor func cuCaptureWindow(_ number: CGWindowID, frame: CGRect, marks: (Double) -> [CUMark] = { _ in [] }) async throws -> CUScreenshot {
    guard CGPreflightScreenCaptureAccess() else {
        throw CUError("permission_screen_recording", "Screenshots need Screen Recording for \"Ace Screen Helper\" in System Settings > Privacy & Security. Ask the person to grant it; the outline still works without it.")
    }
    let scale = cuScreenshotScale(points: frame.size, backing: cuBackingScale(window: frame, displays: cuDisplays()))
    let width = max(1, Int((frame.width * scale).rounded())), height = max(1, Int((frame.height * scale).rounded()))
    let captured: CGImage
    if #available(macOS 14.0, *) {
        captured = try await cuCaptureWithScreenCaptureKit(number, width: width, height: height)
    } else {
        guard let last = cuLastFrame(number, width: width, height: height) else {
            throw CUError("capture_failed", "macOS would not capture this window. Use the outline instead.")
        }
        captured = last
    }
    let actualScale = Double(captured.width) / max(frame.width, 1)
    let image = cuDrawMarks(captured, marks: marks(actualScale))
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
        throw CUError("internal", "Could not encode the screenshot.")
    }
    return CUScreenshot(jpeg: jpeg, width: image.width, height: image.height, scale: actualScale)
}

/// ScreenCaptureKit first; the window server's last frame when it refuses the window or
/// returns a frame with nothing drawn (an undrawn window on another Space).
@available(macOS 14.0, *)
@MainActor private func cuCaptureWithScreenCaptureKit(_ number: CGWindowID, width: Int, height: Int) async throws -> CGImage {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == number }) else {
        throw CUError("window_gone", "The window closed or can't be captured. Observe the app again.")
    }
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    let filter = SCContentFilter(desktopIndependentWindow: window)
    do {
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        if cuImageLooksBlank(image), let last = cuLastFrame(number, width: width, height: height), !cuImageLooksBlank(last) { return last }
        return image
    } catch {
        guard let last = cuLastFrame(number, width: width, height: height) else { throw error }
        return last
    }
}

/// The window server's last frame of a window, resized. The API is deprecated, so it is
/// looked up at run time; nil when unavailable.
func cuLastFrame(_ number: CGWindowID, width: Int, height: Int) -> CGImage? {
    typealias Create = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
    // Only this window (including-window option 8), without its frame shadow (option 1).
    guard let full = unsafeBitCast(symbol, to: Create.self)(.null, 8, number, 1)?.takeRetainedValue(), full.width > 1,
          let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue) else { return nil }
    context.interpolationQuality = .high
    context.draw(full, in: CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()
}
