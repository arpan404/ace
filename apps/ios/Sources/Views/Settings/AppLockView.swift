import SwiftUI
import LocalAuthentication

/// Device-owner authentication at launch and after the chosen time away.
struct AppLockView: View {
    @Bindable var lock: AppLock
    private var authentication: (name: String, symbol: String) {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return ("Face ID", "faceid")
        case .touchID: return ("Touch ID", "touchid")
        default: return ("Passcode", "lock")
        }
    }
    var body: some View {
        List {
            Section {
                InsetRow(systemImage: authentication.symbol, title: "Lock with \(authentication.name)") {
                    Toggle("Lock with \(authentication.name)", isOn: Binding(get: { lock.enabled }, set: { on in Task { await lock.setEnabled(on) } }))
                        .labelsHidden()
                }
                .disabled(lock.authenticating)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("settings.lock.enabled")
                InsetRow(systemImage: "timer", title: "Lock after") {
                    Picker("Lock after", selection: Binding(get: { lock.timeout }, set: { lock.setTimeout($0) })) {
                        ForEach(AppLock.timeouts, id: \.self) { seconds in Text(Self.label(seconds)).tag(seconds) }
                    }
                    .labelsHidden().pickerStyle(.menu)
                }
                .disabled(!lock.enabled)
                .accessibilityIdentifier("settings.lockTimeout")
            } footer: {
                Text(authentication.name == "Passcode" ? "Your passcode unlocks ace. Turning the lock off asks for it first." : "\(authentication.name) or your passcode unlocks ace. Turning the lock off asks for it first.")
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .sensoryFeedback(.selection, trigger: lock.enabled)
        .navigationTitle("App lock").navigationBarTitleDisplayMode(.inline)
    }
    static func label(_ seconds: TimeInterval) -> String {
        if seconds == 0 { return "Immediately" }
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .wide))
    }
}
