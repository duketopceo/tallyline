#if os(iOS)
import SwiftUI
import UIKit
import TallylineCore
import TallylineDesign

/// Settings, as a sheet from the profile button: one grouped form, native
/// controls only, every toggle with a footer saying what it does.
struct SettingsView: View {
    var session: SessionModel
    let credential: DeviceCredential
    /// Injected so each capability combination can be shown and tested.
    var channel: BuildChannel = .current
    @Environment(\.dismiss) private var dismiss
    @State private var confirmSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    NavigationLink { AccountView(session: session, credential: credential) } label: {
                        HStack(spacing: 12) {
                            Text(Initials.from(session.me?.name))
                                .font(.headline)
                                .foregroundStyle(Theme.ink)
                                .frame(width: 44, height: 44)
                                .background(Theme.surface3, in: Circle())
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session.me?.name ?? "Account").foregroundStyle(Theme.ink)
                                Text(credential.workspaceName).font(.footnote).foregroundStyle(Theme.inkMuted)
                            }
                        }
                    }
                    if !session.workspaceChoices.isEmpty {
                        NavigationLink { WorkspacesView(session: session, credential: credential) } label: {
                            LabeledContent("Workspace", value: credential.workspaceName)
                        }
                    }
                }
                Section {
                    NavigationLink("Appearance") { AppearanceView() }
                    NavigationLink("Notifications") { NotificationSettingsView(push: .shared) }
                    NavigationLink { SyncView(session: session) } label: {
                        LabeledContent("Sync", value: syncSummary)
                    }
                    NavigationLink("Agents") { AgentsView(session: session, credential: credential) }
                    if !iconNames.isEmpty {
                        NavigationLink("App icon") { AppIconView(names: iconNames) }
                    }
                    NavigationLink("About") { AboutView(session: session, credential: credential) }
                    if channel.offersFeedback {
                        Button("Send TestFlight feedback") {
                            // Opens TestFlight, where a screenshot and note go to the team.
                            if let url = URL(string: "itms-beta://") { UIApplication.shared.open(url) }
                        }
                    }
                }
                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Sign out of \(credential.workspaceName)?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    Task {
                        await PushCenter.shared.unregister()
                        session.signOut()
                    }
                }
            } message: {
                Text("Changes that have not sent yet are discarded.")
            }
            .task { await session.loadMe() }
        }
    }

    /// Alternate icons the build declares. Empty, so no row, until they ship.
    private var iconNames: [String] {
        guard UIApplication.shared.supportsAlternateIcons else { return [] }
        return AlternateIcons.declared(in: Bundle.main.infoDictionary)
    }

    private var syncSummary: String {
        let parked = session.offline.count(.parked)
        if parked > 0 { return "\(parked) need you" }
        let waiting = session.offline.entries.count
        return waiting == 0 ? "All sent" : "\(waiting) waiting"
    }
}
#endif
