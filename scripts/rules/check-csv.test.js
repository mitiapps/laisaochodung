// Cross-checks every clause record against its row of the ND 168 research CSV
// (fixtures/nd168-detectable.csv, copied verbatim from the research report).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { realBundle, ROOT } from './lib/test-support.js';

/**
 * Splits one CSV line, honouring double quotes.
 * @param {string} line Line.
 * @returns {string[]} Cells.
 */
function cells(line) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const text = readFileSync(path.join(ROOT, 'scripts', 'rules', 'fixtures', 'nd168-detectable.csv'), 'utf8');
const [header, ...lines] = text.trim().split('\n');
const columns = cells(header);
/** @type {Map<string, Record<string, string>[]>} */
const byCite = new Map();
for (const line of lines) {
  const row = Object.fromEntries(cells(line).map((v, i) => [columns[i], v]));
  byCite.set(row.cite, [...(byCite.get(row.cite) ?? []), row]);
}

describe('ND 168 CSV cross-check', () => {
  it('has the expected header and 101 behaviour rows', () => {
    expect(columns).toEqual([
      'id', 'vehicle', 'behaviour', 'cite', 'fine_min', 'fine_max', 'points', 'susp_months', 'extra', 'amended', 'effective_from',
    ]);
    expect(lines).toHaveLength(101);
  });

  it('matches every verified clause record to its CSV row', async () => {
    const bundle = await realBundle();
    const verified = bundle.clauses.filter((c) => c.verified);
    expect(verified.length).toBe(bundle.clauses.length);
    for (const clause of verified) {
      const rows = byCite.get(clause.id);
      expect(rows, `${clause.id} has a CSV row`).toBeDefined();
      for (const row of /** @type {Record<string, string>[]} */ (rows)) {
        const where = `${clause.id} vs ${row.id}`;
        expect(clause.fineVnd, where).toEqual(row.fine_min === '' ? null : { min: Number(row.fine_min), max: Number(row.fine_max) });
        expect(clause.licencePoints, where).toBe(Number(row.points));
        const [smin, smax] = row.susp_months.split('-').map(Number);
        expect(clause.suspensionMonths, where).toEqual(row.susp_months === 'none' ? null : { min: smin, max: smax });
        expect(clause.effectiveFrom, where).toBe(row.effective_from);
        expect((clause.amendments ?? []).length > 0, `${where}: amendment present iff the CSV marks one`).toBe(row.amended !== '');
        if (row.amended !== '') {
          const [, k] = /Đ19\.(\d+)/u.exec(row.amended) ?? [];
          expect(clause.amendments?.[0]).toMatchObject({ sourceId: 'nd238-2026', article: 'Điều 19', clause: k });
        }
      }
    }
  });
});
