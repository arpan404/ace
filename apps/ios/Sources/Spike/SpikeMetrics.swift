import Foundation
import UIKit
import QuartzCore
import Darwin

/// Debug instrumentation only. Display-link samples describe callback cadence, not GPU presentation.
@MainActor final class SpikeMetrics: NSObject {
    private let now: () -> Double
    private let output: URL
    private weak var model: ClientModel?
    private var link: CADisplayLink?
    private var timer: Timer?
    private var pending: [Double] = []
    private var inputLatency: [Double] = []
    private var gaps: [Double] = []
    private var lastFrame: Double?
    private var started: Double = 0
    private var memory: [[String: Double]] = []
    init(model: ClientModel, now: @escaping () -> Double, output: URL) {
        self.model = model; self.now = now; self.output = output
    }
    func start() {
        started = now()
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
    }
    func inputBegan() { if pending.count < 128 { pending.append(now()) } }
    @objc private func tick(_ displayLink: CADisplayLink) {
        let instant = now()
        for start in pending { if inputLatency.count < 2048 { inputLatency.append((instant - start) * 1000) } }
        pending.removeAll(keepingCapacity: true)
        if let lastFrame, gaps.count < 36000 { gaps.append((instant - lastFrame) * 1000) }
        lastFrame = instant
    }
    private func sample() {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        if result == KERN_SUCCESS, memory.count < 120 {
            memory.append(["seconds": now() - started, "footprintMiB": Double(info.phys_footprint) / 1048576,
                           "rssMiB": Double(info.resident_size) / 1048576, "items": Double(model?.thread?.items.count ?? 0)])
        }
        let json: [String: Any] = ["durationSeconds": now() - started, "inputToNextDisplayLinkMs": inputLatency,
                                  "displayLinkGapMs": gaps, "memory": memory,
                                  "largestBridgeFrameBytes": model?.largestFrame ?? 0, "patches": model?.patchCount ?? 0,
                                  "streamedUpdates": model?.streamedUpdates ?? 0]
        guard let data = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]) else { return }
        try? data.write(to: output, options: .atomic)
    }
    func stop() { link?.invalidate(); timer?.invalidate(); link = nil; timer = nil; sample() }
}
