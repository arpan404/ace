import AppKit
import ScreenCaptureKit

/// Whole-display pictures for the `screen_display` tool, view only. `displays` lists the Mac's
/// displays and the apps with windows on screen. `capture_displays` then pictures the chosen
/// displays showing only windows of the apps the daemon allowed (`include`), so an app that
/// appears in between, or one computer use refuses, stays out of the picture.
@MainActor enum CUDisplays {
    struct Entry {
        let index: Int
        let id: CGDirectDisplayID
        let name: String
        /// In points; a rotated display reports its rotated size.
        let size: CGSize
        let scale: Double
    }

    /// Numbered in NSScreen order, so display 1 is the one with the menu bar.
    static func entries() -> [Entry] {
        NSScreen.screens.enumerated().compactMap { offset, screen in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            return Entry(index: offset + 1, id: CGDirectDisplayID(number.uint32Value), name: screen.localizedName,
                         size: screen.frame.size, scale: Double(screen.backingScaleFactor))
        }
    }

    static func row(_ entry: Entry) -> CUObject {
        var row: CUObject = ["index": entry.index, "name": entry.name, "width": Int(entry.size.width.rounded()), "height": Int(entry.size.height.rounded())]
        if CGDisplayIsMain(entry.id) != 0 { row["main"] = true }
        let rotation = Int(CGDisplayRotation(entry.id).rounded())
        if rotation != 0 { row["rotation"] = rotation }
        return row
    }

    private static func requireScreenRecording() throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw CUError("permission_screen_recording", "Display pictures need Screen Recording for \"Ace Screen Helper\" in System Settings > Privacy & Security > Screen Recording. Ask the person to turn it on, then try again.")
        }
    }

    private static func requireUnlocked() throws {
        guard !cuScreenLocked() else {
            throw CUError("screen_locked", "The Mac is locked, so its displays show only the lock screen. Try again once the person unlocks it.")
        }
    }

    static func list() async throws -> CUObject {
        try requireScreenRecording()
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        var seen = Set<String>()
        var apps: [CUObject] = []
        for window in content.windows {
            guard let app = window.owningApplication, seen.insert(app.bundleIdentifier).inserted else { continue }
            apps.append(["bundleId": app.bundleIdentifier, "name": app.applicationName])
        }
        return ["displays": entries().map(row), "apps": apps]
    }

    static func capture(_ request: CUObject) async throws -> CUObject {
        try requireUnlocked()
        try requireScreenRecording()
        guard #available(macOS 14.0, *) else {
            throw CUError("unsupported", "Display pictures need macOS 14 or later. Look at one app with screen_state instead.")
        }
        let wanted = Set((request["displays"] as? [NSNumber] ?? []).map(\.intValue))
        let include = Set(request.strings("include"))
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        var rows: [CUObject] = []
        for entry in entries() where wanted.contains(entry.index) {
            var row = row(entry)
            if let display = content.displays.first(where: { $0.displayID == entry.id }) {
                // Only windows already on screen, of allowed apps or of no app (system surfaces);
                // a filter by app came back black on macOS 27.
                let windows = content.windows.filter { window in window.owningApplication.map { include.contains($0.bundleIdentifier) } ?? true }
                do {
                    let shot = try await picture(display, size: entry.size, scale: entry.scale, windows: windows)
                    row["screenshot"] = ["jpeg": shot.jpeg.base64EncodedString(), "width": shot.width, "height": shot.height]
                } catch let fault as CUError {
                    row["screenshotError"] = fault.message
                } catch {
                    row["screenshotError"] = "macOS would not capture this display: \(error.localizedDescription)"
                }
            } else {
                row["screenshotError"] = "macOS would not capture this display."
            }
            rows.append(row)
        }
        // The session may lock while ScreenCaptureKit is capturing.
        try requireUnlocked()
        return ["displays": rows]
    }

    @available(macOS 14.0, *)
    private static func picture(_ display: SCDisplay, size: CGSize, scale backing: Double, windows: [SCWindow]) async throws -> CUScreenshot {
        let scale = cuScreenshotScale(points: size, backing: backing)
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int((size.width * scale).rounded()))
        configuration.height = max(1, Int((size.height * scale).rounded()))
        configuration.showsCursor = false
        let filter = SCContentFilter(display: display, including: windows)
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
            throw CUError("internal", "Could not encode the display picture.")
        }
        return CUScreenshot(jpeg: jpeg, width: image.width, height: image.height, scale: Double(image.width) / max(size.width, 1))
    }
}
