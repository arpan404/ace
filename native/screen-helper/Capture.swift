import Foundation
import ScreenCaptureKit
import CoreImage
import AppKit

final class CaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let runtime: NativeRuntime
    let writer: FrameWriter
    let sessionId: String
    let queue = DispatchQueue(label: "ace.screen.capture")
    func drain() async { await withCheckedContinuation { continuation in queue.async { continuation.resume() } } }
    private lazy var encoder = JPEGEncoder(context: CIContext(options: [.cacheIntermediates: false]))
    private lazy var video: VideoEncoder = VideoEncoder(sessionId: sessionId, version: version,
        publish: { [weak self] packet in if let self { self.writer.publish(packet, sessionId: self.sessionId) } },
        completed: { [weak self] in self?.queue.async { [weak self] in self?.pendingVideo.completed() } })
    private struct ChangedImage { let image: CVPixelBuffer; let timestamp: Double; let scale: Double; let damage: [CGRect]? }
    private lazy var pendingVideo: LatestVideoFrames<ChangedImage> = LatestVideoFrames<ChangedImage> { [weak self] changed in
        guard let self else { return .unavailable }
        let result = self.video.encode(changed.image, sequence: self.nextSequence, timestamp: changed.timestamp, scale: changed.scale)
        if result == .submitted { self.lock.lock(); self.sequence += 1; self.initial = false; self.lock.unlock() }
        if result == .unavailable { self.codec = "jpeg"; self.publishImage(changed) }
        return result
    }
    private let images = CaptureImages<ChangedImage>()
    private func publishImage(_ changed: ChangedImage) {
        let started = runtime.nanos()
        guard let packet = encoder.packet(image: changed.image, sessionId: sessionId, sequence: nextSequence,
            timestamp: changed.timestamp, version: version, scale: changed.scale, dirtyRects: changed.damage) else { return }
        lock.lock(); sequence += 1; initial = false; encodeNanos += runtime.nanos() - started; lock.unlock()
        writer.publish(packet, sessionId: sessionId)
    }
    private var codec = "jpeg"
    func configure(_ settings: StreamSettings, targetWidth: Double) async {
        await withCheckedContinuation { continuation in queue.async {
            self.pendingVideo.clear(); self.video.close(); self.targetWidth = targetWidth; self.codec = settings.codec; self.video.configure(bitrate: settings.bitrate, fps: settings.fps)
            self.markInitial(); continuation.resume()
        } }
    }
    func requestKeyframe() { queue.async {
        self.video.requestKeyframe(); self.markInitial()
        if self.codec == "h264", let image = self.images.latest { self.pendingVideo.offer(image) }
    } }
    func requestImage() { queue.async {
        guard let image = self.images.request() else { self.markInitial(); return }
        self.pendingVideo.clear(); self.video.close(); self.publishImage(image)
    } }
    func finish() async { await withCheckedContinuation { continuation in queue.async { self.pendingVideo.clear(); self.video.close(); self.images.clear(); continuation.resume() } } }
    private var sequence: UInt64 = 0
    private let lock = NSLock()
    private var initial = true
    private var changes = FrameChanges()
    private var encodeNanos: UInt64 = 0
    var metrics: [String: Any] { lock.lock(); defer { lock.unlock() }; return ["encodedFrames": sequence, "encodeNanos": encodeNanos] }
    func markInitial() { lock.lock(); initial = true; lock.unlock() }
    private let version: Int
    private let scale: Double
    private var targetWidth: Double
    var nextSequence: UInt64 { lock.lock(); defer { lock.unlock() }; return sequence }
    /// Called (at most twice a second) when the window no longer fills the frame: it was resized
    /// or, for a Simulator, rotated. The capture is then reconfigured to the new size.
    var onResize: (() -> Void)?
    private var lastResize: UInt64 = 0
    init(writer: FrameWriter, sessionId: String, version: Int, scale: Double, targetWidth: Double, runtime: NativeRuntime) { self.runtime = runtime; self.targetWidth = targetWidth; self.writer = writer; self.sessionId = sessionId; self.version = version; self.scale = scale }
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
            let now = runtime.nanos()
            if now - lastResize > 500_000_000 { lastResize = now; onResize?() }
        }
        let currentScale = measured.flatMap { $0.isFinite && $0 > 0 && $0 <= 8 ? $0 : nil } ?? Double(CVPixelBufferGetWidth(image)) / targetWidth
        let changed = ChangedImage(image: image, timestamp: runtime.milliseconds(), scale: currentScale, damage: damage)
        if let screenshot = images.receive(changed) {
            pendingVideo.clear(); video.close(); publishImage(screenshot)
        }
        lock.lock(); let first = initial; lock.unlock()
        var nextChanges = changes
        guard nextChanges.changed(initial: first, dirtyRects: damage, fingerprint: { pixelFingerprint(image) }) else { return }
        changes = nextChanges
        if codec == "h264" { pendingVideo.offer(changed) }
        else { publishImage(changed) }
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
    private var initialRequest: Request?
    private var capturedWindowId: UInt32?
    private var captureDensity = 1.0
    private var settings: StreamSettings?
    private var cachedContent: (at: UInt64, content: ShareableContent)?
    struct PointerPress { let window: SCWindow; let application: NSRunningApplication; let button: String; let location: CGPoint; let mode: String }
    let heldPointer = HeldPointer<PointerPress>()
    var pointerAction: PointerPress? { heldPointer.target }
    private(set) var captureWindow: SCWindow?
    private(set) var target: Target?
    private(set) var allowed = Set<String>()
    private(set) var frame = CGRect.zero
    private(set) var width = 0
    private(set) var height = 0
    var synthesizedInput = false
    var mode = "background"
    var secureInputAllowed = false
    let writer: FrameWriter
    let runtime: NativeRuntime
    init(writer: FrameWriter, runtime: NativeRuntime) { self.writer = writer; self.runtime = runtime }
    var metrics: [String: Any] { var result = resourceMetrics(); result.merge(output?.metrics ?? ["encodedFrames": 0, "encodeNanos": 0]) { _, new in new }; return result }
    func content() async throws -> ShareableContent {
        guard CGPreflightScreenCaptureAccess() else { throw HelperError("Screen Recording permission denied", code: "permission_denied") }
        let now = runtime.nanos()
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
              let fps = request.fps, (1...60).contains(fps) else { throw HelperError("Invalid capture request", code: "bounds") }
        allowed = Set(approvals)
        initialRequest = request
        let content = try await content()
        let filter: SCContentFilter
        if target.kind == "window" || target.kind == "app" {
            guard let bundle = target.bundleId, allowed.contains(bundle) else { throw HelperError("Window is not approved", code: "permission_denied") }
            let candidates = content.windows.filter { $0.owningApplication?.bundleIdentifier == bundle && $0.windowLayer == 0 }
            if target.kind == "app", candidates.isEmpty { self.target = target; return }
            let window: SCWindow
            if target.kind == "app" { window = try appInputWindow(candidates) }
            else {
                guard let selected = candidates.first(where: { $0.windowID == target.windowId }) else { throw unavailableWindow(target) }
                window = selected
            }
            captureWindow = window
            capturedWindowId = window.windowID
            try validateCaptureWindow(window, displays: content.displays)
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
        let density = target.kind != "display" ? Self.pixelDensity(of: frame, on: content.displays) : 1
        captureDensity = density
        let scale = min(density, min(3840 / frame.width, 2160 / frame.height))
        width = max(1, Int(frame.width * scale)); height = max(1, Int(frame.height * scale))
        let config = SCStreamConfiguration()
        config.width = width; config.height = height; config.queueDepth = 3
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.scalesToFit = true
        config.pixelFormat = kCVPixelFormatType_32BGRA; config.showsCursor = false
        let output = CaptureOutput(writer: writer, sessionId: session, version: request.version, scale: Double(width) / frame.width, targetWidth: frame.width, runtime: runtime)
        if target.kind != "display" { output.onResize = { [weak self] in Task { @MainActor in await self?.refit() } } }
        self.output = output; self.configuration = (filter, config); self.target = target
        do { if request.version == 1 || request.capture == true { try await setCapturing(true) } } catch { self.stream = nil; self.configuration = nil; self.output = nil; self.target = nil; throw error }
    }
    func configureStream(_ settings: StreamSettings) async throws {
        guard ["jpeg", "h264"].contains(settings.codec), (64...3840).contains(settings.maxWidth), (64...2160).contains(settings.maxHeight),
              (1...60).contains(settings.fps), (128000...20000000).contains(settings.bitrate), let configuration, let output else {
            throw HelperError("Invalid stream settings", code: "bounds")
        }
        self.settings = settings
        let config = configuration.config
        let scale = min(Double(settings.maxWidth) / frame.width, Double(settings.maxHeight) / frame.height)
        config.width = max(2, Int(frame.width * min(scale, captureDensity)) / 2 * 2)
        config.height = max(2, Int(frame.height * min(scale, captureDensity)) / 2 * 2)
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(settings.fps))
        await output.configure(settings, targetWidth: frame.width)
        try await stream?.updateConfiguration(config)
        width = config.width; height = config.height
        output.markInitial()
        if settings.codec == "jpeg" { output.requestImage() }
    }
    func requestKeyframe() { output?.requestKeyframe() }
    func requestImage() { output?.requestImage() }
    @discardableResult func setCapturing(_ enabled: Bool) async throws -> UInt64 {
        if enabled, configuration == nil, target?.kind == "app", let request = initialRequest {
            self.target = nil; cachedContent = nil
            do { try await start(request) } catch { self.target = request.target; throw error }
        }
        if !enabled && configuration == nil { return 0 }
        guard let configuration, let output else { throw HelperError("No selected capture target", code: "target_gone") }
        let after = output.nextSequence
        if enabled, let target, target.kind != "display" {
            let content = try await content()
            let candidates = content.windows.filter { $0.owningApplication?.bundleIdentifier == target.bundleId && $0.windowLayer == 0 }
            guard let window = candidates.first(where: { $0.windowID == capturedWindowId }) else { throw unavailableWindow(target) }
            if target.kind == "app", try appInputWindow(candidates).windowID != capturedWindowId { throw HelperError("App focus changed; select an explicit window target", code: "not_supported") }
            try validateCaptureWindow(window, displays: content.displays)
        }
        if enabled && !capturing {
            guard CGPreflightScreenCaptureAccess() else { throw HelperError("Screen Recording permission denied", code: "permission_denied") }
            let created = SCStream(filter: configuration.filter, configuration: configuration.config, delegate: output)
            try created.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.queue)
            output.markInitial(); try await created.startCapture(); stream = created; capturing = true
        }
        if !enabled && capturing, let stream {
            try await stream.stopCapture(); await output.drain(); await output.finish()
            try stream.removeStreamOutput(output, type: .screen)
            self.stream = nil; capturing = false
        }
        return after
    }
    /// Match the stream to the captured window's current size, as after a Simulator rotation.
    func refit() async {
        guard let target, target.kind != "display", let configuration, let stream else { return }
        cachedContent = nil
        guard let content = try? await content(), let window = content.windows.first(where: { $0.windowID == capturedWindowId }),
              window.frame.width > 0, window.frame.height > 0,
              abs(window.frame.width - frame.width) >= 1 || abs(window.frame.height - frame.height) >= 1 else { return }
        let density = Self.pixelDensity(of: window.frame, on: content.displays)
        captureDensity = density
        let scale = min(density, min(Double(settings?.maxWidth ?? 3840) / window.frame.width, Double(settings?.maxHeight ?? 2160) / window.frame.height))
        let config = configuration.config
        config.width = max(2, Int(window.frame.width * scale) / 2 * 2); config.height = max(2, Int(window.frame.height * scale) / 2 * 2)
        do { try await stream.updateConfiguration(config) } catch { return }
        frame = window.frame; width = config.width; height = config.height
        if let settings { await output?.configure(settings, targetWidth: frame.width) }
        output?.markInitial()
    }
    func stop() async throws {
        try releasePointer()
        if capturing { _ = try await setCapturing(false) }
        if let output { writer.retire(output.sessionId) }
        stream = nil; configuration = nil; target = nil; initialRequest = nil; capturedWindowId = nil; captureWindow = nil; settings = nil; output = nil; allowed.removeAll(); cachedContent = nil
    }
}
