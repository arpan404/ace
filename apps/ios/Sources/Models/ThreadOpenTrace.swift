import Foundation
import os
import QuartzCore

/// Timing for opening a thread and the bridge traffic behind it. Signposts show in Instruments'
/// Points of Interest; one log line per open carries the numbers (`log stream --predicate
/// 'subsystem == "app.ace.ios" && category == "perf"'`). Measurement only: nothing reads it.
@MainActor final class ThreadOpenTrace {
    static let shared = ThreadOpenTrace()
    nonisolated static let signposter = OSSignposter(subsystem: "app.ace.ios", category: .pointsOfInterest)
    nonisolated static let log = Logger(subsystem: "app.ace.ios", category: "perf")
    /// Time the JavaScript thread spends running bridge work, across runtimes.
    nonisolated static let scriptBusy = OSAllocatedUnfairLock(initialState: 0.0)
    /// When the JavaScript thread emitted each frame not yet applied on the main thread.
    nonisolated static let emits = OSAllocatedUnfairLock(initialState: [Double]())
    nonisolated static func emitted() { let now = CACurrentMediaTime(); emits.withLock { if $0.count < 64 { $0.append(now) } } }
    /// Emit to main-thread apply, and main-thread apply to the next emit, summed over an open.
    private var hopMs = 0.0, turnMs = 0.0
    private var lastApplied: Double?

    private var thread: String?
    private var started = 0.0
    private var scriptAtStart = 0.0
    private var interval: OSSignpostIntervalState?
    private var frames = 0, patches = 0, bytes = 0
    private var mainMs = 0.0
    private var ready: Double?
    private var painted: Double?
    private var warm = false
    private let frameSampler = FrameSampler()
    /// Sample frames while a thread is on screen.
    func showing(_ on: Bool) { frameSampler.run(on) }

    func open(_ id: String, warm: Bool) {
        finish(reason: "left")
        thread = id
        self.warm = warm
        started = CACurrentMediaTime()
        scriptAtStart = Self.scriptBusy.withLock { $0 }
        frames = 0; patches = 0; bytes = 0; mainMs = 0; ready = nil; painted = nil; hopMs = 0; turnMs = 0; lastApplied = nil
        interval = Self.signposter.beginInterval("thread.open", id: Self.signposter.makeSignpostID(), "\(id, privacy: .public)")
    }
    /// One bridge frame applied on the main thread.
    func frame(bytes count: Int, patches added: Int, seconds: Double) {
        window.frames += 1; window.patches += added; window.bytes += count; window.mainMs += seconds * 1000
        let now = CACurrentMediaTime()
        if now - window.started >= 5 {
            let script = Self.scriptBusy.withLock { $0 }
            Self.log.notice("""
                bridge window=\(String(format: "%.1f", now - self.window.started), privacy: .public)s frames=\(self.window.frames) \
                patches=\(self.window.patches) bytes=\(self.window.bytes) mainApplyMs=\(String(format: "%.1f", self.window.mainMs), privacy: .public) \
                scriptMs=\(String(format: "%.1f", (script - self.window.script) * 1000), privacy: .public)
                """)
            window = Window(started: now, script: script)
        }
        let emitted = Self.emits.withLock { $0.isEmpty ? nil : $0.removeFirst() }
        guard thread != nil else { return }
        let applied = CACurrentMediaTime() - seconds
        if let emitted { hopMs += (applied - emitted) * 1000; if let lastApplied { turnMs += (emitted - lastApplied) * 1000 } }
        lastApplied = CACurrentMediaTime()
        frames += 1; patches += added; bytes += count; mainMs += seconds * 1000
    }
    private struct Window { var started = CACurrentMediaTime(); var script = 0.0; var frames = 0, patches = 0, bytes = 0; var mainMs = 0.0 }
    private var window = Window()
    func ready(_ id: String) {
        guard thread == id, ready == nil else { return }
        ready = CACurrentMediaTime()
        Self.signposter.emitEvent("thread.ready")
    }
    /// The first transcript rows were laid out.
    func painted(_ id: String) {
        guard thread == id, painted == nil else { return }
        painted = CACurrentMediaTime()
        Self.signposter.emitEvent("thread.painted")
    }
    /// The feed reached its end after opening.
    func settled(_ id: String) {
        guard thread == id, painted != nil else { return }
        finish(reason: "settled")
    }
    private func finish(reason: String) {
        guard let thread else { return }
        let now = CACurrentMediaTime()
        let ms = { (time: Double?) in time.map { String(format: "%.0f", ($0 - self.started) * 1000) } ?? "-" }
        let script = (Self.scriptBusy.withLock { $0 } - scriptAtStart) * 1000
        Self.log.notice("""
            open thread=\(thread, privacy: .public) warm=\(self.warm) end=\(reason, privacy: .public) \
            readyMs=\(ms(self.ready), privacy: .public) paintMs=\(ms(self.painted), privacy: .public) \
            settledMs=\(ms(now), privacy: .public) frames=\(self.frames) patches=\(self.patches) bytes=\(self.bytes) \
            mainApplyMs=\(String(format: "%.1f", self.mainMs), privacy: .public) scriptMs=\(String(format: "%.1f", script), privacy: .public) \
            hopMs=\(String(format: "%.1f", self.hopMs), privacy: .public) turnMs=\(String(format: "%.1f", self.turnMs), privacy: .public)
            """)
        if let interval { Self.signposter.endInterval("thread.open", interval) }
        interval = nil
        self.thread = nil
    }
}
