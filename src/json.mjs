function copy(value, omitUndefined, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Bridge value must be plain JSON');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) {
    throw new TypeError('Bridge value must be plain JSON');
  }
  const keys = Object.keys(value);
  if (Object.getOwnPropertyNames(value).length !== keys.length + (array ? 1 : 0) ||
      (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index))))) {
    throw new TypeError('Bridge value must be plain JSON');
  }
  ancestors.add(value);
  try {
    const result = array ? [] : {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new TypeError('Bridge value must be plain JSON');
      if (!array && omitUndefined && descriptor.value === undefined) continue;
      Object.defineProperty(result, key, { value: copy(descriptor.value, omitUndefined, ancestors), enumerable: true, writable: true, configurable: true });
    }
    return result;
  } finally { ancestors.delete(value); }
}

// Optional object properties are absent on the wire; array entries must be explicit JSON.
export function toJson(value) { return copy(value, true, new Set()); }
export function assertJson(value) { copy(value, false, new Set()); }
