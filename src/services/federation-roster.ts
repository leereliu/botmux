/**
 * Aggregated cross-deployment roster (HUB side): the hub's own local bots
 * ([[team-roster]]) merged with every member deployment's advertised bots
 * ([[federation-store]]), each tagged with the deployment it belongs to so the
 * UI can group by deployment (local first, then remote by name).
 *
 * Pure read from `{dataDir}` files — testable, no Lark API.
 */
import { buildTeamRoster } from './team-roster.js';
import { listFederatedDeployments } from './federation-store.js';
import { getDeploymentIdentity } from './deployment-identity.js';
import { getTeam, getDefaultTeam, DEFAULT_TEAM_ID } from './team-store.js';

export interface AggregatedRosterBot {
  larkAppId: string;
  name: string;
  cliId: string;
  capability: string | null;
  hasTeamRole: boolean;
  deployment: { id: string; name: string; local: boolean };
}

export interface AggregatedDeployment {
  id: string;
  name: string;
  local: boolean;
  botCount: number;
  lastSeenAt?: number;
}

export interface AggregatedRoster {
  team: { id: string; name: string; memberCount: number };
  deployments: AggregatedDeployment[];
  bots: AggregatedRosterBot[];
}

/** Hub's local bots + all member deployments' bots, tagged + grouped by deployment. */
export function buildFederatedRoster(dataDir: string, teamId: string = DEFAULT_TEAM_ID, configOrder?: string[]): AggregatedRoster {
  const team = getTeam(dataDir, teamId) ?? getDefaultTeam(dataDir);
  const localId = getDeploymentIdentity(dataDir);
  const local = buildTeamRoster(dataDir, teamId, configOrder);

  const deployments: AggregatedDeployment[] = [
    { id: localId.deploymentId, name: localId.name, local: true, botCount: local.bots.length },
  ];
  const bots: AggregatedRosterBot[] = local.bots.map(b => ({
    larkAppId: b.larkAppId,
    name: b.name,
    cliId: b.cliId,
    capability: b.capability,
    hasTeamRole: b.hasTeamRole,
    deployment: { id: localId.deploymentId, name: localId.name, local: true },
  }));

  for (const dep of listFederatedDeployments(dataDir, teamId)) {
    deployments.push({ id: dep.deploymentId, name: dep.name, local: false, botCount: dep.bots.length, lastSeenAt: dep.lastSeenAt });
    for (const b of dep.bots) {
      bots.push({
        larkAppId: b.larkAppId,
        name: b.botName,
        cliId: b.cliId,
        capability: b.capability ?? null,
        hasTeamRole: !!b.hasTeamRole,
        deployment: { id: dep.deploymentId, name: dep.name, local: false },
      });
    }
  }

  return { team: { id: team.id, name: team.name, memberCount: team.members.length }, deployments, bots };
}
