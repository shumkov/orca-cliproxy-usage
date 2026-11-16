import type { Account, Window } from './types.ts';
export function clip(value: string, limit: number): string;
export function accountLabel(account: Account, accounts: Account[], limit?: number): string;
export function displayAccount(accounts: Account[], now?: number): Account | undefined;
export function windowLabel(window: Window): string;
export function humanDate(at: number | null | undefined, now?: number): string | null;

export function observationAge(at: number | null | undefined, now?: number): string | null;
