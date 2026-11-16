import { readFile } from 'node:fs/promises';
import { parseProfiles, runCollector } from '../src/transport.ts';

// Explicit opt-in read probe; never connects to a built-in host list.
const [file, id] = process.argv.slice(2);
if (!file || !id) throw new Error('Usage: node scripts/smoke.ts <profiles.json> <profile-id>');
const profile = parseProfiles(await readFile(file, 'utf8')).find(profile => profile.id === id);
if (!profile) throw new Error('Profile not found');
const snapshot = await runCollector({ profile, operation: 'read' });
console.log(JSON.stringify({ operation: 'read', error: snapshot.error ?? null, authRejected: snapshot.authRejected ?? false,
  credentialEntries: snapshot.accounts?.length ?? null,
  providers: ['codex', 'claude'].map(provider => {
    const entries = snapshot.accounts?.filter(account => account.provider === provider) ?? [];
    return { provider, total: entries.length, available: entries.filter(account => account.available).length };
  }),
}));
