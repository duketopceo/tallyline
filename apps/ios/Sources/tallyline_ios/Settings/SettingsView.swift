#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// Settings, as a sheet from the profile button: one grouped form, native
/// controls only, every toggle with a footer saying what it does.
struct SettingsView: View {
    var session: SessionModel
    let credential: DeviceCredential
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
                }
                Section {
                    NavigationLink("Appearance") { AppearanceView() }
                    NavigationLink("Notifications") { NotificationSettingsView(push: .shared) }
                    NavigationLink { SyncView(session: session) } label: {
                        LabeledContent("Sync", value: syncSummary)
                    }
                    NavigationLink("Agents") { AgentsView(session: session, credential: credential) }
                    NavigationLink("About") { AboutView(session: session, credential: credential) }
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

    private var syncSummary: String {
        let parked = session.offline.count(.parked)
        if parked > 0 { return "\(parked) need you" }
        let waiting = session.offline.entries.count
        return waiting == 0 ? "All sent" : "\(waiting) waiting"
    }
}
#endif
