# Plan: auth-detection + auth-heuristic (issue #40)

Date: 2025-11-04
Branch: feat/40-auth-detection
Parent epic: #34. Item 3 of 11 in api-wrapper-scaffold series.

## Files

### New

- `templates/api-wrapper-scaffold/scripts/detect-auth.js`
  - Exports `classifyAuth(har) -> { authModel, evidence, idpName? }`
  - When invoked as CLI: `node detect-auth.js <har-path>` -> stdout JSON, exit 0
  - Exit 2 on usage error, exit 1 on file read / parse error
- `.github/agents/tests/auth-detection.Tests.ps1` -- Pester tests
- `.github/agents/tests/fixtures/har/*.har` -- 8 fixtures:
  - `cookie.har`
  - `cookie-csrf.har`
  - `bearer.har`
  - `sso-google.har`
  - `sso-microsoft.har`
  - `sso-facebook.har`
  - `oauth2-pkce.har`
  - `ambiguous.har`

### Modified

- None. Agent doc Phase 4 table already matches the heuristic.

## Heuristic (priority order, first match wins)

1. **oauth2-pkce**: any request URL contains `code_challenge_method=S256` OR any request body contains `code_verifier`, AND a Bearer token appears somewhere.
2. **sso-google**: any entry URL host is `accounts.google.com`, AND a Bearer token appears in a later entry on a different host. `idpName = "Google"`.
3. **sso-microsoft**: host `login.microsoftonline.com` + Bearer. `idpName = "Microsoft"`.
4. **sso-facebook**: URL matches `facebook.com/v*/dialog/oauth` + Bearer. `idpName = "Facebook"`.
5. **bearer**: `Authorization: Bearer <jwt-shaped>` header on >=1 entry, no IdP redirect.
6. **cookie+csrf**: any `Set-Cookie` response header AND any request header in `x-csrf-token`, `x-xsrf-token`, `csrf-token`, `x-requested-with`.
7. **cookie**: any `Set-Cookie` response header, no Authorization, no CSRF header.
8. **unknown**: none of the above. Evidence still lists scanned signals.

Evidence entry shape: `{ url: string, signal: string }`.

## Tests (one It per fixture)

```
Describe 'classifyAuth' {
  It 'classifies cookie-only HAR as cookie' { ... }
  It 'classifies cookie + X-CSRF-Token HAR as cookie+csrf' { ... }
  It 'classifies plain Bearer HAR as bearer' { ... }
  It 'classifies Google SSO redirect + Bearer as sso-google with idpName Google' { ... }
  It 'classifies Microsoft SSO redirect + Bearer as sso-microsoft' { ... }
  It 'classifies Facebook OAuth dialog + Bearer as sso-facebook' { ... }
  It 'classifies code_challenge_method=S256 + Bearer as oauth2-pkce' { ... }
  It 'returns unknown with non-empty evidence for ambiguous HAR' { ... }
  It 'CLI prints valid JSON to stdout and exits 0 (skipped if no node)' { ... }
  It 'CLI exits non-zero on missing file' { ... }
}
```

## TDD order

1. Write Pester test file referencing not-yet-existent fixtures and script. Run -> RED.
2. Add fixture for `cookie` only. Implement minimal `classifyAuth` covering only cookie. Run -> 1 green.
3. Add `cookie-csrf` fixture + branch. Continue down the table.
4. Add CLI wrapper at end. Verify exit codes via `& node`.
5. Refactor classifier into small helpers (`hasBearerToken`, `findIdpRedirect`, `findCsrfHeader`, `findSetCookie`, `findPkceMarker`).

## Commits

- `test(auth-detection): add Pester tests + fixtures` (RED)
- `feat(auth-detection): implement classifyAuth heuristic` (GREEN)
- `refactor(auth-detection): extract signal helpers` (REFACTOR)
- `docs(auth-detection): add Phase 5b evidence capture`
