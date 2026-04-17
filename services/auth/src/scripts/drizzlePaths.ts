import fs from "fs";
import path from "path";
import dotenv from "dotenv";

/** Directory containing `drizzle.config.ts` (`services/auth`), regardless of ts-node `__dirname`. */
export function findAuthServiceRoot(): string {
  const markers = ["drizzle.config.ts", "drizzle.config.js"];
  const walkUp = (start: string): string | undefined => {
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i++) {
      if (markers.some((m) => fs.existsSync(path.join(dir, m)))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  };

  const seeds = [
    path.resolve(__dirname),
    path.resolve(process.cwd()),
    path.join(process.cwd(), "services", "auth"),
  ];

  for (const seed of seeds) {
    const found = walkUp(seed);
    if (found) return found;
  }

  throw new Error(
    "Could not find services/auth (no drizzle.config.ts). Run: npm run db:migrate from the repo root, or cd services/auth first.",
  );
}

export function resolveRepoEnvPath(authRoot: string): string {
  return path.resolve(authRoot, "../../.env");
}

export function loadDotenvFromRepoRoot(): { authRoot: string; envPath: string } {
  const authRoot = findAuthServiceRoot();
  const envPath = resolveRepoEnvPath(authRoot);
  dotenv.config({ path: envPath });
  return { authRoot, envPath };
}
