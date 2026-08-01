/**
 * Exit codes are a public contract (plan §4.1). Scripts and agents branch on
 * these, so they may be added to but never repurposed.
 */
export const ExitCode = {
  /** Success. For writes this also means the state change is confirmed. */
  Ok: 0,
  /** Operational failure — including `execute` outcome `failed`, where the
   *  chain transaction succeeded but the vault call did not. */
  Failure: 1,
  /** Usage error: unknown command, bad flag, missing required argument. */
  Usage: 2,
  /** Precondition not met, or a policy rule refused the action. */
  Precondition: 3,
  /** Not executed, and not an error: `approved_only` / `timelock_started`.
   *  `qv tx execute && deploy.sh` must not proceed on these. */
  NotExecuted: 4,
  /** The user declined at a confirmation prompt. An abort is not a failure. */
  Declined: 5,
  /** Interrupted (SIGINT). */
  Interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Map an SDK error code to an exit code.
 *
 * Deliberately a total function over the codes we know, with an explicit
 * fallback: an unrecognised code is an operational failure, never a silent 0.
 */
export function exitCodeForErrorCode(code: string | undefined): ExitCodeValue {
  switch (code) {
    case undefined:
      return ExitCode.Failure;
    case 'VALIDATION':
    case 'CONFIG':
      return ExitCode.Usage;
    case 'PRECONDITION':
    case 'NO_SIGNER':
    case 'NO_INDEXER':
    case 'STALE_PROPOSAL':
    case 'POLICY':
      return ExitCode.Precondition;
    case 'ABORTED':
      return ExitCode.Interrupted;
    default:
      return ExitCode.Failure;
  }
}
