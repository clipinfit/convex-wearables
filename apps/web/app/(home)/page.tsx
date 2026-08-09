import {
  Activity,
  ArrowRight,
  Database,
  Github,
  Radio,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Convex Wearables — one schema for every wearable",
  description:
    "Sync wearable data into Convex, normalize every provider, control time-series storage, and generate deterministic fixtures with Synth.",
};

const providers = [
  { name: "Garmin", logo: "/providers/garmin.svg", path: "Cloud" },
  { name: "Strava", logo: "/providers/strava.svg", path: "Cloud" },
  { name: "WHOOP", logo: "/providers/whoop.svg", path: "Cloud" },
  { name: "Polar", logo: "/providers/polar.svg", path: "Cloud" },
  { name: "Suunto", logo: "/providers/suunto.svg", path: "Cloud" },
  { name: "Apple Health", logo: "/providers/apple.svg", path: "SDK" },
  {
    name: "Health Connect",
    logo: "/providers/google-health-connect.svg",
    path: "SDK",
  },
  { name: "Samsung Health", logo: "/providers/samsung.svg", path: "SDK" },
] as const;

function ProviderList({ duplicate = false }: { duplicate?: boolean }) {
  return (
    <ul className="provider-list" aria-hidden={duplicate || undefined}>
      {providers.map((provider) => (
        <li className="provider-pill" key={provider.name}>
          <span className="provider-logo-wrap">
            <Image
              src={provider.logo}
              alt=""
              width={25}
              height={22}
              className="provider-logo"
            />
          </span>
          <span className="provider-name">{provider.name}</span>
          <span className="provider-path">{provider.path}</span>
        </li>
      ))}
    </ul>
  );
}

function SignalPanel() {
  return (
    <section
      className="signal-panel"
      aria-label="Normalized wearable data preview"
    >
      <div className="signal-panel-bar">
        <div className="flex items-center gap-2">
          <span className="signal-dot bg-[#ff6159]" />
          <span className="signal-dot bg-[#ffbd2e]" />
          <span className="signal-dot bg-[#28c840]" />
        </div>
        <div className="signal-live">
          <Radio className="size-3.5" /> live ingestion
        </div>
      </div>

      <div className="signal-body">
        <div className="signal-heading">
          <div>
            <span className="signal-eyebrow">heart_rate · normalized</span>
            <div className="mt-1 flex items-end gap-2">
              <strong className="signal-value">72</strong>
              <span className="pb-1.5 text-sm text-white/45">bpm</span>
            </div>
          </div>
          <span className="signal-badge">streaming</span>
        </div>

        <div className="signal-chart">
          <div className="signal-grid" />
          <svg
            viewBox="0 0 560 132"
            role="img"
            aria-label="Animated heart-rate signal"
          >
            <defs>
              <linearGradient id="signal-gradient" x1="0" x2="1">
                <stop offset="0" stopColor="#8b5cf6" />
                <stop offset="0.48" stopColor="#22d3ee" />
                <stop offset="1" stopColor="#34d399" />
              </linearGradient>
              <filter
                id="signal-glow"
                x="-20%"
                y="-50%"
                width="140%"
                height="200%"
              >
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <path
              className="signal-line signal-line-glow"
              d="M0 78 L52 77 L77 75 L91 80 L104 76 L119 77 L132 65 L145 92 L159 18 L176 111 L192 69 L209 78 L251 77 L275 74 L290 80 L307 76 L324 77 L338 60 L350 94 L365 31 L380 104 L396 69 L413 77 L457 76 L480 73 L496 79 L511 75 L527 77 L540 63 L560 83"
            />
            <path
              className="signal-line"
              d="M0 78 L52 77 L77 75 L91 80 L104 76 L119 77 L132 65 L145 92 L159 18 L176 111 L192 69 L209 78 L251 77 L275 74 L290 80 L307 76 L324 77 L338 60 L350 94 L365 31 L380 104 L396 69 L413 77 L457 76 L480 73 L496 79 L511 75 L527 77 L540 63 L560 83"
            />
          </svg>
        </div>

        <div className="signal-events">
          <div className="signal-event">
            <span className="signal-event-icon signal-event-icon-cyan">
              <Activity className="size-4" />
            </span>
            <span>
              <small>Workout</small>
              <strong>Morning run</strong>
            </span>
            <span className="signal-event-meta">42 min</span>
          </div>
          <div className="signal-event">
            <span className="signal-event-icon signal-event-icon-violet">
              <Sparkles className="size-4" />
            </span>
            <span>
              <small>Provider</small>
              <strong>SynthDevice</strong>
            </span>
            <span className="signal-event-meta">ready</span>
          </div>
        </div>

        <div className="signal-code">
          <span className="text-violet-300">provider</span>:{" "}
          <span className="text-emerald-300">"synthetic"</span>,
          <span className="ml-2 text-cyan-300">seriesType</span>:{" "}
          <span className="text-emerald-300">"heart_rate"</span>
        </div>
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <div className="landing-page">
      <div className="landing-glow landing-glow-one" />
      <div className="landing-glow landing-glow-two" />

      <section className="hero-section">
        <div className="hero-copy">
          <Link href="/docs/guides/synthetic-data" className="release-chip">
            <span className="release-icon">
              <Sparkles className="size-3.5" />
            </span>
            New: deterministic data with Synth
            <ArrowRight className="size-3.5" />
          </Link>

          <h1 className="hero-title">
            Every wearable.
            <br />
            <span>One clean schema.</span>
          </h1>
          <p className="hero-description">
            Production-ready wearable ingestion for Convex. Connect cloud APIs,
            receive native health data, generate realistic fixtures, and query
            it all through one typed interface.
          </p>

          <div className="hero-actions">
            <Link
              href="/docs/getting-started/installation"
              className="primary-cta"
            >
              Start building <ArrowRight className="size-4" />
            </Link>
            <a
              href="https://github.com/clipinfit/convex-wearables"
              target="_blank"
              rel="noreferrer"
              className="secondary-cta"
            >
              <Github className="size-4" /> View on GitHub
            </a>
          </div>

          <div className="hero-stats">
            <div>
              <strong>9</strong>
              <span>providers</span>
            </div>
            <div>
              <strong>88</strong>
              <span>health metrics</span>
            </div>
            <div>
              <strong>1</strong>
              <span>normalized model</span>
            </div>
          </div>
        </div>

        <SignalPanel />
      </section>

      <section className="provider-section" aria-labelledby="provider-heading">
        <div className="section-kicker" id="provider-heading">
          <span>Cloud, native, or generated</span>
          <span className="section-kicker-line" />
          <span>same API on the other side</span>
        </div>
        <div className="provider-marquee">
          <div className="provider-track">
            <ProviderList />
            <ProviderList duplicate />
          </div>
        </div>
      </section>

      <section className="bento-section" aria-labelledby="why-heading">
        <div className="section-heading">
          <p className="section-label">Built for real product work</p>
          <h2 id="why-heading">From first payload to production scale.</h2>
          <p>
            The provider-specific complexity stays inside the component. Your
            app gets typed data, explicit lifecycle controls, and room to grow.
          </p>
        </div>

        <div className="bento-grid">
          <article className="bento-card bento-card-wide bento-card-violet">
            <div className="bento-icon">
              <Sparkles className="size-5" />
            </div>
            <span className="bento-tag">New in v0.5</span>
            <h3>
              Build against believable data before the first device connects.
            </h3>
            <p>
              Synth creates deterministic workouts, sleep, heart rate, HRV,
              SpO₂, steps, recovery, and summaries in the exact normalized model
              used by live providers.
            </p>
            <div className="profile-row">
              <span>active</span>
              <span>sedentary</span>
              <span>recovery</span>
              <span>mixed</span>
            </div>
            <Link href="/docs/guides/synthetic-data" className="card-link">
              Explore Synth <ArrowRight className="size-4" />
            </Link>
          </article>

          <article className="bento-card bento-card-dark">
            <div className="bento-icon">
              <Database className="size-5" />
            </div>
            <span className="bento-tag">Storage engine</span>
            <h3>Keep the signal. Control the rows.</h3>
            <p>
              Retain raw data, roll older points into useful buckets, and assign
              storage presets per user.
            </p>
            <div className="retention-viz" aria-hidden="true">
              <span className="retention-raw">raw · 24h</span>
              <span className="retention-rollup">30m rollups · 7d</span>
              <span className="retention-archive">3h · forever</span>
            </div>
            <Link href="/docs/guides/storage-policies" className="card-link">
              Design a policy <ArrowRight className="size-4" />
            </Link>
          </article>

          <article className="bento-card bento-card-code">
            <div className="bento-icon">
              <Terminal className="size-5" />
            </div>
            <span className="bento-tag">Developer experience</span>
            <h3>TypeScript from OAuth to query.</h3>
            <p>
              One client for connections, events, time series, summaries, sync,
              backfills, and lifecycle cleanup.
            </p>
            <div className="mini-code">
              <span>await</span> wearables.<strong>getTimeSeries</strong>(ctx,
              args)
            </div>
            <Link href="/docs/reference/client-api" className="card-link">
              Browse the API <ArrowRight className="size-4" />
            </Link>
          </article>

          <article className="bento-card">
            <div className="bento-icon">
              <ShieldCheck className="size-5" />
            </div>
            <span className="bento-tag">Operationally ready</span>
            <h3>Safe sync and clean exits.</h3>
            <p>
              Durable backfills, deduplication, provider-aware summaries, and a
              cascading delete path for user data.
            </p>
            <Link href="/docs/guides/sync-and-backfill" className="card-link">
              See sync controls <ArrowRight className="size-4" />
            </Link>
          </article>
        </div>
      </section>

      <section className="bottom-cta">
        <div>
          <p className="section-label">Ready when your users are</p>
          <h2>Ship the integration, not the plumbing.</h2>
        </div>
        <Link href="/docs" className="primary-cta primary-cta-light">
          Read the docs <ArrowRight className="size-4" />
        </Link>
      </section>
    </div>
  );
}
