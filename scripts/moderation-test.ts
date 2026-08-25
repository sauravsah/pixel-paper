/**
 * Tests for the server-side moderation / safety layer.
 *
 *     node --experimental-strip-types --test scripts/moderation-test.ts
 *
 * `validateAdSubmission` decides whether a submission is the right *shape*;
 * `moderateAdSubmission` decides whether a well-formed submission is *safe to
 * publish* on a page strangers read and click. These cases pin down the second
 * decision: no private/reserved/blocked destination, no stored markup or script,
 * and no false positives on ordinary copy. The rate limiter that guards the same
 * endpoint is exercised at the bottom.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Request } from 'express';

import { moderateAdSubmission, type ModeratedAd } from '../server/moderation.ts';
import { clientIp, createRateLimiter, isLoopback } from '../server/rate-limit.ts';

// A real 1×1 PNG — what a picked file becomes. A bounded data:image is never a
// network destination, so moderation must always leave it alone.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// A submission that has already cleared validation and is entirely benign, so a
// single overridden field is the only thing under test in each case below.
const CLEAN: ModeratedAd = {
  brandName: 'Orbital Coffee',
  headline: 'Roasted above the clouds',
  description: 'Small-batch beans, shipped weekly.',
  destinationUrl: 'https://orbital.coffee/',
  imageUrl: '',
  ctaText: 'Order now',
};

function ad(overrides: Partial<ModeratedAd>): ModeratedAd {
  return { ...CLEAN, ...overrides };
}

/** Convenience: does moderation flag this field at all? */
function flags(a: ModeratedAd, field: string): boolean {
  return moderateAdSubmission(a).some((e) => e.field === field);
}

// --------------------------------------------------------------------------
// The clean baseline
// --------------------------------------------------------------------------

test('a benign ordinary ad passes cleanly', () => {
  assert.deepEqual(moderateAdSubmission(CLEAN), []);
});

test('a benign logo-only ad (data:image, no text) passes cleanly', () => {
  const result = moderateAdSubmission(
    ad({ brandName: '', headline: '', description: '', ctaText: '', imageUrl: TINY_PNG, destinationUrl: 'https://logo.example/' })
  );
  assert.deepEqual(result, []);
});

test('a benign ad with a hosted https image passes cleanly', () => {
  assert.deepEqual(
    moderateAdSubmission(ad({ imageUrl: 'https://cdn.example.com/logo.png' })),
    []
  );
});

// --------------------------------------------------------------------------
// Destination host safety — loopback / private / reserved / metadata
// --------------------------------------------------------------------------

test('private, loopback, link-local and reserved destinations are refused', () => {
  const blocked = [
    'http://localhost/',
    'http://localhost:3000/preview',
    'http://127.0.0.1/',
    'http://127.9.9.9/',
    'http://0.0.0.0/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.0.1/',
    'http://192.168.1.10/',
    'http://169.254.0.1/',
    'http://169.254.169.254/latest/meta-data/', // the cloud metadata address
    'http://100.64.0.1/', // CGNAT
    'http://192.0.2.5/', // TEST-NET-1
    'http://198.18.0.1/', // benchmarking
    'http://198.51.100.9/', // TEST-NET-2
    'http://203.0.113.7/', // TEST-NET-3
    'http://224.0.0.1/', // multicast
    'http://239.255.255.250/', // multicast (SSDP)
    'http://255.255.255.255/', // broadcast
  ];

  for (const destinationUrl of blocked) {
    const result = moderateAdSubmission(ad({ destinationUrl }));
    assert.ok(
      result.some((e) => e.field === 'destinationUrl'),
      `should refuse destination ${destinationUrl}`
    );
  }
});

test('genuinely public IPv4 destinations are allowed', () => {
  const allowed = [
    'http://8.8.8.8/',
    'http://1.1.1.1/',
    'http://172.15.0.1/', // just below the 172.16/12 private block
    'http://172.32.0.1/', // just above it
    'http://192.169.0.1/', // not 192.168
    'http://100.63.0.1/', // just below CGNAT
    'http://100.128.0.1/', // just above CGNAT
  ];

  for (const destinationUrl of allowed) {
    assert.deepEqual(
      moderateAdSubmission(ad({ destinationUrl })),
      [],
      `should allow public destination ${destinationUrl}`
    );
  }
});

test('IPv6 loopback, unique-local and link-local destinations are refused', () => {
  for (const destinationUrl of [
    'http://[::1]/',
    'http://[::]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
  ]) {
    assert.ok(
      flags(ad({ destinationUrl }), 'destinationUrl'),
      `should refuse IPv6 destination ${destinationUrl}`
    );
  }
});

test('IPv4-mapped IPv6 destinations are unwrapped and judged as their IPv4', () => {
  assert.ok(flags(ad({ destinationUrl: 'http://[::ffff:127.0.0.1]/' }), 'destinationUrl'));
  assert.ok(flags(ad({ destinationUrl: 'http://[::ffff:169.254.169.254]/' }), 'destinationUrl'));
  // A mapped *public* address is still fine.
  assert.deepEqual(moderateAdSubmission(ad({ destinationUrl: 'http://[::ffff:8.8.8.8]/' })), []);
});

test('a genuinely global IPv6 destination is allowed', () => {
  assert.deepEqual(
    moderateAdSubmission(ad({ destinationUrl: 'http://[2606:4700:4700::1111]/' })),
    []
  );
});

test('internal-only name suffixes are refused', () => {
  for (const destinationUrl of [
    'https://printer.local/',
    'https://api.internal/',
    'https://box.localhost/',
    'https://nas.lan/',
    'https://service.home.arpa/',
    'https://wiki.intranet/',
  ]) {
    assert.ok(
      flags(ad({ destinationUrl }), 'destinationUrl'),
      `should refuse internal name ${destinationUrl}`
    );
  }
});

test('embedded credentials in the destination are refused', () => {
  assert.ok(flags(ad({ destinationUrl: 'https://user:pass@example.com/' }), 'destinationUrl'));
  assert.ok(flags(ad({ destinationUrl: 'https://admin@example.com/' }), 'destinationUrl'));
});

// --------------------------------------------------------------------------
// Blocked destinations — domains and keywords
// --------------------------------------------------------------------------

test('a blocked domain and its subdomains are refused', () => {
  assert.ok(flags(ad({ destinationUrl: 'https://pornhub.com/' }), 'destinationUrl'));
  assert.ok(flags(ad({ destinationUrl: 'https://www.pornhub.com/watch' }), 'destinationUrl'));
  assert.ok(flags(ad({ destinationUrl: 'https://cdn.media.pornhub.com/x' }), 'destinationUrl'));
  assert.ok(flags(ad({ destinationUrl: 'https://phishing.example/login' }), 'destinationUrl'));
});

test('a domain that merely ends in the same letters is not treated as blocked', () => {
  // "notpornhub.com" is a different registrable domain; suffix matching must be on
  // a dot boundary, not a bare string ending.
  assert.deepEqual(moderateAdSubmission(ad({ destinationUrl: 'https://notpornhub.com/' })), []);
});

test('a blocked keyword in the destination host or path is refused', () => {
  assert.ok(flags(ad({ destinationUrl: 'https://example.com/porn/clip' }), 'destinationUrl'));
  assert.ok(flags(ad({ destinationUrl: 'https://example.com/escort-service' }), 'destinationUrl'));
  assert.ok(flags(ad({ destinationUrl: 'https://example.com/shop?q=counterfeit' }), 'destinationUrl'));
});

test('a blocked keyword does not trip on an innocent longer word', () => {
  // Whole-word matching: "escorted" is not "escort", "popcorn" is not "porn".
  assert.deepEqual(moderateAdSubmission(ad({ destinationUrl: 'https://example.com/escorted-tours' })), []);
  assert.deepEqual(moderateAdSubmission(ad({ destinationUrl: 'https://example.com/popcorn-recipes' })), []);
});

// --------------------------------------------------------------------------
// Markup / script screening in the text fields
// --------------------------------------------------------------------------

test('HTML, event handlers and script URLs are refused in every text field', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<b>bold</b>',
    'click <a href="#">here</a>',
    'onload=alert(1)',
    'javascript:alert(1)',
    'VBScript:msgbox(1)',
  ];

  for (const field of ['brandName', 'headline', 'description', 'ctaText'] as const) {
    for (const payload of payloads) {
      assert.ok(
        flags(ad({ [field]: payload }), field),
        `should refuse ${JSON.stringify(payload)} in ${field}`
      );
    }
  }
});

test('ordinary punctuation and copy are not mistaken for markup', () => {
  const benign = [
    'Rock & Roll',
    'Cats > Dogs',
    'Save 20% — today only',
    'A+ service, guaranteed',
    'Big data: the sequel',
    'Tom & Jerry: reloaded',
  ];

  for (const value of benign) {
    assert.deepEqual(
      moderateAdSubmission(ad({ headline: value })),
      [],
      `should accept benign copy ${JSON.stringify(value)}`
    );
  }
});

test('a blocked keyword is refused in a text field', () => {
  assert.ok(flags(ad({ headline: 'Best XXX deals in town' }), 'headline'));
  assert.ok(flags(ad({ description: 'Hire an escort tonight' }), 'description'));
  assert.ok(flags(ad({ brandName: 'Ransomware Depot' }), 'brandName'));
});

test('a keyword-free field with the same letters inside a word is accepted', () => {
  assert.deepEqual(moderateAdSubmission(ad({ brandName: 'Escorted Getaways' })), []);
  assert.deepEqual(moderateAdSubmission(ad({ headline: 'Fresh popcorn nightly' })), []);
});

// --------------------------------------------------------------------------
// Hosted image host safety
// --------------------------------------------------------------------------

test('a hosted image on a private or blocked host is refused', () => {
  assert.ok(flags(ad({ imageUrl: 'http://192.168.1.10/logo.png' }), 'imageUrl'));
  assert.ok(flags(ad({ imageUrl: 'http://localhost/logo.png' }), 'imageUrl'));
  assert.ok(flags(ad({ imageUrl: 'http://169.254.169.254/logo.png' }), 'imageUrl'));
  assert.ok(flags(ad({ imageUrl: 'https://pornhub.com/logo.png' }), 'imageUrl'));
});

test('a public hosted image and an attached data:image are allowed', () => {
  assert.deepEqual(moderateAdSubmission(ad({ imageUrl: 'https://cdn.example.com/logo.png' })), []);
  assert.deepEqual(moderateAdSubmission(ad({ imageUrl: TINY_PNG })), []);
});

// --------------------------------------------------------------------------
// Shape of the result
// --------------------------------------------------------------------------

test('several problems at once are all reported, each naming its field', () => {
  const result = moderateAdSubmission(
    ad({ destinationUrl: 'http://169.254.169.254/', headline: '<script>alert(1)</script>' })
  );
  assert.ok(result.some((e) => e.field === 'destinationUrl'));
  assert.ok(result.some((e) => e.field === 'headline'));
});

test('every returned problem carries a non-empty human message', () => {
  for (const e of moderateAdSubmission(ad({ destinationUrl: 'http://192.168.0.1/' }))) {
    assert.equal(typeof e.message, 'string');
    assert.ok(e.message.length > 0);
  }
});

// --------------------------------------------------------------------------
// Rate limiter — the anti-spam guard on the same endpoint
// --------------------------------------------------------------------------

test('isLoopback recognises loopback in the spellings Node hands us', () => {
  for (const ip of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '::ffff:127.9.9.9']) {
    assert.equal(isLoopback(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '10.0.0.1', '::ffff:8.8.8.8', '2606:4700::1111', 'unknown']) {
    assert.equal(isLoopback(ip), false, ip);
  }
});

test('clientIp prefers the first x-forwarded-for hop, then the socket address', () => {
  const withForwarded = {
    headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    socket: { remoteAddress: '10.1.1.1' },
  } as unknown as Request;
  assert.equal(clientIp(withForwarded), '203.0.113.5');

  const socketOnly = {
    headers: {},
    socket: { remoteAddress: '198.51.100.9' },
  } as unknown as Request;
  assert.equal(clientIp(socketOnly), '198.51.100.9');

  const bracketedV6 = {
    headers: { 'x-forwarded-for': '[2606:4700::1111]' },
    socket: {},
  } as unknown as Request;
  assert.equal(clientIp(bracketedV6), '2606:4700::1111');

  const nothing = { headers: {}, socket: {} } as unknown as Request;
  assert.equal(clientIp(nothing), 'unknown');
});

test('a non-loopback key is allowed up to the cap, then blocked', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3, exemptLoopback: true });
  const ip = '203.0.113.42';

  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.check(ip).allowed, true, `request ${i + 1} should be allowed`);
  }

  const overflow = limiter.check(ip);
  assert.equal(overflow.allowed, false, 'the 4th request should be blocked');
  assert.ok(Number.isInteger(overflow.retryAfterSec) && overflow.retryAfterSec >= 1);
});

test('loopback is exempt by default and never blocked', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, exemptLoopback: true });
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.check('127.0.0.1').allowed, true);
  }
  assert.equal(limiter.check('127.0.0.1').retryAfterSec, 0);
});

test('loopback can be limited too when the exemption is turned off', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, exemptLoopback: false });
  assert.equal(limiter.check('127.0.0.1').allowed, true);
  assert.equal(limiter.check('127.0.0.1').allowed, false);
});

test('distinct keys are counted independently', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, exemptLoopback: true });
  assert.equal(limiter.check('198.51.100.1').allowed, true);
  assert.equal(limiter.check('198.51.100.2').allowed, true); // different key, own budget
  assert.equal(limiter.check('198.51.100.1').allowed, false); // first key now over cap
});
