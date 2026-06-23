// dev-loop hub — P7 one-way Linear mirror adapter (Linear GraphQL).
// §16: the API token arrives as a function ARG (the caller reads it from process.env); this module
// NEVER logs/returns the token. Every call has a HARD timeout. A failure is a thrown Error carrying
// only an HTTP status / a truncated Linear error message (never the token, never request headers).
// STRICTLY ONE-WAY: this module only WRITES Linear (issueCreate/issueUpdate) + reads ONLY to
// reconcile its own mapping (findByMarker) — it NEVER imports Linear state back as truth.
export type FetchImpl = typeof fetch;
const timeoutMs = (): number => Number(process.env.DEVLOOP_MIRROR_TIMEOUT_MS) || 10_000;
// The endpoint defaults to the real Linear; DEVLOOP_LINEAR_API_URL overrides it (an integration-test /
// self-hosted seam). §16 is unaffected — the token is still a function arg, never placed in the URL —
// and env is already the trust boundary for the token, so this adds no new exposure. Read at call time.
const endpoint = (): string => process.env.DEVLOOP_LINEAR_API_URL || "https://api.linear.app/graphql";

export interface MirrorIssue { title: string; description: string; stateId?: string; }

async function gql(
  fetchImpl: FetchImpl, token: string, query: string, variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs());
  try {
    const res = await fetchImpl(endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token }, // Linear personal API key (no "Bearer")
      body: JSON.stringify({ query, variables }),
      signal: ctl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status !== 200) throw new Error(`linear http ${res.status}`); // status only — never the body/token
    const errors = body.errors as { message?: string }[] | undefined;
    if (errors?.length) throw new Error(`linear error: ${String(errors[0].message ?? "unknown").slice(0, 80)}`);
    return (body.data ?? {}) as Record<string, unknown>;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("linear network error: timeout");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// reconcile-by-marker: find a previously-mirrored issue by the `[hub:<id>]` marker in its title,
// so a crash between issueCreate and recording the mapping never double-creates on retry.
export async function findByMarker(fetchImpl: FetchImpl, token: string, marker: string): Promise<string | null> {
  const d = await gql(fetchImpl, token,
    "query($q:String!){ issues(filter:{ title:{ containsIgnoreCase:$q } }, first:1){ nodes{ id } } }", { q: marker });
  const nodes = ((d.issues as Record<string, unknown>)?.nodes ?? []) as { id: string }[];
  return nodes[0]?.id ?? null;
}

export async function createIssue(
  fetchImpl: FetchImpl, token: string, teamId: string, projectId: string | null, issue: MirrorIssue,
): Promise<string> {
  const input: Record<string, unknown> = { teamId, title: issue.title, description: issue.description };
  if (projectId) input.projectId = projectId;
  if (issue.stateId) input.stateId = issue.stateId;
  const d = await gql(fetchImpl, token,
    "mutation($i:IssueCreateInput!){ issueCreate(input:$i){ success issue{ id } } }", { i: input });
  const r = d.issueCreate as { success?: boolean; issue?: { id: string } } | undefined;
  if (!r?.success || !r.issue?.id) throw new Error("linear issueCreate failed");
  return r.issue.id;
}

export async function updateIssue(
  fetchImpl: FetchImpl, token: string, id: string, issue: MirrorIssue,
): Promise<void> {
  const input: Record<string, unknown> = { title: issue.title, description: issue.description };
  if (issue.stateId) input.stateId = issue.stateId;
  const d = await gql(fetchImpl, token,
    "mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id, input:$i){ success } }", { id, i: input });
  const r = d.issueUpdate as { success?: boolean } | undefined;
  if (!r?.success) throw new Error("linear issueUpdate failed");
}
