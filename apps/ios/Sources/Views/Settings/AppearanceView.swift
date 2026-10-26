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
    static func style(_ id: String) -> UIUserInterfaceStyle { id == "dark" ? .dark : id == "light" ? .light : .unspecified }

    @AppStorage("ace.appearance") private var appearance = "system"
    @State private var palette = NativePaletteModel(defaults: .standard)
    func body(content: Content) -> some View {
        content
            // Set on the window, not with `preferredColorScheme`: that leaves an open sheet
            // (Settings itself) in the old mode and doesn't always return to System.
            .background { WindowInterfaceStyle(style: Self.style(appearance)) }
            .environment(palette)
            .onAppear { NativePaletteBridge.model = palette }
            // Reading the palette here keeps this root invalidated on save/reset, so every
            // active view re-resolves its colours without resetting navigation identity.
            .onChange(of: palette.palette) { _, _ in NativePaletteBridge.model = palette }
    }
}

/// Applies a light or dark override to the window hosting it, so every screen and every
/// presented sheet in that window changes at once.
private struct WindowInterfaceStyle: UIViewRepresentable {
    let style: UIUserInterfaceStyle
    func makeUIView(context: Context) -> Probe { Probe() }
    func updateUIView(_ view: Probe, context: Context) { view.style = style }

    final class Probe: UIView {
        var style: UIUserInterfaceStyle = .unspecified { didSet { apply() } }
        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            isAccessibilityElement = false
        }
        required init?(coder: NSCoder) { nil }
        override func didMoveToWindow() { super.didMoveToWindow(); apply() }
        private func apply() {
            guard let window, window.overrideUserInterfaceStyle != style else { return }
            window.overrideUserInterfaceStyle = style
        }
    }
}
