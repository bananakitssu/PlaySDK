export interface PlaySDKOptions {
  /** Play OAuth access token for the current player and game. */
  accessToken: string;
  /** Defaults to https://banana-datacenter.vercel.app/play-api. */
  apiBaseUrl?: string;
  /** Useful for tests and custom compatible deployments. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface PlayerProfile {
  userId?: string;
  username: string;
  status?: "online" | "offline" | string;
  statusText?: string;
  playing?: boolean;
  statusExpiresAt?: number | null;
  [key: string]: unknown;
}

export interface SavedDataResult<T = unknown> {
  key: string;
  value: T | null;
  updatedAt: number | null;
}

export interface SaveDataResult {
  ok: true;
  key: string;
  updatedAt: number;
  usedBytes: number;
  quotaBytes: number;
  keys: number;
}

export interface DeleteDataResult {
  ok: true;
  key: string;
  deleted: boolean;
}

export interface GameAchievement {
  achievementId: string;
  title: string;
  description: string;
  xp: number;
  unlocked: boolean;
  unlockedAt: number | null;
}

export interface GameAchievementListResult {
  slug: string;
  achievements: GameAchievement[];
}

export interface ClaimedAchievement {
  achievementId: string;
  title: string;
  description?: string;
  xp: number;
  unlockedAt: number;
}

export interface ClaimAchievementResult {
  ok: true;
  claimed: boolean;
  alreadyUnlocked?: boolean;
  achievement: ClaimedAchievement;
}

export interface ActivityResult {
  ok: true;
  statusText: string;
  expiresAt: number;
  ttlSeconds: number;
}

export interface ActivityOptions {
  /** Presence TTL accepted by Banana Play is 30–180 seconds. Defaults to 120. */
  ttlSeconds?: number;
  /** Must be shorter than the TTL. Defaults to half the TTL. */
  refreshEveryMs?: number;
  /** Called if a background activity refresh fails. */
  onError?: (error: unknown) => void;
}

export interface ActivityLease {
  readonly lastError: unknown | null;
  /** Change the visible status and continue refreshing it. */
  update(statusText: string): Promise<ActivityResult>;
  /** Stop refreshing and restore the profile status to Online. Safe to call repeatedly. */
  stop(): Promise<void>;
}
