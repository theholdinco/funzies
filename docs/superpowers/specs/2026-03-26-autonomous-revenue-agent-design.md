# Autonomous Revenue-Generating AI Agent

**Date:** 2026-03-26
**Status:** Approved

## Overview

An autonomous AI agent that runs on Railway, powered by Claude Code in headless mode, that continuously ideates, builds, ships, and monetizes digital products while growing a Twitter/X presence from zero. The agent operates with maximum autonomy, self-improves over time, and communicates with its owner via Telegram.

## Goals

1. **Generate revenue** (primary) — build and sell digital products autonomously
2. **Grow Twitter/X presence** (secondary) — build an audience from zero followers
3. **Continuously self-improve** — evolve its own strategy, prompts, and code

## Architecture

### System Layers

```
┌─────────────────────────────────────────────────────┐
│  ORCHESTRATOR (Railway — always-on Node process)     │
│  Loop: run cycle → report → sleep 30min → repeat    │
│  Maintains state in JSON files                       │
└──────────────┬──────────────────┬────────────────────┘
               │                  │
    ┌──────────▼──────┐  ┌───────▼────────┐
    │  CLAUDE CODE    │  │  INTEGRATIONS  │
    │  CLI headless   │  │                │
    │  mode on the    │  │  - Stripe API  │
    │  Railway server │  │  - Twitter/X   │
    │  Full autonomy: │  │  - Railway API │
    │  files, git,    │  │  - Telegram    │
    │  bash, subagents│  │  - GitHub      │
    └─────────────────┘  └────────────────┘
               │
    ┌──────────▼──────────────────┐
    │  STATE STORE (JSON files)   │
    │  - Current projects         │
    │  - Revenue tracking         │
    │  - Ideas backlog            │
    │  - Activity log             │
    │  - Budget spent             │
    └─────────────────────────────┘
```

### Loop Design

Event-driven, not clock-driven. Each cycle:

1. **INBOX** → check Telegram for owner messages
2. ASSESS → DECIDE → execute chosen phase → REPORT
3. Send Telegram update
4. Wait 30 minutes
5. Repeat

No concurrency. One phase at a time. If a phase takes 45 minutes, it finishes naturally, then the 30-minute cooldown starts.

### Owner Inbox (pre-phase step, every cycle)

Before anything else, the agent checks Telegram for messages from the owner. These are processed as **directives** that influence the current cycle:

- **Ideas:** "You should build X" or "What about a tool that does Y" → added to ideas backlog in `STATE.json` with high priority, DECIDE will likely pick IDEATE or BUILD next
- **Feedback:** "Product X needs a better landing page" or "The pricing is too high" → attached to the relevant project in `STATE.json`, next BUILD/MAINTAIN cycle addresses it
- **Strategy:** "Focus on Twitter this week" or "Stop building PDFs, try micro-tools" → written directly into `STRATEGY.md` as an owner directive (takes precedence over agent's own strategy)
- **Requests:** "Make me a personal website" or "Can you set up a blog?" → treated as top-priority task, overrides normal DECIDE logic
- **Approvals:** "YES" / "NO" responses to pending approval requests → resolved immediately

If there are no messages, the agent proceeds normally. If there are multiple messages, they're all processed before ASSESS runs.

The agent acknowledges each message with a short Telegram reply: "Got it — I'll build X next cycle" or "Noted, updating strategy to focus on Twitter."

## Phases

### ASSESS (2-3 min, every cycle)

Reads current state and external APIs to build context:
- `STATE.json` — projects, revenue, active tasks
- Railway status — are all services up?
- Stripe — any new payments since last cycle?
- Twitter metrics — follower count, engagement
- Error log — anything unresolved?
- Telegram inbox — any messages from owner?

Outputs updated `STATE.json` and priority-ranked list of possible actions.

### DECIDE (1-2 min, every cycle)

Pure reasoning. Claude reads ASSESS output + `STRATEGY.md` + `PLAYBOOK.md` and picks the highest-value action:
- Something broken? → MAINTAIN (highest priority)
- Owner sent a message? → Handle it
- Project mid-build? → BUILD or SHIP
- No active projects? → IDEATE
- Project live but no traffic? → PROMOTE
- 20+ cycles since last EVOLVE? → EVOLVE
- Revenue stagnating? → REFLECT then EVOLVE

### IDEATE (10-30 min, when needed)

Full research + validation session. Multi-step, may spawn subagents:

1. **Market scan** — web search for trending problems, niches, pain points. Check Twitter, Reddit, indie hacker communities.
2. **Filter against capabilities** — can I build this with Railway, static sites, APIs? Is there a monetization path? Can I build an MVP in 1-3 cycles?
3. **Validate against PLAYBOOK.md** — tried something similar? What happened?
4. **Score and pick** — rank by buildability x revenue potential x speed to ship. Write product spec to `STATE.json`.

### BUILD (15-60 min, multi-session capable)

The heaviest phase. Full Claude Code autonomy:

1. **Scaffold** — create project directory, set up framework, init git branch
2. **Build MVP** — code the product. Multi-step: write → run → errors → fix → run → iterate. Spawn subagents for parallel work if useful.
3. **Integrate payments** — Stripe checkout/payment links, webhook handler
4. **Test** — agent tests its own work end-to-end. Debug loop if tests fail.
5. **Git commit + push** — triggers Railway deploy

If BUILD can't finish in one cycle, saves progress to `STATE.json` with `"status": "building"` and resume context. Next cycle picks up where it left off.

### SHIP (5-15 min)

1. **Verify deployment** — check Railway deploy succeeded, hit live URL
2. **Set up monitoring** — health check endpoint, register in `STATE.json`
3. **Go live** — use live Stripe API key (stored in `STRIPE_LIVE_KEY` env var, separate from `STRIPE_TEST_KEY`), update project status to "live"

If deploy fails → error to Telegram, move to MAINTAIN.

### PROMOTE (10-20 min)

1. **Decide channel and angle** — read `STRATEGY.md`, check what's performed well
2. **Create content** — tweets, threads, blog posts, Product Hunt drafts
3. **Post** — via Twitter API
4. **Engage** — reply to relevant conversations, quote-tweet, follow relevant accounts
5. **Log** — record what was posted, check engagement metrics next cycle

### MAINTAIN (5-30 min, triggered by errors)

Full Claude Code debug loop: read logs → hypothesize → edit code → test → push → verify. Handle customer support issues or escalate to owner via Telegram.

### REFLECT (10-15 min, periodic)

Performance analysis:
- Revenue data per project
- Twitter growth metrics
- Cost per acquisition
- Best/worst performing products and content
- Recommendations: kill a project, double down, pivot
- Write findings to `PLAYBOOK.md`

### EVOLVE (15-30 min, periodic)

Self-improvement. Can modify:
- `STRATEGY.md` — new approach, new focus
- Phase prompts — improve how phases work
- Orchestrator code — add integrations, fix bugs, refactor
- `PLAYBOOK.md` — codify learned patterns
- Create reusable templates from successful projects

Guardrails (cannot modify):
- Cannot remove Telegram notifications
- Cannot modify `BRAIN.md` core constraints
- Cannot exceed spending without owner approval
- Cannot delete live products without owner approval
- Must log all self-modifications to `CHANGELOG.md`

## Integrations

| Integration | Purpose | Auth |
|------------|---------|------|
| Telegram Bot API | Owner communication, updates, errors, approvals | Bot token (env var) |
| Twitter/X API v2 | Posting, engagement, metrics | OAuth tokens (env var) |
| Stripe API | Create products, payment links, check payments (polling, not webhooks) | Test + Live secret keys (env vars) |
| Railway API | Deploy services, check status | API token (env var) |
| GitHub | Commit, push, trigger deploys | SSH key on Railway server |

## Twitter/X — Cold Start Strategy

The agent starts from 0 followers and must be strategically self-aware about this:

### Phase 1: Exist and Build (weeks 1-2)
- Pick identity/brand (first EVOLVE decision)
- Post consistently so profile isn't empty
- Focus on being interesting, not promotional
- Follow and genuinely engage with 10-20 indie builders daily
- Reply with useful, thoughtful takes
- Build in public — raw numbers, screenshots, honest updates

### Phase 2: Outbound (weeks 2-4)
- Ask owner via Telegram to DM/intro to builders who might find products useful
- Share products in relevant communities with genuine value
- Ask owner for introductions and signal boosts via Telegram
- Contribute to relevant Twitter threads meaningfully
- Cross-post to Reddit, Hacker News, indie hacker forums

### Phase 3: Flywheel (month 2+)
- Double down on what content resonates
- Revenue milestones + "AI building in public" narrative compounds
- The story itself is interesting and drives engagement

### What NOT to do
- Don't spam DMs
- Don't post generic motivational content
- Don't follow/unfollow game
- Don't pretend to have traction it doesn't have
- Don't get the account suspended (rate limit API calls conservatively)

## Repo Structure

```
autonomous-agent/
├── agent/
│   ├── orchestrator.ts           # Main loop: cycle → sleep 30min → repeat
│   ├── phases/
│   │   ├── assess.ts             # Reads state, APIs, checks health
│   │   ├── decide.ts             # Picks next action
│   │   ├── ideate.ts             # Market research + idea generation
│   │   ├── build.ts              # Scaffolds and codes products
│   │   ├── ship.ts               # Deploys, verifies, goes live
│   │   ├── promote.ts            # Twitter content, engagement
│   │   ├── maintain.ts           # Bug fixes, error handling
│   │   ├── reflect.ts            # Performance analysis
│   │   └── evolve.ts             # Self-improvement
│   ├── integrations/
│   │   ├── telegram.ts           # Send/read messages
│   │   ├── twitter.ts            # Post, engage, read metrics
│   │   ├── stripe.ts             # Create products, check payments
│   │   ├── railway.ts            # Deploy, check status
│   │   └── github.ts             # Commit, push, create repos
│   ├── state/
│   │   ├── STATE.json            # Current state (persisted)
│   │   └── state.ts              # Read/write helpers
│   └── brain/
│       ├── BRAIN.md              # Core identity + mission (protected)
│       ├── STRATEGY.md           # Current approach (agent-editable)
│       ├── PLAYBOOK.md           # Learned lessons (agent-editable)
│       └── CHANGELOG.md          # Self-modification log
├── products/                     # Agent's shipped products live here
│   └── (created by agent)
├── Dockerfile                    # For Railway deployment
└── package.json
```

## How Phase Files Work

Each phase `.ts` file assembles context and prompts, then launches Claude Code CLI in headless mode via subprocess. Example:

```ts
import { execFile } from 'child_process';

async function runClaudeCode(prompt: string, allowedTools: string[]): Promise<string> {
  // Spawns: claude -p "<prompt>" --output-format json --allowedTools "..."
  // Returns Claude's text response after it finishes working
  // Timeout: 60 minutes max per invocation
  // If Claude Code hits rate limits, the orchestrator waits and retries once
  return new Promise((resolve, reject) => {
    const proc = execFile('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--allowedTools', allowedTools.join(','),
    ], { timeout: 60 * 60 * 1000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(JSON.parse(stdout).result);
    });
  });
}

export async function runBuild(state: State) {
  const prompt = `
    You are an autonomous product builder.
    Current project: ${state.currentProject.name}
    Spec: ${state.currentProject.spec}
    Progress so far: ${state.currentProject.buildProgress}

    Build this product. You have full filesystem, git, and bash access.
    When done, commit and push to trigger deploy.
    If stuck, document where in your response.
  `;

  const result = await runClaudeCode(prompt, ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
  return updateState(state, result);
}
```

Claude Code does all real work. TypeScript is orchestration glue.

## Approval Flow

When the agent needs owner approval (spending money, killing a product):

1. Agent sends Telegram message with the request and context
2. Agent saves `"pending_approval": { "type": "spend", "amount": 12, "reason": "domain" }` to `STATE.json`
3. Next cycles continue normally but skip the pending action
4. ASSESS checks Telegram inbox each cycle for owner's reply
5. If owner replies YES → execute the action. If NO → drop it. If no reply after 48h → remind once, then drop.

The agent never blocks waiting. It continues other work while approval is pending.

## EVOLVE Safety

When the agent modifies its own orchestrator code:

1. All changes are committed to a `self-update` branch, not `main`
2. Agent runs the modified code's test suite (if any)
3. If tests pass, it merges to `main` and the Railway redeploy picks it up
4. If the orchestrator fails to start after a self-update, Railway's health check fails and it rolls back to the previous deploy automatically
5. Railway's rollback behavior is the safety net — no custom rollback logic needed

## Brain Files

### BRAIN.md — Core (protected)

Full contents:

```markdown
# Identity

You are an autonomous AI entrepreneur. You build, ship, and monetize
digital products. You grow an audience on Twitter/X. You operate
independently with minimal human oversight.

# Mission

1. Generate revenue (primary)
2. Grow Twitter/X presence (secondary)
3. Continuously improve your own process

# Owner Communication

- Telegram is your lifeline to your owner
- Send updates after every cycle
- Send errors immediately
- Ask permission before spending money (domains, paid tools)
- If the owner sends you a message, prioritize reading it next cycle

# Social Reality

You are starting from absolute zero. No followers, no credibility,
no audience. Posting into the void is expected. Do not measure
success by engagement in the early days.

Growing from zero requires outbound effort, not just posting:
- Reply to and engage with indie hackers, builders, AI enthusiasts
- Share genuinely useful things, not just self-promotion
- Ask your owner for help when you need signal boosts or introductions
- Study what accounts with similar trajectories did to grow
- Be creative — the playbook for growing from zero is different
  from growing from 1000

You can ask your owner via Telegram:
- "Can you RT this?"
- "Do you know anyone who'd find this useful?"
- "Should I try posting on Reddit/HN too?"

# Hard Constraints (NEVER modify this section)

- Never remove Telegram notifications
- Never modify this Hard Constraints section of BRAIN.md
- Never spend money without owner approval via Telegram
- Never delete a live product without owner approval
- Never impersonate a real person
- Always commit and push work frequently — be recoverable
- Log all self-modifications to CHANGELOG.md
- Never store secrets in code — use environment variables
- Never run the orchestrator without the core loop intact
  (assess → decide → execute → report → sleep)
```

### STRATEGY.md — Initial (agent-editable)

Cold start strategy: ship something small fast, build in public on Twitter, learn and iterate. Start with digital products ($5-29), target developers/indie hackers, one product at a time. Success metrics: first dollar within 1 week, 100 followers within 2 weeks, 3 products shipped within first month. EVOLVE triggers: after 20 cycles, or $0 revenue for 5 consecutive cycles, or 48+ hours with zero traffic on a live product.

### PLAYBOOK.md — Empty (agent-populated)

Populated through REFLECT and EVOLVE phases. Tracks: what works, what doesn't, templates/patterns, revenue log.

## Infrastructure

- **Compute:** Claude Code Max subscription (owner's account, installed on Railway server)
- **Hosting:** Railway (orchestrator + all products the agent builds)
- **Payments:** Stripe
- **State:** JSON files persisted on Railway volume. State is also committed to git every cycle, so git history serves as the backup. If Railway volume is lost, clone the repo and state is recovered from the last commit.
- **Budget:** Free tiers for everything. Agent asks via Telegram before any spend.

## Accounts to Set Up

1. Telegram Bot (via BotFather)
2. Twitter/X developer account + fresh user account
3. Stripe account
4. Railway project (owner already has account with card linked)
5. GitHub repo for the agent
