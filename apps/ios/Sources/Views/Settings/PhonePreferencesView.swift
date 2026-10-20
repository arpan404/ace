import SwiftUI

struct PhonePreferencesView: View {
    @AppStorage("ace.appearance") private var appearance = "system"
    @AppStorage("ace.keyboard.returnSends") private var returnSends = false
    @Environment(NativePaletteModel.self) private var palette: NativePaletteModel?
    @State private var fallback = NativePaletteModel(defaults: .standard)
    private var active: NativePaletteModel { palette ?? fallback }
    var body: some View {
        Form {
            Section("Appearance") {
                Picker("Mode", selection: $appearance) { Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") }
                NavigationLink("Custom theme") { CustomThemeView(preferences: active) }
            }
            Section {
                Toggle("Send on Return", isOn: $returnSends)
            } header: { Text("Keyboard") } footer: { Text("Off: Return adds a line. On: Return sends the message when it is ready to send.") }
        }
        .navigationTitle("Appearance and keyboard").navigationBarTitleDisplayMode(.inline)
    }
}

struct PhoneAppearance: ViewModifier {
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
