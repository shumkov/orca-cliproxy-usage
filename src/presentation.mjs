import { isObservationFresh, selectDisplayWindow } from './quota.mjs';

export function clip(value, limit) {
  if (value.length <= limit) return value;
  let end = Math.max(0, limit - 1);
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return value.slice(0, end) + '…';
}

export function accountLabel(account, accounts, limit = Infinity) {
  const email = value => value.email?.trim() && value.email !== value.name && value.email !== 'Unnamed credential' ? value.email : null;
  const address = email(account);
  const peers = accounts.filter(value => value.provider === account.provider && email(value) === address)
    .sort((a, b) => a.key.localeCompare(b.key));
  if (address && peers.length < 2) return clip(address, limit);
  const ordinal = Math.max(0, peers.findIndex(value => value.key === account.key)) + 1;
  const suffix = `Account ${ordinal}`;
  return address ? `${clip(address, Math.max(1, limit - suffix.length - 3))} · ${suffix}` : suffix;
}

export function displayAccount(accounts, now = Date.now()) {
  const ordered = [...accounts].sort((a, b) => a.key.localeCompare(b.key));
  const quality = account => {
    const window = selectDisplayWindow(account);
    return !Number.isFinite(window?.usedPercent) ? 2 : isObservationFresh(window, now) ? 0 : 1;
  };
  return ordered.filter(account => account.available).sort((a, b) => quality(a) - quality(b))[0] ?? ordered[0];
}

export function windowLabel(window) {
  const minutes = window.minutes;
  const label = window.label?.trim() || 'Usage';
  let period = null;
  if (Number.isFinite(minutes) && minutes > 0) {
    period = minutes === 60 ? 'Hourly' : minutes === 300 ? '5-hour' : minutes === 10080 ? 'Weekly' : minutes === 43200 ? 'Monthly'
      : minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
  }
  const durationLabel = /^(?:hourly|weekly|monthly|\d+\s*(?:-|\s)\s*(?:minutes?|hours?|days?)(?: window)?)$/i.test(label);
  const scope = /^(?:primary|secondary)$/i.test(label) ? '' : label.replace(/(?:^|\s)(?:primary|secondary)[ _]+window$/i, '').trim();
  if (period) return scope && !durationLabel ? `${scope} · ${period}` : period;
  return /^7\s*days?$/i.test(label) ? 'Weekly' : /^30\s*days?$/i.test(label) ? 'Monthly' : scope || 'Usage';
}

export function humanDate(at, now = Date.now()) {
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) return null;
  const minutes = (at - now) / 60000;
  const distance = Math.abs(minutes);
  if (distance < 1) return minutes > 0 ? 'in less than a minute' : 'just now';
  if (distance > 43200) return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(at);
  const unit = distance < 60 ? 'minute' : distance < 1440 ? 'hour' : 'day';
  const amount = distance / (unit === 'minute' ? 1 : unit === 'hour' ? 60 : 1440);
  const rounded = Math.max(1, minutes > 0 ? Math.ceil(amount) : Math.floor(amount));
  return new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(minutes > 0 ? rounded : -rounded, unit);
}

export function observationAge(at, now = Date.now()) {
  if (!Number.isFinite(at) || at > now) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 1 ? 'Updated just now' : minutes < 60 ? `Updated ${minutes}m ago` : minutes < 1440 ? `Updated ${Math.floor(minutes / 60)}h ago` : `Updated ${Math.floor(minutes / 1440)}d ago`;
}
