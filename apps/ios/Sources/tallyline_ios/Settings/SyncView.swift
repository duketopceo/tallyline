#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// Outbox, last sync, and what the phone keeps.
struct SyncView: View {
    var session: SessionModel
    @AppStorage("syncOnCellular") private var cellular = true
    @State private var confirmClear = false
    @State private var bytes = 0

    private var offline: OfflineModel { session.offline }

    var body: some View {
        Form {
            Section {
                NavigationLink {
                    OutboxView(offline: offline)
                } label: {
                    LabeledContent("Outbox") { statusPill }
                }
            } footer: {
                Text("Changes made offline wait in the outbox and send by themselves when you're back online.")
            }
            Section {
                LabeledContent("Last synced") {
                    if let at = offline.lastSyncedAt {
                        Text(at, format: .relative(presentation: .named))
                    } else {
                        Text("Not yet this launch")
                    }
                }
                Button("Sync now") { Task { await session.refresh() } }
            }
            Section {
                LabeledContent("Stored on this phone", value: ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))
                Button("Clear cached issues", role: .destructive) { confirmClear = true }
                Toggle("Sync on cellular", isOn: $cellular)
            } header: {
                Text("Cache")
            } footer: {
                Text("Turn cellular off to sync issues only on Wi-Fi. Writes still send whenever there is a connection.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Sync")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Clear cached issues?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear", role: .destructive) {
                offline.clearCache()
                bytes = offline.storageBytes()
                Task { await session.refresh() }
            }
        } message: {
            Text("The next sync loads every issue again. Unsent changes are kept.")
        }
        .task { bytes = offline.storageBytes() }
    }

    @ViewBuilder
    private var statusPill: some View {
        let parked = offline.count(.parked)
        let waiting = offline.entries.count - parked
        if parked > 0 {
            Text("\(parked) need you").foregroundStyle(Theme.urgent)
        } else if waiting > 0 {
            Text("\(waiting) waiting").foregroundStyle(Theme.inkMuted)
        } else {
            Text("All sent").foregroundStyle(Theme.inkMuted)
        }
    }
}

/// Writes saved on the phone that have not reached the server yet.
struct OutboxView: View {
    var offline: OfflineModel

    var body: some View {
        List {
            if offline.entries.isEmpty {
                ContentUnavailableView("All sent", systemImage: "checkmark.circle", description: Text("Changes made offline wait here until they send."))
            }
            ForEach(OutboxDisplayState.allCases, id: \.self) { state in
                let rows = offline.entries.filter { $0.displayState == state }
                if !rows.isEmpty {
                    Section {
                        ForEach(rows) { entry in row(entry) }
                    } header: {
                        Text(title(state)).font(.footnote.smallCaps())
                    }
                }
            }
        }
        .navigationTitle("Outbox")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if offline.count(.parked) > 0 {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Retry all", systemImage: "arrow.clockwise") { Task { await offline.retryParked() } }
                        Button("Discard parked", systemImage: "trash", role: .destructive) { Task { await offline.discardParked() } }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Outbox actions")
                }
            }
        }
        .refreshable { await offline.drain() }
    }

    private func title(_ state: OutboxDisplayState) -> String {
        switch state {
        case .pending: "Waiting to send"
        case .retrying: "Retrying"
        case .parked: "Need you"
        }
    }

    private func row(_ entry: OutboxEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.operation.summary).font(.body).foregroundStyle(Theme.ink)
            switch entry.displayState {
            case .pending:
                Text("Waiting to send").font(.caption).foregroundStyle(Theme.inkMuted)
            case .retrying:
                Text("Retrying (\(entry.attempts) tries so far)").font(.caption).foregroundStyle(Theme.inkMuted)
            case .parked:
                if case .failed(let reason) = entry.status {
                    Text(reason).font(.caption).foregroundStyle(Theme.urgent)
                }
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
#endif
