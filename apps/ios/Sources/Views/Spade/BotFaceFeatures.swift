import SwiftUI

/// Resolved SwiftUI colours for one bot face pair and colour scheme.
struct BotFaceColors: Sendable {
    let palette: BotFacePalette

    init(pair: BotFace.Pair, dark: Bool) {
        self.palette = BotFaceGeometry.palette(for: pair, dark: dark)
    }

    func color(for tone: BotFaceTone) -> Color {
        let hex: UInt32
        switch tone {
        case .body: hex = palette.body
        case .accent: hex = palette.accent
        case .bodyShade: hex = palette.bodyShade
        case .accentShade: hex = palette.accentShade
        case .pale: hex = palette.pale
        case .visor: hex = palette.visor
        case .mask: hex = palette.mask
        case .blush: hex = palette.blush
        case .tongue: hex = palette.tongue
        case .ink: hex = BotFaceGeometry.ink
        case .paper: hex = BotFaceGeometry.paper
        case .sweat: hex = BotFaceGeometry.sweat
        }
        return Color(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// Eye placement and pupil reach on a body (`ui-core/bot-face/draw-shared.ts`).
struct BotFaceEyeLayout: Sendable {
    let shape: BotFaceEyeMetrics
    let tier: BotFaceTier
    let pupilRx: CGFloat
    let pupilRy: CGFloat
    let reachX: CGFloat
    let reachY: CGFloat
    let y: CGFloat
    let xs: [CGFloat]

    init(eyes: BotFace.Eyes, tier: BotFaceTier, body: BotFaceBodyMetrics) {
        let s = BotFaceGeometry.eye(eyes)
        let small = tier == .s
        let pRx = s.rx * (small ? 0.56 : 0.5)
        let pRy = s.ry * (small ? 0.52 : 0.47)
        let pad: CGFloat = small ? 0.02 : 0.22
        self.shape = s
        self.tier = tier
        self.pupilRx = pRx
        self.pupilRy = pRy
        self.reachX = max(0.3, s.rx - pRx - pad)
        self.reachY = max(0.3, s.ry - pRy - pad)
        self.y = body.eyeY + s.dy
        let span = s.dx * body.eyeScale
        self.xs = [12 - span, 12 + span]
    }
}

/// Pure `GraphicsContext` drawing helpers on the shared 24-unit bot face box.
enum BotFaceFeatures {
    static func drawPiece(
        _ piece: BotFacePiece,
        in context: GraphicsContext,
        colors: BotFaceColors,
        clip: Path
    ) {
        var ctx = context
        if piece.clipped { ctx.clip(to: clip) }
        if let rot = piece.rotate {
            ctx.translateBy(x: rot.cx, y: rot.cy)
            ctx.rotate(by: .degrees(rot.degrees))
            ctx.translateBy(x: -rot.cx, y: -rot.cy)
        }
        if let fill = piece.fill {
            let color = colors.color(for: fill).opacity(piece.fillOpacity)
            ctx.fill(piece.path, with: .color(color))
        }
        if let stroke = piece.stroke {
            let color = colors.color(for: stroke.tone).opacity(stroke.opacity)
            let style = StrokeStyle(
                lineWidth: stroke.width,
                lineCap: stroke.roundCap ? .round : .butt,
                lineJoin: stroke.roundJoin ? .round : .miter
            )
            ctx.stroke(piece.path, with: .color(color), style: style)
        }
    }

    static func eggPath(cx: CGFloat, cy: CGFloat, rx: CGFloat, ry: CGFloat) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: cx, y: cy - ry))
        path.addCurve(
            to: CGPoint(x: cx + rx, y: cy + ry * 0.12),
            control1: CGPoint(x: cx + rx * 0.78, y: cy - ry),
            control2: CGPoint(x: cx + rx, y: cy - ry * 0.36)
        )
        path.addCurve(
            to: CGPoint(x: cx, y: cy + ry),
            control1: CGPoint(x: cx + rx, y: cy + ry * 0.66),
            control2: CGPoint(x: cx + rx * 0.58, y: cy + ry)
        )
        path.addCurve(
            to: CGPoint(x: cx - rx, y: cy + ry * 0.12),
            control1: CGPoint(x: cx - rx * 0.58, y: cy + ry),
            control2: CGPoint(x: cx - rx, y: cy + ry * 0.66)
        )
        path.addCurve(
            to: CGPoint(x: cx, y: cy - ry),
            control1: CGPoint(x: cx - rx, y: cy - ry * 0.36),
            control2: CGPoint(x: cx - rx * 0.78, y: cy - ry)
        )
        path.closeSubpath()
        return path
    }

    static func drawDynamicMarking(
        _ kind: BotFace.Marking,
        eyes: BotFaceEyeLayout,
        body: BotFaceBodyMetrics,
        in context: GraphicsContext,
        colors: BotFaceColors
    ) {
        let s = eyes.shape
        switch kind {
        case .mask:
            let halfW = s.dx + s.rx + 1.6
            let r = s.ry * 0.62
            let rect = CGRect(x: 12 - halfW, y: eyes.y - r, width: halfW * 2, height: s.ry * 1.25)
            context.fill(Path(roundedRect: rect, cornerSize: CGSize(width: r, height: r)), with: .color(colors.color(for: .mask)))
        case .muzzle:
            let ry = 22.6 - body.mouthY + 0.6
            let rect = CGRect(x: 12 - 7.4, y: body.mouthY + 1.6 - ry, width: 14.8, height: ry * 2)
            context.fill(Path(ellipseIn: rect), with: .color(colors.color(for: .pale)))
        case .patch:
            let rx = s.rx + 2.1
            let ry = s.ry + 1.9
            let rect = CGRect(x: 12 - s.dx - rx, y: eyes.y - ry, width: rx * 2, height: ry * 2)
            context.fill(Path(ellipseIn: rect), with: .color(colors.color(for: .accent)))
        default:
            break
        }
    }

    static func drawCheeks(
        _ kind: BotFace.Cheeks,
        tier: BotFaceTier,
        body: BotFaceBodyMetrics,
        in context: GraphicsContext,
        colors: BotFaceColors
    ) {
        guard kind != .none, tier != .s else { return }
        let y = body.cheekY
        let dx = body.cheekDx
        if kind == .blush {
            let fill = GraphicsContext.Shading.color(colors.color(for: .blush))
            context.fill(Path(ellipseIn: CGRect(x: 12 - dx - 1.9, y: y - 1.1, width: 3.8, height: 2.2)), with: fill)
            context.fill(Path(ellipseIn: CGRect(x: 12 + dx - 1.9, y: y - 1.1, width: 3.8, height: 2.2)), with: fill)
            return
        }
        let fill = GraphicsContext.Shading.color(colors.color(for: .bodyShade))
        if tier == .m {
            dot(cx: 12 - dx, cy: y, r: 0.55, in: context, with: fill)
            dot(cx: 12 + dx, cy: y, r: 0.55, in: context, with: fill)
            return
        }
        for cx in [12 - dx, 12 + dx] {
            dot(cx: cx - 0.9, cy: y - 0.2, r: 0.42, in: context, with: fill)
            dot(cx: cx + 0.5, cy: y - 0.5, r: 0.38, in: context, with: fill)
            dot(cx: cx, cy: y + 0.7, r: 0.4, in: context, with: fill)
        }
    }

    static func drawEyes(
        layout: BotFaceEyeLayout,
        body: BotFaceBodyMetrics,
        pupilFrac: CGPoint,
        pupilScale: CGFloat,
        eyeScale: CGSize,
        lid: CGFloat,
        happy: Bool,
        in context: GraphicsContext,
        colors: BotFaceColors
    ) {
        let s = layout.shape
        let ring = BotFaceGeometry.ring(for: layout.tier)
        let ink = colors.color(for: .ink)
        let paper = colors.color(for: .paper)
        let y = layout.y

        for x in layout.xs {
            if happy {
                let half = s.rx * 0.95
                var arc = Path()
                arc.move(to: CGPoint(x: x - half, y: y + 0.8))
                arc.addQuadCurve(to: CGPoint(x: x + half, y: y + 0.8), control: CGPoint(x: x, y: y - s.ry))
                context.stroke(arc, with: .color(ink), style: StrokeStyle(lineWidth: ring * 2 + 1.5, lineCap: .round))
                context.stroke(arc, with: .color(paper), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                continue
            }
            var eyeCtx = context
            if eyeScale.width != 1 || eyeScale.height != 1 {
                eyeCtx.translateBy(x: x, y: y)
                eyeCtx.scaleBy(x: eyeScale.width, y: eyeScale.height)
                eyeCtx.translateBy(x: -x, y: -y)
            }
            let outer = eggPath(cx: x, cy: y, rx: s.rx + ring, ry: s.ry + ring)
            let inner = eggPath(cx: x, cy: y, rx: s.rx, ry: s.ry)
            eyeCtx.fill(outer, with: .color(ink))
            eyeCtx.fill(inner, with: .color(paper))

            var clipped = eyeCtx
            clipped.clip(to: inner)

            let px = x + layout.reachX * pupilFrac.x
            let py = y + layout.reachY * pupilFrac.y
            let pRx = layout.pupilRx * pupilScale
            let pRy = layout.pupilRy * pupilScale
            clipped.fill(Path(ellipseIn: CGRect(x: px - pRx, y: py - pRy, width: pRx * 2, height: pRy * 2)), with: .color(ink))
            if layout.tier == .l {
                dot(cx: px + pRx * 0.36, cy: py - pRy * 0.4, r: pRx * 0.34, in: clipped, with: .color(paper))
                dot(cx: px - pRx * 0.42, cy: py + pRy * 0.45, r: pRx * 0.14, in: clipped, with: .color(paper.opacity(0.8)))
            } else if layout.tier == .m {
                dot(cx: px + pRx * 0.34, cy: py - pRy * 0.38, r: pRx * 0.32, in: clipped, with: .color(paper))
            }

            if lid > 0 {
                let top = y - s.ry
                let height = s.ry * 2
                let lidY = top + height * lid
                let rect = CGRect(x: x - s.rx - 1, y: top - 0.2, width: s.rx * 2 + 2, height: lidY - top + 0.2)
                clipped.fill(Path(rect), with: .color(colors.color(for: body.lid)))
                var line = Path()
                line.move(to: CGPoint(x: x - s.rx - 1, y: lidY))
                line.addLine(to: CGPoint(x: x + s.rx + 1, y: lidY))
                clipped.stroke(line, with: .color(ink), lineWidth: ring * 0.95)
            }
        }
    }

    enum RenderedMouth { case smile, open, cat, o, grin, frown }

    static func drawMouth(
        _ mouth: RenderedMouth,
        tier: BotFaceTier,
        y: CGFloat,
        in context: GraphicsContext,
        colors: BotFaceColors
    ) {
        let w = BotFaceGeometry.line(for: tier)
        let ink = colors.color(for: .ink)
        switch mouth {
        case .smile:
            var path = Path()
            path.move(to: CGPoint(x: 10.3, y: y))
            path.addQuadCurve(to: CGPoint(x: 13.7, y: y), control: CGPoint(x: 12, y: y + 1.8))
            context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: w, lineCap: .round))
        case .open:
            var path = Path()
            path.move(to: CGPoint(x: 9.9, y: y - 0.3))
            path.addQuadCurve(to: CGPoint(x: 14.1, y: y - 0.3), control: CGPoint(x: 12, y: y))
            path.addQuadCurve(to: CGPoint(x: 12, y: y + 2.5), control: CGPoint(x: 13.9, y: y + 2.5))
            path.addQuadCurve(to: CGPoint(x: 9.9, y: y - 0.3), control: CGPoint(x: 10.1, y: y + 2.5))
            path.closeSubpath()
            context.fill(path, with: .color(ink))
            if tier != .s {
                var tongue = Path()
                tongue.move(to: CGPoint(x: 10.9, y: y + 1.9))
                tongue.addQuadCurve(to: CGPoint(x: 13.1, y: y + 1.9), control: CGPoint(x: 12, y: y + 1))
                tongue.addQuadCurve(to: CGPoint(x: 12, y: y + 2.4), control: CGPoint(x: 12.6, y: y + 2.4))
                tongue.addQuadCurve(to: CGPoint(x: 10.9, y: y + 1.9), control: CGPoint(x: 11.4, y: y + 2.4))
                tongue.closeSubpath()
                context.fill(tongue, with: .color(colors.color(for: .tongue)))
            }
        case .cat:
            var path = Path()
            path.move(to: CGPoint(x: 9.9, y: y))
            path.addQuadCurve(to: CGPoint(x: 12, y: y), control: CGPoint(x: 10.95, y: y + 1.4))
            path.addQuadCurve(to: CGPoint(x: 14.1, y: y), control: CGPoint(x: 13.05, y: y + 1.4))
            context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round))
        case .o:
            context.fill(Path(ellipseIn: CGRect(x: 11.05, y: y - 0.65, width: 1.9, height: 2.3)), with: .color(ink))
        case .grin:
            var path = Path()
            path.move(to: CGPoint(x: 9.6, y: y - 0.2))
            path.addQuadCurve(to: CGPoint(x: 14.4, y: y - 0.2), control: CGPoint(x: 12, y: y + 0.3))
            path.addQuadCurve(to: CGPoint(x: 12, y: y + 2.3), control: CGPoint(x: 14, y: y + 2.3))
            path.addQuadCurve(to: CGPoint(x: 9.6, y: y - 0.2), control: CGPoint(x: 10, y: y + 2.3))
            path.closeSubpath()
            context.fill(path, with: .color(ink))
            if tier != .s {
                let tooth = CGRect(x: 11.35, y: y, width: 1.3, height: 0.95)
                context.fill(Path(roundedRect: tooth, cornerSize: CGSize(width: 0.25, height: 0.25)), with: .color(colors.color(for: .paper)))
            }
        case .frown:
            var path = Path()
            path.move(to: CGPoint(x: 10.4, y: y + 1.3))
            path.addQuadCurve(to: CGPoint(x: 13.6, y: y + 1.3), control: CGPoint(x: 12, y: y - 0.2))
            context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: w, lineCap: .round))
        }
    }

    static func dot(cx: CGFloat, cy: CGFloat, r: CGFloat, in context: GraphicsContext, with shading: GraphicsContext.Shading) {
        context.fill(Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)), with: shading)
    }
}
