/**
 * Bundled character metadata (H-owned payload, in-package only).
 *
 * Only needed metadata travels in the npm tar — schema/registry subset +
 * selected-pack descriptors. No GIF bytes, no weights, no `../../runtime`
 * references. Payload version = package version; installer verifies hashes
 * before first use (P concern; this file documents the payload contract).
 *
 * Build asserts exact consistency with public `characters/registry.json` (schema 2). State-owned cues
 * (`question`, `static_hold`, `work_talk`, `neutral_hold`) are listed for
 * completeness but NEVER model-resolvable.
 */

export interface PayloadPack {
  id: string;
  version: string;
  license: string;
  modelSelectable: readonly string[];
  roles: Readonly<Record<string, readonly string[]>>;
}

export const PAYLOAD_VERSION = '0.3.0-rc0';

export const PAYLOAD_PACKS: readonly PayloadPack[] = Object.freeze([
  {
    id: 'cappi-original',
    version: '1.0.0',
    license: 'Apache-2.0',
    modelSelectable: Object.freeze([
      'idle1_a', 'idle1_b', 'idle1_c', 'idle1_d',
      'idle2_a', 'idle2_b', 'idle2_c', 'idle2_d', 'idle2_e',
      'breath', 'breath2', 'relaxed',
      'talk2', 'talk3', 'talk_gesture',
      'dance', 'shadow', 'work',
    ]),
    roles: Object.freeze({
      celebrate: Object.freeze(['dance', 'shadow']),
      idle: Object.freeze([
        'breath', 'breath2',
        'idle1_a', 'idle1_b', 'idle1_c', 'idle1_d',
        'idle2_a', 'idle2_b', 'idle2_c', 'idle2_d', 'idle2_e', 'relaxed',
      ]),
      listen: Object.freeze(['breath', 'breath2', 'relaxed']),
      neutral_hold: Object.freeze(['static_hold']),
      question: Object.freeze(['question']),
      talk: Object.freeze(['talk2', 'talk3', 'talk_gesture']),
      work: Object.freeze(['work']),
      work_talk: Object.freeze(['work_talk']),
    }),
  },
  {
    id: 'dot-default',
    version: '1.0.0',
    license: 'CC0-1.0',
    modelSelectable: Object.freeze([
      'idle_a', 'idle_b', 'idle_c', 'listen', 'talk_a', 'talk_b', 'work_set', 'celebrate',
    ]),
    roles: Object.freeze({
      celebrate: Object.freeze(['celebrate']),
      idle: Object.freeze(['idle_a', 'idle_b', 'idle_c']),
      listen: Object.freeze(['listen']),
      neutral_hold: Object.freeze(['static_hold']),
      question: Object.freeze(['question']),
      talk: Object.freeze(['talk_a', 'talk_b']),
      work: Object.freeze(['work_set']),
    }),
  },
  {
    id: 'ember-min',
    version: '1.0.0',
    license: 'CC0-1.0',
    modelSelectable: Object.freeze(['idle_a', 'idle_b', 'idle_c', 'listen', 'talk', 'work_set']),
    roles: Object.freeze({
      idle: Object.freeze(['idle_a', 'idle_b', 'idle_c']),
      listen: Object.freeze(['listen']),
      neutral_hold: Object.freeze(['static_hold']),
      question: Object.freeze(['question']),
      talk: Object.freeze(['talk']),
      work: Object.freeze(['work_set']),
    }),
  },
]);

export const PAYLOAD_DEFAULT = 'cappi-original';
