import { describe, it, expect, vi } from "vitest";
import { lastNDays, precedingNDays, daysBetween, toYmd, lastNDaysYmd } from "../src/tools/dateUtils.js";

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

  it("toYmd extrai só a data (YYYY-MM-DD) de um ISO completo", () => {
    expect(toYmd("2026-08-15T13:45:00.000Z")).toBe("2026-08-15");
  });

  it("lastNDaysYmd usa o mesmo período de lastNDays, só que em YYYY-MM-DD", () => {
    const iso = lastNDays(30);
    const ymd = lastNDaysYmd(30);
    expect(ymd.from).toBe(toYmd(iso.from));
    expect(ymd.to).toBe(toYmd(iso.to));
    expect(ymd.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
