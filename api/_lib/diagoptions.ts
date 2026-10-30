// Fin — the fixed options of the diagnostic questions that the plan needs
// to recognise again later, on their own.
//
// The diagnostic (diagnostic.ts) asks them; the plan's hand-over
// (playbooks.ts problemPhrase) has to recognise them when the "problem in
// their words" is only the labels the person tapped. Kept here so the
// playbooks need not import the diagnostic and everything it pulls in (the
// WhatsApp client, the database).

/** "Is that mainly about any of these?" — what they are aiming at. */
export const OBJECTIVE_KIND_OPTIONS = ["Get out of debt", "Have something saved", "Fix my credit record", "Make the month fit", "Protect my family", "Something else"] as const;

/** "What's getting in the way right now?" */
export const BLOCKER_OPTIONS = [
  "Repayments eat my pay",
  "Family needs money from me",
  "The month is longer than the money",
  "A mashonisa or loan shark",
  "Nothing saved for emergencies",
  "I don't know where it goes",
  "Fees and airtime eat it",
  "Nothing major, I want to get ahead",
] as const;

/** "Who do you owe money to right now?" */
export const OWES_OPTIONS = ["A bank loan or card", "A clothing or furniture account", "A cellphone contract", "A mashonisa", "Stokvel, family or friends", "Nobody"] as const;

/** "If something broke tomorrow, what could you reach?" */
export const CUSHION_OPTIONS = ["Nothing", "Less than a week's spend", "About a month", "More than a month"] as const;

/** "What cover do you have?" */
export const COVER_OPTIONS = ["Funeral policy", "Burial society", "Medical aid", "Life cover", "None", "Not sure"] as const;

/** "How does money come in?" */
export const INCOME_KIND_OPTIONS = ["Salary or wage", "Piece jobs or hustle", "SASSA grant", "My own business", "Family or partner", "A mix, not sure"] as const;

/** "Who depends on your money?" */
export const DEPENDS_OPTIONS = ["Just me", "A partner", "Children", "Parents or elders", "Extended family", "Not sure"] as const;

/** "How do you keep track of your money?" */
export const RECORDS_OPTIONS = ["In my head", "A notebook", "The bank app", "A spreadsheet or app", "Someone helps me"] as const;

/**
 * A multi-select answer split back into the labels picked. They are stored
 * joined with ", ", and some labels carry a comma of their own ("Stokvel,
 * family or friends"), so known labels are matched whole, longest first;
 * anything else falls back to its comma-separated pieces.
 */
export function splitPicks(text: string, options: readonly string[]): string[] {
  const known = [...options].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  let rest = String(text ?? "").trim();
  while (rest) {
    const hit = known.find((k) => rest.toLowerCase().startsWith(k.toLowerCase()) && /^(?:\s*,\s*|\s*$)/.test(rest.slice(k.length)));
    if (hit) {
      out.push(hit);
      rest = rest.slice(hit.length).replace(/^\s*,\s*/, "");
      continue;
    }
    const cut = rest.indexOf(",");
    const piece = (cut < 0 ? rest : rest.slice(0, cut)).trim();
    if (piece) out.push(piece);
    rest = cut < 0 ? "" : rest.slice(cut + 1).trim();
  }
  return out;
}
