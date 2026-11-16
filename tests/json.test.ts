import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertJson, toJson } from '../src/json.mjs';
import { strictJson } from './strict-json.ts';

test('wire conversion omits optional fields and preserves null, zero, false, and hostile keys', () => {
  const input = JSON.parse('{"__proto__":{"safe":true},"constructor":"text"}');
  const result = toJson({ ...input, absent: undefined, nested: { absent: undefined, empty: null, count: 0, enabled: false } });
  strictJson(result);
  assert.deepEqual(result, JSON.parse('{"__proto__":{"safe":true},"constructor":"text","nested":{"empty":null,"count":0,"enabled":false}}'));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.ok(result !== null && typeof result === 'object');
  assert.equal(Object.hasOwn(result, 'absent'), false);
});

test('non-JSON numbers, values, sparse arrays, objects, and cycles fail without coercion', () => {
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const invalid of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('value'), () => null, new Date(), new Map(), new Set(), [undefined], Array(1), cycle, { value: NaN }, { value: () => null }]) {
    assert.throws(() => toJson(invalid), /plain JSON/);
    assert.throws(() => assertJson(invalid), /plain JSON/);
  }
  assert.throws(() => assertJson({ absent: undefined }), /plain JSON/);
});

test('validation never invokes getters or custom serialization', () => {
  let called = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get: () => { called++; return 1; } });
  const serializer = { toJSON: () => { called++; return {}; } };
  for (const value of [getter, serializer, { [Symbol('value')]: true }]) assert.throws(() => toJson(value), /plain JSON/);
  assert.equal(called, 0);
  const shared = { value: 1 };
  assert.deepEqual(toJson([shared, shared]), [{ value: 1 }, { value: 1 }]);
});

test('hidden and array-owned serialization cannot bypass the JSON boundary', () => {
  let called = 0;
  const serialize = () => { called++; return {}; };
  class CustomArray extends Array {}
  const values = [Object.defineProperty({}, 'toJSON', { value: serialize }), Object.assign([], { toJSON: serialize }), new CustomArray(), Object.defineProperty({}, 'hidden', { get: serialize })];
  for (const value of values) {
    assert.throws(() => assertJson(value), /plain JSON/);
    assert.throws(() => toJson(value), /plain JSON/);
  }
  assert.equal(called, 0);
});
