import pkg from "@/package.json";

/** Static build metadata, sourced from package.json. Safe on client and server. */
export const buildInfo = {
  name: pkg.name,
  version: pkg.version,
} as const;
