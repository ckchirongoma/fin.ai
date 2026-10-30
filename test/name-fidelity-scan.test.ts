// Fin — name fidelity must never rewrite ordinary prose into a place name.
//
// Review of 4e685e5 (2026-09-23): an independent reviewer ran 2,632 ordinary
// words (every distinct word in this repo's docs and prompts) against ~120
// real place names across the four markets, and found the single-word rule
// rewriting "welcome" -> "Welkom", "worker" -> "Worcester", "durable" ->
// "Durban", "machines" -> "Machakos", "greeting" -> "Greenpoint" and more.
// This is that scan, kept: zero rewrites allowed, in lower case and at the
// start of a sentence.
//
// Known, accepted residual: an ordinary word written in Title Case in the
// MIDDLE of a sentence ("...and Worker and...") can still be read as a
// drifted name, because that is exactly the shape of the real incident
// ("in Woodwood search", four edits from "Woodstock"). Replies almost never
// capitalise an ordinary word mid-sentence; tightening further would miss
// the incident itself.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
process.env.OPENROUTER_API_KEY = "k";
process.env.WHATSAPP_ACCESS_TOKEN = "k";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.WORKER_SECRET = "k";

import { installFakeNet, makeFakeDb } from "./_fakes.ts";

let safety: typeof import("../api/_lib/safety.ts");
let restore: () => void;
let net: ReturnType<typeof installFakeNet>;
before(async () => {
  net = installFakeNet();
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(makeFakeDb({}).client);
  safety = await import("../api/_lib/safety.ts");
});
after(() => {
  restore?.();
  net?.restore();
});

const PLACES = ["Woodstock, Cape Town","Phuthaditjhaba, Free State","Soweto, Johannesburg","Durban, KwaZulu-Natal","Pietermaritzburg","Polokwane, Limpopo","Mthatha, Eastern Cape","Khayelitsha","Mitchells Plain","Bloemfontein","Kimberley","Stellenbosch","Pretoria","Centurion","Midrand","Sandton","Randburg","Germiston","Benoni","Kempton Park","Tembisa","Mamelodi","Rustenburg","Mahikeng","Nelspruit","Mbombela","George, Western Cape","Upington","Paarl","Worcester","Hermanus","Knysna","Port Elizabeth","Gqeberha","East London","Richards Bay","Newcastle","Ladysmith","Welkom","Kroonstad","Vereeniging","Vanderbijlpark","Potchefstroom","Klerksdorp","Nairobi","Westlands","Kibera","Eastleigh","Mombasa","Kisumu","Nakuru","Eldoret","Thika","Machakos","Kiambu","Kakamega","Lagos","Ikeja","Surulere","Lekki","Abuja","Garki","Kano","Ibadan","Port Harcourt","Enugu","Benin City","Onitsha","Warri","Kaduna","Accra","Kumasi","Tamale","Takoradi","Cape Coast","Tema","Madina","Kasoa","Sunyani","Nima","Osu","Legon","Market Street","Main Road","Church Street","Station Road","Victoria Road","Longmarket","Greenpoint","Seapoint","Observatory","Salt River","Parklands","Brooklyn","Hatfield","Arcadia","Sunnyside","Northcliff","Parkhurst","Rosebank","Melville","Braamfontein","Diepsloot","Alexandra","Orange Farm","Lenasia","Chatsworth","Umlazi","Pinetown","Westville","Ballito"];

const vocab = readFileSync(new URL("./fixtures/prose-vocab.txt", import.meta.url), "utf8").split("\n").filter(Boolean);
const title = (w: string) => w[0]!.toUpperCase() + w.slice(1);

test("no ordinary word is ever rewritten into any of ~120 real place names", async () => {
  const variants = [vocab.join(" "), vocab.map((w) => `${title(w)} works.`).join(" ")];
  const hits: string[] = [];
  for (const place of PLACES) {
    for (const msg of variants) {
      const r = await safety.checkNameFidelity(msg, { location: place });
      if (r.message !== msg) hits.push(place);
    }
  }
  assert.deepEqual([...new Set(hits)], []);
});

test("while real drifts of those same names are still corrected", async () => {
  for (const [msg, place, fixed] of [
    ["Property managers in Woodwood search for tests.", "Woodstock, Cape Town", "Property managers in Woodstock search for tests."],
    ["Customers in Durbin love it.", "Durban, KwaZulu-Natal", "Customers in Durban love it."],
    ["Customers in Phutaditjhaba love it.", "Phuthaditjhaba, Free State", "Customers in Phuthaditjhaba love it."],
    ["Deliveries around Pietermaritsburg daily.", "Pietermaritzburg", "Deliveries around Pietermaritzburg daily."],
  ] as const) {
    assert.equal((await safety.checkNameFidelity(msg, { location: place })).message, fixed);
  }
});
