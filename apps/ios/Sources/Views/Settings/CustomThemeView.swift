import SwiftUI

struct CustomThemeView: View {
    @Bindable var preferences: NativePaletteModel
    @State private var draft = NativePalette()
    @State private var saved = false
    @State private var problem: String?
    private let labels = ["Background", "Secondary background", "Cards", "Text", "Secondary text", "Subtle text", "Separators", "Control fill", "Accent", "Text on accent"]
    var body: some View {
        Form {
            Section {
                Text("Adjust light and dark colours separately. Status colours keep their shared meanings.")
                Text("Preview your task")
                    .foregroundStyle(colour("foreground", dark: false)).padding(AceTheme.Spacing.lg)
                    .frame(maxWidth: .infinity, alignment: .leading).background(colour("background", dark: false))
                Text("Preview your task")
                    .foregroundStyle(colour("foreground", dark: true)).padding(AceTheme.Spacing.lg)
                    .frame(maxWidth: .infinity, alignment: .leading).background(colour("background", dark: true))
            }
            ForEach(Array(NativePalette.editable.enumerated()), id: \.element) { index, key in
                Section(labels[index]) {
                    ColorPicker("Light", selection: binding(key, dark: false), supportsOpacity: false)
                    ColorPicker("Dark", selection: binding(key, dark: true), supportsOpacity: false)
                    if draft.colours[key] != nil { Button("Use default") { draft.colours[key] = nil; saved = false } }
                }
            }
            ServiceProblem(message: problem)
            Button(saved ? "Saved" : "Save theme") {
                do { try preferences.save(draft); saved = true; problem = nil } catch { problem = "Couldn't save the theme." }
            }
            Button("Reset theme") { preferences.reset(); draft = preferences.palette; saved = false }
        }
        .navigationTitle("Custom theme").navigationBarTitleDisplayMode(.inline)
        .onAppear { draft = preferences.palette }
    }
    private func pair(_ key: String) -> NativePalette.Pair {
        draft.colours[key] ?? AceTheme.paletteDefaults[key] ?? .init(light: 0, dark: 0)
    }
    private func colour(_ key: String, dark: Bool) -> Color {
        let pair = pair(key)
        return Self.colour(dark ? pair.dark : pair.light)
    }
    private static func colour(_ hex: UInt32) -> Color { Color(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1) }
    private func binding(_ key: String, dark: Bool) -> Binding<Color> {
        Binding(get: { colour(key, dark: dark) }, set: { picked in
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            guard UIColor(picked).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return }
            let hex = (UInt32(max(0, min(255, (red * 255).rounded()))) << 16) | (UInt32(max(0, min(255, (green * 255).rounded()))) << 8) | UInt32(max(0, min(255, (blue * 255).rounded())))
            var next = pair(key)
            if dark { next.dark = hex } else { next.light = hex }
            draft.colours[key] = next; saved = false
        })
    }
}
