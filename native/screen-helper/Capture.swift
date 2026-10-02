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
    init(writer: FrameWriter, sessionId: String, version: Int, scale: Double) { self.writer = writer; self.sessionId = sessionId; self.version = version; self.scale = scale }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let image = sample.imageBuffer else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue else { return }
        let damage = attachments.first?[.dirtyRects] as? [CGRect]
        let seq = nextSequence
        lock.lock(); let first = initial; lock.unlock()
        var nextChanges = changes
        guard nextChanges.changed(initial: first, dirtyRects: damage, fingerprint: { pixelFingerprint(image) }) else { return }
        let started = DispatchTime.now().uptimeNanoseconds
        guard let packet = encoder.packet(image: image, sessionId: sessionId, sequence: seq, timestamp: Date().timeIntervalSince1970 * 1000, version: version, scale: scale, dirtyRects: damage) else { return }
        changes = nextChanges
        lock.lock(); sequence += 1; initial = false; encodeNanos += DispatchTime.now().uptimeNanoseconds - started; lock.unlock()
        writer.publish(packet)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { exit(1) }
}

@MainActor final class Capture {
    private var stream: SCStream?
    private var output: CaptureOutput?
    private var configuration: (filter: SCContentFilter, config: SCStreamConfiguration)?
    private var capturing = false
    private var cachedContent: (at: UInt64, content: SCShareableContent)?
    private(set) var target: Target?
    private(set) var allowed = Set<String>()
    private(set) var frame = CGRect.zero
    private(set) var width = 0
    private(set) var height = 0
    let writer: FrameWriter
    init(writer: FrameWriter) { self.writer = writer }
    var metrics: [String: Any] { var result = resourceMetrics(); result.merge(output?.metrics ?? ["encodedFrames": 0, "encodeNanos": 0]) { _, new in new }; return result }
    func content() async throws -> SCShareableContent {
        guard CGPreflightScreenCaptureAccess() else { throw HelperError("Screen Recording permission denied", code: "permission_denied") }
        let now = DispatchTime.now().uptimeNanoseconds
        if let cachedContent, now - cachedContent.at < 250_000_000 { return cachedContent.content }
        let result = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        cachedContent = (now, result); return result
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
        let scale = min(1, min(3840 / frame.width, 2160 / frame.height))
        width = max(1, Int(frame.width * scale)); height = max(1, Int(frame.height * scale))
        let config = SCStreamConfiguration()
        config.width = width; config.height = height; config.queueDepth = 3
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.pixelFormat = kCVPixelFormatType_32BGRA; config.showsCursor = true
        let output = CaptureOutput(writer: writer, sessionId: session, version: request.version, scale: Double(width) / frame.width)
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
    func stop() async throws {
        if capturing { _ = try await setCapturing(false) }
        stream = nil; configuration = nil; target = nil; output = nil; allowed.removeAll(); cachedContent = nil
    }
}
