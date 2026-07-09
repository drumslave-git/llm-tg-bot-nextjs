import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle (`.next/standalone`) so the
  // production image ships only traced runtime deps, not the full node_modules.
  output: "standalone",
};

export default nextConfig;
