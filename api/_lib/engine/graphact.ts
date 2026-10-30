// Charles — sending the one action the knowledge graph earned (graphactions.ts).
//
// Called after the memory step changed the graph, and after a statement is
// read. The reply has already gone: this is the follow-on, never instead of
// it, and it never throws.

import { householdGraph } from "../graph.js";
import { nextGraphAction } from "../graphactions.js";
import { sendButtons } from "../wa.js";
import type { Business } from "../types.js";

export async function actOnGraph(biz: Business): Promise<boolean> {
  try {
    const action = await nextGraphAction(biz, await householdGraph(biz));
    if (!action) return false;
    await sendButtons(biz.wa_id, action.text, action.buttons, biz.id);
    return true;
  } catch (err) {
    console.warn("actOnGraph: not sent", err);
    return false;
  }
}
