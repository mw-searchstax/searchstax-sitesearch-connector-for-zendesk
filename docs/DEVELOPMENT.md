# Development

## Local checks

Use Node 24.18.0 and npm 11.16.0 when running the source outside Docker:

```sh
npm ci
npm run check
```

`npm run check` runs formatting, lint, type checking, unit tests, browser tests,
and the production client build. Browser tests use Playwright and stub vendor
responses; they do not require Zendesk or SearchStax credentials.

The public source and supported customer runtime use MySQL. Keep credentials
and local state outside commits. Do not add vendor calls to ordinary tests.

## Changes

Preserve the one-brand, one-destination boundary, loopback/private operator
boundary, public-only eligibility rules, connector ownership checks, complete
inventory guard, explicit migrations, and redacted diagnostics. Validate any
runtime or schema change against a disposable MySQL environment and document
release compatibility in the public release record.
