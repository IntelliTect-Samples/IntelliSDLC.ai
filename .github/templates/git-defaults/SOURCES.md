# Bundled git-defaults snapshots

Per-language templates composed by `Initialize-GitDefaults.ps1` into a
project's `.gitattributes` and `.gitignore`.

## Pinned upstream sources

| File             | Upstream repo                  | Authority                                       | Pinned SHA |
|------------------|--------------------------------|-------------------------------------------------|------------|
| `*.gitattributes`| `alexkaratarakis/gitattributes`| Community de facto -- no GitHub-org source exists | `fddc586cf0f10ec4485028d0d2dd6f73197a4258` |
| `*.gitignore`    | `github/gitignore`             | GitHub-org authoritative -- powers GitHub's UI picker | `dcc0fc7bc2b5ba480cf117ad1be31bafceeaff46` |

The `github/gitattributes` repo does **not** exist (verified:
`gh api repos/github/gitattributes/commits/main` returns 404 at the time of
pinning). `alexkaratarakis/gitattributes` is the long-standing community
canonical source.

## Files in this directory

From `alexkaratarakis/gitattributes`:

- `Common.gitattributes` -- baseline rules included for every language.
- `CSharp.gitattributes` -- C# language rules.
- `Web.gitattributes` -- TypeScript / web stack rules.

From `github/gitignore`:

- `VisualStudio.gitignore` -- C# / .NET / Visual Studio.
- `Node.gitignore` -- Node.js / TypeScript.
- `Global/Backup.gitignore` -- cross-platform editor backups.

## Discoveries during initial bundle (issue #160)

1. **`VisualStudio.gitattributes` does not exist** in
   `alexkaratarakis/gitattributes` at the pinned SHA. ASP.NET therefore
   inherits only from `CSharp.gitattributes` (no extra VS-specific layer).
   The repo does ship `Web.gitattributes` (used for TypeScript).
2. **`PowerShell.gitattributes` exists upstream** but the script uses an
   in-script curated block instead -- smaller surface, explicit
   `linguist-language=PowerShell` hints, and signing-aware CRLF without
   relying on upstream churn. Future option: switch to the upstream file
   if it grows beyond the curated block's coverage.

## Refresh procedure

Run the bootstrap script with `-Refresh` (network fetch path; future
work). Manual procedure today:

```powershell
$gaSha = '<new-sha>'
$giSha = '<new-sha>'
foreach ($f in 'Common','CSharp','Web') {
    Invoke-WebRequest "https://raw.githubusercontent.com/alexkaratarakis/gitattributes/$gaSha/$f.gitattributes" `
        -OutFile ".github/templates/git-defaults/$f.gitattributes" -UseBasicParsing
}
foreach ($f in 'VisualStudio','Node') {
    Invoke-WebRequest "https://raw.githubusercontent.com/github/gitignore/$giSha/$f.gitignore" `
        -OutFile ".github/templates/git-defaults/$f.gitignore" -UseBasicParsing
}
Invoke-WebRequest "https://raw.githubusercontent.com/github/gitignore/$giSha/Global/Backup.gitignore" `
    -OutFile ".github/templates/git-defaults/Global/Backup.gitignore" -UseBasicParsing
```

Then update the pinned SHAs in `Initialize-GitDefaults.ps1` (the
`$GitattributesRef` and `$GitignoreRef` defaults) and this file.