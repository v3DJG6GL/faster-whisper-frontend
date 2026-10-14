import { ruleListOf, ruleMapWritable } from "@/lib/pipelineMap";
import type { PipelineFetch, PipelineRule } from "@/lib/types";

/** The word-mapping lists onboarding's quick-add step may offer: only those Quick add itself will
 *  write to (`ruleMapWritable`, the gate QuickAdd enforces on the pinned list). Offering a locked
 *  one would pin a list the first quick-add summon refuses, and the step's empty-state notice
 *  promises that what it lists is editable. */
export function quickAddListsOf(res: PipelineFetch): PipelineRule[] {
  return ruleListOf(res).filter((r) => r.type === "callback:map" && ruleMapWritable(r, res.state));
}
