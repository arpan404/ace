import SwiftUI
import UIKit

/// The last accent swatch: the system colour picker (no opacity). The picked colour goes to a
/// connected machine's runtime, which fits it to every theme with the web's own maths
/// (bridge/custom-accent.ts); the phone keeps the fit and shows it. Ringed while chosen.
struct CustomAccentPicker: View {
    let inbox: MachineInbox?
    let chosen: Bool
    let choose: (CustomAccent) -> Void
    @State private var picked: Color
    @State private var failed = false
    /// The colour last shown or fitted: only a different pick is sent.
    @State private var settled: String?

    init(inbox: MachineInbox?, chosen: Bool, start: String?, choose: @escaping (CustomAccent) -> Void) {
        self.inbox = inbox
        self.chosen = chosen
        self.choose = choose
        let colour = Color(hexString: start ?? "#3E8E7E") ?? .teal
        _picked = State(initialValue: colour)
        _settled = State(initialValue: colour.hexString)
    }

    var body: some View {
        ColorPicker("Custom", selection: $picked, supportsOpacity: false)
            .labelsHidden()
            .frame(width: 28, height: 28)
            .padding(AceTheme.Spacing.xs)
            .overlay { Circle().strokeBorder(AceTheme.Colours.accent, lineWidth: 2).opacity(chosen ? 1 : 0).allowsHitTesting(false) }
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
            .disabled(runtime == nil)
            .accessibilityLabel("Custom")
            .accessibilityAddTraits(chosen ? .isSelected : [])
            .accessibilityIdentifier("appearance.accent.custom")
            // Dragging in the picker sends many colours; fit the one it settles on.
            .task(id: picked.hexString) { await fit(picked.hexString) }
            .sensoryFeedback(.error, trigger: failed) { _, now in now }
    }

    /// Any machine whose runtime is up: fitting is pure, so whichever answers is the same.
    private var runtime: ClientModel? {
        inbox?.sessions.first { $0.client.connection == "ready" }?.client
    }

    private func fit(_ hex: String?) async {
        guard let hex, hex != settled, let runtime else { return }
        do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
        do {
            let reply = try await runtime.service(["type": "appearance.customAccent", "colour": hex], as: Reply.self)
                failed = false
            settled = hex
            choose(reply.accent)
        } catch is CancellationError {
        } catch { failed = true }
    }

    /// `appearance.customAccent`'s answer: theme → scheme → the accent and its label.
    struct Reply: Decodable {
        struct Pair: Decodable { let accent: String; let onAccent: String }
        let colour: String
        let themes: [String: [String: Pair]]
        var accent: CustomAccent {
            var fitted: [String: [String: NativePalette.Pair]] = [:]
            for (theme, schemes) in themes {
                guard let light = schemes["light"], let dark = schemes["dark"] else { continue }
                var roles: [String: NativePalette.Pair] = [:]
                if let l = UInt32(hex: light.accent), let d = UInt32(hex: dark.accent) { roles["accent"] = .init(light: l, dark: d) }
                if let l = UInt32(hex: light.onAccent), let d = UInt32(hex: dark.onAccent) { roles["onAccent"] = .init(light: l, dark: d) }
                fitted[theme] = roles
            }
            return CustomAccent(colour: colour, themes: fitted)
        }
    }
}

private extension UInt32 {
    init?(hex: String) {
        guard hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self = value
    }
}

extension Color {
    init?(hexString: String) {
        guard hexString.hasPrefix("#"), hexString.count == 7, let value = UInt32(hexString.dropFirst(), radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
    }
    /// "#RRGGBB" in sRGB, opacity dropped; nil if the colour can't be read as sRGB.
    var hexString: String? {
        guard let srgb = CGColorSpace(name: CGColorSpace.sRGB),
              let colour = UIColor(self).cgColor.converted(to: srgb, intent: .defaultIntent, options: nil),
              let parts = colour.components, parts.count >= 3 else { return nil }
        let byte = { (value: CGFloat) in Int((min(1, max(0, value)) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(parts[0]), byte(parts[1]), byte(parts[2]))
    }
}
