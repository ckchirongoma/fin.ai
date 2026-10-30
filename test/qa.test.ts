// Charles — the guard on fetching a link an owner forwarded.
//
// "Is this legit?" is one of the three answer paths, and it means this backend
// will fetch a URL a stranger sent over WhatsApp. That is a server-side
// request forgery hole unless the destination is checked first: the backend
// sits inside a hosting network and holds the Supabase service-role key, so a
// link pointing at a loopback address, a private range, or a cloud metadata
// endpoint has to be refused before fetch() is called.
//
// The tests marked BUG below describe what the guard is supposed to do and
// currently does not. They are skipped rather than deleted so the intent is
// recorded next to the evidence.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isFetchableUrl, URL_RE } from "../api/_lib/engine/qa.js";

describe("links Charles is allowed to fetch", () => {
  test("an ordinary public page is fine", () => {
    for (const url of [
      "https://www.cipc.co.za/?page_id=3036",
      "https://sedfa.org.za/funding",
      "http://example.co.ke/offer",
      "https://www.kra.go.ke/individual/filing-paying",
    ]) {
      assert.equal(isFetchableUrl(url), true, url);
    }
  });

  test("a public address with a port or a query string is still fine", () => {
    assert.equal(isFetchableUrl("https://example.com:8443/a?b=c#d"), true);
  });
});

describe("links Charles must refuse", () => {
  test("anything that is not http or https", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "gopher://example.com/x",
      "data:text/html,<script>fetch('/')</script>",
      "javascript:alert(1)",
      "chrome://settings",
    ]) {
      assert.equal(isFetchableUrl(url), false, url);
    }
  });

  test("something that is not a URL at all, rather than throwing mid-answer", () => {
    for (const x of ["", "not a url", "example.com", "   ", "http://"]) {
      assert.equal(isFetchableUrl(x), false, JSON.stringify(x));
    }
  });

  test("the machine itself, by name", () => {
    assert.equal(isFetchableUrl("http://localhost:3000/api/worker"), false);
    assert.equal(isFetchableUrl("http://LOCALHOST/"), false);
  });

  test("the machine itself, over IPv6", () => {
    assert.equal(isFetchableUrl("http://[::1]:3000/api/worker"), false);
  });

  test("internal service discovery names", () => {
    assert.equal(isFetchableUrl("http://supabase.internal/rest/v1/businesses"), false);
    assert.equal(isFetchableUrl("http://printer.local/"), false);
  });

  test(
    "the machine itself, by loopback address",
    () => {
      assert.equal(isFetchableUrl("http://127.0.0.1:3000/api/worker"), false);
      assert.equal(isFetchableUrl("http://127.0.0.1/"), false);
      assert.equal(isFetchableUrl("http://0.0.0.0/"), false);
    },
  );

  test(
    "private network ranges",
    () => {
      assert.equal(isFetchableUrl("http://10.0.0.5/admin"), false);
      assert.equal(isFetchableUrl("http://172.16.0.1/"), false);
      assert.equal(isFetchableUrl("http://172.31.255.254/"), false);
      assert.equal(isFetchableUrl("http://192.168.1.1/"), false);
    },
  );

  test(
    "the cloud metadata endpoint",
    () => {
      assert.equal(isFetchableUrl("http://169.254.169.254/latest/meta-data/iam/security-credentials/"), false);
      assert.equal(isFetchableUrl("http://169.254.170.2/v2/credentials"), false);
    },
  );
});

describe("finding a link in what the owner wrote", () => {
  test("a forwarded link is picked out of the message around it", () => {
    assert.equal("is this legit? https://sedfa.org.za/funding someone sent me".match(URL_RE)?.[0], "https://sedfa.org.za/funding");
  });

  test("a message with no link finds none", () => {
    assert.equal("is this legit? someone sent me a form".match(URL_RE), null);
  });
});
