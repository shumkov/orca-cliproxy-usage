import type { JsonValue } from 'orca/host';
export function toJson(value: unknown): JsonValue;
export function assertJson(value: unknown): asserts value is JsonValue;
