# Security policy

## Scope

This tree is a release scaffold (pre-publication; see
`docs/ASSET-LICENSE-NOTES.md` and `LICENSE-DECISION.md`). There is no
supported production deployment, and no claim is made about hardware,
production, or legal validation.

## Transport rules (enforced by contributors B/C; verified by docs)

- Token travels in the `X-Bridge-Token` header only — never in URLs, logs,
  or error strings. `?token=` is rejected (HTTP 401).
- HTTPS with pinned certificate SHA-256, verified before any token is
  sent. Cleartext only with explicit mutual opt-in
  (`BRIDGE_ALLOW_INSECURE_HTTP=1` + watch-side flag); no silent downgrade.
- UDP discovery and `/watch/pair-probe` are liveness/consistency only —
  never authentication, never relay-proof. Only the certificate pin
  confers trust. No new client may treat a pair-probe pass as identity.
- The bridge never redirects; clients refuse 3xx rather than following.

## Secrets handling

- Never commit tokens, keys, certificates, keystores, `.env` files,
  signing configs, logs, transcripts, or model weights (see `.gitignore`).
- The bridge prints the certificate **pin** at startup (public pairing
  material, entered on the watch). It never prints the **token** in
  routine logs; the token lives in a mode-`0600` file under the external
  state dir (`BRIDGE_STATE_DIR`, never the source tree).
- `tools/scan-secrets.py` reports paths and counts only — it never prints
  secret values. Report a suspected leak the same way (path + category,
  never the value).

## Reporting a vulnerability

Do not open a public issue with exploit details or secrets. Contact the
tree owner privately with: affected path(s), a description without secret
values, and reproduction steps against a local fixture build. Allow
reasonable time for a fix before any disclosure.

## Release verification

Run `./tools/verify.sh` before sharing any bundle. Publication is
additionally gated by `tools/check-license-gate.py`; open gates block
`tools/release-bundle.sh` (LOCAL candidates only) until closed.
