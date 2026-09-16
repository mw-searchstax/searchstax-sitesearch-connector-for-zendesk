# Releases and provenance

Public releases are standalone repository releases. The first public version
must be a new version and tag; private prerelease history is not reused.

Use immutable image digests, not `latest`, as deployment identity. A release
record should contain:

- public repository URL;
- public commit and tag/version;
- export manifest version and schema version;
- Linux/arm64 platform;
- image digest and SHA-256 checksums;
- build inputs and migration/schema compatibility;
- rollback constraints and verification results.

`release/provenance.schema.json` defines the public record shape and
`release/provenance.example.json` shows placeholders for a future release.
Replace placeholders only when the standalone public repository, commit, and
image exist. Do not claim signing, SBOM attestation, or reproducible builds
without independent implementation and proof.
