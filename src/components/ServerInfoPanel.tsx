// The Backends ⓘ panel: what this server limits and what it keeps (GET /v1/me `server_info`),
// one ENV-titled row each with the backend's own description. Show-only.
import { OverrideHeader } from "@/components/OverrideField";
import { envDesc } from "@/lib/settingDesc";
import { keepRows, limitRows, type InfoRow, type KeepTone } from "@/lib/serverInfo";
import type { ServerInfo } from "@/lib/types";

const TONE: Record<KeepTone, string> = {
  bad: "var(--c-rec)",
  warn: "var(--c-warn)",
  ok: "var(--c-ok)",
  none: "var(--c-faint)",
};

function Group({ title, rows }: { title: string; rows: InfoRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="rounded-xl border border-line bg-panel px-4 pt-2">
      <div className="pt-1.5 text-[12.5px] font-semibold text-dim">{title}</div>
      {rows.map((r, i) => (
        <OverrideHeader
          key={r.env}
          title={r.env}
          desc={
            r.you ? (
              <>
                {envDesc(r.env)}
                <span className="mt-1 block text-text">{r.you}</span>
              </>
            ) : (
              envDesc(r.env)
            )
          }
          dot={r.tone ? TONE[r.tone] : undefined}
          last={i === rows.length - 1}
        >
          <span className="whitespace-nowrap font-mono text-[12px] text-dim">{r.value}</span>
        </OverrideHeader>
      ))}
    </div>
  );
}

export function ServerInfoPanel({ id, info, reportApp }: { id: string; info: ServerInfo | undefined; reportApp: boolean }) {
  return (
    <div id={id} className="flex flex-col gap-3 pb-4 pt-1">
      <Group title="Limits" rows={limitRows(info)} />
      <Group title="What this server keeps" rows={keepRows(info, reportApp)} />
    </div>
  );
}
