export type FailureReason = 'source' | 'profile' | 'cancelled' | 'spawn' | 'input' | 'timeout' | 'output-limit' | 'exit' | 'response' | 'storage';
export class OperationFailure extends Error {
  readonly reason: FailureReason;
  readonly exitCode?: number;
  readonly signal?: string;
  constructor(reason: FailureReason, exitCode?: number | null, signal?: string | null) {
    super(reason === 'cancelled' ? 'Request cancelled' : `Collector operation failed (${reason})`);
    this.reason = reason;
    if (Number.isInteger(exitCode) && exitCode! >= 0 && exitCode! <= 255) this.exitCode = exitCode!;
    if (signal && ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGPIPE', 'SIGABRT', 'SIGSEGV', 'SIGALRM'].includes(signal)) this.signal = signal;
  }
}

export function failureDiagnostic(operation: 'read' | 'rich', stage: 'queue' | 'transport' | 'apply' | 'reconcile' | 'rich', error: unknown, started: number) {
  const failure = error instanceof OperationFailure ? error : null;
  const elapsed = Date.now() - started;
  return `CLIProxy Usage failure operation=${operation} stage=${stage} reason=${failure?.reason ?? 'unexpected'} elapsedMs=${Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0}`
    + (failure?.exitCode === undefined ? '' : ` exitCode=${failure.exitCode}`)
    + (failure?.signal === undefined ? '' : ` signal=${failure.signal}`);
}
