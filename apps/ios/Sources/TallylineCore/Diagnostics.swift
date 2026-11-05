import Foundation

/// The text a person can copy or share when something is wrong. It carries
/// counts and versions only: no credential, no name, no email, no issue text.
public enum DiagnosticsReport {
    public struct Outbox: Sendable, Equatable {
        public var pending: Int, retrying: Int, parked: Int
        public init(pending: Int, retrying: Int, parked: Int) {
            self.pending = pending; self.retrying = retrying; self.parked = parked
        }
    }

    public static func text(
        device: String, os: String, appVersion: String, build: String,
        serverHost: String, outbox: Outbox, lastSync: Date?, now: Date = Date()
    ) -> String {
        let sync = lastSync.map { "\(Int(now.timeIntervalSince($0))) s ago" } ?? "not yet this launch"
        return [
            "Tallyline \(appVersion) (\(build))",
            "Device: \(device), \(os)",
            "Server: \(serverHost)",
            "Outbox: \(outbox.pending) pending, \(outbox.retrying) retrying, \(outbox.parked) parked",
            "Last sync: \(sync)",
        ].joined(separator: "\n")
    }
}
