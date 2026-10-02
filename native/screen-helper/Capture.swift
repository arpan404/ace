import Foundation
import ScreenCaptureKit
import CoreImage
import AppKit

final class CaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let writer: FrameWriter
    let sessionId: String
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var sequence: UInt64 = 0
    init(writer: FrameWriter, sessionId: String) { self.writer = writer; self.sessionId = sessionId }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let image = sample.imageBuffer else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue else { return }
        let ciImage = CIImage(cvPixelBuffer: image)
        guard let jpeg = context.jpegRepresentation(of: ciImage, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.75]),
              jpeg.count > 0, jpeg.count <= 8 * 1024 * 1024 else { return }
        let header: [String: Any] = ["version": 1, "sessionId": sessionId, "sequence": sequence, "timestamp": Date().timeIntervalSince1970 * 1000,
                                   "width": CVPixelBufferGetWidth(image), "height": CVPixelBufferGetHeight(image), "codec": "jpeg", "bytes": jpeg.count]
        sequence += 1
        guard let json = try? JSONSerialization.data(withJSONObject: header), json.count <= 4096 else { return }
        var length = UInt32(json.count).bigEndian
        var packet = withUnsafeBytes(of: &length) { Data($0) }
        packet.append(json); packet.append(jpeg); writer.publish(packet)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { exit(1) }
}

@MainActor final class Capture {
    private var stream: SCStream?
    private var output: CaptureOutput?
    private(set) var target: Target?
    private(set) var allowed = Set<String>()
    private(set) var frame = CGRect.zero
    private(set) var width = 0
    private(set) var height = 0
    let writer: FrameWriter
    init(writer: FrameWriter) { self.writer = writer }
    func content() async throws -> SCShareableContent {
        guard CGPreflightScreenCaptureAccess() else { throw HelperError("Screen Recording permission denied") }
        return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    }
    func start(_ request: Request) async throws {
        guard stream == nil, let target = request.target, let session = request.sessionId,
              session.count <= 64, let approvals = request.allowlist, approvals.count <= 64,
              let fps = request.fps, (1...30).contains(fps) else { throw HelperError("Invalid capture request") }
        allowed = Set(approvals)
        let content = try await content()
        let filter: SCContentFilter
        if target.kind == "window" {
            guard let bundle = target.bundleId, allowed.contains(bundle),
                  let window = content.windows.first(where: { $0.windowID == target.windowId && $0.owningApplication?.bundleIdentifier == bundle }) else { throw HelperError("Window is not approved or available") }
            filter = SCContentFilter(desktopIndependentWindow: window); frame = window.frame
        } else {
            guard let display = content.displays.first(where: { $0.displayID == target.displayId }) else { throw HelperError("Display unavailable") }
            let bundles = target.kind == "app" ? [target.bundleId].compactMap { $0 } : target.bundleIds ?? []
            guard ["display", "app"].contains(target.kind), !bundles.isEmpty, bundles.allSatisfy({ allowed.contains($0) }) else { throw HelperError("Application approval required") }
            let apps = content.applications.filter { bundles.contains($0.bundleIdentifier) }
            guard !apps.isEmpty else { throw HelperError("Approved applications unavailable") }
            filter = SCContentFilter(display: display, including: apps, exceptingWindows: []); frame = display.frame
        }
        guard frame.width > 0, frame.height > 0 else { throw HelperError("Empty capture target") }
        let scale = min(1, min(3840 / frame.width, 2160 / frame.height))
        width = max(1, Int(frame.width * scale)); height = max(1, Int(frame.height * scale))
        let config = SCStreamConfiguration()
        config.width = width; config.height = height; config.queueDepth = 3
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.pixelFormat = kCVPixelFormatType_32BGRA; config.showsCursor = true
        let output = CaptureOutput(writer: writer, sessionId: session)
        let stream = SCStream(filter: filter, configuration: config, delegate: output)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "ace.screen.capture"))
        self.output = output; self.stream = stream; self.target = target
        do { try await stream.startCapture() } catch { self.stream = nil; self.output = nil; self.target = nil; throw error }
    }
    func stop() async throws {
        let old = stream; stream = nil; target = nil; output = nil; allowed.removeAll()
        try await old?.stopCapture()
    }
}
