import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mountWorker, mockHost, type TestWorker } from 'orca/testing';
import * as workerModule from '../src/worker.ts';
import type { View } from '../src/types.ts';
import type { JsonValue } from 'orca/host';
import { strictJson } from './strict-json.ts';

async function withOpenCommand(t: TestContext, outcome: { error?: Error; stdout: string }, action: (worker: TestWorker) => Promise<void>, pluginKey = 'local.cliproxy-usage', candidates?: unknown[], responses: { inspect?: string; list?: string; opens?: number } = {}) {
  let opens = 0;
  const selectors = ['ORCA_ENVIRONMENT', 'ORCA_ENVIRONMENT_ID', 'ORCA_PAIRING_CODE'] as const;
  const previous = selectors.map(key => process.env[key]);
  for (const key of selectors) process.env[key] = 'synthetic-inherited-selector';
  const run = t.mock.method(childProcess, 'execFile', ((...args: any[]) => {
    assert.equal(args[0], '/Applications/Orca.app/Contents/Resources/bin/orca');
    assert.equal(args[2].timeout, 10000);
    assert.equal(args[2].maxBuffer, 65536);
    assert.equal(args[2].env.ORCA_ENVIRONMENT, undefined);
    assert.equal(args[2].env.ORCA_ENVIRONMENT_ID, undefined);
    assert.equal(args[2].env.ORCA_PAIRING_CODE, undefined);
    const hash = 'a'.repeat(64);
    let stdout: string; let error: Error | null = null;
    if (args[1][1] === 'inspect') {
      assert.deepEqual(args[1], ['plugin', 'inspect', fileURLToPath(new URL('../', import.meta.url)), '--json']);
      stdout = responses.inspect ?? JSON.stringify({ ok: true, result: { valid: true, kind: 'plugin', contentHash: hash, plugin: { pluginKey: 'local.cliproxy-usage' } } });
    } else if (args[1][1] === 'list') {
      assert.deepEqual(args[1], ['plugin', 'list', '--environment', 'local', '--json']);
      stdout = responses.list ?? JSON.stringify({ ok: true, result: { plugins: candidates ?? [{ pluginKey, source: { kind: 'git', contentHash: hash } }] } });
    } else {
      assert.deepEqual(args[1], ['plugin', 'open', pluginKey, '--panel', 'usage', '--environment', 'local', '--json']);
      opens++; stdout = outcome.stdout; error = outcome.error ?? null;
    }
    queueMicrotask(() => args[3](error, stdout, 'private stderr must not be logged'));
    return {};
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  let worker: TestWorker | undefined;
  try {
    worker = await mountWorker(workerModule, { host: mockHost({ capabilities: ['storage:own', 'settings:own'], settings: { profiles: '[]' } }) });
    await action(worker); if (responses.opens !== undefined) assert.equal(opens, responses.opens);
  } finally {
    await worker?.deactivate(); run.mock.restore(); syncBuiltinESMExports();
    selectors.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
}

test('status and palette command rejects a CLI JSON refusal instead of reporting opened', async t => {
  for (const stdout of ['{"ok":false,"error":{"code":"unavailable","message":"private response must not be logged"}}', '', '{not JSON}',
    '{"ok":true,"result":{"kind":"panel","pluginKey":"another-plugin","panelId":"usage"}}']) {
    await withOpenCommand(t, { stdout }, async worker => {
      await assert.rejects(worker.command('usage.open'), /Could not open CLIProxy Usage panel/);
      assert.ok(worker.logs.includes('CLIProxy Usage open: failed stage=response operation=open'));
      assert.ok(!worker.logs.join(' ').includes('private'));
    });
  }
});

test('status and palette command logs dispatch and validated panel-open acknowledgement', async t => {
  await withOpenCommand(t, { stdout: '{"ok":true,"result":{"kind":"panel","pluginKey":"local.cliproxy-usage","panelId":"usage"}}' }, async worker => {
    assert.equal(await worker.command('usage.open'), 'CLIProxy Usage opened');
    assert.ok(worker.logs.includes('CLIProxy Usage open: started'));
    assert.ok(worker.logs.includes('CLIProxy Usage open: succeeded'));
    assert.ok(!worker.logs.join(' ').includes('private'));
  });
});

test('status and palette command classifies process failures without leaking stderr or errors', async t => {
  for (const [fields, stage] of [
    [{ code: 1 }, 'exit'], [{ code: null, signal: 'SIGTERM', killed: false }, 'exit'], [{ code: 'ENOENT' }, 'spawn'], [{ code: 'ETIMEDOUT', killed: true }, 'timeout'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'output-limit'], [{ code: 'private-error-code' }, 'spawn'],
  ] as const) {
    await withOpenCommand(t, { error: Object.assign(new Error('private failure must not be logged'), fields), stdout: 'private output must not be logged' }, async worker => {
      await assert.rejects(worker.command('usage.open'), /Could not open CLIProxy Usage panel/);
      assert.ok(worker.logs.includes(`CLIProxy Usage open: failed stage=${stage} operation=open`));
      assert.ok(!worker.logs.join(' ').includes('private'));
    });
  }
});

test('one failed provider status still publishes the other provider and panel state', async () => {
  const host = mockHost({ capabilities: ['storage:own', 'settings:own'], settings: { profiles: JSON.stringify([{ id: 'fixture', label: 'Fixture', transport: 'local', configPath: '/unused/config.json', baseUrl: 'http://127.0.0.1:8318' }]) } });
  const worker = await mountWorker(workerModule, { host });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const failed of ['codex', 'claude']) {
      const attempted: string[] = [];
      host.respond('statusBar.update', (params: { id: string }) => {
        attempted.push(params.id);
        if (params.id === failed) throw new Error('private host diagnostic must not be logged');
        return { ok: true };
      });
      const before = worker.posts.length;
      await worker.request('usage.mode', { mode: 'detailed' });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(attempted, ['codex', 'claude']);
      assert.ok(worker.posts.length > before, 'status failure must not suppress usage.changed');
      assert.equal(worker.posts.at(-1)!.event, 'usage.changed');
      assert.ok(worker.logs.some(line => line.includes(failed)));
      assert.ok(!worker.logs.join(' ').includes('private host diagnostic'));
    }
    host.respond('statusBar.update', { ok: true });
    const before = worker.posts.length;
    await worker.request('usage.mode', { mode: 'compact' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(worker.posts.length > before, 'later publication must recover');
  } finally { await worker.deactivate(); }
});

test('real Orca worker bridge collects and verifies Enabled through the host-local process', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'cliproxy-worker-'));
  const configPath = join(temp, 'config.json');
  const statePath = join(temp, 'state.json');
  await writeFile(configPath, JSON.stringify({ 'remote-management': { 'secret-key': 'test-secret' } }));
  await writeFile(statePath, JSON.stringify({ disabled: false }));
  let patchCount = 0;
  let rejectNextRead = false;
  let unavailableReads = 0;
  let holdNextRead = false; let readStarted!: () => void; let releaseRead!: () => void;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-secret');
    if (request.method === 'PATCH') {
      patchCount++;
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      await writeFile(statePath, JSON.stringify({ disabled: input.disabled }));
      if (patchCount === 2) unavailableReads = 1;
      // Simulate a committed write whose acknowledgement disappears.
      request.socket.destroy(); return;
    }
    if (rejectNextRead) { rejectNextRead = false; response.writeHead(401); response.end('{}'); return; }
    if (unavailableReads) { unavailableReads--; response.writeHead(503); response.end('{}'); return; }
    if (holdNextRead) { holdNextRead = false; readStarted(); await new Promise<void>(resolve => { releaseRead = resolve; }); }
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ files: [
      { name: 'fixture.json', auth_index: 'fixture', provider: 'codex', status: 'active', disabled: state.disabled, id_token: 'DO_NOT_LEAK' },
      { name: 'b'.repeat(56), email: 'a'.repeat(35), auth_index: 'claude-fixture', provider: 'claude', status: 'error', disabled: false,
        quota: { observed_at: 1794620296.136135, signals: { 'anthropic-ratelimit-unified-7d-utilization': 0.99, 'anthropic-ratelimit-unified-7d-reset': 1795143600 } } },
    ] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const host = mockHost({ capabilities: ['storage:own', 'settings:own'], settings: { profiles: JSON.stringify([{ id: 'fixture', label: 'Fixture', transport: 'local', configPath, baseUrl: `http://127.0.0.1:${port}` }]) } });
  const worker = await mountWorker(workerModule, { host });
  try {
    const initial = await worker.request('usage.state') as unknown as View;
    strictJson(initial);
    assert.equal(initial.selectedHost, null);
    const selected = await worker.request('usage.selectHost', { id: 'fixture' }) as unknown as View;
    strictJson(selected);
    const snapshot = selected.snapshot!;
    assert.equal(snapshot.accounts[0]!.disabled, false);
    const ready = new Promise<void>(resolve => { readStarted = resolve; }); holdNextRead = true;
    const background = worker.request('usage.refresh'); await ready;
    const saving = worker.request('usage.toggle', { profileId: 'fixture', revision: snapshot.revision, snapshotId: snapshot.snapshotId, key: snapshot.accounts[0]!.key, disabled: true });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(patchCount, 0, 'Enabled waits for queued read revalidation');
    releaseRead(); await background;
    const result = await saving as unknown as View;
    strictJson(result);
    assert.equal(result.snapshot!.accounts[0]!.disabled, true);
    assert.equal(result.snapshot!.pending, 0);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).disabled, true);
    assert.equal(patchCount, 1);
    const request = async (name: string, input?: any) => {
      strictJson(input ?? null);
      const result = await worker.request(name, input);
      strictJson(result);
      return result as unknown as View;
    };
    await request('usage.state');
    await request('usage.mode', { mode: 'detailed' });
    const refreshed = await request('usage.refresh');
    const target = (view: View) => ({ profileId: 'fixture', revision: view.snapshot!.revision, snapshotId: view.snapshot!.snapshotId, key: view.snapshot!.accounts[0]!.key });
    const rich = await request('usage.details', target(refreshed));
    assert.equal(rich.snapshot!.snapshotId, refreshed.snapshot!.snapshotId, 'quota-only read must preserve the authoritative Enabled target');
    await request('usage.details', target(rich));
    const unconfirmed = await request('usage.toggle', { ...target(rich), disabled: false });
    assert.equal(unconfirmed.snapshot!.pending, 1);
    const reconciled = await request('usage.reconcile', { revision: unconfirmed.snapshot!.revision });
    assert.equal(reconciled.snapshot!.pending, 0);
    assert.equal(reconciled.snapshot!.accounts[0]!.disabled, false);
    assert.equal(patchCount, 2);
    rejectNextRead = true;
    const rejected = await request('usage.refresh');
    assert.equal(rejected.snapshot!.rejected, true);
    const retried = await request('usage.retryAuthentication', { revision: rejected.snapshot!.revision });
    assert.equal(retried.snapshot!.rejected, false);
    const malformed: [string, JsonValue][] = [['usage.selectHost', null], ['usage.details', {}], ['usage.toggle', { ...target(retried), disabled: 'false' }], ['usage.mode', []], ['usage.displayAccount', { key: 1 }], ['usage.retryAuthentication', null], ['usage.reconcile', false]];
    for (const [name, input] of malformed) {
      await assert.rejects(worker.request(name, input));
    }
    assert.equal(patchCount, 2);
    assert.ok(!JSON.stringify(result).includes('DO_NOT_LEAK'));
    assert.ok(!JSON.stringify(host.data()).includes('test-secret'));
    assert.deepEqual(worker.refusals, []);
    assert.ok(host.callsOf('statusBar.update').length >= 2);
    for (const status of host.callsOf('statusBar.update') as { text: string; tooltip: string }[]) {
      assert.ok(status.text.length <= 64);
      assert.ok(status.tooltip.length <= 256);
    }
  } finally {
    await worker.deactivate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});


test('Git-installed status command opens its public identity instead of a local deployment', async t => {
  await withOpenCommand(t, { stdout: '{"ok":true,"result":{"kind":"panel","pluginKey":"shumkov.cliproxy-usage","panelId":"usage"}}' }, async worker => {
    assert.equal(await worker.command('usage.open'), 'CLIProxy Usage opened');
  }, 'shumkov.cliproxy-usage');
});

test('status open refuses missing or ambiguous content identities without opening another deployment', async t => {
  for (const candidates of [[], [{ pluginKey: 'wrong.cliproxy-usage', source: { contentHash: 'b'.repeat(64) } }],
    ['local', 'shumkov'].map(owner => ({ pluginKey: `${owner}.cliproxy-usage`, source: { contentHash: 'a'.repeat(64) } }))]) {
    await withOpenCommand(t, { stdout: '' }, async worker => {
      await assert.rejects(worker.command('usage.open'), /Could not open CLIProxy Usage panel/);
      assert.ok(worker.logs.includes('CLIProxy Usage open: failed stage=identity operation=list'));
    }, 'local.cliproxy-usage', candidates);
  }
});


test('malformed or refused identity inspection never reaches panel open', async t => {
  const valid = { valid: true, kind: 'plugin', contentHash: 'a'.repeat(64), plugin: { pluginKey: 'local.cliproxy-usage' } };
  for (const result of [null, {}, { ...valid, valid: false }, { ...valid, kind: 'catalog' }, { ...valid, contentHash: 'bad' }, { ...valid, plugin: { pluginKey: 'local.other' } }]) {
    await withOpenCommand(t, { stdout: '' }, async worker => {
      await assert.rejects(worker.command('usage.open'), /Could not open/);
    }, 'local.cliproxy-usage', undefined, { inspect: JSON.stringify({ ok: true, result }), opens: 0 });
  }
  for (const step of ['inspect', 'list'] as const) {
    for (const response of ['{bad JSON', '{"ok":false}', '{"ok":true,"result":null}']) {
      await withOpenCommand(t, { stdout: '' }, async worker => {
        await assert.rejects(worker.command('usage.open'), /Could not open/);
        assert.ok(worker.logs.some(line => line.endsWith(`operation=${step}`)));
      }, 'local.cliproxy-usage', undefined, { [step]: response, opens: 0 });
    }
  }
});

test('identical local and Git content opens the exact local source only after hash validation', async t => {
  const source = { kind: 'local-path', reference: fileURLToPath(new URL('../', import.meta.url)), contentHash: 'a'.repeat(64) };
  await withOpenCommand(t, { stdout: '{"ok":true,"result":{"kind":"panel","pluginKey":"local.cliproxy-usage","panelId":"usage"}}' }, async worker => {
    assert.equal(await worker.command('usage.open'), 'CLIProxy Usage opened');
  }, 'local.cliproxy-usage', [{ pluginKey: 'local.cliproxy-usage', source }, { pluginKey: 'shumkov.cliproxy-usage', source: { kind: 'git', contentHash: source.contentHash } }], { opens: 1 });
  await withOpenCommand(t, { stdout: '' }, async worker => {
    await assert.rejects(worker.command('usage.open'), /Could not open/);
  }, 'local.cliproxy-usage', [{ pluginKey: 'local.cliproxy-usage', source: { ...source, contentHash: 'b'.repeat(64) } }], { opens: 0 });
});


test('cached Git status command uses real file-local inspect without an environment selector', async t => {
  const temp = await mkdtemp(join(fileURLToPath(new URL('../', import.meta.url)), '.command-cache-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'plugins', 'shumkov.cliproxy-usage', 'a'.repeat(64));
  await mkdir(root, { recursive: true });
  for (const path of ['orca-plugin.json', 'src', 'README.md', 'LICENSE', 'docs', 'assets']) {
    await cp(new URL(`../${path}`, import.meta.url), join(root, path), { recursive: true });
  }
  const nativeExec = childProcess.execFile;
  const operations: string[] = []; let inspectedHash: string | undefined;
  const selectors = ['ORCA_ENVIRONMENT', 'ORCA_ENVIRONMENT_ID', 'ORCA_PAIRING_CODE'] as const;
  const previous = selectors.map(key => process.env[key]);
  for (const key of selectors) process.env[key] = 'synthetic-inherited-selector';
  const run = t.mock.method(childProcess, 'execFile', ((program: string, args: string[], options: any, callback: any) => {
    operations.push(args[1]!);
    if (args[1] === 'inspect') {
      assert.equal(args[2], root + '/');
      return nativeExec(program, args, options, (error, stdout) => {
        if (!error) {
          for (const key of selectors) assert.equal(options.env[key], undefined);
          inspectedHash = JSON.parse(stdout.toString()).result.contentHash;
        }
        callback(error, stdout, '');
      });
    }
    assert.match(inspectedHash!, /^[a-f0-9]{64}$/);
    if (args[1] === 'list') callback(null, JSON.stringify({ ok: true, result: { plugins: [{ pluginKey: 'shumkov.cliproxy-usage', source: { kind: 'git', contentHash: inspectedHash } }] } }), '');
    else {
      assert.deepEqual(args, ['plugin', 'open', 'shumkov.cliproxy-usage', '--panel', 'usage', '--environment', 'local', '--json']);
      callback(null, JSON.stringify({ ok: true, result: { kind: 'panel', pluginKey: 'shumkov.cliproxy-usage', panelId: 'usage' } }), '');
    }
    return {};
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  let worker: TestWorker | undefined;
  try {
    const module = await import(pathToFileURL(join(root, 'src/worker.ts')).href);
    worker = await mountWorker(module, { host: mockHost({ capabilities: ['storage:own', 'settings:own'], settings: { profiles: '[]' } }) });
    assert.equal(await worker.command('usage.open'), 'CLIProxy Usage opened');
    assert.deepEqual(operations, ['inspect', 'list', 'open']);
  } finally {
    await worker?.deactivate(); run.mock.restore(); syncBuiltinESMExports();
    selectors.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(temp, { recursive: true, force: true });
  }
});
