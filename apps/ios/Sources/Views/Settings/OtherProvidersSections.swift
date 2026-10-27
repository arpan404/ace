import SwiftUI

/// The Providers list's quieter sections: providers turned off (each opens its page to turn it
/// back on) and providers not installed (each opens its page showing what installing runs).
struct OtherProvidersSections: View {
    let model: ClientModel
    @State private var others: OtherProvidersData?

    init(model: ClientModel) {
        self.model = model
        _others = State(initialValue: model.kept(OtherProvidersData.read, as: OtherProvidersData.self))
    }

    var body: some View {
        Group {
            if let others, !others.off.isEmpty {
                Section {
                    ForEach(others.off) { row in
                        NavigationLink { ProviderPageView(model: model, provider: row.provider, name: row.name) } label: {
                            providerRow(row) { Text("Off").foregroundStyle(AceTheme.Colours.mutedForeground) }
                        }
                    }
                } header: { InsetHeader("Turned off") }
                .insetRowBackground()
            }
            if let others, !others.missing.isEmpty {
                Section {
                    ForEach(others.missing) { row in
                        NavigationLink { ProviderPageView(model: model, provider: row.provider, name: row.name, start: row.installable ? "install" : nil) } label: {
                            providerRow(row) {
                                if row.installable {
                                    Text("Install").aceFont(InsetStyle.value, relativeTo: .body).foregroundStyle(AceTheme.Colours.accent)
                                }
                            }
                        }
                        .accessibilityIdentifier("provider.install.\(row.provider)")
                    }
                } header: { InsetHeader("Not installed") }
                .insetRowBackground()
            }
        }
        .animation(.smooth, value: others)
        .task(id: [model.connection == "ready" ? 1 : 0, model.readGeneration(OtherProvidersData.read)]) {
            guard model.connection == "ready" else { return }
            if let next = try? await model.read(OtherProvidersData.read, as: OtherProvidersData.self) {
                withAnimation(.smooth) { others = next }
            }
        }
    }

    private func providerRow<Trailing: View>(_ row: OtherProvidersData.Row, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: AceTheme.Spacing.md + AceTheme.Spacing.xxs) {
            ProviderMark(provider: row.provider, size: 20, quiet: true).frame(width: 24)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(row.name).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                if let detail = row.detail {
                    Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            trailing()
        }
        .padding(.vertical, AceTheme.Spacing.xs)
        .accessibilityElement(children: .combine)
    }
}
