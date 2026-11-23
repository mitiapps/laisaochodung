import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { realBundle } from '../../../scripts/rules/lib/test-support.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);

describe('rule coverage', () => {
  it('every rule in the bundle has a kinematic scenario file that breaks it and checks the clean twin', async () => {
    const bundle = await realBundle();
    const missing = [];
    for (const rule of bundle.rules) {
      const file = path.join(HERE, `${rule.id}.test.js`);
      if (!existsSync(file)) {
        missing.push(rule.id);
        continue;
      }
      const text = readFileSync(file, 'utf8');
      expect(text, `${rule.id} must assert a breach`).toContain(`breachesOf(report, '${rule.id}')`);
    }
    expect(missing).toEqual([]);
  });
});
