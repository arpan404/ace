import SwiftUI

/// What an agent drives, in ace's own glyphs (the web's `ace-icons.tsx`), drawn from the shared
/// geometry (`AceGlyphs`, generated from `@ace/design-tokens/glyphs`). Each is decorative: the
/// row or step names what the agent uses in words. Computer use as a tool or setting is a named
/// icon (`.aceComputerUse`), generated into the icon catalogue from the same geometry.

/// The agent cursor as it appears over pages and apps, "the Pebble" (`AgentCursorIcon`): filled
/// with the person's accent, outlined in the colour that reads on it, with a soft shadow. Rows
/// mark a thread using computer use with it.
struct PebbleMark: View {
    @ScaledMetric private var size: CGFloat
    init(size: CGFloat = AceDesign.Size.rowPebble, relativeTo style: Font.TextStyle = .footnote) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
    }
    var body: some View {
        Canvas { context, canvas in
            let scale = canvas.width / AceGlyphs.box
            let pebble = AceGlyphs.cursor.applying(CGAffineTransform(scaleX: scale, y: scale))
            context.fill(pebble, with: .color(AceTheme.Colours.accent))
            context.stroke(pebble, with: .color(AceTheme.Colours.onAccent),
                           style: StrokeStyle(lineWidth: AceGlyphs.cursorOutline * scale, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .shadow(color: AceTheme.Colours.shadow.opacity(AceShadow.pebbleOpacity), radius: AceShadow.pebbleRadius, y: AceShadow.pebbleY)
        .accessibilityHidden(true)
    }
}

/// Browser use (`BrowserUseIcon`): a globe with the agent's pointer resting on its lower right,
/// the globe cut away around the pointer so the two read apart small. In the foreground style.
struct BrowserUseMark: View {
    @ScaledMetric private var size: CGFloat
    init(size: CGFloat = AceDesign.Size.rowStatus, relativeTo style: Font.TextStyle = .footnote) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
    }
    var body: some View {
        Canvas { context, canvas in
            let box = CGAffineTransform(scaleX: canvas.width / AceGlyphs.box, y: canvas.width / AceGlyphs.box)
            let pointer = AceGlyphMetrics.pointer(scale: AceGlyphs.browserUseScale, tip: AceGlyphs.browserUseTip).applying(box)
            let line = AceGlyphs.stroke * canvas.width / AceGlyphs.box
            context.drawLayer { layer in
                layer.stroke(AceGlyphs.browserUseGlobe.applying(box), with: .foreground,
                             style: StrokeStyle(lineWidth: line, lineCap: .round))
                layer.blendMode = .destinationOut
                layer.fill(pointer, with: .color(.black))
                layer.stroke(pointer, with: .color(.black),
                             style: StrokeStyle(lineWidth: line * AceGlyphs.browserUseKnockout, lineJoin: .round))
            }
            context.stroke(pointer, with: .foreground, style: StrokeStyle(lineWidth: line, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// ace's own tools (`AceToolIcon`): the ace mark, solid, a little inside its box so its filled
/// wings sit level with the outlined glyphs beside it in a list of steps.
struct AceToolMark: View {
    @ScaledMetric private var size: CGFloat
    init(size: CGFloat = AceDesign.Size.stepGlyph, relativeTo style: Font.TextStyle = .footnote) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
    }
    var body: some View {
        AceMark().frame(width: size * AceGlyphs.aceToolScale, height: size * AceGlyphs.aceToolScale)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

enum AceGlyphMetrics {
    /// The cursor on the 24 box, scaled by `scale` with its tip moved to `tip`.
    static func pointer(scale: CGFloat, tip: CGPoint) -> Path {
        let x = tip.x - AceGlyphs.cursorTip.x * scale
        let y = tip.y - AceGlyphs.cursorTip.y * scale
        return AceGlyphs.cursor.applying(CGAffineTransform(translationX: x, y: y).scaledBy(x: scale, y: scale))
    }
}
