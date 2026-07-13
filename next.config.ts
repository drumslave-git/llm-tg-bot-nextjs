import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle (`.next/standalone`) so the
  // production image ships only traced runtime deps, not the full node_modules.
  output: "standalone",
  // Playwright is a native Node package (spawns a browser binary); never bundle
  // it — leave it as an external `require` resolved from node_modules at runtime.
  serverExternalPackages: ["playwright"],
};

export default nextConfig;
