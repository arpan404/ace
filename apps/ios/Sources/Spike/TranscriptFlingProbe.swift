import QuartzCore
import SwiftUI
import os

/// A release-to-stop sample in fixture builds. Counters are read twice per fling,
/// so measuring a busy feed adds no per-frame logging or observed state.
@MainActor final class TranscriptFlingProbe {
    #if ACE_FIXTURE
    private static let logger = Logger(subsystem: "dev.ace.perf", category: "fling")
    private static let enabled = ProcessInfo.processInfo.arguments.contains("-ace-fling-trace")
    static let isolated = ProcessInfo.processInfo.arguments.contains("-ace-fling-isolate")
    static let suppressesAnchors = isolated || ProcessInfo.processInfo.arguments.contains("-ace-fling-no-anchors")

    private struct Start {
        let time: CFTimeInterval
        let offset: Double
        let velocity: Double?
        let height: Double
        let room: Double
        let counts: [String: Int]
    }

    private var start: Start?
    private var lastTime = 0.0
    private var largestGap = 0.0
    private var sequence = 0

    func phase(from old: ScrollPhase, to phase: ScrollPhase, context: ScrollPhaseChangeContext, holdingEnd: Bool) {
        guard Self.enabled else { return }
        let now = CACurrentMediaTime()
        let offset = Double(context.geometry.contentOffset.y)
        let height = Double(context.geometry.contentSize.height)
        if phase == .decelerating {
            let room = height + Double(context.geometry.contentInsets.bottom - context.geometry.containerSize.height) - offset
            start = Start(time: now, offset: offset, velocity: context.velocity.map { Double($0.dy) },
                          height: height, room: room, counts: PerfCounters.snapshot())
            lastTime = now
            largestGap = 0
            Self.logger.log("decelerating y=\(offset) endAnchor=\(holdingEnd) isolated=\(Self.isolated)")
            return
        }
        guard let began = start else {
            if old == .interacting {
                Self.logger.log("drag ended directly in \(String(describing: phase), privacy: .public) y=\(offset)")
            }
            return
        }
        start = nil
        let elapsed = max(now - began.time, 0.001)
        let counts = PerfCounters.snapshot()
        func count(_ key: String) -> Int { counts[key, default: 0] - began.counts[key, default: 0] }
        func perSecond(_ key: String) -> Double { Double(count(key)) / elapsed }
        let gap = max(largestGap, now - lastTime) * 1000
        let travel = offset - began.offset
        let growth = height - began.height
        let velocity = began.velocity.map { String($0) } ?? "unknown"
        let feed = perSecond("feed.body")
        let rows = perSecond("row.body")
        let requests = perSecond("offset.proxy")
        let writes = perSecond("offset.write")
        let samples = perSecond("scroll.geometry")
        sequence += 1
        let summary = """
            fling \(sequence) \(phase) seconds=\(elapsed) travel=\(travel) releaseVelocity=\(velocity) room=\(began.room) heightDelta=\(growth) \
            geometry/s=\(samples) gapMs=\(gap) feed/s=\(feed) rows/s=\(rows) \
            proxy/s=\(requests) offsetWrites/s=\(writes) blocked=\(count("offset.blocked"))
            """
        Self.logger.log("\(summary, privacy: .public)")
        PerfProbe.record([
            "fling.sequence": String(sequence), "fling.points": String(travel), "fling.seconds": String(elapsed),
            "fling.feedBodiesPerSecond": String(feed), "fling.rowBodiesPerSecond": String(rows),
            "fling.proxyRequestsPerSecond": String(requests), "fling.offsetWritesPerSecond": String(writes),
            "fling.geometryPerSecond": String(samples), "fling.geometryGapMs": String(gap),
        ])
    }

    func geometry() {
        guard start != nil else { return }
        let now = CACurrentMediaTime()
        largestGap = max(largestGap, now - lastTime)
        lastTime = now
    }
    #else
    static let isolated = false
    static let suppressesAnchors = false
    func phase(from old: ScrollPhase, to phase: ScrollPhase, context: ScrollPhaseChangeContext, holdingEnd: Bool) {}
    func geometry() {}
    #endif
}
