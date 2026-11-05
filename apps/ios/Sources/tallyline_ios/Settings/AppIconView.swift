#if os(iOS)
import SwiftUI
import UIKit
import TallylineCore
import TallylineDesign

/// Settings > App icon. Reached only when the build declares alternate icons
/// (`AlternateIcons.declared`); none ship yet, so the row stays hidden.
struct AppIconView: View {
    let names: [String]
    @State private var current = UIApplication.shared.alternateIconName
    @State private var failed = false

    var body: some View {
        Form {
            Section {
                choice("Default", name: nil)
                ForEach(names, id: \.self) { name in choice(name, name: name) }
            } footer: {
                if failed { Text("Could not change the icon. Try again.").foregroundStyle(Theme.urgent) }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("App icon")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func choice(_ title: String, name: String?) -> some View {
        Button {
            Task {
                do {
                    try await UIApplication.shared.setAlternateIconName(name)
                    current = name
                    failed = false
                } catch {
                    failed = true
                }
            }
        } label: {
            HStack {
                Text(title).foregroundStyle(Theme.ink)
                Spacer()
                if current == name {
                    Image(systemName: "checkmark").foregroundStyle(Theme.accent).accessibilityHidden(true)
                }
            }
        }
        .accessibilityAddTraits(current == name ? .isSelected : [])
    }
}
#endif
