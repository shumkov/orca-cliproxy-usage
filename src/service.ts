import { OperationFailure, failureDiagnostic } from './failure.ts';
import { randomUUID } from 'node:crypto';
import { isFresh } from './summary.ts';
import { parseProfiles } from './transport.ts';
import type { Account, CollectorRequest, CollectorResult, Identity, Preferences, Profile, Rich, Snapshot, Store, Transport, View } from './types.ts';

interface Pending { key: string; identity: Identity; disabled: boolean; phase: 'pending' | 'unconfirmed' }
interface Journal { profile: Profile; rejected: boolean; pending: Pending[] }
export interface Target { profileId: string; revision: string; snapshotId: string; key: string }

function credentialState(accounts: Account[]): string {
  return JSON.stringify([...accounts].sort((a, b) => a.key.localeCompare(b.key)).map(account => ({
    key: account.key, identity: account.identity, provider: account.provider, email: account.email, name: account.name,
    status: account.status, disabled: account.disabled, available: account.available, requiresSignIn: account.requiresSignIn,
    quotaBlocked: account.quotaBlocked, unavailable: account.unavailable, priority: account.priority, cooldowns: account.cooldowns,
  })));
}

class Connection {
  snapshotId = randomUUID();
  accounts: Account[] = [];
  observedAt: number | null = null;
  error?: string;
  retryAt = 0;
  mutationErrors = new Map<string, { identity: Identity; message: string }>();
  rich = new Map<string, { value: Rich; fetchedAt: number }>();
  epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private current?: { operation: string; controller: AbortController };
  read?: Promise<void>;
  readState: Snapshot['readState'] = 'idle';
  readingCount = 0;
  loadingDetails = new Map<string, number>();

  readonly journal: Journal;
  constructor(journal: Journal) { this.journal = journal; }

  enqueue<T>(operation: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.depth >= 8) return Promise.reject(new Error('Host request queue is full'));
    this.depth++;
    const epoch = this.epoch;
    const result = this.tail.then(async () => {
      if (this.journal.rejected) throw new Error('Management authentication rejected; use Retry authentication once');
      if (Date.now() < this.retryAt) throw new Error('Host requested a delay; try again after Retry-After');
      if (epoch !== this.epoch) throw new Error('Request cancelled');
      const controller = new AbortController();
      this.current = { operation, controller };
      try { return await task(controller.signal); }
      finally { this.current = undefined; }
    });
    this.tail = result.catch(() => {}).finally(() => { this.depth--; });
    return result;
  }

  cancelReads() {
    this.epoch++;
    this.snapshotId = randomUUID();
    if (this.current && this.current.operation !== 'toggle') this.current.controller.abort();
  }
}

export class Controller {
  private profiles: Profile[];
  private selectedId: string | null = null;
  private connections = new Map<string, Connection>();
  private journals: Record<string, Journal> = {};
  private preferences: Preferences = { mode: 'compact' };
  private persistTail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  configurationError?: string;
  private version = 0;

  private store: Store;
  private transport: Transport;
  private log: (message: string) => void;
  constructor(profiles: Profile[], store: Store, transport: Transport, log: (message: string) => void = () => {}) {
    this.profiles = profiles; this.store = store; this.transport = transport; this.log = log;
  }

  async initialize() {
    const saved = await this.store.get('connections');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [revision, input] of Object.entries(saved)) {
        try {
          const journal = input as Journal;
          const { revision: _old, ...profile } = journal.profile;
          const verified = parseProfiles(JSON.stringify([profile]))[0]!;
          if (verified.revision !== revision || !Array.isArray(journal.pending) || typeof journal.rejected !== 'boolean') continue;
          this.journals[revision] = { profile: verified, rejected: journal.rejected, pending: journal.pending };
        } catch { /* Ignore unsupported stored versions without changing remote state. */ }
      }
    }
    const selected = await this.store.get('selectedHost');
    if (typeof selected === 'string' && this.profiles.some(p => p.id === selected)) this.selectedId = selected;
    const preferences = await this.store.get('preferences');
    if (preferences && typeof preferences === 'object') {
      const value = preferences as Preferences;
      this.preferences.mode = value.mode === 'detailed' ? 'detailed' : 'compact';

    }
  }

  onChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { this.version++; for (const listener of this.listeners) listener(); }
  private persist() {
    const copy = structuredClone(this.journals);
    const result = this.persistTail.then(() => this.store.set('connections', copy)).catch(() => { throw new OperationFailure('storage'); });
    this.persistTail = result.catch(() => {});
    return result;
  }

  private report(operation: 'read' | 'rich', stage: 'queue' | 'transport' | 'apply' | 'reconcile' | 'rich', error: unknown, started: number) {
    try { this.log(failureDiagnostic(operation, stage, error, started)); } catch { /* Diagnostics must not change request outcomes. */ }
  }

  private connection(profile: Profile): Connection {
    let result = this.connections.get(profile.revision);
    if (!result) {
      const journal = this.journals[profile.revision] ?? { profile: structuredClone(profile), rejected: false, pending: [] };
      this.journals[profile.revision] = journal;
      result = new Connection(journal);
      this.connections.set(profile.revision, result);
    }
    return result;
  }
  private selected(): Connection | null {
    const profile = this.profiles.find(p => p.id === this.selectedId);
    return profile ? this.connection(profile) : null;
  }
  private snapshot(connection: Connection): Snapshot {
    const journal = connection.journal;
    const snapshot: Snapshot = {
      profileId: journal.profile.id, revision: journal.profile.revision, snapshotId: connection.snapshotId,
      accounts: connection.accounts.map(account => {
        const pending = journal.pending.find(x => x.key === account.key && x.identity.name === account.identity.name && x.identity.authIndex === account.identity.authIndex);
        const failure = connection.mutationErrors.get(account.key);
        const mutationError = failure?.identity.name === account.identity.name && failure?.identity.authIndex === account.identity.authIndex ? failure.message : null;
        return { ...account, ...(mutationError ? { mutationError } : {}), ...(connection.rich.has(account.key) ? { rich: connection.rich.get(account.key)!.value } : {}), ...(pending ? { mutation: pending.phase, mutationDisabled: pending.disabled } : {}) };
      }),
      readState: connection.readState, loadingDetails: [...connection.loadingDetails.keys()],
      observedAt: connection.observedAt, ...(connection.error === undefined ? {} : { error: connection.error }), rejected: journal.rejected, pending: journal.pending.length, fresh: false,
    };
    snapshot.fresh = isFresh(snapshot);
    return snapshot;
  }
  view(): View {
    return structuredClone({ version: this.version, profiles: this.profiles.map(({ id, label, revision }) => ({ id, label, revision })), selectedHost: this.selectedId,
      snapshot: this.selected() ? this.snapshot(this.selected()!) : null, preferences: this.preferences, ...(this.configurationError === undefined ? {} : { configurationError: this.configurationError }),
      unresolved: Object.values(this.journals).filter(j => j.pending.length).map(j => ({ revision: j.profile.revision, label: j.profile.label, count: j.pending.length })),
    });
  }

  async select(id: unknown) {
    if (typeof id !== 'string' || !this.profiles.some(p => p.id === id)) throw new Error('Unknown host');
    if (this.selectedId !== id) this.selected()?.cancelReads();
    this.selectedId = id;
    await this.store.set('selectedHost', id);
    this.changed();
    await this.refresh();
    return this.view();
  }

  replaceProfiles(profiles: Profile[], error?: string) {
    this.selected()?.cancelReads();
    this.profiles = profiles;
    this.configurationError = error;
    if (!profiles.some(p => p.id === this.selectedId)) this.selectedId = null;
    this.changed();
  }

  private assertTarget(target: Target, requireFresh = true): { connection: Connection; account: Account } {
    const connection = this.selected();
    if (!connection || !target || target.profileId !== this.selectedId || target.revision !== connection.journal.profile.revision || target.snapshotId !== connection.snapshotId) throw new Error('Stale host or credential snapshot; refresh before acting');
    const account = connection.accounts.find(a => a.key === target.key);
    if (!account || (requireFresh && !isFresh(this.snapshot(connection)))) throw new Error('Stale credential snapshot; refresh before acting');
    if (!account.identity.name || !account.identity.authIndex) throw new Error('Credential has no authoritative identity');
    return { connection, account };
  }

  private async apply(connection: Connection, result: CollectorResult, expectedEpoch?: number) {
    if (result.authRejected) {
      connection.journal.rejected = true;
      connection.cancelReads();
      connection.error = 'Management authentication rejected; automatic requests stopped';
      await this.persist();
      this.changed();
      return;
    }
    if (expectedEpoch !== undefined && expectedEpoch !== connection.epoch) return;
    if (result.error) {
      connection.error = result.error;
      connection.retryAt = result.retryAt ?? 0;
      this.changed();
      return;
    }
    const accounts = result.accounts ?? [];
    // Quota observations do not replace the authoritative credential state.
    if (credentialState(accounts) !== credentialState(connection.accounts)) connection.snapshotId = randomUUID();
    connection.accounts = accounts;
    connection.observedAt = result.observedAt ?? null;
    connection.error = undefined;
    connection.retryAt = 0;
    this.changed();
  }

  private async reconcileFromSnapshot(connection: Connection) {
    if (connection.error || connection.journal.rejected) return;
    const before = connection.journal.pending.length;
    connection.journal.pending = connection.journal.pending.filter(pending => {
      const entry = connection.accounts.find(a => a.key === pending.key);
      // A successful authoritative read resolves both applied and unapplied writes.
      return !entry || typeof entry.disabled !== 'boolean';
    });
    if (before !== connection.journal.pending.length) { await this.persist(); this.changed(); }
  }

  async refresh(ordered = false) {
    const connection = this.selected();
    if (!connection || connection.journal.rejected) return this.view();
    if (!connection.read || ordered) {
      const epoch = connection.epoch;
      connection.readState = 'loading'; connection.readingCount++;
      const queuedAt = Date.now();
      const read = connection.enqueue('read', async signal => {
        const started = Date.now(); let stage: 'transport' | 'apply' | 'reconcile' = 'transport';
        try {
          const result = await this.transport({ profile: connection.journal.profile, operation: 'read' }, signal);
          stage = 'apply'; await this.apply(connection, result, epoch);
          stage = 'reconcile'; if (epoch === connection.epoch) await this.reconcileFromSnapshot(connection);
        } catch (error) {
          this.report('read', stage, error, started);
          if (epoch === connection.epoch) { connection.error = 'Host transport unavailable; last data is stale'; this.changed(); }
        }
      }).catch(error => {
        this.report('read', 'queue', error, queuedAt);
        if (epoch === connection.epoch && !connection.journal.rejected) connection.error = 'Could not start account refresh. Try again.';
      }).finally(() => {
        if (connection.read === read) connection.read = undefined;
        connection.readingCount--; connection.readState = connection.readingCount ? 'loading' : 'settled'; this.changed();
      });
      if (!ordered) connection.read = read;
      this.changed();
      await read;
      return this.view();
    }
    await connection.read;
    return this.view();
  }

  async details(target: Target, callerSignal?: AbortSignal) {
    if (callerSignal?.aborted) throw new Error('Request cancelled');
    const { connection, account } = this.assertTarget(target);
    const cached = connection.rich.get(account.key);
    if (cached && Date.now() < Math.max(cached.fetchedAt + 300000, cached.value.retryAt ?? 0)) return this.view();
    const epoch = connection.epoch;
    connection.loadingDetails.set(account.key, (connection.loadingDetails.get(account.key) ?? 0) + 1);
    this.changed();
    try { await connection.enqueue('rich', async signal => {
      if (callerSignal?.aborted) throw new Error('Request cancelled');
      this.assertTarget(target);
      const current = connection.rich.get(account.key);
      if (current && Date.now() < Math.max(current.fetchedAt + 300000, current.value.retryAt ?? 0)) return;
      const started = Date.now(); let stage: 'transport' | 'apply' | 'rich' = 'transport';
      try {
        const result = await this.transport({ profile: connection.journal.profile, operation: 'rich', identity: account.identity }, callerSignal ? AbortSignal.any([signal, callerSignal]) : signal);
        stage = 'apply'; await this.apply(connection, result, epoch);
        stage = 'rich';
        if (result.rich && epoch === connection.epoch && !connection.journal.rejected) {
          const old = connection.rich.get(account.key)?.value;
          const value = { ...result.rich,
            windows: result.rich.windows.length ? result.rich.windows : old?.windows ?? [],
            plan: result.rich.plan ?? old?.plan ?? null, credits: result.rich.credits ?? old?.credits ?? null,
            resetEntitlements: result.rich.resetEntitlements ?? old?.resetEntitlements ?? null,
            observedAt: result.rich.windows.length ? result.rich.observedAt : old?.observedAt ?? result.rich.observedAt,
          };
          connection.rich.set(account.key, { value, fetchedAt: Date.now() });
          this.changed();
        }
      } catch (error) {
        this.report('rich', stage, error, started);
        if (epoch === connection.epoch && !callerSignal?.aborted) { connection.error = 'Host transport unavailable; last data is stale'; this.changed(); }
      }
    }); } finally {
      const remaining = (connection.loadingDetails.get(account.key) ?? 1) - 1;
      if (remaining) connection.loadingDetails.set(account.key, remaining); else connection.loadingDetails.delete(account.key);
      this.changed();
    }
    return this.view();
  }

  async toggle(target: Target & { disabled: boolean }, callerSignal?: AbortSignal) {
    if (callerSignal?.aborted) throw new Error('Request cancelled');
    if (typeof target?.disabled !== 'boolean') throw new Error('Enabled must be a boolean');
    const initial = this.assertTarget(target);
    const epoch = initial.connection.epoch;
    if (initial.connection.journal.pending.some(p => p.key === target.key)) throw new Error('Reconcile the previous change before changing Enabled again');
    return initial.connection.enqueue('toggle', async () => {
      if (callerSignal?.aborted) throw new Error('Request cancelled');
      const { connection, account } = this.assertTarget(target);
      if (connection.journal.pending.some(p => p.key === target.key)) throw new Error('Enabled change already pending');
      const pending: Pending = { key: account.key, identity: structuredClone(account.identity), disabled: target.disabled, phase: 'pending' };
      connection.journal.pending.push(pending);
      connection.mutationErrors.delete(account.key);
      // The durable journal precedes dispatch. Cancellation never implies rollback.
      await this.persist();
      try {
        if (callerSignal?.aborted || epoch !== connection.epoch) throw new Error('Request cancelled');
        this.assertTarget(target);
      } catch (error) {
        connection.journal.pending = connection.journal.pending.filter(p => p !== pending);
        await this.persist();
        throw error;
      }
      this.changed();
      let result: CollectorResult | undefined;
      const observedAt = connection.observedAt;
      try {
        result = await this.transport({ profile: connection.journal.profile, operation: 'toggle', identity: pending.identity, disabled: pending.disabled });
        await this.apply(connection, result.mutation === 'unconfirmed' ? { ...result, observedAt: observedAt ?? undefined } : result);
      } catch {
        // The journal preserves uncertainty; missing replies must not renew credential freshness.
      }
      if (result?.mutation === 'confirmed' || result?.mutation === 'not_applied') {
        connection.journal.pending = connection.journal.pending.filter(p => p !== pending);
        if (result.mutation === 'not_applied') connection.mutationErrors.set(account.key, { identity: pending.identity, message: 'Could not change Enabled. Try again.' });
      } else {
        pending.phase = 'unconfirmed';
      }
      await this.persist();
      this.changed();
      return this.view();
    });
  }

  async reconcile(revision: unknown) {
    if (typeof revision !== 'string' || !this.journals[revision]?.pending.length) throw new Error('No unresolved change for this connection');
    const connection = this.connection(this.journals[revision]!.profile);
    await connection.enqueue('read', async signal => {
      try {
        await this.apply(connection, await this.transport({ profile: connection.journal.profile, operation: 'read' }, signal));
        await this.reconcileFromSnapshot(connection);
      } catch { connection.error = 'Could not reconcile Enabled; no write was repeated'; }
      this.changed();
    });
    return this.view();
  }

  async retryAuthentication(revision: unknown) {
    const connection = this.selected();
    if (!connection || revision !== connection.journal.profile.revision || !connection.journal.rejected) throw new Error('Select the rejected connection before retrying authentication');
    connection.journal.rejected = false;
    await this.persist();
    await this.refresh();
    return this.view();
  }

  async setMode(mode: unknown) {
    if (mode !== 'compact' && mode !== 'detailed') throw new Error('Invalid display mode');
    this.preferences.mode = mode;
    await this.store.set('preferences', this.preferences);
    this.changed(); return this.view();
  }

  dispose() { for (const connection of this.connections.values()) connection.cancelReads(); this.listeners.clear(); }
}
