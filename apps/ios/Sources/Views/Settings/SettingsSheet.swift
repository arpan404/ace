import SwiftUI

/// Settings, opened from the inbox header (there is no tab bar): app lock, notifications per
/// machine, machines and the archive, about and licences, and a diagnostics export.
struct SettingsSheet: View {
    let inbox: MachineInbox
    var machines: MachinesModel?
    var lock: AppLock?
    var openMachines: () -> Void
    var openArchive: () -> Void
    @Environment(NotificationCoordinator.self) private var notifications: NotificationCoordinator?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("This phone") {
                    NavigationLink("Profiles") { TaskProfilesView(store: TaskProfileStore(defaults: .standard)) }
                    NavigationLink("Appearance and keyboard") { PhonePreferencesView() }
                }
                if let lock { AppLockSection(lock: lock) }
                Section {
                    if let notifications {
                        NavigationLink { NotificationSettingsView(notifications: notifications, inbox: inbox) } label: {
                            LabeledContent("Notifications", value: notifications.delivering ? "On" : "Off")
                        }
                        .accessibilityIdentifier("settings.notifications")
                    }
                    Button { dismiss(); openMachines() } label: {
                        LabeledContent("Machines", value: inbox.sessions.count.formatted())
                    }
                    .accessibilityIdentifier("settings.machines")
                    Button { dismiss(); openArchive() } label: { Text("Archived threads") }
                        .accessibilityIdentifier("settings.archive")
                }
                .foregroundStyle(AceTheme.Colours.foreground)
                Section("Machine settings") {
                    ForEach(inbox.sessions) { session in
                        NavigationLink(inbox.name(session.hostId)) { MachineFeaturesView(inbox: inbox, machineId: session.hostId) }
                            .accessibilityIdentifier("settings.machine.\(session.hostId)")
                    }
                }
                Section("About") {
                    LabeledContent("Version", value: "\(app.version) (\(app.build))")
                    NavigationLink("Licences") { LicencesView() }.accessibilityIdentifier("settings.licences")
                    ShareLink(item: report.json, preview: SharePreview("ace diagnostics")) {
                        Label("Share diagnostics", systemImage: "square.and.arrow.up")
                    }
                    .accessibilityIdentifier("settings.diagnostics")
                }
            }
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.large]).presentationDragIndicator(.visible)
    }
    private var app: DiagnosticsReport.App { .current }
    private var report: DiagnosticsReport {
        DiagnosticsReport.collect(app: app, inbox: inbox, entries: machines?.machines ?? [], notifications: notifications, lock: lock, now: Date())
    }
}

/// Face ID or the passcode at launch and after the chosen time in the background.
private struct AppLockSection: View {
    @Bindable var lock: AppLock
    var body: some View {
        Section {
            Toggle("Lock with Face ID", isOn: Binding(get: { lock.enabled }, set: { on in Task { await lock.setEnabled(on) } }))
                .disabled(lock.authenticating)
                .accessibilityIdentifier("settings.lock")
            Picker("Lock after", selection: Binding(get: { lock.timeout }, set: { lock.setTimeout($0) })) {
                ForEach(AppLock.timeouts, id: \.self) { seconds in Text(Self.label(seconds)).tag(seconds) }
            }
            .disabled(!lock.enabled)
            .accessibilityIdentifier("settings.lockTimeout")
        } header: { Text("App lock") } footer: {
            Text("Face ID or your passcode unlocks ace. Turning the lock off asks for it first.")
        }
    }
    static func label(_ seconds: TimeInterval) -> String {
        if seconds == 0 { return "Immediately" }
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .wide))
    }
}

/// What ships inside the app and its licence. The interface uses Apple's system fonts (SF Pro,
/// SF Mono); no font, icon set or other third-party asset is bundled. The JavaScript bridge
/// bundles ace's own packages, Zod and the shared HTML renderer's parse5/entities dependencies.
struct LicencesView: View {
    private struct Entry: Identifiable {
        let name: String
        let licence: String
        let notice: String
        var id: String { name }
    }
    private let entries = [
        Entry(name: "ace", licence: "Apache License 2.0",
              notice: "Copyright ace contributors. Licensed under the Apache License, Version 2.0. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0"),
        Entry(name: "Zod", licence: "MIT",
              notice: "Copyright (c) 2025 Colin McDonnell. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."),
        Entry(name: "LobeHub Icons", licence: "MIT",
              notice: "Provider marks. Copyright (c) 2023 LobeHub. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. The OpenAI mark is OpenAI's trademark, from its brand kit; each mark belongs to its owner."),
        Entry(name: "parse5", licence: "MIT", notice: Self.bundledNotice("parse5-license")),
        Entry(name: "entities", licence: "BSD 2-Clause", notice: Self.bundledNotice("entities-license")),
    ]
    private static func bundledNotice(_ name: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: "txt"), let text = try? String(contentsOf: url, encoding: .utf8) else { return "See \(name).txt in the app bundle." }
        return text
    }
    var body: some View {
        List(entries) { entry in
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                Text(entry.name).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                Text(entry.licence).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                Text(entry.notice).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            .padding(.vertical, AceTheme.Spacing.xs)
            .accessibilityElement(children: .combine)
        }
        .navigationTitle("Licences").navigationBarTitleDisplayMode(.inline)
    }
}
