import { describe, it, expect } from "vitest";
import { isAllowed, permissionsFor, ROLE_PERMISSIONS } from "./permissions";

describe("agent permissions", () => {
  it("red-team may attack the cyber range but NOT deploy", () => {
    expect(isAllowed("red-team", "cyber.attack")).toBe(true);
    expect(isAllowed("red-team", "deploy.run")).toBe(false);
    expect(isAllowed("red-team", "code.write")).toBe(false);
  });

  it("only engineers can write code", () => {
    expect(isAllowed("backend-engineer", "code.write")).toBe(true);
    expect(isAllowed("frontend-engineer", "code.write")).toBe(true);
    expect(isAllowed("product-manager", "code.write")).toBe(false);
    expect(isAllowed("qa-engineer", "code.write")).toBe(false);
  });

  it("only devops can deploy and rollback", () => {
    expect(isAllowed("devops", "deploy.run")).toBe(true);
    expect(isAllowed("devops", "deploy.rollback")).toBe(true);
    expect(isAllowed("backend-engineer", "deploy.run")).toBe(false);
  });

  it("every role can send messages", () => {
    for (const role of Object.keys(ROLE_PERMISSIONS)) {
      expect(isAllowed(role, "message.send")).toBe(true);
    }
  });

  it("unknown agents get a minimal permission set", () => {
    expect(permissionsFor("nobody")).toEqual(["message.send"]);
  });
});
