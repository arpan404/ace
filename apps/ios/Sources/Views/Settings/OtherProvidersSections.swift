import SwiftUI

/// The Providers list's quieter sections: providers turned off (each opens its page to turn it
/// back on) and providers not installed (each opens its page showing what installing runs).
/// Its read is attached to the list (`followOtherProviders`): sections with nothing to show yet
/// never appear, so a read attached to them would never run.
struct OtherProvidersSections: View {
    let model: ClientModel
    let others: OtherProvidersData?

    var body: some View {
        Group {
            if let others, !others.off.isEmpty {
                Section {
                    ForEach(others.off) { row in
                        NavigationLink { ProviderPageView(model: model, provider: row.provider, name: row.name) } label: {
                            providerRow(row) { Text("Off").foregroundStyle(AceDesign.Ink.muted) }
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
                                    Text("Install").font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.accent)
                                }
                            }
                        }
                        .accessibilityIdentifier("provider.install.\(row.provider)")
                    }
                } header: { InsetHeader("Not installed") }
                .insetRowBackground()
            }
        }
        .smoothChange(others)
    }

    private func providerRow<Trailing: View>(_ row: OtherProvidersData.Row, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: AceDesign.Space.row) {
            ProviderMark(provider: row.provider, size: AceDesign.Size.icon, quiet: true).frame(width: AceDesign.Size.icon + AceDesign.Space.related)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(row.name).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                if let detail = row.detail {
                    Text(detail).font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted).lineLimit(2)
                }
            }
            Spacer(minLength: AceDesign.Space.related)
            trailing()
        }
        .padding(.vertical, AceDesign.Space.tight)
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// Reads the off and missing providers into `others`: the last kept answer at once, then the
    /// machine's, again whenever it goes out of date or the machine comes back.
    func followOtherProviders(_ model: ClientModel, _ others: Binding<OtherProvidersData?>) -> some View {
        onAppear { if others.wrappedValue == nil { others.wrappedValue = model.kept(OtherProvidersData.read, as: OtherProvidersData.self) } }
            .task(id: [model.connection == "ready" ? 1 : 0, model.readGeneration(OtherProvidersData.read)]) {
                guard model.connection == "ready" else { return }
                if let next = try? await model.read(OtherProvidersData.read, as: OtherProvidersData.self) {
                    withAnimation { others.wrappedValue = next }
                }
            }
    }
}
