// Server-only helper for the OUTBOUND direction of the HyperAgent integration:
// the CRM kicks off a HyperAgent agent run over HTTP. The agent does its work
// (e.g. drafts outreach) and writes results back through the inbound API in
// app/routes/api.hyperagent.ts.

export type TriggerConfig = {
  url: string;
  key: string;
};

export type TriggerResult =
  | { ok: true; status: number }
  | { ok: false; error: string };

/**
 * POST `payload` to the configured HyperAgent trigger endpoint with a bearer
 * token. Returns a plain result object (never throws) so callers can surface a
 * friendly message. When the URL is unset the integration is treated as
 * disabled and a clear error is returned instead of attempting a fetch.
 */
export async function triggerAgent(
  cfg: TriggerConfig,
  payload: unknown,
): Promise<TriggerResult> {
  if (!cfg.url) {
    return { ok: false, error: "HyperAgent trigger URL is not configured." };
  }
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { ok: false, error: `HyperAgent returned ${res.status}.` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to reach HyperAgent.",
    };
  }
}
