import SwiftUI

/// Settings › Face ID: Face ID or the passcode at launch and after the chosen time away.
struct AppLockView: View {
    @Bindable var lock: AppLock
    var body: some View {
        List {
            Section {
                InsetRow(systemImage: "faceid", title: "Lock with Face ID") {
                    Toggle("Lock with Face ID", isOn: Binding(get: { lock.enabled }, set: { on in Task { await lock.setEnabled(on) } }))
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
                Text("Face ID or your passcode unlocks ace. Turning the lock off asks for it first.")
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .sensoryFeedback(.selection, trigger: lock.enabled)
        .navigationTitle("Face ID").navigationBarTitleDisplayMode(.inline)
    }
    static func label(_ seconds: TimeInterval) -> String {
        if seconds == 0 { return "Immediately" }
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .wide))
    }
}
