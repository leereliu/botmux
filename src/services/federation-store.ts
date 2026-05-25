/**
 * Federation store (HUB side): which remote deployments have joined each team,
 * and the bots they last advertised. The hub aggregates these with its own local
 * roster so every member sees a shared cross-deployment roster.
 *
 * A deployment registers once via an invite (→ teamId) and is issued a long-lived
 * `syncToken` (high-entropy, never logged) used for subsequent sync/roster pulls.
 *
 * Storage: `{dataDir}/federations.json`, atomic writes. Single dashboard writer
 * (same assumption as invite-store): register/sync are read-modify-write.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export interface FederatedBot {
  larkAppId: string;
  botName: string;
  cliId: string;
  /** Tenant-stable bot id (used by P2 拉群 to add the bot cross-app). */
  botUnionId?: string;
  capability?: string | null;
  hasTeamRole?: boolean;
}

export interface FederatedDeployment {
  deploymentId: string;
  name: string;
  syncToken: string;
  bots: FederatedBot[];
  joinedAt: number;
  lastSeenAt: number;
}

interface FileShape {
  version: 1;
  /** teamId → member deployments */
  teams: Record<string, FederatedDeployment[]>;
}

function filePath(dataDir: string): string {
  return join(dataDir, 'federations.json');
}

function readFile(dataDir: string): FileShape {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return { version: 1, teams: {} };
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed.teams === 'object' && parsed.teams) return { version: 1, teams: parsed.teams };
  } catch { /* corrupt — fall through */ }
  return { version: 1, teams: {} };
}

function writeFileAtomic(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fp = filePath(dataDir);
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

export interface RegisterInput {
  deploymentId: string;
  name: string;
  bots: FederatedBot[];
}

/**
 * Register (or refresh) a remote deployment under a team. Idempotent by
 * deploymentId: re-registering keeps the same syncToken and refreshes bots/name.
 * Returns the (possibly existing) syncToken.
 */
export function registerDeployment(dataDir: string, teamId: string, input: RegisterInput, now: number = Date.now()): { syncToken: string } {
  const data = readFile(dataDir);
  const list = data.teams[teamId] ?? (data.teams[teamId] = []);
  const existing = list.find(d => d.deploymentId === input.deploymentId);
  if (existing) {
    existing.name = input.name || existing.name;
    existing.bots = input.bots;
    existing.lastSeenAt = now;
    writeFileAtomic(dataDir, data);
    return { syncToken: existing.syncToken };
  }
  const syncToken = randomBytes(24).toString('base64url');
  list.push({ deploymentId: input.deploymentId, name: input.name, syncToken, bots: input.bots, joinedAt: now, lastSeenAt: now });
  writeFileAtomic(dataDir, data);
  return { syncToken };
}

/** Resolve a syncToken to its {teamId, deployment}, or null. */
export function getDeploymentByToken(dataDir: string, syncToken: string): { teamId: string; deployment: FederatedDeployment } | null {
  if (!syncToken) return null;
  const data = readFile(dataDir);
  for (const [teamId, list] of Object.entries(data.teams)) {
    const deployment = list.find(d => d.syncToken === syncToken);
    if (deployment) return { teamId, deployment };
  }
  return null;
}

/** Refresh a deployment's advertised bots + heartbeat, by syncToken. Returns true if found. */
export function syncDeployment(dataDir: string, syncToken: string, bots: FederatedBot[], now: number = Date.now()): boolean {
  const data = readFile(dataDir);
  for (const list of Object.values(data.teams)) {
    const deployment = list.find(d => d.syncToken === syncToken);
    if (deployment) {
      deployment.bots = bots;
      deployment.lastSeenAt = now;
      writeFileAtomic(dataDir, data);
      return true;
    }
  }
  return false;
}

/** Member deployments of a team (empty if none). */
export function listFederatedDeployments(dataDir: string, teamId: string): FederatedDeployment[] {
  return readFile(dataDir).teams[teamId] ?? [];
}

/** Remove a deployment from a team (leave/kick). Returns true if removed. */
export function removeDeployment(dataDir: string, teamId: string, deploymentId: string): boolean {
  const data = readFile(dataDir);
  const list = data.teams[teamId];
  if (!list) return false;
  const before = list.length;
  data.teams[teamId] = list.filter(d => d.deploymentId !== deploymentId);
  if (data.teams[teamId].length === before) return false;
  writeFileAtomic(dataDir, data);
  return true;
}

/** Drop all federation records for a team (e.g. when the team is deleted). */
export function removeTeamFederation(dataDir: string, teamId: string): void {
  const data = readFile(dataDir);
  if (data.teams[teamId]) {
    delete data.teams[teamId];
    writeFileAtomic(dataDir, data);
  }
}
