/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: import.meta.dirname,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  // Allow relocating the build dir OFF cloud-synced storage (e.g. OneDrive),
  // where constant .next writes trigger sync thrash / Files-On-Demand eviction.
  // Defaults to the normal ".next" so nothing changes for standard setups.
  ...(process.env.AURA_DIST_DIR ? { distDir: process.env.AURA_DIST_DIR } : {}),
};

export default nextConfig;
