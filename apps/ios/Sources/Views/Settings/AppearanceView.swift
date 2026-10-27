import SwiftUI

/// Settings › Appearance: mode, theme and accent as picker cards (the app in miniature, in each
/// choice's own colours), then transcript size, motion and translucency. All kept on this phone.
/// iOS's own Dynamic Type, Reduce Motion and Reduce Transparency always apply on top. Colours
/// saved by the old custom-theme editor still win until they're reset here.
struct AppearanceView: View {
    @AppStorage("ace.appearance") private var appearance = "system"
    @AppStorage(PhoneLook.transcriptKey) private var transcriptSize = "default"
    @AppStorage(PhoneLook.reduceMotionKey) private var reduceMotion = false
    @AppStorage(PhoneLook.solidKey) private var solid = false
    @Environment(NativePaletteModel.self) private var palette: NativePaletteModel?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.accessibilityReduceTransparency) private var systemReduceTransparency
    private let columns = [GridItem(.adaptive(minimum: 92), spacing: AceTheme.Spacing.md)]

    var body: some View {
        List {
            Section {
                LazyVGrid(columns: columns, spacing: AceTheme.Spacing.lg) {
                    ForEach(PhoneAppearance.modes, id: \.id) { mode in
                        PickerCard(name: mode.label, selected: appearance == mode.id, id: "appearance.\(mode.id)") {
                            change { appearance = mode.id }
                        } preview: { modePreview(mode.id) }
                    }
                }
                .pickerRow()
            } header: { InsetHeader("Mode") }
            Section {
                LazyVGrid(columns: columns, spacing: AceTheme.Spacing.lg) {
                    ForEach(AceTheme.themeChoices, id: \.id) { theme in
                        PickerCard(name: theme.name, selected: chosenTheme == theme.id, id: "appearance.theme.\(theme.id)") {
                            change { palette?.choose(theme: theme.id) }
                        } preview: { ThemePreview(theme: theme.id, accent: chosenAccent, scheme: scheme) }
                    }
                }
                .pickerRow()
            } header: { InsetHeader("Theme") }
            Section {
                AccentSwatches(theme: chosenTheme, chosen: chosenAccent, scheme: scheme) { accent in
                    change { palette?.choose(accent: accent) }
                }
                .pickerRow()
            } header: { InsetHeader("Accent") }
            Section {
                Picker("Transcript size", selection: $transcriptSize) {
                    ForEach(AceTheme.transcriptSizes, id: \.id) { size in Text(size.name).tag(size.id) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("appearance.transcriptSize")
            } header: { InsetHeader("Transcript size") }
            .insetRowBackground()
            Section {
                InsetRow(systemImage: "figure.walk.motion", title: "Reduce motion") {
                    Toggle("Reduce motion", isOn: Binding(get: { reduceMotion || systemReduceMotion }, set: { reduceMotion = $0 }))
                        .labelsHidden().disabled(systemReduceMotion)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("appearance.reduceMotion")
                InsetRow(systemImage: "square.on.square.intersection.dashed", title: "Translucency") {
                    Toggle("Translucency", isOn: Binding(get: { !solid && !systemReduceTransparency }, set: { solid = !$0 }))
                        .labelsHidden().disabled(systemReduceTransparency)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("appearance.translucency")
            } header: { InsetHeader("Motion and surfaces") } footer: {
                if systemReduceMotion || systemReduceTransparency { Text("Set by Accessibility in the Settings app.") }
            }
            .insetRowBackground()
            if let palette, !palette.palette.colours.isEmpty {
                Section {
                    Button("Use the standard colours") { change { palette.reset() } }
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .accessibilityIdentifier("appearance.resetColours")
                } footer: { Text("This phone uses colours from an earlier custom theme.") }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .sensoryFeedback(.selection, trigger: appearance)
        .sensoryFeedback(.selection, trigger: palette?.theme)
        .sensoryFeedback(.selection, trigger: palette?.accent)
        .sensoryFeedback(.selection, trigger: transcriptSize)
        .sensoryFeedback(.selection, trigger: reduceMotion)
        .sensoryFeedback(.selection, trigger: solid)
        .navigationTitle("Appearance").navigationBarTitleDisplayMode(.inline)
    }

    private var chosenTheme: String { palette?.theme ?? "ace" }
    private var chosenAccent: String { palette?.accent ?? "theme" }
    /// Colour changes fade across the whole window.
    private func change(_ apply: () -> Void) { LookCrossfade.run(apply) }

    /// System shows the light half beside the dark half; Light and Dark show their own.
    @ViewBuilder private func modePreview(_ mode: String) -> some View {
        if mode == "system" {
            ThemePreview(theme: chosenTheme, accent: chosenAccent, scheme: .light)
                .overlay {
                    ThemePreview(theme: chosenTheme, accent: chosenAccent, scheme: .dark)
                        .mask { GeometryReader { box in Rectangle().frame(width: box.size.width / 2).offset(x: box.size.width / 2) } }
                }
        } else {
            ThemePreview(theme: chosenTheme, accent: chosenAccent, scheme: mode == "dark" ? .dark : .light)
        }
    }
}

/// The accent choices as swatches in the theme's own colours: Theme keeps the theme's accent,
/// Ink its text colour. The chosen one is ringed, and its name sits under the row.
private struct AccentSwatches: View {
    let theme: String
    let chosen: String
    let scheme: ColorScheme
    let choose: (String) -> Void

    var body: some View {
        VStack(spacing: AceTheme.Spacing.xs) {
            HStack(spacing: AceTheme.Spacing.none) {
                ForEach(AceTheme.accentChoices, id: \.id) { accent in
                    Button { choose(accent.id) } label: {
                        Circle().fill(ThemePreview.colour("accent", theme: theme, accent: accent.id, scheme: scheme))
                            .frame(width: 28, height: 28)
                            .padding(AceTheme.Spacing.xs)
                            .overlay { Circle().strokeBorder(AceTheme.Colours.accent, lineWidth: 2).opacity(chosen == accent.id ? 1 : 0) }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(accent.name)
                    .accessibilityAddTraits(chosen == accent.id ? [.isButton, .isSelected] : .isButton)
                    .accessibilityIdentifier("appearance.accent.\(accent.id)")
                }
            }
            Text(AceTheme.accentChoices.first { $0.id == chosen }?.name ?? "Theme")
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .contentTransition(.opacity)
                .animation(.smooth, value: chosen)
                .accessibilityHidden(true)
        }
    }
}

private extension View {
    /// Picker cards sit on the page itself, not in a filled row.
    func pickerRow() -> some View {
        listRowBackground(Color.clear).listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.xs, leading: AceTheme.Spacing.xs, bottom: AceTheme.Spacing.xs, trailing: AceTheme.Spacing.xs))
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
            .onChange(of: palette.theme) { _, _ in NativePaletteBridge.model = palette }
            .onChange(of: palette.accent) { _, _ in NativePaletteBridge.model = palette }
            .modifier(PhoneLookEnvironment())
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
