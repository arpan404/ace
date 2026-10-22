import SwiftUI

/// The composer's one strip slot (DESIGN.md §8): what shows above the composer, most urgent
/// first. A request needs the person; queued messages wait for the turn; otherwise what the main
/// agent waits on, with its Stop. The person can switch to another present item from the strip's
/// indicator; a new request takes the slot back. Pure.
enum StripKind: Equatable { case request, queue, waiting }

struct StripSlot: Equatable {
    var shown: StripKind?
    /// The other present items, in priority order.
    var others: [StripKind]

    static func pick(request: Bool, queue: Bool, waiting: Bool, picked: StripKind?) -> StripSlot {
        let present = [request ? StripKind.request : nil, queue ? .queue : nil, waiting ? .waiting : nil].compactMap { $0 }
        let shown = request ? .request : picked.flatMap { present.contains($0) ? $0 : nil } ?? present.first
        return StripSlot(shown: shown, others: present.filter { $0 != shown })
    }
}

/// The strip's surface: the composer's material on a slightly narrower card, its lower edge
/// tucked behind the composer's top edge. Its glass stops at that edge, so the two never blur one
/// another. Content past about half the screen scrolls inside it.
struct StripSurface<Content: View>: View {
    /// A request card keeps a card's padding; the one-line rows are dense.
    var dense = false
    var maxHeight: CGFloat = .infinity
    @ViewBuilder var content: () -> Content
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let shape = AceShape.strip
        ScrollView {
            content()
                .padding(.horizontal, dense ? AceTheme.Spacing.md : AceTheme.Spacing.lg)
                .padding(.top, dense ? AceTheme.Spacing.xs : AceTheme.Spacing.md)
                .padding(.bottom, (dense ? AceTheme.Spacing.xs : AceTheme.Spacing.md) + StripMetrics.tuck)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollIndicators(.hidden)
        .frame(maxHeight: maxHeight)
        .fixedSize(horizontal: false, vertical: true)
        .aceContainerShape(shape)
        .aceGlass(in: shape)
        .shadow(color: AceTheme.Colours.shadow.opacity(AceTheme.Opacity.shadow(scheme) / 2), radius: AceTheme.Spacing.sm, y: -AceTheme.Dimensions.border)
        .mask(alignment: .top) {
            // The glass and its shadow end at the composer's edge.
            GeometryReader { box in
                let bleed = AceTheme.Spacing.xl
                Rectangle()
                    .frame(width: box.size.width + bleed * 2, height: max(AceTheme.Spacing.none, box.size.height - StripMetrics.tuck) + bleed)
                    .offset(x: -bleed, y: -bleed)
            }
        }
        .padding(.horizontal, StripMetrics.inset)
        .padding(.bottom, -StripMetrics.tuck)
    }
}

enum StripMetrics {
    /// The composer and its strip share the composer radius: a capsule while one line tall.
    static let radius = AceTheme.Radii.composer
    /// Insets inside the strip or composer (a command, a plan, a choice) sit `lg` in from its
    /// edge, so their corners are the composer's less that.
    static let insetRadius = AceShape.nested(in: radius, inset: AceTheme.Spacing.lg)
    /// How far the strip's lower edge sits behind the composer.
    static let tuck = AceTheme.Spacing.lg
    /// The strip is narrower than the composer by this much on each side.
    static let inset = AceTheme.Spacing.md + AceTheme.Spacing.lg
}

/// What the main agent waits on while it does nothing itself, its Stop at the right edge:
/// "Waiting for 2 subagents · 1 command running · 5m 58s", or "Running `bun run dev`". Stop ends
/// what it waits on (the whole tree, or the background commands); "Stopping…" until it ends.
struct WaitStrip<Indicators: View>: View {
    let wait: ActivityRow.Wait
    /// The turn's timer origin, for the time beside waiting subagents.
    let since: Double?
    /// Stop is offered: the tree can be stopped, or a command it waits on can.
    let canStop: Bool
    let stopping: Bool
    let stop: () -> Void
    @ViewBuilder var indicators: () -> Indicators
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            words
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            indicators()
            if stopping {
                Text("Stopping…").foregroundStyle(AceTheme.Colours.subtleForeground)
            } else if canStop {
                Button("Stop", action: stop)
                    .buttonStyle(StripTextButtonStyle())
                    .accessibilityLabel(wait.stop == "tree" ? "Stop the agent" : wait.taskIds.count == 1 ? "Stop the background command" : "Stop the background commands")
                    .accessibilityIdentifier("strip.stop")
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("strip.waiting")
    }
    @ViewBuilder private var words: some View {
        let lead = wait.code.isEmpty
            ? Text(wait.label).foregroundStyle(AceTheme.Colours.foreground)
            : Text("\(wait.label) ").foregroundStyle(AceTheme.Colours.foreground) + Text(wait.code).font(.system(.footnote, design: .monospaced)).foregroundStyle(AceTheme.Colours.foreground)
        let detail = wait.detail.isEmpty ? Text(verbatim: "") : Text(" · \(wait.detail)").foregroundStyle(AceTheme.Colours.mutedForeground)
        if wait.timed, let since {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                lead + detail + Text(" · \(Elapsed.words(since: since, now: context.date))").foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
            }
        } else {
            lead + detail
        }
    }
}

/// A small text action inside the strip: "Stop", "2 queued". Ghost, a step brighter when pressed.
struct StripTextButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).fontWeight(.medium)
            .foregroundStyle(configuration.isPressed ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.sm)
            .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
            .background(configuration.isPressed ? AceTheme.Colours.fill : .clear, in: AceShape.capsule)
            .contentShape(Rectangle())
    }
}

/// The other items present in the slot, as quiet words that switch to them.
struct StripIndicators: View {
    let kinds: [StripKind]
    let queued: Int
    let pick: (StripKind) -> Void
    var body: some View {
        ForEach(kinds.filter { $0 != .request }, id: \.self) { kind in
            Button(kind == .queue ? "\(queued) queued" : "Waiting") { pick(kind) }
                .buttonStyle(StripTextButtonStyle())
                .accessibilityIdentifier(kind == .queue ? "strip.queue" : "strip.showWaiting")
        }
    }
}
