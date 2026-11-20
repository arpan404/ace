import SwiftUI

/// Dynamic accessory and state-extra drawing on the 24-unit bot face box (`ui-core/bot-face`).
extension BotFaceFeatures {
    enum AccessoryLayer { case back, front, over }

    static func drawAccessory(
        _ kind: BotFace.Accessory,
        layer: AccessoryLayer,
        tier: BotFaceTier,
        body: BotFaceBodyMetrics,
        eyes: BotFaceEyeLayout,
        clip: Path,
        in context: GraphicsContext,
        colors: BotFaceColors
    ) {
        let tx = body.top.x
        let ty = body.top.y
        switch (kind, layer) {
        case (.headphones, .back):
            var band = Path()
            band.move(to: CGPoint(x: body.left + 0.6, y: 11.4))
            band.addCurve(
                to: CGPoint(x: body.right - 0.6, y: 11.4),
                control1: CGPoint(x: body.left + 0.6, y: ty - 3),
                control2: CGPoint(x: body.right - 0.6, y: ty - 3)
            )
            context.stroke(
                band,
                with: .color(colors.color(for: .accentShade)),
                style: StrokeStyle(lineWidth: tier == .s ? 1.7 : 1.35, lineCap: .round)
            )
        case (.headphones, .front):
            for cx in [body.left + 0.4, body.right - 0.4] {
                let cup = CGRect(x: cx - 2, y: 9.6, width: 4, height: 7.2)
                context.fill(Path(roundedRect: cup, cornerSize: CGSize(width: 2, height: 2)), with: .color(colors.color(for: .accent)))
                if tier == .l {
                    let glint = CGRect(x: cx - 1.1, y: 10.6, width: 1, height: 3.4)
                    context.fill(Path(roundedRect: glint, cornerSize: CGSize(width: 0.5, height: 0.5)), with: .color(colors.color(for: .paper).opacity(0.35)))
                }
            }
        case (.beanie, .front):
            let fold = ty + 5.6
            dot(cx: tx, cy: ty - 0.6, r: tier == .s ? 1.9 : 1.7, in: context, with: .color(colors.color(for: .accent)))
            var clipped = context
            clipped.clip(to: clip)
            clipped.fill(Path(CGRect(x: 0, y: 0, width: 24, height: fold)), with: .color(colors.color(for: .accent)))
            clipped.fill(Path(CGRect(x: 0, y: fold - 1.8, width: 24, height: 1.8)), with: .color(colors.color(for: .accentShade)))
            if tier == .l {
                var ribs = Path()
                for (rx, dy) in [(7.0, 1.6), (10.0, 0.8), (13.0, 0.6), (16.0, 1.2)] as [(CGFloat, CGFloat)] {
                    ribs.move(to: CGPoint(x: rx, y: ty + dy))
                    ribs.addLine(to: CGPoint(x: rx, y: fold - 2.2))
                }
                clipped.stroke(ribs, with: .color(colors.color(for: .accentShade).opacity(0.7)), lineWidth: 0.5)
            }
        case (.scarf, .front):
            for piece in BotFaceGeometry.scarf(tier: tier) {
                drawPiece(piece, in: context, colors: colors, clip: clip)
            }
        case (.glasses, .over):
            let ring = BotFaceGeometry.ring(for: tier)
            let gx = eyes.shape.rx + ring + 0.75
            let gy = eyes.shape.ry + ring + 0.55
            let w: CGFloat = tier == .s ? 1.05 : 0.8
            let ink = colors.color(for: .ink)
            var arms = Path()
            arms.move(to: CGPoint(x: eyes.xs[0] - gx, y: eyes.y - 0.8))
            arms.addLine(to: CGPoint(x: body.left + 0.3, y: eyes.y - 0.8))
            arms.move(to: CGPoint(x: eyes.xs[1] + gx, y: eyes.y - 0.8))
            arms.addLine(to: CGPoint(x: body.right - 0.3, y: eyes.y - 0.8))
            context.stroke(arms, with: .color(ink), style: StrokeStyle(lineWidth: w, lineCap: .round))
            for x in eyes.xs {
                let lens = eggPath(cx: x, cy: eyes.y, rx: gx, ry: gy)
                if tier == .l { context.fill(lens, with: .color(colors.color(for: .paper).opacity(0.12))) }
                context.stroke(lens, with: .color(ink), lineWidth: w)
            }
        case (.bow, .over):
            let bx = tx + 5
            let by = ty + 2.6
            var rot = context
            rot.translateBy(x: bx, y: by)
            rot.rotate(by: .degrees(16))
            rot.translateBy(x: -bx, y: -by)
            for s in [-1.0, 1.0] as [CGFloat] {
                var wing = Path()
                wing.move(to: CGPoint(x: bx, y: by))
                wing.addCurve(to: CGPoint(x: bx + s * 4, y: by), control1: CGPoint(x: bx + s * 1.6, y: by - 2.5), control2: CGPoint(x: bx + s * 4.3, y: by - 2.3))
                wing.addCurve(to: CGPoint(x: bx, y: by), control1: CGPoint(x: bx + s * 4.3, y: by + 2.3), control2: CGPoint(x: bx + s * 1.6, y: by + 2.5))
                wing.closeSubpath()
                rot.fill(wing, with: .color(colors.color(for: .accent)))
            }
            if tier != .s {
                var crease = Path()
                crease.move(to: CGPoint(x: bx - 3.6, y: by + 0.5))
                crease.addCurve(to: CGPoint(x: bx, y: by), control1: CGPoint(x: bx - 2.6, y: by + 1.6), control2: CGPoint(x: bx - 1.2, y: by + 1.4))
                crease.addCurve(to: CGPoint(x: bx + 3.6, y: by + 0.5), control1: CGPoint(x: bx + 1.2, y: by + 1.4), control2: CGPoint(x: bx + 2.6, y: by + 1.6))
                rot.stroke(crease, with: .color(colors.color(for: .accentShade)), lineWidth: 0.6)
            }
            dot(cx: bx, cy: by, r: 1.2, in: rot, with: .color(colors.color(for: .accentShade)))
        case (.flower, .over):
            let fx = tx + 5.4
            let fy = ty + 1.6
            let petal = Path(ellipseIn: CGRect(x: fx - 1.15, y: fy - 1.45 - 1.5, width: 2.3, height: 3))
            let paper = GraphicsContext.Shading.color(colors.color(for: .paper))
            for deg in [0.0, 72.0, 144.0, 216.0, 288.0] {
                var rot = context
                rot.translateBy(x: fx, y: fy)
                rot.rotate(by: .degrees(deg))
                rot.translateBy(x: -fx, y: -fy)
                rot.fill(petal, with: paper)
            }
            dot(cx: fx, cy: fy, r: 1.05, in: context, with: .color(colors.color(for: .accent)))
        default:
            break
        }
    }

    static func drawSweat(body: BotFaceBodyMetrics, tier: BotFaceTier, in context: GraphicsContext, colors: BotFaceColors) {
        guard tier != .s else { return }
        let sx = body.right - 2.2
        let sy = body.eyeY - 6.2
        let k: CGFloat = 0.7732
        var drop = Path()
        drop.move(to: CGPoint(x: sx, y: sy))
        drop.addCurve(to: CGPoint(x: sx + 1.4, y: sy + 2.9), control1: CGPoint(x: sx + 1.2, y: sy + 1.6), control2: CGPoint(x: sx + 1.4, y: sy + 2.4))
        drop.addCurve(to: CGPoint(x: sx, y: sy + 4.3), control1: CGPoint(x: sx + 1.4, y: sy + 2.9 + k), control2: CGPoint(x: sx + k, y: sy + 4.3))
        drop.addCurve(to: CGPoint(x: sx - 1.4, y: sy + 2.9), control1: CGPoint(x: sx - k, y: sy + 4.3), control2: CGPoint(x: sx - 1.4, y: sy + 2.9 + k))
        drop.addCurve(to: CGPoint(x: sx, y: sy), control1: CGPoint(x: sx - 1.4, y: sy + 2.4), control2: CGPoint(x: sx - 1.2, y: sy + 1.6))
        drop.closeSubpath()
        context.fill(drop, with: .color(colors.color(for: .sweat)))
        context.stroke(drop, with: .color(colors.color(for: .ink)), lineWidth: 0.55)
    }
}
