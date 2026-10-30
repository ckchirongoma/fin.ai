// Fin — reading what Meta sends.
//
// parseWebhook is the front door, and every failure here is invisible: a
// delivery receipt mistaken for a message replies to an owner who said
// nothing; a batched POST read at [0] drops two voice notes without an error
// anywhere; a list tap read as text falls through to the diagnostic's parser
// and is stored as an answer to whatever was asked last.
//
// The payload shapes below follow Meta's Cloud API webhook reference.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { WA, clip, isMetaMediaHost, parseWebhook, withinServiceWindow } from "../api/_lib/wa.js";

const envelope = (value: Record<string, unknown>, field = "messages") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", changes: [{ value: { messaging_product: "whatsapp", ...value }, field }] }],
});

const from = "27809930003";

describe("reading one message out of a webhook", () => {
  test("a typed message arrives with its text and its sender", () => {
    const { messages, statuses } = parseWebhook(
      envelope({ messages: [{ from, id: "wamid.AAA", timestamp: "1758240000", type: "text", text: { body: "how do I register?" } }] }),
    );
    assert.equal(messages.length, 1);
    assert.equal(statuses.length, 0);
    const m = messages[0]!;
    assert.equal(m.kind, "text");
    assert.equal(m.text, "how do I register?");
    assert.equal(m.from, from);
    assert.equal(m.waMessageId, "wamid.AAA");
    assert.equal(m.timestamp, 1758240000_000, "Meta sends seconds; everything downstream works in milliseconds");
  });

  // CLAUDE.md rule 7: the tap is the id, never the visible label.
  test("a tapped reply button arrives as its action id, not as its label", () => {
    const { messages } = parseWebhook(
      envelope({
        messages: [
          {
            from,
            id: "wamid.BBB",
            timestamp: "1758240001",
            type: "interactive",
            interactive: { type: "button_reply", button_reply: { id: "a.step.next", title: "Next step" } },
          },
        ],
      }),
    );
    const m = messages[0]!;
    assert.equal(m.kind, "button");
    assert.equal(m.actionId, "a.step.next");
    assert.equal(m.actionLabel, "Next step");
    assert.equal(m.text, "", "a tap has no text to re-parse");
  });

  // The first version read button_reply only, so every list tap arrived as
  // empty text and fell through to the diagnostic's text parser.
  test("a tapped list row arrives as its action id too", () => {
    const { messages } = parseWebhook(
      envelope({
        messages: [
          {
            from,
            id: "wamid.CCC",
            timestamp: "1758240002",
            type: "interactive",
            interactive: { type: "list_reply", list_reply: { id: "d.1.2", title: "Not yet, it's an idea" } },
          },
        ],
      }),
    );
    const m = messages[0]!;
    assert.equal(m.kind, "list");
    assert.equal(m.actionId, "d.1.2");
    assert.equal(m.text, "");
  });

  test("a quick reply on a template arrives as a button, carrying its payload", () => {
    const { messages } = parseWebhook(
      envelope({ messages: [{ from, id: "wamid.DDD", timestamp: "1758240003", type: "button", button: { payload: "a.step.next", text: "Next step" } }] }),
    );
    assert.equal(messages[0]!.kind, "button");
    assert.equal(messages[0]!.actionId, "a.step.next");
  });

  test("a voice note arrives as audio with the media id needed to fetch it", () => {
    const { messages } = parseWebhook(
      envelope({
        messages: [{ from, id: "wamid.EEE", timestamp: "1758240004", type: "audio", audio: { id: "1234567890", mime_type: "audio/ogg; codecs=opus", voice: true } }],
      }),
    );
    const m = messages[0]!;
    assert.equal(m.kind, "audio");
    assert.equal(m.mediaId, "1234567890");
    assert.equal(m.mimeType, "audio/ogg; codecs=opus");
  });

  test("a forwarded document keeps its caption, and falls back to its filename", () => {
    const withCaption = parseWebhook(
      envelope({
        messages: [{ from, id: "wamid.FFF", timestamp: "1758240005", type: "document", document: { id: "m1", mime_type: "application/pdf", caption: "is this legit?", filename: "quote.pdf" } }],
      }),
    ).messages[0]!;
    assert.equal(withCaption.kind, "document");
    assert.equal(withCaption.text, "is this legit?");
    assert.equal(withCaption.mediaId, "m1");

    const noCaption = parseWebhook(
      envelope({ messages: [{ from, id: "wamid.GGG", timestamp: "1758240006", type: "document", document: { id: "m2", filename: "SARS-letter.pdf" } }] }),
    ).messages[0]!;
    assert.equal(noCaption.text, "SARS-letter.pdf", "the filename is the only clue we have about an uncaptioned file");
  });

  test("a message type we do not handle is still surfaced, so it can be answered rather than ignored", () => {
    const { messages } = parseWebhook(envelope({ messages: [{ from, id: "wamid.HHH", timestamp: "1758240007", type: "sticker", sticker: { id: "s1" } }] }));
    assert.equal(messages[0]!.kind, "unsupported");
  });

  test("a message with no id or no sender is dropped rather than creating a business row for nobody", () => {
    const { messages } = parseWebhook(
      envelope({ messages: [{ id: "wamid.III", timestamp: "1", type: "text", text: { body: "hi" } }, { from, timestamp: "1", type: "text", text: { body: "hi" } }] }),
    );
    assert.equal(messages.length, 0);
  });
});

// Every outbound message generates several of these on the SAME `messages`
// field. Treating one as a message replies to an owner who said nothing.
describe("delivery receipts are not messages", () => {
  test("a statuses-only payload yields zero messages", () => {
    const { messages, statuses } = parseWebhook(
      envelope({
        statuses: [
          { id: "wamid.OUT1", status: "sent", timestamp: "1758240000", recipient_id: from, conversation: { id: "c1", expiration_timestamp: "1758326400" } },
          { id: "wamid.OUT1", status: "delivered", timestamp: "1758240005", recipient_id: from },
          { id: "wamid.OUT1", status: "read", timestamp: "1758240060", recipient_id: from },
        ],
      }),
    );
    assert.equal(messages.length, 0, "a delivery receipt must never be treated as something the owner said");
    assert.equal(statuses.length, 3);
    assert.equal(statuses[0]!.status, "sent");
    assert.equal(statuses[0]!.recipient, from);
    assert.equal(statuses[0]!.windowExpiresAt, 1758326400_000, "Meta's own end of the 24-hour window, in milliseconds");
    assert.equal(statuses[1]!.windowExpiresAt, null);
  });

  test("a failed send carries Meta's error code and detail", () => {
    const { statuses } = parseWebhook(
      envelope({
        statuses: [
          {
            id: "wamid.OUT2",
            status: "failed",
            recipient_id: from,
            errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "Message failed to send because more than 24 hours have passed" } }],
          },
        ],
      }),
    );
    assert.equal(statuses[0]!.errorCode, 131047);
    assert.match(statuses[0]!.errorDetail ?? "", /24 hours/);
  });

  test("statuses and messages in the same change are kept apart", () => {
    const { messages, statuses } = parseWebhook(
      envelope({
        statuses: [{ id: "wamid.OUT3", status: "read", recipient_id: from }],
        messages: [{ from, id: "wamid.JJJ", timestamp: "1758240100", type: "text", text: { body: "done" } }],
      }),
    );
    assert.equal(messages.length, 1);
    assert.equal(statuses.length, 1);
    assert.equal(messages[0]!.text, "done");
  });
});

// Meta batches. Three voice notes in a row can arrive as one POST.
describe("a batched delivery", () => {
  test("every message across every entry and every change comes back", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "e1",
          changes: [
            { field: "messages", value: { messages: [{ from, id: "w1", timestamp: "1", type: "text", text: { body: "one" } }] } },
            { field: "messages", value: { messages: [{ from, id: "w2", timestamp: "2", type: "text", text: { body: "two" } }] } },
          ],
        },
        {
          id: "e2",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  { from, id: "w3", timestamp: "3", type: "text", text: { body: "three" } },
                  { from, id: "w4", timestamp: "4", type: "text", text: { body: "four" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const { messages } = parseWebhook(body);
    assert.deepEqual(messages.map((m) => m.text), ["one", "two", "three", "four"]);
  });

  test("a change on a field we did not ask about is ignored", () => {
    const body = {
      entry: [
        {
          id: "e1",
          changes: [
            { field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "next_step" } },
            { field: "account_update", value: { event: "VERIFIED_ACCOUNT" } },
            { field: "messages", value: { messages: [{ from, id: "w9", timestamp: "9", type: "text", text: { body: "real" } }] } },
          ],
        },
      ],
    };
    const { messages } = parseWebhook(body);
    assert.deepEqual(messages.map((m) => m.text), ["real"]);
  });
});

describe("a body that is not what we expected", () => {
  test("nonsense comes back empty instead of throwing at the front door", () => {
    for (const body of [null, undefined, {}, "", 0, [], { entry: null }, { entry: "nope" }, { entry: [{}] }, { entry: [null] }, { entry: [{ changes: "nope" }] }, { entry: [{ changes: [] }] }, { entry: [{ changes: [{ field: "messages" }] }] }, { entry: [{ changes: [{ field: "messages", value: {} }] }] }]) {
      const out = parseWebhook(body);
      assert.deepEqual(out, { messages: [], statuses: [] }, `parseWebhook(${JSON.stringify(body)}) must not throw`);
    }
  });

  test(
    "a null change does not take the rest of the batch down with it",
    () => {
      const { messages } = parseWebhook({
        entry: [{ id: "e1", changes: [null, { field: "messages", value: { messages: [{ from, id: "w11", timestamp: "1", type: "text", text: { body: "still here" } }] } }] }],
      });
      assert.deepEqual(messages.map((m) => m.text), ["still here"]);
    },
  );

  test("an interactive message of a type we do not handle does not become an empty text message", () => {
    const { messages } = parseWebhook(
      envelope({ messages: [{ from, id: "w10", timestamp: "1", type: "interactive", interactive: { type: "something_new" } }] }),
    );
    assert.equal(messages[0]!.kind, "unsupported", "an unreadable interactive gets a real reply, not an empty answer to the last question");
    assert.equal(messages[0]!.text, "");
  });
});

describe("WhatsApp's own limits", () => {
  test("text that fits is left exactly as it was", () => {
    assert.equal(clip("Next step", 20), "Next step");
    assert.equal(clip("12345678901234567890", 20), "12345678901234567890", "exactly at the limit is not over it");
  });

  test("text that does not fit is cut to the limit, ellipsis included", () => {
    const out = clip("123456789012345678901", 20);
    assert.equal(out.length, 20, "a 21-character button title is a rejected message, not a truncated one");
    assert.ok(out.endsWith("…"));
  });

  test("surrounding whitespace never eats into the budget", () => {
    assert.equal(clip("   Next step   ", 20), "Next step");
    assert.equal(clip("", 20), "");
  });

  test("the limits are Meta's, not ours", () => {
    assert.equal(WA.buttons, 3);
    assert.equal(WA.buttonTitleChars, 20);
    assert.equal(WA.listRows, 10);
  });
});

describe("the 24-hour customer service window", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

  test("someone who messaged an hour ago can be replied to freely", () => {
    assert.equal(withinServiceWindow(hoursAgo(1)), true);
  });

  test("someone who messaged twenty-five hours ago needs an approved template", () => {
    assert.equal(withinServiceWindow(hoursAgo(25)), false);
  });

  test("someone who has never messaged is outside it", () => {
    assert.equal(withinServiceWindow(null), false);
    assert.equal(withinServiceWindow(undefined), false);
    assert.equal(withinServiceWindow(""), false);
  });

  test("an unreadable timestamp is treated as outside the window, not inside it", () => {
    assert.equal(withinServiceWindow("never"), false, "the safe assumption costs a template; the unsafe one costs a delivery");
  });
});

// Inbound media is a two-step fetch and the second request carries our access
// token, so a poisoned metadata response must not be able to redirect it.
describe("where the access token is allowed to be sent", () => {
  test("Meta's own media hosts over https are accepted", () => {
    for (const url of [
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
      "https://mmg.whatsapp.net/d/f/abc.enc",
      "https://scontent.xx.fbcdn.net/v/t1.png",
    ]) {
      assert.equal(isMetaMediaHost(url), true, `${url} is Meta's`);
    }
  });

  test("plain http is refused, whoever it claims to be", () => {
    assert.equal(isMetaMediaHost("http://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1"), false);
  });

  test("a lookalike domain is refused", () => {
    for (const url of [
      "https://fbsbx.com.evil.com/whatsapp_business/attachments/",
      "https://notfbsbx.com/x",
      "https://lookaside.fbsbx.com.attacker.net/x",
      "https://evil.com/?u=lookaside.fbsbx.com",
      "https://attacker.example/steal",
    ]) {
      assert.equal(isMetaMediaHost(url), false, `${url} must not receive our token`);
    }
  });

  test("something that is not a URL at all is refused rather than throwing", () => {
    assert.equal(isMetaMediaHost("not a url"), false);
    assert.equal(isMetaMediaHost(""), false);
  });
});
