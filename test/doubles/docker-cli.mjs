#!/usr/bin/env node
/**
 * TEST DOUBLE — the `docker` CLI, for automated tests ONLY, used when the real
 * Docker daemon is unavailable (src/lib/builder/engine.double.test.ts).
 *
 * It answers `docker image inspect` and runs `docker run … -v <dir>:/work …
 * sh -c <command>` by executing the command ON THE HOST in <dir>. It provides
 * NONE of the sandbox's isolation (no network/memory/pids/capability limits,
 * not read-only, not non-root), so it is only ever pointed at AURA's own
 * trusted test fixtures. Application code never references it (guarded by
 * src/lib/no-fixtures.test.ts); tests that use it say so in their name.
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] === "image" && args[1] === "inspect") {
  process.stdout.write("sha256:docker-cli-test-double\n");
  process.exit(0);
}
if (args[0] === "kill" || args[0] === "rm") process.exit(0);
if (args[0] !== "run") {
  process.stderr.write(`docker test double: unsupported command ${args[0]}\n`);
  process.exit(125);
}
const v = args.indexOf("-v");
const dir = v >= 0 ? args[v + 1].split(":/work")[0] : process.cwd();
const sh = args.lastIndexOf("-c");
const command = args[sh + 1];
const r = spawnSync("sh", ["-c", command], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir }, maxBuffer: 16 * 1024 * 1024 });
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
process.exit(r.status ?? 1);
