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
    var icon: AceIcon.Name {
        switch self {
        case .install: .package
        case .openApp: .appWindow
        case .openURL: .globe
        case .location: .mapPin
        case .language: .translate
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

/// The device screen's ⋯: logs and UI tree, rotate and a foldable device's posture, appearance
/// and screenshot, the forms, and
/// the live view, recording and power.
struct DeviceMenu: View {
    let info: DeviceScreenInfo?
    let canOperate: Bool
    let canDrive: Bool
    let busy: Bool
    /// This phone's viewing choices.
    @Binding var screenOnly: Bool
    @Binding var showStats: Bool
    let open: (DeviceSheet) -> Void
    let key: (String) -> Void
    let operate: ([String: Any]) -> Void
    let boot: () -> Void
    let screenshot: () -> Void
    let shutdown: () -> Void

    var body: some View {
        Menu {
            Section {
                Button("Logs", ace: .fileMagnifyingGlass) { open(.logs) }
                Button("UI tree", ace: .treeView) { open(.tree) }
            }
            Section {
                Button(screenOnly ? "Show device frame" : "Show screen only", ace: .frameCorners) { screenOnly.toggle() }
                    .accessibilityIdentifier("devices.screenOnly")
                Button(showStats ? "Hide stream stats" : "Show stream stats", ace: .gauge) { showStats.toggle() }
                    .accessibilityIdentifier("devices.streamStats")
            }
            if let info {
                Section {
                    Button("Rotate", ace: .deviceRotate) { key("rotate") }.disabled(!canDrive)
                    if let posture = info.posture { postures(posture) }
                    Button("Device keyboard", ace: .keyboard) { key("keyboard") }.disabled(!canDrive)
                    Menu {
                        Button("Light") { operate(["op": "configure", "settings": ["appearance": "light"]]) }
                        Button("Dark") { operate(["op": "configure", "settings": ["appearance": "dark"]]) }
                    } label: {
                        Label("Appearance", ace: .circleHalf)
                    }
                    .disabled(!canOperate || !info.running || busy)
                    Button("Screenshot", ace: .camera, action: screenshot).disabled(!info.live)
                }
                Section {
                    ForEach(DeviceAction.allCases, id: \.self) { action in
                        Button(action.rawValue, ace: action.icon) { open(.action(action)) }
                    }
                }
                .disabled(!canOperate || !info.running || busy)
                if canOperate { power(info) }
            }
        } label: { Label("Device options", ace: .dotsThree) }
        .accessibilityIdentifier("devices.options")
    }

    /// A foldable device's postures as its hardware shows them; the current one is checked.
    private func postures(_ current: String) -> some View {
        Menu {
            ForEach(Self.postures, id: \.value) { posture in
                Button(posture.title, ace: posture.value == current ? .check : posture.icon) {
                    if posture.value != current { operate(["op": "posture", "posture": posture.value]) }
                }
            }
        } label: {
            Label("Posture", ace: Self.postures.first { $0.value == current }?.icon ?? .deviceTablet)
        }
        .disabled(!canDrive)
        .accessibilityIdentifier("devices.posture")
    }
    private static let postures: [(value: String, title: String, icon: AceIcon.Name)] = [
        ("closed", "Closed", .deviceMobile),
        ("partiallyOpen", "Half open", .bookOpen),
        ("open", "Open flat", .deviceTablet),
    ]

    @ViewBuilder private func power(_ info: DeviceScreenInfo) -> some View {
        Section {
            if info.live {
                Button(info.recording ? "Stop recording" : "Record", ace: info.recording ? .stopCircle : .record) {
                    operate(["op": info.recording ? "record.stop" : "record.start"])
                }
            }
            if info.cleanupRequired {
                Button("Retry cleanup", ace: .stop) { operate(["op": "stop"]) }
            } else if info.live {
                Button("Stop live view", ace: .stop) { operate(["op": "stop"]) }
            } else if info.running {
                Button("Start live view", ace: .play) { operate(["op": "start", "fps": 60]) }.disabled(info.busy)
            }
            if info.running {
                Button("Shut down…", ace: .power, role: .destructive, action: shutdown)
            } else {
                Button("Boot", ace: .power, action: boot).disabled(info.busy)
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
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", ace: .x) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action.title, ace: .check, action: submit).disabled(!ready)
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
                .clipShape(AceShape.block)
                .padding(AceTheme.Spacing.xl)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(AceTheme.Colours.background)
                .navigationTitle("Screenshot").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close", ace: .x) { dismiss() } }
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: Image(uiImage: image), preview: SharePreview(name, image: Image(uiImage: image)))
                    }
                }
        }
        .presentationDetents([.large])
    }
}

/// The live stream's stats over the stage, on glass: "H.264 · 59 fps", then what arrived and was
/// drawn, the bit rate, the longest stall and the keyframes asked for. Never takes a touch.
struct StreamStatsCard: View {
    let stats: DeviceStreamStats?
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(stats?.summary.isEmpty == false ? stats?.summary ?? "" : "H.264")
                .aceFont(AceTheme.Typography.label, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.foreground)
            ForEach(stats?.details ?? ["Waiting for the first picture"], id: \.self) { line in
                Text(line).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption2)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
        .monospacedDigit()
        .padding(.horizontal, AceTheme.Spacing.md).padding(.vertical, AceTheme.Spacing.sm)
        .aceGlass(in: RoundedRectangle(cornerRadius: AceTheme.Radii.lg, style: .continuous))
        .padding(AceTheme.Spacing.md)
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("devices.stats")
    }
}
