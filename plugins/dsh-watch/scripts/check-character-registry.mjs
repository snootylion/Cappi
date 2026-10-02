// Build-time check only. Published runtime uses bundled metadata and NEVER
// reads outside its package. Drift must fail the build, not silently ship.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { PAYLOAD_PACKS, PAYLOAD_DEFAULT, PAYLOAD_VERSION } from '../src/character-payload.ts';
const registry = JSON.parse(readFileSync(new URL('../../../characters/registry.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(PAYLOAD_VERSION, pkg.version, 'character payload version drift');
assert.equal(PAYLOAD_DEFAULT, registry.default, 'default character drift');
assert.deepEqual(PAYLOAD_PACKS, registry.characters.map(p => ({ id: p.id, version: p.version, license: p.license, modelSelectable: p.model_selectable, roles: p.roles })), 'bundled character registry drift');
console.log('Character payload matches canonical public registry and package version');
