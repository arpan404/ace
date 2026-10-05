import Foundation
import ScreenCaptureKit
import CoreImage
import AppKit

final class CaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let writer: FrameWriter
    let sessionId: String
    let queue = DispatchQueue(label: "ace.screen.capture")
    func drain() async { await withCheckedContinuation { continuation in queue.async { continuation.resume() } } }
    private lazy var encoder = JPEGEncoder(context: CIContext(options: [.cacheIntermediates: false]))
    private var sequence: UInt64 = 0
    private let lock = NSLock()
    private var initial = true
    private var changes = FrameChanges()
    private var encodeNanos: UInt64 = 0
    var metrics: [String: Any] { lock.lock(); defer { lock.unlock() }; return ["encodedFrames": sequence, "encodeNanos": encodeNanos] }
    func markInitial() { lock.lock(); initial = true; lock.unlock() }
    private let version: Int
    private let scale: Double
    var nextSequence: UInt64 { lock.lock(); defer { lock.unlock() }; return sequence }
    /// Called (at most twice a second) when the window no longer fills the frame: it was resized
    /// or, for a Simulator, rotated. The capture is then reconfigured to the new size.
    var onResize: (() -> Void)?
    private var lastResize: UInt64 = 0
    init(writer: FrameWriter, sessionId: String, version: Int, scale: Double) { self.writer = writer; self.sessionId = sessionId; self.version = version; self.scale = scale }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let image = sample.imageBuffer else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue else { return }
        let info = attachments.first ?? [:]
        let damage = (info[.dirtyRects] as? [CGRect]) ?? (info[.dirtyRects] as? [NSValue])?.map { $0.rectValue }
        let density = (info[.scaleFactor] as? NSNumber)?.doubleValue
        let contentScale = (info[.contentScale] as? NSNumber)?.doubleValue
        let measured = density.flatMap { density in contentScale.map { density * $0 } }
        let content = (info[.contentRect] as CFTypeRef?).flatMap { CFGetTypeID($0) == CFDictionaryGetTypeID() ? CGRect(dictionaryRepresentation: $0 as! CFDictionary) : nil }
        let fitted = (contentScale.map { abs($0 - 1) < 0.02 } ?? true) && (content.map { rect in
            let points = Double(CVPixelBufferGetWidth(image)) / (density ?? 1), height = Double(CVPixelBufferGetHeight(image)) / (density ?? 1)
            return rect.width >= points - 2 && rect.height >= height - 2
        } ?? true)
        if !fitted {
            let now = DispatchTime.now().uptimeNanoseconds
            if now - lastResize > 500_000_000 { lastResize = now; onResize?() }
        }
        let currentScale = measured.flatMap { $0.isFinite && $0 > 0 && $0 <= 8 ? $0 : nil } ?? scale
        let seq = nextSequence
        lock.lock(); let first = initial; lock.unlock()
        var nextChanges = changes
        guard nextChanges.changed(initial: first, dirtyRects: damage, fingerprint: { pixelFingerprint(image) }) else { return }
        let started = DispatchTime.now().uptimeNanoseconds
        guard let packet = encoder.packet(image: image, sessionId: sessionId, sequence: seq, timestamp: Date().timeIntervalSince1970 * 1000, version: version, scale: currentScale, dirtyRects: damage) else { return }
        changes = nextChanges
        lock.lock(); sequence += 1; initial = false; encodeNanos += DispatchTime.now().uptimeNanoseconds - started; lock.unlock()
        writer.publish(packet)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { exit(1) }
}

/// The capturable displays, applications and listed windows at one moment.
struct ShareableContent {
    let displays: [SCDisplay]
    let applications: [SCRunningApplication]
    let windows: [SCWindow]
}

@MainActor final class Capture {
    private var stream: SCStream?
    private var output: CaptureOutput?
    private var configuration: (filter: SCContentFilter, config: SCStreamConfiguration)?
    private var capturing = false
    private var cachedContent: (at: UInt64, content: ShareableContent)?
    private(set) var target: Target?
    private(set) var allowed = Set<String>()
    private(set) var frame = CGRect.zero
    private(set) var width = 0
    private(set) var height = 0
    let writer: FrameWriter
    init(writer: FrameWriter) { self.writer = writer }
    var metrics: [String: Any] { var result = resourceMetrics(); result.merge(output?.metrics ?? ["encodedFrames": 0, "encodeNanos": 0]) { _, new in new }; return result }
    func content() async throws -> ShareableContent {
        guard CGPreflightScreenCaptureAccess() else { throw HelperError("Screen Recording permission denied", code: "permission_denied") }
        let now = DispatchTime.now().uptimeNanoseconds
        if let cachedContent, now - cachedContent.at < 250_000_000 { return cachedContent.content }
        // Windows on another Space (a full-screen ace, say) are off screen but still capturable.
        let result = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let content = ShareableContent(displays: result.displays, applications: result.applications, windows: result.windows)
        cachedContent = (now, content); return content
    }
    /// Pixels per point of the display showing `frame`, from its display mode (NSScreen may list
    /// no screens while the display sleeps).
    nonisolated static func pixelDensity(of frame: CGRect, on displays: [SCDisplay]) -> Double {
        let display = displays.first { $0.frame.contains(CGPoint(x: frame.midX, y: frame.midY)) } ?? displays.first
        guard let id = display?.displayID, let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 else { return 1 }
        return max(1, Double(mode.pixelWidth) / Double(mode.width))
    }
    /// Windows worth offering as targets: on screen, or ordinary titled windows on another Space
    /// (not the many hidden utility windows apps keep).
    nonisolated static func listed(_ window: SCWindow) -> Bool {
        window.isOnScreen || (window.windowLayer == 0 && !(window.title ?? "").isEmpty && window.frame.width >= 2 && window.frame.height >= 2)
    }
    func start(_ request: Request) async throws {
        guard target == nil, let target = request.target, let session = request.sessionId,
              session.count <= 64, let approvals = request.allowlist, approvals.count <= 64,
              let fps = request.fps, (1...30).contains(fps) else { throw HelperError("Invalid capture request", code: "bounds") }
        allowed = Set(approvals)
        let content = try await content()
        let filter: SCContentFilter
        if target.kind == "window" {
            guard let bundle = target.bundleId, allowed.contains(bundle) else { throw HelperError("Window is not approved", code: "permission_denied") }
            guard let window = content.windows.first(where: { $0.windowID == target.windowId && $0.owningApplication?.bundleIdentifier == bundle }) else { throw HelperError("Window is not approved or available", code: "target_gone") }
            filter = SCContentFilter(desktopIndependentWindow: window); frame = window.frame
        } else {
            guard let display = content.displays.first(where: { $0.displayID == target.displayId }) else { throw HelperError("Display unavailable", code: "target_gone") }
            let bundles = target.kind == "app" ? [target.bundleId].compactMap { $0 } : target.bundleIds ?? []
            guard ["display", "app"].contains(target.kind), !bundles.isEmpty, bundles.allSatisfy({ allowed.contains($0) }) else { throw HelperError("Application approval required", code: "permission_denied") }
            let apps = content.applications.filter { bundles.contains($0.bundleIdentifier) }
            guard !apps.isEmpty else { throw HelperError("Approved applications unavailable", code: "target_gone") }
            filter = SCContentFilter(display: display, including: apps, exceptingWindows: []); frame = display.frame
        }
        guard frame.width > 0, frame.height > 0 else { throw HelperError("Empty capture target", code: "bounds") }
        // A window is captured at the screen's pixel density, so a phone screen stays legible;
        // a whole display stays at points to bound its encoding cost.
        let density = target.kind == "window" ? Self.pixelDensity(of: frame, on: content.displays) : 1
        let scale = min(density, min(3840 / frame.width, 2160 / frame.height))
        width = max(1, Int(frame.width * scale)); height = max(1, Int(frame.height * scale))
        let config = SCStreamConfiguration()
        config.width = width; config.height = height; config.queueDepth = 3
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.pixelFormat = kCVPixelFormatType_32BGRA; config.showsCursor = true
        let output = CaptureOutput(writer: writer, sessionId: session, version: request.version, scale: Double(width) / frame.width)
        if target.kind == "window" { output.onResize = { [weak self] in Task { @MainActor in await self?.refit() } } }
        self.output = output; self.configuration = (filter, config); self.target = target
        do { if request.version == 1 || request.capture == true { try await setCapturing(true) } } catch { self.stream = nil; self.configuration = nil; self.output = nil; self.target = nil; throw error }
    }
    @discardableResult func setCapturing(_ enabled: Bool) async throws -> UInt64 {
        guard let configuration, let output else { throw HelperError("No selected capture target", code: "target_gone") }
        let after = output.nextSequence
        if enabled && !capturing {
            guard CGPreflightScreenCaptureAccess() else { throw HelperError("Screen Recording permission denied", code: "permission_denied") }
            let created = SCStream(filter: configuration.filter, configuration: configuration.config, delegate: output)
            try created.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.queue)
            output.markInitial(); try await created.startCapture(); stream = created; capturing = true
        }
        if !enabled && capturing, let stream {
            try await stream.stopCapture(); await output.drain()
            try stream.removeStreamOutput(output, type: .screen)
            self.stream = nil; capturing = false
        }
        return after
    }
    /// Match the stream to the captured window's current size, as after a Simulator rotation.
    func refit() async {
        guard let target, target.kind == "window", let configuration, let stream else { return }
        cachedContent = nil
        guard let content = try? await content(), let window = content.windows.first(where: { $0.windowID == target.windowId }),
              window.frame.width > 0, window.frame.height > 0,
              abs(window.frame.width - frame.width) >= 1 || abs(window.frame.height - frame.height) >= 1 else { return }
        let density = Self.pixelDensity(of: window.frame, on: content.displays)
        let scale = min(density, min(3840 / window.frame.width, 2160 / window.frame.height))
        let config = configuration.config
        config.width = max(1, Int(window.frame.width * scale)); config.height = max(1, Int(window.frame.height * scale))
        do { try await stream.updateConfiguration(config) } catch { return }
        frame = window.frame; width = config.width; height = config.height
        output?.markInitial()
    }
    func stop() async throws {
        if capturing { _ = try await setCapturing(false) }
        stream = nil; configuration = nil; target = nil; output = nil; allowed.removeAll(); cachedContent = nil
    }
}
