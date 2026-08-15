import { describe, it, expect } from "vitest";
import {
  augmentModelsWithCapacityAdapter,
  getHardCapabilities,
  modelMeetsCapabilities,
} from "../../open-sse/services/capacityAdapter.js";

const VISION = new Set(["vision"]);
const SETTINGS = {
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: ["kiro/claude-sonnet-4.6"] },
  },
};

describe("getHardCapabilities", () => {
  it("keeps input modalities, drops soft caps like search", () => {
    expect(getHardCapabilities(new Set(["vision", "search", "pdf"]))).toEqual(["vision", "pdf"]);
    expect(getHardCapabilities(new Set())).toEqual([]);
    expect(getHardCapabilities(null)).toEqual([]);
  });
});

describe("modelMeetsCapabilities", () => {
  it("resolves vision by provider/model", () => {
    expect(modelMeetsCapabilities("kiro/claude-sonnet-4.6", ["vision"])).toBe(true);
    expect(modelMeetsCapabilities("deepseek/deepseek-chat", ["vision"])).toBe(false);
  });
});

describe("augmentModelsWithCapacityAdapter opts", () => {
  it("checkModels: raw string that pattern-matches vision no longer masks a text-only resolved model", () => {
    // Raw "gpt-5-custom" matches the *gpt-5* vision pattern, but it resolves to
    // deepseek-chat (text-only) — the resolved check must win.
    const out = augmentModelsWithCapacityAdapter(["gpt-5-custom"], VISION, SETTINGS, {
      checkModels: ["deepseek/deepseek-chat"],
    });
    expect(out).toEqual(["kiro/claude-sonnet-4.6", "gpt-5-custom"]);
  });

  it("checkModels: alias judged by its resolved vision-capable target is left alone", () => {
    // Raw "my-alias" matches no capability pattern (would engage the adapter),
    // but it resolves to a vision model — no adapter needed.
    const out = augmentModelsWithCapacityAdapter(["my-alias"], VISION, SETTINGS, {
      checkModels: ["kiro/claude-sonnet-4.6"],
    });
    expect(out).toEqual(["my-alias"]);
  });

  it("poolOverride: empty override (all pool models credential-filtered) disables the adapter", () => {
    const out = augmentModelsWithCapacityAdapter(["deepseek/deepseek-chat"], VISION, SETTINGS, {
      poolOverride: [],
    });
    expect(out).toEqual(["deepseek/deepseek-chat"]);
  });

  it("poolOverride: usable pool model is prepended ahead of the incapable target", () => {
    const out = augmentModelsWithCapacityAdapter(["deepseek/deepseek-chat"], VISION, SETTINGS, {
      poolOverride: ["codex/gpt-5.6-sol"],
    });
    expect(out).toEqual(["codex/gpt-5.6-sol", "deepseek/deepseek-chat"]);
  });

  it("poolOverride: entries that do not satisfy the required capability are still excluded", () => {
    const out = augmentModelsWithCapacityAdapter(["deepseek/deepseek-chat"], VISION, SETTINGS, {
      poolOverride: ["deepseek/deepseek-reasoner"], // text-only
    });
    expect(out).toEqual(["deepseek/deepseek-chat"]);
  });

  it("without opts: behaves as before (settings pool, raw-string check)", () => {
    const out = augmentModelsWithCapacityAdapter(["deepseek/deepseek-chat"], VISION, SETTINGS);
    expect(out).toEqual(["kiro/claude-sonnet-4.6", "deepseek/deepseek-chat"]);
  });
});
