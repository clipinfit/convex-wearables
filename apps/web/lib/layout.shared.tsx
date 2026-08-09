import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { NavTitle } from "@/lib/nav-title";

export const gitConfig = {
  user: "clipinfit",
  repo: "convex-wearables",
  branch: "main",
};

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: NavTitle,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
