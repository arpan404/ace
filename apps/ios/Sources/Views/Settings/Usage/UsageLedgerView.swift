import SwiftUI

/// A row the person opened in the ledger: its grouping, its key and its name.
struct UsageLedgerStep: Hashable, Sendable {
    let group: String
    let key: String
    let label: String
}

/// What every level of the ledger reads with: the machines, the days, the metric shown and the
/// provider chosen above.
struct UsageLedgerContext {
    let reads: UsageMachineReads
    let from: String
    let to: String
    let cost: Bool
    let provider: String?

    /// The scope a path of opened rows reads within (web's `ledgerScope`): each step filters its
    /// dimension, and a machine's step keeps the read to that machine.
    func scope(_ path: [UsageLedgerStep]) -> (filters: [String: [String]], machine: String?) {
        var filters: [String: [String]] = provider.map { ["provider": [$0]] } ?? [:]
        var machine: String?
        for step in path {
            if step.group == "machine" { machine = step.key } else { filters[step.group] = [step.key] }
        }
        return (filters, machine)
    }
}

/// Spend as web's ledger: grouped by provider, account, project, model, machine, automation,
/// skill or agent. Each row has its figure, its change against the period before, its share and
/// its days as a trend; a row opens in place to the level below (a provider's accounts, an
/// account's projects), and nothing else on the page moves.
struct UsageLedgerView: View {
    let context: UsageLedgerContext
    @State private var group = "provider"
    @State private var groups: [UsageLedgerReply.Group] = []

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(alignment: .center) {
                UsageSectionHeading(title: "Breakdown")
                Spacer(minLength: AceDesign.Space.row)
                if !groups.isEmpty {
                    Menu {
                        Picker("Group by", selection: $group) {
                            ForEach(groups, id: \.value) { Text($0.label).tag($0.value) }
                        }
                    } label: {
                        HStack(spacing: AceDesign.Space.tight) {
                            Text("By \((groups.first { $0.value == group }?.label ?? group).lowercased())")
                            AceIcon(.caretDown, size: AceDesign.Size.glyphSmall, relativeTo: .caption)
                        }
                        .font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .frame(minHeight: AceDesign.Size.tap)
                        .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Group by")
                    .accessibilityValue(groups.first { $0.value == group }?.label ?? group)
                    .accessibilityIdentifier("usage.ledger.group")
                }
            }
            // A new grouping, range or provider starts with every row closed.
            UsageLedgerLevel(group: group, path: [], context: context) { groups = $0 }
                .id([group, context.from, context.to, context.provider ?? ""])
        }
    }
}

/// One level of rows: the top of the ledger, or what one row opened to.
private struct UsageLedgerLevel: View {
    let group: String
    let path: [UsageLedgerStep]
    let context: UsageLedgerContext
    var loaded: (([UsageLedgerReply.Group]) -> Void)? = nil
    @State private var reply: UsageLedgerReply?
    @State private var reading = true
    @State private var all = false
    @State private var open: Set<String> = []

    private var indent: CGFloat { CGFloat(path.count) * AceDesign.Space.group }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if let reply {
                if reply.rows.isEmpty { quiet("None in this period") }
                let rows = all ? reply.rows : Array(reply.rows.prefix(reply.top))
                ForEach(rows) { row in
                    Hairline()
                    UsageLedgerRow(row: row, cost: context.cost, indent: indent, opens: reply.next != nil,
                                   open: open.contains(row.key)) {
                        withAnimation { if open.contains(row.key) { open.remove(row.key) } else { open.insert(row.key) } }
                    }
                    if let next = reply.next, open.contains(row.key) {
                        UsageLedgerLevel(group: next.value,
                                         path: path + [UsageLedgerStep(group: group, key: row.key, label: row.name)],
                                         context: context)
                    }
                }
                if reply.rows.count > reply.top {
                    Button(all ? "Show fewer" : "Show all \(reply.rows.count)") { withAnimation { all.toggle() } }
                        .font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .padding(.leading, indent)
                        .frame(minHeight: AceDesign.Size.tap)
                }
            } else if reading {
                SkeletonRows(count: path.isEmpty ? 4 : 2, label: "Reading spend")
            } else {
                quiet("Not recorded on these machines")
            }
        }
        .task { await read() }
    }

    private func quiet(_ text: String) -> some View {
        Text(text).font(AceDesign.Typeface.meta)
            .foregroundStyle(AceDesign.Ink.subtle)
            .padding(.leading, indent)
            .padding(.vertical, AceDesign.Space.row)
    }

    private func read() async {
        let scope = context.scope(path)
        reading = true
        defer { reading = false }
        let answer = await context.reads.ledger(group: group, filters: scope.filters, machine: scope.machine,
                                                parent: path.last, from: context.from, to: context.to)
        guard !Task.isCancelled else { return }
        reply = answer
        if let answer { loaded?(answer.groups) }
    }
}

/// Name · figure on the first line; share bar, trend and change under it. The row opens to the
/// level below when there is one.
private struct UsageLedgerRow: View {
    let row: UsageLedgerReply.Row
    let cost: Bool
    let indent: CGFloat
    let opens: Bool
    let open: Bool
    let toggle: () -> Void
    private static let barHeight: CGFloat = 2
    private static let trendSize = CGSize(width: 56, height: 16)

    private var cell: UsageLedgerReply.Cell { cost ? row.cost : row.tokens }
    private var share: Double { cost ? row.share.cost : row.share.tokens }
    private var trend: [Double] { cost ? row.trend.cost : row.trend.tokens }

    var body: some View {
        if opens {
            Button(action: toggle) { content }
                .buttonStyle(.plain)
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                .accessibilityHint("Shows what is inside it")
        } else {
            content
        }
    }

    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            AceIcon(.caretRight, size: AceDesign.Size.glyphSmall, relativeTo: .caption)
                .foregroundStyle(AceDesign.Ink.subtle)
                .rotationEffect(.degrees(open ? 90 : 0))
                .opacity(opens ? 1 : 0)
            VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                HStack(spacing: AceDesign.Space.related) {
                    if let provider = row.provider { ProviderMark(provider: provider, size: AceDesign.Size.icon) }
                    Text(row.name).font(AceDesign.Typeface.body)
                        .foregroundStyle(AceDesign.Ink.primary).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: AceDesign.Space.related)
                    Text(cell.figure).font(AceDesign.Typeface.body).monospacedDigit()
                        .foregroundStyle(cell.figure == "Unpriced" ? AceDesign.Ink.subtle : AceDesign.Ink.primary)
                }
                HStack(spacing: AceDesign.Space.row) {
                    GeometryReader { box in
                        ZStack(alignment: .leading) {
                            AceDesign.Shape.control.fill(AceTheme.Colours.separator)
                            AceDesign.Shape.control.fill(AceDesign.Ink.muted)
                                .frame(width: max(Self.barHeight, box.size.width * min(1, max(0, share))))
                        }
                    }
                    .frame(height: Self.barHeight)
                    UsageLedgerTrend(values: trend)
                        .frame(width: Self.trendSize.width, height: Self.trendSize.height)
                        .foregroundStyle(AceDesign.Ink.muted)
                    Text(cell.change).monospacedDigit()
                        .font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.subtle)
                }
                .accessibilityHidden(true)
            }
        }
        .padding(.leading, indent)
        .padding(.vertical, AceDesign.Space.row)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.name): \(cell.figure)\(cell.change.isEmpty ? "" : ", \(cell.change)")")
        .accessibilityIdentifier("usage.ledger.row.\(row.key)")
    }
}

/// The row's days as a thin line, scaled to its own busiest day; nothing with under two days.
private struct UsageLedgerTrend: View {
    let values: [Double]
    var body: some View {
        if values.count > 1 {
            Canvas { context, size in
                let top = max(values.max() ?? 0, 1e-9)
                var line = Path()
                for (index, value) in values.enumerated() {
                    let point = CGPoint(x: size.width * CGFloat(index) / CGFloat(values.count - 1),
                                        y: size.height * (1 - CGFloat(value / top)))
                    if index == 0 { line.move(to: point) } else { line.addLine(to: point) }
                }
                context.stroke(line, with: .foreground, lineWidth: 1)
            }
        }
    }
}
