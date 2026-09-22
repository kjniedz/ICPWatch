import { describe, expect, it } from "vitest";
import { inQuietHours, webhookPath } from "../src/telegram";

describe("inQuietHours", () => {
  const at = (utcHour: number) => Math.floor(Date.UTC(2026, 8, 22, utcHour) / 1000);
  it("handles an overnight window in the chat's own offset", () => {
    const c = { tz_offset_h: 2, quiet_from_h: 23, quiet_to_h: 7 };
    expect(inQuietHours(c, at(21))).toBe(true);  // 23:00 local
    expect(inQuietHours(c, at(3))).toBe(true);   // 05:00 local
    expect(inQuietHours(c, at(5))).toBe(false);  // 07:00 local, quiet ends
    expect(inQuietHours(c, at(12))).toBe(false);
  });
  it("handles a daytime window and no window", () => {
    expect(inQuietHours({ tz_offset_h: 0, quiet_from_h: 9, quiet_to_h: 17 }, at(10))).toBe(true);
    expect(inQuietHours({ tz_offset_h: 0, quiet_from_h: 9, quiet_to_h: 17 }, at(18))).toBe(false);
    expect(inQuietHours({ tz_offset_h: 0, quiet_from_h: null, quiet_to_h: null }, at(10))).toBe(false);
  });
});

describe("webhookPath", () => {
  it("is stable, hex, and not the token", async () => {
    const p = await webhookPath("123:abc");
    expect(p).toMatch(/^[0-9a-f]{32}$/);
    expect(await webhookPath("123:abc")).toBe(p);
    expect(await webhookPath("123:abd")).not.toBe(p);
  });
});
