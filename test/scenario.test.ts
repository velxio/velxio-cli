import { describe, expect, test } from 'bun:test';
import { appendFlagSteps, EMPTY_PLAN, normalizeScenario, parseDuration, parseScenarioText } from '../src/scenario/scenario.ts';
import { CliError } from '../src/errors.ts';

const parts = new Set(['uno', 'led1', 'btn1', 'oled1', 'dht1']);

describe('durations', () => {
  test('units ms, s, us and decimals; bare numbers are ms', () => {
    expect(parseDuration('500ms')).toBe(500_000);
    expect(parseDuration('2s')).toBe(2_000_000);
    expect(parseDuration('100us')).toBe(100);
    expect(parseDuration('1.5s')).toBe(1_500_000);
    expect(parseDuration(' 250 ms ')).toBe(250_000);
    expect(parseDuration(3)).toBe(3000);
  });

  test('rejects garbage and negatives', () => {
    expect(() => parseDuration('soon')).toThrow(/cannot parse duration/);
    expect(() => parseDuration('5min')).toThrow(/cannot parse duration/);
    expect(() => parseDuration(-1)).toThrow(/non-negative/);
    expect(() => parseDuration(null)).toThrow(/must be a string/);
  });
});

describe('normalisation', () => {
  test('every Wokwi step kind maps to a PlanStep', () => {
    const plan = parseScenarioText(
      `
name: full
version: 1
steps:
  - wait-serial: "READY"
  - delay: 500ms
  - write-serial: "hi\\n"
  - write-serial: [1, 2, 255]
  - expect-pin:
      part-id: led1
      pin: A
      value: high
  - expect-pin:
      part-id: uno
      pin: 13
      expected: 0
  - set-control:
      part-id: btn1
      control: pressed
      value: 1
  - set-control:
      part-id: dht1
      control: temperature
      value: 31.5
  - take-screenshot:
      part-id: oled1
      save-to: shots/oled.png
  - name: named step
    wait-serial: 42
`,
      { partIds: parts },
    );
    expect(plan.name).toBe('full');
    expect(plan.steps).toEqual([
      { kind: 'wait-serial', text: 'READY' },
      { kind: 'delay', us: 500_000 },
      { kind: 'write-serial', data_b64: Buffer.from('hi\n').toString('base64') },
      { kind: 'write-serial', data_b64: Buffer.from([1, 2, 255]).toString('base64') },
      { kind: 'expect-pin', part_id: 'led1', pin: 'A', expected: 1 },
      { kind: 'expect-pin', part_id: 'uno', pin: '13', expected: 0 },
      { kind: 'set-control', part_id: 'btn1', control: 'pressed', value: 1 },
      { kind: 'set-control', part_id: 'dht1', control: 'temperature', value: 31.5 },
      { kind: 'take-screenshot', part_id: 'oled1', name: 'shot-8.png', compare_blob: null, tolerance_pct: 0.5 },
      { kind: 'wait-serial', text: '42' },
    ]);
    expect(plan.screenshots).toEqual([{ index: 8, name: 'shot-8.png', partId: 'oled1', saveTo: 'shots/oled.png', compareWith: null, compareBlob: null }]);
  });

  test('compare-with gets a blob name and a tolerance', () => {
    const plan = normalizeScenario({ steps: [{ 'take-screenshot': { 'part-id': 'oled1', 'compare-with': 'golden.png', tolerance: 2 } }] }, { partIds: parts });
    expect(plan.steps[0]).toEqual({ kind: 'take-screenshot', part_id: 'oled1', name: 'shot-0.png', compare_blob: 'cmp-0', tolerance_pct: 2 });
    expect(plan.screenshots[0]?.compareBlob).toBe('cmp-0');
  });

  test('errors: unknown kind, touch, missing part, bad level, two keys, limits', () => {
    const err = (doc: unknown): CliError => {
      try {
        normalizeScenario(doc, { partIds: parts });
      } catch (e) {
        return e as CliError;
      }
      throw new Error('did not throw');
    };
    expect(err({ steps: [{ 'wait-pin': 'x' }] }).message).toMatch(/unknown step "wait-pin"/);
    expect(err({ steps: [{ touch: { 'part-id': 'oled1', x: 1, y: 2 } }] }).message).toMatch(/touch steps arrive in phase 3/);
    expect(err({ steps: [{ 'expect-pin': { 'part-id': 'nope', pin: 'A', value: 1 } }] }).message).toMatch(/part "nope" is not in the diagram/);
    expect(err({ steps: [{ 'expect-pin': { 'part-id': 'led1', pin: 'A', value: 'maybe' } }] }).message).toMatch(/expected 0\/1/);
    expect(err({ steps: [{ delay: '1s', 'wait-serial': 'x' }] }).message).toMatch(/exactly one step key/);
    expect(err({ steps: [{ 'write-serial': [300] }] }).message).toMatch(/0\.\.255/);
    expect(err({ steps: [{ 'take-screenshot': { 'part-id': 'oled1' } }] }).message).toMatch(/save-to and\/or compare-with/);
    expect(err({ steps: [{ 'wait-serial': 'x'.repeat(513) }] }).message).toMatch(/exceeds 512 bytes/);
    expect(err({ steps: Array.from({ length: 201 }, () => ({ delay: '1ms' })) }).message).toMatch(/201 steps exceeds/);
    expect(err({ steps: Array.from({ length: 21 }, () => ({ 'take-screenshot': { 'part-id': 'oled1', 'save-to': 'a.png' } })) }).message).toMatch(/more than 20 screenshots/);
    expect(err({ version: 2, steps: [] }).message).toMatch(/version must be 1/);
    expect(err({ steps: 'nope' }).message).toMatch(/steps must be a list/);
    expect(err({ steps: [{ 'set-control': { 'part-id': 'btn1', control: 'pressed', value: [1] } }] }).message).toMatch(/number, string or boolean/);
    for (const e of [err({ steps: [{ 'wait-pin': 'x' }] })]) {
      expect(e.exitCode).toBe(2);
      expect(e.code).toBe('scenario_invalid');
    }
  });

  test('invalid YAML is scenario_invalid', () => {
    expect(() => parseScenarioText('steps: [\n  - :')).toThrow(CliError);
  });

  test('flags append: screenshot then expect-text', () => {
    const plan = appendFlagSteps(EMPTY_PLAN, { expectText: 'DONE', screenshotPart: 'oled1', screenshotTime: 1500, screenshotFile: 'out.png' }, parts);
    expect(plan.steps).toEqual([
      { kind: 'delay', us: 1_500_000 },
      { kind: 'take-screenshot', part_id: 'oled1', name: 'shot-1.png', compare_blob: null, tolerance_pct: 0.5 },
      { kind: 'wait-serial', text: 'DONE' },
    ]);
    expect(plan.screenshots[0]?.saveTo).toBe('out.png');
    expect(() => appendFlagSteps(EMPTY_PLAN, { screenshotPart: 'ghost' }, parts)).toThrow(/not in the diagram/);
    expect(() => appendFlagSteps(EMPTY_PLAN, { expectText: '' })).toThrow(/must not be empty/);
  });
});
