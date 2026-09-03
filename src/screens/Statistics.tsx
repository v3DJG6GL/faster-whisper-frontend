// Dedicated Statistics page — the full usage document lifted off Home so the home
// screen stays focused on dictation: one filter bar (range · kind · with-stages), the
// per-kind tiles, the stacked columns by kind, the Stages / Dictation / Rhythm / When-you-
// dictate panels. Reached from the sidebar, the "View statistics →" link on Home, or a
// Home small multiple (`?kind=file` preselects that kind). The filters live in the URL
// (`?kind=&with=&range=&from=&to=`) so a reload or a deep link lands on the same view, and
// in the store (`usageViewQuery`) so the controller fetches the matching document. The kind
// and the measure (`?kind=`, `?metric=`) are client-side: they change what the page shows of
// the document it already has, never the fetch.

import { BarChart3 } from "lucide-react";
import { screenEyebrow, screenTitle } from "@/lib/screens";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { StatisticsView } from "@/components/UsageStats";
import { PageHeader } from "@/components/ui";
import { useApp } from "@/lib/store";
import { pageQueryParams, parsePageQuery, type ChartMetric, type Rhythm, type UsagePageQuery, type UsageScope } from "@/lib/usageDerive";

export default function Statistics() {
  const [searchParams, setSearchParams] = useSearchParams();
  const setUsageViewQuery = useApp((s) => s.setUsageViewQuery);
  // Read once on mount; the controls own it from there and mirror it back to the URL.
  const [state, setState] = useState(() => parsePageQuery((k) => searchParams.get(k)));
  // react-router re-creates setSearchParams whenever the URL changes, so it must not be an
  // effect dependency: the write below would change the URL and re-run itself forever.
  const setParams = useRef(setSearchParams);
  setParams.current = setSearchParams;
  useEffect(() => {
    setUsageViewQuery(state.query);
    setParams.current(pageQueryParams(state.scope, state.query, state.metric, state.rhythm), { replace: true });
  }, [state, setUsageViewQuery]);
  const setScope = (scope: UsageScope) => setState((s) => ({ ...s, scope }));
  const setQuery = (query: UsagePageQuery) => setState((s) => ({ ...s, query }));
  const setMetric = (metric: ChartMetric) => setState((s) => ({ ...s, metric }));
  const setRhythm = (rhythm: Rhythm) => setState((s) => ({ ...s, rhythm }));
  return (
    <div className="page page-dense">
      <PageHeader eyebrow={screenEyebrow("statistics")} title={screenTitle("statistics")} icon={BarChart3}>
        Everything you've dictated, transcribed, translated or diarized.
        <br />
        Filter them by time range and kind, with the stages each session used.
        <br />A <strong className="font-semibold text-text">faster-whisper-backend</strong> server is needed.
      </PageHeader>

      <div className="page-content">
        <StatisticsView scope={state.scope} onScope={setScope} query={state.query} onQuery={setQuery} metric={state.metric} onMetric={setMetric} rhythm={state.rhythm} onRhythm={setRhythm} />
      </div>
    </div>
  );
}
