import SwiftUI

/// The device toolbar, over a hairline above the bar: the device the tab is shown as (a menu of
/// phones, tablets and computers), its size, Rotate and Hide. Words only, as the strips above it.
struct BrowserDeviceBar: View {
    @Bindable var model: ClientModel
    let device: BrowserViewInfo.Device

    private var enabled: Bool { model.canOperate && device.supported }
    private var size: String {
        if let width = device.width, let height = device.height { return "\(width) × \(height)" }
        guard let page = model.browser.pageSize else { return "" }
        return "\(Int(page.width.rounded())) × \(Int(page.height.rounded()))"
    }

    var body: some View {
        HStack(spacing: AceTheme.Spacing.lg) {
            Menu {
                Section {
                    choice("This phone", id: "this-phone")
                }
                section("Phones", kind: "phone")
                section("Tablets", kind: "tablet")
                section("Computers", kind: "computer")
            } label: {
                Text(device.label)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .lineLimit(1)
            }
            .disabled(!enabled)
            .accessibilityLabel("Device, \(device.label)")
            .accessibilityIdentifier("browser.device.menu")
            Text(size)
                .monospacedDigit()
                .accessibilityLabel(size.replacingOccurrences(of: " × ", with: " by "))
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(1)
                .accessibilityIdentifier("browser.device.size")
            Spacer(minLength: 0)
            Button("Rotate") { model.browserRotateDevice() }
                .disabled(!enabled || device.width == nil)
                .accessibilityIdentifier("browser.device.rotate")
            Button("Hide") { model.browserDeviceToolbar(false) }
                .accessibilityLabel("Hide device toolbar")
                .accessibilityIdentifier("browser.device.hide")
        }
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .contentShape(Rectangle())
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
        .tint(AceTheme.Colours.foreground)
        .padding(.horizontal, AceTheme.Spacing.xl)
        .overlay(alignment: .top) {
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("browser.device")
    }

    @ViewBuilder private func section(_ title: String, kind: String) -> some View {
        Section(title) {
            ForEach(model.browser.presets.filter { $0.kind == kind }) { preset in
                choice(preset.label, id: preset.id)
            }
        }
    }
    private func choice(_ label: String, id: String) -> some View {
        Button {
            model.browserDevice(id)
        } label: {
            if id == device.preset {
                Label(label, ace: .check)
            } else {
                Text(label)
            }
        }
    }
}
