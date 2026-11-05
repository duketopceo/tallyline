#if os(iOS)
import SwiftUI
import UIKit
import TallylineCore
import TallylineDesign

struct AboutView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var copied = 0

    private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?" }
    private var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?" }

    private var report: String {
        let offline: OfflineModel = session.offline
        return DiagnosticsReport.text(
            device: UIDevice.current.model,
            os: "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
            appVersion: version, build: build,
            serverHost: credential.serverURL.host ?? "unknown",
            outbox: .init(pending: offline.count(.pending), retrying: offline.count(.retrying), parked: offline.count(.parked)),
            lastSync: offline.lastSyncedAt
        )
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Version", value: version)
                LabeledContent("Build", value: build)
            }
            Section {
                LabeledContent("App", value: "AGPL-3.0")
                LabeledContent("MCP server and CLI", value: "MIT")
                Link("Source code", destination: URL(string: "https://github.com/duketopceo/tallyline")!)
            } header: {
                Text("Open source")
            }
            Section {
                Button("Copy diagnostics") {
                    UIPasteboard.general.string = report
                    copied += 1
                }
                ShareLink("Share diagnostics", item: report)
            } header: {
                Text("Diagnostics")
            } footer: {
                Text("A short text with versions and counts for a bug report. It has no credentials, names or issue text.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: copied)
    }
}
#endif
