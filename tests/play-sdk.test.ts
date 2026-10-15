import test from "node:test";
import assert from "node:assert/strict";
import { PlaySDK, PlayAPIError } from "../src/index.js";

function mockedSDK(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new PlaySDK({
    accessToken: "test-token",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return responder(call.url, call.init);
    }) as typeof fetch,
  });
  return { client, calls };
}

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });

test("getSavedData uses bearer auth and reads the existing data response shape", async () => {
  const { client, calls } = mockedSDK(() => jsonResponse({
    key: "world",
    value: { level: 4 },
    updatedAt: 1_800_000_000,
  }));
  const result = await client.getSavedData("world");
  assert.deepEqual(result.value, { level: 4 });
  assert.match(calls[0]!.url, /\/data\?key=world$/);
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), "Bearer test-token");
});

test("saveData posts JSON and rejects oversized values before fetch", async () => {
  const { client, calls } = mockedSDK(() => jsonResponse({
    ok: true, key: "profile", updatedAt: 1, usedBytes: 17, quotaBytes: 1048576, keys: 1,
  }));
  const saved = await client.saveData("profile", { name: "Banana" });
  assert.equal(saved.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { key: "profile", value: { name: "Banana" } });
  await assert.rejects(
    client.saveData("oversized", "x".repeat(65536)),
    RangeError,
  );
  assert.equal(calls.length, 1);
});

test("saved-data key restrictions match the Banana Play API", async () => {
  const { client, calls } = mockedSDK(() => jsonResponse({ key: "ok", value: null, updatedAt: null }));
  await assert.rejects(client.getSavedData("../bad"), TypeError);
  await assert.rejects(client.deleteSavedData(" "), TypeError);
  assert.equal(calls.length, 0);
});

test("activity enforces server TTL and supports the MineJS presence text", async () => {
  const { client, calls } = mockedSDK(() => jsonResponse({
    ok: true, statusText: "MineJS: In the menus", expiresAt: 1_800_000_100, ttlSeconds: 120,
  }));
  const result = await client.setActivity("MineJS: In the menus");
  assert.equal(result.statusText, "MineJS: In the menus");
  assert.equal(JSON.parse(String(calls[0]!.init.body)).ttlSeconds, 120);
  await assert.rejects(client.setActivity("Custom status", 10), RangeError);
});

test("API errors preserve error codes and retry-after", async () => {
  const { client } = mockedSDK(() => jsonResponse({
    error: "game_data_rate_limited",
    error_description: "Try later",
    retryAfter: 60,
  }, 429, { "retry-after": "60" }));
  await assert.rejects(client.saveData("key", 1), (error: unknown) => {
    assert.ok(error instanceof PlayAPIError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "game_data_rate_limited");
    assert.equal(error.retryAfterSeconds, 60);
    return true;
  });
});


test("getAchievements reads developer-defined achievements and player unlock state", async () => {
  const { client, calls } = mockedSDK(() => jsonResponse({
    slug: "my-game",
    achievements: [{
      achievementId: "first-win", title: "First win", description: "Win a match",
      xp: 50, unlocked: false, unlockedAt: null,
    }],
  }));
  const achievements = await client.getAchievements("My-Game");
  assert.equal(achievements[0]?.achievementId, "first-win");
  assert.equal(achievements[0]?.unlocked, false);
  assert.match(calls[0]!.url, /\/achievements\?slug=my-game$/);
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), "Bearer test-token");
});

test("claimAchievement posts a stable ID and safely handles an already-claimed result", async () => {
  const { client, calls } = mockedSDK(() => jsonResponse({
    ok: true, claimed: false, alreadyUnlocked: true,
    achievement: { achievementId: "first-win", title: "First win", xp: 50, unlockedAt: 1_800_000_000 },
  }));
  const result = await client.claimAchievement("my-game", "First-Win");
  assert.equal(result.claimed, false);
  assert.equal(result.alreadyUnlocked, true);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { slug: "my-game", achievementId: "first-win" });
  assert.equal(calls[0]!.init.method, "POST");
  assert.match(calls[0]!.url, /\/achievements$/);
});

test("achievement slug and ID validation reject malformed input before network access", async () => {
  const { client, calls } = mockedSDK(() => jsonResponse({ ok: true, claimed: true }));
  await assert.rejects(client.getAchievements("../bad"), TypeError);
  await assert.rejects(client.claimAchievement("my-game", "../admin"), TypeError);
  assert.equal(calls.length, 0);
});
