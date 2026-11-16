export interface Profile {
  id: string; label: string; transport: 'local' | 'ssh'; configPath: string;
  baseUrl: string; target?: string; secretPath?: string; revision: string;
}
export interface Identity { name: string | null; authIndex: string | null }
export interface Window {
  id?: string;
  label: string; usedPercent: number | null; resetAt: number | null; observedAt: number | null;
  minutes?: number | null; model?: string | null;
}
export interface Credits { balance: number | null; unlimited: boolean }
export interface Rich {
  windows: Window[]; plan?: string | null; credits?: Credits | null;
  resetEntitlements?: { available: number | null; applicable: number | null; expiresAt: (number | null)[] } | null;
  subscriptionUntil?: number | null; observedAt: number; error?: string; retryAt?: number | null;
}
export interface Account {
  key: string; identity: Identity; provider: string; email: string; name: string | null;
  status: string; disabled: boolean | null; available: boolean; requiresSignIn: boolean;
  quotaBlocked: boolean; unavailable: boolean; priority: number | null;
  windows: Window[]; modelWindows: Window[]; plan: string | null; credits: Credits | null;
  cooldowns: { scope: string; model: string | null; reason: string | null; retryAt: number | null; httpStatus: number | null }[];
  recent: { label: string | null; success: number | null; failed: number | null }[];
  rich?: Rich; mutation?: 'pending' | 'unconfirmed'; mutationDisabled?: boolean; mutationError?: string;
}
export interface CollectorResult {
  accounts?: Account[]; observedAt?: number; rich?: Rich;
  mutation?: 'confirmed' | 'not_applied' | 'unconfirmed';
  error?: string; code?: string; authRejected?: boolean; retryAt?: number;
}
export interface CollectorRequest {
  profile: Profile; operation: 'read' | 'rich' | 'toggle'; identity?: Identity; disabled?: boolean;
}
export type Transport = (request: CollectorRequest, signal?: AbortSignal) => Promise<CollectorResult>;
export interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}
export interface Snapshot {
  profileId: string; revision: string; snapshotId: string; accounts: Account[];
  readState: 'idle' | 'loading' | 'settled'; loadingDetails: string[];
  observedAt: number | null; error?: string; rejected: boolean; pending: number; fresh: boolean;
}
export interface Preferences {
  mode: 'compact' | 'detailed';
}
export interface View {
  version: number;
  profiles: { id: string; label: string; revision: string }[];
  selectedHost: string | null; snapshot: Snapshot | null; preferences: Preferences; configurationError?: string;
  unresolved: { revision: string; label: string; count: number }[];
}
