import SwiftUI

/// A provider's bare mark at `size` points (`ProviderMarks.generated.swift`). Brand colours stay
/// where the mark has them; a mono mark takes the surrounding foreground style. A provider
/// without a mark draws ace's neutral agent glyph, never a lookalike.
struct ProviderMark: View {
    let provider: String
    var size: CGFloat = 18
    var body: some View {
        Group {
            if let art = ProviderMarks.art(provider) {
                ZStack {
                    ForEach(Array(art.paths.enumerated()), id: \.offset) { _, path in
                        let shape = MarkShape(art: art, path: path)
                        if let fill = path.fill {
                            shape.fill(Color(red: Double((fill >> 16) & 255) / 255, green: Double((fill >> 8) & 255) / 255, blue: Double(fill & 255) / 255),
                                       style: FillStyle(eoFill: path.evenOdd))
                                .opacity(path.opacity)
                        } else {
                            shape.fill(style: FillStyle(eoFill: path.evenOdd)).opacity(path.opacity)
                        }
                    }
                }
            } else {
                Image(systemName: "sparkle").resizable().scaledToFit().padding(size * 0.08)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// One path of a mark, scaled from its view box into the frame.
private struct MarkShape: Shape {
    let art: ProviderMarks.Art
    let path: ProviderMarks.Path
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / art.width, rect.height / art.height)
        let transform = CGAffineTransform(translationX: rect.midX - art.width * scale / 2, y: rect.midY - art.height * scale / 2)
            .scaledBy(x: scale, y: scale).translatedBy(x: -art.x, y: -art.y)
        return MarkPath.parse(path.d).applying(transform)
    }
}

/// A mark outline from its generated path data: absolute M, L, C, Q and Z only, a few hundred
/// numbers at most, so reading it again on layout costs little.
private enum MarkPath {
    static func parse(_ d: String) -> Path {
        var path = Path()
        var tokens = d.split(separator: " ")[...]
        func point() -> CGPoint? {
            guard let x = tokens.popFirst().flatMap({ Double($0) }), let y = tokens.popFirst().flatMap({ Double($0) }) else { return nil }
            return CGPoint(x: x, y: y)
        }
        while let command = tokens.popFirst() {
            switch command {
            case "M": if let p = point() { path.move(to: p) }
            case "L": if let p = point() { path.addLine(to: p) }
            case "C": if let c1 = point(), let c2 = point(), let p = point() { path.addCurve(to: p, control1: c1, control2: c2) }
            case "Q": if let c = point(), let p = point() { path.addQuadCurve(to: p, control: c) }
            case "Z": path.closeSubpath()
            default: return path
            }
        }
        return path
    }
}
