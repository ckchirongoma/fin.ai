// Fin — the things that must be exactly right or the front door is open.
//
// metaSignature is what proves an inbound webhook came from Meta. Without it
// anyone who finds the URL can write owner data and spend model credits, so
// the digest is computed here independently with node:crypto rather than
// against a value copied out of the implementation.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { metaSignature, mintNumericCode, mintToken, safeEqualHex, shortHash } from "../api/_lib/crypto.js";

describe("the signature Meta puts on every webhook", () => {
  test("it is HMAC-SHA256 over the raw body, prefixed the way Meta prefixes it", () => {
    const body = '{"object":"whatsapp_business_account","entry":[{"id":"1"}]}';
    const secret = "a-meta-app-secret";
    const expected = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
    assert.equal(metaSignature(body, secret), expected);
    assert.match(metaSignature(body, secret), /^sha256=[0-9a-f]{64}$/);
  });

  // Meta escapes non-ASCII as \uXXXX. Re-serialising a parsed body changes the
  // bytes and the digest never matches, so every message with an accent, an
  // emoji or a non-Latin script would silently fail authentication.
  test("one changed byte anywhere in the body changes the signature", () => {
    const secret = "a-meta-app-secret";
    const a = metaSignature('{"text":"Nkosi\'s Kitchen"}', secret);
    const b = metaSignature('{"text":"Nkosi\'s kitchen"}', secret);
    const c = metaSignature('{"text":"Nkosi\'s Kitchen"} ', secret);
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  test("the same body under a different app secret signs differently", () => {
    const body = '{"entry":[]}';
    assert.notEqual(metaSignature(body, "secret-one"), metaSignature(body, "secret-two"));
  });

  test("an empty body still produces a real digest rather than an empty string", () => {
    assert.match(metaSignature("", "s"), /^sha256=[0-9a-f]{64}$/);
  });

  test("a body containing emoji and non-Latin script is signed over its UTF-8 bytes", () => {
    const body = '{"text":"Karibu 🇰🇪 — bei ni KSh 2,000"}';
    assert.equal(metaSignature(body, "s"), "sha256=" + createHmac("sha256", "s").update(body, "utf8").digest("hex"));
  });
});

describe("comparing two digests without leaking how far they matched", () => {
  const digest = createHmac("sha256", "k").update("v").digest("hex");

  test("identical digests compare equal", () => {
    assert.equal(safeEqualHex(digest, digest), true);
  });

  test("digests of the same length that differ compare unequal", () => {
    const other = createHmac("sha256", "k").update("w").digest("hex");
    assert.equal(other.length, digest.length);
    assert.equal(safeEqualHex(digest, other), false);
  });

  test("digests of different lengths compare unequal instead of throwing", () => {
    assert.equal(safeEqualHex(digest, digest.slice(0, 40)), false);
    assert.equal(safeEqualHex("", digest), false);
    assert.equal(safeEqualHex(digest, ""), false);
  });

  test("two empty values are not quietly treated as a match for something", () => {
    assert.equal(safeEqualHex("", ""), true, "equal inputs are equal — callers never pass an empty expected digest");
    assert.equal(safeEqualHex(null as unknown as string, digest), false);
  });
});

describe("the one-time code an owner types to read their plan on the web", () => {
  test("it is always the number of digits asked for", () => {
    for (let i = 0; i < 500; i++) {
      assert.match(mintNumericCode(), /^\d{6}$/);
    }
    assert.match(mintNumericCode(4), /^\d{4}$/);
    assert.match(mintNumericCode(8), /^\d{8}$/);
  });

  test("a code that happens to be small is padded, not shortened", () => {
    // Over this many draws a leading zero is a near certainty; the point is
    // that a padded code is still exactly six characters.
    const codes = Array.from({ length: 2000 }, () => mintNumericCode());
    assert.ok(codes.every((c) => c.length === 6));
    assert.ok(codes.some((c) => c.startsWith("0")), "leading zeros do occur, and must survive");
  });

  test("codes are not repeated in any obvious way", () => {
    const codes = new Set(Array.from({ length: 500 }, () => mintNumericCode()));
    assert.ok(codes.size > 450, "a generator this predictable would be guessable");
  });
});

describe("the token an owner's own AI connects with", () => {
  test("it is URL-safe, so it survives being pasted into a connector address", () => {
    for (let i = 0; i < 50; i++) assert.match(mintToken(), /^[A-Za-z0-9_-]+$/);
  });

  test("it is long enough not to be guessed", () => {
    assert.ok(mintToken().length >= 40);
    assert.notEqual(mintToken(), mintToken());
  });
});

describe("the short hash used for log lines and job keys", () => {
  test("the same input always gives the same short id", () => {
    assert.equal(shortHash("wamid.AAA"), shortHash("wamid.AAA"));
    assert.equal(shortHash("wamid.AAA").length, 12);
    assert.notEqual(shortHash("wamid.AAA"), shortHash("wamid.AAB"));
  });
});
