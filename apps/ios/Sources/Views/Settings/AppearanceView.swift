import SwiftUI

/// Settings › Appearance: the mode as three previews of the app. Colours saved by the old
/// custom-theme editor still apply until they're reset here.
struct AppearanceView: View {
    @AppStorage("ace.appearance") private var appearance = "system"
    @Environment(NativePaletteModel.self) private var palette: NativePaletteModel?

    var body: some View {
        List {
            Section {
                ModePicker(selection: $appearance)
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: AceTheme.Spacing.xs, leading: SettingsStyle.margin,
                                              bottom: AceTheme.Spacing.xs, trailing: SettingsStyle.margin))
            } header: { SettingsHeader("Mode") }
            if let palette, !palette.palette.colours.isEmpty {
                Section {
                    Button("Use the standard colours") { palette.reset() }
                        .aceFont(SettingsStyle.label, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .accessibilityIdentifier("appearance.resetColours")
                } header: { SettingsHeader("Colours", note: "This phone uses colours from an earlier custom theme.") }
                .settingsRow()
            }
        }
        .settingsList()
        .navigationTitle("Appearance").navigationBarTitleDisplayMode(.inline)
    }
}

/// The phone's light or dark choice and saved palette, applied at the app root.
struct PhoneAppearance: ViewModifier {
    struct Mode { let id: String; let label: String }
    static let modes = [Mode(id: "system", label: "System"), Mode(id: "light", label: "Light"), Mode(id: "dark", label: "Dark")]
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
