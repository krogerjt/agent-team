import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProviderConfig } from "./config.js";

test("defaults to mock without credentials", () => {
  assert.deepEqual(resolveProviderConfig("lead", {}), { provider: "mock" });
});

test("role model overrides provider model", () => {
  assert.deepEqual(resolveProviderConfig("researcher", {
    RESEARCHER_PROVIDER: "openai",
    RESEARCHER_MODEL: "role-model",
    OPENAI_MODEL: "provider-model",
    OPENAI_API_KEY: "test-key",
  }), { provider: "openai", model: "role-model" });
});

test("reports missing model before attempting an API call", () => {
  assert.throws(() => resolveProviderConfig("reviewer", {
    REVIEWER_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "test-key",
  }), /Set REVIEWER_MODEL or ANTHROPIC_MODEL/);
});

test("new personas inherit existing role settings unless overridden", () => {
  const env = { LEAD_PROVIDER: "openai", LEAD_MODEL: "base", OPENAI_API_KEY: "test-key", WREN_MODEL: "design" };
  assert.deepEqual(resolveProviderConfig("kit", env), { provider: "openai", model: "base" });
  assert.deepEqual(resolveProviderConfig("wren", env), { provider: "openai", model: "design" });
});
