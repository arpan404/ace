import CoreGraphics

/*
 * Capture and encode policy for live views. Pure: the capture and encoder shells ask it what
 * to do and apply the answer. Numbers come from docs/computer-use-performance.md.
 */

/// How a frame is encoded: `motion` while the picture changes, `refine` once it holds still.
enum StreamQuality: Equatable { case motion, refine }

/// Capture pixels for a live view: what the viewer asked for, never more than the source's own
/// pixels (an upscaled capture costs bandwidth and adds no detail), even for the encoder.
func streamCaptureSize(points: CGSize, density: Double, maxWidth: Int, maxHeight: Int) -> (width: Int, height: Int) {
    guard points.width > 0, points.height > 0 else { return (2, 2) }
    let scale = min(max(density, 1), Double(maxWidth) / points.width, Double(maxHeight) / points.height)
    return (max(2, Int(points.width * scale) / 2 * 2), max(2, Int(points.height * scale) / 2 * 2))
}

/// Settings the hardware encoder runs with. `maxFrameQP` nil leaves quantisation to rate control;
/// a cap takes precedence over the average bitrate for that frame.
struct VideoEncoderSettings: Equatable {
    let maxFrameQP: Int?
    let keyframe: Bool
}

/// Worst-case bytes per pixel of an H.264 High keyframe at each QP cap, measured on a window
/// of dense small text (the hardest UI content). Real windows are mostly flat and much smaller.
let refineBytesPerPixel: [(qp: Int, bytes: Double)] = [(12, 0.57), (16, 0.44), (20, 0.33), (24, 0.27)]
/// A refine may take this long to reach a viewer at the negotiated bitrate.
let refineBudgetSeconds = 1.5

/// The QP cap for a refine keyframe: the finest one whose worst-case size reaches the viewer
/// within the budget at its bitrate; the coarsest otherwise, which is still sharper than
/// motion frames at that bitrate.
func refineFrameQP(bitrate: Int, pixels: Int) -> Int {
    let budget = Double(bitrate) / 8 * refineBudgetSeconds
    let fitting = refineBytesPerPixel.first { Double(pixels) * $0.bytes <= budget }
    return (fitting ?? refineBytesPerPixel[refineBytesPerPixel.count - 1]).qp
}

/// Motion frames follow the viewer's bitrate. A refine is one keyframe with capped
/// quantisation, which may exceed the average once.
func videoEncoderSettings(_ quality: StreamQuality, bitrate: Int, width: Int, height: Int) -> VideoEncoderSettings {
    switch quality {
    case .motion: return VideoEncoderSettings(maxFrameQP: nil, keyframe: false)
    case .refine: return VideoEncoderSettings(maxFrameQP: refineFrameQP(bitrate: bitrate, pixels: width * height), keyframe: true)
    }
}

/// JPEG quality: moving frames favour size, a still favours text edges.
func jpegQuality(_ quality: StreamQuality) -> Double { quality == .refine ? 0.92 : 0.75 }

/**
 * When to send a refined copy of a picture that stopped changing. Each change restarts the
 * idle clock; once the picture has been still for `idleNs` one refine is due, and no other
 * until the picture changes again. A refine the encoder could not take yet stays due.
 */
struct RefineOnIdle {
    let idleNs: UInt64
    /// Rate control may drop a refine after heavy motion on a slow link; it is retried this often.
    let maxAttempts: Int
    private var changedAt: UInt64?
    private var refined = true
    private var attempts = 0
    init(idleNs: UInt64 = 300_000_000, maxAttempts: Int = 3) { self.idleNs = idleNs; self.maxAttempts = maxAttempts }

    /// A changed picture went out at motion quality.
    mutating func changed(at now: UInt64) { changedAt = now; refined = false; attempts = 0 }
    /// When to check again, if a refine is pending.
    var wakeAt: UInt64? { refined ? nil : changedAt.map { $0 + idleNs } }
    /// Whether the refine is due now.
    func due(at now: UInt64) -> Bool {
        guard !refined, let changedAt else { return false }
        return now >= changedAt && now - changedAt >= idleNs
    }
    /// The refine went to the encoder.
    mutating func sent() { refined = true; attempts += 1 }
    /// The encoder dropped the refine: try again after another idle interval, a few times.
    mutating func dropped(at now: UInt64) {
        guard refined, changedAt != nil, attempts < maxAttempts else { return }
        changedAt = now; refined = false
    }
    /// The picture has held still since its refine: a keyframe asked for now should be refined too.
    var still: Bool { refined && changedAt != nil }
    /// The stream restarted (new size, codec or viewer): nothing is pending.
    mutating func reset() { changedAt = nil; refined = true; attempts = 0 }
}
