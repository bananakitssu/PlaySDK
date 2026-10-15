import type {
  ActivityLease,
  ActivityOptions,
  ActivityResult,
  DeleteDataResult,
  GameAchievement,
  GameAchievementListResult,
  ClaimAchievementResult,
  PlaySDKOptions,
  PlayerProfile,
  SavedDataResult,
  SaveDataResult,
} from "./types.js";

export type {
  ActivityLease,
  ActivityOptions,
  ActivityResult,
  DeleteDataResult,
  PlaySDKOptions,
  PlayerProfile,
  SavedDataResult,
  SaveDataResult,
} from "./types.js";
export { RServer, type RServerOptions, type RServerPeer, type RServerPacket } from "./rserver.js";

const DEFAULT_API_BASE_URL = "https://banana-datacenter.vercel.app/play-api";
const KEY_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_ACTIVITY_LENGTH = 80;

interface APIErrorBody {
  error?: string;
  error_description?: string;
  retryAfter?: number;
  [key: string]: unknown;
}

export class PlayAPIError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  readonly details: APIErrorBody | null;

  constructor(status: number, body: APIErrorBody | null, retryAfterHeader: string | null) {
    const code = typeof body?.error === "string" ? body.error : null;
    const description = typeof body?.error_description === "string" ? body.error_description : null;
    super(description || code || `Banana Play API request failed with HTTP ${status}`);
    this.name = "PlayAPIError";
    this.status = status;
    this.code = code;
    const headerValue = Number(retryAfterHeader);
    this.retryAfterSeconds = Number.isFinite(headerValue) && headerValue > 0
      ? headerValue
      : typeof body?.retryAfter === "number" && body.retryAfter > 0
        ? body.retryAfter
        : null;
    this.details = body;
  }
}

function validateKey(key: string): void {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new TypeError("Saved-data keys must be 1–128 characters and contain only letters, numbers, '.', '_', ':', or '-'.");
  }
}

function normalizeActivity(statusText: string): string {
  if (typeof statusText !== "string") throw new TypeError("Activity must be a string.");
  const normalized = statusText.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!normalized) throw new TypeError("Activity cannot be empty.");
  if (normalized.length > MAX_ACTIVITY_LENGTH) {
    throw new RangeError(`Activity must be at most ${MAX_ACTIVITY_LENGTH} characters.`);
  }
  return normalized;
}

function validateGameSlug(gameSlug: string): string {
  const slug = typeof gameSlug === "string" ? gameSlug.trim().toLowerCase() : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/.test(slug)) {
    throw new TypeError("A valid Banana Play game slug is required.");
  }
  return slug;
}

function validateAchievementId(achievementId: string): string {
  const id = typeof achievementId === "string" ? achievementId.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new TypeError("Achievement IDs must be 1–64 lowercase letters, numbers, underscores, or hyphens.");
  }
  return id;
}

function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") {
    throw new TypeError("Saved data must be JSON-serializable.");
  }
  return new TextEncoder().encode(serialized).byteLength;
}

/**
 * Client for Banana Play's existing Play OAuth API.
 *
 * Required OAuth scopes:
 * - play:data:read for getSavedData()
 * - play:data:write for saveData()/deleteSavedData()
 * - play:profile:read for getProfile()
 * - play:presence:write for setActivity()/clearActivity()/startActivity()
 * - play:achievements:write for getAchievements()/claimAchievement()
 */
export class PlaySDK {
  private readonly accessToken: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PlaySDKOptions) {
    const token = options.accessToken?.trim();
    if (!token) throw new TypeError("A Banana Play OAuth access token is required.");
    this.accessToken = token;
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.apiBaseUrl)) {
      throw new TypeError("apiBaseUrl must be an absolute HTTP(S) URL.");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    if (typeof this.fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.accessToken}`);
    headers.set("accept", "application/json");
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const errorBody = body && typeof body === "object"
        ? body as APIErrorBody
        : null;
      throw new PlayAPIError(response.status, errorBody, response.headers.get("retry-after"));
    }

    return body as T;
  }

  /**
   * Read the achievement definitions for a game, including which achievements this player has
   * already unlocked. The Play OAuth app must belong to that game's publisher.
   */
  async getAchievements(gameSlug: string): Promise<GameAchievement[]> {
    const slug = validateGameSlug(gameSlug);
    const result = await this.request<GameAchievementListResult>(`/achievements?slug=${encodeURIComponent(slug)}`);
    return result.achievements;
  }

  /**
   * Claim a developer-defined achievement for the current player. Claims are idempotent: a
   * repeat claim returns alreadyUnlocked=true and does not award the XP again.
   */
  async claimAchievement(gameSlug: string, achievementId: string): Promise<ClaimAchievementResult> {
    const slug = validateGameSlug(gameSlug);
    const id = validateAchievementId(achievementId);
    return this.request<ClaimAchievementResult>("/achievements", {
      method: "POST",
      body: JSON.stringify({ slug, achievementId: id }),
    });
  }

  /** Read the player's own profile, or an accepted friend's profile by user ID. */
  async getProfile(userId?: string): Promise<PlayerProfile> {
    const query = userId ? `?userId=${encodeURIComponent(userId)}` : "";
    const result = await this.request<{ profile: PlayerProfile }>(`/profile${query}`);
    return result.profile;
  }

  /** Retrieve a saved value and its last-updated timestamp. Missing keys return value=null. */
  async getSavedData<T = unknown>(key: string): Promise<SavedDataResult<T>> {
    validateKey(key);
    const result = await this.request<SavedDataResult<T>>(`/data?key=${encodeURIComponent(key)}`);
    return result;
  }

  /** Save JSON data for this player and this Play OAuth client. */
  async saveData(key: string, value: unknown): Promise<SaveDataResult> {
    validateKey(key);
    const size = jsonByteLength(value);
    if (size > MAX_VALUE_BYTES) {
      throw new RangeError(`Saved value is ${size} bytes; Banana Play allows at most ${MAX_VALUE_BYTES} bytes per value.`);
    }
    return this.request<SaveDataResult>("/data", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    });
  }

  /** Convenience alias that returns only the value (or null if the key does not exist). */
  async loadData<T = unknown>(key: string): Promise<T | null> {
    return (await this.getSavedData<T>(key)).value;
  }

  /** Delete one saved value belonging to this player and game. */
  async deleteSavedData(key: string): Promise<DeleteDataResult> {
    validateKey(key);
    return this.request<DeleteDataResult>(`/data?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
  }

  /** Set a temporary game activity. The server limits text to 80 characters and TTL to 30–180 seconds. */
  async setActivity(statusText: string, ttlSeconds = 120): Promise<ActivityResult> {
    const activity = normalizeActivity(statusText);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 180) {
      throw new RangeError("ttlSeconds must be between 30 and 180.");
    }
    return this.request<ActivityResult>("/presence", {
      method: "POST",
      body: JSON.stringify({ statusText: activity, ttlSeconds }),
    });
  }

  /** Clear this game's activity and restore the player's status to Online. */
  async clearActivity(): Promise<{ ok: true; statusText: "Online"; cleared: true }> {
    return this.request("/presence", { method: "DELETE" });
  }

  /**
   * Start an activity heartbeat so the custom status does not expire while the game is active.
   * Call lease.stop() when the player exits the game. Errors from background refreshes are
   * retained on lease.lastError and optionally forwarded to onError.
   */
  async startActivity(
    initialStatusText: string,
    options: ActivityOptions = {},
  ): Promise<ActivityLease> {
    const ttlSeconds = options.ttlSeconds ?? 120;
    const refreshEveryMs = options.refreshEveryMs ?? Math.floor(ttlSeconds * 500);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 180) {
      throw new RangeError("ttlSeconds must be between 30 and 180.");
    }
    if (!Number.isFinite(refreshEveryMs) || refreshEveryMs < 1 || refreshEveryMs >= ttlSeconds * 1000) {
      throw new RangeError("refreshEveryMs must be positive and shorter than the presence TTL.");
    }

    let statusText = normalizeActivity(initialStatusText);
    await this.setActivity(statusText, ttlSeconds);
    let stopped = false;
    let lastError: unknown | null = null;
    let inFlight = Promise.resolve();
    const timer = setInterval(() => {
      if (stopped) return;
      inFlight = this.setActivity(statusText, ttlSeconds)
        .then(() => { lastError = null; })
        .catch((error: unknown) => {
          lastError = error;
          options.onError?.(error);
        });
    }, refreshEveryMs);
    (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();

    return {
      get lastError() { return lastError; },
      update: async (nextStatusText: string) => {
        if (stopped) throw new Error("This activity lease has been stopped.");
        const next = normalizeActivity(nextStatusText);
        statusText = next;
        const result = await this.setActivity(next, ttlSeconds);
        lastError = null;
        return result;
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        await inFlight;
        await this.clearActivity();
      },
    };
  }
}

export const DEFAULT_PLAY_API_BASE_URL = DEFAULT_API_BASE_URL;
