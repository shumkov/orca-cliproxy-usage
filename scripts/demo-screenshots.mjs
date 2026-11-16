import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { fixture } from '../tests/ui/fixture.ts';

const server = spawn(process.execPath, ['scripts/serve-ui.mjs'], { stdio: 'ignore' });
const browser = await chromium.launch({ headless: true });
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch('http://127.0.0.1:4179')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await mkdir('assets', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 350, height: 850 }, deviceScaleFactor: 1, baseURL: 'http://127.0.0.1:4179' });
  await fixture(page);
  await page.evaluate(async () => {
    const host = window; const view = await host.orca.plugin.request('usage.state'); const now = Date.now();
    view.profiles = [{ id: 'local', label: 'Local', revision: 'rev-local' }];
    view.snapshot.accounts = view.snapshot.accounts.slice(0, 5).map((account, i) => ({ ...account,
      key: `demo-${i}`, name: `demo-${i}.json`, identity: { authIndex: `demo-${i}`, name: `demo-${i}.json` },
      email: ['alex@example.test', 'morgan@example.test', 'sam@example.test', 'taylor@example.test', 'casey@example.test'][i],
      provider: i < 2 ? 'codex' : 'claude', plan: i < 2 ? 'Pro' : 'Max', disabled: i === 4, available: i !== 4,
      windows: i === 4 ? [] : [{ label: 'Weekly', usedPercent: [37, 18, 42, 67][i], observedAt: now, resetAt: now + 3 * 86400000 }],
      credits: i === 0 ? { balance: 1250.50, unlimited: false } : null,
    }));
    host.push(view);
  });
  await page.screenshot({ path: 'assets/compact.png' });
  await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  await page.screenshot({ path: 'assets/detailed.png' });
  await page.locator('[data-account="demo-0"]').click();
  await page.screenshot({ path: 'assets/account.png' });
  const gallery = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
  const panels = await Promise.all(['compact', 'detailed', 'account'].map(async name => ({ name, image: (await readFile(`assets/${name}.png`)).toString('base64') })));
  await gallery.setContent(`<style>body{margin:0;background:#121b20;color:#dce8e5;font:20px system-ui}h1{text-align:center;font-size:26px;font-weight:500;margin:24px 0 18px}main{display:flex;justify-content:center;gap:30px}figure{margin:0}figcaption{text-align:center;font-size:15px;color:#9eb7b8;margin-bottom:12px}img{width:350px;border:1px solid #33484d;border-radius:12px;display:block}</style><h1>CLIProxy Usage · synthetic demo</h1><main>${panels.map(({ name, image }) => `<figure><figcaption>${name === 'account' ? 'Account details' : name[0].toUpperCase() + name.slice(1)}</figcaption><img src="data:image/png;base64,${image}" alt="${name} view with fictional accounts"></figure>`).join('')}</main>`);
  await gallery.screenshot({ path: 'assets/gallery.png' });
  const art = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const svg = await readFile('assets/hero.svg', 'utf8');
  await art.setContent(`<style>body{margin:0;background:#101419;display:grid;place-items:center;height:100vh}svg{width:1500px}</style>${svg}`);
  await art.screenshot({ path: 'assets/cover.png' });
  await art.setViewportSize({ width: 256, height: 256 });
  await art.setContent('<style>body{margin:0}</style><svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="#17252b"/><path d="M49 164a79 79 0 0 1 158 0" fill="none" stroke="#344b51" stroke-width="18" stroke-linecap="round"/><path d="M49 164a79 79 0 0 1 74-79" fill="none" stroke="#86e6c3" stroke-width="18" stroke-linecap="round"/><path d="m128 164 38-55" stroke="#eef6f2" stroke-width="10" stroke-linecap="round"/><circle cx="128" cy="164" r="12" fill="#eef6f2"/></svg>');
  await art.screenshot({ path: 'assets/icon.png' });
  console.log('Synthetic Compact, Detailed, account, cover and icon images written to assets/.');
} finally { await browser.close(); server.kill(); }
