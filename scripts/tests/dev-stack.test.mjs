import assert from "node:assert/strict";
import test from "node:test";
import {
  readEnvOverrides,
  generateSecret,
  readPinnedDigests,
} from "../dev-stack.mjs";

test("readEnvOverrides returns defaults when no env vars are set", () => {
  const overrides = readEnvOverrides();
  assert.strictEqual(overrides.apiPort, 4910);
  assert.strictEqual(overrides.webPort, 4911);
  assert.strictEqual(overrides.postgresPort, 5432);
  assert.strictEqual(overrides.temporalPort, 7233);
  assert.strictEqual(overrides.bindHost, "127.0.0.1");
});

test("readEnvOverrides reads custom port env vars", () => {
  const prevApi = process.env.SPACEAPP_DEV_API_PORT;
  const prevWeb = process.env.SPACEAPP_DEV_WEB_PORT;
  process.env.SPACEAPP_DEV_API_PORT = "14910";
  process.env.SPACEAPP_DEV_WEB_PORT = "14911";
  try {
    const overrides = readEnvOverrides();
    assert.strictEqual(overrides.apiPort, 14910);
    assert.strictEqual(overrides.webPort, 14911);
  } finally {
    if (prevApi === undefined) delete process.env.SPACEAPP_DEV_API_PORT;
    else process.env.SPACEAPP_DEV_API_PORT = prevApi;
    if (prevWeb === undefined) delete process.env.SPACEAPP_DEV_WEB_PORT;
    else process.env.SPACEAPP_DEV_WEB_PORT = prevWeb;
  }
});

test("generateSecret returns an alphanumeric string of requested length", () => {
  const secret = generateSecret(32);
  assert.strictEqual(secret.length, 32);
  assert.match(secret, /^[A-Za-z0-9]+$/);
});

test("generateSecret default length is 32", () => {
  const secret = generateSecret();
  assert.strictEqual(secret.length, 32);
});

test("readPinnedDigests returns pgvector and temporal images", () => {
  const digests = readPinnedDigests();
  assert.ok(digests.postgres, "expected postgres digest");
  assert.ok(digests.temporal, "expected temporal digest");
  assert.match(digests.postgres, /pgvector\/pgvector:.+@sha256:[0-9a-f]+/);
  assert.match(digests.temporal, /temporalio\/auto-setup:.+@sha256:[0-9a-f]+/);
});
