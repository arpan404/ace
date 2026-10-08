import Foundation
import ScreenCaptureKit
import CoreImage
import AppKit
import Darwin

/// SCK presentation timestamps and injection marks both use CMClock's host clock.
/// Wall-clock time and callback-delivery time are never used as content update times.
func measurementHostMs() -> Double { CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) * 1000 }

final class MeasurementOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "ace.screen.measurement", autoreleaseFrequency: .workItem)
    private let clock: () -> Double
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let refreshHz: Double
    private let filmstrip: Bool
    private let observeMs: Double
    private let maxWindowMs: Double
    private let point: CGPoint?
    private var previous: MeasurementPixels?
    private var initialImage: CGImage?
    private var baseline: CheckedContinuation<Void, Error>?
    private var failure: Error?
    private var origin: Double?
    private var actionAt: Double?
    private var firstChange: Double?
    private var regionalChange: Double?
    private var updates: [Double] = []
    private var candidates = MeasurementCandidates()
    private var overheadMs = 0.0
    private var capped = false
    private var clipped = false
    init(refreshHz: Double, filmstrip: Bool, observeMs: Double, maxWindowMs: Double, point: CGPoint?, clock: @escaping () -> Double) {
        self.refreshHz = refreshHz; self.filmstrip = filmstrip; self.observeMs = observeMs; self.maxWindowMs = maxWindowMs; self.point = point; self.clock = clock
    }
    func ready() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in queue.async {
            if let failure = self.failure { continuation.resume(throwing: failure) }
            else if self.previous != nil { continuation.resume() }
            else {
                self.baseline = continuation
                self.queue.asyncAfter(deadline: .now() + 1) {
                    guard let pending = self.baseline else { return }
                    self.baseline = nil; pending.resume(throwing: HelperError("No window frame; desktop may be locked or capture unavailable", code: "target_gone"))
                }
            }
        } }
    }
    func begin() -> Double { queue.sync {
        let started = clock(); origin = started
        if let initialImage { candidates.receive(MeasurementCandidate(atMs: 0, image: initialImage, damage: nil), intervalMs: 1000 / refreshHz, windowMs: observeMs) }
        initialImage = nil
        return started
    } }
    func markInput() { queue.sync {
        guard actionAt == nil else { return }
        actionAt = clock()
        let baseline = candidates.last
        candidates = MeasurementCandidates()
        if let baseline { candidates.receive(baseline, intervalMs: 1000 / refreshHz, windowMs: observeMs) }
    } }
    func deadlineReached() { queue.async { self.clipped = true } }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { self.failure = error; self.baseline?.resume(throwing: error); self.baseline = nil }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let image = sample.imageBuffer,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue else { return }
        let started = clock()
        defer { overheadMs += max(0, clock() - started) }
        guard let pixels = MeasurementPixels.sample(image) else { return }
        let timestamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000
        guard timestamp.isFinite else { failure = HelperError("Capture frame has no host presentation timestamp"); return }
        defer { previous = pixels }
        guard let previous else {
            if filmstrip { initialImage = measurementThumbnail(image, context: context) }
            baseline?.resume(); baseline = nil; return
        }
        guard let origin, timestamp >= origin, timestamp - origin <= maxWindowMs,
              let damage = pixels.difference(from: previous) else { return }
        let at = ((timestamp - origin) * 100).rounded() / 100
        guard updates.count < 2400 else { capped = true; return }
        updates.append(at)
        if let actionAt, timestamp >= actionAt {
            if firstChange == nil { firstChange = timestamp - actionAt }
            if regionalChange == nil, let point, pixels.changed(near: point, from: previous) { regionalChange = timestamp - actionAt }
        }
        if filmstrip, let thumbnail = measurementThumbnail(image, context: context) {
            candidates.receive(MeasurementCandidate(atMs: at, image: thumbnail, damage: damage), intervalMs: 1000 / refreshHz, windowMs: observeMs)
        }
    }
    func finish(windowMs: Double) async throws -> ([String: Any], [MeasurementCandidate]) {
        try await withCheckedThrowingContinuation { continuation in queue.async {
            if let failure = self.failure { continuation.resume(throwing: failure); return }
            var notes = ["Screen content changes use a 96x64 sample grid; tiny changes can be missed.", "Display-rate gaps cannot distinguish deliberate low-rate animation from rendering stalls.", "Capture overhead covers callback sampling and thumbnails, excluding WindowServer/GPU cost."]
            if self.capped { notes.append("Update evidence reached its 2400-frame cap.") }
            if self.clipped { notes.append("Capture stopped at its allotted recording deadline; the requested post-input observation was clipped.") }
            var data: [String: Any] = ["refreshHz": self.refreshHz, "windowMs": windowMs, "updatesMs": self.updates,
                "captureOverheadPct": min(100, self.overheadMs / max(1, windowMs) * 100), "notes": notes]
            if self.capped || self.clipped { data["truncated"] = true }
            if let origin = self.origin, let actionAt = self.actionAt { data["actionAtMs"] = max(0, actionAt - origin) }
            if let latency = self.regionalChange ?? self.firstChange {
                data["latencyMs"] = latency
                if self.regionalChange == nil, self.point != nil { notes.append("No change near the action point; latency uses the whole window."); data["notes"] = notes }
            }
            let offset = self.actionAt.flatMap { actionAt in self.origin.map { actionAt - $0 } } ?? 0
            let frames = self.candidates.selected().map { MeasurementCandidate(atMs: $0.atMs - offset, image: $0.image, damage: $0.damage, hitch: $0.hitch) }
            continuation.resume(returning: (data, frames))
        } }
    }
}

@MainActor extension Capture {
    func measureInteraction(_ request: Request, accessibility: Accessibility) async throws -> [String: Any] {
        let observeMs = request.observeMs ?? 2000
        let recordingLimit = Double(request.maxWindowMs ?? 10_000)
        guard (1...10_000).contains(observeMs), (1...10_000).contains(recordingLimit), let target, target.kind == "window", let bundle = target.bundleId,
              allowed.contains(bundle) else { throw HelperError("Measurement requires an approved window and observation/recording limits in 1...10000", code: "bounds") }
        let input = request.measurementAction ?? request.input
        if let input, !["pointer.click", "pointer.drag", "text.type", "text.paste", "key.press", "scroll"].contains(input.kind) { throw HelperError("Measurement requires a complete click, drag, text, key or scroll action", code: "bounds") }
        if let duration = input?.durationMs {
            guard (0...10_000).contains(duration), duration <= 10_000 - observeMs else { throw HelperError("Action and observation exceed 10000 ms", code: "bounds") }
        }
        let available = try await content()
        guard let window = available.windows.first(where: { $0.windowID == target.windowId && $0.owningApplication?.bundleIdentifier == bundle }) else { throw unavailableWindow(target) }
        try validateCaptureWindow(window, displays: available.displays)
        let bounds = window.frame
        let display = available.displays.first { $0.frame.contains(CGPoint(x: bounds.midX, y: bounds.midY)) } ?? available.displays.first
        let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display?.displayID }
        let reported = screen.map { Double($0.maximumFramesPerSecond) } ?? display.flatMap { CGDisplayCopyDisplayMode($0.displayID)?.refreshRate } ?? 0
        let refreshHz = reported > 0 ? min(240, reported) : 60
        let config = SCStreamConfiguration()
        let scale = min(1, min(960 / bounds.width, 640 / bounds.height))
        config.width = max(2, Int(bounds.width * scale)); config.height = max(2, Int(bounds.height * scale))
        config.queueDepth = 3; config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(refreshHz.rounded()))
        config.pixelFormat = kCVPixelFormatType_32BGRA; config.showsCursor = false; config.scalesToFit = true
        let point = input.flatMap { action -> CGPoint? in
            guard let x = action.x, let y = action.y else { return nil }
            return CGPoint(x: x / bounds.width, y: y / bounds.height)
        }
        let output = MeasurementOutput(refreshHz: refreshHz, filmstrip: request.filmstrip == true, observeMs: Double(observeMs), maxWindowMs: recordingLimit, point: point, clock: measurementHostMs)
        let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: output)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.queue)
        try await stream.startCapture()
        let stop = MeasurementStop(stream: stream)
        defer { stop.cancelWatchdog() }
        do {
            try await output.ready()
            let started = output.begin()
            stop.arm(afterMs: started + recordingLimit - measurementHostMs(), onDeadline: { [weak output] in output?.deadlineReached() })
            let focus = input != nil && mode == "background" ? FocusGuard(targetPID: window.owningApplication?.processID, targetWindow: try? resolver.resolve(window)) : nil
            synthesizedInput = false; dispatched = false; deliveryConfirmed = false; deliveryProbe = nil
            defer { deliveryProbe = nil }
            measurementInputMark = { output.markInput() }
            defer { measurementInputMark = nil }
            var actionError: Error?
            var injectedAt = started
            if let input {
                guard measurementHostMs() < started + recordingLimit else {
                    throw HelperError("Recording allowance elapsed before input dispatch", code: "timeout")
                }
                do { try await injectV2(input) } catch { actionError = error }
                injectedAt = measurementHostMs()
                if let actionError {
                    let fault = actionError as? HelperError
                    throw HelperError(String(describing: actionError), code: fault?.code ?? "internal", phase: dispatched ? "partial" : fault?.phase ?? "rejected-before-dispatch", candidates: fault?.candidates ?? [])
                }
            }
            let deadline = min(started + recordingLimit, injectedAt + Double(observeMs))
            let remaining = max(0, deadline - measurementHostMs())
            try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000))
            let ended = measurementHostMs()
            try await stop.stop()
            if ended >= started + recordingLimit { output.deadlineReached() }
            let recordedEnd = stop.deadlineReached || ended >= started + recordingLimit ? started + recordingLimit : ended
            let (evidence, frames) = try await output.finish(windowMs: recordedEnd - started)
            if input != nil, mode == "background", synthesizedInput, !deliveryConfirmed, deliveryProbe?() != true {
                throw HelperError("Input destination did not acknowledge delivery; do not retry automatically", code: "delivery_unconfirmed", phase: "dispatched")
            }
            var data = evidence
            var loads = [Double](repeating: 0, count: 3)
            if getloadavg(&loads, 3) > 0 { data["hostLoad"] = loads[0] }
            data["hostCores"] = ProcessInfo.processInfo.activeProcessorCount
            var notes = data["notes"] as? [String] ?? []
            if let warning = focus?.warning() { notes.append(warning) }
            if reported <= 0 { data["refreshAssumed"] = true; notes.append("Display refresh rate unavailable; assumed 60 Hz.") }
            if request.filmstrip == true {
                if let jpeg = measurementFilmstrip(frames) { data["filmstrip"] = ["type": "image", "data": jpeg.base64EncodedString(), "mimeType": "image/jpeg"] }
                else { notes.append("Filmstrip could not fit the bounded reply.") }
            }
            data["notes"] = notes
            try stream.removeStreamOutput(output, type: .screen)
            return data
        } catch {
            measurementInputMark = nil
            try? await stop.stop(); try? stream.removeStreamOutput(output, type: .screen)
            throw error
        }
    }
}
