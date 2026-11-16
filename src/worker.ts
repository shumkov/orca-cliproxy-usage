import type { JsonValue, OrcaWorkerApi, PanelRequestContext } from 'orca/worker';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { Controller } from './service.ts';
import type { Target } from './service.ts';
import { parseProfiles, runCollector } from './transport.ts';
import { summary } from './summary.ts';
import type { Profile, Store } from './types.ts';
import { assertJson, toJson } from './json.mjs';

const CLI = '/Applications/Orca.app/Contents/Resources/bin/orca';
let cleanup: (() => void) | undefined;
type CliOperation = 'inspect' | 'list' | 'open';

function params(input: unknown): Record<string, JsonValue> {
  assertJson(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Request input must be an object');
  return input;
}
function target(input: unknown): Target {
  const value = params(input);
  const { profileId, revision, snapshotId, key } = value;
  if (typeof profileId !== 'string' || typeof revision !== 'string' || typeof snapshotId !== 'string' || typeof key !== 'string') {
    throw new Error('Request requires a host, revision, snapshot, and account key');
  }
  return { profileId, revision, snapshotId, key };
}

export default async function activate(orca: OrcaWorkerApi) {
  const store: Store = {
    get: key => orca.storage.get(key),
    set: async (key, value) => { await orca.storage.set(key, toJson(value)); },
  };
  let profiles: Profile[] = [];
  let error: string | undefined;
  try { profiles = parseProfiles(await orca.settings.get('profiles')); }
  catch (caught) { error = caught instanceof Error ? caught.message : 'Invalid connection profiles'; }
  const controller = new Controller(profiles, store, runCollector, message => orca.log(message));
  controller.configurationError = error;
  await controller.initialize();
  let updateTail = Promise.resolve();
  const update = () => {
    updateTail = updateTail.then(async () => {
      const view = controller.view();
      const host = view.profiles.find(p => p.id === view.selectedHost)?.label ?? 'No host selected';
      for (const provider of ['codex', 'claude']) {
        try {
          const status = summary(provider, view.snapshot, view.preferences, host);
          const item = { id: provider, ...status };
          assertJson(item);
          await orca.host.call('statusBar.update', item);
        } catch { orca.log(`Could not update CLIProxy Usage ${provider} status`); }
      }
      orca.panels.post('usage.changed', toJson({ version: view.version }));
    }).catch(() => { orca.log('Could not publish CLIProxy Usage state'); });
  };
  const unsubscribe = controller.onChange(update);
  const handle = (name: string, action: (input: JsonValue | undefined, context: PanelRequestContext) => unknown) => {
    orca.panels.handle(name, async (input, context) => {
      assertJson(input ?? null);
      return toJson(await action(input, context));
    });
  };
  handle('usage.state', () => controller.view());
  handle('usage.selectHost', input => controller.select(params(input).id));
  handle('usage.refresh', () => controller.refresh(true));
  handle('usage.details', (input, { signal }) => controller.details(target(input), signal));
  handle('usage.toggle', (input, { signal }) => {
    const { disabled } = params(input);
    if (typeof disabled !== 'boolean') throw new Error('Enabled must be a boolean');
    return controller.toggle({ ...target(input), disabled }, signal);
  });
  handle('usage.mode', input => controller.setMode(params(input).mode));
  handle('usage.retryAuthentication', input => controller.retryAuthentication(params(input).revision));
  handle('usage.reconcile', input => controller.reconcile(params(input).revision));
  orca.commands.register('usage.open', async () => {
    orca.log('CLIProxy Usage open: started');
    let stage = 'identity';
    let operation: CliOperation = 'inspect';
    try {
      const root = fileURLToPath(new URL('../', import.meta.url));
      const inspect = await cliJson(['plugin', 'inspect', root]);
      if (inspect?.valid !== true || inspect.kind !== 'plugin' || inspect.plugin?.pluginKey !== 'local.cliproxy-usage'
        || typeof inspect.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(inspect.contentHash)) throw new Error();
      operation = 'list';
      const list = await cliJson(['plugin', 'list']);
      if (!Array.isArray(list?.plugins)) throw new Error();
      const matches = list.plugins.filter((plugin: any) => typeof plugin?.pluginKey === 'string'
        && /^[a-z0-9][a-z0-9-]*\.cliproxy-usage$/.test(plugin.pluginKey) && plugin.source?.contentHash === inspect.contentHash);
      const local = matches.filter((plugin: any) => plugin.source?.kind === 'local-path'
        && typeof plugin.source.reference === 'string' && resolvePath(plugin.source.reference) === resolvePath(root));
      const candidates = local.length ? local : matches;
      if (candidates.length !== 1) throw new Error();
      const key = candidates[0].pluginKey;
      stage = 'response';
      operation = 'open';
      const opened = await cliJson(['plugin', 'open', key, '--panel', 'usage']);
      if (opened?.kind !== 'panel' || opened.pluginKey !== key || opened.panelId !== 'usage') throw new Error();
      orca.log('CLIProxy Usage open: succeeded');
      return 'CLIProxy Usage opened';
    } catch (error) {
      orca.log(`CLIProxy Usage open: failed stage=${error instanceof CliFailure ? error.stage : stage} operation=${error instanceof CliFailure ? error.operation : operation}`);
      throw new Error('Could not open CLIProxy Usage panel');
    }
  });
  const settingsUnsubscribe = orca.settings.onDidChange(async ({ key }) => {
    if (key !== 'profiles') return;
    try { controller.replaceProfiles(parseProfiles(await orca.settings.get('profiles'))); }
    catch (error) { controller.replaceProfiles([], error instanceof Error ? error.message : 'Invalid profiles'); }
  });
  const timer = setInterval(() => { void controller.refresh(); update(); }, 45000);
  timer.unref();
  cleanup = () => { clearInterval(timer); unsubscribe(); settingsUnsubscribe.dispose(); controller.dispose(); };
  update();
  // A new install waits for explicit host selection. Restarts resume only that host.
  if (controller.view().selectedHost) void controller.refresh();
}

export function deactivate() { cleanup?.(); cleanup = undefined; }

class CliFailure extends Error {
  constructor(readonly stage: string, readonly operation: CliOperation) { super('Orca CLI request failed'); }
}

function cliJson(args: ['plugin', CliOperation, ...string[]]): Promise<any> {
  const env = { ...process.env };
  delete env.ORCA_ENVIRONMENT;
  delete env.ORCA_ENVIRONMENT_ID;
  delete env.ORCA_PAIRING_CODE;
  return new Promise((resolve, reject) => {
    execFile(CLI, [...args, ...(args[1] === 'inspect' ? [] : ['--environment', 'local']), '--json'], { env, timeout: 10000, maxBuffer: 65536 }, (error, stdout) => {
      if (error) {
        const stage = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit'
          : error.killed || error.code === 'ETIMEDOUT' ? 'timeout' : typeof error.code === 'number' || error.signal ? 'exit' : 'spawn';
        reject(new CliFailure(stage, args[1])); return;
      }
      try {
        const response = JSON.parse(stdout);
        if (response?.ok !== true) throw new Error();
        resolve(response.result);
      } catch { reject(new CliFailure('response', args[1])); }
    });
  });
}
