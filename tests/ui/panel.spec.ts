import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fixture } from './fixture.ts';

const hostThemes = JSON.parse(readFileSync(new URL('../fixtures/orca-frame-themes.json', import.meta.url), 'utf8')) as { light: Record<string, string>; dark: Record<string, string> };

function contrastRatio(foreground: string, background: string) {
  const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).reduce((sum, value, index) => {
    const channel = value / 255;
    return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]!;
  }, 0);
  const a = luminance(foreground); const b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}


async function applyFrameTheme(page: Page, scheme: string, tokens: Record<string, string>) {
  await page.evaluate(({ scheme, tokens }) => {
    document.documentElement.className = scheme;
    for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(`--orca-${key}`, value);
  }, { scheme, tokens });
}

test('shipped Orca dark tokens use the card panel surface instead of the app canvas', async ({ page }) => {
  await fixture(page);
  await applyFrameTheme(page, 'dark', hostThemes.dark);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 23, 23)');
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(240, 240, 240)');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await applyFrameTheme(page, 'light', hostThemes.light);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(10, 10, 10)');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
});

test('in-place host theme updates preserve panel state and pair card, secondary and accent foregrounds', async ({ page }) => {
  await page.setViewportSize({ width: 297, height: 620 });
  await fixture(page);
  await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  const row = page.locator('[data-account="entry-8"]');
  await row.scrollIntoViewIfNeeded();
  const scroll = await page.locator('main').evaluate(node => node.scrollTop);
  await row.click();
  const back = page.getByRole('button', { name: '← Back', exact: true });
  await back.focus();
  const requests = await page.evaluate(() => (window as any).requests.length);
  const tokens = { ...hostThemes.light, background: '#ffffff', foreground: '#000000', card: 'rgb(38 45 57)', 'card-foreground': '#fafbfc',
    secondary: '#f5f5f5', 'secondary-foreground': '#123456', accent: 'color-mix(in srgb, #e0e0e0 50%, #ffffff)', 'accent-foreground': '#182838',
    muted: '#424a56', 'muted-foreground': '#e1e5ea', border: '#ffffff26' };
  await page.mouse.move(0, 0);
  await applyFrameTheme(page, 'light', tokens);
  const resolved = await page.evaluate(tokens => {
    const probe = document.createElement('span'); probe.style.backgroundColor = tokens.accent; probe.style.borderColor = tokens.border; document.body.append(probe);
    const style = getComputedStyle(probe); const colors = { accent: style.backgroundColor, border: style.borderTopColor }; probe.remove(); return colors;
  }, tokens);
  await expect(back).toBeFocused();
  await expect(page.locator('.detail-email')).toHaveText('account-8@example.test');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(38, 45, 57)');
  await expect(page.locator('.detail-email')).toHaveCSS('color', 'rgb(250, 251, 252)');
  await expect(page.locator('.detail .usage')).toHaveCSS('color', 'rgb(250, 251, 252)');
  await expect(page.locator('header')).toHaveCSS('border-bottom-color', resolved.border);
  await expect(back).toHaveCSS('color', 'rgb(18, 52, 86)');
  await back.hover();
  await expect(back).toHaveCSS('color', 'rgb(24, 40, 56)');
  await back.click();
  await expect(page.getByRole('button', { name: 'Detailed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('main').evaluate(node => node.scrollTop)).toBe(scroll);
  await expect(row).toBeFocused();
  await row.hover();
  await expect(row).toHaveCSS('background-color', resolved.accent);
  for (const selector of ['.email', '.usage', '.window .row-line span', '.split span']) {
    await expect(row.locator(selector).first()).toHaveCSS('color', 'rgb(24, 40, 56)');
  }
  await expect(page.getByRole('button', { name: 'Detailed', exact: true })).toHaveCSS('color', 'rgb(24, 40, 56)');
  expect(await page.evaluate(() => (window as any).requests.length)).toBe(requests);
  await page.screenshot({ path: 'test-results/host-theme-functional-297.png' });
  await page.mouse.move(0, 0);
  await applyFrameTheme(page, 'dark', hostThemes.dark);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 23, 23)');
  await expect(row).toBeFocused();
  expect(await page.locator('main').evaluate(node => node.scrollTop)).toBe(scroll);
  await page.screenshot({ path: 'test-results/host-theme-dark-297.png' });
});

test('Compact / Detailed and click / Back restore mode, scroll, and focus', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Detailed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const row = page.locator('[data-account="entry-8"]');
  await row.scrollIntoViewIfNeeded();
  const before = await page.locator('main').evaluate(node => node.scrollTop);
  expect(before).toBeGreaterThan(0);
  await row.click();
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Detailed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('main').evaluate(node => node.scrollTop)).toBe(before);
  await expect(row).toBeFocused();
});

test('keyboard Enter opens details; hostile labels and errors remain text', async ({ page }) => {
  await fixture(page);
  const row = page.locator('[data-account="entry-0"]');
  await row.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('switch', { name: 'Enabled' })).toBeVisible();
  await expect(page.locator('img')).toHaveCount(0);
  await page.evaluate(() => { (window as any).toggleOutcome = 'error'; });
  await page.getByRole('switch', { name: 'Enabled' }).click();
  await expect(page.getByRole('switch', { name: 'Enabled' })).toBeDisabled();
  await page.evaluate(() => (window as any).resolveToggle());
  await expect(page.locator('#notice')).toContainText('rejected');
  await expect(page.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
});

test('Enabled is pending until confirmed without exposing manual status selection', async ({ page }) => {
  await fixture(page);
  await page.locator('[data-account="entry-1"]').click();
  const toggle = page.getByRole('switch', { name: 'Enabled', exact: true });
  await expect(toggle).toBeChecked(); await toggle.click();
  await expect(toggle).toBeDisabled(); await expect(page.locator('.mutation-progress')).toHaveAttribute('data-phase', 'saving');
  await page.evaluate(() => (window as any).resolveToggle());
  await expect(toggle).not.toBeChecked(); await expect(toggle).toBeEnabled();
  await expect(page.getByRole('button', { name: /status bar/i })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).requests.filter((r: any) => r.name === 'usage.toggle').length)).toBe(1);
});

test('ordinary usage surfaces hide filenames and implementation narration while preserving account identity', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state');
    view.snapshot.accounts[0].email = view.snapshot.accounts[0].name;
    view.snapshot.accounts[1].email = 'same@example.test';
    view.snapshot.accounts[2].email = 'same@example.test';
    view.snapshot.accounts[3].email = 'Unnamed credential'; view.snapshot.accounts[3].name = null;
    view.snapshot.accounts[4].email = 'Unnamed credential'; view.snapshot.accounts[4].name = null;
    host.push(view);
  });
  await expect(page.getByRole('button', { name: 'Open Account 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Account 2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Account 3', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Unnamed credential');
  const duplicate = page.getByRole('button', { name: 'Open same@example.test · Account 2', exact: true });
  await expect(duplicate).toBeVisible();
  await expect(page.locator('body')).not.toContainText('.json');
  expect(await page.locator('.provider-title [title]').count()).toBe(0);
  await duplicate.click();
  await expect(page.locator('.detail-email')).toHaveText('same@example.test · Account 2');
  await expect(page.locator('body')).not.toContainText(/\.json|Persisted flag|routing|priority\./);
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toBeChecked();
  await page.getByRole('button', { name: '← Back' }).click();
  await page.getByRole('button', { name: 'Open Account 1', exact: true }).click();
  await expect(page.locator('.detail-email')).toHaveText('Account 1');
});

test('normal account usage omits redundant Available labels while exceptions and counts remain', async ({ page }) => {
  await fixture(page);
  await expect(page.locator('.provider-title').first()).toHaveText('Codex12/12');
  await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  await expect(page.locator('body')).not.toContainText(/\bAvailable\b|\bavailable\b/);
  await page.locator('[data-account="entry-1"]').click();
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toBeChecked();
  await expect(page.locator('body')).not.toContainText(/\bAvailable\b|\bavailable\b/);
  await page.getByRole('button', { name: '← Back' }).click();
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state');
    view.snapshot.accounts[1].available = false; view.snapshot.accounts[1].quotaBlocked = true;
    view.snapshot.accounts[2].available = false; view.snapshot.accounts[2].disabled = true;
    host.push(view);
  });
  await expect(page.locator('.provider-title').first()).toHaveText('Codex10/12');
  await expect(page.locator('[data-account="entry-1"]')).toContainText('Limit reached');
  await expect(page.locator('[data-account="entry-2"]')).toContainText('Disabled');
});

test('Detailed rows show each usage window and exceptional state once', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state');
    view.snapshot.accounts[1].quotaBlocked = true; view.snapshot.accounts[1].available = false;
    view.snapshot.accounts[2].disabled = true; view.snapshot.accounts[2].available = false;
    view.snapshot.accounts[3].windows = [];
    view.snapshot.accounts[4].windows.push({ ...view.snapshot.accounts[4].windows[0], id: 'secondary', label: 'Secondary', usedPercent: 35 });
    host.push(view);
  });
  await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  for (const [key, state] of [['entry-1', 'Limit reached'], ['entry-2', 'Disabled']]) {
    const row = page.locator(`[data-account="${key}"]`);
    await expect(row.getByRole('meter')).toHaveCount(1);
    await expect(row.getByText('21% used', { exact: true })).toHaveCount(1);
    await expect(row.getByText('resets in 3 days', { exact: true })).toHaveCount(1);
    await expect(row.getByText(state, { exact: true })).toHaveCount(1);
  }
  await expect(page.locator('[data-account="entry-3"]').getByText('N/A', { exact: true })).toHaveCount(1);
  await expect(page.locator('[data-account="entry-4"]').getByRole('meter')).toHaveCount(2);
  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  await expect(page.locator('[data-account="entry-1"]').getByRole('meter')).toHaveCount(1);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state');
    view.snapshot.observedAt = Date.now() - 120001;
    view.snapshot.accounts[4].cooldowns = [{ scope: 'model', model: 'Model A', reason: 'Rate limited', retryAt: null, httpStatus: 429 }];
    host.push(view);
  });
  await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  await expect(page.locator('[data-account="entry-1"]').getByText('Limit reached', { exact: true })).toHaveCount(1);
  await expect(page.locator('[data-account="entry-4"]').getByText('Model restrictions', { exact: true })).toHaveCount(1);
});

test('account details use monthly usage, formatted credits and one nearest expiry without request buckets', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state'); const now = Date.now();
    const account = view.snapshot.accounts[1];
    account.windows = [{ label: 'Primary Window', minutes: 43200, usedPercent: 24, observedAt: now, resetAt: now + 259200000 }];
    account.rich = { windows: [], observedAt: now, credits: { balance: 8068.4245375, unlimited: false },
      resetEntitlements: { available: 3, applicable: null, expiresAt: [now + 432000000, now + 259200000, now + 259200000, now - 86400000, null] },
      subscriptionUntil: now + 7776000000 };
    account.recent = Array.from({ length: 20 }, (_, i) => ({ label: `${i}h`, success: 0, failed: 0 }));
    host.push(view);
  });
  await page.locator('[data-account="entry-1"]').click();
  await expect(page.getByText('Monthly', { exact: true })).toBeVisible();
  await expect(page.locator('body')).toContainText('8,068.42');
  await expect(page.locator('dt', { hasText: 'Resets remaining' })).toHaveCount(1);
  await expect(page.locator('dt', { hasText: 'Next expires' })).toHaveCount(1);
  await expect(page.locator('dt', { hasText: 'Next expires' }).locator('xpath=following-sibling::dd[1]')).toHaveText('in 3 days');
  await expect(page.locator('dt', { hasText: 'Subscription ends' }).locator('xpath=following-sibling::dd[1]')).toHaveText(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
  await expect(page.locator('body')).not.toContainText(/Primary Window|30d window|Priority|Proxy status|Sign-in|Resets applicable|Reset expires|Recent requests|succeeded|8068\.424|\d{1,2}\/\d{1,2}\/\d{4}|\d\d:\d\d:\d\d/);
});

test('empty optional account metadata is omitted and unknown usage never becomes zero', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state'); const account = view.snapshot.accounts[1];
    account.plan = null; account.credits = null;
    account.windows = [{ label: 'Primary Window', minutes: 43200, usedPercent: null, resetAt: null, observedAt: null }];
    account.rich = { windows: [], observedAt: Date.now(), plan: null, credits: { balance: null, unlimited: false },
      resetEntitlements: { available: null, applicable: null, expiresAt: [null] }, subscriptionUntil: null };
    host.push(view);
  });
  await page.locator('[data-account="entry-1"]').click();
  await expect(page.getByText('N/A', { exact: true })).toBeVisible();
  await expect(page.locator('.detail dt')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/Unknown|unknown|0% used|Priority|Status|Sign-in|Recent requests/);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state');
    view.snapshot.accounts[1].windows[0].usedPercent = 21; view.snapshot.accounts[1].windows[0].observedAt = Date.now();
    host.push(view);
  });
  await expect(page.locator('body')).toContainText('21% used');
  await expect(page.locator('body')).not.toContainText(/Reset time unavailable|Update time unavailable/);
});

test('passed reset and expiry stay explicit while a known zero reset count remains visible', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state'); const now = Date.now(); const account = view.snapshot.accounts[1];
    account.windows = [{ label: 'Primary Window', minutes: 300, usedPercent: 99, observedAt: now - 259200000, resetAt: now - 60000 }];
    account.rich = { windows: [], observedAt: now, resetEntitlements: { available: 0, applicable: null, expiresAt: [now - 259200000, now - 86400000] }, subscriptionUntil: now - 7776000000 };
    host.push(view);
  });
  await page.locator('[data-account="entry-1"]').click();
  await expect(page.getByText('5-hour', { exact: true })).toBeVisible();
  await expect(page.locator('body')).toContainText('99% used');
  await expect(page.locator('body')).toContainText('Reset passed · awaiting update');
  await expect(page.locator('body')).toContainText('Updated 3d ago');
  await expect(page.locator('dt', { hasText: 'Last expired' }).locator('xpath=following-sibling::dd[1]')).toHaveText('1 day ago');
  await expect(page.locator('dt', { hasText: 'Resets remaining' }).locator('xpath=following-sibling::dd[1]')).toHaveText('0');
  await expect(page.locator('dt', { hasText: 'Subscription ended' })).toHaveCount(1);
  await expect(page.locator('body')).not.toContainText(/Next expires|0% used/);
});

test('human quota durations preserve distinct code review and additional limit purposes', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state'); const now = Date.now();
    view.snapshot.accounts[1].windows = [
      ['Primary Window', 43200], ['Code review Primary Window', 43200], ['Search Secondary Window', 43200], ['Primary Search Primary Window', 43200],
      ['Primary Window', 60], ['Primary Window', 300], ['Secondary Window', 10080], ['Primary Window', 120],
    ].map(([label, minutes], index) => ({ id: `window-${index}`, label, minutes, usedPercent: 21, observedAt: now, resetAt: now + 259200000 }));
    host.push(view);
  });
  await page.locator('[data-account="entry-1"]').click();
  for (const label of ['Monthly', 'Code review · Monthly', 'Search · Monthly', 'Primary Search · Monthly', 'Hourly', '5-hour', 'Weekly', '2-hour']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
});

test('an unnamed model restriction remains scoped to models in human details', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state');
    view.snapshot.accounts[1].cooldowns = [{ scope: 'model', model: null, reason: 'Rate limited', retryAt: null, httpStatus: 429 }];
    host.push(view);
  });
  await page.locator('[data-account="entry-1"]').click();
  await expect(page.getByText('Model · Rate limited', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Account · Rate limited');
});

test('account details have no manual status selection even with obsolete saved pins', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state');
    view.preferences.selected = { 'local:codex': 'entry-0' }; host.push(view);
  });
  await page.locator('[data-account="entry-1"]').click();
  await expect(page.getByRole('button', { name: /status bar/i })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).requests.some((r: any) => ['usage.toggle', 'usage.displayAccount'].includes(r.name)))).toBe(false);
});

test('missing quota and unconfirmed Enabled changes use concise human copy without unlocking the switch', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state');
    view.snapshot.accounts[1].windows = [];
    view.snapshot.accounts[1].mutation = 'unconfirmed';
    view.snapshot.accounts[2].windows = [{ label: 'Primary', usedPercent: null, resetAt: null, observedAt: null }];
    host.push(view);
  });
  await page.locator('[data-account="entry-1"]').click();
  await expect(page.getByText('N/A', { exact: true })).toBeVisible();
  await expect(page.locator('#notice')).toContainText('Change not confirmed. Refresh to check.');
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toBeDisabled();
  await expect(page.locator('body')).not.toContainText(/Unknown is not zero|Persisted flag/);
  await page.getByRole('button', { name: '← Back' }).click();
  await page.locator('[data-account="entry-2"]').click();
  await expect(page.getByText('N/A', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/Reset time unavailable|Update time unavailable|Stale/);
});

test('host switching closes details and late detail reply cannot reopen old account', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).holdDetails = true; });
  await page.locator('[data-account="entry-0"]').click();
  await expect(page.getByRole('button', { name: '← Back' })).toBeVisible();
  await page.getByLabel('Host', { exact: true }).selectOption('remote');
  await expect(page.locator('[data-account="entry-0"]')).toContainText('remote-entry-0');
  await page.evaluate(() => (window as any).releaseDetails());
  await expect(page.getByRole('switch', { name: 'Enabled' })).toHaveCount(0);
  await expect(page.getByLabel('Host', { exact: true })).toHaveValue('remote');
});

test('stale and future snapshots never show Available in Detailed mode', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  await page.evaluate(() => {
    (window as any).orca.plugin.request('usage.state').then((view: any) => (window as any).push({ snapshot: { ...view.snapshot, error: 'Transport unavailable' } }));
  });
  await expect(page.locator('#notice')).toContainText('Transport unavailable');
  await page.evaluate(() => {
    (window as any).orca.plugin.request('usage.state').then((view: any) => (window as any).push({ snapshot: { ...view.snapshot, error: null, observedAt: Date.now() + 600000 } }));
  });
  await expect(page.locator('.provider-title').first()).toContainText('—/12');
  await page.locator('[data-account="entry-0"]').click();
  await expect(page.getByRole('switch', { name: 'Enabled' })).toBeDisabled();
});

test('a rejected late request from the old host does not report an error on the new host', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).holdDetails = true; (window as any).rejectDetails = true; });
  await page.locator('[data-account="entry-0"]').click();
  await page.getByLabel('Host', { exact: true }).selectOption('remote');
  await page.evaluate(() => (window as any).releaseDetails());
  await expect(page.locator('#notice')).not.toContainText('Old host');
  await expect(page.locator('[data-account="entry-0"]')).toContainText('remote-entry-0');
});

test('external host changes clear the previous host refresh loading flag', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).holdRefresh = true; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
  await page.evaluate(async () => {
    const host = window as any;
    const next = await host.orca.plugin.request('usage.selectHost', { id: 'remote' }); host.push(next);
    host.releaseRefresh();
  });
  await expect(page.getByLabel('Host', { exact: true })).toHaveValue('remote');
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
});

for (const theme of ['light', 'dark']) {
  for (const width of [297, 350]) {
    test(`${theme} ${width}px hierarchy, hover and keyboard feedback preserve click-through`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await fixture(page, theme);
      await page.evaluate(async () => {
        const host = window as any; const view = await host.orca.plugin.request('usage.state');
        view.snapshot.accounts = view.snapshot.accounts.slice(0, 3);
        view.snapshot.accounts[1].email = 'a-very-long-account-address@example.test';
        view.snapshot.accounts[1].windows[0].label = 'Code review Primary Window';
        view.snapshot.accounts[1].windows[0].minutes = 10080;
        view.snapshot.accounts[1].available = false; view.snapshot.accounts[1].quotaBlocked = true;
        host.push(view);
      });
      await page.getByRole('button', { name: 'Detailed', exact: true }).click();
      const row = page.locator('[data-account="entry-1"]');
      const before = await row.evaluate(node => getComputedStyle(node).backgroundColor);
      const requests = await page.evaluate(() => (window as any).requests.length);
      await row.hover();
      expect(await row.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(before);
      expect(await row.evaluate(node => getComputedStyle(node).cursor)).toBe('pointer');
      expect(await page.evaluate(() => (window as any).requests.length)).toBe(requests);
      await expect(page.getByRole('switch')).toHaveCount(0);
      const hierarchy = await row.evaluate(node => {
        const style = (selector: string) => getComputedStyle(node.querySelector(selector)!);
        const email = style('.email'); const usage = style('.usage'); const period = style('.window .row-line span');
        const meta = style('.split'); const badge = style('.badge');
        return {
          heading: Number.parseFloat(getComputedStyle(document.querySelector('h2')!).fontSize),
          period: Number.parseFloat(period.fontSize), email: Number.parseFloat(email.fontSize), meta: Number.parseFloat(meta.fontSize),
          emailWeight: Number(email.fontWeight), usageWeight: Number(usage.fontWeight), periodWeight: Number(period.fontWeight),
          background: getComputedStyle(node).backgroundColor, colors: [email, usage, period, meta, badge].map(s => s.color),
        };
      });
      expect(hierarchy.heading).toBeGreaterThan(hierarchy.period);
      expect(hierarchy.email).toBeGreaterThan(hierarchy.meta);
      expect(hierarchy.emailWeight).toBeGreaterThan(hierarchy.periodWeight);
      expect(hierarchy.usageWeight).toBeGreaterThan(hierarchy.periodWeight);
      for (const color of hierarchy.colors) expect(contrastRatio(color, hierarchy.background)).toBeGreaterThanOrEqual(4.5);
      await expect(row).toHaveAccessibleName('Open a-very-long-account-address@example.test');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/${theme}-hierarchy-${width}.png` });
      await row.click();
      await expect(page.locator('.detail-email')).toHaveText('a-very-long-account-address@example.test');
      const toggle = page.getByRole('switch', { name: 'Enabled', exact: true });
      for (const checked of [true, false]) {
        await page.evaluate(async checked => {
          const host = window as any; const view = await host.orca.plugin.request('usage.state');
          view.snapshot.accounts[1].disabled = !checked; host.push(view);
        }, checked);
        const colors = await toggle.evaluate(node => [getComputedStyle(node, '::before').backgroundColor, getComputedStyle(node).backgroundColor]);
        expect(contrastRatio(colors[0]!, colors[1]!)).toBeGreaterThanOrEqual(3);
      }
      await page.evaluate(async () => {
        const host = window as any; const view = await host.orca.plugin.request('usage.state');
        view.snapshot.accounts[1].disabled = false; host.push(view);
      });
      const toggleBefore = await toggle.evaluate(node => getComputedStyle(node).boxShadow);
      await toggle.hover();
      expect(await toggle.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe(toggleBefore);
      for (const control of [toggle, page.getByLabel('Host', { exact: true }), page.getByRole('button', { name: '← Back', exact: true })]) {
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(24);
      }
      for (const control of [page.getByLabel('Host', { exact: true }), page.getByRole('button', { name: '← Back', exact: true })]) {
        await page.mouse.move(0, 0);
        const plain = await control.evaluate(node => [getComputedStyle(node).backgroundColor, getComputedStyle(node).borderColor]);
        await control.hover();
        expect(await control.evaluate(node => [getComputedStyle(node).backgroundColor, getComputedStyle(node).borderColor])).not.toEqual(plain);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/${theme}-hierarchy-detail-${width}.png` });
      await page.getByRole('button', { name: '← Back', exact: true }).click();
      await expect(row).toBeFocused();
      expect(await row.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('none');
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      await expect(row).toBeFocused();
      expect(await row.evaluate(node => node.matches(':focus-visible'))).toBe(true);
      expect(await row.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
      expect(await row.evaluate(node => Number.parseFloat(getComputedStyle(node).outlineOffset))).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/${theme}-hierarchy-focus-${width}.png` });
      await page.keyboard.press('Enter');
      await expect(toggle).toBeVisible();
      await page.getByRole('button', { name: '← Back', exact: true }).press('Enter');
      await expect(row).toBeFocused();
      expect(await row.evaluate(node => node.matches(':focus-visible'))).toBe(true);
      expect(await page.evaluate(() => (window as any).requests.some((r: any) => r.name === 'usage.toggle'))).toBe(false);
    });
  }

  test(`${theme} narrow view has no horizontal overflow and no hover navigation`, async ({ page }) => {
    await page.setViewportSize({ width: 260, height: 620 });
    await fixture(page, theme);
    const row = page.locator('[data-account="entry-0"]');
    await row.hover();
    await expect(page.getByRole('switch', { name: 'Enabled' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await row.click();
    await expect(page.getByRole('switch', { name: 'Enabled' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/${theme}-details-260.png` });
    await page.getByRole('button', { name: '← Back' }).click();
    await page.screenshot({ path: `test-results/${theme}-list-260.png` });
  });
}

test('Enabled is a compact labelled control beside metadata at narrow sidebar widths', async ({ page }) => {
  for (const width of [297, 350]) {
    await page.setViewportSize({ width, height: 620 }); await fixture(page);
    await page.evaluate(async () => {
      const host = window as any; const view = await host.orca.plugin.request('usage.state');
      view.snapshot.accounts[1].plan = 'Pro 200 with a long descriptive subscription name'; host.push(view);
    });
    await page.locator('[data-account="entry-1"]').click();
    const toggle = page.getByRole('switch', { name: 'Enabled', exact: true });
    await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
    const row = await page.locator('.switch-row').boundingBox(); const detail = await page.locator('.detail').boundingBox();
    expect(row!.width).toBeLessThan(detail!.width * .6); expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    expect(await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/compact-enabled-${width}.png` });
  }
});

for (const theme of ['light', 'dark'] as const) {
  for (const width of [297, 350]) {
    test(`${theme} ${width}px authentic provider marks preserve names, theme and account navigation`, async ({ page }) => {
      const requests: string[] = []; page.on('request', request => requests.push(request.url()));
      await page.setViewportSize({ width, height: 620 }); await fixture(page, theme);
      await applyFrameTheme(page, theme, hostThemes[theme]);
      await page.evaluate(async () => {
        const host = window as any; const view = await host.orca.plugin.request('usage.state');
        view.snapshot.accounts = [view.snapshot.accounts[1], view.snapshot.accounts[12]]; host.push(view);
      });
      await page.getByRole('button', { name: 'Detailed', exact: true }).click();
      for (const provider of ['Codex', 'Claude']) {
        const heading = page.getByRole('heading', { name: provider, exact: true });
        const label = heading.locator('..'); const mark = label.locator('svg.provider-mark');
        await expect(mark).toHaveCount(1); await expect(heading).toHaveAccessibleName(provider);
        await expect(label).toHaveText(provider); await expect(label.locator('..')).toContainText('1/1');
        await expect(mark).toHaveAttribute('aria-hidden', 'true'); await expect(mark).toHaveAttribute('focusable', 'false');
        expect(await mark.getAttribute('tabindex')).toBeNull();
        const geometry = await mark.locator('path').evaluate((node: SVGPathElement) => {
          const box = node.getBBox(); return { width: box.width, height: box.height };
        });
        expect(geometry.width).toBeGreaterThan(0); expect(geometry.height).toBeGreaterThan(0);
        const icon = await mark.boundingBox(); const title = await heading.boundingBox();
        expect(icon!.x + icon!.width).toBeLessThan(title!.x);
        expect(Math.abs(icon!.y + icon!.height / 2 - title!.y - title!.height / 2)).toBeLessThan(2);
        expect(icon!.width).toBeLessThanOrEqual(title!.height);
      }
      const codex = page.getByRole('heading', { name: 'Codex', exact: true }).locator('..').locator('path');
      const claude = page.getByRole('heading', { name: 'Claude', exact: true }).locator('..').locator('path');
      const bodyColor = () => page.locator('body').evaluate(node => getComputedStyle(node).color);
      await expect(codex).toHaveCSS('fill', await bodyColor()); await expect(claude).toHaveCSS('fill', 'rgb(217, 119, 87)');
      const count = await page.evaluate(() => (window as any).requests.length);
      const other = theme === 'dark' ? 'light' : 'dark'; await applyFrameTheme(page, other, hostThemes[other]);
      await expect(codex).toHaveCSS('fill', await bodyColor()); await expect(claude).toHaveCSS('fill', 'rgb(217, 119, 87)');
      await applyFrameTheme(page, theme, hostThemes[theme]);
      await page.locator('svg.provider-mark').first().hover();
      expect(await page.evaluate(() => (window as any).requests.length)).toBe(count);
      await expect(page.getByRole('img')).toHaveCount(0);
      expect(await page.locator('body').evaluate(node => node.scrollWidth <= innerWidth)).toBe(true);
      expect(requests.every(url => new URL(url).origin === 'http://127.0.0.1:4179')).toBe(true);
      await page.mouse.move(0, 0); await page.screenshot({ path: `test-results/provider-marks-${theme}-${width}.png` });
      const row = page.locator('[data-account="entry-1"]'); await row.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('.detail-email')).toHaveText('account-1@example.test');
      await page.getByRole('button', { name: '← Back', exact: true }).click(); await expect(row).toBeFocused();
      await expect(page.getByRole('button', { name: 'Detailed', exact: true })).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => (window as any).requests.some((r: any) => r.name === 'usage.toggle'))).toBe(false);
    });
  }
}

test('unknown providers keep their named heading without a synthetic or inherited brand mark', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const host = window as any; const view = await host.orca.plugin.request('usage.state');
    view.snapshot.accounts = [{ ...view.snapshot.accounts[1], provider: 'constructor' }]; host.push(view);
  });
  const label = page.getByRole('heading', { name: 'constructor', exact: true }).locator('..');
  await expect(label).toHaveText('constructor'); await expect(label.locator('svg, img, .provider-mark')).toHaveCount(0);
  await expect(label.locator('..')).toContainText('1/1');
});

test('pending initial account read keeps account loading separate from quota absence', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => (window as any).push({ snapshot: { profileId: 'local', revision: 'rev-local', snapshotId: 'loading', accounts: [], observedAt: null, rejected: false, pending: 0, fresh: false, readState: 'loading', loadingDetails: [] } }));
  await expect(page.locator('main')).toContainText('Checking accounts…');
  await expect(page.locator('main')).not.toContainText('N/A');
  await page.evaluate(() => (window as any).push({ snapshot: { profileId: 'local', revision: 'rev-local', snapshotId: 'loading', accounts: [], observedAt: Date.now(), rejected: false, pending: 0, fresh: true, readState: 'settled', loadingDetails: [] } }));
  await expect(page.locator('main')).toContainText('No accounts on this host.');
});

test('empty detail quota stays N/A without locking a valid Enabled control during its rich read', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const host = window as any; host.holdDetails = true;
    host.push({ snapshot: { profileId: 'local', revision: 'rev-local', snapshotId: 'rich', observedAt: Date.now(), rejected: false, pending: 0, fresh: true, readState: 'settled', loadingDetails: [], accounts: [{ key: 'entry-0', identity: { name: 'a', authIndex: 'a' }, provider: 'claude', email: 'demo@example.test', disabled: true, available: false, status: 'active', requiresSignIn: false, quotaBlocked: false, unavailable: false, plan: 'Max 20x', credits: null, windows: [], modelWindows: [], cooldowns: [], recent: [] }] } });
  });
  await page.locator('[data-account="entry-0"]').click();
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toBeEnabled();
  await expect(page.locator('.detail')).toContainText('N/A');
  await expect(page.locator('.detail').getByText('N/A', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).releaseDetails());
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toBeEnabled();
  await expect(page.locator('.detail')).toContainText('N/A');
});


test('Back and reopen cannot publish an old detail failure or clear the new pending request', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { (window as any).queueDetails = true; });
  await page.locator('[data-account="entry-1"]').click();
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await page.locator('[data-account="entry-1"]').click();
  await page.evaluate(() => (window as any).detailsQueue[0].reject(new Error('obsolete detail failure')));
  await expect(page.locator('#notice')).not.toContainText('obsolete detail failure');
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toBeEnabled();
  await expect(page.locator('.detail')).toContainText('21% used');
  await page.evaluate(() => (window as any).detailsQueue[1].resolve());
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toBeEnabled();
});

test('background refresh retains prior usage and auth rejection never becomes an endless checking state', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const host = window as any;
    const snapshot = { profileId: 'local', revision: 'rev-local', snapshotId: 'retained', observedAt: Date.now(), rejected: false, pending: 0, fresh: true, readState: 'loading', loadingDetails: [], accounts: [{ key: 'retained', email: 'retained@example.test', provider: 'codex', disabled: false, available: true, cooldowns: [], windows: [{ label: 'Weekly', usedPercent: 31, observedAt: Date.now(), resetAt: null }] }] };
    host.push({ snapshot }); host.savedSnapshot = snapshot;
  });
  await expect(page.locator('main')).toContainText('31% used');
  await page.evaluate(() => { const host = window as any; host.push({ snapshot: { ...host.savedSnapshot, readState: 'settled', error: 'Could not update accounts' } }); });
  await expect(page.locator('#notice')).toContainText('Could not update accounts');
  await expect(page.locator('main')).toContainText('31% used');
  await page.evaluate(() => (window as any).push({ snapshot: { profileId: 'local', revision: 'rev-local', snapshotId: 'rejected', accounts: [], observedAt: null, rejected: true, pending: 0, fresh: false, readState: 'idle', loadingDetails: [], error: 'Authentication rejected' } }));
  await expect(page.locator('#notice')).toContainText('Could not authenticate');
  await expect(page.locator('main')).not.toContainText('Checking accounts');
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toBeVisible();
});

test('unknown window values stay N/A in Detailed and detail while reads settle', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  await page.evaluate(() => {
    const host = window as any; host.holdDetails = true;
    const snapshot = { profileId: 'local', revision: 'rev-local', snapshotId: 'unknown-window', observedAt: Date.now(), rejected: false, pending: 0, fresh: true, readState: 'loading', loadingDetails: [], accounts: [{ key: 'entry-0', email: 'unknown@example.test', provider: 'claude', disabled: false, available: true, cooldowns: [], windows: [{ label: 'Weekly', usedPercent: null, observedAt: null, resetAt: null }], modelWindows: [] }] };
    host.push({ snapshot }); host.savedSnapshot = snapshot;
  });
  await expect(page.locator('main')).toContainText('N/A');
  await page.locator('[data-account="entry-0"]').click();
  await expect(page.locator('.detail').getByText('N/A', { exact: true })).toBeVisible();
  await page.evaluate(() => { const host = window as any; host.push({ snapshot: { ...host.savedSnapshot, readState: 'settled' } }); host.releaseDetails(); });
  await expect(page.locator('.detail')).toContainText('N/A');
});
for (const width of [297, 350]) {
  test(`compact icon toolbar fits one line and retains accessible selected mode at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 }); await fixture(page);
    const host = page.getByRole('combobox', { name: 'Host', exact: true });
    const compact = page.getByRole('button', { name: 'Compact', exact: true });
    const detailed = page.getByRole('button', { name: 'Detailed', exact: true });
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    await expect(compact.locator('svg')).toHaveCount(1); await expect(refresh.locator('svg')).toHaveCount(1);
    const bounds = await Promise.all([host, compact, detailed, refresh].map(node => node.boundingBox()));
    expect(Math.max(...bounds.map(b => b!.y)) - Math.min(...bounds.map(b => b!.y))).toBeLessThan(4);
    expect(bounds.every(b => b!.x >= 0 && b!.x + b!.width <= width)).toBe(true);
    await compact.focus(); await page.keyboard.press('Tab'); await expect(detailed).toBeFocused();
    await page.keyboard.press('Enter'); await expect(detailed).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: `test-results/toolbar-${width}.png` });
  });
}

test('icon refresh exposes pending state, retains data, and respects reduced motion', async ({ page }) => {
  await fixture(page); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { (window as any).holdRefresh = true; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  await expect(refresh).toBeDisabled(); await expect(refresh).toHaveAttribute('aria-busy', 'true');
  await expect(refresh.locator('svg')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('main')).toContainText('21% used');
  await expect(refresh).toHaveAttribute('title', 'Refreshing usage…');
  await page.evaluate(() => (window as any).releaseRefresh());
  await expect(refresh).toBeEnabled(); await expect(refresh).toHaveAttribute('aria-busy', 'false');
  await expect(refresh).toHaveAttribute('title', 'Refresh');
});

test('removing the open account clears obsolete detail loading and releases Refresh', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { (window as any).holdDetails = true; });
  await page.locator('[data-account="entry-1"]').click();
  await page.evaluate(() => (window as any).push({ snapshot: { profileId: 'local', revision: 'rev-local', snapshotId: 'removed', observedAt: Date.now(), rejected: false, pending: 0, fresh: true, readState: 'settled', loadingDetails: [], accounts: [] } }));
  await expect(page.locator('main')).toContainText('No accounts on this host.');
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).releaseDetails());
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
});

test('failed host selection cannot strand obsolete detail loading on the account list', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { const host = window as any; host.holdDetails = true; host.rejectHost = true; });
  await page.locator('[data-account="entry-1"]').click();
  await page.getByRole('combobox', { name: 'Host', exact: true }).selectOption('remote');
  await expect(page.locator('#notice')).toContainText('Host selection failed');
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).releaseDetails());
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
});

test('background reads keep valid Enabled, navigation and mode controls usable without a status dot', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const host = window as any; host.holdRefresh = true; host.holdDetails = true; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Detailed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('combobox', { name: 'Host', exact: true })).toBeEnabled();
  await page.locator('[data-account="entry-1"]').click();
  const enabled = page.getByRole('switch', { name: 'Enabled', exact: true });
  await expect(enabled).toBeEnabled(); await enabled.click();
  await expect(enabled).toBeDisabled();
  expect(await page.evaluate(() => (window as any).requests.filter((r: any) => r.name === 'usage.toggle').length)).toBe(1);
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await page.locator('[data-account="entry-2"]').click();
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toBeEnabled();
  await expect(page.locator('.connection-status')).toHaveCount(0);
  await page.evaluate(() => { const host = window as any; host.releaseRefresh(); host.releaseDetails(); host.resolveToggle(); });
});

test('a valid pending snapshot expires safely and a successful read restores Enabled', async ({ page }) => {
  await page.clock.install(); await fixture(page);
  await page.evaluate(() => { (window as any).holdDetails = true; });
  await page.locator('[data-account="entry-1"]').click();
  const enabled = page.getByRole('switch', { name: 'Enabled', exact: true });
  await expect(enabled).toBeEnabled();
  await page.clock.fastForward(120001);
  await expect(enabled).toBeDisabled();
  await expect(page.locator('#notice')).toContainText('Connection is out of date');
  await page.evaluate(() => { const host = window as any; host.push({ snapshot: { profileId: 'local', revision: 'rev-local', snapshotId: 'renewed', observedAt: Date.now(), rejected: false, pending: 0, fresh: true, readState: 'settled', loadingDetails: [], accounts: [{ key: 'entry-1', email: 'account-1@example.test', provider: 'codex', disabled: false, available: true, cooldowns: [], windows: [], modelWindows: [] }] } }); host.releaseDetails(); });
  await expect(enabled).toBeEnabled();
});

for (const initialDisabled of [true, false]) {
  test(`pending ${initialDisabled ? 'enable' : 'disable'} keeps requested position through stale events and authoritative success`, async ({ page }) => {
    await fixture(page);
    await page.evaluate(value => (window as any).patchAccount('entry-1', { disabled: value, available: !value }), initialDisabled);
    await page.locator('[data-account="entry-1"]').click();
    const toggle = page.getByRole('switch', { name: 'Enabled', exact: true });
    await toggle.click(); await expect(toggle).toBeChecked({ checked: initialDisabled }); await expect(toggle).toBeDisabled();
    await expect(page.locator('.detail')).not.toContainText('Saving…');
    await page.evaluate(value => (window as any).patchAccount('entry-1', { disabled: value }), initialDisabled);
    await expect(toggle).toBeChecked({ checked: initialDisabled });
    await page.evaluate(() => (window as any).resolveToggle());
    await expect(toggle).toBeChecked({ checked: initialDisabled }); await expect(toggle).toBeEnabled();
    expect(await page.evaluate(() => (window as any).requests.filter((r: any) => r.name === 'usage.toggle').length)).toBe(1);
  });
}

test('confirmed failure reverts but uncertain Enabled preserves intent until authoritative reconciliation', async ({ page }) => {
  await fixture(page); await page.evaluate(() => (window as any).patchAccount('entry-1', { disabled: true, available: false }));
  await page.locator('[data-account="entry-1"]').click();
  const toggle = page.getByRole('switch', { name: 'Enabled', exact: true });
  await page.evaluate(() => { (window as any).toggleOutcome = 'unconfirmed'; });
  await toggle.click(); await page.evaluate(() => (window as any).resolveToggle());
  await expect(toggle).toBeChecked(); await expect(toggle).toBeDisabled();
  await page.getByRole('button', { name: '← Back', exact: true }).click(); await page.locator('[data-account="entry-1"]').click();
  await expect(toggle).toBeChecked(); await expect(toggle).toBeDisabled();
  await page.evaluate(() => (window as any).patchAccount('entry-1', { mutation: null, mutationDisabled: null, disabled: false, available: true }));
  await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
  await page.evaluate(() => { (window as any).toggleOutcome = 'not_applied'; });
  await toggle.click(); await page.evaluate(() => (window as any).resolveToggle());
  await expect(toggle).toBeChecked(); await expect(page.locator('#notice')).toContainText('Could not change Enabled'); await expect(toggle).toBeEnabled();
});

test('quota refresh keeps meter position stable and normal three-minute observation has no stale alarm', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const host = window as any; host.holdDetails = true; host.patchAccount('entry-1', { windows: [{ label: 'Weekly', usedPercent: 31, observedAt: Date.now() - 180000, resetAt: Date.now() + 259200000 }] }); });
  await page.locator('[data-account="entry-1"]').click();
  await expect(page.locator('.detail')).toContainText('Updated 3m ago');
  await expect(page.locator('.detail')).not.toContainText(/stale/i);
  const before = await page.getByRole('meter').boundingBox();
  await page.evaluate(() => (window as any).releaseDetails());
  const after = await page.getByRole('meter').boundingBox();
  expect(after!.y).toBe(before!.y);
});

for (const theme of ['light', 'dark']) for (const width of [297, 350]) {
  test(`${theme} ${width}px async switch intent, keyboard focus and quota layout stay stable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 }); await fixture(page, theme);
    await page.evaluate(() => { const host = window as any; host.holdDetails = true; host.patchAccount('entry-1', { disabled: true, available: false, windows: [{ label: 'Weekly', usedPercent: 31, observedAt: Date.now() - 180000, resetAt: Date.now() + 259200000 }] }); });
    await page.locator('[data-account="entry-1"]').click();
    const toggle = page.getByRole('switch', { name: 'Enabled', exact: true }); const before = await page.getByRole('meter').boundingBox();
    await page.screenshot({ path: `test-results/${theme}-async-before-${width}.png` });
    await toggle.focus(); await page.keyboard.press('Space');
    await expect(toggle).toBeChecked(); await expect(toggle).toBeDisabled();
    expect((await page.getByRole('meter').boundingBox())!.y).toBe(before!.y);
    await page.screenshot({ path: `test-results/${theme}-async-pending-${width}.png` });
    await page.evaluate(() => { const host = window as any; host.releaseDetails(); host.resolveToggle(); });
    await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled(); await expect(toggle).toBeFocused();
    expect((await page.getByRole('meter').boundingBox())!.y).toBe(before!.y);
    await page.screenshot({ path: `test-results/${theme}-async-confirmed-${width}.png` });
    await page.keyboard.press('Space'); await expect(toggle).not.toBeChecked();
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    const host = page.getByRole('combobox', { name: 'Host', exact: true }); await host.focus();
    await page.evaluate(() => (window as any).resolveToggle()); await expect(host).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('bridge uncertainty holds requested position until an ordered authoritative Refresh and never retries toggle', async ({ page }) => {
  await fixture(page); await page.locator('[data-account="entry-1"]').click();
  const toggle = page.getByRole('switch', { name: 'Enabled', exact: true });
  await page.evaluate(() => { (window as any).toggleOutcome = 'error'; });
  await toggle.click(); await page.evaluate(() => (window as any).resolveToggle());
  await expect(toggle).not.toBeChecked(); await expect(toggle).toBeDisabled();
  await expect(page.locator('#notice')).toContainText('Refresh to check');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
  expect(await page.evaluate(() => (window as any).requests.filter((r: any) => r.name === 'usage.toggle').length)).toBe(1);
});

test('replaced credential identity cannot inherit old optimistic state or old action errors', async ({ page }) => {
  await fixture(page); await page.locator('[data-account="entry-1"]').click();
  const toggle = page.getByRole('switch', { name: 'Enabled', exact: true });
  await toggle.click(); await expect(toggle).not.toBeChecked();
  await page.evaluate(() => { const host = window as any; host.toggleOutcome = 'error'; host.patchAccount('entry-1', { identity: { name: 'replacement.json', authIndex: 'new' }, disabled: false }); host.resolveToggle(); });
  await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
  await expect(page.locator('#notice')).not.toContainText('rejected');
  await expect(page.locator('.mutation-progress')).toHaveAttribute('data-phase', 'idle');
});

test('an earlier held Refresh cannot resolve uncertainty from a later Enabled action', async ({ page }) => {
  await fixture(page); await page.locator('[data-account="entry-1"]').click();
  await page.evaluate(() => { const host = window as any; host.holdRefresh = true; host.toggleOutcome = 'error'; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Enabled', exact: true });
  await toggle.click(); await page.evaluate(() => (window as any).resolveToggle());
  await expect(toggle).not.toBeChecked(); await expect(toggle).toBeDisabled();
  await page.evaluate(() => (window as any).releaseRefresh());
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(toggle).not.toBeChecked(); await expect(toggle).toBeDisabled();
});

test('Compact recency updates keep following account rows in place', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => (window as any).patchAccount('entry-1', { windows: [{ label: 'Weekly', usedPercent: 31, observedAt: Date.now() - 180000, resetAt: null }] }));
  const next = page.locator('[data-account="entry-2"]'); const before = await next.boundingBox();
  await page.evaluate(() => (window as any).patchAccount('entry-1', { windows: [{ label: 'Weekly', usedPercent: 32, observedAt: Date.now(), resetAt: null }] }));
  expect((await next.boundingBox())!.y).toBe(before!.y);
});

test('an account mutation failure stays attached to its account after navigating elsewhere', async ({ page }) => {
  await fixture(page); await page.locator('[data-account="entry-1"]').click();
  await page.getByRole('switch', { name: 'Enabled', exact: true }).click();
  await page.getByRole('button', { name: '← Back', exact: true }).click(); await page.locator('[data-account="entry-2"]').click();
  await page.evaluate(() => { const host = window as any; host.toggleOutcome = 'error'; host.resolveToggle(); });
  await expect(page.locator('#notice')).not.toContainText('rejected');
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '← Back', exact: true }).click(); await page.locator('[data-account="entry-1"]').click();
  await expect(page.locator('#notice')).toContainText('Refresh to check');
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toBeDisabled();
});

test('unavailable quota stays N/A through held reads without changing layout or known zero', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const host = window as any; host.holdDetails = true;
    host.patchAccount('entry-1', { windows: [{ label: 'Weekly', usedPercent: null, observedAt: null, resetAt: null }] });
    host.patchAccount('entry-2', { windows: [{ label: 'Weekly', usedPercent: 0, observedAt: Date.now(), resetAt: null }] });
  });
  const row = page.locator('[data-account="entry-1"]');
  await expect(row.getByText('N/A', { exact: true })).toBeVisible();
  await expect(page.locator('[data-account="entry-2"]')).toContainText('0% used');
  await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  await expect(row.getByText('N/A', { exact: true })).toBeVisible();
  await row.click();
  const window = page.locator('.detail .window');
  await expect(window.getByText('N/A', { exact: true })).toBeVisible();
  const before = await window.boundingBox();
  await page.evaluate(() => (window as any).releaseDetails());
  await expect(window.getByText('N/A', { exact: true })).toBeVisible();
  expect(await window.boundingBox()).toEqual(before);
  await expect(page.locator('.detail')).not.toContainText(/No usage data|Checking usage/);
});
