import { beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "@/hub/registry";
import { Teams } from "@/hub/teams";

function mockWs() {
  return { send(_data: string) {} };
}

describe("Teams", () => {
  let registry: Registry;
  let teams: Teams;

  beforeEach(() => {
    registry = new Registry();
    teams = new Teams(registry);
  });

  test("join creates team if new", () => {
    const members = teams.join("backend", "proj:alice@host");
    expect(members).toEqual(["proj:alice@host"]);
    expect(teams.teams.has("backend")).toBe(true);
  });

  test("join existing team adds member", () => {
    teams.join("backend", "proj:alice@host");
    const members = teams.join("backend", "proj:bob@host");
    expect(members).toEqual(["proj:alice@host", "proj:bob@host"]);
  });

  test("leave removes member", () => {
    teams.join("backend", "proj:alice@host");
    teams.join("backend", "proj:bob@host");
    const remaining = teams.leave("backend", "proj:alice@host");
    expect(remaining).toBe(1);
    expect(teams.getMembers("backend")?.has("proj:alice@host")).toBe(false);
    expect(teams.getMembers("backend")?.has("proj:bob@host")).toBe(true);
  });

  test("leave last member deletes team", () => {
    teams.join("backend", "proj:alice@host");
    const remaining = teams.leave("backend", "proj:alice@host");
    expect(remaining).toBe(0);
    expect(teams.teams.has("backend")).toBe(false);
  });

  test("leave from nonexistent team returns 0", () => {
    const remaining = teams.leave("nope", "proj:alice@host");
    expect(remaining).toBe(0);
  });

  test("getTeamsForAgent returns correct teams", () => {
    teams.join("backend", "proj:alice@host");
    teams.join("frontend", "proj:alice@host");
    teams.join("backend", "proj:bob@host");

    const aliceTeams = teams.getTeamsForAgent("proj:alice@host");
    expect(aliceTeams.has("backend")).toBe(true);
    expect(aliceTeams.has("frontend")).toBe(true);
    expect(aliceTeams.size).toBe(2);
  });

  test("getMembers returns null for nonexistent team", () => {
    expect(teams.getMembers("nope")).toBeNull();
  });

  test("removeFromAllTeams cleans up correctly", () => {
    teams.join("backend", "proj:alice@host");
    teams.join("frontend", "proj:alice@host");
    teams.join("backend", "proj:bob@host");

    teams.removeFromAllTeams("proj:alice@host");

    // alice should be gone from backend, bob still there
    expect(teams.getMembers("backend")?.has("proj:alice@host")).toBe(false);
    expect(teams.getMembers("backend")?.has("proj:bob@host")).toBe(true);
    // frontend had only alice, so it should be deleted
    expect(teams.teams.has("frontend")).toBe(false);
  });

  test("list returns all teams with member status", () => {
    registry.register("proj:alice@host", mockWs());
    teams.join("backend", "proj:alice@host");
    teams.join("backend", "proj:bob@host"); // bob not registered = offline

    const list = teams.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("backend");
    expect(list[0]?.members).toHaveLength(2);

    const alice = list[0]?.members.find((m) => m.name === "proj:alice@host");
    const bob = list[0]?.members.find((m) => m.name === "proj:bob@host");
    expect(alice?.status).toBe("online");
    expect(bob?.status).toBe("offline");
  });
});
