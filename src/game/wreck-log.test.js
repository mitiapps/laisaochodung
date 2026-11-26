import { describe, expect, it } from 'vitest';
import { DT } from '../contracts/units.js';
import { WRECK_LOG_SIZE, createWreckLog } from './wreck-log.js';

/** @typedef {import('../contracts/telemetry.js').Frame} Frame */
/** @typedef {import('../contracts/telemetry.js').ActorPose} ActorPose */

/**
 * A frame with only the fields the log reads.
 * @param {number} tick Tick.
 * @param {{x: number, z: number}} ego Ego centre.
 * @param {Array<Pick<ActorPose, 'id' | 'kind' | 'state'> & {x: number, z: number}>} actors Actors.
 * @returns {Frame} Frame.
 */
function frame(tick, ego, actors) {
  return /** @type {Frame} */ (
    /** @type {unknown} */ ({
      tick,
      ego: { pos: { x: ego.x, y: 0, z: ego.z } },
      actors: actors.map((a) => ({ id: a.id, kind: a.kind, state: a.state, pos: { x: a.x, z: a.z } })),
    })
  );
}

describe('createWreckLog', () => {
  it('validates its arguments', () => {
    expect(() => createWreckLog(0)).toThrow(RangeError);
    expect(() => createWreckLog(DT, 0)).toThrow(RangeError);
  });

  it('records when a traffic wreck first shows, when it leaves, and its last distance to the ego', () => {
    const log = createWreckLog(DT);
    const ped = { id: 'ped-1', kind: /** @type {const} */ ('pedestrian'), state: /** @type {const} */ ('crashed'), x: 0, z: 0 };
    const car = { id: 'npc-4', kind: /** @type {const} */ ('car'), x: 10, z: 0 };
    log.observe(frame(0, { x: 0, z: 0 }, [ped, { ...car, state: 'moving' }]), 1);
    expect(log.entries()).toEqual([]);
    log.observe(frame(1, { x: 0, z: 0 }, [ped, { ...car, state: 'crashed' }]), 1);
    log.observe(frame(2, { x: 4, z: 3 }, [ped, { ...car, state: 'crashed', x: 8 }]), 1);
    expect(log.entries()).toEqual([{ id: 'npc-4', kind: 'car', firstTick: 1, goneTick: null, standS: null, egoDistM: 5 }]);
    log.observe(frame(182, { x: 0, z: 0 }, [ped]), 1);
    const [e] = log.entries();
    expect(e).toMatchObject({ id: 'npc-4', firstTick: 1, goneTick: 182, egoDistM: 5 });
    expect(e.standS).toBeCloseTo(181 * DT, 12);
  });

  it('ignores scripted actors before the first traffic index', () => {
    const log = createWreckLog(DT);
    log.observe(frame(0, { x: 0, z: 0 }, [{ id: 'act-1', kind: 'motorbike', state: 'fallen', x: 1, z: 0 }]), 1);
    expect(log.entries()).toEqual([]);
  });

  it('keeps the newest entries only', () => {
    const log = createWreckLog(DT);
    for (let i = 0; i < WRECK_LOG_SIZE + 3; i += 1) {
      log.observe(frame(i, { x: 0, z: 0 }, [{ id: `npc-${i}`, kind: 'motorbike', state: 'fallen', x: i, z: 0 }]), 0);
    }
    const entries = log.entries();
    expect(entries).toHaveLength(WRECK_LOG_SIZE);
    expect(entries[0].id).toBe('npc-3');
    expect(entries.at(-1)?.id).toBe(`npc-${WRECK_LOG_SIZE + 2}`);
    // Each left on the next frame.
    expect(entries.slice(0, -1).every((e) => e.goneTick === e.firstTick + 1)).toBe(true);
  });

  it('returns copies', () => {
    const log = createWreckLog(DT);
    log.observe(frame(0, { x: 0, z: 0 }, [{ id: 'npc-1', kind: 'car', state: 'crashed', x: 0, z: 0 }]), 0);
    log.entries()[0].goneTick = 99;
    expect(log.entries()[0].goneTick).toBeNull();
  });
});
