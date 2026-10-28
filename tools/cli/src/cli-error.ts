// CLI-side failure carrying an exit code. API-side failures stay ApiError.
export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}
