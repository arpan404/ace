import SwiftUI

/// "When it runs" in the automation editor: the kind of trigger, then its own fields. A schedule
/// gets a repeat, its day and time (native pickers read in the schedule's zone), a later start,
/// the zone, the missed-run rule and its next three starts; GitHub a repository, event and label;
/// files their globs. The kinds, cadences and every word come from the bridge.
struct AutomationWhenSection: View {
    @Binding var form: AutomationFormValues
    let view: AutomationFormView
    let choices: AutomationFormView.Choices
    let error: (String) -> String?
    let touch: (String) -> Void
    /// A control's change the bridge applies (`automations.form.preview`'s `change`).
    let change: ([String: Any]) -> Void
    /// What a picker shows until the bridge answers, so it never springs back mid-turn.
    @State private var pendingTime: Date?
    @State private var pendingAt: Date?
    @State private var pendingStart: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var zone: TimeZone { TimeZone(identifier: form.timezone) ?? .current }
    private var timed: Bool { ["daily", "weekdays", "weekly"].contains(form.cadence) }
    private func date(_ ms: Double?) -> Date? { ms.map { Date(timeIntervalSince1970: $0 / 1000) } }
    private func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }

    var body: some View {
        Section {
            menu("Runs", selection: form.trigger, choices.triggers, id: "automation.trigger") { change(["trigger": $0]) }
            switch form.trigger {
            case "schedule": schedule
            case "github": github
            case "file": files
            default:
                Text("It runs only when you tap Run now.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        } header: { InsetHeader("When it runs") }
        .insetRowBackground()
        .animation(reduceMotion ? AceTheme.Motion.standardCurve : .smooth, value: form.trigger)
        .animation(reduceMotion ? AceTheme.Motion.standardCurve : .smooth, value: form.cadence)
        .onChange(of: view.instants?.time) { _, _ in pendingTime = nil }
        .onChange(of: view.instants?.at) { _, _ in pendingAt = nil }
        .onChange(of: view.instants?.startsAt) { _, _ in pendingStart = nil }
        if form.trigger == "schedule", let upcoming = view.upcoming {
            Section {
                if upcoming.isEmpty {
                    Text("No upcoming run").foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                ForEach(upcoming, id: \.self) { start in
                    Text(start).monospacedDigit().foregroundStyle(AceTheme.Colours.foreground)
                        .transition(.opacity)
                }
            } header: { InsetHeader("Next starts") }
            .insetRowBackground()
            .accessibilityIdentifier("automation.nextStarts")
        }
    }

    // MARK: Schedule

    @ViewBuilder private var schedule: some View {
        menu("Repeat", selection: form.cadence, choices.cadences, id: "automation.cadence") { change(["cadence": $0]) }
        if form.cadence == "weekly" {
            menu("Day", selection: form.day, choices.weekdays, id: "automation.day") { form.day = $0 }
        }
        if form.cadence == "minutes", let options = view.minutes {
            menu("How often", selection: String(form.minutes), options, id: "automation.minutes") { form.minutes = Int($0) ?? form.minutes }
            problem("minutes")
        }
        if form.cadence == "hourly", let options = view.hours {
            menu("How often", selection: String(form.every), options, id: "automation.hours") { form.every = Int($0) ?? form.every }
            problem("every")
        }
        if timed, let instant = date(view.instants?.time) {
            DatePicker("At", selection: Binding(get: { pendingTime ?? instant },
                                                set: { pendingTime = $0; touch("time"); change(["time": ms($0)]) }),
                       displayedComponents: .hourAndMinute)
                .environment(\.timeZone, zone)
                .accessibilityIdentifier("automation.time")
            problem("time")
        }
        if form.cadence == "once", let instant = date(view.instants?.at) {
            DatePicker("At", selection: Binding(get: { pendingAt ?? instant },
                                                set: { pendingAt = $0; touch("date"); change(["at": ms($0)]) }),
                       in: (date(view.today) ?? .distantPast)...)
                .environment(\.timeZone, zone)
                .accessibilityIdentifier("automation.at")
            problem("date")
        }
        if form.cadence == "custom" { custom }
        if form.cadence != "once" { starts }
        NavigationLink {
            AutomationZonePicker(selection: Binding(get: { form.timezone }, set: { form.timezone = $0; touch("timezone") }))
        } label: {
            LabeledContent("Time zone", value: zoneName(form.timezone))
        }
        .accessibilityIdentifier("automation.zone")
        problem("timezone")
        menu("If a run is missed", selection: form.missedRun, choices.missed, id: "automation.missed") { form.missedRun = $0 }
    }

    @ViewBuilder private var custom: some View {
        GlassChoice(items: choices.syntaxes.map { GlassChoiceItem(id: $0.value, label: $0.label) },
                    selection: form.syntax, idPrefix: "automation.syntax") { form.syntax = $0 }
            .padding(.vertical, AceTheme.Spacing.xs)
        TextField(form.syntax == "cron" ? "30 7 * * 1-5" : "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9",
                  text: Binding(get: { form.expression }, set: { form.expression = $0; touch("expression") }))
            .aceMonospace(AceTheme.Typography.code, relativeTo: .body)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .accessibilityIdentifier("automation.expression")
        problem("expression")
    }

    /// "Starts": now, or a later day and time picked here.
    @ViewBuilder private var starts: some View {
        let later = view.instants?.startsAt != nil || pendingStart != nil
        Toggle("Start later", isOn: Binding(get: { later }, set: { on in
            touch("startsAt")
            if on {
                // Opens on the next whole hour from now.
                let next = Calendar.current.nextDate(after: .now, matching: DateComponents(minute: 0), matchingPolicy: .nextTime) ?? .now
                pendingStart = next
                change(["startsAt": ms(next)])
            } else {
                pendingStart = nil
                change(["startsAt": NSNull()])
            }
        }))
        .toggleStyle(.systemSwitch)
        .accessibilityIdentifier("automation.startLater")
        if later, let shown = pendingStart ?? date(view.instants?.startsAt) {
            DatePicker("Starts", selection: Binding(get: { shown }, set: { pendingStart = $0; change(["startsAt": ms($0)]) }),
                       in: Date.now...)
                .environment(\.timeZone, zone)
                .accessibilityIdentifier("automation.starts")
                .transition(.opacity)
        }
        problem("startsAt")
    }

    // MARK: GitHub and files

    @ViewBuilder private var github: some View {
        LabeledContent("Repository") {
            TextField("owner/name", text: Binding(get: { form.repository }, set: { form.repository = $0; touch("repository") }))
                .multilineTextAlignment(.trailing)
                .aceMonospace(AceTheme.Typography.code, relativeTo: .body)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                .accessibilityIdentifier("automation.repository")
        }
        problem("repository")
        menu("Event", selection: form.event, choices.events, id: "automation.event") { form.event = $0 }
        if form.event == "issue_labelled" {
            LabeledContent("Label") {
                TextField("needs-triage", text: Binding(get: { form.label }, set: { form.label = $0; touch("label") }))
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("automation.label")
            }
            .transition(.opacity)
            problem("label")
        }
        Text("ace checks GitHub every five minutes with this machine's GitHub sign-in.")
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
    }

    @ViewBuilder private var files: some View {
        TextField("src/**/*.ts", text: Binding(get: { form.paths }, set: { form.paths = $0; touch("paths") }), axis: .vertical)
            .lineLimit(2...8)
            .aceMonospace(AceTheme.Typography.code, relativeTo: .body)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .accessibilityIdentifier("automation.paths")
        problem("paths")
        Text("One path or glob per line, inside the project.")
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
    }

    // MARK: Parts

    private func menu(_ title: String, selection: String, _ options: [AutomationChoice], id: String,
                      set: @escaping (String) -> Void) -> some View {
        Picker(title, selection: Binding(get: { selection }, set: set)) {
            ForEach(options) { option in Text(option.label).tag(option.value) }
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier(id)
    }

    @ViewBuilder private func problem(_ field: String) -> some View {
        if let message = error(field) {
            Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.StatusText.failed)
                .transition(.opacity)
        }
    }
}

/// "London", "New York": a zone's city as people say it.
func zoneName(_ identifier: String) -> String {
    (identifier.split(separator: "/").last.map(String.init) ?? identifier).replacingOccurrences(of: "_", with: " ")
}

/// Every time zone, this phone's first, searchable by city or region.
struct AutomationZonePicker: View {
    @Binding var selection: String
    @State private var query = ""
    @Environment(\.dismiss) private var dismiss
    private var zones: [String] {
        let local = TimeZone.current.identifier
        let all = TimeZone.knownTimeZoneIdentifiers.filter { $0 != local }
        let listed = [local] + all
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return listed }
        return listed.filter { $0.localizedCaseInsensitiveContains(needle) || zoneName($0).localizedCaseInsensitiveContains(needle) }
    }
    var body: some View {
        List(zones, id: \.self) { zone in
            Button { selection = zone; dismiss() } label: {
                HStack {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        Text(zoneName(zone)).foregroundStyle(AceTheme.Colours.foreground)
                        Text(zone).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    Spacer()
                    if zone == selection { Image(systemName: "checkmark").foregroundStyle(AceTheme.Colours.foreground) }
                }
                .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .insetRowBackground()
        }
        .insetGroupedList()
        .searchable(text: $query, prompt: "City or region")
        .navigationTitle("Time zone").navigationBarTitleDisplayMode(.inline)
    }
}
