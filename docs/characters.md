# Characters (contributor B/Q)

Data-driven avatar characters for the watch app. The scheduler is driven by
**semantic roles**, never by hardcoded action ids or fixed pixel dimensions,
so new characters ship as data — no scheduler edits, no core edits, no
resource-registration edits (packs resolve via `discoverPackIds` + asset
paths; `ember-min` proves a second selectable pack with zero code changes).

## Pack format (schema v2)

Spec: `protocol/character-pack.schema.json`. A pack declares:

- `pack` / `version`: stable id (`^[a-z0-9][a-z0-9._-]*$`) + version string.
- `author` / `license` (+ optional `attribution`). Only explicitly cleared
  original licenses ship publicly: `CC0-1.0` (the two hand-authored vector
  packs) and `Apache-2.0` (the owner-approved original Cappi pack,
  `cappi-original`). `UNRESOLVED`-prefixed values mark
  **local-parity-only** packs that must never ship publicly, and **any other
  uncleared string is also local-only**: an arbitrary license is never
  treated as safe (`provenanceOf` allowlist, enforced by
  `CharacterRegistryDriftTest`).
- `dimensions`: per-pack `width`/`height` (16–1024). Alternate sizes are
  first-class: every clip entry must match the pack's own dimensions.
- `actions`: `{id, mode, clips, model_selectable}`. Modes: `once`,
  `neutral_loop`, `enter_loop_exit` (exactly `[enter, loop, exit]`),
  `hold`. Clip refs must be **bare filenames** (`.gif`/`.xml`/`.png`/`.webp`;
  no directories, no `..`, no absolutes) present in the pack's `clips` table.
- `roles`: role → action ids in preference order. Required contracts
  (validated at parse AND in the JSON schema): `idle` (≥3 clips),
  `work` (`enter_loop_exit` exactly `[enter, loop, exit]`), `neutral_hold`
  (`hold`, exactly 1 clip). Optional roles — `listen`, `talk`, `work_talk`,
  `celebrate`, `question` — resolve through `fallback_role`, ultimately
  `idle`, so sparse packs still drive every transition. (`dot-default`
  omits `work_talk`; `ember-min` omits `celebrate`/`work_talk`; both fall
  back safely.)
- `fallback_role`: must name a declared role.
- `transitions` (optional): explicit action-id → action-id graph override.
  Both ends must be declared actions.

**Ownership invariants** (enforced at parse): `question` and `work_talk`
actions must be `model_selectable: false`. The model can never cue a pending
question or fake work-talk speech; only snapshot state selects those. A pack
that violates this is rejected, not degraded.

## Shipped packs

| pack | size | license | notes |
|------|------|---------|-------|
| `cappi-original` | 98×98 | Apache-2.0 (owner-approved originals) | Clean-checkout **default**. Canonical schema-v2 conversion of the original v1 manifest: original GIF filenames/actions/modes preserved, `question`/`work_talk` state-owned. Per-file sha256 in `characters/cappi-original/provenance.json` (root `LICENSE` governs). |
| `dot-default` | 96×96 | CC0-1.0 (original hand-authored vectors) | Extensibility demo: full roles except `work_talk` (exercises the standing-speech fallback). Fallback when Cappi assets are missing/corrupt. |
| `ember-min` | 64×64 | CC0-1.0 (original) | Sparse demo: no `celebrate`/`work_talk` roles (both fall back safely). |

Runtime sources: `characters/<id>/pack.json` is the source of truth;
`watch-app/.../assets/characters/<id>/pack.json` is the in-app mirror and
`res/drawable/*.xml` holds the compiled vector frames. `characters/registry.json`
is generated deterministically from the canonical shipped packs
(`cappi-original`, `dot-default`, `ember-min`) via `CharacterRegistry.toBridgeJson` — never
hand-edited, never includes the authoring `example-pack/`. `characters/example-pack/`
is a valid schema-v2 authoring example (sparse, like `ember-min`): copy its
shape to add a pack with no code changes. Test mirrors
(`src/test/resources/characters/*`) stay byte-equal to the canonical sources
(`CharacterRegistryDriftTest` fails on drift).

## Runtime wiring

- `cappi/CharacterPack.kt` — `parseCharacterPack` (validating, pure JVM) +
  `migrateLegacyManifest` (v1 → v2 with the exact legacy role sets).
- `cappi/CharacterScheduler.kt` — role-driven scheduler. `CappiScheduler`
  (legacy, untouched) keeps its exact public API; `CharacterScheduler` proves
  bit-for-bit parity over scripted sequences in `CharacterSchedulerTest`.
- `cappi/CharacterRegistry.kt` — `select(id)` (null/unknown → default),
  `modelSelectableActions`, `legacyActionIds`, and `toBridgeJson()`.
- `cappi/CharacterAssets.kt` — traversal-safe asset paths, `provenanceOf` /
  `canShipPublicly` allowlist gate, `inspectImport` hook core, `discoverPackIds`.
- `cappi/CharacterClipResolver.kt` — pure clip-target decisions:
  compiled `res/drawable` resources win; imported `.xml` vectors with no
  compiled resource render from the asset XML through the minimal subset
  renderer (`cappi/AssetVectorRenderer` — the framework/compat
  `VectorDrawable` loaders require a binary `XmlBlock` parser and cannot
  inflate raw text streams, proven on-device) or fail with a useful reason
  (never fed to the GIF decoder); unsafe/absent art resolves to `Missing`
  and the UI falls back to neutral with a bounded wait.
- `ui/AvatarScreen.kt` — loads `assets/characters/<id>/pack.json`
  (`characterId` param, default null → registry default `cappi-original`,
  `dot-default` fallback on missing/corrupt Cappi), renders compiled
  `.xml` vectors as drawable resources with pack-driven hold timing,
  imported `.xml` vectors via the subset renderer
  (`cappi/AssetVectorRenderer`: viewport + group transforms + fill/stroke
  paths; gradients/`clip-path`/unknown content refuse and fall back), and
  `.gif` via the pre-existing decode path. All question/speech ownership,
  completion, wake, and ambient behavior is unchanged.
- Render validation (Role CA, debug builds only): `AvatarRenderProbeActivity`
  (`src/debug`, never in release) renders the real `AvatarScreen` with
  synthetic connected/speaking/question `UiState` snapshots — no ViewModel,
  no bridge traffic. `src/androidTest/AvatarRenderProbeTest` (11 tests)
  asserts the default `cappi-original` pack renders through the real GIF
  path (idle/speaking/question, plus an omitted-extra default-selection
  test proving null resolves to `cappi-original`, and an on-device
  `Movie.duration() > 0` animation proof at the 98×98 pack contract so a
  static substitution cannot pass silently), both vector packs render
  through the compiled-vector path, the debug-only `import-probe` pack
  (vectors exist ONLY as asset XML) renders through the asset-inflation
  path, and a missing pack falls back to `cappi-original` safely.

## Contracts for other owners (wiring requests)

- **A (device/app)**: `AvatarScreen(..., characterId: String? = null)` is
  source-compatible — no call-site change required. Character picker:
  fulfilled — ids listed via `CharacterAssets.discoverPackIds(assets.list(...))`,
  choice persisted in Settings as `character_id`, passed as `characterId`.
  Companion/remote mode switch: fulfilled touch-first on every profile —
  Menu → Avatar mode (`avatar-toggle`) and Settings → Display → Avatar mode
  pill flip the same `toggleAvatarMode()` the hardware double-press keeps as
  a shortcut; touch-hold the avatar face reopens Menu to switch back
  (see `docs/devices.md` §Avatar/remote mode switch).
- **C (transport/bridge)**: `characters/registry.json` (generated by
  `CharacterRegistry.toBridgeJson`, do not hand-edit) is the single source of
  capabilities: ids, versions, dimensions, roles, `model_selectable`, asset
  dirs. Legacy `POST /watch/cappi` action ids remain a valid adapter surface
  (`legacyActionIds`); the preferred new contract is role-based. Request: adopt
  the registry for allowlist generation; actual SSE route is `/watch/stream`.
  Character-side seams kept stable: `reduceCappiAction`, `CAPPI_ACTION_TIMEOUT_MS`,
  `CappiSnapshot`/`CappiProgram` shapes, clip-completion semantics. (Q round:
  `net/` URL validation, `set-permission` session binding, and the
  `SseSupervisor` policy extraction were required to close read-only audit
  findings; behavior preserved, singleton kept.)
- **D (voice/plugins)**: role names in the registry are the shared vocabulary
  for any character tooling; session scope stays watch-linked-only. B does not
  touch `plugins/`.

## Bridge handshake (watch ↔ bridge; shared with bridge owner J)

The local selection is user-owned: persisted on the watch as `character_id`
(default `cappi-original`), chosen in Settings, passed to `AvatarScreen` as
`characterId`. The bridge never changes it silently.

- Watch → bridge: `POST /watch/command`
  `{cmd: "character-select", characterId, registryVersion: 2}`.
  Sent on manual selection and re-advertised on every SSE `hello`/reconnect
  (the current local choice, not a cached echo).
- Bridge → watch: `{ok: true, characterId}`. A differing echo is recorded as
  `remoteCharacterId` and surfaced ("Bridge suggests 'x' — keeping 'y'"),
  never applied.
- Bridge → watch events: `t: "character", {characterId, ...}` is observed the
  same way — it never switches the local pack. Known ids: `cappi-original`,
  `dot-default`, `ember-min` (a saved pre-clearance `cappi-legacy-local`
  migrates to `cappi-original` at sanitize time).
- Capabilities: `characters/registry.json` (`schema_version: 2`, generated by
  `CharacterRegistry.toBridgeJson`) lists ids, versions, dimensions, roles,
  `model_selectable`, and asset dirs.
- Model cues: the watch translates every `cappiAction` per active pack
  (`CharacterSelection.resolveModelAction`): exact pack ids win; legacy bridge
  ids (`dance`, `talk2`, …) and cross-pack semantic ids map through roles so
  they animate instead of being ignored. State-owned roles (`question`,
  `work_talk`) never resolve from a model request.

## Original Cappi pack (rights cleared — ships)

`characters/cappi-original/` holds the canonical schema-v2 conversion of the
original v1 Cappi manifest: original GIF filenames, actions, modes and the
tested role assignments (`idle`/`listen`/`talk`/`work`/`work_talk`/
`question`/`celebrate`/`neutral_hold`; `question`/`work_talk` state-owned),
with per-file sha256 provenance in `characters/cappi-original/provenance.json`.
The rights holder confirmed ownership and approved Apache-2.0 for the
original Cappi assets (no personal names, emails, or private paths recorded;
root `LICENSE` governs). The in-app mirror lives at
`watch-app/app/src/main/assets/characters/cappi-original/`. The pre-clearance
private staging copies under `.release-work/local-assets/cappi/` are preserved
outside the tree for reference only.

Parent action needed:
`docs/ASSET-LICENSE-NOTES.md` still describes the old in-tree location —
request an update to point at the gate + this hook.
