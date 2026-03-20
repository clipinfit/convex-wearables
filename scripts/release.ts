import { execSync } from "node:child_process";

const BUMPS = ["patch", "minor", "major"] as const;

const raw = process.argv[2];
const bump = BUMPS.find((b) => b === raw);

if (!bump) {
  console.error("Usage: npm run release -- <patch|minor|major>");
  process.exit(1);
}

execSync(`npm version ${bump}`, { stdio: "inherit" });
execSync("git push --follow-tags", { stdio: "inherit" });
execSync("npm publish", { stdio: "inherit" });
