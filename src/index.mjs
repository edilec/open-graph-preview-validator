export const TOOL_ID = 'open-graph-preview-validator';
export const LIMITS = Object.freeze({ pageBytes: 262144, imageBytes: 5242880, tags: 200, attributes: 20, milliseconds: 5000 });
export const SEVERITY = Object.freeze({
  'input-unavailable': 'warning', 'input-too-large': 'warning', 'input-invalid': 'warning', 'tag-limit': 'warning', 'timeout': 'warning',
  'image-unavailable': 'warning', 'image-unsupported': 'warning',
  'duplicate-field': 'error', 'field-missing': 'error', 'image-description-missing': 'error',
  'canonical-mismatch': 'error', 'title-mismatch': 'error', 'image-mismatch': 'error',
  'image-dimensions-mismatch': 'error', 'reference-malformed': 'error'
});
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const forbidden = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
export const finding = (ruleId, file, pointer, message) => {
  if (!Object.hasOwn(SEVERITY, ruleId)) throw Error('Unknown rule');
  return { ruleId, severity: SEVERITY[ruleId], message, location: { file, pointer } };
};
export function report(findings, checked = 0) {
  findings.sort((a, b) => cmp(a.location.file, b.location.file) || cmp(a.location.pointer, b.location.pointer) || cmp(a.ruleId, b.ruleId));
  const status = findings.some(f => f.severity === 'warning') ? 'incomplete' : findings.length ? 'fail' : 'pass';
  return { schemaVersion: '1', tool: TOOL_ID, status, summary: { checked, errors: findings.filter(f => f.severity === 'error').length, warnings: findings.filter(f => f.severity === 'warning').length }, findings };
}
class Issue extends Error { constructor(ruleId) { super(ruleId); this.ruleId = ruleId; } }
function decode(raw) {
  if (forbidden.test(raw)) throw new Issue('input-invalid');
  return raw.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);/gi, (_, value) => {
    if (value[0] === '#') {
      const hex = value[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(value.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isSafeInteger(code) || code < 1 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw new Issue('input-invalid');
      return String.fromCodePoint(code);
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' })[value.toLowerCase()];
  });
}
function attributes(raw) {
  const result = {};
  let rest = raw.trim(), count = 0;
  while (rest && rest !== '/') {
    const match = /^([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
    if (!match || ++count > LIMITS.attributes) throw new Issue('input-invalid');
    const key = match[1].toLowerCase();
    if (Object.hasOwn(result, key)) throw new Issue('input-invalid');
    result[key] = decode(match[2] ?? match[3]);
    rest = rest.slice(match[0].length).trimStart();
  }
  return result;
}
function headTokens(html) {
  if (html.includes('<!--') && /<!--(?:(?!-->)[\s\S])*$/s.test(html)) throw new Issue('input-invalid');
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const start = /<head(?:\s[^>]*)?>/i.exec(clean);
  if (!start) throw new Issue('input-invalid');
  const end = /<\/head\s*>/i.exec(clean.slice(start.index + start[0].length));
  if (!end) throw new Issue('input-invalid');
  const area = clean.slice(start.index + start[0].length, start.index + start[0].length + end.index);
  const withoutScripts = area.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  if (/<\/?(?:script|style|template|noscript)\b/i.test(withoutScripts)) throw new Issue('input-invalid');
  const tokens = [];
  let cursor = 0;
  while (cursor < withoutScripts.length) {
    const open = withoutScripts.indexOf('<', cursor);
    if (open < 0) break;
    let endAt = open + 1, quote = '';
    for (; endAt < withoutScripts.length; endAt++) {
      const c = withoutScripts[endAt];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (endAt >= withoutScripts.length) throw new Issue('input-invalid');
    const content = withoutScripts.slice(open + 1, endAt);
    const match = /^([A-Za-z][A-Za-z0-9:-]*)([\s\S]*)$/.exec(content);
    if (match) tokens.push({ tag: match[1].toLowerCase(), attrs: match[2], start: open, end: endAt + 1 });
    if (tokens.length > LIMITS.tags) throw new Issue('tag-limit');
    cursor = endAt + 1;
  }
  return { area: withoutScripts, tokens };
}
const normalized = value => value.replace(/\s+/gu, ' ').trim();
const goodText = value => typeof value === 'string' && normalized(value).length > 0 && !forbidden.test(value);
function checkedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || forbidden.test(value)) return null;
    return url;
  } catch { return null; }
}
export function validatePreview(html, resolveImage, { deadline = Infinity, now = Date.now } = {}) {
  const expired = () => deadline !== Infinity && now() > deadline;
  try {
    if (expired()) throw new Issue('timeout');
    if (typeof html !== 'string' || typeof resolveImage !== 'function') throw new Issue('input-invalid');
    const { area, tokens } = headTokens(html);
    const fields = new Map();
    const add = (key, value, pointer) => { const list = fields.get(key) ?? []; list.push({ value, pointer }); fields.set(key, list); };
    for (const [i, token] of tokens.entries()) {
      if (expired()) throw new Issue('timeout');
      if (token.tag === 'title') {
        const close = area.slice(token.end).search(/<\/title\s*>/i);
        if (close < 0) throw new Issue('input-invalid');
        const value = area.slice(token.end, token.end + close);
        if (value.includes('<')) throw new Issue('input-invalid');
        add('title', decode(value), `/head/tags/${i}`);
      }
      if (token.tag !== 'meta' && token.tag !== 'link') continue;
      const attrs = attributes(token.attrs);
      if (token.tag === 'link' && attrs.rel?.toLowerCase().split(/\s+/u).includes('canonical')) add('canonical', attrs.href, `/head/tags/${i}`);
      if (token.tag === 'meta') {
        const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
        if (key.startsWith('og:') || key.startsWith('twitter:')) add(key, attrs.content, `/head/tags/${i}`);
      }
    }
    const findings = [];
    for (const [key, list] of fields) if (list.length > 1) findings.push(finding('duplicate-field', '@page', list[1].pointer, 'Page metadata field is duplicated'));
    const required = ['title', 'canonical', 'og:url', 'og:title', 'og:image', 'og:image:alt', 'og:image:width', 'og:image:height', 'twitter:card', 'twitter:title', 'twitter:image', 'twitter:image:alt'];
    for (const key of required) if (!fields.has(key) || !goodText(fields.get(key)[0].value)) findings.push(finding(key.endsWith(':alt') ? 'image-description-missing' : 'field-missing', '@page', '/head', 'Required page metadata is missing'));
    if (findings.some(f => f.ruleId === 'duplicate-field' || f.ruleId === 'field-missing' || f.ruleId === 'image-description-missing')) return report(findings, 1);
    const value = key => normalized(fields.get(key)[0].value);
    const canonical = checkedUrl(value('canonical')), ogUrl = checkedUrl(value('og:url'));
    const ogImage = checkedUrl(value('og:image')), xImage = checkedUrl(value('twitter:image'));
    if (!canonical || !ogUrl || !ogImage || !xImage) findings.push(finding('reference-malformed', '@page', '/head', 'Page metadata has a malformed URL'));
    else {
      if (canonical.href !== ogUrl.href) findings.push(finding('canonical-mismatch', '@page', fields.get('og:url')[0].pointer, 'Open Graph URL differs from canonical URL'));
      if (ogImage.href !== xImage.href || ogImage.origin !== canonical.origin) findings.push(finding('image-mismatch', '@page', fields.get('twitter:image')[0].pointer, 'Image identities disagree with the page'));
      if (ogImage.search || xImage.search) findings.push(finding('image-unavailable', '@image', '', 'Query-dependent image variant cannot be verified locally'));
    }
    if (value('title') !== value('og:title') || value('title') !== value('twitter:title')) findings.push(finding('title-mismatch', '@page', '/head', 'Preview title differs from page title'));
    if (!['summary', 'summary_large_image'].includes(value('twitter:card'))) findings.push(finding('reference-malformed', '@page', fields.get('twitter:card')[0].pointer, 'X card type is unsupported'));
    const width = Number(value('og:image:width')), height = Number(value('og:image:height'));
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 10000 || height > 10000) findings.push(finding('reference-malformed', '@page', '/head', 'Image dimensions are malformed'));
    if (!findings.length) {
      let image;
      try { image = resolveImage(ogImage); }
      catch { return report([finding('image-unavailable', '@image', '', 'Local image could not be verified')]); }
      if (!image || image.mime !== 'image/png') return report([finding('image-unsupported', '@image', '', 'Local image format is unsupported')]);
      if (image.width !== width || image.height !== height) findings.push(finding('image-dimensions-mismatch', '@page', '/head', 'Declared image dimensions differ from local image'));
    }
    if (expired()) throw new Issue('timeout');
    return report(findings, 1);
  } catch (error) {
    if (error instanceof Issue) return report([finding(error.ruleId, '@page', '', 'Page metadata could not be completely evaluated')]);
    return report([finding('input-invalid', '@page', '', 'Page metadata could not be completely evaluated')]);
  }
}
