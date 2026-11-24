import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { checkTrafficParams } from '../../src/contracts/traffic.js';
import { buildTraffic, compileTrafficParams } from './build.js';

const PARAMS_FILE = new URL('../../data/traffic/params.yaml', import.meta.url);

/** @typedef {import('../../src/contracts/check.js').UntrustedJson} UntrustedJson Parsed YAML. */

/** @returns {Promise<UntrustedJson>} Fresh parsed copy of the shipped YAML. */
const shipped = async () => parse(await readFile(PARAMS_FILE, 'utf8'));

/** @type {string} */
let dir;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'traffic-build-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('compileTrafficParams', () => {
  it('compiles the shipped parameters to values only', async () => {
    const params = compileTrafficParams(await shipped());
    expect(checkTrafficParams(params)).toEqual([]);
    const text = JSON.stringify(params);
    expect(text).not.toContain('paramBasis');
    expect(text).not.toContain('sources');
    expect(Object.keys(params.classes).sort()).toEqual(['bus', 'car', 'motorbike', 'taxi', 'truck']);
    expect(params.models.motorbike).toMatchObject({ class: 'motorbike', kind: 'motorbike' });
    expect(params.classes.motorbike.reactionMeanS).toBe(0.79);
    expect(params.violations.nearEgoViolationBoost).toBe(1);
    const shares = Object.values(params.personalities).map((p) => p.share);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  /** @type {[string, (doc: UntrustedJson) => void, RegExp][]} */
  const broken = [
    ['a missing class row', (d) => delete d.classes.bus, /classes\.bus: missing class row/],
    ['personality shares not summing to 1', (d) => (d.personalities.normal.share = 0.5), /personalities: shares sum to 0\.9/],
    ['a missing personality', (d) => delete d.personalities.reckless, /personalities\.reckless: missing personality row/],
    ['a number without a basis', (d) => delete d.classes.car.paramBasis.timeGapS, /classes\.car\.timeGapS: missing paramBasis/],
    ['a basis naming an unknown source', (d) => (d.classes.car.paramBasis.minGapM = { sourced: 'nope' }), /unknown source "nope"/],
    ['a basis for no parameter', (d) => (d.motorbike.paramBasis.ghost = 'design'), /motorbike\.paramBasis\.ghost: names no parameter/],
    ['an unknown key', (d) => ((d.behaviour.typo = 1), (d.behaviour.paramBasis.typo = 'design')), /behaviour\.typo: unknown key/],
    ['a probability above 1', (d) => (d.personalities.reckless.violations.redLight = 1.5), /redLight: a probability is at most 1/],
    ['a motorbike model with a car kind', (d) => (d.models.motorbike.kind = 'car'), /models\.motorbike\.kind/],
    ['turn weights not summing to 1', (d) => (d.behaviour.turnWeights.left = 0.5), /behaviour\.turnWeights: shares sum/],
    ['a zero comfortable deceleration', (d) => (d.classes.bus.comfortDecelMps2 = 0), /classes\.bus\.comfortDecelMps2: must be positive/],
    ['a zero body width', (d) => (d.models.car.widthM = 0), /models\.car\.widthM: must be positive/],
    ['a reversed range', (d) => (d.humanFactors.distractionDurationS = [3, 1]), /distractionDurationS: max is below min/],
    ['a view cone wider than a half turn', (d) => (d.viewHalfAngleDeg = 200), /params\.viewHalfAngleDeg: must be at most 180/],
    ['a zero turn speed', (d) => (d.behaviour.minTurnSpeedMps = 0), /behaviour\.minTurnSpeedMps: must be positive/],
    ['a missing long-vehicle length', (d) => (delete d.behaviour.longVehicleM, delete d.behaviour.paramBasis.longVehicleM), /behaviour\.longVehicleM/],
    ['a source without an https url', (d) => (d.sources['tfd-errata'].url = 'ftp://x'), /sources\.tfd-errata/],
  ];
  it.each(broken)('rejects %s', async (_, mutate, pattern) => {
    const doc = await shipped();
    mutate(doc);
    expect(() => compileTrafficParams(doc)).toThrow(pattern);
  });
});

describe('buildTraffic', () => {
  it('writes the compiled JSON', async () => {
    const outFile = path.join(dir, 'out', 'traffic-params.json');
    const { models } = await buildTraffic({ outFile });
    expect(models).toBe(5);
    expect(checkTrafficParams(JSON.parse(await readFile(outFile, 'utf8')))).toEqual([]);
  });

  it('fails with a clear message on an invalid file', async () => {
    const doc = await shipped();
    delete doc.classes.truck;
    doc.personalities.careful.share = 0.3;
    const inFile = path.join(dir, 'bad.yaml');
    await writeFile(inFile, stringify(doc));
    await expect(buildTraffic({ inFile, outFile: path.join(dir, 'never.json') })).rejects.toThrow(
      /2 problem\(s\):[\s\S]*classes\.truck: missing class row[\s\S]*personalities: shares sum to 1\.05/,
    );
  });

  it('reports unreadable and malformed files', async () => {
    await expect(buildTraffic({ inFile: path.join(dir, 'missing.yaml') })).rejects.toThrow(/Cannot read/);
    const inFile = path.join(dir, 'malformed.yaml');
    await writeFile(inFile, 'classes: [unclosed\n');
    await expect(buildTraffic({ inFile })).rejects.toThrow(/Invalid YAML/);
  });
});
