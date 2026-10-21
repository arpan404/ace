import SwiftUI

/// The device's forms, as on the web's ⋯: install and open apps, open a link, and set where the
/// device is and its language.
enum DeviceAction: String, CaseIterable {
    case install = "Install app…"
    case openApp = "Open app…"
    case openURL = "Open URL…"
    case location = "Location…"
    case language = "Language and region…"

    var title: String { String(rawValue.dropLast()) }
    var symbol: String {
        switch self {
        case .install: "shippingbox"
        case .openApp: "app"
        case .openURL: "globe"
        case .location: "location"
        case .language: "character.bubble"
        }
    }
    fileprivate var field: String {
        switch self {
        case .install: "Path to an .app or .apk on the machine"
        case .openApp: "Bundle or package identifier"
        case .openURL: "https://example.com"
        case .location: ""
        case .language: "en-US"
        }
    }
}

/// The device screen's ⋯: logs and UI tree, rotate, appearance and screenshot, the forms, and
/// the live view, recording and power.
struct DeviceMenu: View {
    let info: DeviceScreenInfo?
    let canOperate: Bool
    let canDrive: Bool
    let busy: Bool
    let open: (DeviceSheet) -> Void
    let key: (String) -> Void
    let operate: ([String: Any]) -> Void
    let boot: () -> Void
    let screenshot: () -> Void
    let shutdown: () -> Void

    var body: some View {
        Menu {
            Section {
                Button("Logs", systemImage: "doc.text.magnifyingglass") { open(.logs) }
                Button("UI tree", systemImage: "list.bullet.indent") { open(.tree) }
            }
            if let info {
                Section {
                    Button("Rotate", systemImage: "rotate.right") { key("rotate") }.disabled(!canDrive)
                    Button("Device keyboard", systemImage: "keyboard.chevron.compact.down") { key("keyboard") }.disabled(!canDrive)
                    Menu("Appearance", systemImage: "circle.lefthalf.filled") {
                        Button("Light") { operate(["op": "configure", "settings": ["appearance": "light"]]) }
                        Button("Dark") { operate(["op": "configure", "settings": ["appearance": "dark"]]) }
                    }
                    .disabled(!canOperate || !info.running || busy)
                    Button("Screenshot", systemImage: "camera", action: screenshot).disabled(!info.live)
                }
                Section {
                    ForEach(DeviceAction.allCases, id: \.self) { action in
                        Button(action.rawValue, systemImage: action.symbol) { open(.action(action)) }
                    }
                }
                .disabled(!canOperate || !info.running || busy)
                if canOperate { power(info) }
            }
        } label: { Label("Device options", systemImage: "ellipsis") }
        .accessibilityIdentifier("devices.options")
    }

    @ViewBuilder private func power(_ info: DeviceScreenInfo) -> some View {
        Section {
            if info.live {
                Button(info.recording ? "Stop recording" : "Record", systemImage: info.recording ? "stop.circle" : "record.circle") {
                    operate(["op": info.recording ? "record.stop" : "record.start"])
                }
            }
            if info.cleanupRequired {
                Button("Retry cleanup", systemImage: "stop") { operate(["op": "stop"]) }
            } else if info.live {
                Button("Stop live view", systemImage: "stop") { operate(["op": "stop"]) }
            } else if info.running {
                Button("Start live view", systemImage: "play") { operate(["op": "start", "fps": 60]) }.disabled(info.busy)
            }
            if info.running {
                Button("Shut down…", systemImage: "power", role: .destructive, action: shutdown)
            } else {
                Button("Boot", systemImage: "power", action: boot).disabled(info.busy)
            }
        }
        .disabled(busy)
    }
}

/// One of the device's forms as a sheet: its field, and a check that sends it.
struct DeviceActionSheet: View {
    let action: DeviceAction
    let send: ([String: Any]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var value = ""
    @State private var latitude = ""
    @State private var longitude = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if action == .location {
                        TextField("Latitude", text: $latitude).keyboardType(.numbersAndPunctuation)
                        TextField("Longitude", text: $longitude).keyboardType(.numbersAndPunctuation)
                    } else {
                        TextField(action.field, text: $value)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .keyboardType(action == .openURL ? .URL : .default)
                            .submitLabel(.done).onSubmit(submit)
                    }
                } footer: {
                    if let error { Text(error).foregroundStyle(AceTheme.StatusText.failed) }
                }
            }
            .navigationTitle(action.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", systemImage: "xmark") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action.title, systemImage: "checkmark", action: submit).disabled(!ready)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private var ready: Bool {
        action == .location ? !latitude.isEmpty && !longitude.isEmpty : !value.trimmingCharacters(in: .whitespaces).isEmpty
    }
    private func submit() {
        let text = value.trimmingCharacters(in: .whitespaces)
        switch action {
        case .install: send(["op": "install", "path": text])
        case .openApp: send(["op": "open_app", "appId": text])
        case .openURL:
            guard let url = URL(string: text), url.scheme != nil, url.host != nil else {
                error = "Enter a complete URL, such as https://example.com."; return
            }
            send(["op": "open_url", "url": text])
        case .language:
            // The bridge checks the locale against the protocol and says if it isn't one.
            send(["op": "configure", "settings": ["locale": text]])
        case .location:
            guard let lat = Double(latitude), let long = Double(longitude) else {
                error = "Enter both latitude and longitude as numbers."; return
            }
            send(["op": "configure", "settings": ["location": ["latitude": lat, "longitude": long]]])
        }
        dismiss()
    }
}

/// The picture on the device's screen, to share or save.
struct DeviceScreenshotSheet: View {
    let image: UIImage
    let name: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Image(uiImage: image).resizable().scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: AceTheme.Radii.card, style: .continuous))
                .padding(AceTheme.Spacing.xl)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(AceTheme.Colours.background)
                .navigationTitle("Screenshot").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close", systemImage: "xmark") { dismiss() } }
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: Image(uiImage: image), preview: SharePreview(name, image: Image(uiImage: image)))
                    }
                }
        }
        .presentationDetents([.large])
    }
}
