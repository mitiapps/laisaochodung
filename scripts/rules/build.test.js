import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countUnverified, validateRules } from '../../src/rules/index.js';
import { buildRules } from './build.js';
import { stableStringify } from './lib/load.js';
import { clone, realBundle, ROOT } from './lib/test-support.js';

/** @typedef {import('../../src/contracts/index.js').RulesBundle} RulesBundle */

/** @type {string} */
let tmp;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'rules-build-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/**
 * Copies only the data directories the rules build reads.
 * @param {string} dest Destination data root.
 */
async function copyRulesData(dest) {
  for (const dir of ['legal', 'rules', 'scoring', 'signs']) {
    await cp(path.join(ROOT, 'data', dir), path.join(dest, dir), { recursive: true });
  }
}

/**
 * Clause ids named in an accident-b quote ("điểm a, điểm b khoản 1; điểm c khoản 2; …").
 * @param {string} quote Quote of D6.10.b or D7.10.b.
 * @param {'D6' | 'D7'} group Group.
 * @returns {string[]} Ids.
 */
function listedClauses(quote, group) {
  const body = quote.slice(quote.indexOf(':') + 1);
  return body.split(';').flatMap((seg) => {
    const k = /khoản (\d+)/u.exec(seg)?.[1];
    return [...seg.matchAll(/điểm ([a-zđ])(?=[,\s])/gu)].map((m) => `${group}.${k}.${m[1]}`);
  });
}

describe('rules build', () => {
  it('writes 18 rules, byte-stable across builds', async () => {
    const out1 = path.join(tmp, 'a.json');
    const out2 = path.join(tmp, 'b.json');
    expect((await buildRules({ outFile: out1 })).rules).toBe(18);
    await buildRules({ outFile: out2 });
    const [a, b] = await Promise.all([readFile(out1, 'utf8'), readFile(out2, 'utf8')]);
    expect(a).toBe(b);
    const bundle = JSON.parse(a);
    expect(bundle.rules.map((/** @type {{id: string}} */ r) => r.id)).toEqual([
      'banned-turn', 'crash', 'crosswalk-yield', 'following-distance', 'give-way', 'headlights', 'high-beam', 'lane-change',
      'night-horn', 'no-entry', 'pavement', 'red-light', 'speeding', 'stop-sign', 'stopping', 'turn-signal', 'wrong-side', 'wrong-way',
    ]);
    expect(a).toBe(stableStringify(JSON.parse(a)));
  });

  it('exits with every problem when a data file is broken', async () => {
    const data = path.join(tmp, 'data');
    await copyRulesData(data);
    const file = path.join(data, 'rules', 'speeding.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('D6.3.a', 'D6.3.zz'));
    await expect(buildRules({ dataDir: data, outFile: path.join(tmp, 'x.json') })).rejects.toThrow(/unknown clause "D6\.3\.zz"/);
  });

  it('rejects a rule file whose id differs from its name', async () => {
    const data = path.join(tmp, 'data2');
    await copyRulesData(data);
    const file = path.join(data, 'rules', 'pavement.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('id: pavement', 'id: sidewalk'));
    await expect(buildRules({ dataDir: data, outFile: path.join(tmp, 'y.json') })).rejects.toThrow(/must match the file name/);
  });
});

describe('validateRules', () => {
  it('accepts the real bundle', async () => {
    expect(validateRules(await realBundle())).toEqual([]);
  });

  it('keeps accidentBList equal to the lists quoted in 6.10.b and 7.10.b', async () => {
    const bundle = await realBundle();
    for (const g of /** @type {const} */ (['D6', 'D7'])) {
      const quote = bundle.clauses.find((c) => c.id === `${g}.10.b`)?.citation.quote ?? '';
      expect([...bundle.collisionPolicy.accidentBList[g]].sort()).toEqual(listedClauses(quote, g).sort());
    }
  });

  it('gives no cited clause a higher fine than the accident clauses of its group', async () => {
    // An accident absorbs its cause's fine band in the report total, which is only fair when
    // the accident band is the larger one.
    const bundle = await realBundle();
    const byId = new Map(bundle.clauses.map((c) => [c.id, c]));
    const policy = bundle.collisionPolicy;
    for (const g of /** @type {const} */ (['D6', 'D7'])) {
      const accidentMax = Math.min(
        ...[policy.accidentA[g], policy.accidentB[g]].map((id) => byId.get(id)?.fineVnd?.max ?? 0),
      );
      const cited = bundle.rules.flatMap((r) => r.tiers.map((t) => t.clause?.[g])).filter((id) => id !== undefined);
      expect(cited.length).toBeGreaterThan(0);
      for (const id of cited) expect(byId.get(id)?.fineVnd?.max ?? 0, id).toBeLessThanOrEqual(accidentMax);
    }
  });

  /** @type {[string, (b: RulesBundle) => void, RegExp][]} */
  const broken = [
    ['an unknown source id', (b) => { b.clauses[0].citation.sourceId = 'nd999'; }, /unknown source "nd999"/],
    ['an unknown clause id', (b) => { b.rules[0].tiers[0].clause = { D6: 'D6.99.a', D7: 'D7.3.a' }; }, /unknown clause "D6\.99\.a"/],
    ['a missing quote', (b) => { b.clauses[1].citation.quote = ''; }, /missing or empty quote/],
    ['a missing obligation quote', (b) => { b.rules[3].obligation[0].quote = ' '; }, /obligation\[0\]\.quote/],
    ['wrong points', (b) => { /** @type {{licencePoints: number}} */ (b.clauses[2]).licencePoints = 3; }, /licencePoints/],
    ['a fine band upside down', (b) => { b.clauses[2].fineVnd = { min: 5, max: 1 }; }, /min above max/],
    ['a bad supersedes', (b) => { b.rules.find((r) => r.id === 'wrong-way')?.supersedes?.push({ ruleId: 'nope' }); }, /unknown rule "nope"/],
    ['an unknown detector', (b) => { b.rules[0].detection.type = 'teleport'; }, /unknown detector "teleport"/],
    ['a paramBasis key that is not a param', (b) => { b.rules[0].detection.paramBasis.ghost = 'design'; }, /paramBasis\.ghost: not a detection parameter/],
    ['a param without basis', (b) => { b.rules[0].detection.params.extra = 1; }, /params\.extra: has no paramBasis/],
    ['a score-only tier without note', (b) => { delete b.rules.find((r) => r.id === 'following-distance')?.tiers[0].note; }, /needs a note/],
    ['clauseFromPolicy outside crash', (b) => { b.rules[0].tiers[0] = { danger: 2, scoreOnly: false, clauseFromPolicy: true }; }, /only the collision detector/],
    ['a tier with two shapes', (b) => { b.rules[0].tiers[0].scoreOnly = true; }, /exactly one of/],
    ['a missing D7 clause', (b) => { const t = b.rules.find((r) => r.id === 'speeding')?.tiers[0]; if (t) t.clause = { D6: 'D6.3.a' }; }, /clause\.D7: missing/],
    ['a clause in the wrong group', (b) => { const t = b.rules.find((r) => r.id === 'speeding')?.tiers[0]; if (t) t.clause = { D6: 'D7.2.b', D7: 'D7.2.b' }; }, /not in D6/],
    ['a policy clause that does not exist', (b) => { b.collisionPolicy.accidentA.D7 = 'D7.10.z'; }, /accidentA\.D7: unknown clause/],
    ['an inferred cause that is neither clause nor rule', (b) => { b.collisionPolicy.inferredAccidentCauses.push('xyz'); }, /neither a clause nor a rule/],
    ['a citation that names another điểm', (b) => { b.clauses[0].citation.point = 'z'; }, /cites D6\.1\.z/],
    ['a text split by an unquoted comma', (b) => { b.rules[0].description = /** @type {never} */ ({ vi: 'Rẽ trái', 'rẽ phải': null }); }, /unexpected key "rẽ phải"/],
    ['a duplicate rule id', (b) => { b.rules.push(clone(b.rules[0])); }, /duplicate id/],
    ['a sign figure date that is not a date', (b) => { b.signs[0].figureChecked = 'soon'; }, /signs\[0\]\.figureChecked/],
    ['a source URL that is not https', (b) => { b.sources[0].url = 'javascript:alert(1)'; }, /sources\[0\]\.url: expected an https URL/],
    ['a missing accident closing speed', (b) => { delete (/** @type {Record<string, unknown>} */ (b.scoring)).accidentRelSpeed; }, /scoring\.accidentRelSpeed/],
  ];
  for (const [name, edit, pattern] of broken) {
    it(`rejects ${name}`, async () => {
      const b = clone(await realBundle());
      edit(b);
      expect(validateRules(b).join('\n')).toMatch(pattern);
    });
  }

  it('lets a tier limited to one decree group name only that clause', async () => {
    const b = await realBundle();
    const buffer = b.rules.find((r) => r.id === 'stopping')?.tiers[1];
    expect(buffer?.when).toEqual({ place: 'buffer', decreeGroups: ['D6'] });
    expect(buffer?.clause).toEqual({ D6: 'D6.3.đ' });
  });
});

describe('countUnverified', () => {
  it('counts every unchecked sign figure and no clause, speed default or sign meaning', async () => {
    const bundle = await realBundle();
    expect(bundle.signs).toHaveLength(12);
    const figures = bundle.signs.filter((s) => s.figureChecked === null).map((s) => s.code);
    expect(countUnverified(bundle)).toEqual({ clauses: [], speedDefaults: 0, signs: [], figures, total: figures.length });
  });

  it('counts unverified speed defaults and sign meanings', async () => {
    const bundle = clone(await realBundle());
    bundle.speedDefaults[0].verified = false;
    bundle.signs[0].verified = false;
    const counted = countUnverified(bundle);
    expect(counted.speedDefaults).toBe(1);
    expect(counted.signs).toEqual([bundle.signs[0].code]);
  });

  it('stops counting a sign figure once figureChecked has a date', async () => {
    const bundle = clone(await realBundle());
    bundle.signs[0].figureChecked = '2026-11-23';
    expect(countUnverified(bundle).figures).not.toContain(bundle.signs[0].code);
  });
});
