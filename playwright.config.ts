import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config. Spins up the Next.js dev server and runs the core user-journey
 * tests against it. Uses the real app + real SQLite DB.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    storageState: "e2e/.auth/state.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // SwiftShader gives headless Chromium software WebGL so the 3D office path is exercised.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } } }],
  // E2E_EXTERNAL_SERVER=1: the server (and provider test doubles) are started by scripts/e2e.sh.
  webServer: process.env.E2E_EXTERNAL_SERVER ? undefined : {
    // Keep the Next build dir OFF cloud-synced storage (OneDrive) to avoid
    // sync thrash; mirrors the documented AURA_DIST_DIR workaround.
    // AURA_CHECK_TIMEOUT_MS: sandbox container start-up is slow on a loaded laptop; a run that exceeds it is reported TIMED_OUT.
    command: "AURA_DIST_DIR=/tmp/aura-next-e2e AURA_CHECK_TIMEOUT_MS=90000 npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
