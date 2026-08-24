/**
 * Adversarial tests for input validation.
 *
 *     node --experimental-strip-types --test scripts/validation-test.ts
 *
 * Destination URLs are rendered into `href` attributes on a public page, so a
 * hostile one is a stored XSS bug affecting every reader. These cases are the
 * ones that actually get tried.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSafeUrl, isValidEmail, validateAdSubmission } from '../server/validation.ts';
import { MAX_IMAGE_BYTES, parseSafeImageSrc } from '../shared/field-rules.ts';

const GOOD_AD = {
  brandName: 'Orbital Coffee',
  headline: 'Roasted above the clouds',
  destinationUrl: 'https://orbital.coffee',
};

// --------------------------------------------------------------------------
// Hostile URLs
// --------------------------------------------------------------------------

test('script-bearing protocols are rejected', () => {
  const attacks = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'JAVASCRIPT:alert(document.cookie)',
    '  javascript:alert(1)  ',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\rscript:alert(1)',
    'javascript\u0000:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'file:///etc/passwd',
    'about:blank',
    'blob:https://example.com/uuid',
    'chrome://settings',
    'ftp://example.com/x',
    'mailto:someone@example.com',
    'tel:+15551234',
    'ws://example.com',
    'jar:http://example.com!/',
  ];

  for (const attack of attacks) {
    assert.equal(parseSafeUrl(attack), null, `should reject: ${JSON.stringify(attack)}`);
  }
});

test('http and https are accepted', () => {
  assert.equal(parseSafeUrl('https://example.com'), 'https://example.com/');
  assert.equal(parseSafeUrl('http://example.com/path?a=1'), 'http://example.com/path?a=1');
  assert.ok(parseSafeUrl('https://sub.domain.example.co.uk/deep/path#anchor'));
});

test('a bare domain is upgraded to https', () => {
  assert.equal(parseSafeUrl('example.com'), 'https://example.com/');
  assert.equal(parseSafeUrl('www.example.com/page'), 'https://www.example.com/page');
});

test('a bare domain cannot smuggle a disallowed protocol through the upgrade', () => {
  // If "javascript:alert(1)" were treated as a bare domain and prefixed, it
  // would become a valid https URL and slip through. It must not be.
  assert.equal(parseSafeUrl('javascript:alert(1)'), null);
});

test('junk that is not a URL is rejected', () => {
  for (const junk of ['', '   ', 'not a url', 'https://', 'http://', '://example.com', 'localhost:', '?', '#', '//', 'https://.', 'https://..', 'https://-', 'https://-.com', 'https://a-.com', 'https://.com', 'https://example.', 'https://example..com', 'https://example.c', 'https://example.123', null, undefined, 42, {}, [], true]) {
    assert.equal(parseSafeUrl(junk), null, `should reject: ${JSON.stringify(junk)}`);
  }
});

test('real-world hostnames are accepted', () => {
  for (const good of [
    'https://example.com',
    'https://a.co',
    'https://my-site.example.org',
    'https://deep.sub.domain.example.co.uk',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
  ]) {
    assert.ok(parseSafeUrl(good), `should accept: ${good}`);
  }
});

test('localhost is allowed so the app can be tested against itself', () => {
  assert.ok(parseSafeUrl('http://localhost:3000/preview'));
});

test('absurdly long URLs are rejected', () => {
  assert.equal(parseSafeUrl(`https://example.com/${'a'.repeat(4000)}`), null);
});

// --------------------------------------------------------------------------
// Email
// --------------------------------------------------------------------------

test('plausible emails are accepted and nonsense is not', () => {
  for (const good of ['a@b.co', 'first.last@example.com', 'x+tag@sub.example.org']) {
    assert.ok(isValidEmail(good), good);
  }
  for (const bad of ['', 'no-at-sign', 'a@b', 'a@@b.com', 'a b@example.com', '@example.com', 'a@.com', 'a@b.', null, undefined, 42]) {
    assert.equal(isValidEmail(bad), false, JSON.stringify(bad));
  }
});

// --------------------------------------------------------------------------
// The submission as a whole
// --------------------------------------------------------------------------

test('a good submission passes and comes back tidied', () => {
  const result = validateAdSubmission({
    ...GOOD_AD,
    brandName: '  Orbital   Coffee  ',
    description: 'Small-batch beans.\n\nShipped weekly.',
    ctaText: ' Order ',
    buyerEmail: '  Buyer@Example.COM ',
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.brandName, 'Orbital Coffee');
  assert.equal(result.value.description, 'Small-batch beans. Shipped weekly.');
  assert.equal(result.value.ctaText, 'Order');
  assert.equal(result.value.buyerEmail, 'buyer@example.com');
  assert.equal(result.value.imageUrl, '');
});

test('the three required fields are required', () => {
  // GOOD_AD carries no image, so it is an ordinary ad and all three hold.
  for (const field of ['brandName', 'headline', 'destinationUrl']) {
    const result = validateAdSubmission({ ...GOOD_AD, [field]: '' });
    assert.equal(result.ok, false, `${field} should be required`);
    assert.ok(result.errors.some((e) => e.field === field), `error should name ${field}`);
  }
});

test('a logo-only ad needs neither brand nor headline', () => {
  const result = validateAdSubmission({
    destinationUrl: 'https://logo.example',
    imageUrl: 'https://logo.example/mark.png',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.brandName, '');
  assert.equal(result.value.headline, '');
  assert.ok(result.value.imageUrl, 'the image should survive as the ad content');
});

test('a logo-only ad may still carry an optional brand', () => {
  const result = validateAdSubmission({
    brandName: 'Acme',
    destinationUrl: 'https://acme.example',
    imageUrl: 'https://acme.example/logo.png',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.brandName, 'Acme');
  assert.equal(result.value.headline, '');
});

test('an ad with neither text nor image is rejected', () => {
  const result = validateAdSubmission({ destinationUrl: 'https://empty.example' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'brandName'), 'error should name brandName');
  assert.ok(result.errors.some((e) => e.field === 'headline'), 'error should name headline');
});

test('a logo-only ad still needs a destination URL', () => {
  const result = validateAdSubmission({ imageUrl: 'https://logo.example/mark.png' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'destinationUrl'));
});


test('whitespace alone does not satisfy a required field', () => {
  const result = validateAdSubmission({ ...GOOD_AD, headline: '     ' });
  assert.equal(result.ok, false);
});

test('control characters are stripped rather than stored', () => {
  const result = validateAdSubmission({ ...GOOD_AD, brandName: 'Ac\u0000me\u001FCo' });
  assert.equal(result.ok, true);
  assert.equal(result.value.brandName, 'Ac me Co');
  assert.ok(!/[\u0000-\u001F]/.test(result.value.brandName));
});

test('a hostile destination URL fails the whole submission', () => {
  const result = validateAdSubmission({ ...GOOD_AD, destinationUrl: 'javascript:alert(1)' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'destinationUrl'));
});

// --------------------------------------------------------------------------
// Attached images (data: URLs)
//
// The image field is the one place a `data:` URL is allowed, and only for a
// bounded, allow-listed image — because a picked file is embedded in the ad as
// a data URL rather than hosted. Everything the destination rule rejects, the
// image rule must still reject: the relaxation is deliberately narrow.
// --------------------------------------------------------------------------

// A real 1×1 PNG, small enough to embed. This is what a picked file becomes.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('a small allow-listed data:image is accepted and preserved as the image', () => {
  const result = validateAdSubmission({ ...GOOD_AD, imageUrl: TINY_PNG });
  assert.equal(result.ok, true);
  assert.equal(result.value.imageUrl, TINY_PNG);
});

test('a data:image makes an ad logo-only — neither brand nor headline required', () => {
  const result = validateAdSubmission({
    destinationUrl: 'https://logo.example',
    imageUrl: TINY_PNG,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.brandName, '');
  assert.equal(result.value.headline, '');
  assert.equal(result.value.imageUrl, TINY_PNG);
});

test('a data:text/html payload is rejected on the image field', () => {
  for (const hostile of [
    'data:text/html,<script>alert(1)</script>',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  ]) {
    const result = validateAdSubmission({ ...GOOD_AD, imageUrl: hostile });
    assert.equal(result.ok, false, `should reject: ${hostile}`);
    assert.ok(result.errors.some((e) => e.field === 'imageUrl'));
  }
});

test('a data: image whose type is not on the allow-list is rejected', () => {
  const result = validateAdSubmission({
    ...GOOD_AD,
    imageUrl: 'data:image/x-icon;base64,AAAA',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'imageUrl'));
});

test('a data: image larger than the byte cap is rejected', () => {
  // Decoded size ≈ (payload / 4) × 3. Pick a payload that clears the cap, kept
  // a whole number of base64 groups so the shape itself is valid.
  const payloadChars = Math.ceil((MAX_IMAGE_BYTES + 4096) / 3) * 4;
  const oversize = `data:image/png;base64,${'A'.repeat(payloadChars)}`;
  const result = validateAdSubmission({ ...GOOD_AD, imageUrl: oversize });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'imageUrl'));
});

test('a hosted https image is still accepted', () => {
  const result = validateAdSubmission({
    ...GOOD_AD,
    imageUrl: 'https://cdn.example.com/logo.png',
  });
  assert.equal(result.ok, true);
  assert.ok(result.value.imageUrl.startsWith('https://'));
});

test('parseSafeImageSrc: bounded data:image kept, hosted image upgraded, junk refused', () => {
  // A valid attachment comes back canonicalised, unchanged here.
  assert.equal(parseSafeImageSrc(TINY_PNG), TINY_PNG);
  // A hosted image defers to the ordinary URL rule.
  assert.equal(parseSafeImageSrc('example.com/logo.png'), 'https://example.com/logo.png');
  // The relaxation does not extend to executable or non-base64 data URLs.
  for (const bad of [
    'data:text/html,<b>x</b>',
    'data:image/svg+xml,<svg onload=alert(1)></svg>', // not base64 → not matched
    'data:image/png;base64,####', // not valid base64
    'data:image/png;base64,', // empty payload
    'data:image/png;base64,abc', // length not a multiple of 4
    'javascript:alert(1)',
    null,
    undefined,
    42,
  ]) {
    assert.equal(parseSafeImageSrc(bad), null, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('an optional field left blank is not an error', () => {
  const result = validateAdSubmission({
    ...GOOD_AD,
    description: '',
    imageUrl: '',
    ctaText: '',
    buyerEmail: '',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.buyerEmail, null);
});

test('over-long fields are rejected with a message naming the field', () => {
  const cases: Array<[string, string]> = [
    ['brandName', 'b'.repeat(61)],
    ['headline', 'h'.repeat(121)],
    ['description', 'd'.repeat(401)],
    ['ctaText', 'c'.repeat(29)],
  ];

  for (const [field, value] of cases) {
    const result = validateAdSubmission({ ...GOOD_AD, [field]: value });
    assert.equal(result.ok, false, `${field} should have a length limit`);
    assert.ok(result.errors.some((e) => e.field === field), `error should name ${field}`);
  }
});

test('every problem is reported at once', () => {
  const result = validateAdSubmission({
    brandName: '',
    headline: '',
    destinationUrl: 'javascript:void(0)',
    buyerEmail: 'nope',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 4, `expected 4+ errors, got ${result.errors.length}`);
});

test('a missing body does not throw', () => {
  assert.equal(validateAdSubmission({}).ok, false);
});
