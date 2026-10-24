/**
 * Codebase intelligence (acceptance 7, 14): the index is built from the real
 * node-web starter + the ScamScout change, and impact analysis finds the
 * files, tests and risks a change touches. Pure — no DB, model or Docker.
 */
import { describe, it, expect } from "vitest";
import { stackFor } from "./stacks";
import { buildIndex, analyzeChange, dependentsOf, testsFor, relatedToText, focusedTestCommand } from "./intel";
import { ROUTE_FIXED, ROUTE_TEST, APP_PATCH } from "../../../test/doubles/scamscout";

const base = stackFor("node-web").files;
const after: Record<string, string> = { ...base, "src/routes/assessments.js": ROUTE_FIXED, "src/routes/assessments.test.js": ROUTE_TEST, "src/app.js": APP_PATCH(base["src/app.js"]) };

describe("code index", () => {
  it("parses imports with the TypeScript pre-processor, resolves local files, finds routes and test coverage", async () => {
    const ix = await buildIndex(after);
    expect(ix.parser).toBe("typescript");
    const app = ix.files.find((f) => f.path === "src/app.js")!;
    expect(app.imports).toEqual(expect.arrayContaining(["src/http.js", "src/routes/health.js", "src/routes/assessments.js"]));
    expect(app.symbols).toEqual(expect.arrayContaining(["handle", "ROUTES"]));
    expect(ix.routes).toEqual(expect.arrayContaining([{ method: "GET", path: "/api/health", file: "src/routes/health.js" }, { method: "POST", path: "/api/assessments", file: "src/routes/assessments.js" }]));
    // server.test.js → testing.js → server.js → app.js → routes/* : the whole app
    const serverTest = ix.tests.find((t) => t.file === "src/server.test.js")!;
    expect(serverTest.covers).toEqual(expect.arrayContaining(["src/app.js", "src/routes/assessments.js", "src/store.js"]));
    expect(ix.config.testCommand).toBe("npm test");
    expect(ix.limitations.join(" ")).toMatch(/file-level/);
  });

  it("dependents and tests of a change follow the real import graph", async () => {
    const ix = await buildIndex(after);
    expect(dependentsOf(ix, ["src/store.js"])).toEqual(expect.arrayContaining(["src/routes/assessments.js", "src/app.js", "src/server.js"]));
    expect(testsFor(ix, ["src/routes/assessments.js"])).toEqual(["src/routes/assessments.test.js", "src/server.test.js"]);
    expect(testsFor(ix, ["public/styles.css"])).toEqual([]);
    expect(focusedTestCommand({ ...ix, config: { ...ix.config, scripts: { test: "node --test" } } }, ["src/routes/assessments.test.js"])).toBe("node --test src/routes/assessments.test.js");
    expect(focusedTestCommand({ ...ix, config: { ...ix.config, scripts: { test: "vitest run" } } }, ["a.test.js"])).toBeNull();
  });

  it("requirement text maps to related files and tests (lexical, labelled)", async () => {
    const ix = await buildIndex(after);
    const r = relatedToText(ix, "Listings asking for upfront payment are rated high risk in assessments");
    expect(r.method).toBe("lexical");
    expect(r.files).toContain("src/routes/assessments.js");
    expect(r.tests).toContain("src/routes/assessments.test.js");
  });
});

describe("change impact analysis", () => {
  it("lists changed files, dependents and the tests to run; flags uncovered changes as warnings", async () => {
    const before = await buildIndex(base);
    const ix = await buildIndex(after);
    const imp = analyzeChange({ before, after: ix, beforeFiles: base, afterFiles: after, changed: [{ status: "M", path: "src/app.js" }, { status: "A", path: "src/routes/assessments.js" }, { status: "A", path: "src/routes/assessments.test.js" }], scope: ["src/routes/assessments.js"] });
    expect(imp.dependents).toEqual(expect.arrayContaining(["src/server.js", "src/testing.js"]));
    expect(imp.tests).toEqual(expect.arrayContaining(["src/routes/assessments.test.js", "src/server.test.js"]));
    expect(imp.flags.filter((f) => f.confidence === "confirmed")).toEqual([]);
    expect(imp.flags.find((f) => f.kind === "unintended_file")?.files).toEqual(["src/app.js"]);
  });

  it("confirms real breakage: deleted file still imported, weakened pre-existing test; warns on removed route, deps, auth, schema, contract mismatch", async () => {
    const before = await buildIndex(after);
    const broken: Record<string, string> = { ...after };
    delete broken["src/http.js"];
    broken["src/server.test.js"] = base["src/server.test.js"].replace(/test\("frontend is served"[\s\S]*$/, "");
    broken["src/routes/health.js"] = "module.exports.routes = [];\n";
    broken["package.json"] = JSON.stringify({ name: "app", scripts: { test: "node --test" }, dependencies: { express: "^5.0.0" } });
    broken["src/auth/session.js"] = "module.exports = {};\n";
    broken["prisma/schema.prisma"] = "model User {\n  id String @id\n}\n";
    broken["public/app.js"] = 'fetch("/api/listings", { method: "POST" });\n';
    const ix = await buildIndex(broken);
    const imp = analyzeChange({
      before, after: ix, beforeFiles: after, afterFiles: broken,
      changed: [{ status: "D", path: "src/http.js" }, { status: "M", path: "src/server.test.js" }, { status: "M", path: "src/routes/health.js" }, { status: "M", path: "package.json" }, { status: "A", path: "src/auth/session.js" }, { status: "A", path: "prisma/schema.prisma" }, { status: "M", path: "public/app.js" }],
      protectedTests: ["src/server.test.js"], failingTests: ["src/server.test.js"],
    });
    const by = (k: string) => imp.flags.filter((f) => f.kind === k);
    expect(by("deleted_still_imported")[0]).toMatchObject({ confidence: "confirmed", severity: "high" });
    expect(by("deleted_still_imported")[0].files).toEqual(expect.arrayContaining(["src/http.js", "src/app.js"]));
    expect(by("test_weakened")[0]).toMatchObject({ confidence: "confirmed", files: ["src/server.test.js"] });
    // Weakening a pre-existing test that was NOT failing is only a warning (a requirement may justify it).
    const soft = analyzeChange({ before, after: ix, beforeFiles: after, afterFiles: broken, changed: [{ status: "M", path: "src/server.test.js" }], protectedTests: ["src/server.test.js"] });
    expect(soft.flags.find((f) => f.kind === "test_weakened")).toMatchObject({ confidence: "warning", severity: "high" });
    expect(by("api_breaking")[0].detail).toMatch(/GET \/api\/health/);
    expect(by("api_breaking")[0].confidence).toBe("warning");
    expect(by("dependency")[0].detail).toMatch(/added express/);
    expect(by("authorization")[0].files).toEqual(["src/auth/session.js"]);
    expect(by("migration")[0].files).toEqual(["prisma/schema.prisma"]);
    expect(by("contract_mismatch")[0].detail).toMatch(/POST \/api\/listings/);
  });
});
