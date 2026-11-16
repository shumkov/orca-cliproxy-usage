import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OperationFailure } from '../src/failure.ts';
import { Controller } from '../src/service.ts';
import { commandFor, parseProfiles } from '../src/transport.ts';
import { displayWindows, isFresh, summary } from '../src/summary.ts';
import { strictJson } from './strict-json.ts';
import type { Account, CollectorRequest, CollectorResult, Store } from '../src/types.ts';

const profiles = parseProfiles(JSON.stringify([
  { id: 'local', label: 'Local', transport: 'local', configPath: '~/config.json', baseUrl: 'http://127.0.0.1:8318' },
  { id: 'remote', label: 'Remote', transport: 'ssh', target: 'user@proxy.example.test', configPath: '~/config.json', baseUrl: 'http://127.0.0.1:8318' },
]));
const account = { key: 'entry-a', identity: { name: 'a.json', authIndex: 'a' }, provider: 'codex', email: 'a@example.test', name: 'a.json',
  disabled: false, available: true, status: 'active', requiresSignIn: false, quotaBlocked: false, unavailable: false,
  windows: [], modelWindows: [], cooldowns: [], recent: [], priority: 10, credits: null, plan: null } satisfies Account;
function memory(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, get: async key => structuredClone(data.get(key)), set: async (key, value) => { data.set(key, structuredClone(value)); } };
}
const good = (): CollectorResult => ({ accounts: [structuredClone(account)], observedAt: Date.now() });
async function setup(transport = async (_request: CollectorRequest): Promise<CollectorResult> => good(), store = memory()) {
  const controller = new Controller(profiles, store, transport);
  await controller.initialize();
  await controller.select('local');
  return { controller, store, snapshot: controller.view().snapshot! };
}
function target(snapshot: { profileId: string; revision: string; snapshotId: string }) {
  return { profileId: snapshot.profileId, revision: snapshot.revision, snapshotId: snapshot.snapshotId, key: account.key };
}

test('panel initial state and host snapshots can cross Orca strict JSON validation', async () => {
  const controller = new Controller(profiles, memory(), async () => good());
  await controller.initialize();
  try {
    strictJson(controller.view());
    strictJson(await controller.select('local'));
    strictJson(await controller.details(target(controller.view().snapshot!)));
  } finally { controller.dispose(); }
});

test('partial rich responses do not introduce undefined metadata into panel snapshots', async () => {
  const { controller, snapshot } = await setup(async request => ({ ...good(), ...(request.operation === 'rich' ? { rich: { windows: [], observedAt: Date.now() } } : {}) }));
  try {
    const result = await controller.details(target(snapshot));
    strictJson(result);
    assert.equal(result.snapshot!.accounts[0]!.rich!.plan, null);
    assert.equal(result.snapshot!.accounts[0]!.rich!.credits, null);
    assert.equal(result.snapshot!.accounts[0]!.rich!.resetEntitlements, null);
  } finally { controller.dispose(); }
});

test('rejects wrong host and stale snapshot before dispatching a mutation', async () => {
  const calls: CollectorRequest[] = []; let changed = false;
  const { controller, snapshot } = await setup(async request => { calls.push(request); const result = good(); if (changed) result.accounts![0]!.status = 'changed'; return result; });
  await assert.rejects(controller.toggle({ ...target(snapshot), revision: 'old', disabled: true }), /Stale/);
  changed = true; await controller.refresh();
  await assert.rejects(controller.toggle({ ...target(snapshot), disabled: true }), /Stale/);
  await controller.select('remote');
  await assert.rejects(controller.toggle({ ...target(controller.view().snapshot!), profileId: 'local', disabled: true }), /Stale/);
  assert.equal(calls.filter(x => x.operation === 'toggle').length, 0);
  controller.dispose();
});

test('outer rejection persists across restart and only explicit retry makes one request', async () => {
  let calls = 0;
  const store = memory();
  const transport = async (): Promise<CollectorResult> => { calls++; return { error: 'Management authentication rejected', authRejected: true }; };
  const first = await setup(transport, store);
  await first.controller.refresh();
  assert.equal(calls, 1);
  first.controller.dispose();
  const second = new Controller(profiles, store, transport);
  await second.initialize();
  await second.refresh();
  assert.equal(calls, 1);
  await second.retryAuthentication(profiles[0]!.revision);
  assert.equal(calls, 2);
  await second.refresh();
  assert.equal(calls, 2);
  second.dispose();
});

test('ambiguous write stays durable and reconciliation reads without repeating PATCH', async () => {
  let applied = false; let patches = 0;
  const store = memory();
  const transport = async (request: CollectorRequest): Promise<CollectorResult> => {
    if (request.operation === 'toggle') { patches++; applied = true; throw new Error('lost response'); }
    const result = good(); result.accounts![0]!.disabled = applied; return result;
  };
  const { controller, snapshot } = await setup(transport, store);
  await controller.toggle({ ...target(snapshot), disabled: true });
  assert.equal(controller.view().snapshot!.accounts[0]!.mutation, 'unconfirmed');
  controller.dispose();
  const restarted = new Controller(profiles, store, transport);
  await restarted.initialize();
  await restarted.refresh();
  assert.equal(restarted.view().snapshot!.pending, 0);
  assert.equal(restarted.view().snapshot!.accounts[0]!.disabled, true);
  assert.equal(patches, 1);
  restarted.dispose();
});

test('single flight and bounded queue serialize polling, rich reads, and writes', async () => {
  let running = 0; let peak = 0; let reads = 0;
  const { controller } = await setup(async request => {
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 5));
    if (request.operation === 'read') reads++;
    running--; return good();
  });
  await Promise.all([controller.refresh(), controller.refresh(), controller.refresh()]);
  assert.equal(peak, 1);
  assert.equal(reads, 2);
  controller.dispose();
});

test('nested provider error preserves basic quota and rich cache prevents navigation storms', async () => {
  let richCalls = 0;
  const { controller, snapshot } = await setup(async request => {
    const result = good();
    result.accounts![0]!.windows = [{ label: 'Primary', usedPercent: 22, resetAt: Date.now() + 5000, observedAt: Date.now() }];
    if (request.operation === 'rich') {
      richCalls++;
      result.rich = { windows: [], observedAt: Date.now(), error: 'Provider authentication rejected (401)' };
    }
    return result;
  });
  await controller.details(target(snapshot));
  await controller.details(target(controller.view().snapshot!));
  const current = controller.view().snapshot!;
  strictJson(controller.view());
  assert.equal(current.rejected, false);
  assert.equal(current.accounts[0]!.windows[0]!.usedPercent, 22);
  assert.equal(richCalls, 1);
  controller.dispose();
});

test('host switch cancels old reads and late response cannot replace new host', async () => {
  let release!: () => void;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let slow = false;
  const { controller } = await setup(async request => {
    if (slow && request.profile.id === 'local') { ready(); await new Promise<void>(resolve => { release = resolve; }); }
    return good();
  });
  slow = true;
  const old = controller.refresh();
  await started;
  await controller.select('remote');
  release(); await old;
  assert.equal(controller.view().selectedHost, 'remote');
  assert.equal(controller.view().snapshot!.profileId, 'remote');
  controller.dispose();
});

test('profiles reject shell/SSH options and non-loopback management routes', () => {
  const base = { id: 'test', label: 'Test', transport: 'ssh', target: 'user@proxy.example.test', configPath: '~/x; $(touch y)', baseUrl: 'http://127.0.0.1:8318' };
  const valid = parseProfiles(JSON.stringify([base]))[0]!;
  const command = commandFor(valid);
  assert.equal(command.program, '/usr/bin/ssh');
  assert.ok(command.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(!command.args.join(' ').includes(base.configPath));
  for (const target of ['-oProxyCommand=evil', 'host;id', 'host\ncommand', 'x@-host']) {
    assert.throws(() => parseProfiles(JSON.stringify([{ ...base, target }])));
  }
  for (const baseUrl of ['http://example.com:8318', 'http://user@127.0.0.1:8318', 'http://127.0.0.1:8318/?q=x', 'http://127.0.0.1:8318/#x']) {
    assert.throws(() => parseProfiles(JSON.stringify([{ ...base, baseUrl }])));
  }
});

test('stale counts are unknown and account percentages are never aggregated', async () => {
  const { controller } = await setup();
  const snapshot = controller.view().snapshot!;
  snapshot.accounts.push({ ...account, key: 'entry-b', email: account.email, disabled: true, available: false });
  const prefs = { mode: 'compact' as const, selected: {} };
  assert.match(summary('codex', snapshot, prefs, 'Local').text, /1\/2/);
  assert.match(summary('codex', snapshot, prefs, 'Local').tooltip, /a@example.test · Account 1/);
  snapshot.observedAt = Date.now() - 120001;
  assert.equal(isFresh(snapshot), false);
  assert.match(summary('codex', snapshot, prefs, 'Local').text, /—\/—.*Stale/);
  snapshot.error = 'Transport failed';
  assert.match(summary('codex', snapshot, prefs, 'Local').text, /Unavailable/);
  controller.dispose();
});

test('Remote Claude status fits Orca tooltip limits with real metadata lengths', async () => {
  const { controller } = await setup();
  try {
    const snapshot = controller.view().snapshot!;
    const observedAt = 1794620296136.135;
    const now = 1794744673891.724;
    snapshot.profileId = 'remote'; snapshot.observedAt = now;
    snapshot.accounts = Array.from({ length: 5 }, (_, index) => ({ ...structuredClone(account),
      key: `entry-${index}`, provider: 'claude', email: 'a'.repeat(35), name: 'b'.repeat(56), available: false,
      windows: [{ label: '7 days', usedPercent: 99, observedAt, resetAt: 1795143600000 }],
    }));
    const status = summary('claude', snapshot, { mode: 'detailed' }, 'Remote', now);
    assert.ok(status.text.length <= 64);
    assert.ok(status.tooltip.length <= 256, `Orca rejects tooltip length ${status.tooltip.length}`);
    assert.match(status.tooltip, /^a{35} · Account 1/);
    snapshot.accounts[0]!.name = '🦊'.repeat(512);
    const long = summary('claude', snapshot, { mode: 'detailed' }, 'H'.repeat(100), now);
    assert.ok(long.tooltip.length <= 256);
    assert.match(long.tooltip, /^a{35} · Account 1/);
    assert.ok(!/[\uD800-\uDFFF]/u.test(long.tooltip));
    snapshot.error = '🦊'.repeat(200);
    const stale = summary('claude', snapshot, { mode: 'detailed' }, 'Remote', now);
    assert.ok(stale.tooltip.length <= 256);
    assert.ok(!/[\uD800-\uDFFF]/u.test(stale.tooltip));
  } finally { controller.dispose(); }
});

test('status tooltip shows account, plan, usage and reset without technical narration', async () => {
  const { controller } = await setup();
  try {
    const now = Date.now(); const snapshot = controller.view().snapshot!;
    snapshot.observedAt = now;
    snapshot.accounts[0]!.plan = 'Pro 500';
    snapshot.accounts[0]!.windows = [{ label: 'Primary', usedPercent: 24, observedAt: now, resetAt: now + 259200000 }];
    assert.equal(summary('codex', snapshot, { mode: 'compact' }, 'Private host', now).tooltip,
      'a@example.test · Pro 500 · 24% used · resets in 3d');
    snapshot.accounts[0]!.windows = [];
    const missing = summary('codex', snapshot, { mode: 'compact' }, 'Private host', now);
    assert.equal(missing.text, 'Codex 1/1 · N/A');
    assert.equal(missing.tooltip, 'a@example.test · Pro 500 · N/A');
    const empty = summary('claude', snapshot, { mode: 'compact' }, 'Private host', now);
    assert.equal(empty.text, 'Claude 0/0 · N/A');
  } finally { controller.dispose(); }
});

test('status keeps old usage and passed reset honest with concise warnings', async () => {
  const { controller } = await setup();
  try {
    const now = Date.now(); const snapshot = controller.view().snapshot!;
    snapshot.observedAt = now;
    snapshot.accounts[0]!.windows = [{ label: 'Weekly', usedPercent: 99, observedAt: now - 259200000, resetAt: now - 1 }];
    const prefs = { mode: 'compact' as const, selected: {} };
    const old = summary('codex', snapshot, prefs, 'Private host', now);
    assert.match(old.text, /99% used.*Updated 3d ago.*reset passed/);
    assert.match(old.tooltip, /99% used.*reset passed.*Updated 3d ago/);
    assert.doesNotMatch(old.tooltip, /\.json|observed|deterministic|routing|credential|\d{4}-\d\d-\d\dT/);
    snapshot.rejected = true; snapshot.error = 'Management authentication rejected';
    const rejected = summary('codex', snapshot, prefs, 'Private host', now);
    assert.equal(rejected.text, 'Codex —/— · Authentication failed');
    assert.match(rejected.tooltip, /Could not authenticate/);
    snapshot.rejected = false; snapshot.error = 'Transport failed';
    const unavailable = summary('codex', snapshot, prefs, 'Private host', now);
    assert.equal(unavailable.text, 'Codex —/— · Unavailable');
    assert.match(unavailable.tooltip, /Could not update usage/);
  } finally { controller.dispose(); }
});

test('long account metadata cannot hide stale, passed-reset or failure warnings', async () => {
  const { controller } = await setup();
  try {
    const now = Date.now(); const snapshot = controller.view().snapshot!;
    snapshot.observedAt = now;
    const entry = snapshot.accounts[0]!;
    entry.email = '🦊'.repeat(160) + '@example.test'; entry.plan = 'P'.repeat(300);
    entry.windows = [{ label: 'Weekly', usedPercent: 99, observedAt: now - 259200000, resetAt: now - 1 }];
    snapshot.accounts.push({ ...structuredClone(entry), key: 'entry-b' });
    for (const error of [null, 'Transport failed', 'The change could not be confirmed']) {
      snapshot.error = error ?? undefined;
      for (const rejected of [false, true]) {
        snapshot.rejected = rejected;
        const value = summary('codex', snapshot, { mode: 'compact' }, 'Private host', now);
        assert.ok(value.tooltip.length <= 256);
        assert.ok(!/[\uD800-\uDFFF]/u.test(value.tooltip));
        assert.match(value.tooltip, /99% used.*reset passed.*Updated 3d ago/);
        assert.match(value.tooltip, /Account 1/);
        if (rejected) assert.match(value.tooltip, /Could not authenticate/);
        else if (error) {
          assert.match(value.tooltip, /Could not update usage/);
          assert.doesNotMatch(value.tooltip, /Could not connect/);
        }
      }
    }
  } finally { controller.dispose(); }
});

test('missing-email filenames never become status account labels and legacy duplicate selection is ignored', async () => {
  const { controller } = await setup();
  try {
    const snapshot = controller.view().snapshot!;
    snapshot.accounts[0]!.email = account.name;
    const prefs = { mode: 'compact' as const, selected: {} as Record<string, string> };
    assert.equal(summary('codex', snapshot, prefs, 'Private host').tooltip, 'Account 1 · N/A');
    snapshot.accounts[0]!.email = 'Unnamed credential'; snapshot.accounts[0]!.name = null;
    assert.equal(summary('codex', snapshot, prefs, 'Private host').tooltip, 'Account 1 · N/A');
    snapshot.accounts = [structuredClone(account), { ...structuredClone(account), key: 'entry-b' }];
    prefs.selected['local:codex'] = 'entry-b';
    assert.equal(summary('codex', snapshot, prefs, 'Private host').tooltip, 'a@example.test · Account 1 · N/A');
  } finally { controller.dispose(); }
});

test('Claude 1/5 defaults to the sole available 22% account instead of an exhausted 100% entry', async () => {
  const { controller } = await setup();
  try {
    const now = Date.now(); const snapshot = controller.view().snapshot!; snapshot.observedAt = now;
    snapshot.accounts = Array.from({ length: 5 }, (_, index) => ({ ...structuredClone(account), provider: 'claude', key: `entry-${index}`,
      email: `account-${index}@example.test`, available: index === 4, quotaBlocked: index !== 4,
      windows: [{ label: 'Weekly', usedPercent: index === 4 ? 22 : 100, resetAt: now + 259200000, observedAt: index === 4 ? now : now - 432000000 }] }));
    const preferences = { mode: 'compact' as const, selected: {} as Record<string, string> };
    let value = summary('claude', snapshot, preferences, 'Private host', now);
    assert.equal(value.text, 'Claude 1/5 · 22% used · 3d');
    assert.match(value.tooltip, /^account-4@example.test/);
    assert.doesNotMatch(value.tooltip, /stale|100%/);
    assert.deepEqual(preferences.selected, {});
    snapshot.accounts[3]!.available = true; snapshot.accounts[3]!.quotaBlocked = false;
    snapshot.accounts[4]!.priority = 100;
    value = summary('claude', snapshot, preferences, 'Private host', now);
    assert.match(value.tooltip, /^account-4@example.test/);
    preferences.selected['local:claude'] = 'removed-entry';
    assert.match(summary('claude', snapshot, preferences, 'Private host', now).tooltip, /^account-4@example.test/);
    snapshot.observedAt = now - 120001;
    assert.match(summary('claude', snapshot, preferences, 'Private host', now).text, /^Claude —\/— · Stale/);
  } finally { controller.dispose(); }
});

test('Codex 2/2 shows the fresh 26% Weekly account instead of the first available account with no usage data', async () => {
  const { controller } = await setup();
  try {
    const now = Date.now(); const snapshot = controller.view().snapshot!; snapshot.observedAt = now;
    snapshot.accounts = [
      { ...structuredClone(account), key: 'a', email: 'account@organization-1.example.test', windows: [] },
      { ...structuredClone(account), key: 'b', email: 'account@organization-2.example.test', windows: [{ label: 'Weekly', minutes: 10080, usedPercent: 26, observedAt: now, resetAt: now + 259200000 }] },
    ];
    const preferences = { mode: 'detailed' as const, selected: {} };
    const value = summary('codex', snapshot, preferences, 'Private host', now);
    assert.equal(value.text, 'Codex 2/2 · 26% used · 3d');
    assert.equal(value.tooltip, 'account@organization-2.example.test · 26% used · resets in 3d');
    assert.deepEqual(preferences.selected, {});
  } finally { controller.dispose(); }
});

test('automatic usage prefers fresh then stale then unknown, treats zero as known, and ignores obsolete unknown choice', async () => {
  const { controller } = await setup();
  try {
    const now = Date.now(); const snapshot = controller.view().snapshot!; snapshot.observedAt = now;
    const unknown = { ...structuredClone(account), key: 'a', email: 'unknown@example.test' };
    const stale = { ...structuredClone(account), key: 'b', email: 'stale@example.test', windows: [{ label: 'Weekly', usedPercent: 70, observedAt: now - 120001, resetAt: null }] };
    const fresh = { ...structuredClone(account), key: 'c', email: 'fresh@example.test', windows: [{ label: 'Weekly', usedPercent: 0, observedAt: now - 120000, resetAt: null }] };
    snapshot.accounts = [fresh, stale, unknown];
    const preferences = { mode: 'compact' as const, selected: {} as Record<string, string> };
    let value = summary('codex', snapshot, preferences, 'Private host', now);
    assert.equal(value.text, 'Codex 3/3 · 0% used');
    assert.match(value.tooltip, /^fresh@example.test/);
    preferences.selected['local:codex'] = 'a';
    assert.match(summary('codex', snapshot, preferences, 'Private host', now).tooltip, /^fresh@example.test · 0% used/);
    preferences.selected['local:codex'] = 'missing';
    fresh.windows[0]!.observedAt = now + 1;
    value = summary('codex', snapshot, preferences, 'Private host', now);
    assert.match(value.tooltip, /^stale@example.test · 70% used · Updated 2m ago/);
    stale.windows[0]!.observedAt = now;
    fresh.windows[0]!.observedAt = now;
    assert.match(summary('codex', snapshot, preferences, 'Private host', now).tooltip, /^stale@example.test/);
    stale.windows = []; fresh.windows = [];
    assert.match(summary('codex', snapshot, preferences, 'Private host', now).tooltip, /^unknown@example.test/);
    assert.deepEqual(snapshot.accounts.map(a => a.key), ['c', 'b', 'a']);
    assert.equal(preferences.selected['local:codex'], 'missing');
  } finally { controller.dispose(); }
});

test('quota quality uses the displayed merged window and cannot promote an unavailable account', async () => {
  const { controller } = await setup();
  try {
    const now = Date.now(); const snapshot = controller.view().snapshot!; snapshot.observedAt = now;
    const window = { id: 'weekly', label: 'Weekly', usedPercent: 26, observedAt: now, resetAt: null };
    snapshot.accounts = [
      { ...structuredClone(account), key: 'a', email: 'blocked@example.test', available: false, disabled: true, windows: [window] },
      { ...structuredClone(account), key: 'b', email: 'unknown@example.test', windows: [{ ...window, usedPercent: null }, { ...window, id: 'review', label: 'Code review' }] },
      { ...structuredClone(account), key: 'c', email: 'known@example.test', windows: [window] },
    ];
    const preferences = { mode: 'compact' as const, selected: {} };
    assert.match(summary('codex', snapshot, preferences, 'Private host', now).tooltip, /^known@example.test · 26% used/);
    snapshot.accounts[1]!.windows = [{ ...window, id: 'model', model: 'Model A' }, { ...window, usedPercent: null }];
    assert.match(summary('codex', snapshot, preferences, 'Private host', now).tooltip, /^known@example.test/);
    snapshot.accounts[1]!.rich = { observedAt: now, windows: [{ ...window, observedAt: now - 120001, usedPercent: 100 }] };
    snapshot.accounts[1]!.windows = [{ ...window, usedPercent: 0 }];
    assert.match(summary('codex', snapshot, preferences, 'Private host', now).tooltip, /^unknown@example.test · 0% used$/);
    snapshot.accounts[1]!.windows = []; delete snapshot.accounts[1]!.rich;
    snapshot.accounts[2]!.available = false;
    assert.equal(summary('codex', snapshot, preferences, 'Private host', now).tooltip, 'unknown@example.test · N/A');
    snapshot.accounts[1]!.available = false;
    assert.match(summary('codex', snapshot, preferences, 'Private host', now).tooltip, /^blocked@example.test · Disabled/);
    snapshot.accounts[0]!.windows = [];
    assert.equal(summary('codex', snapshot, preferences, 'Private host', now).tooltip, 'blocked@example.test · Disabled · N/A');
  } finally { controller.dispose(); }
});

test('obsolete unavailable status selection is ignored and zero-available fallback explains its state', async () => {
  const { controller } = await setup();
  try {
    const now = Date.now(); const snapshot = controller.view().snapshot!; snapshot.observedAt = now;
    snapshot.accounts = [
      { ...structuredClone(account), key: 'a', available: false, quotaBlocked: true, windows: [{ label: 'Weekly', usedPercent: 100, observedAt: now, resetAt: now + 259200000 }] },
      { ...structuredClone(account), key: 'b', available: true, windows: [{ label: 'Weekly', usedPercent: 22, observedAt: now, resetAt: now + 259200000 }] },
    ];
    const explicit = { mode: 'compact' as const, selected: { 'local:codex': 'a' } };
    const value = summary('codex', snapshot, explicit, 'Private host', now);
    assert.match(value.text, /1\/2 · 22% used/);
    assert.doesNotMatch(value.tooltip, /Limit reached|100%/);
    assert.equal(explicit.selected['local:codex'], 'a');
    snapshot.accounts[1]!.available = false; snapshot.accounts[1]!.disabled = true;
    const fallback = summary('codex', snapshot, { mode: 'compact' }, 'Private host', now);
    assert.match(fallback.text, /0\/2 · 100% used/);
    assert.match(fallback.tooltip, /Account 1.*Limit reached/);
  } finally { controller.dispose(); }
});

test('a cancelled panel action cannot dispatch a queued Enabled write', async () => {
  let writes = 0;
  const { controller, snapshot } = await setup(async request => { if (request.operation === 'toggle') writes++; return good(); });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(controller.toggle({ ...target(snapshot), disabled: true }, abort.signal), /cancelled/);
  assert.equal(writes, 0);
  controller.dispose();
});

test('a subsequent transport failure invalidates current availability immediately', async () => {
  let fail = false;
  const { controller } = await setup(async () => { if (fail) throw new Error('secret transport diagnostics'); return good(); });
  fail = true; await controller.refresh();
  const snapshot = controller.view().snapshot!;
  assert.equal(snapshot.fresh, false);
  assert.equal(snapshot.accounts.length, 1);
  assert.ok(!JSON.stringify(snapshot).includes('secret transport diagnostics'));
  controller.dispose();
});

test('a dispatched write remains bound to the original host after selection changes', async () => {
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const calls: CollectorRequest[] = [];
  const { controller, snapshot } = await setup(async request => {
    calls.push(request);
    const result = good();
    if (request.operation === 'toggle') {
      started(); await new Promise<void>(resolve => { release = resolve; });
      result.accounts![0]!.disabled = true; result.mutation = 'confirmed';
    }
    return result;
  });
  const write = controller.toggle({ ...target(snapshot), disabled: true });
  await waiting;
  await controller.select('remote');
  release(); await write;
  const view = controller.view();
  assert.equal(view.snapshot!.profileId, 'remote');
  assert.equal(view.snapshot!.accounts[0]!.disabled, false);
  assert.equal(calls.find(c => c.operation === 'toggle')!.profile.id, 'local');
  controller.dispose();
});

test('renaming a rejected profile never retries the same rejected key', async () => {
  let calls = 0;
  const { controller } = await setup(async () => { calls++; return { authRejected: true, error: 'Rejected' }; });
  controller.replaceProfiles(profiles.map(profile => {
    const { revision, ...input } = profile;
    return parseProfiles(JSON.stringify([{ ...input, label: 'Renamed' }]))[0]!;
  }));
  await controller.refresh();
  assert.equal(calls, 1);
  controller.dispose();
});

test('new basic quota supersedes older matching rich data and preserves rich-only windows', () => {
  const value = structuredClone(account) as Account;
  value.windows = [{ id: 'primary_window', label: 'Primary', usedPercent: 90, resetAt: null, observedAt: 200 }];
  value.rich = { observedAt: 100, windows: [
    { id: 'primary_window', label: 'Primary Window', usedPercent: 20, resetAt: null, observedAt: 100 },
    { id: 'review', label: 'Code review', usedPercent: 2, resetAt: null, observedAt: 100 },
  ] };
  assert.equal(displayWindows(value)[0]!.usedPercent, 90);
  assert.equal(displayWindows(value).length, 2);
});

test('a queued old-host write stays cancelled after switching away and back', async () => {
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let slow = false; let writes = 0;
  const { controller, snapshot } = await setup(async request => {
    if (request.operation === 'toggle') writes++;
    if (slow && request.profile.id === 'local' && request.operation === 'read') {
      slow = false; started(); await new Promise<void>(resolve => { release = resolve; });
    }
    return good();
  });
  slow = true;
  const read = controller.refresh(); await waiting;
  const write = controller.toggle({ ...target(snapshot), disabled: true });
  await controller.select('remote');
  const back = controller.select('local');
  const rejected = assert.rejects(write, /cancelled/);
  release(); await read; await back; await rejected;
  assert.equal(writes, 0);
  controller.dispose();
});

test('rich, polling and Enabled all share one bounded host queue', async () => {
  let running = 0; let peak = 0; let release!: () => void; let started!: () => void;
  let blockRich = false;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const operations: string[] = [];
  const { controller, snapshot } = await setup(async request => {
    operations.push(request.operation); running++; peak = Math.max(peak, running);
    if (blockRich && request.operation === 'rich') { blockRich = false; started(); await new Promise<void>(resolve => { release = resolve; }); }
    const result = good();
    if (request.operation === 'toggle') { result.accounts![0]!.disabled = true; result.mutation = 'confirmed'; }
    running--; return result;
  });
  blockRich = true;
  const rich = controller.details(target(snapshot)); await waiting;
  const read = controller.refresh();
  const burst = Array.from({ length: 10 }, () => controller.details(target(snapshot)));
  const burstResult = Promise.allSettled(burst);
  release(); await rich; await read;
  const rejected = await burstResult;
  assert.ok(rejected.some(result => result.status === 'rejected' && /queue is full/.test(String(result.reason))));
  await controller.toggle({ ...target(controller.view().snapshot!), disabled: true });
  assert.equal(peak, 1);
  assert.ok(['read', 'rich', 'toggle'].every(operation => operations.includes(operation)));
  controller.dispose();
});

 test('startup ignores obsolete pins while preserving host, mode and rejected pending journals without writes', async () => {
  const store = memory(); const profile = profiles[0]!;
  store.data.set('selectedHost', 'local');
  store.data.set('preferences', { mode: 'detailed', selected: { 'local:codex': 'blocked' } });
  store.data.set('connections', { [profile.revision]: { profile, rejected: true, pending: [{ key: account.key, identity: account.identity, disabled: true, phase: 'unconfirmed' }] } });
  const before = structuredClone(store.data); let calls = 0;
  const controller = new Controller(profiles, store, async () => { calls++; return good(); });
  try {
    await controller.initialize(); const view = controller.view();
    assert.deepEqual(view.preferences, { mode: 'detailed' }); assert.equal(view.selectedHost, 'local');
    assert.equal(view.snapshot!.rejected, true); assert.equal(view.snapshot!.pending, 1);
    assert.deepEqual(store.data, before); assert.equal(calls, 0);
  } finally { controller.dispose(); }
});

test('refresh and details failures log their actual stage without leaking private exception text', async () => {
  const logs: string[] = []; let failure = false;
  const controller = new Controller(profiles, memory(), async request => {
    if (failure && request.operation === 'read') throw new Error('private token and host');
    if (failure) return { ...good(), rich: { windows: null, observedAt: Date.now() } } as unknown as CollectorResult;
    return good();
  }, (message: string) => logs.push(message));
  try {
    await controller.initialize(); await controller.select('local'); failure = true;
    await controller.details(target(controller.view().snapshot!));
    assert.match(logs[0]!, /operation=rich stage=rich reason=unexpected elapsedMs=\d+/);
    await controller.refresh();
    assert.match(logs[1]!, /operation=read stage=transport reason=unexpected elapsedMs=\d+/);
    assert.equal(controller.view().snapshot!.accounts.length, 1); assert.equal(controller.view().snapshot!.fresh, false);
    assert.doesNotMatch(logs.join(''), /private|token|host/);
  } finally { controller.dispose(); }
});

test('storage failures retain the auth rejection latch and identify apply rather than SSH', async () => {
  const logs: string[] = []; const store = memory(); let reject = false;
  const controller = new Controller(profiles, { get: store.get, set: async (key, value) => {
    if (reject && key === 'connections') throw new Error('private storage path'); await store.set(key, value);
  } }, async () => reject ? { authRejected: true, error: 'Authentication failed' } : good(), message => logs.push(message));
  try {
    await controller.initialize(); await controller.select('local'); reject = true; await controller.refresh();
    assert.match(logs[0]!, /operation=read stage=apply reason=storage/);
    assert.equal(controller.view().snapshot!.rejected, true); assert.equal(controller.view().snapshot!.accounts.length, 1);
    const count = logs.length; await controller.refresh(); assert.equal(logs.length, count);
    assert.doesNotMatch(logs.join(''), /private|path/);
  } finally { controller.dispose(); }
});

test('journal reconciliation storage failure is distinguished and a broken logger cannot change stale fences', async () => {
  const store = memory(); const profile = profiles[0]!; let fail = false; const logs: string[] = [];
  store.data.set('connections', { [profile.revision]: { profile, rejected: false, pending: [{ key: account.key, identity: account.identity, disabled: false, phase: 'unconfirmed' }] } });
  const controller = new Controller(profiles, { get: store.get, set: async (key, value) => {
    if (fail && key === 'connections') throw new Error('private journal'); await store.set(key, value);
  } }, async () => { fail = true; return good(); }, message => { logs.push(message); throw new Error('logging offline'); });
  try {
    await controller.initialize(); await controller.select('local');
    assert.match(logs[0]!, /operation=read stage=reconcile reason=storage/);
    assert.equal(controller.view().snapshot!.fresh, false); assert.equal(controller.view().snapshot!.accounts.length, 1);
  } finally { controller.dispose(); }
});

test('cancelled old-host reads are logged without marking the newly selected host stale', async () => {
  const logs: string[] = []; let slow = false; let notify!: () => void;
  const ready = new Promise<void>(resolve => { notify = resolve; });
  const controller = new Controller(profiles, memory(), async (request, signal) => {
    if (slow && request.profile.id === 'local') {
      notify(); await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new OperationFailure('cancelled')), { once: true }));
    }
    return good();
  }, message => logs.push(message));
  try {
    await controller.initialize(); await controller.select('local'); slow = true;
    const pending = controller.refresh(); await ready; await controller.select('remote'); await pending;
    assert.match(logs[0]!, /operation=read stage=transport reason=cancelled/);
    assert.equal(controller.view().snapshot!.fresh, true); assert.equal(controller.view().snapshot!.profileId, 'remote');
    assert.doesNotMatch(logs.join(''), /private/);
  } finally { controller.dispose(); }
});

test('Remote Disabled Claude 31% can be enabled after a queued quota-only read without losing its credential target', async () => {
  let release!: () => void; let started!: () => void; let writes = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const entry: Account = { ...structuredClone(account), provider: 'claude', email: 'demo@example.test', disabled: true, available: false, plan: 'Max 20x', windows: [{ label: 'Seven Day', usedPercent: 31, observedAt: Date.now(), resetAt: Date.now() + 259200000 }] };
  const { controller, snapshot } = await setup(async request => {
    if (request.operation === 'rich') { started(); await new Promise<void>(resolve => { release = resolve; }); }
    if (request.operation === 'toggle') { writes++; entry.disabled = request.disabled!; entry.available = !entry.disabled; }
    return { accounts: [structuredClone(entry)], observedAt: Date.now(), ...(request.operation === 'toggle' ? { mutation: 'confirmed' as const } : {}) };
  });
  try {
    const rich = controller.details(target(snapshot)); await ready;
    const write = controller.toggle({ ...target(snapshot), disabled: false });
    const result = Promise.all([rich, write]); release(); await result;
    assert.equal(writes, 1); assert.equal(controller.view().snapshot!.accounts[0]!.disabled, false);
    assert.equal(controller.view().snapshot!.pending, 0);
  } finally { controller.dispose(); }
});

test('initial and rich loading are published before completion while previous accounts remain visible', async () => {
  let release!: () => void; let started!: () => void;
  const controller = new Controller(profiles, memory(), async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return good(); });
  try {
    await controller.initialize();
    let ready = new Promise<void>(resolve => { started = resolve; });
    const selection = controller.select('local'); await ready;
    assert.equal(controller.view().snapshot!.readState, 'loading'); release(); await selection;
    assert.equal(controller.view().snapshot!.readState, 'settled');
    ready = new Promise<void>(resolve => { started = resolve; });
    const rich = controller.details(target(controller.view().snapshot!)); await ready;
    assert.deepEqual(controller.view().snapshot!.loadingDetails, [account.key]);
    assert.equal(controller.view().snapshot!.accounts.length, 1); release(); await rich;
    assert.deepEqual(controller.view().snapshot!.loadingDetails, []);
  } finally { controller.dispose(); }
});

test('credential changes invalidate old targets, including changes back and submitting after host return', async () => {
  let writes = 0; let current = structuredClone(account) as Account;
  const { controller, snapshot } = await setup(async request => { if (request.operation === 'toggle') writes++; return { accounts: [structuredClone(current)], observedAt: Date.now() }; });
  try {
    const original = target(snapshot);
    const stable = controller.view().snapshot!.snapshotId;
    current.windows = [{ label: 'Weekly', usedPercent: 31, observedAt: Date.now(), resetAt: null }]; current.plan = 'Max 20x';
    await controller.refresh(); assert.equal(controller.view().snapshot!.snapshotId, stable);
    for (const patch of [{ disabled: true }, { identity: { name: 'b.json', authIndex: 'b' } }, { quotaBlocked: true }, { provider: 'claude' }, { available: false }]) {
      current = { ...structuredClone(account), ...patch }; await controller.refresh();
      await assert.rejects(controller.toggle({ ...original, disabled: true }), /Stale/);
      current = structuredClone(account); await controller.refresh();
      await assert.rejects(controller.toggle({ ...original, disabled: true }), /Stale/);
    }
    const beforeSwitch = target(controller.view().snapshot!);
    await controller.select('remote'); await controller.select('local');
    await assert.rejects(controller.toggle({ ...beforeSwitch, disabled: true }), /Stale/);
    assert.equal(writes, 0);
  } finally { controller.dispose(); }
});

test('rich loading counts overlapping queued reads and clears after cancellation', async () => {
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }); let richCalls = 0;
  const { controller, snapshot } = await setup(async request => {
    if (request.operation === 'rich' && ++richCalls === 1) { started(); await new Promise<void>(resolve => { release = resolve; }); }
    return good();
  });
  try {
    const first = controller.details(target(snapshot)); await ready;
    const abort = new AbortController(); const second = controller.details(target(snapshot), abort.signal);
    const rejected = assert.rejects(second, /cancelled/); abort.abort(); release(); await first; await rejected;
    assert.deepEqual(controller.view().snapshot!.loadingDetails, []);
  } finally { controller.dispose(); }
});

test('queued duplicate rich reads respect the first response cache and retain newly loaded quota', async () => {
  let release!: () => void; let started!: () => void; let calls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const { controller, snapshot } = await setup(async request => {
    if (request.operation !== 'rich') return good();
    calls++; if (calls === 1) { started(); await new Promise<void>(resolve => { release = resolve; }); }
    return { ...good(), rich: { windows: calls === 1 ? [{ label: 'Weekly', usedPercent: 31, observedAt: Date.now(), resetAt: null }] : [], observedAt: Date.now(), retryAt: Date.now() + 600000 } };
  });
  try {
    const first = controller.details(target(snapshot)); await ready;
    const second = controller.details(target(snapshot)); release(); await Promise.all([first, second]);
    assert.equal(calls, 1); assert.equal(controller.view().snapshot!.accounts[0]!.rich!.windows[0]!.usedPercent, 31);
    assert.deepEqual(controller.view().snapshot!.loadingDetails, []);
  } finally { controller.dispose(); }
});

test('uncertain mutation verification cannot coalesce onto a pre-write background read', async () => {
  let releaseRead!: () => void; let releaseWrite!: () => void; let startRead!: () => void; let startWrite!: () => void;
  const readReady = new Promise<void>(resolve => { startRead = resolve; }); const writeReady = new Promise<void>(resolve => { startWrite = resolve; });
  let block = false; let disabled = false; const operations: string[] = [];
  const { controller, snapshot } = await setup(async request => {
    operations.push(request.operation);
    if (request.operation === 'read' && block) { block = false; startRead(); await new Promise<void>(resolve => { releaseRead = resolve; }); }
    if (request.operation === 'toggle') { startWrite(); await new Promise<void>(resolve => { releaseWrite = resolve; }); disabled = true; }
    const result = good(); result.accounts![0]!.disabled = disabled; result.accounts![0]!.available = !disabled;
    if (request.operation === 'toggle') result.mutation = 'confirmed'; return result;
  });
  let read: Promise<unknown> | undefined; let write: Promise<unknown> | undefined; let verification: Promise<unknown> | undefined;
  try {
    block = true; read = controller.refresh(); await readReady;
    write = controller.toggle({ ...target(snapshot), disabled: true });
    let verified = false;
    verification = controller.refresh(true).then(view => { verified = true; return view; });
    releaseRead(); await writeReady; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(verified, false, 'a fresh pre-write read is not mutation verification');
    releaseWrite(); await Promise.all([read, write, verification]);
    assert.deepEqual(operations, ['read', 'read', 'toggle', 'read']);
    assert.equal(controller.view().snapshot!.accounts[0]!.disabled, true);
  } finally { releaseRead?.(); releaseWrite?.(); await Promise.allSettled([read, write, verification]); controller.dispose(); }
});

test('three-minute quota age is neutral while unknown times and failed updates remain honest', async () => {
  const { controller } = await setup();
  try {
    const now = Date.now(); const snapshot = controller.view().snapshot!;
    snapshot.accounts[0]!.windows = [{ label: 'Weekly', usedPercent: 31, observedAt: now - 180000, resetAt: now + 259200000 }];
    const value = summary('codex', snapshot, { mode: 'compact' }, 'Local', now);
    assert.doesNotMatch(value.text + value.tooltip, /stale/i);
    assert.match(value.text, /31% used.*Updated 3m ago/);
    for (const observedAt of [null, now + 1]) {
      snapshot.accounts[0]!.windows[0]!.observedAt = observedAt;
      assert.match(summary('codex', snapshot, { mode: 'compact' }, 'Local', now).tooltip, /Update time unknown/);
    }
    snapshot.error = 'Host transport unavailable';
    assert.match(summary('codex', snapshot, { mode: 'compact' }, 'Local', now).tooltip, /Could not update usage/);
    assert.equal(isFresh(snapshot, now), false);
  } finally { controller.dispose(); }
});

test('queued Enabled still rejects an expired or changed authoritative state before dispatch', async t => {
  const realNow = Date.now(); let now = realNow; const clock = t.mock.method(Date, 'now', () => now);
  try {
    for (const changed of [false, true]) {
      let release!: () => void; let started!: () => void; let block = false; let writes = 0;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const { controller, snapshot } = await setup(async request => {
        if (request.operation === 'read' && block) { started(); await new Promise<void>(resolve => { release = resolve; }); }
        if (request.operation === 'toggle') writes++;
        const result = good(); result.observedAt = realNow;
        if (changed && block) result.accounts![0]!.identity = { name: 'replaced.json', authIndex: 'new' };
        return result;
      });
      try {
        now = realNow; block = true; const read = controller.refresh(); await ready;
        const write = controller.toggle({ ...target(snapshot), disabled: true });
        const refused = assert.rejects(write, /Stale/);
        if (!changed) now += 120001; release(); await read; await refused;
        assert.equal(writes, 0);
      } finally { controller.dispose(); now = realNow; }
    }
  } finally { clock.mock.restore(); }
});

test('journal intent stays separate from authoritative Enabled and cannot decorate a replaced identity', async () => {
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const { controller, snapshot } = await setup(async request => {
    if (request.operation !== 'toggle') return good();
    started(); await new Promise<void>(resolve => { release = resolve; });
    const result = good(); result.accounts![0]!.identity = { name: 'replacement.json', authIndex: 'other' }; result.mutation = 'unconfirmed'; return result;
  });
  try {
    const saving = controller.toggle({ ...target(snapshot), disabled: true }); await ready;
    let entry = controller.view().snapshot!.accounts[0]!;
    assert.equal(entry.disabled, false); assert.equal(entry.mutationDisabled, true);
    release(); await saving; entry = controller.view().snapshot!.accounts[0]!;
    assert.equal(entry.mutation, undefined); assert.equal(entry.mutationDisabled, undefined);
    assert.equal(controller.view().snapshot!.pending, 1);
  } finally { release?.(); controller.dispose(); }
});

test('confirmed unapplied Enabled preserves fresh credentials and permits a deliberate retry', async () => {
  let writes = 0;
  const { controller, snapshot } = await setup(async request => { if (request.operation === 'toggle') { writes++; return { ...good(), mutation: 'not_applied' }; } return good(); });
  try {
    const result = await controller.toggle({ ...target(snapshot), disabled: true });
    assert.equal(result.snapshot!.fresh, true); assert.equal(result.snapshot!.error, undefined);
    assert.match(result.snapshot!.accounts[0]!.mutationError!, /Could not change Enabled/);
    await controller.toggle({ ...target(result.snapshot!), disabled: true }); assert.equal(writes, 2);
  } finally { controller.dispose(); }
});

test('uncertain writes lock only their identity without renewing old credentials or repeating a PATCH', async t => {
  const start = Date.now(); let now = start; const clock = t.mock.method(Date, 'now', () => now);
  try {
    for (const outcome of ['unconfirmed', 'lost'] as const) {
      now = start; let writes = 0;
      const second = { ...structuredClone(account), key: 'entry-b', identity: { name: 'b.json', authIndex: 'b' } };
      const { controller, snapshot } = await setup(async request => {
        const result = { accounts: [structuredClone(account), structuredClone(second)], observedAt: now } as CollectorResult;
        if (request.operation === 'toggle') {
          writes++;
          if (request.identity!.authIndex === 'a') { if (outcome === 'lost') throw new Error('lost acknowledgement'); result.mutation = 'unconfirmed'; }
          else { result.mutation = 'confirmed'; result.accounts![1]!.disabled = true; }
        }
        return result;
      });
      try {
        now += 60000; const uncertain = await controller.toggle({ ...target(snapshot), disabled: true });
        assert.equal(uncertain.snapshot!.fresh, true); assert.equal(uncertain.snapshot!.error, undefined);
        assert.equal(uncertain.snapshot!.observedAt, start, 'uncertainty cannot renew old credentials');
        assert.equal(uncertain.snapshot!.accounts[0]!.mutationDisabled, true);
        await assert.rejects(controller.toggle({ ...target(uncertain.snapshot!), disabled: false }), /Reconcile/);
        const other = { ...target(uncertain.snapshot!), key: second.key, disabled: true };
        await controller.toggle(other); assert.equal(writes, 2);
        now += 120001;
        await assert.rejects(controller.toggle({ ...target(controller.view().snapshot!), key: second.key, disabled: false }), /Stale/);
        assert.equal(writes, 2);
      } finally { controller.dispose(); }
    }
  } finally { clock.mock.restore(); }
});

test('unavailable quota status stays N/A while account loading and zero remain distinct', async () => {
  const { controller } = await setup();
  try {
    const now = Date.now(); const snapshot = controller.view().snapshot!;
    snapshot.observedAt = now; snapshot.accounts[0]!.windows = [];
    for (const readState of ['loading', 'settled'] as const) {
      snapshot.readState = readState;
      const value = summary('codex', snapshot, { mode: 'compact' }, 'Fixture', now);
      assert.equal(value.text, 'Codex 1/1 · N/A'); assert.match(value.tooltip, / · N\/A$/);
    }
    snapshot.accounts[0]!.windows = [{ label: 'Weekly', usedPercent: 0, resetAt: null, observedAt: now }];
    assert.match(summary('codex', snapshot, { mode: 'compact' }, 'Fixture', now).text, /0% used/);
    snapshot.observedAt = null; snapshot.readState = 'loading';
    assert.equal(summary('codex', snapshot, { mode: 'compact' }, 'Fixture', now).text, 'Codex · Checking…');
  } finally { controller.dispose(); }
});
