import SwiftUI

/// Settings › Face ID: Face ID or the passcode at launch and after the chosen time away.
struct AppLockView: View {
    @Bindable var lock: AppLock
    var body: some View {
        List {
            Section {
                Toggle(isOn: Binding(get: { lock.enabled }, set: { on in Task { await lock.setEnabled(on) } })) {
                    SettingsRow(title: "Lock with Face ID") { EmptyView() }
                }
                .disabled(lock.authenticating)
                .accessibilityIdentifier("settings.lock.enabled")
                SettingsRow(title: "Lock after") {
                    Picker("Lock after", selection: Binding(get: { lock.timeout }, set: { lock.setTimeout($0) })) {
                        ForEach(AppLock.timeouts, id: \.self) { seconds in Text(Self.label(seconds)).tag(seconds) }
                    }
                    .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
                }
                .disabled(!lock.enabled)
                .accessibilityIdentifier("settings.lockTimeout")
            } header: {
                SettingsHeader("Lock", note: "Face ID or your passcode unlocks ace. Turning the lock off asks for it first.")
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Face ID").navigationBarTitleDisplayMode(.inline)
    }
    static func label(_ seconds: TimeInterval) -> String {
        if seconds == 0 { return "Immediately" }
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .wide))
    }
}
