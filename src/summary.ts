import type { Account, Preferences, Snapshot, Window } from './types.ts';
import { isObservationFresh, selectDisplayWindow, selectWindows } from './quota.mjs';
import { accountLabel, clip, displayAccount, observationAge } from './presentation.mjs';

function status(text: string, tooltip: string, tone: 'warning' | 'neutral') {
  // Orca's status schema measures these limits in UTF-16 units.
  return { text: clip(text, 64), tooltip: clip(tooltip, 256), tone };
}

export function duration(at: number | null | undefined, now = Date.now()): string {
  if (at == null) return 'reset unknown';
  const minutes = Math.ceil((at - now) / 60000);
  if (minutes <= 0) return 'reset passed';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.ceil(minutes / 60)}h`;
  return `${Math.ceil(minutes / 1440)}d`;
}

export function displayWindows(account: Account): Window[] {
  return selectWindows(account);
}

export function isFresh(snapshot: Snapshot | null, now = Date.now()): boolean {
  return !!snapshot && snapshot.observedAt !== null && now - snapshot.observedAt <= 120000 && now >= snapshot.observedAt && !snapshot.error && !snapshot.rejected;
}

export function summary(provider: string, snapshot: Snapshot | null, _preferences: Preferences, _host: string, now = Date.now()) {
  const title = provider === 'codex' ? 'Codex' : 'Claude';
  if (snapshot && snapshot.observedAt === null && !snapshot.error && !snapshot.rejected && snapshot.readState !== 'settled') return status(`${title} · Checking…`, 'Checking accounts…', 'neutral');
  const accounts = (snapshot?.accounts ?? []).filter(a => a.provider === provider);
  const chosen = displayAccount(accounts, now);
  const fresh = isFresh(snapshot, now);
  const available = accounts.filter(a => a.available).length;
  let text = `${title} ${fresh ? `${available}/${accounts.length}` : '—/—'}`;
  const parts: string[] = [];
  const plan = chosen?.rich?.plan ?? chosen?.plan;
  if (chosen) {
    if (!chosen.available) parts.push(chosen.disabled === true ? 'Disabled' : chosen.requiresSignIn ? 'Sign-in required'
      : chosen.quotaBlocked ? 'Limit reached' : chosen.cooldowns.some(c => c.scope !== 'model') ? 'Cooling down' : 'Unavailable');
    const window = selectDisplayWindow(chosen);
    const observationFresh = isObservationFresh(window, now);
    const usage = window?.usedPercent == null ? 'N/A' : `${Math.round(window.usedPercent)}% used`;
    const reset = window?.resetAt == null ? null : duration(window.resetAt, now);
    parts.push(usage);
    if (reset) parts.push(reset === 'reset passed' ? reset : `resets in ${reset}`);
    const recency = window?.usedPercent != null && !observationFresh ? observationAge(window.observedAt, now) ?? 'Update time unknown' : null;
    if (recency) parts.push(recency);
    if (fresh) text += ` · ${usage}${recency ? ` · ${recency}` : ''}${reset ? ` · ${reset}` : ''}`;
  } else {
    parts.push('N/A');
    if (fresh) text += ' · N/A';
  }
  if (!fresh) {
    const warning = snapshot?.rejected ? 'Authentication failed' : snapshot?.error ? 'Unavailable' : snapshot ? 'Stale' : 'N/A';
    text += ` · ${warning}`;
    if (snapshot?.rejected) parts.push('Could not authenticate. Check the host connection settings.');
    else if (snapshot?.error) parts.push('Could not update usage. Check this host in the panel.');
    else if (snapshot) parts.push('Account availability is out of date.');
  }
  const meaning = parts.join(' · ');
  const planLabel = plan ? clip(plan, 32) : null;
  const identityBudget = 256 - meaning.length - 3 - (planLabel ? planLabel.length + 3 : 0);
  const label = chosen ? accountLabel(chosen, accounts, identityBudget) : null;
  return status(text, [label, planLabel, meaning].filter(Boolean).join(' · '), fresh ? 'neutral' : 'warning');
}
