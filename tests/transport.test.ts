import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseProfiles, runCollector } from '../src/transport.ts';

const profile = parseProfiles(JSON.stringify([{ id: 'fixture', label: 'Fixture', transport: 'local', configPath: '~/fixture.json', baseUrl: 'http://127.0.0.1:8318' }]))[0]!;
const request = { profile, operation: 'read' as const };

test('collector failures expose bounded reasons without remote diagnostic text', async t => {
  for (const reason of ['exit', 'response', 'output-limit', 'input', 'spawn', 'cancelled', 'timeout', 'signal', 'sync-spawn'] as const) {
    await t.test(reason, async t => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; } });
      const abort = new AbortController();
      let notify!: () => void; const ready = new Promise<void>(resolve => { notify = resolve; });
      t.mock.method(childProcess, 'spawn', () => {
        if (reason === 'sync-spawn') throw new Error('private executable');
        queueMicrotask(() => {
          notify();
          if (reason === 'signal') child.emit('close', null, 'SIGTERM');
          if (reason === 'exit') child.emit('close', 255, null);
          if (reason === 'response') { child.stdout.write('private invalid response'); child.emit('close', 0, null); }
          if (reason === 'output-limit') child.stderr.write('x'.repeat(1024 * 1024 + 1));
          if (reason === 'input') child.stdin.emit('error', new Error('private key path'));
          if (reason === 'spawn') child.emit('error', new Error('private environment'));
          if (reason === 'cancelled') abort.abort();
        });
        return child;
      });
      syncBuiltinESMExports();
      if (reason === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const pending = runCollector(request, abort.signal);
        if (reason === 'timeout') { await ready; t.mock.timers.tick(60000); }
        await assert.rejects(pending, (error: any) => {
          assert.equal(error.reason, reason === 'signal' ? 'exit' : reason === 'sync-spawn' ? 'spawn' : reason);
          if (reason === 'signal') assert.equal(error.signal, 'SIGTERM');
          if (reason === 'exit') assert.equal(error.exitCode, 255);
          assert.doesNotMatch(error.message, /private|xxxx/); return true;
        });
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    });
  }
});

test('invalid process profiles are classified without echoing their contents', async () => {
  await assert.rejects(runCollector({ ...request, profile: { ...profile, target: 'private target' } }), (error: any) => {
    assert.equal(error.reason, 'profile'); assert.doesNotMatch(error.message, /private/); return true;
  });
});

test('collector source failures are classified without exposing local paths', async t => {
  t.mock.method(fs, 'readFile', async () => { throw new Error('private source path'); }); syncBuiltinESMExports();
  try {
    await assert.rejects(runCollector(request), (error: any) => {
      assert.equal(error.reason, 'source'); assert.doesNotMatch(error.message, /private|path/); return true;
    });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
