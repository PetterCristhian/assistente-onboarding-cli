import { describe, expect, it } from "vitest";
import { batteryIdFrom, uniqueBatteryId } from "../evals/battery-id.js";

describe("batteryIdFrom", () => {
  it("is the UTC time without milliseconds and colons", () => {
    expect(batteryIdFrom(new Date("2026-11-20T14:30:00.412Z"))).toBe(
      "2026-11-20T14-30-00Z",
    );
  });

  it("uses UTC whatever the offset of the input", () => {
    expect(batteryIdFrom(new Date("2026-11-20T23:59:59-03:00"))).toBe(
      "2026-11-21T02-59-59Z",
    );
  });

  it("is a valid folder name on Windows", () => {
    expect(batteryIdFrom(new Date("2026-01-02T03:04:05.999Z"))).toMatch(
      /^[0-9TZ-]+$/,
    );
  });

  it("refuses an invalid date", () => {
    expect(() => batteryIdFrom(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("refuses a year outside 1000 to 9999, which the id and the schema cannot hold", () => {
    for (const iso of ["0999-12-31T23:59:59Z", "+010000-01-01T00:00:00Z"]) {
      expect(() => batteryIdFrom(new Date(iso))).toThrow(RangeError);
    }
    expect(batteryIdFrom(new Date("1000-01-01T00:00:00Z"))).toBe(
      "1000-01-01T00-00-00Z",
    );
    expect(batteryIdFrom(new Date("9999-12-31T23:59:59Z"))).toBe(
      "9999-12-31T23-59-59Z",
    );
  });
});

describe("uniqueBatteryId", () => {
  const date = new Date("2026-11-20T14:30:00.000Z");

  it("keeps the id when no folder has that name", () => {
    expect(uniqueBatteryId(date, () => false)).toBe("2026-11-20T14-30-00Z");
  });

  it("adds -2, then -3 when the folders exist", () => {
    const taken = new Set(["2026-11-20T14-30-00Z"]);
    expect(uniqueBatteryId(date, (id) => taken.has(id))).toBe(
      "2026-11-20T14-30-00Z-2",
    );
    taken.add("2026-11-20T14-30-00Z-2");
    expect(uniqueBatteryId(date, (id) => taken.has(id))).toBe(
      "2026-11-20T14-30-00Z-3",
    );
  });

  it("gives up when every name is taken", () => {
    expect(() => uniqueBatteryId(date, () => true)).toThrow(
      "Não foi possível escolher um nome livre",
    );
  });
});
