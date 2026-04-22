#!/usr/bin/env bun
// Capture dashboard screenshots for ad-hoc UX review.
//
// Usage:
//   bun run scripts/screenshot-dashboard.ts               # uses https://cn.tynan.io
//   bun run scripts/screenshot-dashboard.ts http://localhost:4820
//
// Output: /tmp/cn-shots/<slug>.png for a fixed set of viewport × theme × view
// combinations. Read each back with an image viewer or the Read tool to
// inspect.

import * as fs from "node:fs";
import { chromium } from "playwright";

const HUB = process.argv[2] ?? "https://cn.tynan.io";
const OUT = "/tmp/cn-shots";
fs.mkdirSync(OUT, { recursive: true });

interface Shot {
  slug: string;
  viewport: { width: number; height: number };
  theme: "dark" | "light";
  /** Hash to navigate to. Empty = log view. */
  hash: string;
  /** Optional extra steps after the page has loaded. */
  prep?: (
    // biome-ignore lint/suspicious/noExplicitAny: Playwright's Page type avoids pulling it in here.
    page: any,
  ) => Promise<void>;
}

const SHOTS: Shot[] = [
  {
    slug: "desktop-dark-log",
    viewport: { width: 1280, height: 800 },
    theme: "dark",
    hash: "",
  },
  {
    slug: "desktop-light-log",
    viewport: { width: 1280, height: 800 },
    theme: "light",
    hash: "",
  },
  {
    slug: "desktop-dark-sidebar-closed",
    viewport: { width: 1280, height: 800 },
    theme: "dark",
    hash: "",
    prep: async (page) => {
      // Click the hamburger to collapse the inline sidebar.
      await page.click("#sidebar-toggle").catch(() => {});
      await page.waitForTimeout(400);
    },
  },
  {
    slug: "mobile-dark-log",
    viewport: { width: 375, height: 667 },
    theme: "dark",
    hash: "",
  },
  {
    slug: "mobile-light-log",
    viewport: { width: 375, height: 667 },
    theme: "light",
    hash: "",
  },
];

async function getFirstMirrorSid(): Promise<string | null> {
  try {
    const resp = await fetch(`${HUB}/api/mirror/sessions/all`);
    if (!resp.ok) return null;
    const list = (await resp.json()) as Array<{ sid: string }>;
    return list[0]?.sid ?? null;
  } catch {
    return null;
  }
}

async function takeShots(): Promise<void> {
  const mirrorSid = await getFirstMirrorSid();
  if (mirrorSid) {
    SHOTS.push({
      slug: "desktop-dark-mirror",
      viewport: { width: 1280, height: 800 },
      theme: "dark",
      hash: `#agent=${encodeURIComponent(mirrorSid)}`,
    });
    SHOTS.push({
      slug: "mobile-dark-mirror",
      viewport: { width: 375, height: 667 },
      theme: "dark",
      hash: `#agent=${encodeURIComponent(mirrorSid)}`,
    });
  } else {
    process.stderr.write("no mirror sessions — skipping mirror-view shots\n");
  }

  const browser = await chromium.launch();
  try {
    for (const shot of SHOTS) {
      const isMobile = shot.viewport.width < 768;
      const ctx = await browser.newContext({
        viewport: shot.viewport,
        deviceScaleFactor: 2,
        hasTouch: isMobile,
        isMobile,
      });
      const page = await ctx.newPage();
      // Seed the theme key before first paint so the inline theme bootstrap
      // reads the value we want.
      await page.addInitScript((t: string) => {
        try {
          localStorage.setItem("claude-net.mirror.theme", t);
        } catch {
          // ignore
        }
      }, shot.theme);
      const url = `${HUB}/${shot.hash}`;
      await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
      // Give Bootstrap's offcanvas animation + initial renderAgents() a tick.
      await page.waitForTimeout(600);
      if (shot.prep) await shot.prep(page);
      await page.screenshot({
        path: `${OUT}/${shot.slug}.png`,
        fullPage: false,
      });
      process.stdout.write(
        `wrote ${shot.slug}.png (${shot.viewport.width}x${shot.viewport.height}, ${shot.theme})\n`,
      );
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

takeShots().catch((err) => {
  process.stderr.write(`screenshot-dashboard: ${err?.message ?? err}\n`);
  process.exit(1);
});
