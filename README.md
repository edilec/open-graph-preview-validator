# Open Graph Preview Validator

Validate a built page’s canonical URL and title against its Open Graph and X (Twitter card) metadata, then compare the declared preview image dimensions with a local PNG. Duplicate fields, malformed URLs, missing image descriptions and identity mismatches are reported. This is an offline, read-only, zero-dependency Node.js 22+ check, not a prediction of social-platform rendering.

```sh
node bin/open-graph-preview-validator.mjs --root examples --page pass.html
node bin/open-graph-preview-validator.mjs --root examples --page fail.html
npm run check
```

The first example exits 0. The second exits 1 because OG and X image URLs disagree. Unreadable, out-of-root or unsupported local image evidence exits 2 as `incomplete`; it is never treated as a good preview. `src/index.mjs` exports `TOOL_ID` and `validatePreview`. See [rules and limits](docs/README.md).
