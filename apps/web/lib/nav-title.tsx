"use client";

import componentPackage from "@clipin/convex-wearables/package.json";
import Link from "next/link";
import type { ComponentProps } from "react";

export function NavTitle({
  href = "/",
  className,
  ...props
}: ComponentProps<"a">) {
  return (
    <span className={className}>
      <Link href={href} {...props}>
        Convex Wearables
      </Link>
      <a
        href="https://www.npmjs.com/package/@clipin/convex-wearables"
        target="_blank"
        rel="noreferrer"
        aria-label={`View @clipin/convex-wearables version ${componentPackage.version} on npm`}
        className="rounded-full border border-fd-border bg-fd-secondary px-2 py-1 font-mono text-xs font-medium leading-none text-fd-muted-foreground transition-colors hover:text-fd-foreground"
      >
        v{componentPackage.version}
      </a>
    </span>
  );
}
