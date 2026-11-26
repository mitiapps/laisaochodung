/**
 * Dev diagnostics of traffic wrecks, built from the frames the session already handles: how long
 * each wreck stood on the road and how far from the ego it was when it left. Nothing here feeds a
 * frame, the scorer or the HUD.
 */

/** @typedef {import('../contracts/telemetry.js').Frame} Frame */

/** The log keeps this many wrecks, the newest. */
export const WRECK_LOG_SIZE = 32;

/**
 * One traffic agent seen as a wreck.
 * @typedef {object} WreckEntry
 * @property {string} id Agent id.
 * @property {string} kind Actor kind.
 * @property {number} firstTick First frame tick with state `crashed` or `fallen`.
 * @property {number | null} goneTick First frame tick without the agent; null while it stands.
 * @property {number | null} standS `(goneTick − firstTick) · dt`; null while it stands.
 * @property {number | null} egoDistM Distance to the ego centre in the last frame the agent was in.
 */

/**
 * @typedef {object} WreckLog
 * @property {(frame: Frame, firstTraffic: number) => void} observe Reads one frame; traffic poses
 *   start at index `firstTraffic` of `frame.actors`.
 * @property {() => WreckEntry[]} entries Copies of the entries, oldest first.
 */

/**
 * Creates an empty wreck log.
 * @param {number} dt Fixed step, s.
 * @param {number} [size] Entries kept.
 * @returns {WreckLog} Log.
 */
export function createWreckLog(dt, size = WRECK_LOG_SIZE) {
  if (!(dt > 0)) throw new RangeError(`dt must be positive, got ${String(dt)}`);
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`size must be a positive integer, got ${String(size)}`);
  /** @type {WreckEntry[]} */
  const log = [];
  /** Entries still standing, by agent id. */
  /** @type {Map<string, WreckEntry>} */
  const open = new Map();

  return {
    observe(frame, firstTraffic) {
      /** @type {Set<string>} */
      const present = new Set();
      const ego = frame.ego.pos;
      for (let i = firstTraffic; i < frame.actors.length; i += 1) {
        const a = frame.actors[i];
        present.add(a.id);
        const dist = Math.hypot(a.pos.x - ego.x, a.pos.z - ego.z);
        const entry = open.get(a.id);
        if (entry) entry.egoDistM = dist;
        else if (a.state === 'crashed' || a.state === 'fallen') {
          /** @type {WreckEntry} */
          const e = { id: a.id, kind: a.kind, firstTick: frame.tick, goneTick: null, standS: null, egoDistM: dist };
          open.set(a.id, e);
          log.push(e);
          if (log.length > size) {
            const dropped = /** @type {WreckEntry} */ (log.shift());
            if (open.get(dropped.id) === dropped) open.delete(dropped.id);
          }
        }
      }
      for (const [id, e] of open) {
        if (present.has(id)) continue;
        e.goneTick = frame.tick;
        e.standS = (frame.tick - e.firstTick) * dt;
        open.delete(id);
      }
    },

    entries() {
      return log.map((e) => ({ ...e }));
    },
  };
}
