// Charles — fuzz households: random people inviting, joining, racing for the
// same code, being let in or turned away, leaving, sharing and unsharing
// their debts, being forgotten, and codes expiring, in any order. After every
// step it checks what must always hold:
//
//   - one household per person; every household has an active owner, at
//     most six active people, at most three open codes;
//   - a person waiting to be let in sees nothing, and is never stranded:
//     someone can always answer for them;
//   - nobody ever sees their own lines as someone else's, or a line from
//     someone outside their household, or a debt or income line from
//     someone who has not chosen to share it;
//   - every shared line is attributed to the right person (each person's
//     figures are unique, so a line's figure says whose it is);
//   - a code is used once, even when two people send it at the same moment;
//   - only the inviter (or, once they have gone, whoever holds the
//     household) can let someone in;
//   - no phone number ever reaches a prompt block.
//
// Runs against the in-memory fake database (test/_fakes.ts), which enforces
// db/0040's unique columns and supabase-js's maybeSingle. Imports are dynamic
// so the environment is set before any module reads it.

interface HouseholdFuzzStats {
  runs: number;
  steps: number;
  ops: Record<string, number>;
  outcomes: Record<string, number>;
  maxMembers: number;
  violations: string[];
  ms: number;
}

const NAMES = ["Nomsa", "Sipho", "Thandi", "Lerato", "Bongani", "Ayanda", "Zanele", "Kagiso", "Palesa"];
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each person's figures are unique, so a shared line's figure names its owner. */
const figures = (i: number) => ({ rent: 1000 + i * 7, debt: 5000 + i * 13, salary: 8000 + i * 17, stokvel: 200 + i * 3 });

export async function fuzzHouseholds(runs: number, seed = 1, steps = 60): Promise<HouseholdFuzzStats> {
  for (const [k, v] of Object.entries({
    SUPABASE_URL: "https://fake.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "fake-service-key",
    OPENROUTER_API_KEY: "fake-openrouter-key",
    WHATSAPP_ACCESS_TOKEN: "fake-wa-token",
    WHATSAPP_PHONE_NUMBER_ID: "1234567890",
    WORKER_SECRET: "fake-worker-secret",
    PUBLIC_BASE_URL: "https://charles.test",
    SESSION_SECRET: "fake-session-secret",
    TRACKING_OFF: "1",
  })) process.env[k] ??= v;

  const fakes = await import("../test/_fakes.ts");
  const dbmod = await import("../api/_lib/db.ts");
  const hh = await import("../api/_lib/household.ts");
  const graph = await import("../api/_lib/graph.ts");
  const net = fakes.installFakeNet();

  const stats: HouseholdFuzzStats = { runs: 0, steps: 0, ops: {}, outcomes: {}, maxMembers: 0, violations: [], ms: 0 };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const t0 = performance.now();
  let restore: (() => void) | null = null;

  try {
    for (let run = 0; run < runs; run++) {
      const r = rng(seed * 1_000_003 + run);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      const db = fakes.makeFakeDb({});
      restore?.();
      restore = dbmod.__setClient(db.client);
      const crowded = run % 3 === 2;
      const people = NAMES.slice(0, crowded ? NAMES.length : 5 + Math.floor(r() * 5)).map((name, i) => ({ name, i, wa: `2780993${String(1000 + i).padStart(4, "0")}`, id: "" }));
      const codes: { code: string; by: number }[] = [];
      const used = new Set<string>();
      const where = (msg: string) => `run ${run} (seed ${seed}): ${msg}`;
      const fail = (msg: string) => {
        if (stats.violations.length < 50) stats.violations.push(where(msg));
      };

      const born = async (p: (typeof people)[number]) => {
        const b = await dbmod.createBusiness(p.wa, "ZA");
        p.id = b.id;
        await dbmod.updateBusiness(b.id, {
          stage: "plan_ready",
          identity: { name: p.name, earns: "x", one_liner: "x", unsure: null },
          answers: { person: p.name, depends: r() < 0.5 ? "Children" : "My mother", owes: r() < 0.5 ? "A mashonisa" : "Nobody" },
        } as never);
        const f = figures(p.i);
        const said = `I pay the rent, R${f.rent} a month. I owe Capfin R${f.debt}. I earn a salary of R${f.salary} a month. I pay R${f.stokvel} a month into my stokvel.`;
        const { kept } = graph.graphUpdates(
          [
            { relation: "pays", object: "rent", amount: f.rent, per: "month" },
            { relation: "owes", object: "Capfin", balance: f.debt },
            { relation: "earns_from", object: "salary", amount: f.salary, per: "month" },
            { relation: "member_of", object: "stokvel", amount: f.stokvel, per: "month" },
          ],
          said,
          "2026-11-02",
        );
        await graph.recordFacts(b.id, kept);
      };
      for (const p of people) await born(p);
      const byId = (id: string) => people.find((p) => p.id === id);
      const bizOf = async (p: (typeof people)[number]) => (await dbmod.findBusinessById(p.id))!;

      /** Who may answer a pending request, worked out from the tables alone. */
      const mayDecide = (pendingRow: Record<string, any>): string | null => {
        const inv = (db.tables.household_invites ?? []).filter((x) => x.used_by === pendingRow.business_id && x.household_id === pendingRow.household_id).sort((a, b) => String(b.used_at).localeCompare(String(a.used_at)))[0];
        const active = (db.tables.household_members ?? []).filter((m) => m.household_id === pendingRow.household_id && m.status === "active");
        if (inv && active.some((m) => m.business_id === inv.created_by)) return inv.created_by as string;
        return (active.find((m) => m.role === "owner")?.business_id as string | undefined) ?? null;
      };

      const check = async (after: string) => {
        const members = db.tables.household_members ?? [];
        const homes = db.tables.households ?? [];
        const invites = db.tables.household_invites ?? [];
        const seen = new Set<string>();
        for (const m of members) {
          if (seen.has(m.business_id)) fail(`${after}: ${byId(m.business_id)?.name} is in two households`);
          seen.add(m.business_id);
          if (!homes.some((h) => h.id === m.household_id)) fail(`${after}: a member row points at a household that is gone`);
          if (!byId(m.business_id)) fail(`${after}: a member row outlived the person`);
        }
        for (const h of homes) {
          const rows = members.filter((m) => m.household_id === h.id);
          const active = rows.filter((m) => m.status === "active");
          const owners = rows.filter((m) => m.role === "owner");
          if (!active.length) fail(`${after}: a household with no active member was left behind`);
          if (owners.length !== 1) fail(`${after}: a household has ${owners.length} owners`);
          if (owners[0] && owners[0].status !== "active") fail(`${after}: the owner is not active`);
          if (active.length > hh.MAX_MEMBERS) fail(`${after}: ${active.length} active members`);
          stats.maxMembers = Math.max(stats.maxMembers, active.length);
          const open = invites.filter((x) => x.household_id === h.id && !x.used_at && Date.parse(x.expires_at) > Date.now());
          if (open.length > 3) fail(`${after}: ${open.length} open codes`);
          for (const pend of rows.filter((m) => m.status === "pending_owner")) {
            if (!mayDecide(pend)) fail(`${after}: ${byId(pend.business_id)?.name} is waiting and nobody can let them in`);
          }
        }
        for (const x of invites) if (!homes.some((h) => h.id === x.household_id)) fail(`${after}: a code outlived its household`);

        for (const p of people) {
          const me = members.find((m) => m.business_id === p.id);
          const view = await hh.householdView(await bizOf(p));
          if (!me || me.status !== "active") {
            if (view) fail(`${after}: ${p.name} sees a household while ${me ? "waiting" : "outside one"}`);
            continue;
          }
          if (!view) {
            fail(`${after}: ${p.name} is active but sees nothing`);
            continue;
          }
          const co = members.filter((m) => m.household_id === me.household_id && m.status === "active");
          if (view.members.length !== co.length) fail(`${after}: ${p.name} sees ${view.members.length} members, there are ${co.length}`);
          if (view.members.filter((m) => m.you).length !== 1) fail(`${after}: ${p.name}'s view does not have exactly one "you"`);
          for (const { who, edge } of view.shared) {
            const owner = people.find((q) => q.name === who);
            const row = owner && co.find((m) => m.business_id === owner.id);
            if (!owner || !row) {
              fail(`${after}: ${p.name} sees a line from ${who}, who is not in their household`);
              continue;
            }
            if (owner.id === p.id) fail(`${after}: ${p.name} sees their own line as someone else's`);
            if ((edge.rel === "owes" || edge.rel === "earns_from") && !row.share_debts) fail(`${after}: ${p.name} sees ${who}'s ${edge.rel} line, which ${who} has not shared`);
            const fig = edge.amount ?? edge.balance;
            if (fig != null) {
              const whose = people.find((q) => Object.values(figures(q.i)).includes(fig));
              if (whose && whose.id !== owner.id) fail(`${after}: ${p.name} sees ${whose.name}'s R${fig} attributed to ${who}`);
            }
          }
          const sheet = hh.householdSheet(view);
          if (/2780993|\d{9,}/.test(sheet)) fail(`${after}: a number reached ${p.name}'s prompt block`);
          if (sheet.length > 1200 || sheet.split("\n").length > 12) fail(`${after}: ${p.name}'s household block is over its cap`);
          for (const q of people) if (q.id !== p.id && !co.some((m) => m.business_id === q.id) && sheet.includes(`- ${q.name}:`)) fail(`${after}: ${p.name}'s block names ${q.name}, who is not in their household`);
        }
      };

      for (let s = 0; s < steps; s++) {
        stats.steps++;
        const p = pick(people);
        // Crowded runs (every third): nobody leaves and the right person
        // always says yes, so households fill up to six and past it.
        let roll = r();
        if (crowded && roll >= 0.66 && roll < 0.95) roll = r() * 0.66;
        let op = "";
        if (roll < 0.2) {
          op = "invite";
          // Crowded: one founder does most of the inviting, so one household grows.
          const from = crowded && r() < 0.8 ? people[0]! : p;
          const res = await hh.createInvite(await bizOf(from));
          if ("code" in res) codes.push({ code: res.code, by: from.i });
          bump(stats.outcomes, `invite:${"code" in res ? "ok" : res.refused}`);
        } else if (roll < 0.4) {
          op = "join";
          const fresh = codes.filter((x) => !used.has(x.code));
          const c = crowded && fresh.length ? pick(fresh).code : codes.length && r() < 0.85 ? pick(codes).code : Array.from({ length: 6 }, () => pick(ALPHABET.split(""))).join("");
          const typed = r() < 0.3 ? c.toLowerCase() : c;
          const res = await hh.requestToJoin(await bizOf(p), typed);
          if ("member" in res || res.refused === "used") used.add(c);
          bump(stats.outcomes, `join:${"member" in res ? "ok" : res.refused}`);
        } else if (roll < 0.46) {
          op = "race";
          if (codes.length) {
            const c = pick(codes).code;
            const q = pick(people.filter((x) => x.id !== p.id));
            const [a, b] = await Promise.all([hh.requestToJoin(await bizOf(p), c), hh.requestToJoin(await bizOf(q), c)]);
            const wins = [a, b].filter((x) => "member" in x).length;
            if (wins > 1) fail(`race: one code let two people in (${p.name}, ${q.name})`);
            bump(stats.outcomes, `race:${wins}`);
          }
        } else if (roll < 0.66) {
          op = "decide";
          const pending = (db.tables.household_members ?? []).filter((m) => m.status === "pending_owner");
          if (pending.length) {
            const row = pick(pending);
            const right = mayDecide(row);
            // Wrong answerers on purpose: often a fellow member who did not make the code.
            const fellows = people.filter((q) => q.id !== right && (db.tables.household_members ?? []).some((m) => m.business_id === q.id && m.household_id === row.household_id && m.status === "active"));
            const decider = (crowded ? r() < 0.8 : r() < 0.5) && right ? byId(right)! : fellows.length && r() < 0.6 ? pick(fellows) : p;
            const yes = crowded || r() < 0.75;
            const res = await hh.decideJoin(await bizOf(decider), row.id, yes);
            if (res && decider.id !== right) fail(`decide: ${decider.name} answered a request that was not theirs to answer`);
            if (!res && decider.id === right && db.tables.household_members!.some((m) => m.id === row.id && m.status === "pending_owner")) fail(`decide: ${decider.name} could not answer their own request`);
            bump(stats.outcomes, `decide:${res ? (res.full ? "full" : yes ? "yes" : "no") : "refused"}`);
          }
        } else if (roll < 0.78) {
          op = "leave";
          bump(stats.outcomes, `leave:${await hh.leaveHousehold(p.id)}`);
        } else if (roll < 0.9) {
          op = "share";
          bump(stats.outcomes, `share:${await hh.setShareDebts(p.id, r() < 0.5)}`);
        } else if (roll < 0.95) {
          op = "forget";
          await dbmod.forgetBusiness(p.id);
          if (await dbmod.findBusinessById(p.id)) fail(`forget: ${p.name} is still there`);
          if ((db.tables.household_members ?? []).some((m) => m.business_id === p.id)) fail(`forget: ${p.name} is still in a household`);
          if ((db.tables.household_invites ?? []).some((x) => x.used_by === p.id || (x.created_by === p.id && !x.used_at))) fail(`forget: ${p.name}'s codes are still there`);
          await born(p);
        } else {
          op = "expire";
          const open = (db.tables.household_invites ?? []).filter((x) => !x.used_at);
          if (open.length) pick(open).expires_at = new Date(Date.now() - 1000).toISOString();
        }
        bump(stats.ops, op);
        await check(`step ${s} ${op} by ${p.name}`);
        if (stats.violations.length >= 50) break;
      }
      stats.runs++;
      if (stats.violations.length >= 50) break;
    }
  } finally {
    restore?.();
    net.restore();
  }
  stats.ms = performance.now() - t0;
  return stats;
}
