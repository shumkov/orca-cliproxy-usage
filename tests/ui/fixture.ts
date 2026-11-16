import { expect, type Page } from '@playwright/test';

export async function fixture(page: Page, theme = 'dark') {
  await page.addInitScript(({ theme }) => {
    const host = window as unknown as Record<string, any>;
    const now = Date.now();
    const accounts: any[] = Array.from({ length: 20 }, (_, i) => ({
      key: `entry-${i}`, identity: { authIndex: `index-${i}`, name: `credential-${i}.json` },
      name: `credential-${i}.json`, email: i === 0 ? '<img src=x onerror="window.pwned=true">' : `account-${i}@example.test`,
      provider: i < 12 ? 'codex' : 'claude', disabled: false, available: true, status: 'active',
      requiresSignIn: false, quotaBlocked: false, unavailable: false, priority: 10, plan: 'Pro 200', credits: null,
      windows: [{ label: 'Weekly', usedPercent: 21, resetAt: now + 259200000, observedAt: now }],
      modelWindows: [], cooldowns: [], recent: [],
    }));
    let view = {
      version: 1, profiles: [{ id: 'local', label: 'Local', revision: 'rev-local' }, { id: 'remote', label: 'Remote', revision: 'rev-remote' }],
      selectedHost: 'local', snapshot: { profileId: 'local', revision: 'rev-local', snapshotId: 'snapshot', accounts, observedAt: now, error: null as string | null, rejected: false, fresh: true, pending: 0 },
      preferences: { mode: 'compact', selected: {} as Record<string, string> }, unresolved: [],
    };
    const subscribers: ((view: unknown) => void)[] = [];
    const strict = (value: any): any => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (!value || typeof value !== 'object') throw new Error('Mock bridge rejected non-JSON value');
      for (const child of Array.isArray(value) ? value : Object.values(value)) strict(child);
      return structuredClone(value);
    };
    host.requests = [];
    host.toggleOutcome = 'confirmed';
    host.togglePending = false;
    host.orca = { plugin: {
      on: (_name: string, callback: (view: unknown) => void) => { subscribers.push(callback); },
      request: async (name: string, input: any = null) => {
        strict(input);
        host.requests.push({ name, input });
        if (name === 'usage.mode') view.preferences.mode = input.mode;
        if (name === 'usage.selectHost') {
          if (host.rejectHost) throw new Error('Host selection failed');
          view.selectedHost = input.id;
          view.snapshot.profileId = input.id; view.snapshot.revision = `rev-${input.id}`;
          view.snapshot.accounts = accounts.map(a => ({ ...a, email: `remote-${a.key}@example.test` }));
        }
        if (name === 'usage.details') {
          host.detailsWaiting = true;
          if (host.queueDetails) await new Promise<void>((resolve, reject) => { (host.detailsQueue ??= []).push({ resolve, reject }); });
          if (host.holdDetails) await new Promise<void>(resolve => { host.releaseDetails = resolve; });
          if (host.rejectDetails) throw new Error('Old host request cancelled');
          host.detailsWaiting = false;
        }
        if (name === 'usage.refresh' && host.holdRefresh) await new Promise<void>(resolve => { host.releaseRefresh = resolve; });
        if (name === 'usage.toggle') {
          host.togglePending = true;
          await new Promise<void>(resolve => { host.resolveToggle = resolve; });
          if (host.toggleOutcome === 'error') throw new Error('<img src=x onerror="window.pwned=true"> rejected');
          const account = view.snapshot.accounts.find(a => a.key === input.key)!;
          if (host.toggleOutcome === 'unconfirmed') { account.mutation = 'unconfirmed'; account.mutationDisabled = input.disabled; }
          else if (host.toggleOutcome === 'not_applied') { account.mutationError = 'Could not change Enabled. Try again.'; }
          else { account.disabled = input.disabled; account.available = !input.disabled; }
          host.togglePending = false;
        }
        view.version++;
        return strict(view);
      },
    } };
    host.patchAccount = (key: string, patch: any) => { Object.assign(view.snapshot.accounts.find(a => a.key === key)!, patch); view.version++; for (const callback of subscribers) callback(strict(view)); };
    host.push = (patch: any) => { view = { ...view, ...patch, version: view.version + 1 }; for (const callback of subscribers) callback(strict(view)); };
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.className = theme;
      const tokens = theme === 'light' ? {
        background: '#ffffff', foreground: '#25252a', muted: '#f4f4f5', 'muted-foreground': '#666670', card: '#fafafa', border: '#dedee3', secondary: '#f4f4f5', primary: '#52525b', ring: '#71717a',
      } : { background: '#18181b', foreground: '#ededf1', muted: '#27272a', 'muted-foreground': '#a1a1aa', card: '#202024', border: '#38383d', secondary: '#27272a', primary: '#a1a1aa', ring: '#a1a1aa' };
      for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(`--orca-${key}`, value);
    });
  }, { theme });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Compact', exact: true })).toHaveAttribute('aria-pressed', 'true');
}

