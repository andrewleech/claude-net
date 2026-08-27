import type { TeamInfo } from "@/shared/types";
import type { Registry } from "./registry";

export class Teams {
  readonly teams = new Map<string, Set<string>>();
  private registry: Registry;

  constructor(registry: Registry) {
    this.registry = registry;
  }

  join(teamName: string, agentFullName: string): string[] {
    let members = this.teams.get(teamName);
    if (!members) {
      members = new Set();
      this.teams.set(teamName, members);
    }
    members.add(agentFullName);
    return [...members];
  }

  leave(teamName: string, agentFullName: string): number {
    const members = this.teams.get(teamName);
    if (!members) return 0;

    members.delete(agentFullName);
    if (members.size === 0) {
      this.teams.delete(teamName);
      return 0;
    }
    return members.size;
  }

  getTeamsForAgent(agentFullName: string): Set<string> {
    const result = new Set<string>();
    for (const [teamName, members] of this.teams) {
      if (members.has(agentFullName)) {
        result.add(teamName);
      }
    }
    return result;
  }

  getMembers(teamName: string): Set<string> | null {
    return this.teams.get(teamName) ?? null;
  }

  /**
   * Swap a renamed agent's membership key in every team it belongs to.
   * Without this, a rename leaves each team's member set pointing at
   * the dead name — team sends would resolve the stale identity via
   * seenNames and deposit into its mailbox slot instead of the agent's
   * current one, and the renamed agent's own re-broadcast wouldn't be
   * recognized as "self" and skipped.
   */
  renameMember(oldName: string, newName: string): void {
    for (const members of this.teams.values()) {
      if (members.delete(oldName)) {
        members.add(newName);
      }
    }
  }

  removeFromAllTeams(agentFullName: string): void {
    const toDelete: string[] = [];
    for (const [teamName, members] of this.teams) {
      members.delete(agentFullName);
      if (members.size === 0) {
        toDelete.push(teamName);
      }
    }
    for (const teamName of toDelete) {
      this.teams.delete(teamName);
    }
  }

  list(): TeamInfo[] {
    const result: TeamInfo[] = [];
    for (const [teamName, members] of this.teams) {
      const memberList = [...members].map((name) => ({
        name,
        status: this.registry.getByFullName(name)
          ? ("online" as const)
          : ("offline" as const),
      }));
      result.push({ name: teamName, members: memberList });
    }
    return result;
  }
}
