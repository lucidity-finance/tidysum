import { describe, expect, it } from "vitest";
import { normalizePhone } from "../src/users.js";

describe("normalizePhone", () => {
  it("reads US numbers however they're typed", () => {
    for (const typed of [
      "4155550123",
      "(415) 555-0123",
      "415.555.0123",
      "1 415 555 0123",
      "+1 415-555-0123",
    ]) {
      expect(normalizePhone(typed), typed).toBe("+14155550123");
    }
  });

  it("keeps other countries when given their +", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("refuses what Plaid can't use", () => {
    for (const bad of [
      "",
      "12345",
      "555-0123",
      "+1 015 555 0123",
      "call me",
      "+0 123 456 789",
      "41555501234",
    ]) {
      expect(normalizePhone(bad), bad).toBeUndefined();
    }
  });
});
