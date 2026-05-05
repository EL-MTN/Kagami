import { describe, expect, it } from "vitest";

import { haversineMeters } from "../src/geo";

describe("haversineMeters", () => {
  it("returns 0 for identical points", () => {
    expect(haversineMeters(40.7128, -74.006, 40.7128, -74.006)).toBe(0);
  });

  it("is symmetric in argument order", () => {
    const a = haversineMeters(40.7128, -74.006, 51.5074, -0.1278);
    const b = haversineMeters(51.5074, -0.1278, 40.7128, -74.006);
    expect(a).toBe(b);
  });

  it("computes ~5570 km between New York City and London", () => {
    // Reference: NYC (40.7128, -74.0060) to London (51.5074, -0.1278) ≈ 5570 km.
    const meters = haversineMeters(40.7128, -74.006, 51.5074, -0.1278);
    expect(meters).toBeGreaterThan(5_550_000);
    expect(meters).toBeLessThan(5_590_000);
  });

  it("computes ~111 km for a 1-degree latitude step at the equator", () => {
    // One degree of latitude is ~111 km regardless of longitude.
    const meters = haversineMeters(0, 0, 1, 0);
    expect(meters).toBeGreaterThan(110_000);
    expect(meters).toBeLessThan(112_000);
  });

  it("returns ~half the Earth's circumference between antipodal points", () => {
    // Antipode of (0, 0) is (0, 180); great-circle distance ≈ π·R ≈ 20015 km.
    const meters = haversineMeters(0, 0, 0, 180);
    expect(meters).toBeGreaterThan(20_015_000 - 1);
    expect(meters).toBeLessThan(20_015_087 + 1);
  });

  it("computes ~3-block distance in Manhattan (~250 m)", () => {
    // 40.7580,-73.9855 (Times Square) to 40.7614,-73.9776 (Bryant Park area)
    const meters = haversineMeters(40.758, -73.9855, 40.7614, -73.9776);
    expect(meters).toBeGreaterThan(700);
    expect(meters).toBeLessThan(800);
  });
});
