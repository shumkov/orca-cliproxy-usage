import { OperationFailure } from './failure.ts';
import type { FailureReason } from './failure.ts';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { CollectorRequest, CollectorResult, Profile } from './types.ts';

const BOOTSTRAP = "import sys,json;d=json.load(sys.stdin);exec(compile(d['source'],'collector','exec'));main(d['input'])";
const PYTHON = '/usr/bin/python3';
const MAX_OUTPUT = 1024 * 1024;

export function parseProfiles(value: unknown): Profile[] {
  if (typeof value !== 'string' || value.length > 32768) throw new Error('Connection profiles must be a JSON array');
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new Error('Connection profiles must be valid JSON'); }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16) throw new Error('Configure between 1 and 16 profiles');
  const ids = new Set<string>();
  return raw.map((input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid connection profile');
    const x = input as Record<string, unknown>;
    if (Object.keys(x).some(k => !['id', 'label', 'transport', 'configPath', 'baseUrl', 'target', 'secretPath'].includes(k))) throw new Error('Unknown connection profile field');
    if (typeof x.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(x.id) || ids.has(x.id)) throw new Error('Profile ids must be unique lowercase names');
    ids.add(x.id);
    if (typeof x.label !== 'string' || x.label.length < 1 || x.label.length > 100 || /[\x00-\x1f\x7f]/.test(x.label)) throw new Error('Invalid profile label');
    if (x.transport !== 'local' && x.transport !== 'ssh') throw new Error('Transport must be local or ssh');
    for (const field of ['configPath', 'secretPath']) {
      const path = x[field];
      if (field === 'secretPath' && path === undefined) continue;
      if (typeof path !== 'string' || path.length > 4096 || !/^(\/|~\/)/.test(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Paths must be absolute or home-relative');
    }
    if (typeof x.baseUrl !== 'string' || !/^https?:\/\/(127(?:\.\d{1,3}){3}|\[::1\]):\d{1,5}\/?$/.test(x.baseUrl)) throw new Error('Management URL must be literal loopback with an explicit port');
    const url = new URL(x.baseUrl);
    if (!url.port || Number(url.port) < 1 || Number(url.port) > 65535) throw new Error('Invalid management port');
    if (x.transport === 'ssh' && (typeof x.target !== 'string' || x.target.length > 255 || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(x.target))) throw new Error('SSH target must be a fixed host or user@host');
    if (x.transport === 'local' && x.target !== undefined) throw new Error('Local profiles do not use SSH targets');
    const canonical = Object.fromEntries(Object.entries(x).filter(([key]) => key !== 'label').sort(([a], [b]) => a.localeCompare(b)));
    return { ...x, revision: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') } as Profile;
  });
}

export function commandFor(profile: Profile): { program: string; args: string[] } {
  // Validate again at the process boundary, including persisted immutable targets.
  const { revision: _revision, ...input } = profile;
  parseProfiles(JSON.stringify([input]));
  if (profile.transport === 'local') return { program: PYTHON, args: ['-I', '-c', BOOTSTRAP] };
  return {
    program: '/usr/bin/ssh',
    args: ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
      '--', profile.target!, `${PYTHON} -I -c '${BOOTSTRAP.replaceAll("'", "'\\''")}'`],
  };
}

export async function runCollector(request: CollectorRequest, signal?: AbortSignal): Promise<CollectorResult> {
  let source: string;
  try { source = await readFile(new URL('./collector.py', import.meta.url), 'utf8'); }
  catch { throw new OperationFailure('source'); }
  let command: ReturnType<typeof commandFor>;
  try { command = commandFor(request.profile); } catch { throw new OperationFailure('profile'); }
  if (signal?.aborted) throw new OperationFailure('cancelled');
  const { program, args } = command;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn> & { stdin: NonNullable<ReturnType<typeof spawn>['stdin']>; stdout: NonNullable<ReturnType<typeof spawn>['stdout']>; stderr: NonNullable<ReturnType<typeof spawn>['stderr']> };
    try { child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
    catch { reject(new OperationFailure('spawn')); return; }
    let stdout = ''; let bytes = 0; let failed = false;
    const stop = (reason: FailureReason) => {
      if (failed) return;
      failed = true;
      child.kill('SIGTERM');
      reject(new OperationFailure(reason));
    };
    const timer = setTimeout(() => stop('timeout'), 60000);
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) stop('output-limit');
      else stdout += chunk;
    });
    // Remote diagnostics can contain paths or secrets; bound and discard them.
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) stop('output-limit');
    });
    child.stdin.on('error', () => stop('input'));
    child.on('error', () => stop('spawn'));
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failed) return;
      if (code !== 0) { reject(new OperationFailure('exit', code, exitSignal)); return; }
      try {
        const result = JSON.parse(stdout) as CollectorResult;
        if (!result || typeof result !== 'object' || (!result.error && !Array.isArray(result.accounts))) throw new Error();
        resolve(result);
      } catch { reject(new OperationFailure('response')); }
    });
    child.stdin.end(JSON.stringify({ source, input: request }));
  });
}
