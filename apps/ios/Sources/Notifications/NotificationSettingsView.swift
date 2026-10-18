import SwiftUI
import UIKit

/// Settings › Notifications: on/off, quiet hours and per-thread snooze. Quiet hours and snooze are
/// the daemon's (`notification.preferences`, `notification.snooze`); it applies them at delivery.
struct NotificationSettingsView: View {
    @Bindable var notifications: NotificationCoordinator
    let model: ClientModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Notifications", isOn: Binding(get: { notifications.delivering },
                                                          set: { on in Task { await notifications.setEnabled(on) } }))
                    .accessibilityIdentifier("notifications.enabled")
                    if notifications.permission == .denied {
                        Button("Allow in Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }
                    }
                } footer: {
                    Text("Alerts arrive while ace is open or refreshing in the background. A locked phone may show them late.")
                }
                Section("Quiet hours") {
                    Toggle("Quiet hours", isOn: Binding(get: { notifications.preferences.quietHours != nil }, set: { on in
                        var preferences = notifications.preferences
                        preferences.quietHours = on ? QuietHours(timeZone: TimeZone.current.identifier, startMinute: 22 * 60, endMinute: 7 * 60) : nil
                        notifications.save(preferences)
                    }))
                    if notifications.preferences.quietHours != nil {
                        DatePicker("From", selection: minute(\.startMinute), displayedComponents: .hourAndMinute)
                        DatePicker("Until", selection: minute(\.endMinute), displayedComponents: .hourAndMinute)
                    }
                }
                Section("Snooze a thread") {
                    ForEach(threads) { row in
                        let until = notifications.snoozes[row.id]
                        Menu {
                            Button("For 1 hour") { notifications.snooze(row.id, until: notifications.now() + 3_600_000) }
                            Button("Until tomorrow") { notifications.snooze(row.id, until: tomorrowMorning()) }
                            if until != nil { Button("Turn off snooze") { notifications.snooze(row.id, until: nil) } }
                        } label: {
                            LabeledContent(row.title) {
                                Text(until.map { "Until \(Date(timeIntervalSince1970: $0 / 1000).formatted(date: .omitted, time: .shortened))" } ?? "Off")
                            }
                        }
                    }
                }
            }
            .navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { notifications.loadPreferences(); await notifications.refreshPermission() }
        }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
    private var threads: [ThreadRow] {
        model.inbox.values.filter { $0.state != "done" }.sorted { $0.updatedAt > $1.updatedAt }.prefix(20).map { $0 }
    }
    private func minute(_ key: WritableKeyPath<QuietHours, Int>) -> Binding<Date> {
        Binding(get: {
            let value = notifications.preferences.quietHours?[keyPath: key] ?? 0
            return Calendar.current.date(bySettingHour: value / 60, minute: value % 60, second: 0, of: Date(timeIntervalSince1970: notifications.now() / 1000)) ?? Date()
        }, set: { date in
            guard var hours = notifications.preferences.quietHours else { return }
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            hours[keyPath: key] = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
            hours.timeZone = TimeZone.current.identifier
            var preferences = notifications.preferences
            preferences.quietHours = hours
            notifications.save(preferences)
        })
    }
    private func tomorrowMorning() -> Double {
        let now = Date(timeIntervalSince1970: notifications.now() / 1000)
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: now) ?? now
        let morning = Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? tomorrow
        return morning.timeIntervalSince1970 * 1000
    }
}

/// Inbox hooks: the settings entry, tap-to-open deep links on any machine and the one-time
/// permission ask.
struct NotificationHooks: ViewModifier {
    let inbox: MachineInbox
    let open: (InboxKey) -> Void
    @Environment(NotificationCoordinator.self) private var notifications: NotificationCoordinator?
    @State private var showingSettings = false

    func body(content: Content) -> some View {
        content
            .toolbar {
                if notifications != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingSettings = true } label: { Image(systemName: "bell") }
                            .accessibilityLabel("Notification settings").accessibilityIdentifier("notifications.settings")
                    }
                }
            }
            .sheet(isPresented: $showingSettings) {
                if let notifications, let model = notifications.model ?? inbox.sessions.first?.client {
                    NotificationSettingsView(notifications: notifications, model: model)
                }
            }
            .task(id: inbox.sessions.compactMap { session in session.client.deepLink.map { "\(session.hostId)/\($0)" } }) {
                guard let session = inbox.sessions.first(where: { $0.client.deepLink != nil }), let id = session.client.deepLink else { return }
                session.client.deepLink = nil
                open(InboxKey(machineId: session.hostId, id: id))
            }
            .task(id: inbox.sessions.contains { $0.client.inboxLoaded && !$0.client.inbox.isEmpty && $0.client.connection == "ready" }) {
                await notifications?.askAfterFirstThread()
            }
    }
}
extension View {
    func aceNotifications(inbox: MachineInbox, open: @escaping (InboxKey) -> Void) -> some View {
        modifier(NotificationHooks(inbox: inbox, open: open))
    }
}
