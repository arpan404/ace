import SwiftUI
import UIKit

/// ace's design language on the iPhone (docs/design/design-language.md §3 and §5), as the one
/// set of values every view draws with. Views name a token from here; they never write a
/// radius, a gap, a font size, a colour or a curve of their own (a one-off value is a bug).
///
/// - Shape: full roundness. Controls are capsules; containers are concentric with the screen;
///   anything inside a container is concentric with it, ending in a capsule.
/// - Space: a 4-point grid; 16 at the side, 12 inside rows, 8 between related things, 24
///   between groups. Fixed row heights.
/// - Type: SF Pro with Dynamic Type, five roles on the system's own text styles, two weights.
/// - Surfaces: background, glass (only what floats), raised (sheets).
/// - Colour: grey ink in four tiers; status hues only on status icons; one accent.
/// - Motion: the system's spring; things leave faster than they came; nothing loops.
@MainActor enum AceDesign {

    // MARK: Shape

    @MainActor enum Shape {
        /// Buttons, pills, chips, tabs, the segmented control, the search field, + and Send/Stop,
        /// strip actions, status marks: always a capsule.
        static let control = Capsule(style: .continuous)
        /// A field that grows with its text (the composer's): a capsule while one line tall,
        /// then concentric with the container it sits in.
        static let field = TextCapsule(maxRadius: Corner.field)
        /// A container (the composer block, a strip, a floating bar, a grouped list, a sheet's
        /// content): concentric with the screen's corners, or with its own container.
        static var container: AnyShape {
            if #available(iOS 26, *) {
                return AnyShape(ConcentricRectangle(corners: .concentric(minimum: .fixed(Corner.containerFloor)), isUniform: true))
            }
            return AnyShape(RoundedRectangle(cornerRadius: Corner.device, style: .continuous))
        }
        /// A block on the page with no container around it (a code block, an image, a diff):
        /// concentric with the screen at the page's margin.
        static var block: AnyShape {
            if #available(iOS 26, *) {
                return AnyShape(ConcentricRectangle(corners: .concentric(minimum: .fixed(Corner.blockFloor)), isUniform: true))
            }
            return AnyShape(RoundedRectangle(cornerRadius: Corner.nested(in: Corner.device, inset: Space.margin), style: .continuous))
        }
        /// The person's message: a capsule for a short line, then concentric with the page.
        static let bubble = TextCapsule(maxRadius: Corner.field)
    }

    /// The radii the shapes above resolve to where the system can't work them out itself. Views
    /// never use these directly: they name a `Shape`.
    enum Corner {
        /// The iPhone's display corner, for systems before iOS 26's concentric shapes.
        static let device: CGFloat = 44
        /// The smallest a container's corner gets once concentric math runs out (deep nesting).
        static let containerFloor: CGFloat = 22
        /// A page block at the margin: the display corner less the margin, never sharper.
        static let blockFloor: CGFloat = 18
        /// A growing field's corner once it wraps: concentric inside the composer block.
        static let field: CGFloat = 22
        /// A drawn glyph's own corners (the Stop square, a file-status box).
        static let glyphStop: CGFloat = 2
        static let glyph: CGFloat = 6
        /// Inner radius = outer radius − the inset between them, never sharper than a capsule's
        /// smallest step.
        nonisolated static func nested(in outer: CGFloat, inset: CGFloat) -> CGFloat { max(outer - inset, 8) }
    }

    // MARK: Space

    enum Space {
        /// The grid.
        static let unit: CGFloat = 4
        /// Between a glyph and its words, inside a pill.
        static let tight: CGFloat = 4
        /// Between related things.
        static let related: CGFloat = 8
        /// Inside a row, top and bottom and between its lines' blocks.
        static let row: CGFloat = 12
        /// The one side margin, everywhere.
        static let margin: CGFloat = 16
        /// Between groups.
        static let group: CGFloat = 24
        /// Above a section or an empty state.
        static let section: CGFloat = 32
    }

    enum Size {
        /// The smallest a tap may land on.
        static let tap: CGFloat = 44
        /// A one-line row (chats, settings, menus).
        static let rowLine: CGFloat = 44
        /// A thread row: two lines.
        static let rowThread: CGFloat = 64
        /// A status icon or provider mark beside text.
        static let icon: CGFloat = 16
        /// An icon in a header button or the tab bar.
        static let barIcon: CGFloat = 20
        /// An empty state's glyph.
        static let emptyIcon: CGFloat = 28
        /// Spade's face in its tab.
        static let spade: CGFloat = 56
    }

    // MARK: Type

    /// Five roles, two weights, Dynamic Type through the system's own text styles: large title
    /// 34, title 17, body 15, meta 13, caption 11.
    enum Typeface {
        /// A place's name: Threads, Chats, More.
        static let largeTitle = Font.largeTitle
        /// Thread titles, message text, sheet titles.
        static let title = Font.body
        /// Row titles, answers, settings labels.
        static let body = Font.subheadline
        /// Project, branch, time, counts.
        static let meta = Font.footnote
        /// Tiny labels.
        static let caption = Font.caption2
        /// Code, commands, paths and branches only.
        static let code = Font.system(.footnote, design: .monospaced)
        static let codeBody = Font.system(.subheadline, design: .monospaced)
        /// The two weights.
        static let regular = Font.Weight.regular
        static let strong = Font.Weight.semibold
    }

    // MARK: Colour

    @MainActor enum Ink {
        /// Read this.
        static var primary: Color { AceTheme.Colours.foreground }
        /// Secondary.
        static var muted: Color { AceTheme.Colours.mutedForeground }
        /// Meta: time, branch, counts.
        static var subtle: Color { AceTheme.Colours.subtleForeground }
        /// Decorative only, never words.
        static var faint: Color { AceTheme.Colours.faintForeground }
        /// The one accent: the primary action (send, approve, the selected tab's fill).
        static var accent: Color { AceTheme.Colours.foreground }
        /// Provider marks in lists keep their colours at this strength.
        static let markOpacity: Double = 0.8
    }

    /// The status hues, only on status icons and the one sentence that states a state.
    @MainActor enum Status {
        static var needsYou: Color { AceTheme.RowStatus.needsYou }
        static var failed: Color { AceTheme.RowStatus.failed }
        static var working: Color { AceTheme.RowStatus.working }
        static var waiting: Color { AceTheme.RowStatus.waiting }
        static var background: Color { AceTheme.RowStatus.background }
        static var finished: Color { AceTheme.RowStatus.finished }
    }

    // MARK: Surfaces

    @MainActor enum Surface {
        /// Where content lives: flat.
        static var background: Color { AceTheme.Colours.background }
        /// Sheets and anything holding content above the page.
        static var raised: Color { AceTheme.Colours.card }
        /// A pressed or chosen fill on the page, never a box.
        static var fill: Color { AceTheme.Colours.fill }
    }

    // MARK: Motion

    enum Motion {
        /// Things arrive with the system's spring.
        static let arrive = Animation.spring
        /// …and leave faster than they came.
        static let leave = Animation.spring(duration: 0.25)
        /// Under Reduce Motion: a short fade only.
        static let reduced = Animation.easeInOut(duration: 0.15)
        static func arriving(_ reduce: Bool) -> Animation { reduce ? reduced : arrive }
        static func leaving(_ reduce: Bool) -> Animation { reduce ? reduced : leave }
    }

    /// Haptics confirm what the person did: send, approve, tab change, pull to refresh.
    enum Haptic {
        static let send = SensoryFeedback.impact(weight: .light)
        static let approve = SensoryFeedback.success
        static let tab = SensoryFeedback.selection
        static let refresh = SensoryFeedback.impact(weight: .light)
    }
}

extension View {
    /// The glass only floating things wear (tab bar, composer block, header buttons, the model
    /// and live pills), in `shape`. Never on a scrolling area, never inside other glass.
    func floatingGlass<S: Shape>(_ shape: S, interactive: Bool = true) -> some View {
        aceGlass(in: shape, interactive: interactive)
    }
    /// A sheet's raised surface.
    func raisedSurface() -> some View { background(AceDesign.Surface.raised) }
    /// Marks this view as the container that concentric shapes inside it follow.
    @ViewBuilder func concentricContainer() -> some View {
        if #available(iOS 26, *) {
            containerShape(RoundedRectangle(cornerRadius: AceDesign.Corner.containerFloor, style: .continuous))
        } else { self }
    }
}
