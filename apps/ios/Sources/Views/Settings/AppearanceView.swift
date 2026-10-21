import SwiftUI

/// Settings › Appearance: System, Light or Dark. Colours saved by the old custom-theme editor
/// still apply until they're reset here.
struct AppearanceView: View {
    @AppStorage("ace.appearance") private var appearance = "system"
    @Environment(NativePaletteModel.self) private var palette: NativePaletteModel?

    var body: some View {
        List {
            Section {
                ForEach(PhoneAppearance.modes, id: \.id) { mode in
                    Button { appearance = mode.id } label: {
                        InsetRow(systemImage: mode.symbol, title: mode.label) {
                            if appearance == mode.id { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(AceTheme.Colours.foreground) }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(appearance == mode.id ? .isSelected : [])
                    .accessibilityIdentifier("appearance.\(mode.id)")
                }
            } header: { InsetHeader("Mode") }
            .insetRowBackground()
            if let palette, !palette.palette.colours.isEmpty {
                Section {
                    Button("Use the standard colours") { palette.reset() }
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .accessibilityIdentifier("appearance.resetColours")
                } footer: { Text("This phone uses colours from an earlier custom theme.") }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .sensoryFeedback(.selection, trigger: appearance)
        .navigationTitle("Appearance").navigationBarTitleDisplayMode(.inline)
    }
}

/// The phone's light or dark choice and saved palette, applied at the app root.
struct PhoneAppearance: ViewModifier {
    struct Mode { let id: String; let label: String; let symbol: String }
    static let modes = [
        Mode(id: "system", label: "System", symbol: "circle.lefthalf.filled"),
        Mode(id: "light", label: "Light", symbol: "sun.max"),
        Mode(id: "dark", label: "Dark", symbol: "moon"),
    ]
    static func label(_ id: String) -> String { modes.first { $0.id == id }?.label ?? "System" }

    @AppStorage("ace.appearance") private var appearance = "system"
    @State private var palette = NativePaletteModel(defaults: .standard)
    func body(content: Content) -> some View {
        content
            .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
            .environment(palette)
            .onAppear { NativePaletteBridge.model = palette }
            // Reading the palette here keeps this root invalidated on save/reset, so every
            // active view re-resolves its colours without resetting navigation identity.
            .onChange(of: palette.palette) { _, _ in NativePaletteBridge.model = palette }
    }
}
