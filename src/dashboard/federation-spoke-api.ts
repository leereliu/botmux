/**
 * Federation SPOKE endpoints, mounted INSIDE the dashboard's token gate (these
 * are owner actions — the dashboard token already proves the owner). The spoke
 * makes OUTBOUND calls to a hub; it never needs to expose anything inbound.
 *   - POST /api/team/join-remote   { hubUrl, inviteCode }
 *   - GET  /api/team/remote-roster
 *   - POST /api/team/sync-remote
 *   - POST /api/team/leave-remote  { hubUrl, teamId }
 *
 * See docs/federation-design.md.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { jsonRes } from './workflow-api.js';
import { buildTeamRoster } from '../services/team-roster.js';
import { getDeploymentIdentity } from '../services/deployment-identity.js';
import { addMembership, listMemberships, removeMembership } from '../services/federation-membership-store.js';
import type { FederatedBot } from '../services/federation-store.js';

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > maxBytes) throw new Error('too_large');
    chunks.push(b);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

/** Normalize a hub base URL (strip trailing slash); only http/https allowed. */
function normalizeHubUrl(raw: string): string | null {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(s)) return null;
  return s;
}

/** This deployment's bots, in the shape the hub federates (bots.json order). */
function localBots(dataDir: string): FederatedBot[] {
  return buildTeamRoster(dataDir).bots.map(b => ({
    larkAppId: b.larkAppId,
    botName: b.name,
    cliId: b.cliId,
    capability: b.capability,
    hasTeamRole: b.hasTeamRole,
    // botUnionId: resolved in P2 (needed for cross-app 拉群), best-effort/omitted now
  }));
}

type Fetcher = typeof fetch;

/** Push this deployment's current bots to every joined hub. Best-effort. */
export async function syncAllMemberships(dataDir: string, fetcher: Fetcher = fetch): Promise<{ synced: number; failed: number }> {
  const bots = localBots(dataDir);
  let synced = 0, failed = 0;
  for (const m of listMemberships(dataDir)) {
    try {
      const r = await fetcher(`${m.hubUrl}/api/federation/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ syncToken: m.syncToken, bots }),
      });
      if (r.ok) synced++; else failed++;
    } catch { failed++; }
  }
  return { synced, failed };
}

export interface FederationSpokeDeps {
  dataDir?: string;
  fetcher?: Fetcher;
}

export async function handleFederationSpokeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: FederationSpokeDeps = {},
): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/team/join-remote' && path !== '/api/team/remote-roster'
    && path !== '/api/team/sync-remote' && path !== '/api/team/leave-remote') return false;
  const dataDir = deps.dataDir ?? config.session.dataDir;
  const fetcher = deps.fetcher ?? fetch;
  const method = req.method ?? 'GET';

  // Accept an invite from another deployment's hub: register our bots there.
  if (path === '/api/team/join-remote' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const hubUrl = normalizeHubUrl(body?.hubUrl);
    const inviteCode = String(body?.inviteCode ?? '').trim();
    if (!hubUrl) { jsonRes(res, 400, { ok: false, error: 'bad_hub_url' }); return true; }
    if (!inviteCode) { jsonRes(res, 400, { ok: false, error: 'code_required' }); return true; }
    const me = getDeploymentIdentity(dataDir);
    let hubRes: Response;
    try {
      hubRes = await fetcher(`${hubUrl}/api/federation/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteCode, deployment: { deploymentId: me.deploymentId, name: me.name, bots: localBots(dataDir) } }),
      });
    } catch {
      jsonRes(res, 502, { ok: false, error: 'hub_unreachable' });
      return true;
    }
    const j = await hubRes.json().catch(() => ({} as any));
    if (!hubRes.ok || !j?.ok) {
      jsonRes(res, hubRes.status === 403 ? 403 : 502, { ok: false, error: j?.error || `hub_${hubRes.status}` });
      return true;
    }
    addMembership(dataDir, { hubUrl, teamId: j.teamId, teamName: j.teamName, syncToken: j.syncToken, deploymentId: me.deploymentId });
    jsonRes(res, 200, { ok: true, hubUrl, teamId: j.teamId, teamName: j.teamName });
    return true;
  }

  // Pull each joined hub's aggregated roster for display.
  if (path === '/api/team/remote-roster' && method === 'GET') {
    const out: any[] = [];
    for (const m of listMemberships(dataDir)) {
      try {
        const r = await fetcher(`${m.hubUrl}/api/federation/roster?syncToken=${encodeURIComponent(m.syncToken)}`);
        const j = await r.json().catch(() => ({} as any));
        out.push({ hubUrl: m.hubUrl, teamId: m.teamId, teamName: m.teamName, ok: r.ok && j?.ok, roster: j?.ok ? { deployments: j.deployments, bots: j.bots, team: j.team } : null, error: j?.error });
      } catch {
        out.push({ hubUrl: m.hubUrl, teamId: m.teamId, teamName: m.teamName, ok: false, roster: null, error: 'hub_unreachable' });
      }
    }
    jsonRes(res, 200, { ok: true, memberships: out });
    return true;
  }

  // Manually push bots + heartbeat to all joined hubs.
  if (path === '/api/team/sync-remote' && method === 'POST') {
    const r = await syncAllMemberships(dataDir, fetcher);
    jsonRes(res, 200, { ok: true, ...r });
    return true;
  }

  // Forget a remote membership locally (does not unregister at the hub).
  if (path === '/api/team/leave-remote' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const hubUrl = normalizeHubUrl(body?.hubUrl);
    const teamId = String(body?.teamId ?? '').trim();
    if (!hubUrl || !teamId) { jsonRes(res, 400, { ok: false, error: 'bad_request' }); return true; }
    const removed = removeMembership(dataDir, hubUrl, teamId);
    jsonRes(res, removed ? 200 : 404, { ok: removed });
    return true;
  }

  return false;
}
