import SwiftUI
import UIKit

/// Settings › Notifications: the phone's on/off switch, then each paired machine with its own
/// on/off. Quiet hours and snooze are each machine's (`notification.preferences`,
/// `notification.snooze`); that machine's daemon applies them at delivery.
struct NotificationSettingsView: View {
    @Bindable var notifications: NotificationCoordinator
    let inbox: MachineInbox
    @Environment(\.openURL) private var openURL

    var body: some View {
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
            Section("Machines") {
                ForEach(inbox.sessions) { session in
                    NavigationLink {
                        MachineNotificationSettings(notifications: notifications, hostId: session.hostId,
                                                    name: inbox.name(session.hostId), model: session.client)
                    } label: {
                        Toggle(inbox.name(session.hostId), isOn: Binding(
                            get: { !notifications.muted.contains(session.hostId) },
                            set: { notifications.setMachine(session.hostId, enabled: $0) }))
                        .disabled(!notifications.delivering)
                    }
                    .accessibilityIdentifier("notifications.machine.\(session.hostId)")
                }
            }
        }
        .navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
        .task { notifications.loadPreferences(); await notifications.refreshPermission() }
    }
}

/// One machine's quiet hours and thread snoozes, read from and saved to that machine only.
struct MachineNotificationSettings: View {
    @Bindable var notifications: NotificationCoordinator
    let hostId: String
    let name: String
    let model: ClientModel
    private var preferences: NotificationPreferences { notifications.preferences(for: hostId) }

    var body: some View {
        Form {
            Section("Quiet hours") {
                Toggle("Quiet hours", isOn: Binding(get: { preferences.quietHours != nil }, set: { on in
                    var next = preferences
                    next.quietHours = on ? QuietHours(timeZone: TimeZone.current.identifier, startMinute: 22 * 60, endMinute: 7 * 60) : nil
                    notifications.save(next, for: hostId)
                }))
                .accessibilityIdentifier("notifications.quiet")
                if preferences.quietHours != nil {
                    DatePicker("From", selection: minute(\.startMinute), displayedComponents: .hourAndMinute)
                    DatePicker("Until", selection: minute(\.endMinute), displayedComponents: .hourAndMinute)
                }
            }
            Section("Snooze a thread") {
                ForEach(threads) { row in
                    let until = notifications.snoozes(for: hostId)[row.id]
                    Menu {
                        Button("For 1 hour") { notifications.snooze(row.id, until: notifications.now() + 3_600_000, hostId: hostId) }
                        Button("Until tomorrow") { notifications.snooze(row.id, until: tomorrowMorning(), hostId: hostId) }
                        if until != nil { Button("Turn off snooze") { notifications.snooze(row.id, until: nil, hostId: hostId) } }
                    } label: {
                        LabeledContent(row.title) {
                            Text(until.map { "Until \(Date(timeIntervalSince1970: $0 / 1000).formatted(date: .omitted, time: .shortened))" } ?? "Off")
                        }
                    }
                }
            }
        }
        .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
    }
    private var threads: [ThreadRow] {
        model.inbox.values.filter { $0.state != "done" && $0.archivedAt == nil }.sorted { $0.updatedAt > $1.updatedAt }.prefix(20).map { $0 }
    }
    private func minute(_ key: WritableKeyPath<QuietHours, Int>) -> Binding<Date> {
        Binding(get: {
            let value = preferences.quietHours?[keyPath: key] ?? 0
            return Calendar.current.date(bySettingHour: value / 60, minute: value % 60, second: 0, of: Date(timeIntervalSince1970: notifications.now() / 1000)) ?? Date()
        }, set: { date in
            guard var hours = preferences.quietHours else { return }
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            hours[keyPath: key] = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
            hours.timeZone = TimeZone.current.identifier
            var next = preferences
            next.quietHours = hours
            notifications.save(next, for: hostId)
        })
    }
    private func tomorrowMorning() -> Double {
        let now = Date(timeIntervalSince1970: notifications.now() / 1000)
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: now) ?? now
        let morning = Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? tomorrow
        return morning.timeIntervalSince1970 * 1000
    }
}

/// Inbox hooks: tap-to-open deep links on any machine and the one-time permission ask. The
/// settings themselves live in the Settings sheet.
struct NotificationHooks: ViewModifier {
    let inbox: MachineInbox
    let open: (InboxKey) -> Void
    @Environment(NotificationCoordinator.self) private var notifications: NotificationCoordinator?

    func body(content: Content) -> some View {
        content
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
