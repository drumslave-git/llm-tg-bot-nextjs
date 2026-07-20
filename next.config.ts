import type { NextConfig } from "next";

import pkg from "./package.json";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle (`.next/standalone`) so the
  // production image ships only traced runtime deps, not the full node_modules.
  output: "standalone",
  // Inline only name/version for `lib/build-info` — importing package.json from
  // client-reachable code shipped the whole manifest (dependency list and
  // versions) into the browser bundle.
  env: {
    NEXT_PUBLIC_APP_NAME: pkg.name,
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  // Playwright is a native Node package (spawns a browser binary); never bundle
  // it — leave it as an external `require` resolved from node_modules at runtime.
  // Native Node packages that spawn binaries / load native addons must never be
  // bundled — leave them as runtime `require`s resolved from node_modules.
  serverExternalPackages: ["playwright", "sharp"],
};

export default nextConfig;
