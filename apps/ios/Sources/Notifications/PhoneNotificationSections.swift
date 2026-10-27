import SwiftUI

/// Settings › Notifications on this phone: the four categories as banners while ace is open and
/// as system notifications while it's away, then quiet hours for the locked phone. The same
/// categories as the desktop; each machine's own quiet hours stay on its own page.
struct PhoneNotificationSections: View {
    @Bindable var notifications: NotificationCoordinator
    @Environment(\.aceReduceMotion) private var reduceMotion

    var body: some View {
        Section {
            ForEach(PhoneNotificationPrefs.categories, id: \.key) { category in toggle(category, \.inApp, id: "inApp") }
        } header: { InsetHeader("While ace is open") }
        .insetRowBackground()
        Section {
            ForEach(PhoneNotificationPrefs.categories, id: \.key) { category in toggle(category, \.system, id: "system") }
            Toggle("Quiet hours", isOn: Binding(get: { prefs.quietHours != nil }, set: { on in
                update { $0.quietHours = on ? PhoneNotificationPrefs.defaultQuietHours : nil }
            }))
            .disabled(!notifications.delivering)
            .accessibilityIdentifier("notifications.phone.quiet")
            if prefs.quietHours != nil {
                DatePicker("From", selection: minute(\.start), displayedComponents: .hourAndMinute)
                    .disabled(!notifications.delivering)
                    .accessibilityIdentifier("notifications.phone.quietStart")
                    .transition(.opacity)
                DatePicker("Until", selection: minute(\.end), displayedComponents: .hourAndMinute)
                    .disabled(!notifications.delivering)
                    .accessibilityIdentifier("notifications.phone.quietEnd")
                    .transition(.opacity)
            }
        } header: { InsetHeader("When ace is in the background") } footer: {
            if prefs.quietHours != nil { Text("During quiet hours notifications arrive silently in Notification Center.") }
        }
        .insetRowBackground()
        .sensoryFeedback(.selection, trigger: prefs)
    }

    private var prefs: PhoneNotificationPrefs { notifications.phone }
    private func update(_ change: (inout PhoneNotificationPrefs) -> Void) {
        var next = prefs
        change(&next)
        withAnimation(reduceMotion ? nil : .smooth) { notifications.setPhone(next) }
    }
    private func toggle(_ category: (key: String, title: String), _ path: WritableKeyPath<PhoneNotificationPrefs, PhoneNotificationPrefs.Categories>, id: String) -> some View {
        Toggle(category.title, isOn: Binding(get: { prefs[keyPath: path][category.key] }, set: { on in
            update { $0[keyPath: path][category.key] = on }
        }))
        .disabled(!notifications.delivering)
        .accessibilityIdentifier("notifications.\(id).\(category.key)")
    }
    private func minute(_ edge: WritableKeyPath<PhoneNotificationPrefs.Window, Int>) -> Binding<Date> {
        Binding(get: {
            let value = prefs.quietHours?[keyPath: edge] ?? 0
            let today = Date(timeIntervalSince1970: notifications.now() / 1000)
            return Calendar.current.date(bySettingHour: value / 60, minute: value % 60, second: 0, of: today) ?? today
        }, set: { date in
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            update { prefs in
                guard var window = prefs.quietHours else { return }
                window[keyPath: edge] = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
                // An empty window means nothing; the last one stays.
                if window.start != window.end { prefs.quietHours = window }
            }
        })
    }
}
