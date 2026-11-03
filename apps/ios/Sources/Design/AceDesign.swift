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

    /// Five roles, two weights, Dynamic Type through the system's own text styles, sized as
    /// Mail, Messages and Reminders are at the default size: large title 34 (real large titles
    /// only), title 17 (message text, sheet titles), body 16 (row titles), meta 13, caption 11.
    /// Nothing is drawn bigger than its role.
    enum Typeface {
        /// A place's name: More, Settings, a section root.
        static let largeTitle = Font.largeTitle
        /// Message text, sheet titles.
        static let title = Font.body
        /// Row titles, answers, settings labels.
        static let body = Font.callout
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

    /// The same roles as sizes for text drawn with `aceFont`, each scaled against the system
    /// text style named beside it, so Dynamic Type grows them from the default size.
    enum TextRole {
        /// A real large title. `.largeTitle`.
        static let largeTitle = AceTheme.TypeStyle(size: 34, lineHeight: 41, weight: 600, tracking: 0)
        /// The home screen's own title ("ace ⌄"). `.title3`.
        static let header = AceTheme.TypeStyle(size: 20, lineHeight: 25, weight: 600, tracking: 0)
        /// Message text. `.body`.
        static let message = AceTheme.TypeStyle(size: 17, lineHeight: 22, weight: 400, tracking: 0)
        /// A row's title: a thread, a chat, a setting. `.callout`.
        static let rowTitle = AceTheme.TypeStyle(size: 16, lineHeight: 21, weight: 400, tracking: 0)
        /// A segmented control's words. `.subheadline`.
        static let segment = AceTheme.TypeStyle(size: 14, lineHeight: 18, weight: 400, tracking: 0)
        /// Project, time, counts, the scope under a title. `.footnote`.
        static let meta = AceTheme.TypeStyle(size: 13, lineHeight: 18, weight: 400, tracking: 0)
        /// Tiny labels. `.caption2`.
        static let caption = AceTheme.TypeStyle(size: 11, lineHeight: 13, weight: 400, tracking: 0)
        /// A tab's word under its icon. `.caption2`.
        static let tab = AceTheme.TypeStyle(size: 10, lineHeight: 12, weight: 600, tracking: 0)
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
    /// Takes taps over a full 44pt band while drawn `drawn` tall: the hit area grows above and
    /// below, the layout keeps the drawn height.
    func tapBand(drawn: CGFloat) -> some View {
        let grow = max(AceDesign.Size.tap - drawn, 0) / 2
        return padding(.vertical, grow).contentShape(Rectangle()).padding(.vertical, -grow)
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

// MARK: - Inbox, thread and composer: the values these places name

/// The few values the inbox, the thread and the composer need beyond `AceDesign.swift`. Same
/// rule: views name one of these, never a number of their own.

extension AceDesign.Size {
    /// A glyph beside meta or caption words: a caret, a clock, a fork.
    static let glyphSmall: CGFloat = 12
    /// A glyph beside a quiet line of body words: stop, paperclip, a machine, a file.
    static let glyphMeta: CGFloat = 14
    /// The box a bar-size glyph sits in, so the words beside or under a column of glyphs line up.
    static let glyphBox: CGFloat = 24
    /// The column a transcript line's or a row's lead icon sits in, so every line's words start
    /// together.
    static let lead: CGFloat = 20
    /// The Stop square inside Send/Stop.
    static let stopGlyph: CGFloat = 10
    /// The round backing behind a small glyph laid on a picture (remove on a thumbnail).
    static let badge: CGFloat = 20
    /// The dot that marks a row or a tab that needs the person.
    static let dot: CGFloat = 8
    /// A step's running dot on the step rail: smaller than a row's, it sits in a line of meta.
    static let dotSmall: CGFloat = 6
    /// A places-bar tab: room for its word at caption size with the chosen capsule around it.
    static let tab: CGFloat = 88
    /// A popover beside a message or a row (the message menu, a thread's preview, the thread
    /// menu): a reading column's width, never the screen's.
    static let popover: CGFloat = 340
    /// The most a popover widens to where the screen has room (the thread menu on a wide window).
    static let popoverWide: CGFloat = 380
    /// The tallest a popover grows before it scrolls.
    static let popoverHeight: CGFloat = 360
    /// The tallest a folded output (a command's log, a tool's result, a diff) shows before it
    /// scrolls.
    static let foldedOutput: CGFloat = 288
}

/// The home screen's chrome, sized as the system's own at the default Dynamic Type size: rows,
/// the header's capsule, the segmented control and the bottom bar.
extension AceDesign.Size {
    /// A row's padding above and below its lines: a two-line thread row comes to about 60.
    static let rowPadding: CGFloat = 10
    /// A grouped list's row (More, Settings), as the system's Settings draws one.
    static let settingsRow: CGFloat = 52
    /// A provider mark at a row's trailing edge.
    static let rowMark: CGFloat = 15
    /// The header's glass capsule (More, Pull requests, Search): drawn this tall, each button
    /// still a 44pt target.
    static let headerBar: CGFloat = 40
    /// A glyph in the header's capsule.
    static let headerGlyph: CGFloat = 17
    /// The segmented control under the title, and the inset its chosen capsule sits in.
    static let segment: CGFloat = 32
    static let segmentInset: CGFloat = 2
    /// The bottom bar: the tab pill and the compose circle.
    static let tabBar: CGFloat = 52
    /// A tab's outline icon, and compose's glyph.
    static let tabIcon: CGFloat = 22
    static let composeGlyph: CGFloat = 20
    /// One tab in the pill: room for its icon and word with the chosen capsule around them.
    static let tabWidth: CGFloat = 72
}

extension AceDesign.Space {
    /// The bottom bar's gap above the home indicator.
    static let aboveHome: CGFloat = 8
    /// The home indicator's top, above the screen's foot.
    static let homeIndicator: CGFloat = 13
    /// Between the segmented control and the first row.
    static let belowSegment: CGFloat = 12
    /// How far the page fades out above a bar pinned to the bottom.
    static let fade: CGFloat = 20
    /// A toast's clearance above the places bar: the bar's height and a gap.
    static let aboveTabBar: CGFloat = 76
}

extension AceDesign.Surface {
    /// Behind full-screen photos and video: black in every theme, as the system's own viewers.
    static let media = Color.black
    /// The page laid over a picture so a word or glyph on it reads ("+3", remove).
    static var veil: Color { AceTheme.Colours.background.opacity(veilStrength) }
    /// Code inside the person's bubble: the page showing through, one step back from the bubble.
    static var nested: Color { AceTheme.Colours.background.opacity(nestedStrength) }
    nonisolated static let veilStrength: Double = 0.7
    nonisolated static let nestedStrength: Double = 0.5
}

extension AceDesign.Ink {
    /// Words drawn straight on a picture (a video's length): white with a soft shadow, in
    /// every theme, because the picture decides the background.
    static let onMedia = Color.white
    static let onMediaShadow = Color.black.opacity(0.6)
    nonisolated static let onMediaShadowRadius: CGFloat = 2
    /// A destructive word (Delete, Archive): the system's red, as its menus and alerts draw it.
    static var destructive: Color { Color(uiColor: .systemRed) }
    /// A pressed filled control draws at this strength.
    nonisolated static let pressed: Double = 0.7
    /// A provider mark on a settled row, or quietened: present, one step back.
    nonisolated static let quiet: Double = 0.6
}

extension AceDesign.Motion {
    /// A pressed control shrinks this little, so the press reads without moving the layout.
    static let pressScale: CGFloat = 0.98
    /// A pill grows into place from this scale as it fades in.
    static let arrivalScale: CGFloat = 0.94
    /// Follows the keyboard: the system hands its own duration, ace adds no bounce.
    static func keyboard(_ duration: Double) -> Animation { .spring(duration: duration, bounce: 0) }
}

// MARK: - Pull requests, files and tools: the values these places name

/// Tokens the pull request, files, changes and tool views need beyond the core design file.
/// Same rules: views name these, never the numbers.

extension AceDesign.Space {
    /// Where a full page's empty, failed or loading state sits below its header.
    static let pageState: CGFloat = 120
    /// The same inside one part of a page (a diff, a comparison).
    static let partState: CGFloat = 64
    /// One level of a file tree: each level's name starts this far past its parent's.
    static let treeLevel: CGFloat = 16
}

extension AceDesign.Size {
    /// A row with a title and a meta line under it.
    static let rowDetail: CGFloat = 52
    /// A glyph inside a meta line or a pill.
    static let metaIcon: CGFloat = 14
    /// A disclosure caret or a chevron.
    static let caret: CGFloat = 12
    /// The column a row's leading glyph sits in, so the names beside it line up.
    static let rowGlyph: CGFloat = 24
    /// A pill or small glass button drawn smaller than its 44pt tap (a reaction, a toolbar
    /// toggle, a panel tab, an expand button over a page).
    static let pill: CGFloat = 32
    /// A pull request or issue label: a capsule one caption line tall.
    static let label: CGFloat = 18
    /// An unread dot or a modified-file dot.
    static let dotTiny: CGFloat = 6
    /// The side panel's drag handle.
    static let handleWidth: CGFloat = 4
    static let handleHeight: CGFloat = 36
    /// How wide the strip is that a drag on the panel's edge starts from.
    static let dragEdge: CGFloat = 24
    /// A file's git status mark: a small outlined square.
    static let fileMark: CGFloat = barIcon
    /// A diff's line-number column: room for four digits.
    static let lineNumber: CGFloat = 32
    /// A hairline: a divider, a diff's comment rail, the image-diff split.
    static let hairline: CGFloat = 1
    static let rail: CGFloat = 2
    /// A drawn glyph's stroke (a file-status box).
    static let glyphStroke: CGFloat = 1.5
    /// The space a floating bar takes at the bottom of a scrolling page, so the last row clears it.
    static let floatingBarClearance: CGFloat = 72
    /// Command output shows this much before it scrolls.
    static let outputMaxHeight: CGFloat = 160
    /// A fixed editor that holds a few lines of instructions.
    static let editorHeight: CGFloat = 220
    /// A chip whose text is cut before it pushes its neighbours off the row.
    static let chipMaxWidth: CGFloat = 96
}

@MainActor extension AceDesign.Surface {
    /// A quiet band on the page: a diff's hunk header, a folded run of lines.
    static var band: Color { AceTheme.Colours.fill.opacity(0.5) }
    /// The lines a person picked in a diff.
    static var picked: Color { AceTheme.Colours.accent.opacity(0.16) }
    /// The line a person jumped to in a file.
    static var lineHighlight: Color { AceTheme.Colours.foreground.opacity(0.07) }
    /// The chosen item in a glass choice row.
    static func chosen(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? AceTheme.Colours.foreground.opacity(0.16) : AceTheme.Colours.glass
    }
}

extension AceDesign.Ink {
    /// A forge label's own colour, behind its words.
    static let labelFillOpacity: Double = 0.2
    /// …and its words, mixed this far toward the page's ink so they read in either appearance.
    static let labelInkMix: Double = 0.45
    /// Something the person has finished with (a viewed file, a folder's totals) steps back to this.
    static let settledOpacity: Double = 0.6
    /// Content dimmed while it can't be used (a terminal that has ended).
    static let dimmedOpacity: Double = 0.5
}

// MARK: - Settings, devices and browser: the values these places name

/// Tokens the Settings, Devices, Browser, Machines and Projects screens need beyond the core
/// design file. Same rules: views name these, never a number of their own.

extension AceDesign.Ink {
    /// Words and glyphs on the accent's fill (the chosen segment, a primary button).
    static var onAccent: Color { AceTheme.Colours.onAccent }
    /// How far a quiet thing (a settled row's mark, an unchosen preview) recedes.
    static let recede: Double = 0.5
}

extension AceDesign.Surface {
    /// The dim behind a field raised over the page (the browser's address editor).
    static var scrim: Color { Color.black.opacity(0.25) }
}

extension AceDesign.Size {
    /// A place's mark beside its name at the head of its page (a provider's page).
    static let headerMark: CGFloat = 36
    /// A provider mark or avatar leading a two-line row.
    static let avatar: CGFloat = 28
    /// A colour you pick (an accent, a badge's colour): small enough for a row of nine, ringed
    /// inside a 44pt target.
    static let swatch: CGFloat = 28
    /// The ring around a chosen swatch.
    static let ring: CGFloat = 2
    /// A short number field (days, megabytes): room for four digits.
    static let numberField: CGFloat = 64
    /// A chart's legend dot, and the thickness of a bar that shares its colours.
    static let legendDot: CGFloat = 8
    /// A QR code shown to scan: big enough for a camera across a desk.
    static let qrCode: CGFloat = 240
    /// The widest an empty state's words run, so a sentence breaks where it reads well.
    static let emptyWidth: CGFloat = 360
    /// The widest a lone action under an empty state runs.
    static let loneAction: CGFloat = 200
    /// The widest a full-page notice (a page that failed to load) runs.
    static let noticeWidth: CGFloat = 480
    /// The widest a page's content runs on a large screen (Usage on an iPad).
    static let readable: CGFloat = 720
    /// A slim capsule at the system segmented control's height, inside a 44pt tap area.
    static let slimControl: CGFloat = 32
}

extension AceDesign.Motion {
    /// A press answers at once.
    static let press = Animation.easeOut(duration: 0.1)
}
