import SwiftUI
import UIKit

/// The page opened a picker (a `<select>`, a date, time or colour input): the person picks with
/// the phone's own controls and the choice goes back to the page as a `pick`. Cancel dismisses
/// the page's picker without changing the value. A kind the phone has no control for is typed in
/// the page's own format instead.
struct BrowserPickerSheet: View {
    let picker: BrowserPageInfo.Picker
    let choose: ([String]?) -> Void
    @State private var date: Date
    @State private var colour: Color
    @State private var typed: String
    @FocusState private var typing: Bool

    init(picker: BrowserPageInfo.Picker, choose: @escaping ([String]?) -> Void) {
        self.picker = picker
        self.choose = choose
        _typed = State(initialValue: picker.value)
        _date = State(initialValue: PickerValues.date(picker.value, kind: picker.kind) ?? Date())
        let rgb = PickerValues.rgb(picker.value) ?? (0, 0, 0)
        _colour = State(initialValue: Color(red: Double(rgb.red) / 255, green: Double(rgb.green) / 255, blue: Double(rgb.blue) / 255))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { choose(nil) } }
                    if picker.kind != "select" {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { choose(chosen.map { [$0] }) }.disabled(chosen == nil)
                                .accessibilityIdentifier("browser.picker.done")
                        }
                    }
                }
        }
        .presentationDetents(picker.kind == "select" ? [.medium, .large] : [.large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder private var content: some View {
        switch PickerValues.control(picker.kind) {
        case .options:
            ScrollView {
                VStack(spacing: AceDesign.Space.group) {
                ForEach(groups, id: \.offset) { group in
                    QuietSection(group.label) {
                        ForEach(group.options, id: \.offset) { option in
                            Button { choose([option.element.value]) } label: {
                                QuietSectionRow {
                                    Text(option.element.label.isEmpty ? option.element.value : option.element.label)
                                        .foregroundStyle(option.element.disabled == true ? AceDesign.Ink.muted : AceDesign.Ink.primary)
                                    Spacer()
                                    if option.element.value == picker.value { AceIcon(.check).foregroundStyle(AceDesign.Ink.accent) }
                                }
                            }
                            .disabled(option.element.disabled == true)
                            .accessibilityAddTraits(option.element.value == picker.value ? .isSelected : [])
                        }
                    }
                }
                }.padding(.vertical, AceDesign.Space.related)
            }
            .buttonStyle(.plain)
        case .colour:
            ScrollView { QuietSectionRow { ColorPicker("Colour", selection: $colour, supportsOpacity: false) } }
        case .date:
            ScrollView {
                if picker.kind == "time" { datePicker.datePickerStyle(.wheel) }
                else { datePicker.datePickerStyle(.graphical) }
            }
                .environment(\.timeZone, .gmt)
                .environment(\.calendar, Self.calendar)
        case .typed:
            ScrollView {
                QuietSection {
                    QuietSectionRow {
                        TextField("Value", text: $typed)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($typing)
                            .submitLabel(.done)
                            .onSubmit { choose([typed]) }
                            .accessibilityIdentifier("browser.picker.typed")
                    }
                }
                Text("The phone has no picker for a \(picker.kind.isEmpty ? "field like this" : "“\(picker.kind)” field"). Type the value the way the page expects it.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, AceDesign.Space.margin)
                .padding(.vertical, AceDesign.Space.related)
            }
            .onAppear { typing = true }
        }
    }

    @ViewBuilder private var datePicker: some View {
        let components: DatePickerComponents = switch picker.kind {
        case "time": .hourAndMinute
        case "datetime-local": [.date, .hourAndMinute]
        default: .date
        }
        let lower = picker.min.flatMap { PickerValues.date($0, kind: picker.kind) }
        let upper = picker.max.flatMap { PickerValues.date($0, kind: picker.kind) }
        Group {
            if let lower, let upper, lower <= upper {
                DatePicker(title, selection: $date, in: lower...upper, displayedComponents: components)
            } else if let lower {
                DatePicker(title, selection: $date, in: lower..., displayedComponents: components)
            } else if let upper {
                DatePicker(title, selection: $date, in: ...upper, displayedComponents: components)
            } else {
                DatePicker(title, selection: $date, displayedComponents: components)
            }
        }
    }

    /// The value the page's input takes, in its own format.
    private var chosen: String? {
        switch PickerValues.control(picker.kind) {
        case .typed: return typed
        case .colour:
            let resolved = UIColor(colour)
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            guard resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return nil }
            return PickerValues.hex(red: red, green: green, blue: blue)
        case .options, .date: return PickerValues.string(date, kind: picker.kind)
        }
    }
    private var title: String {
        switch picker.kind {
        case "select": "Choose"
        case "color": "Colour"
        case "time": "Time"
        case "month": "Month"
        case "week": "Week"
        default: PickerValues.control(picker.kind) == .typed ? "Value" : "Date"
        }
    }
    /// Options in order, grouped under their `<optgroup>` labels.
    private var groups: [(offset: Int, label: String?, options: [(offset: Int, element: BrowserPageInfo.Picker.Option)])] {
        var result: [(offset: Int, label: String?, options: [(offset: Int, element: BrowserPageInfo.Picker.Option)])] = []
        for (index, option) in (picker.options ?? []).enumerated() {
            if let last = result.last, last.label == option.group {
                result[result.count - 1].options.append((index, option))
            } else {
                result.append((result.count, option.group, [(index, option)]))
            }
        }
        return result
    }
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = .gmt
        return calendar
    }()
}
