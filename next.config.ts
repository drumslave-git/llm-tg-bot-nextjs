import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle (`.next/standalone`) so the
  // production image ships only traced runtime deps, not the full node_modules.
  output: "standalone",
  // Playwright is a native Node package (spawns a browser binary); never bundle
  // it — leave it as an external `require` resolved from node_modules at runtime.
  // Native Node packages that spawn binaries / load native addons must never be
  // bundled — leave them as runtime `require`s resolved from node_modules.
  serverExternalPackages: ["playwright", "sharp"],
};

export default nextConfig;
