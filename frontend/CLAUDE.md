<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# frontend — the owner dashboard

Next 16 (Turbopack, React Compiler on), React 19, Tailwind v4, Reown AppKit.

| Path | What it is |
| --- | --- |
| `src/app/page.tsx` | The dashboard. The app's only page. |
| `src/app/api/daemon/[...path]/` | Server-side proxy to the local approval daemon. |
| `src/components/ui/` | Primitives lifted from the landing page. Use these. |
| `src/components/dashboard/` | The panels. |
| `src/lib/vault/` | Balance maths, card state, finality, event→history mapping. |
| `src/config/`, `src/context/` | AppKit + wagmi wiring. |

```bash
bun test src && bun run build
```

## Things that will bite you

**No webpack config.** Next 16 builds with Turbopack; a `webpack` key errors the
build. Reown's setup guide prescribes `externals` for `pino-pretty`/`lokijs`/
`encoding` — do not add it. An empty `turbopack: {}` opts out of the webpack
path, and Turbopack resolves those peers itself. The `@x402/*` packages *are*
installed explicitly, because Turbopack resolves them where webpack ignored them.

**`createAppKit` runs at module scope**, in `src/context/index.tsx`. Calling it
inside a component makes a fresh modal per render and loses connection state.

**The root layout forwards cookies to `cookieToInitialState`.** Without it a
reload drops the wallet and fails hydration.

**TS target is ES2020, not ES2017.** Below that, bigint literals do not compile.
Test files are excluded from `tsconfig` so `next build` does not typecheck
`bun:test` imports.

**React Compiler is on** — do not hand-roll `useMemo`/`memo` without a measured
reason.

**Finality reads `finalized`, falling back to `safe`, never `latest`.** On a
Flashblocks chain `latest` can already hold a preconfirmation. If neither tag
answers, everything stays `Pending` and the panel says why — the failure
direction understates finality on purpose. An approved-but-unminted request is
`neutral`, never `settled`: a signature is not a transaction.

**A card past its expiry still reads `Active` onchain** until someone calls the
permissionless `releaseExpired`, so it renders as "Expired" with a note that its
escrow is still locked — not as a live card.

**`available` is computed client-side** by `computeBalance` and clamped at 0.
`balanceOf` and `escrowedOf` are separate calls and a mint can land between them.

**The daemon proxy holds daemon authority.** A browser cannot read the 0600 token
file, so the Next server reads it. While this app runs, anything reaching
`/api/daemon/*` on its origin can drive the approval queue. Two guards keep it
from widening the daemon's hole: same-origin only, and JSON-only writes (a
cross-site form post cannot produce `application/json`). **Defensible for a
localhost MVP only** — deploying this anywhere shared needs real auth first.

**Visual language comes from `landingpage/`** (KTD-18). Reuse
`src/components/ui/`; do not start a second design system. One rule in
`globals.css` clamps AppKit's `<w3m-modal>` host, which reports a ~328px floor
even while closed and otherwise puts a scrollbar on a 320px phone.
