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

/// Captures one window on any Space, even when covered, without its shadow.
/// `marks` tags elements with their outline ids so the picture and the outline line up.
@MainActor func cuCaptureWindow(_ number: CGWindowID, marks: (Double) -> [CUMark] = { _ in [] }) async throws -> CUScreenshot {
    guard CGPreflightScreenCaptureAccess() else {
        throw CUError("permission_screen_recording", "Screenshots need Screen Recording for \"Ace Screen Helper\" in System Settings > Privacy & Security. Ask the person to grant it; the outline still works without it.")
    }
    guard #available(macOS 14.0, *) else { throw CUError("not_supported", "Screenshots need macOS 14 or later.") }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == number }) else {
        throw CUError("window_gone", "The window closed or can't be captured. Observe the app again.")
    }
    let backing = NSScreen.screens.map { Double($0.backingScaleFactor) }.max() ?? 2
    let scale = cuScreenshotScale(points: window.frame.size, backing: backing)
    let configuration = SCStreamConfiguration()
    configuration.width = max(1, Int((window.frame.width * scale).rounded()))
    configuration.height = max(1, Int((window.frame.height * scale).rounded()))
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let captured: CGImage
    do { captured = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) }
    catch {
        // ScreenCaptureKit refuses some windows that are not being drawn (browsers on another
        // Space); the window server still holds their last frame.
        guard let last = cuLastFrame(number, width: configuration.width, height: configuration.height) else { throw error }
        captured = last
    }
    let actualScale = Double(captured.width) / window.frame.width
    let image = cuDrawMarks(captured, marks: marks(actualScale))
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
        throw CUError("internal", "Could not encode the screenshot.")
    }
    return CUScreenshot(jpeg: jpeg, width: image.width, height: image.height, scale: actualScale)
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
