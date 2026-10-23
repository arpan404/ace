import Foundation
import os
import QuartzCore
import Darwin

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
    /// Sample frames while a thread is on screen, only when asked: a display link firing every
    /// frame keeps an idle phone awake.
    func showing(_ on: Bool) { if FrameSampler.enabled { frameSampler.run(on) } }

    func open(_ id: String, warm: Bool) {
        finish(reason: "left")
        thread = id
        self.warm = warm
        started = CACurrentMediaTime()
        scriptAtStart = Self.scriptBusy.withLock { $0 }
        frames = 0; patches = 0; bytes = 0; mainMs = 0; ready = nil; painted = nil; settledAt = nil; hopMs = 0; turnMs = 0; lastApplied = nil
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
            PerfProbe.record(["bridge.windowS": String(format: "%.1f", now - window.started), "bridge.frames": "\(window.frames)",
                              "bridge.patches": "\(window.patches)", "bridge.bytes": "\(window.bytes)",
                              "bridge.mainMs": String(format: "%.1f", window.mainMs),
                              "bridge.scriptMs": String(format: "%.1f", (script - window.script) * 1000),
                              "footprintMiB": Self.footprint()])
            PerfProbe.add("bridge.windows", 1)
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
        if settledAt != nil { finish(reason: "settled") }
    }
    /// The first transcript rows were laid out.
    func painted(_ id: String) {
        guard thread == id, painted == nil else { return }
        painted = CACurrentMediaTime()
        Self.signposter.emitEvent("thread.painted")
    }
    /// The feed reached its end after opening; the open ends once the bridge is ready too.
    func settled(_ id: String) {
        guard thread == id, painted != nil, settledAt == nil else { return }
        settledAt = CACurrentMediaTime()
        if ready != nil { finish(reason: "settled") }
    }
    private var settledAt: Double?
    /// Agents and Changes: from the sheet asking the bridge to its first rows applied.
    private var sheets: [String: (asked: Double, interval: OSSignpostIntervalState)] = [:]
    func sheetAsked(_ kind: String) {
        sheets[kind] = (CACurrentMediaTime(), Self.signposter.beginInterval("sheet.open", id: Self.signposter.makeSignpostID(), "\(kind, privacy: .public)"))
    }
    func sheetFilled(_ kind: String) {
        guard let sheet = sheets.removeValue(forKey: kind) else { return }
        Self.signposter.endInterval("sheet.open", sheet.interval)
        let ms = (CACurrentMediaTime() - sheet.asked) * 1000
        Self.log.notice("sheet \(kind, privacy: .public) filledMs=\(String(format: "%.0f", ms), privacy: .public)")
        PerfProbe.record(["sheet.\(kind)Ms": String(format: "%.0f", ms)])
        PerfProbe.add("sheets", 1)
    }
    /// A page of history read into the transcript, from asking to the window replaced.
    static func page(_ operation: String, items: Int, blocks: Int, seconds: Double) {
        log.notice("page \(operation, privacy: .public) items=\(items) blocks=\(blocks) ms=\(String(format: "%.0f", seconds * 1000), privacy: .public) footprintMiB=\(footprint(), privacy: .public)")
    }
    /// The app's physical footprint, as the system counts it against its memory limit.
    nonisolated static func footprint() -> String {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? String(format: "%.0f", Double(info.phys_footprint) / 1_048_576) : "-"
    }
    private func finish(reason: String) {
        guard let thread else { return }
        let now = CACurrentMediaTime()
        let ms = { (time: Double?) in time.map { String(format: "%.0f", ($0 - self.started) * 1000) } ?? "-" }
        let script = (Self.scriptBusy.withLock { $0 } - scriptAtStart) * 1000
        Self.log.notice("""
            open thread=\(thread, privacy: .public) warm=\(self.warm) end=\(reason, privacy: .public) \
            readyMs=\(ms(self.ready), privacy: .public) paintMs=\(ms(self.painted), privacy: .public) \
            settledMs=\(ms(self.settledAt ?? now), privacy: .public) frames=\(self.frames) patches=\(self.patches) bytes=\(self.bytes) \
            mainApplyMs=\(String(format: "%.1f", self.mainMs), privacy: .public) scriptMs=\(String(format: "%.1f", script), privacy: .public) \
            hopMs=\(String(format: "%.1f", self.hopMs), privacy: .public) turnMs=\(String(format: "%.1f", self.turnMs), privacy: .public) \
            footprintMiB=\(Self.footprint(), privacy: .public)
            """)
        PerfProbe.record(["open.thread": thread, "open.warm": "\(warm)", "open.end": reason,
                          "open.readyMs": ms(ready), "open.paintMs": ms(painted), "open.settledMs": ms(settledAt ?? now),
                          "open.bytes": "\(bytes)", "open.mainMs": String(format: "%.1f", mainMs),
                          "open.scriptMs": String(format: "%.1f", script), "footprintMiB": Self.footprint()])
        PerfProbe.add("opens", 1)
        if let interval { Self.signposter.endInterval("thread.open", interval) }
        interval = nil
        self.thread = nil
    }
}
