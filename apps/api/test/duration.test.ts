import { describe, expect, it } from 'vitest';
import { parseDurationMs } from '../src/lib/duration.js';

const D = 86_400_000;
const H = 3_600_000;

describe('parseDurationMs', () => {
  it('parses ISO durations', () => {
    expect(parseDurationMs('P1D')).toBe(D);
    expect(parseDurationMs('P7D')).toBe(7 * D);
    expect(parseDurationMs('P2W')).toBe(14 * D);
    expect(parseDurationMs('PT12H')).toBe(12 * H);
    expect(parseDurationMs('P1DT12H')).toBe(D + 12 * H);
  });

  it('parses short forms', () => {
    expect(parseDurationMs('7d')).toBe(7 * D);
    expect(parseDurationMs('12h')).toBe(12 * H);
    expect(parseDurationMs('2w')).toBe(14 * D);
    expect(parseDurationMs('30D')).toBe(30 * D);
  });

  it('rejects invalid input', () => {
    expect(() => parseDurationMs('')).toThrow();
    expect(() => parseDurationMs('abc')).toThrow();
    expect(() => parseDurationMs('P0D')).toThrow(/non-positive/);
    expect(() => parseDurationMs('PT0H')).toThrow();
    expect(() => parseDurationMs('PXY')).toThrow();
  });
});
