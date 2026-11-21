import CoreGraphics
import Foundation
import SwiftUI

/// Native SwiftUI renderer for a Spade bot's character face (`@ace/ui-core/bot-face`).
/// Draws the generated 24-unit geometry and palettes in a `Canvas` with an unclipped overflow
/// margin so tall ears, sprouts, headphones and scarves extend outside the box as on web.
struct BotFaceView: View {
    let face: BotFace
    var size: CGFloat = AceDesign.Size.tap - AceDesign.Space.tight
    var pose: BotFacePose = .idle

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var animating: Bool { pose.isMoving && !reduceMotion && scenePhase == .active }

    var body: some View {
        let pad = size * 0.25
        Color.clear
            .frame(width: size, height: size)
            .overlay {
                Group {
                    if animating {
                        TimelineView(BotFaceMotion.Schedule(thinking: pose == .thinking)) { context in
                            let seconds = context.date.timeIntervalSinceReferenceDate
                            let sample: BotFaceMotion.Sample? = context.cadence == .live
                                ? BotFaceMotion.sample(at: seconds, thinking: pose == .thinking)
                                : nil
                            canvas(pad: pad, motion: sample)
                        }
                    } else {
                        canvas(pad: pad, motion: nil)
                    }
                }
                .frame(width: size + pad * 2, height: size + pad * 2)
                .allowsHitTesting(false)
            }
    }

    private func canvas(pad: CGFloat, motion: BotFaceMotion.Sample?) -> some View {
        let dark = colorScheme == .dark
        let tier = BotFaceTier(size: size)
        let currentFace = face
        let currentPose = pose
        let boxSize = size
        return Canvas { context, _ in
            BotFaceRenderer.draw(
                face: currentFace,
                tier: tier,
                pose: currentPose,
                dark: dark,
                motion: motion,
                scale: boxSize / 24,
                pad: pad,
                in: context
            )
        }
    }
}

/// Pure 24-unit canvas renderer matching `packages/ui-core/src/bot-face/draw-face.ts`.
enum BotFaceRenderer {
    static func draw(
        face: BotFace,
        tier: BotFaceTier,
        pose: BotFacePose,
        dark: Bool,
        motion: BotFaceMotion.Sample?,
        scale: CGFloat,
        pad: CGFloat,
        in root: GraphicsContext
    ) {
        let colors = BotFaceColors(pair: face.pair, dark: dark)
        let body = BotFaceGeometry.body(face.body)
        let silhouette = BotFaceGeometry.silhouette(face.body, tier: tier)
        let eyes = BotFaceEyeLayout(eyes: face.eyes, tier: tier, body: body)
        let state = BotFacePoseStyle.resolve(pose: pose, face: face, restingLid: eyes.shape.lid, motion: motion)

        var ctx = root
        ctx.translateBy(x: pad, y: pad)
        ctx.scaleBy(x: scale, y: scale)

        // Whole-face tilt (-4° about 12, 12) + head pose about (12, 22).
        ctx.translateBy(x: 12, y: 12)
        ctx.rotate(by: .degrees(BotFaceGeometry.tilt))
        ctx.translateBy(x: -12, y: -12)

        if state.headDy != 0 || state.headRotate != 0 || state.headScaleX != 1 || state.headScaleY != 1 {
            ctx.translateBy(x: 12, y: 22)
            if state.headDy != 0 { ctx.translateBy(x: 0, y: state.headDy) }
            if state.headRotate != 0 { ctx.rotate(by: .degrees(state.headRotate)) }
            if state.headScaleX != 1 || state.headScaleY != 1 {
                ctx.scaleBy(x: state.headScaleX, y: state.headScaleY)
            }
            ctx.translateBy(x: -12, y: -22)
        }

        let topDy = body.top.y - 1.4

        // 1. Ears behind body
        if face.ears != .none {
            var earCtx = ctx
            earCtx.translateBy(x: 0, y: topDy)
            for piece in BotFaceGeometry.earBack(face.ears, tier: tier) {
                BotFaceFeatures.drawPiece(piece, in: earCtx, colors: colors, clip: silhouette)
            }
        }

        // 2. Body back + accessory back
        for piece in BotFaceGeometry.bodyBack(face.body, tier: tier) {
            BotFaceFeatures.drawPiece(piece, in: ctx, colors: colors, clip: silhouette)
        }
        BotFaceFeatures.drawAccessory(face.accessory, layer: .back, tier: tier, body: body, eyes: eyes, clip: silhouette, in: ctx, colors: colors)

        // 3. Body volume (shade + shifted body fill + top specular highlight)
        ctx.fill(silhouette, with: .color(colors.color(for: .bodyShade)))
        var bodyFill = ctx
        bodyFill.clip(to: silhouette)
        let dx: CGFloat = tier == .s ? -0.35 : -0.6
        let dy: CGFloat = tier == .s ? -0.8 : -1.05
        bodyFill.translateBy(x: dx, y: dy)
        bodyFill.fill(silhouette, with: .color(colors.color(for: .body)))
        if tier != .s {
            let rx: CGFloat = tier == .l ? 2.6 : 2.2
            let ry: CGFloat = tier == .l ? 1.25 : 1.05
            var lightCtx = ctx
            lightCtx.translateBy(x: body.light.x, y: body.light.y)
            lightCtx.rotate(by: .degrees(-32))
            lightCtx.translateBy(x: -body.light.x, y: -body.light.y)
            let rect = CGRect(x: body.light.x - rx, y: body.light.y - ry, width: rx * 2, height: ry * 2)
            lightCtx.fill(Path(ellipseIn: rect), with: .color(colors.color(for: .paper).opacity(0.26)))
        }

        // 4. Inner ears + body front
        if face.ears != .none {
            var earCtx = ctx
            earCtx.translateBy(x: 0, y: topDy)
            for piece in BotFaceGeometry.earInner(face.ears, tier: tier) {
                BotFaceFeatures.drawPiece(piece, in: earCtx, colors: colors, clip: silhouette)
            }
        }
        for piece in BotFaceGeometry.bodyFront(face.body, tier: tier) {
            BotFaceFeatures.drawPiece(piece, in: ctx, colors: colors, clip: silhouette)
        }

        // 5. Marking (always clipped to silhouette)
        if face.marking != .none {
            var markCtx = ctx
            markCtx.clip(to: silhouette)
            switch face.marking {
            case .cap, .stripes, .spots:
                markCtx.translateBy(x: 0, y: topDy)
                for piece in BotFaceGeometry.staticMarking(face.marking, tier: tier) {
                    BotFaceFeatures.drawPiece(piece, in: markCtx, colors: colors, clip: silhouette)
                }
            case .mask, .muzzle, .patch:
                BotFaceFeatures.drawDynamicMarking(face.marking, eyes: eyes, body: body, in: markCtx, colors: colors)
            case .none:
                break
            }
        }

        // 6. Accessory front + cheeks + eyes + body over + mouth + accessory over + state extras
        BotFaceFeatures.drawAccessory(face.accessory, layer: .front, tier: tier, body: body, eyes: eyes, clip: silhouette, in: ctx, colors: colors)
        BotFaceFeatures.drawCheeks(face.cheeks, tier: tier, body: body, in: ctx, colors: colors)
        BotFaceFeatures.drawEyes(
            layout: eyes,
            body: body,
            pupilFrac: state.pupilFrac,
            pupilScale: state.pupilScale,
            eyeScale: state.eyeScale,
            lid: state.lid,
            happy: state.happy,
            in: ctx,
            colors: colors
        )
        for piece in BotFaceGeometry.bodyOver(face.body, tier: tier) {
            BotFaceFeatures.drawPiece(piece, in: ctx, colors: colors, clip: silhouette)
        }
        if body.hasMouth, let mouth = state.mouth {
            BotFaceFeatures.drawMouth(mouth, tier: tier, y: body.mouthY, in: ctx, colors: colors)
        }
        BotFaceFeatures.drawAccessory(face.accessory, layer: .over, tier: tier, body: body, eyes: eyes, clip: silhouette, in: ctx, colors: colors)
        if state.sweat {
            BotFaceFeatures.drawSweat(body: body, tier: tier, in: ctx, colors: colors)
        }
    }
}

/// Held pose parameters per `BotFacePose` (`apps/web/src/styles/bot-face.css`).
struct BotFacePoseStyle: Sendable {
    var headDy: CGFloat = 0
    var headRotate: Double = 0
    var headScaleX: CGFloat = 1
    var headScaleY: CGFloat = 1
    var eyeScale = CGSize(width: 1, height: 1)
    var pupilFrac = CGPoint(x: -0.2, y: 0.98)
    var pupilScale: CGFloat = 1
    var lid: CGFloat = 0
    var happy = false
    var sweat = false
    var mouth: BotFaceFeatures.RenderedMouth?

    static func resolve(
        pose: BotFacePose,
        face: BotFace,
        restingLid: CGFloat,
        motion: BotFaceMotion.Sample?
    ) -> BotFacePoseStyle {
        var style = BotFacePoseStyle(lid: restingLid, mouth: ownMouth(face.mouth))
        switch pose {
        case .idle:
            break
        case .working:
            style.headRotate = 2.5
            style.pupilFrac = motion?.pupilFrac ?? CGPoint(x: 0.45, y: 0.7)
            if let open = motion?.blinkOpen, open < 1 { style.eyeScale.height *= open }
        case .thinking:
            style.headRotate = -3
            style.lid = max(restingLid, 0.2)
            style.pupilFrac = motion?.pupilFrac ?? CGPoint(x: 0.6, y: -0.8)
            if let open = motion?.blinkOpen, open < 1 { style.eyeScale.height *= open }
        case .needsYou:
            style.headDy = -0.7
            style.headRotate = 7
            style.eyeScale = CGSize(width: 1.07, height: 1.12)
            style.pupilFrac = CGPoint(x: 0.1, y: -0.8)
            style.pupilScale = 1.24
            style.lid = restingLid * 0.3
            if face.mouth != .none { style.mouth = .o }
        case .blocked:
            style.headDy = 0.5
            style.headScaleX = 1.02
            style.headScaleY = 0.97
            style.pupilFrac = CGPoint(x: -0.15, y: 1)
            style.lid = 0.48
            style.sweat = true
            if face.mouth != .none { style.mouth = .frown }
        case .done:
            style.happy = true
            if face.mouth != .none {
                style.mouth = (face.mouth == .open || face.mouth == .grin) ? .open : .smile
            }
        case .sleeping:
            style.headDy = 0.6
            style.headRotate = -5
            style.pupilFrac = CGPoint(x: 0, y: 1)
            style.lid = 0.9
        }
        return style
    }

    private static func ownMouth(_ kind: BotFace.Mouth) -> BotFaceFeatures.RenderedMouth? {
        switch kind {
        case .none: nil
        case .smile: .smile
        case .open: .open
        case .cat: .cat
        case .o: .o
        case .grin: .grin
        }
    }
}

/// Pure pupil-dart and blink motion for working/thinking bot faces (`bot-face.css`), redrawing
/// only during movement windows just like `SpadeMotion`.
enum BotFaceMotion {
    struct Sample: Sendable, Equatable {
        let pupilFrac: CGPoint
        let blinkOpen: CGFloat
    }

    static let workDartCycle = 2.4
    static let workBlinkCycle = 4.8
    static let thinkCycle = 3.2
    static let frame = 1.0 / 60
    static let closed: CGFloat = 0.1

    private static let workDartMoves: [ClosedRange<Double>] = [0.22...0.27, 0.47...0.52, 0.72...0.77, 0.95...1.0]
    private static let workBlinkMoves: [ClosedRange<Double>] = [0.60...0.66]
    private static let thinkMoves: [ClosedRange<Double>] = [0.42...0.56, 0.88...1.0]

    static func sample(at seconds: Double, thinking: Bool) -> Sample {
        if thinking {
            let t = phase(seconds, thinkCycle)
            let p1 = CGPoint(x: -0.55, y: -0.8)
            let p2 = CGPoint(x: 0.6, y: -0.8)
            let pupil: CGPoint
            switch t {
            case ..<0.42: pupil = p1
            case ..<0.56: pupil = mix(p1, p2, easeInOut((t - 0.42) / 0.14))
            case ..<0.88: pupil = p2
            default: pupil = mix(p2, p1, easeInOut((t - 0.88) / 0.12))
            }
            return Sample(pupilFrac: pupil, blinkOpen: blink(t: t, start: 0.46, mid: 0.50, end: 0.54))
        }
        let d = phase(seconds, workDartCycle)
        let a = CGPoint(x: -0.7, y: 0.55)
        let b = CGPoint(x: 0.75, y: 0.45)
        let c = CGPoint(x: 0.2, y: 0.9)
        let e = CGPoint(x: -0.6, y: -0.1)
        let pupil: CGPoint
        switch d {
        case ..<0.22: pupil = a
        case ..<0.27: pupil = mix(a, b, easeOut((d - 0.22) / 0.05))
        case ..<0.47: pupil = b
        case ..<0.52: pupil = mix(b, c, easeOut((d - 0.47) / 0.05))
        case ..<0.72: pupil = c
        case ..<0.77: pupil = mix(c, e, easeOut((d - 0.72) / 0.05))
        case ..<0.95: pupil = e
        default: pupil = mix(e, a, easeOut((d - 0.95) / 0.05))
        }
        let bt = phase(seconds, workBlinkCycle)
        return Sample(pupilFrac: pupil, blinkOpen: blink(t: bt, start: 0.60, mid: 0.63, end: 0.66))
    }

    static func nextTick(after seconds: Double, thinking: Bool) -> Double {
        if thinking {
            return nextWindowTick(after: seconds, cycle: thinkCycle, moves: thinkMoves)
        }
        return min(
            nextWindowTick(after: seconds, cycle: workDartCycle, moves: workDartMoves),
            nextWindowTick(after: seconds, cycle: workBlinkCycle, moves: workBlinkMoves)
        )
    }

    struct Schedule: TimelineSchedule {
        let thinking: Bool
        func entries(from startDate: Date, mode: TimelineScheduleMode) -> UnfoldFirstSequence<Date> {
            sequence(first: startDate) { date in
                Date(timeIntervalSinceReferenceDate: BotFaceMotion.nextTick(after: date.timeIntervalSinceReferenceDate, thinking: thinking))
            }
        }
    }

    private static func nextWindowTick(after seconds: Double, cycle: Double, moves: [ClosedRange<Double>]) -> Double {
        let base = (seconds / cycle).rounded(.down) * cycle
        let windows = moves.map { (base + $0.lowerBound * cycle, base + $0.upperBound * cycle) }
            + [(base + cycle + moves[0].lowerBound * cycle, base + cycle + moves[0].upperBound * cycle)]
        for (start, end) in windows {
            if seconds < start { return start }
            if seconds < end { return min(seconds + frame, end) }
        }
        return base + cycle + moves[0].lowerBound * cycle
    }

    private static func blink(t: Double, start: Double, mid: Double, end: Double) -> CGFloat {
        switch t {
        case start..<mid: return 1 + (closed - 1) * easeInOut((t - start) / (mid - start))
        case mid..<end: return closed + (1 - closed) * easeInOut((t - mid) / (end - mid))
        default: return 1
        }
    }

    private static func phase(_ seconds: Double, _ cycle: Double) -> Double {
        let t = seconds.truncatingRemainder(dividingBy: cycle) / cycle
        return t < 0 ? t + 1 : t
    }

    private static func easeOut(_ t: Double) -> CGFloat {
        CGFloat(AnimationTiming.bezier(x1: 0.2, y1: 0.8, x2: 0.2, y2: 1, at: t))
    }

    private static func easeInOut(_ t: Double) -> CGFloat {
        CGFloat(AnimationTiming.bezier(x1: 0.42, y1: 0, x2: 0.58, y2: 1, at: t))
    }

    private static func mix(_ a: CGPoint, _ b: CGPoint, _ k: CGFloat) -> CGPoint {
        CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k)
    }
}
