import assert from 'node:assert/strict';

// Orca validates handler outputs with Zod's recursive JSON schema before delivery.
export function strictJson(value: unknown, path = '$'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { assert.ok(Number.isFinite(value), `${path}: non-JSON number`); return; }
  assert.ok(typeof value === 'object', `${path}: non-JSON value (${typeof value})`);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) strictJson(value[i], `${path}[${i}]`);
  } else {
    for (const [key, item] of Object.entries(value)) strictJson(item, `${path}.${key}`);
  }
}
