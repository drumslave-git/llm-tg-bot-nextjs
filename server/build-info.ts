import pkg from "@/package.json";

/** Static build metadata, sourced from package.json. */
export const buildInfo = {
  name: pkg.name,
  version: pkg.version,
} as const;
