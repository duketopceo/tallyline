#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// Writes saved on the phone that have not reached the server yet.
struct OutboxView: View {
    var offline: OfflineModel

    var body: some View {
        List {
            if offline.entries.isEmpty {
                ContentUnavailableView("All sent", systemImage: "checkmark.circle", description: Text("Changes made offline wait here until they send."))
            }
            ForEach(offline.entries) { entry in
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.operation.summary).font(.body)
                    switch entry.status {
                    case .pending:
                        Text(entry.attempts == 0 ? "Waiting to send" : "Retrying (\(entry.attempts) tries so far)")
                            .font(.caption).foregroundStyle(Theme.inkMuted)
                    case .failed(let reason):
                        Text(reason).font(.caption).foregroundStyle(Theme.urgent)
                    }
                }
                .swipeActions {
                    Button("Discard", role: .destructive) { Task { await offline.discard(entry.id) } }
                    Button("Retry") { Task { await offline.retry(entry.id) } }.tint(Theme.accent)
                }
                .contextMenu {
                    Button("Retry") { Task { await offline.retry(entry.id) } }
                    Button("Discard", role: .destructive) { Task { await offline.discard(entry.id) } }
                }
            }
        }
        .navigationTitle("Outbox")
        .refreshable { await offline.drain() }
    }
}

/// Workspace, device, sign-out.
struct SettingsView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var whoami: Whoami?
    @Environment(\.dismiss) private var dismiss
    @AppStorage("appearance") private var appearance = SilverLiningAppearance.system.rawValue

    private var outboxSummary: String {
        let all = session.offline.entries.count
        let failed = session.offline.failedCount
        if all == 0 { return "All sent" }
        return failed > 0 ? "\(all) waiting, \(failed) need you" : "\(all) waiting"
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Workspace") {
                    LabeledContent("Name", value: credential.workspaceName)
                    LabeledContent("Server", value: credential.serverURL.host ?? credential.serverURL.absoluteString)
                }
                Section("Appearance") {
                    Picker("Theme", selection: $appearance) {
                        ForEach(SilverLiningAppearance.allCases, id: \.rawValue) { option in
                            Text(option.label).tag(option.rawValue)
                        }
                    }
                }
                Section("Notifications") {
                    NavigationLink("Notifications") { NotificationSettingsView(push: .shared) }
                }
                Section("Sync") {
                    NavigationLink {
                        OutboxView(offline: session.offline)
                    } label: {
                        LabeledContent("Outbox", value: outboxSummary)
                    }
                }
                Section("You") {
                    LabeledContent("Signed in as", value: whoami?.name ?? whoami?.id ?? "—")
                    LabeledContent("Credential expires", value: credential.expiresAt, format: .dateTime)
                }
                Section {
                    Button("Sign out", role: .destructive) {
                        Task {
                            await PushCenter.shared.unregister()
                            session.signOut()
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task {
                guard let client = session.client else { return }
                whoami = try? await client.whoami()
            }
        }
    }
}
#endif
