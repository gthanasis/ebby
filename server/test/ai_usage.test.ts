// What a Claude call costs, and whose key pays: the allowance on the owner's key, or your own with no limit.
import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { ASSISTANT_MODELS } from "../src/core/constants.js";
import { BudgetExceeded, chooseKey, costUsd, NoAPIKey, PRICES } from "../src/domain/ai_usage.js";
import { PyDate } from "../src/py.js";

const today = new PyDate(2026, 10, 20);

describe("costs", () => {
  it("every model the app can use has a price", () => {
    for (const m of [config.ANTHROPIC_MODEL, config.ASSISTANT_MODEL, ...Object.values(ASSISTANT_MODELS)]) expect(PRICES[m]).toBeDefined();
  });
  it("counts every kind of token", () => {
    expect(costUsd("claude-opus-5-5", { input_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6, output_tokens: 1e6 }))
      .toBeCloseTo(4 + 5 + 0.2 + 20);
  });
  it("treats missing fields as zero", () => expect(costUsd("claude-haiku-5-5", { input_tokens: null, output_tokens: 2e6 })).toBeCloseTo(1));
  it("charges a long Haiku prompt the higher rate", () => expect(costUsd("claude-haiku-5-5", { input_tokens: 150_000 })).toBeCloseTo(0.075));
  it("charges an unknown model the top price", () => expect(costUsd("claude-someday", { output_tokens: 1e6 })).toBeCloseTo(20));
});

describe("whose key", () => {
  const base = { ownKey: null, sharedKey: "shared", isAdmin: false, spent: 1, budget: 2, today };
  it("your own key goes past an exceeded allowance", () => expect(chooseKey({ ...base, ownKey: "mine", spent: 9 })).toEqual(["mine", true]));
  it("your own key works without the owner's", () => expect(chooseKey({ ...base, ownKey: "mine", sharedKey: "" })).toEqual(["mine", true]));
  it("the admin has no limit", () => expect(chooseKey({ ...base, isAdmin: true, spent: 99 })).toEqual(["shared", false]));
  it("under the allowance uses the owner's key", () => expect(chooseKey(base)).toEqual(["shared", false]));
  it("at the allowance stops, and says when it resets", () => {
    expect(() => chooseKey({ ...base, spent: 2 })).toThrow(BudgetExceeded);
    expect(() => chooseKey({ ...base, spent: 2 })).toThrow("resets on 1 November");
    expect(() => chooseKey({ ...base, spent: 2, today: new PyDate(2026, 12, 9) })).toThrow("resets on 1 January");
  });
  it("no key anywhere says to add one", () => expect(() => chooseKey({ ...base, sharedKey: "" })).toThrow(NoAPIKey));
});
