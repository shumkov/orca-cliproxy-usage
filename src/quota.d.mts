import type { Account, Window } from './types.ts';
export function selectWindows(account: Pick<Account, 'rich' | 'windows'>): Window[];
export function selectDisplayWindow(account: Pick<Account, 'rich' | 'windows'>): Window | undefined;
export function isObservationFresh(window: Window | undefined, now?: number): boolean;
