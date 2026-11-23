import SwiftUI

struct UsageToolbarButton: View {
    let client: ClientModel?
    let open: () -> Void

    var body: some View {
        let bars = client?.usageBars ?? []
        Button(action: open) {
            UsageBars(bars: bars)
                .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Usage")
        .accessibilityValue(bars.isEmpty ? "No limits read yet" : bars.map(\.spoken).joined(separator: ", "))
        .accessibilityIdentifier("inbox.usage")
    }
}

struct UsageBars: View {
    let bars: [UsageHeadroomBar]

    var body: some View {
        let low = AceDesign.Status.needsYou
        let out = AceDesign.Status.failed
        Canvas { context, _ in
            for (index, bar) in UsageBarGeometry.tracks(bars).enumerated() {
                let track = Path(roundedRect: bar.track, cornerRadius: bar.track.width / 2)
                var quiet = context
                quiet.opacity = 0.25
                quiet.fill(track, with: .foreground)
                if let fill = bar.fill {
                    let path = Path(roundedRect: fill, cornerRadius: min(fill.width, fill.height) / 2)
                    switch bars[index].tone {
                    case .ok: context.fill(path, with: .foreground)
                    case .low: context.fill(path, with: .color(low))
                    case .out: context.fill(path, with: .color(out))
                    }
                }
            }
        }
        .frame(width: AceDesign.Size.barIcon, height: AceDesign.Size.barIcon)
        .accessibilityHidden(true)
    }
}
