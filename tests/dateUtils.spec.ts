import { describe, it, expect, vi } from "vitest";
import { lastNDays, precedingNDays, daysBetween } from "../src/tools/dateUtils.js";

describe("dateUtils", () => {
  it("lastNDays cobre exatamente N dias até agora", () => {
    const period = lastNDays(30);
    expect(daysBetween(period.from, period.to)).toBe(30);
  });

  it("precedingNDays não se sobrepõe a lastNDays e tem a mesma duração", () => {
    const current = lastNDays(30);
    const previous = precedingNDays(30);
    expect(new Date(previous.to).getTime()).toBeLessThanOrEqual(new Date(current.from).getTime());
    expect(daysBetween(previous.from, previous.to)).toBe(30);
  });
});
