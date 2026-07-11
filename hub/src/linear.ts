// dev-loop hub — P7 one-way Linear mirror adapter (Linear GraphQL).
// §16: the API token arrives as a function ARG (the caller reads it from process.env); this module
// NEVER logs/returns the token. Every call has a HARD timeout. A failure is a thrown Error carrying
// only an HTTP status / a truncated Linear error message (never the token, never request headers).
// STRICTLY ONE-WAY: this module only WRITES Linear (issueCreate/issueUpdate + the D5 documentCreate/
// documentUpdate) + reads ONLY to (a) reconcile its own mapping (findByMarker/findDocByMarker) and
// (b) serve the D5 comment→intake poller (getDocumentContent/listDocComments) — those poller reads are
// INTAKE (a human comment / a divergence flag becomes a needs-pm ticket), never a state import: no hub
// ticket/doc field is ever written from what Linear returns, and a Linear-side body edit is only ever
// FLAGGED (then overwritten by the next push) — Linear never becomes a second source of truth.
export type FetchImpl = typeof fetch;
const timeoutMs = (): number => Number(process.env.DEVLOOP_MIRROR_TIMEOUT_MS) || 10_000;
// The endpoint defaults to the real Linear; DEVLOOP_LINEAR_API_URL overrides it (an integration-test /
// self-hosted seam). §16 is unaffected — the token is still a function arg, never placed in the URL —
// and env is already the trust boundary for the token, so this adds no new exposure. Read at call time.
const endpoint = (): string => process.env.DEVLOOP_LINEAR_API_URL || "https://api.linear.app/graphql";

export interface MirrorIssue { title: string; description: string; stateId?: string; priority?: number; }

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
  if (issue.priority !== undefined) input.priority = issue.priority; // L2: hub priority IS Linear's 0-4 convention (native, sortable) — not just body text
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
  if (issue.priority !== undefined) input.priority = issue.priority; // L2: native Linear priority (0-4), so the mirror board sorts/filters
  const d = await gql(fetchImpl, token,
    "mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id, input:$i){ success } }", { id, i: input });
  const r = d.issueUpdate as { success?: boolean } | undefined;
  if (!r?.success) throw new Error("linear issueUpdate failed");
}

// ── D5 doc mirror: Linear Documents (create/update/reconcile) + the comment→intake poller reads ──
// Same §16 posture as the issue mirror above: token as an arg, timeouts via gql, thrown errors carry
// only status/truncated message. Documents parent to the mirrored Linear PROJECT (documentCreate's
// projectId) — the caller gates doc pushes on having one.
export interface MirrorDocument { title: string; content: string; }

// reconcile-by-marker for docs: find a previously-mirrored Linear Document by the `[hub:doc:<slug>]`
// marker in its title, so a crash between documentCreate and recording the mapping never double-creates.
export async function findDocByMarker(fetchImpl: FetchImpl, token: string, marker: string): Promise<string | null> {
  const d = await gql(fetchImpl, token,
    "query($q:String!){ documents(filter:{ title:{ containsIgnoreCase:$q } }, first:1){ nodes{ id } } }", { q: marker });
  const nodes = ((d.documents as Record<string, unknown>)?.nodes ?? []) as { id: string }[];
  return nodes[0]?.id ?? null;
}

export async function createDocument(
  fetchImpl: FetchImpl, token: string, projectId: string, doc: MirrorDocument,
): Promise<string> {
  const d = await gql(fetchImpl, token,
    "mutation($i:DocumentCreateInput!){ documentCreate(input:$i){ success document{ id } } }",
    { i: { title: doc.title, content: doc.content, projectId } });
  const r = d.documentCreate as { success?: boolean; document?: { id: string } } | undefined;
  if (!r?.success || !r.document?.id) throw new Error("linear documentCreate failed");
  return r.document.id;
}

export async function updateDocument(
  fetchImpl: FetchImpl, token: string, id: string, doc: MirrorDocument,
): Promise<void> {
  const d = await gql(fetchImpl, token,
    "mutation($id:String!,$i:DocumentUpdateInput!){ documentUpdate(id:$id, input:$i){ success } }",
    { id, i: { title: doc.title, content: doc.content } });
  const r = d.documentUpdate as { success?: boolean } | undefined;
  if (!r?.success) throw new Error("linear documentUpdate failed");
}

// Poller read (INTAKE, not state import): the mirrored document's current upstream body, compared by the
// caller against what IT last pushed to detect a Linear-side edit — the hub never adopts this content.
export async function getDocumentContent(fetchImpl: FetchImpl, token: string, id: string): Promise<string | null> {
  const d = await gql(fetchImpl, token, "query($id:String!){ document(id:$id){ content } }", { id });
  const doc = d.document as { content?: string | null } | undefined;
  return doc?.content ?? null;
}

// Poller read (INTAKE): human comments on a mirrored document. `isHuman` = a user-authored comment
// (bot/integration comments carry botActor and are ignored — the mirror itself never comments, but
// other integrations might). The author identity is NOT returned (an unverified provider id is never
// operator authority, §16) — only the body/url/timestamps the intake ticket quotes as provenance.
// Cursor-paginated (a busy doc must not silently drop comments past the first page); the page cap is a
// runaway guard only — 10×100 comments on ONE mirrored doc is far past any sane loop's traffic.
export interface DocComment { id: string; body: string; url: string | null; createdAt: string; isHuman: boolean; }
export async function listDocComments(fetchImpl: FetchImpl, token: string, docId: string): Promise<DocComment[]> {
  type Node = { id: string; body?: string; url?: string | null; createdAt?: string; user?: { id: string } | null; botActor?: { id: string } | null };
  const out: DocComment[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const d = await gql(fetchImpl, token,
      "query($docId:ID!,$after:String){ comments(filter:{ documentContent:{ document:{ id:{ eq:$docId } } } }, first:100, after:$after){ nodes{ id body url createdAt user{ id } botActor{ id } } pageInfo{ hasNextPage endCursor } } }",
      { docId, after });
    const c = d.comments as { nodes?: Node[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | undefined;
    for (const n of c?.nodes ?? []) {
      out.push({ id: n.id, body: String(n.body ?? ""), url: n.url ?? null, createdAt: String(n.createdAt ?? ""), isHuman: !!n.user && !n.botActor });
    }
    if (!c?.pageInfo?.hasNextPage || !c.pageInfo.endCursor) break;
    after = c.pageInfo.endCursor;
  }
  return out;
}

// ── Workspace fingerprint stamp (concept P4) ─────────────────────────────────────────────────────
// ONE dev-loop workspace drives one Linear project. The marker `[dev-loop:workspace:<id>]` in the
// project DESCRIPTION records which workspace claimed it; a second workspace pointed at the same
// project sees the foreign id and warns instead of silently double-driving every agent. Same §16
// posture as the mirror above: token as a function arg, read-only except appending our own marker,
// and a mismatch NEVER overwrites the incumbent's stamp.
export const WORKSPACE_MARKER_RE = /\[dev-loop:workspace:([A-Za-z0-9-]+)\]/;
export const workspaceMarker = (workspaceId: string): string => `[dev-loop:workspace:${workspaceId}]`;

export type StampResult =
  | { status: "stamped" }                       // no marker was present; ours is now appended
  | { status: "already" }                       // the project already carries THIS workspace's marker
  | { status: "mismatch"; foundId: string };    // ANOTHER workspace claimed it — caller must warn loudly

export async function stampWorkspaceMarker(
  fetchImpl: FetchImpl, token: string, linearProjectId: string, workspaceId: string,
): Promise<StampResult> {
  const d = await gql(fetchImpl, token,
    "query($id:String!){ project(id:$id){ id description } }", { id: linearProjectId });
  const desc = String((d.project as { description?: string } | undefined)?.description ?? "");
  const m = desc.match(WORKSPACE_MARKER_RE);
  if (m) return m[1] === workspaceId ? { status: "already" } : { status: "mismatch", foundId: m[1] };
  const next = desc.trim() ? `${desc}\n\n${workspaceMarker(workspaceId)}` : workspaceMarker(workspaceId);
  const u = await gql(fetchImpl, token,
    "mutation($id:String!,$i:ProjectUpdateInput!){ projectUpdate(id:$id, input:$i){ success } }", { id: linearProjectId, i: { description: next } });
  const r = u.projectUpdate as { success?: boolean } | undefined;
  if (!r?.success) throw new Error("linear projectUpdate failed");
  return { status: "stamped" };
}
