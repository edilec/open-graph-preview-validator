import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../bin/open-graph-preview-validator.mjs';

const cli = new URL('../bin/open-graph-preview-validator.mjs', import.meta.url).pathname;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9FhZkAAAAASUVORK5CYII=', 'base64');
const html = (extra = '', image = 'https://example.test/images/card.png') => `<html><head>
<title>Synthetic page</title>
<link rel="canonical" href="https://example.test/page">
<meta property="og:url" content="https://example.test/page">
<meta property="og:title" content="Synthetic page">
<meta property="og:image" content="${image}">
<meta property="og:image:alt" content="Synthetic graphic">
<meta property="og:image:width" content="1">
<meta property="og:image:height" content="1">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Synthetic page">
<meta name="twitter:image" content="${image}">
<meta name="twitter:image:alt" content="Synthetic graphic">
${extra}</head><body>Example</body></html>`;
function run(page = html(), edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'og-preview-'));
  try {
    mkdirSync(join(root, 'images'));
    writeFileSync(join(root, 'images', 'card.png'), png);
    writeFileSync(join(root, 'page.html'), page);
    edit(root);
    const out = spawnSync(process.execPath, [cli, '--root', root, '--page', 'page.html'], { encoding: 'utf8' });
    return { ...out, report: out.stdout ? JSON.parse(out.stdout) : null };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('valid canonical, OG and X pair with local PNG passes deterministically', () => {
  const a = run(), b = run();
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.report.status, 'pass');
  assert.equal(a.report.summary.checked, 1);
  assert.deepEqual(a.report.findings, []);
});
test('OG and X image identity mismatch fails without leaking URLs', () => {
  const out = run(html().replace('name="twitter:image" content="https://example.test/images/card.png"', 'name="twitter:image" content="https://example.test/images/other.png"'));
  assert.equal(out.status, 1);
  assert.ok(out.report.findings.some(f => f.ruleId === 'image-mismatch'));
  assert.ok(!out.stdout.includes('example.test'));
});
test('duplicate OG property and missing image description fail', () => {
  const duplicate = run(html('<meta property="og:title" content="Other">'));
  assert.equal(duplicate.status, 1);
  assert.ok(duplicate.report.findings.some(f => f.ruleId === 'duplicate-field'));
  const noAlt = run(html().replace('<meta property="og:image:alt" content="Synthetic graphic">', ''));
  assert.equal(noAlt.status, 1);
  assert.ok(noAlt.report.findings.some(f => f.ruleId === 'image-description-missing'));
});
test('canonical and title mismatches fail', () => {
  const out = run(html().replace('property="og:url" content="https://example.test/page"', 'property="og:url" content="https://example.test/elsewhere"').replace('name="twitter:title" content="Synthetic page"', 'name="twitter:title" content="Different"'));
  assert.equal(out.status, 1);
  assert.ok(out.report.findings.some(f => f.ruleId === 'canonical-mismatch'));
  assert.ok(out.report.findings.some(f => f.ruleId === 'title-mismatch'));
});
test('unknown option leaves stdout empty', () => {
  const out = spawnSync(process.execPath, [cli, '--unknown'], { encoding: 'utf8' });
  assert.equal(out.status, 2);
  assert.equal(out.stdout, '');
});
test('inert template metadata cannot satisfy required OG fields', () => {
  const page = html().replace('<meta property="og:title" content="Synthetic page">', '<template><meta property="og:title" content="Synthetic page"></template>');
  const out = run(page);
  assert.equal(out.status, 1);
  assert.ok(out.report.findings.some(f => f.ruleId === 'field-missing'));
});
test('HTML comments and scripts do not create duplicate metadata, and entities decode', () => {
  const page = html('<!-- <meta property="og:title" content="Fake"> --><script>const x = `<meta property="og:title" content="Fake">`;</script>')
    .replaceAll('Synthetic page', 'Synthetic &amp; page');
  const out = run(page);
  assert.equal(out.status, 0);
  assert.deepEqual(out.report.findings, []);
});
test('ordinary title line breaks normalize without a false refusal', () => {
  const out = run(html().replace('<title>Synthetic page</title>', '<title>\n Synthetic page \n</title>'));
  assert.equal(out.status, 0);
});
test('malformed and cross-origin references fail without fetching', () => {
  const malformed = run(html().replace('property="og:url" content="https://example.test/page"', 'property="og:url" content="javascript:alert(1)"'));
  assert.equal(malformed.status, 1);
  assert.ok(malformed.report.findings.some(f => f.ruleId === 'reference-malformed'));
  const crossOrigin = run(html('', 'https://another.test/images/card.png'));
  assert.equal(crossOrigin.status, 1);
  assert.ok(crossOrigin.report.findings.some(f => f.ruleId === 'image-mismatch'));
});
test('query-dependent image variant is incomplete rather than called malformed', () => {
  const out = run(html('', 'https://example.test/images/card.png?v=1'));
  assert.equal(out.status, 2);
  assert.ok(out.report.findings.some(f => f.ruleId === 'image-unavailable'));
});
test('declared image dimensions are compared to local PNG header', () => {
  const out = run(html().replace('property="og:image:width" content="1"', 'property="og:image:width" content="2"'));
  assert.equal(out.status, 1);
  assert.ok(out.report.findings.some(f => f.ruleId === 'image-dimensions-mismatch'));
});
test('missing and out-of-root image evidence remain incomplete', () => {
  const missing = run(html(), root => rmSync(join(root, 'images', 'card.png')));
  assert.equal(missing.status, 2);
  assert.ok(missing.report.findings.some(f => f.ruleId === 'image-unavailable'));
  const outside = mkdtempSync(join(tmpdir(), 'og-outside-'));
  try {
    writeFileSync(join(outside, 'private.png'), png);
    const escaped = run(html(), root => { rmSync(join(root, 'images', 'card.png')); symlinkSync(join(outside, 'private.png'), join(root, 'images', 'card.png')); });
    assert.equal(escaped.status, 2);
    assert.ok(escaped.report.findings.some(f => f.ruleId === 'image-unavailable'));
  } finally { rmSync(outside, { recursive: true, force: true }); }
});
test('page byte boundary accepts 262144 and rejects 262145; UTF-8 is strict', () => {
  const base = html();
  const exact = base + ' '.repeat(262144 - Buffer.byteLength(base));
  assert.equal(run(exact).status, 0);
  const over = run(exact + ' ');
  assert.equal(over.status, 2);
  assert.ok(over.report.findings.some(f => f.ruleId === 'input-too-large'));
  const invalid = run(base, root => writeFileSync(join(root, 'page.html'), Buffer.from([0xff])));
  assert.equal(invalid.status, 2);
  assert.ok(invalid.report.findings.some(f => f.ruleId === 'input-unavailable'));
});
test('head tag bound accepts 200 and refuses 201', () => {
  const extra = n => Array.from({ length: n }, () => '<meta name="unrelated" content="x">').join('');
  assert.equal(run(html(extra(188))).status, 0);
  const over = run(html(extra(189)));
  assert.equal(over.status, 2);
  assert.ok(over.report.findings.some(f => f.ruleId === 'tag-limit'));
});
test('metadata attribute bound accepts 20 and refuses 21', () => {
  const extra = n => Array.from({ length: n }, (_, i) => ` data-${i}="x"`).join('');
  const tag = '<meta property="og:title" content="Synthetic page">';
  assert.equal(run(html().replace(tag, `<meta property="og:title" content="Synthetic page"${extra(18)}>`)).status, 0);
  const over = run(html().replace(tag, `<meta property="og:title" content="Synthetic page"${extra(19)}>`));
  assert.equal(over.status, 2);
  assert.ok(over.report.findings.some(f => f.ruleId === 'input-invalid'));
});
test('image byte boundary accepts 5242880 and refuses 5242881', () => {
  assert.equal(run(html(), root => writeFileSync(join(root, 'images', 'card.png'), Buffer.concat([png, Buffer.alloc(5242880 - png.length)]))).status, 0);
  const over = run(html(), root => writeFileSync(join(root, 'images', 'card.png'), Buffer.concat([png, Buffer.alloc(5242881 - png.length)])));
  assert.equal(over.status, 2);
  assert.ok(over.report.findings.some(f => f.ruleId === 'image-unavailable'));
});
test('page symlink outside root cannot be read', () => {
  const outside = mkdtempSync(join(tmpdir(), 'og-page-out-'));
  try {
    writeFileSync(join(outside, 'private.html'), html());
    const out = run(html(), root => { rmSync(join(root, 'page.html')); symlinkSync(join(outside, 'private.html'), join(root, 'page.html')); });
    assert.equal(out.status, 2);
    assert.ok(out.report.findings.some(f => f.ruleId === 'input-unavailable'));
  } finally { rmSync(outside, { recursive: true, force: true }); }
});
test('injected deadline accepts 5000ms and refuses 5001ms', () => {
  const root = mkdtempSync(join(tmpdir(), 'og-clock-'));
  try {
    mkdirSync(join(root, 'images'));
    writeFileSync(join(root, 'images', 'card.png'), png);
    writeFileSync(join(root, 'page.html'), html());
    const args = ['--root', root, '--page', 'page.html'];
    const invoke = clock => { let stdout = ''; const code = main(args, clock, { write: s => { stdout += s; } }, { write: () => {} }); return { code, report: JSON.parse(stdout) }; };
    let calls = 0;
    assert.equal(invoke(() => calls++ === 0 ? 100 : 5100).code, 0);
    calls = 0;
    const over = invoke(() => calls++ === 0 ? 100 : 5101);
    assert.equal(over.code, 2);
    assert.ok(over.report.findings.some(f => f.ruleId === 'timeout'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
