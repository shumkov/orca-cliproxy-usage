import { providerMark } from './provider-marks.mjs';
import { selectWindows } from './quota.mjs';
import { assertJson } from './json.mjs';
import { accountLabel, humanDate, observationAge as age, windowLabel } from './presentation.mjs';

const header = document.getElementById('header');
const content = document.getElementById('content');
const notice = document.getElementById('notice');
let view;
let detailKey = null;
let returnScroll = 0;
let returnFocus = null;
let message = '';
let busy = false;
let detailsLoading = false;
const localIntents = new Map();
let freshnessTimer;
let hostGeneration = 0;
let selectionSerial = 0;
let detailSerial = 0;
let initialLoading = true;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function button(text, action, options = {}) {
  const node = el('button', text, options.className);
  node.type = 'button';
  node.disabled = options.disabled ?? false;
  if (options.focus) node.dataset.focus = options.focus;
  node.addEventListener('click', action);
  return node;
}
function reset(at) {
  const when = humanDate(at);
  if (!when) return null;
  return at <= Date.now() ? 'Reset passed · awaiting update' : `resets ${when.startsWith('in ') ? when : `on ${when}`}`;
}
function fresh() {
  const snapshot = view?.snapshot;
  return !!snapshot && !snapshot.error && !snapshot.rejected && Number.isFinite(snapshot.observedAt) && Date.now() >= snapshot.observedAt && Date.now() - snapshot.observedAt <= 120000;
}
function checkingAccounts() {
  const snapshot = view?.snapshot;
  return !!view?.selectedHost && !snapshot?.rejected && (busy || snapshot?.readState === 'loading' || (!snapshot?.error && snapshot?.observedAt == null && snapshot?.readState !== 'settled'));
}
function checkingUsage(account) { return detailsLoading || !!view?.snapshot?.loadingDetails?.includes(account.key); }
function windows(account) { return selectWindows(account); }
function used(window) { return window?.usedPercent == null ? 'N/A' : `${Math.round(window.usedPercent)}% used`; }
function bar(window) {
  const node = el('div', undefined, 'bar');
  node.setAttribute('role', 'meter');
  node.setAttribute('aria-label', `${window?.label ?? 'Quota'} usage`);
  node.setAttribute('aria-valuemin', '0'); node.setAttribute('aria-valuemax', '100');
  if (window?.usedPercent == null) {
    node.dataset.unknown = 'true'; node.setAttribute('aria-valuetext', 'N/A');
  } else {
    const value = Math.max(0, Math.min(100, window.usedPercent));
    node.setAttribute('aria-valuenow', String(value));
    const fill = el('div', undefined, 'bar-fill'); fill.style.width = `${value}%`; node.append(fill);
  }
  return node;
}
function target(account) {
  return { profileId: view.snapshot.profileId, revision: view.snapshot.revision, snapshotId: view.snapshot.snapshotId, key: account.key };
}
function adopt(next) {
  if (!next || !Array.isArray(next.profiles)) return;
  if (view && next.version < view.version) return;
  if (view && (next.selectedHost !== view.selectedHost || next.snapshot?.revision !== view.snapshot?.revision)) {
    hostGeneration++; detailSerial++;
    detailKey = null; returnScroll = 0; returnFocus = null; message = ''; detailsLoading = false; localIntents.clear(); busy = false;
  }
  view = next; initialLoading = false;
  if (detailKey && !view.snapshot?.accounts.some(a => a.key === detailKey)) { detailSerial++; detailsLoading = false; detailKey = null; }
  render();
}
async function request(name, input = null, current = () => true, failed) {
  const generation = hostGeneration;
  try {
    assertJson(input);
    const next = await window.orca.plugin.request(name, input, { timeoutMs: 120000 });
    assertJson(next);
    if (generation !== hostGeneration || !current()) return false;
    adopt(next); return true;
  } catch (error) {
    if (generation !== hostGeneration || !current()) return false;
    const errorMessage = typeof error?.message === 'string' ? error.message : 'Request failed';
    if (failed) failed(errorMessage); else message = errorMessage;
    render(); return false;
  }
}
async function refresh() {
  const generation = hostGeneration;
  const verifying = [...localIntents];
  busy = true; message = ''; render();
  const updated = await request('usage.refresh');
  if (updated && generation === hostGeneration && fresh()) {
    for (const [key, intent] of verifying) if (intent.phase === 'uncertain' && localIntents.get(key) === intent) localIntents.delete(key);
  }
  if (generation === hostGeneration) { busy = false; render(); }
}
async function openAccount(account) {
  const generation = hostGeneration;
  const sequence = ++detailSerial;
  const current = () => sequence === detailSerial && detailKey === account.key;
  returnScroll = content.scrollTop;
  returnFocus = account.key;
  detailKey = account.key; message = ''; detailsLoading = true;
  render(); content.scrollTop = 0;
  document.querySelector('[data-focus="back"]')?.focus();
  if (fresh()) await request('usage.details', target(account), current);
  if (generation === hostGeneration && current()) { detailsLoading = false; render(); }
}
function back() {
  detailSerial++; detailsLoading = false; detailKey = null; message = ''; render(); content.scrollTop = returnScroll;
  const row = [...content.querySelectorAll('[data-account]')].find(node => node.dataset.account === returnFocus);
  row?.focus({ preventScroll: true });
}
function toolbarIcon(kind) {
  const paths = {
    refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
    compact: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
    detailed: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M8 7h8', 'M8 17h8'],
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(name, value);
  for (const d of paths[kind]) { const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
function iconButton(name, kind, action, options = {}) {
  const control = button('', action, { ...options, className: 'icon-button' });
  control.setAttribute('aria-label', name); control.title = name; control.append(toolbarIcon(kind));
  return control;
}
function renderHeader() {
  header.replaceChildren();
  const title = el('div', undefined, 'title-row'); title.append(el('h1', 'CLIProxy Usage')); header.append(title);
  const toolbar = el('div', undefined, 'toolbar');
  const host = el('select'); host.id = 'host'; host.dataset.focus = 'host'; host.setAttribute('aria-label', 'Host'); host.title = 'Host';
  const empty = el('option', 'Select a host…'); empty.value = ''; host.append(empty);
  for (const profile of view?.profiles ?? []) { const option = el('option', profile.label); option.value = profile.id; host.append(option); }
  host.value = view?.selectedHost ?? '';
  host.addEventListener('change', async () => {
    if (!host.value) return;
    hostGeneration++; localIntents.clear();
    const selection = ++selectionSerial;
    detailSerial++; detailsLoading = false;
    detailKey = null; returnScroll = 0; message = ''; busy = true;
    const id = host.value; render(); await request('usage.selectHost', { id });
    if (selection === selectionSerial) { busy = false; render(); }
  });
  toolbar.append(host);
  if (!detailKey) {
    const modes = el('div', undefined, 'segments'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Account list mode');
    for (const mode of ['compact', 'detailed']) {
      const control = iconButton(mode === 'compact' ? 'Compact' : 'Detailed', mode, () => request('usage.mode', { mode }), { focus: mode });
      control.setAttribute('aria-pressed', String((view?.preferences.mode ?? 'compact') === mode)); modes.append(control);
    }
    toolbar.append(modes);
  }
  const reading = checkingAccounts() || detailsLoading || !!view?.snapshot?.loadingDetails?.length;
  const reload = iconButton('Refresh', 'refresh', refresh, { disabled: reading || !view?.selectedHost || view?.snapshot?.rejected, focus: 'refresh' });
  reload.setAttribute('aria-busy', String(reading));
  if (reading) reload.classList.add('reading');
  reload.title = reading ? 'Refreshing usage…' : view?.snapshot?.rejected ? 'Connection paused' : view?.snapshot?.error ? 'Refresh · could not update usage' : 'Refresh';
  const feedback = el('span', reading ? 'Refreshing usage…' : '', 'sr-only'); feedback.setAttribute('role', 'status');
  reload.append(feedback); toolbar.append(reload); header.append(toolbar);
}
function renderNotice() {
  notice.replaceChildren();
  if (view?.configurationError) notice.append(el('p', view.configurationError, 'error'));
  if (message) notice.append(el('p', message, 'error'));
  if (!view && !initialLoading) notice.append(button('Retry loading', () => request('usage.state')));
  if (view?.snapshot?.error) notice.append(el('p', view.snapshot.rejected ? 'Could not authenticate with this host. Check its connection settings.' : view.snapshot.error, 'error'));
  else if (view?.snapshot?.observedAt && !fresh()) notice.append(el('p', 'Connection is out of date. Showing previous usage.'));
  if (view?.snapshot?.rejected) {
    notice.append(el('p', 'Automatic refresh is paused.'));
    notice.append(button('Retry connection', () => request('usage.retryAuthentication', { revision: view.snapshot.revision })));
  }
  for (const pending of view?.unresolved ?? []) {
    notice.append(button(`Check ${pending.count} change(s) on ${pending.label}`, () => request('usage.reconcile', { revision: pending.revision })));
  }
}
function stateText(account) {
  if (account.disabled === true) return 'Disabled';
  if (account.disabled == null) return 'Enabled unknown';
  if (account.requiresSignIn) return 'Sign-in required';
  if (account.quotaBlocked) return 'Limit reached';
  if (account.cooldowns.some(c => c.scope !== 'model')) return 'Cooling down';
  if (!account.available) return 'Unavailable';
  return account.cooldowns.length ? 'Model restrictions' : 'Available';
}
function quotaWindow(window, compact = false) {
  const box = el('div', undefined, 'window');
  const line = el('div', undefined, 'row-line'); line.append(el('span', windowLabel(window)), el('span', used(window), 'usage'));
  box.append(line, bar(window));
  if (!compact) {
    const meta = el('div', undefined, 'split quiet small');
    const when = reset(window.resetAt);
    if (when) meta.append(el('span', when));
    if (window.usedPercent != null || window.resetAt != null) meta.append(el('span', age(window.observedAt) ?? 'Update time unknown'));
    box.append(meta);
  }
  return box;
}
function renderList() {
  if (!view) { content.append(el('div', initialLoading ? 'Loading usage…' : 'Could not load usage.', 'empty')); return; }
  if (!view.selectedHost) { content.append(el('div', 'Select a host to view usage.', 'empty')); return; }
  const accounts = view.snapshot?.accounts ?? [];
  if (!accounts.length) { content.append(el('div', checkingAccounts() ? 'Checking accounts…' : view.snapshot?.rejected ? 'Connection paused.' : view.snapshot?.error ? 'Accounts could not be updated.' : fresh() ? 'No accounts on this host.' : 'No usage data. Refresh to try again.', 'empty')); return; }
  const providers = [...new Set(['codex', 'claude', ...accounts.map(a => a.provider)])];
  for (const provider of providers) {
    const entries = accounts.filter(a => a.provider === provider).sort((a, b) => a.email.localeCompare(b.email) || a.key.localeCompare(b.key));
    if (!entries.length && !['codex', 'claude'].includes(provider)) continue;
    const section = el('section', undefined, 'provider');
    const title = el('div', undefined, 'provider-title');
    const name = el('div', undefined, 'provider-label');
    const mark = providerMark(provider);
    if (mark) name.append(mark);
    name.append(el('h2', provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : provider));
    const counts = el('span', fresh() ? `${entries.filter(a => a.available).length}/${entries.length}` : `—/${entries.length}`, 'quiet small');
    title.append(name, counts); section.append(title);
    for (const account of entries) {
      const label = accountLabel(account, entries);
      const row = button('', () => openAccount(account), { className: 'account', focus: `account:${account.key}` }); row.dataset.account = account.key;
      row.setAttribute('aria-label', `Open ${label}`);
      const top = el('div', undefined, 'row-line'); top.append(el('span', label, 'email'));
      const exception = account.disabled || !account.available || account.cooldowns.length ? stateText(account) : null;
      const state = exception;
      if (state) top.append(el('span', state, 'badge'));
      row.append(top);
      const quotaWindows = windows(account);
      const detailed = view.preferences.mode === 'detailed';
      if (!detailed || !quotaWindows.length) {
        const quota = quotaWindows[0];
        const line = el('div', undefined, 'row-line'); line.append(bar(quota), el('span', used(quota), 'usage quiet small'));
        row.append(line);
        const meta = [reset(quota?.resetAt), quota?.usedPercent != null && (quota.observedAt == null || quota.observedAt > Date.now() || Date.now() - quota.observedAt > 120000) ? age(quota.observedAt) ?? 'Update time unknown' : null].filter(Boolean).join(' · ');
        row.append(el('div', meta, 'compact-meta quiet small'));
      }
      if (detailed) {
        const plan = account.rich?.plan ?? account.plan;
        if (plan) row.append(el('div', plan, 'quiet small'));
        for (const window of quotaWindows) row.append(quotaWindow(window));
      }
      section.append(row);
    }
    content.append(section);
  }
}
function pair(list, label, value) { if (value != null && value !== '') list.append(el('dt', label), el('dd', value)); }
function renderDetail(account) {
  const box = el('section', undefined, 'detail');
  box.append(button('← Back', back, { focus: 'back' }), el('div', accountLabel(account, view.snapshot.accounts), 'detail-email'));
  const metadata = el('div', undefined, 'account-meta');
  metadata.append(el('p', [account.provider === 'codex' ? 'Codex' : account.provider === 'claude' ? 'Claude' : account.provider, account.rich?.plan ?? account.plan].filter(Boolean).join(' · '), 'quiet'));
  const row = el('div', undefined, 'switch-row');
  const label = el('label', 'Enabled'); label.htmlFor = 'enabled';
  const toggle = el('input'); toggle.type = 'checkbox'; toggle.id = 'enabled'; toggle.dataset.focus = 'enabled'; toggle.setAttribute('role', 'switch');
  const local = localIntents.get(account.key);
  const intent = local && local.identity.name === account.identity?.name && local.identity.authIndex === account.identity?.authIndex ? local : null;
  const pending = !!intent || !!account.mutation;
  const desired = intent?.disabled ?? account.mutationDisabled;
  toggle.checked = pending && typeof desired === 'boolean' ? !desired : account.disabled === false;
  toggle.disabled = pending || !fresh() || account.disabled == null;
  toggle.setAttribute('aria-describedby', 'enabled-progress');
  toggle.addEventListener('change', async () => {
    const generation = hostGeneration;
    const restoreFocus = document.activeElement === toggle && toggle.matches(':focus-visible');
    const action = { identity: { ...account.identity }, disabled: !toggle.checked, phase: 'saving' };
    localIntents.set(account.key, action); message = ''; render();
    let moved = false;
    const movedFocus = event => { if (event.target !== document.body) moved = true; };
    document.addEventListener('focusin', movedFocus, true); document.addEventListener('pointerdown', movedFocus, true);
    const currentIdentity = () => view?.snapshot?.accounts.some(value => value.key === account.key && value.identity?.name === action.identity.name && value.identity?.authIndex === action.identity.authIndex);
    const updated = await request('usage.toggle', { ...target(account), disabled: action.disabled }, currentIdentity, error => { action.error = error; });
    document.removeEventListener('focusin', movedFocus, true); document.removeEventListener('pointerdown', movedFocus, true);
    if (generation !== hostGeneration) return;
    if (!currentIdentity()) { if (localIntents.get(account.key) === action) localIntents.delete(account.key); render(); return; }
    if (localIntents.get(account.key) === action) {
      if (updated) localIntents.delete(account.key); else action.phase = 'uncertain';
    }
    render();
    if (restoreFocus && !moved && detailKey === account.key && document.activeElement === document.body) document.getElementById('enabled')?.focus({ preventScroll: true });
  });
  const progress = el('span', undefined, 'mutation-progress'); progress.id = 'enabled-progress'; progress.setAttribute('role', 'status');
  const uncertain = intent?.phase === 'uncertain' || account.mutation === 'unconfirmed';
  progress.dataset.phase = uncertain ? 'uncertain' : pending ? 'saving' : 'idle';
  progress.append(el('span', uncertain ? 'Change not confirmed. Refresh to check.' : pending ? 'Saving Enabled change…' : '', 'sr-only'));
  row.append(label, toggle, progress); metadata.append(row); box.append(metadata);
  const state = pending ? '' : stateText(account);
  box.append(el('p', state === 'Available' ? '' : state, 'account-state quiet small'));
  if (account.mutationError) notice.append(el('p', account.mutationError, 'error small'));
  if (intent?.error) notice.append(el('p', intent.error, 'error small'));
  if (uncertain) notice.append(el('p', 'Change not confirmed. Refresh to check.', 'error small'));
  box.append(el('h3', 'Quota'));
  if (!windows(account).length) {
    box.append(quotaWindow({ label: 'Usage', usedPercent: null, observedAt: null, resetAt: null }));
  }
  for (const window of windows(account)) box.append(quotaWindow(window));
  if (account.rich?.error && !checkingUsage(account)) box.append(el('p', account.rich.error, 'error small'));
  const details = el('dl');
  const credits = account.rich?.credits ?? account.credits;
  if (credits?.unlimited) pair(details, 'Credits', 'Unlimited');
  else if (Number.isFinite(credits?.balance)) pair(details, 'Credits', new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(credits.balance));
  const until = account.rich?.subscriptionUntil;
  if (until != null) pair(details, until > Date.now() ? 'Subscription ends' : 'Subscription ended', humanDate(until));
  const entitlements = account.rich?.resetEntitlements;
  if (entitlements) {
    pair(details, 'Resets remaining', entitlements.available);
    const dates = (entitlements.expiresAt ?? []).filter(at => humanDate(at) !== null).sort((a, b) => a - b);
    const next = dates.find(at => at > Date.now());
    const expiry = next ?? dates.at(-1);
    if (expiry != null) pair(details, next != null ? 'Next expires' : 'Last expired', humanDate(expiry));
  }
  if (details.childElementCount) box.append(details);
  if (account.cooldowns.length) {
    box.append(el('h3', 'Restrictions'));
    for (const cooldown of account.cooldowns) {
      const when = humanDate(cooldown.retryAt);
      const retry = when ? cooldown.retryAt > Date.now() ? `Retry ${when.startsWith('in ') ? when : `on ${when}`}` : 'Retry time passed' : null;
      const scope = cooldown.model ?? (cooldown.scope === 'model' ? 'Model' : cooldown.scope === 'credential' ? 'Account' : 'Restriction');
      box.append(el('p', [scope, cooldown.reason, retry].filter(Boolean).join(' · '), 'quiet small'));
    }
  }
  if (account.modelWindows.length) {
    box.append(el('h3', 'Model usage'));
    for (const window of account.modelWindows) { box.append(el('p', window.model, 'quiet small'), quotaWindow(window)); }
  }
  content.append(box);
}
function render() {
  clearTimeout(freshnessTimer);
  if (fresh()) freshnessTimer = setTimeout(render, Math.max(1, view.snapshot.observedAt + 120001 - Date.now()));
  const scroll = content.scrollTop;
  const focus = document.activeElement?.dataset?.focus;
  renderHeader(); renderNotice(); content.replaceChildren();
  const account = detailKey && view?.snapshot?.accounts.find(a => a.key === detailKey);
  if (account) renderDetail(account); else renderList();
  content.scrollTop = scroll;
  if (focus) [...document.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focus)?.focus({ preventScroll: true });
}

render();
window.orca.plugin.on('usage.changed', next => {
  assertJson(next);
  if (Array.isArray(next?.profiles)) adopt(next);
  else void request('usage.state');
});
await request('usage.state');
initialLoading = false; render();
