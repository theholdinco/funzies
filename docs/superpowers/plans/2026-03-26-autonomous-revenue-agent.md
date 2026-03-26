# Autonomous Revenue-Generating Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an autonomous agent that runs on Railway, powered by Claude Code headless mode, that continuously ideates, builds, ships, and monetizes digital products while growing a Twitter/X presence.

**Architecture:** A TypeScript orchestrator runs a perpetual loop (INBOX → ASSESS → DECIDE → execute phase → REPORT → sleep 30min). Each phase assembles context and launches Claude Code CLI in headless mode (`claude -p`). Claude does all real work. The orchestrator is glue. State is persisted in JSON, committed to git each cycle. Telegram for owner comms, Twitter for audience, Stripe for payments.

**Tech Stack:** TypeScript, Node.js, Claude Code CLI (headless), Telegram Bot API, Twitter API v2, Stripe API, Railway (hosting), Git/GitHub

**Spec:** `docs/superpowers/specs/2026-03-26-autonomous-revenue-agent-design.md`

---

## File Map

```
autonomous-agent/
├── package.json
├── tsconfig.json
├── Dockerfile
├── .env.example                    # Template for required env vars
├── agent/
│   ├── orchestrator.ts             # Main loop: inbox → assess → decide → execute → report → sleep
│   ├── claude.ts                   # runClaudeCode() — spawns claude -p subprocess
│   ├── types.ts                    # State, Project, Phase types
│   ├── phases/
│   │   ├── inbox.ts                # Check Telegram for owner messages, classify & apply
│   │   ├── assess.ts               # Read state + external APIs, build context
│   │   ├── decide.ts               # Pick highest-value phase to execute
│   │   ├── ideate.ts               # Market research, idea generation
│   │   ├── build.ts                # Code products, integrate payments
│   │   ├── ship.ts                 # Deploy, verify, go live
│   │   ├── promote.ts              # Tweet, engage, create content
│   │   ├── maintain.ts             # Fix bugs, handle errors
│   │   ├── reflect.ts              # Analyze performance, update playbook
│   │   └── evolve.ts               # Self-improvement, strategy updates
│   ├── integrations/
│   │   ├── telegram.ts             # Send/read messages via Bot API
│   │   ├── twitter.ts              # Post tweets, read metrics via API v2
│   │   ├── stripe.ts               # Create products, check payments
│   │   └── railway.ts              # Check deploy status via API
│   └── state/
│       ├── state.ts                # Read/write STATE.json, git commit state
│       └── STATE.json              # Persisted state (created at runtime)
├── brain/
│   ├── BRAIN.md                    # Core identity + mission (protected)
│   ├── STRATEGY.md                 # Current approach (agent-editable)
│   ├── PLAYBOOK.md                 # Learned lessons (agent-editable)
│   └── CHANGELOG.md                # Self-modification log
└── products/                       # Products built by the agent (created at runtime)
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `autonomous-agent/package.json`
- Create: `autonomous-agent/tsconfig.json`
- Create: `autonomous-agent/.env.example`
- Create: `autonomous-agent/.gitignore`

- [ ] **Step 1: Create the project directory and initialize**

```bash
mkdir -p /Users/solal/Documents/GitHub/autonomous-agent
cd /Users/solal/Documents/GitHub/autonomous-agent
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "autonomous-agent",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/agent/orchestrator.js",
    "dev": "tsx agent/orchestrator.ts"
  },
  "dependencies": {
    "node-telegram-bot-api": "^0.66.0",
    "stripe": "^17.0.0",
    "twitter-api-v2": "^1.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/node-telegram-bot-api": "^0.64.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["agent/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create .env.example**

```
ANTHROPIC_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_CHAT_ID=
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=
STRIPE_TEST_KEY=
STRIPE_LIVE_KEY=
RAILWAY_API_TOKEN=
COOLDOWN_MINUTES=30
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
.env
```

- [ ] **Step 6: Install dependencies**

```bash
cd /Users/solal/Documents/GitHub/autonomous-agent && npm install
```

- [ ] **Step 7: Commit**

```bash
git init && git add -A && git commit -m "chore: scaffold autonomous-agent project"
```

---

## Task 2: Types & State Management

**Files:**
- Create: `autonomous-agent/agent/types.ts`
- Create: `autonomous-agent/agent/state/state.ts`

- [ ] **Step 1: Create types.ts**

All shared types for the project. This is the contract between phases.

```ts
// agent/types.ts

export type Phase = 'inbox' | 'assess' | 'decide' | 'ideate' | 'build' | 'ship' | 'promote' | 'maintain' | 'reflect' | 'evolve';

export interface Project {
  id: string;
  name: string;
  spec: string;
  status: 'idea' | 'building' | 'deploying' | 'live' | 'dead';
  buildProgress: string;
  railwayServiceId?: string;
  stripeProductId?: string;
  stripePaymentLink?: string;
  liveUrl?: string;
  revenue: number;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface PendingApproval {
  type: 'spend' | 'delete_product';
  description: string;
  amount?: number;
  createdAt: string;
  reminderSent: boolean;
}

export interface OwnerDirective {
  type: 'idea' | 'feedback' | 'strategy' | 'request' | 'approval';
  content: string;
  projectId?: string;
  receivedAt: string;
  processed: boolean;
}

export interface CycleLog {
  cycle: number;
  phase: Phase;
  summary: string;
  timestamp: string;
}

export interface State {
  cycleCount: number;
  currentPhase: Phase | null;
  currentProjectId: string | null;
  projects: Project[];
  ideasBacklog: Array<{ idea: string; priority: 'high' | 'normal'; source: 'agent' | 'owner'; addedAt: string }>;
  ownerDirectives: OwnerDirective[];
  pendingApprovals: PendingApproval[];
  errors: Array<{ message: string; phase: Phase; timestamp: string; resolved: boolean }>;
  revenueTotal: number;
  lastEvolveCycle: number;
  lastReflectCycle: number;
  twitterFollowers: number;
  recentCycles: CycleLog[];
}
```

- [ ] **Step 2: Create state.ts**

Read/write `STATE.json` + git commit state each cycle.

```ts
// agent/state/state.ts

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { State } from '../types.js';
import { join } from 'path';

// Use process.cwd() for all paths — the Dockerfile sets WORKDIR /app
// and the start script runs from the repo root. This avoids import.meta.dirname
// pointing to dist/ in production but brain/state files living at repo root.
const ROOT_DIR = process.cwd();
const STATE_PATH = join(ROOT_DIR, 'agent', 'state', 'STATE.json');

const DEFAULT_STATE: State = {
  cycleCount: 0,
  currentPhase: null,
  currentProjectId: null,
  projects: [],
  ideasBacklog: [],
  ownerDirectives: [],
  pendingApprovals: [],
  errors: [],
  revenueTotal: 0,
  lastEvolveCycle: 0,
  lastReflectCycle: 0,
  twitterFollowers: 0,
  recentCycles: [],
};

export function loadState(): State {
  if (!existsSync(STATE_PATH)) {
    writeFileSync(STATE_PATH, JSON.stringify(DEFAULT_STATE, null, 2));
    return { ...DEFAULT_STATE };
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
}

export function saveState(state: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function commitState(summary: string): void {
  execSync('git add -A', { cwd: ROOT_DIR, stdio: 'ignore' });
  execSync(`git commit -m "cycle: ${summary}" --allow-empty`, { cwd: ROOT_DIR, stdio: 'ignore' });
  execSync('git push', { cwd: ROOT_DIR, stdio: 'ignore' });
}
```

- [ ] **Step 3: Commit**

```bash
git add agent/types.ts agent/state/state.ts && git commit -m "feat: add types and state management"
```

---

## Task 3: Claude Code Runner

**Files:**
- Create: `autonomous-agent/agent/claude.ts`

- [ ] **Step 1: Create claude.ts**

This is the core utility that every phase uses to invoke Claude Code headless.

```ts
// agent/claude.ts

import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT_DIR = process.cwd();
const BRAIN_PATH = join(ROOT_DIR, 'brain', 'BRAIN.md');
const STRATEGY_PATH = join(ROOT_DIR, 'brain', 'STRATEGY.md');
const PLAYBOOK_PATH = join(ROOT_DIR, 'brain', 'PLAYBOOK.md');

export interface ClaudeResult {
  result: string;
  costUsd: number;
  durationMs: number;
  isError: boolean;
}

function readBrainContext(): string {
  const brain = readFileSync(BRAIN_PATH, 'utf-8');
  const strategy = readFileSync(STRATEGY_PATH, 'utf-8');
  const playbook = readFileSync(PLAYBOOK_PATH, 'utf-8');
  return `<brain>\n${brain}\n</brain>\n\n<strategy>\n${strategy}\n</strategy>\n\n<playbook>\n${playbook}\n</playbook>`;
}

export async function runClaudeCode(
  phasePrompt: string,
  options: {
    allowedTools?: string[];
    maxBudgetUsd?: number;
    timeoutMinutes?: number;
    includeBrainContext?: boolean;
  } = {}
): Promise<ClaudeResult> {
  const {
    allowedTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    maxBudgetUsd = 5,
    timeoutMinutes = 60,
    includeBrainContext = true,
  } = options;

  const brainContext = includeBrainContext ? readBrainContext() : '';
  const fullPrompt = brainContext
    ? `${brainContext}\n\n---\n\n${phasePrompt}`
    : phasePrompt;

  const args = [
    '-p', fullPrompt,
    '--output-format', 'json',
    '--allowedTools', allowedTools.join(','),
    '--max-budget-usd', maxBudgetUsd.toString(),
    '--permission-mode', 'bypassPermissions',
    '--bare',
  ];

  return new Promise((resolve) => {
    execFile('claude', args, {
      timeout: timeoutMinutes * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
      cwd: ROOT_DIR,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          result: `Error: ${err.message}\nStderr: ${stderr}`,
          costUsd: 0,
          durationMs: 0,
          isError: true,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          result: parsed.result ?? stdout,
          costUsd: parsed.cost_usd ?? 0,
          durationMs: parsed.duration_ms ?? 0,
          isError: false,
        });
      } catch {
        resolve({
          result: stdout,
          costUsd: 0,
          durationMs: 0,
          isError: false,
        });
      }
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/claude.ts && git commit -m "feat: add Claude Code headless runner"
```

---

## Task 4: Telegram Integration

**Files:**
- Create: `autonomous-agent/agent/integrations/telegram.ts`

- [ ] **Step 1: Create telegram.ts**

```ts
// agent/integrations/telegram.ts

import TelegramBot from 'node-telegram-bot-api';

let bot: TelegramBot | null = null;
const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID!;

function getBot(): TelegramBot {
  if (!bot) {
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: false });
  }
  return bot;
}

export async function sendTelegram(message: string): Promise<void> {
  // Telegram messages have a 4096 char limit — truncate if needed
  const truncated = message.length > 4000
    ? message.slice(0, 3997) + '...'
    : message;
  await getBot().sendMessage(ownerChatId, truncated);
}

export async function sendError(phase: string, error: string): Promise<void> {
  await sendTelegram(`🚨 ERROR in ${phase}:\n\n${error}`);
}

export async function sendCycleUpdate(cycle: number, phase: string, summary: string): Promise<void> {
  await sendTelegram(`Cycle #${cycle} [${phase}]: ${summary}`);
}

export async function sendApprovalRequest(description: string, amount?: number): Promise<void> {
  const msg = amount
    ? `💰 Approval needed: ${description} ($${amount})\nReply YES or NO`
    : `❓ Approval needed: ${description}\nReply YES or NO`;
  await sendTelegram(msg);
}

export async function getRecentMessages(): Promise<Array<{ text: string; date: number }>> {
  // Use getUpdates to fetch messages since last check
  // We use polling: false and manually call getUpdates
  const updates = await getBot().getUpdates({ timeout: 1, limit: 50 });

  const messages = updates
    .filter(u => u.message?.chat.id.toString() === ownerChatId && u.message?.text)
    .map(u => ({
      text: u.message!.text!,
      date: u.message!.date,
    }));

  // Acknowledge the updates so they don't come back
  if (updates.length > 0) {
    const lastUpdateId = updates[updates.length - 1].update_id;
    await getBot().getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
  }

  return messages;
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/integrations/telegram.ts && git commit -m "feat: add Telegram integration"
```

---

## Task 5: Twitter Integration

**Files:**
- Create: `autonomous-agent/agent/integrations/twitter.ts`

- [ ] **Step 1: Create twitter.ts**

```ts
// agent/integrations/twitter.ts

import { TwitterApi } from 'twitter-api-v2';

let client: TwitterApi | null = null;

function getClient(): TwitterApi {
  if (!client) {
    client = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY!,
      appSecret: process.env.TWITTER_API_SECRET!,
      accessToken: process.env.TWITTER_ACCESS_TOKEN!,
      accessSecret: process.env.TWITTER_ACCESS_SECRET!,
    });
  }
  return client;
}

export async function tweet(text: string): Promise<string> {
  const result = await getClient().v2.tweet(text);
  return result.data.id;
}

export async function replyToTweet(tweetId: string, text: string): Promise<string> {
  const result = await getClient().v2.reply(text, tweetId);
  return result.data.id;
}

export async function getFollowerCount(): Promise<number> {
  const me = await getClient().v2.me({ 'user.fields': ['public_metrics'] });
  return me.data.public_metrics?.followers_count ?? 0;
}

export async function getRecentMentions(): Promise<Array<{ id: string; text: string; authorId: string }>> {
  const me = await getClient().v2.me();
  const mentions = await getClient().v2.userMentionTimeline(me.data.id, { max_results: 10 });
  return (mentions.data.data ?? []).map(t => ({
    id: t.id,
    text: t.text,
    authorId: t.author_id ?? '',
  }));
}

export async function searchRecentTweets(query: string, maxResults = 10): Promise<Array<{ id: string; text: string; authorId: string }>> {
  const result = await getClient().v2.search(query, { max_results: maxResults });
  return (result.data.data ?? []).map(t => ({
    id: t.id,
    text: t.text,
    authorId: t.author_id ?? '',
  }));
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/integrations/twitter.ts && git commit -m "feat: add Twitter API v2 integration"
```

---

## Task 6: Stripe Integration

**Files:**
- Create: `autonomous-agent/agent/integrations/stripe.ts`

- [ ] **Step 1: Create stripe.ts**

```ts
// agent/integrations/stripe.ts

import Stripe from 'stripe';

let testClient: Stripe | null = null;
let liveClient: Stripe | null = null;

function getTestClient(): Stripe {
  if (!testClient) testClient = new Stripe(process.env.STRIPE_TEST_KEY!);
  return testClient;
}

function getLiveClient(): Stripe {
  if (!liveClient) liveClient = new Stripe(process.env.STRIPE_LIVE_KEY!);
  return liveClient;
}

function getClient(live: boolean): Stripe {
  return live ? getLiveClient() : getTestClient();
}

export async function createProduct(name: string, description: string, priceInCents: number, live = false): Promise<{ productId: string; priceId: string }> {
  const client = getClient(live);
  const product = await client.products.create({ name, description });
  const price = await client.prices.create({
    product: product.id,
    unit_amount: priceInCents,
    currency: 'usd',
  });
  return { productId: product.id, priceId: price.id };
}

export async function createPaymentLink(priceId: string, live = false): Promise<string> {
  const client = getClient(live);
  const link = await client.paymentLinks.create({
    line_items: [{ price: priceId, quantity: 1 }],
  });
  return link.url;
}

export async function getRecentPayments(since: Date, live = true): Promise<Array<{ amount: number; product: string; created: Date }>> {
  const client = getClient(live);
  const charges = await client.charges.list({
    created: { gte: Math.floor(since.getTime() / 1000) },
    limit: 100,
  });
  return charges.data
    .filter(c => c.paid && !c.refunded)
    .map(c => ({
      amount: c.amount / 100,
      product: c.description ?? 'unknown',
      created: new Date(c.created * 1000),
    }));
}

export async function getTotalRevenue(live = true): Promise<number> {
  const client = getClient(live);
  const balance = await client.balance.retrieve();
  const available = balance.available.reduce((sum, b) => sum + b.amount, 0);
  const pending = balance.pending.reduce((sum, b) => sum + b.amount, 0);
  return (available + pending) / 100;
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/integrations/stripe.ts && git commit -m "feat: add Stripe integration (test + live)"
```

---

## Task 7: Railway Integration

**Files:**
- Create: `autonomous-agent/agent/integrations/railway.ts`

- [ ] **Step 1: Create railway.ts**

Railway uses a GraphQL API. We keep it simple with fetch.

```ts
// agent/integrations/railway.ts

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

async function railwayQuery(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RAILWAY_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json() as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

export async function getServiceStatus(serviceId: string): Promise<{ status: string; url: string | null }> {
  const data = await railwayQuery(`
    query ($serviceId: String!) {
      service(id: $serviceId) {
        name
        deployments(first: 1) {
          edges {
            node {
              status
            }
          }
        }
        serviceInstances(first: 1) {
          edges {
            node {
              domains {
                serviceDomains { domain }
              }
            }
          }
        }
      }
    }
  `, { serviceId }) as any;

  const deployment = data?.service?.deployments?.edges?.[0]?.node;
  const domain = data?.service?.serviceInstances?.edges?.[0]?.node?.domains?.serviceDomains?.[0]?.domain;

  return {
    status: deployment?.status ?? 'UNKNOWN',
    url: domain ? `https://${domain}` : null,
  };
}

export async function checkServiceHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/integrations/railway.ts && git commit -m "feat: add Railway API integration"
```

---

## Task 8: Brain Files

**Files:**
- Create: `autonomous-agent/brain/BRAIN.md`
- Create: `autonomous-agent/brain/STRATEGY.md`
- Create: `autonomous-agent/brain/PLAYBOOK.md`
- Create: `autonomous-agent/brain/CHANGELOG.md`

- [ ] **Step 1: Create BRAIN.md**

Copy the exact content from the spec (lines 313-364 of the spec document).

- [ ] **Step 2: Create STRATEGY.md**

```markdown
# Current Strategy

## Phase: Cold Start
I have no products, no audience, no revenue. Priority order:

1. Ship something small and fast — optimize for speed to first dollar
2. Build in public on Twitter — document what I'm building and why
3. Learn from what works and iterate

## Product Approach
- Start with digital products (lowest complexity, fastest to ship)
- Ideas to explore: templates, tools, guides, calculators, APIs
- Target: developers and indie hackers (I understand their problems)
- Price low to start ($5-29), optimize for volume and learning
- One product at a time until I have a working pipeline

## Tech Approach
- Next.js or plain HTML for landing pages
- Stripe Checkout for payments (not custom flows)
- Deploy everything on Railway
- Reuse successful patterns — templatize what works

## Twitter Approach — Cold Start Reality

I have 0 followers. My early strategy must account for this:

### Phase 1: Exist and Build (weeks 1-2)
- Pick my identity/brand (first EVOLVE decision)
- Post consistently so my profile isn't empty
- Focus on being interesting, not promotional
- Follow and genuinely engage with 10-20 indie builders daily
- Reply with useful, thoughtful takes (not generic)
- Build in public — share raw numbers, screenshots, honest updates

### Phase 2: Outbound (weeks 2-4)
- Ask owner for intros to builders who might find products useful
- Share products in relevant communities (genuine value, not spam)
- Ask owner for signal boosts via Telegram
- Contribute meaningfully to relevant Twitter threads
- Consider cross-posting to Reddit, Hacker News, indie forums

### Phase 3: Flywheel (month 2+)
- Double down on what content resonates
- Revenue milestones + "AI building in public" narrative compounds

## Success Metrics
- Revenue: first dollar within 1 week
- Twitter: first 100 followers within 2 weeks
- Products: 3 shipped within first month

## When to EVOLVE
- After 20 cycles, or
- Revenue has been $0 for 5+ consecutive cycles, or
- A product has been live 48+ hours with zero traffic
```

- [ ] **Step 3: Create PLAYBOOK.md**

```markdown
# Playbook — What I've Learned

## What Works

## What Doesn't

## Templates & Patterns

## Revenue Log
| Date | Product | Amount | Channel |
|------|---------|--------|---------|
```

- [ ] **Step 4: Create CHANGELOG.md**

```markdown
# Self-Modification Log

All changes the agent makes to its own prompts, strategy, and code.

| Cycle | Date | What Changed | Why |
|-------|------|-------------|-----|
```

- [ ] **Step 5: Commit**

```bash
git add brain/ && git commit -m "feat: add brain files (BRAIN.md, STRATEGY.md, PLAYBOOK.md, CHANGELOG.md)"
```

---

## Task 9: INBOX Phase

**Files:**
- Create: `autonomous-agent/agent/phases/inbox.ts`

- [ ] **Step 1: Create inbox.ts**

This phase runs first every cycle. It checks Telegram for owner messages, classifies them using Claude, and applies them to state.

```ts
// agent/phases/inbox.ts

import { State, OwnerDirective } from '../types.js';
import { getRecentMessages, sendTelegram } from '../integrations/telegram.js';
import { runClaudeCode } from '../claude.js';
import { saveState } from '../state/state.js';

export async function runInbox(state: State): Promise<State> {
  const messages = await getRecentMessages();
  if (messages.length === 0) return state;

  // Use Claude to classify each message
  for (const msg of messages) {
    const classifyPrompt = `
Classify this message from the owner into one of these types:
- "idea" — they're suggesting a product idea or thing to build
- "feedback" — they're giving feedback on an existing product or the agent's work
- "strategy" — they're giving strategic direction (focus on X, stop doing Y)
- "request" — they're asking for a specific thing to be built or done
- "approval" — they're responding YES or NO to a pending approval

Message: "${msg.text}"

Current projects: ${state.projects.map(p => `${p.id}: ${p.name} (${p.status})`).join(', ') || 'none'}
Pending approvals: ${state.pendingApprovals.map(a => a.description).join(', ') || 'none'}

Respond with ONLY a JSON object: {"type": "<type>", "summary": "<brief summary>", "projectId": "<id or null>"}
`;

    const result = await runClaudeCode(classifyPrompt, {
      allowedTools: [],
      maxBudgetUsd: 0.5,
      timeoutMinutes: 2,
      includeBrainContext: false,
    });

    try {
      const parsed = JSON.parse(result.result);
      const directive: OwnerDirective = {
        type: parsed.type,
        content: msg.text,
        projectId: parsed.projectId !== 'null' ? parsed.projectId : undefined,
        receivedAt: new Date(msg.date * 1000).toISOString(),
        processed: false,
      };

      state.ownerDirectives.push(directive);

      // Handle approvals immediately
      if (parsed.type === 'approval' && state.pendingApprovals.length > 0) {
        const isYes = msg.text.toUpperCase().includes('YES');
        if (isYes) {
          state.pendingApprovals.shift(); // Remove the oldest pending approval
        } else {
          state.pendingApprovals.shift();
        }
      }

      // Handle ideas — add to backlog with high priority
      if (parsed.type === 'idea') {
        state.ideasBacklog.push({
          idea: msg.text,
          priority: 'high',
          source: 'owner',
          addedAt: new Date().toISOString(),
        });
      }

      await sendTelegram(`Got it — ${parsed.summary}. I'll handle this.`);
    } catch {
      // If classification fails, treat as a general directive
      state.ownerDirectives.push({
        type: 'feedback',
        content: msg.text,
        receivedAt: new Date(msg.date * 1000).toISOString(),
        processed: false,
      });
      await sendTelegram(`Received your message. I'll factor it into my next cycle.`);
    }
  }

  saveState(state);
  return state;
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/phases/inbox.ts && git commit -m "feat: add INBOX phase — owner message processing"
```

---

## Task 10: ASSESS Phase

**Files:**
- Create: `autonomous-agent/agent/phases/assess.ts`

- [ ] **Step 1: Create assess.ts**

```ts
// agent/phases/assess.ts

import { State } from '../types.js';
import { getFollowerCount } from '../integrations/twitter.js';
import { getRecentPayments } from '../integrations/stripe.js';
import { getServiceStatus, checkServiceHealth } from '../integrations/railway.js';
import { sendError, sendTelegram } from '../integrations/telegram.js';
import { saveState } from '../state/state.js';

export async function runAssess(state: State): Promise<State> {
  const now = new Date();
  const lastCycleTime = state.recentCycles.length > 0
    ? new Date(state.recentCycles[state.recentCycles.length - 1].timestamp)
    : new Date(now.getTime() - 60 * 60 * 1000); // default 1 hour ago

  // Check Twitter metrics
  try {
    state.twitterFollowers = await getFollowerCount();
  } catch (err) {
    state.errors.push({ message: `Twitter metrics failed: ${err}`, phase: 'assess', timestamp: now.toISOString(), resolved: false });
  }

  // Check Stripe for new payments
  try {
    const payments = await getRecentPayments(lastCycleTime);
    for (const payment of payments) {
      state.revenueTotal += payment.amount;
      // Try to match payment to a project
      const project = state.projects.find(p => p.stripeProductId && payment.product.includes(p.name));
      if (project) project.revenue += payment.amount;
    }
  } catch (err) {
    state.errors.push({ message: `Stripe check failed: ${err}`, phase: 'assess', timestamp: now.toISOString(), resolved: false });
  }

  // Check Railway service health for live projects
  for (const project of state.projects.filter(p => p.status === 'live' && p.railwayServiceId)) {
    try {
      const status = await getServiceStatus(project.railwayServiceId!);
      if (status.url) {
        const healthy = await checkServiceHealth(status.url);
        if (!healthy) {
          const errorMsg = `Project "${project.name}" is down (${status.url})`;
          state.errors.push({ message: errorMsg, phase: 'assess', timestamp: now.toISOString(), resolved: false });
          await sendError('ASSESS', errorMsg);
        }
      }
    } catch (err) {
      state.errors.push({ message: `Railway check failed for ${project.name}: ${err}`, phase: 'assess', timestamp: now.toISOString(), resolved: false });
    }
  }

  // Check for stale pending approvals — remind at 24h, drop at 48h (per spec)
  for (const approval of state.pendingApprovals) {
    const age = now.getTime() - new Date(approval.createdAt).getTime();
    if (age > 48 * 60 * 60 * 1000) {
      // Drop after 48h
      state.pendingApprovals = state.pendingApprovals.filter(a => a !== approval);
    } else if (age > 24 * 60 * 60 * 1000 && !approval.reminderSent) {
      approval.reminderSent = true;
      await sendTelegram(`Reminder: ${approval.description} — still waiting for your reply (YES/NO)`);
    }
  }

  saveState(state);
  return state;
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/phases/assess.ts && git commit -m "feat: add ASSESS phase — state + health checks"
```

---

## Task 11: DECIDE Phase

**Files:**
- Create: `autonomous-agent/agent/phases/decide.ts`

- [ ] **Step 1: Create decide.ts**

```ts
// agent/phases/decide.ts

import { State, Phase } from '../types.js';
import { runClaudeCode } from '../claude.js';

export async function runDecide(state: State): Promise<Phase> {
  // Check for owner requests first (highest priority, no Claude needed)
  const unprocessedRequest = state.ownerDirectives.find(d => d.type === 'request' && !d.processed);
  if (unprocessedRequest) {
    unprocessedRequest.processed = true;
    return 'build';
  }

  // Check for unresolved errors (second highest priority)
  const unresolvedErrors = state.errors.filter(e => !e.resolved);
  if (unresolvedErrors.length > 0) return 'maintain';

  // Check for projects mid-build
  const buildingProject = state.projects.find(p => p.status === 'building');
  if (buildingProject) return 'build';

  const deployingProject = state.projects.find(p => p.status === 'deploying');
  if (deployingProject) return 'ship';

  // Use Claude to decide between the remaining options
  const prompt = `
You are an autonomous AI agent deciding what to do next.

Current state:
- Cycle: ${state.cycleCount}
- Projects: ${JSON.stringify(state.projects.map(p => ({ name: p.name, status: p.status, revenue: p.revenue })))}
- Ideas backlog: ${state.ideasBacklog.length} ideas (${state.ideasBacklog.filter(i => i.priority === 'high').length} high priority)
- Revenue total: $${state.revenueTotal}
- Twitter followers: ${state.twitterFollowers}
- Cycles since last EVOLVE: ${state.cycleCount - state.lastEvolveCycle}
- Cycles since last REFLECT: ${state.cycleCount - state.lastReflectCycle}
- Unprocessed owner feedback: ${state.ownerDirectives.filter(d => !d.processed && d.type === 'feedback').length}
- Unprocessed strategy directives: ${state.ownerDirectives.filter(d => !d.processed && d.type === 'strategy').length}
- Recent activity: ${state.recentCycles.slice(-5).map(c => `${c.phase}: ${c.summary}`).join(' | ')}

Choose ONE phase to execute. Options:
- "ideate" — research and come up with new product ideas (use when no active projects or ideas backlog is empty)
- "build" — build a product from the ideas backlog
- "ship" — deploy and go live with a built product
- "promote" — create content, tweet, engage on Twitter
- "reflect" — analyze performance data, update playbook
- "evolve" — update strategy, improve own prompts/code

Respond with ONLY a JSON object: {"phase": "<phase>", "reason": "<one sentence>"}
`;

  const result = await runClaudeCode(prompt, {
    allowedTools: [],
    maxBudgetUsd: 0.5,
    timeoutMinutes: 2,
  });

  try {
    const parsed = JSON.parse(result.result);
    return parsed.phase as Phase;
  } catch {
    // Default: if no projects, ideate. If projects exist, promote.
    return state.projects.length === 0 ? 'ideate' : 'promote';
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/phases/decide.ts && git commit -m "feat: add DECIDE phase — action selection logic"
```

---

## Task 12: IDEATE Phase

**Files:**
- Create: `autonomous-agent/agent/phases/ideate.ts`

- [ ] **Step 1: Create ideate.ts**

```ts
// agent/phases/ideate.ts

import { State, Project } from '../types.js';
import { runClaudeCode } from '../claude.js';
import { saveState } from '../state/state.js';
import { readFileSync } from 'fs';
import { join } from 'path';

export async function runIdeate(state: State): Promise<{ state: State; summary: string }> {
  // Check if owner gave us a specific idea
  const ownerIdea = state.ideasBacklog.find(i => i.source === 'owner' && i.priority === 'high');

  const prompt = ownerIdea
    ? `
The owner suggested this idea: "${ownerIdea.idea}"

Research this idea. Figure out:
1. What exactly should we build? Be specific — landing page, tool, template, API, etc.
2. Who is the target customer?
3. How do we monetize it? (Stripe checkout, payment link, subscription)
4. What's the simplest MVP we can build in under 1 hour of coding?
5. What price point makes sense?

Also search the web to validate there's demand and check what competitors exist.

Respond with a JSON object:
{
  "name": "<product name>",
  "spec": "<detailed spec for what to build — be very specific about pages, features, tech>",
  "targetCustomer": "<who buys this>",
  "priceInCents": <price in cents>,
  "estimatedBuildCycles": <1-5>,
  "reasoning": "<why this will work>"
}
`
    : `
Research and come up with a product idea that can make money.

Your capabilities: you can build web apps, landing pages, tools, templates, APIs, digital products.
Your stack: Next.js or plain HTML/CSS/JS, Stripe for payments, Railway for hosting.
Your target: developers, indie hackers, small businesses, AI enthusiasts.

Steps:
1. Search the web for trending problems, pain points, and gaps in the market
2. Look at what's selling on Product Hunt, Gumroad, indie hacker communities
3. Think about what YOU can uniquely offer (you're an AI that builds fast)
4. Pick the idea with the best ratio of: easy to build × likely to sell × underserved market

Previously tried ideas (avoid repeats): ${state.projects.map(p => p.name).join(', ') || 'none'}

Respond with a JSON object:
{
  "name": "<product name>",
  "spec": "<detailed spec for what to build — be very specific about pages, features, tech>",
  "targetCustomer": "<who buys this>",
  "priceInCents": <price in cents>,
  "estimatedBuildCycles": <1-5>,
  "reasoning": "<why this will work>"
}
`;

  const result = await runClaudeCode(prompt, {
    allowedTools: ['WebSearch', 'WebFetch'],
    maxBudgetUsd: 2,
    timeoutMinutes: 30,
  });

  try {
    // Extract JSON from Claude's response (it might have text around it)
    const jsonMatch = result.result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const idea = JSON.parse(jsonMatch[0]);

    const project: Project = {
      id: `proj_${Date.now()}`,
      name: idea.name,
      spec: idea.spec,
      status: 'idea',
      buildProgress: '',
      revenue: 0,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };

    state.projects.push(project);
    state.currentProjectId = project.id;

    // Remove the owner idea from backlog if that's what we used
    if (ownerIdea) {
      state.ideasBacklog = state.ideasBacklog.filter(i => i !== ownerIdea);
    }

    saveState(state);
    return {
      state,
      summary: `Ideated: "${idea.name}" — ${idea.reasoning}. Price: $${idea.priceInCents / 100}`,
    };
  } catch (err) {
    return {
      state,
      summary: `Ideation produced no actionable result: ${result.result.slice(0, 200)}`,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/phases/ideate.ts && git commit -m "feat: add IDEATE phase — market research + idea generation"
```

---

## Task 13: BUILD Phase

**Files:**
- Create: `autonomous-agent/agent/phases/build.ts`

- [ ] **Step 1: Create build.ts**

This is the most important phase. Claude Code gets full autonomy to write code, test it, and iterate.

```ts
// agent/phases/build.ts

import { State } from '../types.js';
import { runClaudeCode } from '../claude.js';
import { saveState } from '../state/state.js';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

export async function runBuild(state: State): Promise<{ state: State; summary: string }> {
  // Find the project to build
  const project = state.projects.find(p => p.id === state.currentProjectId)
    ?? state.projects.find(p => p.status === 'idea' || p.status === 'building');

  if (!project) {
    return { state, summary: 'No project to build. Need to IDEATE first.' };
  }

  const projectDir = join(process.cwd(), 'products', project.id);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  project.status = 'building';
  state.currentProjectId = project.id;

  // Check for owner feedback on this project
  const feedback = state.ownerDirectives
    .filter(d => !d.processed && d.type === 'feedback' && d.projectId === project.id)
    .map(d => { d.processed = true; return d.content; });

  const feedbackSection = feedback.length > 0
    ? `\n\nOwner feedback to incorporate:\n${feedback.map(f => `- ${f}`).join('\n')}`
    : '';

  const prompt = `
You are building a product. Work in this directory: ${projectDir}

Product: ${project.name}
Spec: ${project.spec}
${project.buildProgress ? `Progress so far: ${project.buildProgress}` : 'This is a fresh build.'}
${feedbackSection}

Your job:
1. Build the complete product — landing page, core functionality, everything in the spec
2. Integrate Stripe for payments:
   - Use Stripe Checkout with the payment link approach
   - The Stripe live key is in env var STRIPE_LIVE_KEY, test key in STRIPE_TEST_KEY
   - For now, use the test key. We'll switch to live in the SHIP phase.
3. Make sure the product is deployable on Railway (include a Dockerfile or package.json start script)
4. Add a simple health check endpoint (GET /health returns 200)
5. Test your work — run the dev server, check pages load, verify the payment flow makes sense

When you're done or if you get stuck:
- Commit all your work with git
- Describe exactly where you are in your response

Respond with a JSON object at the end:
{
  "completed": true/false,
  "progress": "<where you are>",
  "nextSteps": "<what's left to do if not completed>",
  "stripeProductId": "<if created>",
  "stripePaymentLink": "<if created>"
}
`;

  const result = await runClaudeCode(prompt, {
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    maxBudgetUsd: 5,
    timeoutMinutes: 60,
  });

  // Parse result
  try {
    const jsonMatch = result.result.match(/\{[\s\S]*"completed"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      project.buildProgress = parsed.progress;
      project.lastUpdatedAt = new Date().toISOString();

      if (parsed.stripeProductId) project.stripeProductId = parsed.stripeProductId;
      if (parsed.stripePaymentLink) project.stripePaymentLink = parsed.stripePaymentLink;

      if (parsed.completed) {
        project.status = 'deploying';
      }
    }
  } catch {
    project.buildProgress = result.result.slice(0, 500);
  }

  saveState(state);
  return {
    state,
    summary: `Build [${project.name}]: ${project.status === 'deploying' ? 'Complete, ready to ship' : project.buildProgress?.slice(0, 100)}`,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/phases/build.ts && git commit -m "feat: add BUILD phase — autonomous product building"
```

---

## Task 14: SHIP Phase

**Files:**
- Create: `autonomous-agent/agent/phases/ship.ts`

- [ ] **Step 1: Create ship.ts**

```ts
// agent/phases/ship.ts

import { State } from '../types.js';
import { runClaudeCode } from '../claude.js';
import { checkServiceHealth } from '../integrations/railway.js';
import { sendError } from '../integrations/telegram.js';
import { saveState } from '../state/state.js';
import { join } from 'path';

export async function runShip(state: State): Promise<{ state: State; summary: string }> {
  const project = state.projects.find(p => p.status === 'deploying');
  if (!project) {
    return { state, summary: 'No project ready to ship.' };
  }

  const projectDir = join(process.cwd(), 'products', project.id);

  const prompt = `
You are deploying a product to Railway.

Product: ${project.name}
Project directory: ${projectDir}
Railway API token is in env var RAILWAY_API_TOKEN.

Steps:
1. Make sure all code is committed and pushed to GitHub
2. Use the Railway CLI or API to deploy this project:
   - Create a new Railway service if needed
   - Link it to the GitHub repo + products/${project.id} directory
   - Set up the necessary environment variables on Railway
3. Wait for the deploy to complete
4. Verify the live URL responds (hit /health endpoint)
5. If using Stripe test keys, create new payment links with the live key (STRIPE_LIVE_KEY env var)

Respond with a JSON object:
{
  "success": true/false,
  "liveUrl": "<the live URL>",
  "railwayServiceId": "<service ID>",
  "stripePaymentLink": "<live payment link if updated>",
  "error": "<error message if failed>"
}
`;

  const result = await runClaudeCode(prompt, {
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'WebFetch'],
    maxBudgetUsd: 3,
    timeoutMinutes: 30,
  });

  try {
    const jsonMatch = result.result.match(/\{[\s\S]*"success"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.success) {
        project.status = 'live';
        project.liveUrl = parsed.liveUrl;
        project.railwayServiceId = parsed.railwayServiceId;
        if (parsed.stripePaymentLink) project.stripePaymentLink = parsed.stripePaymentLink;
        project.lastUpdatedAt = new Date().toISOString();
      } else {
        project.status = 'building'; // Roll back to building so MAINTAIN or BUILD can fix
        state.errors.push({
          message: `Ship failed for ${project.name}: ${parsed.error}`,
          phase: 'ship',
          timestamp: new Date().toISOString(),
          resolved: false,
        });
        await sendError('SHIP', `Deploy failed for ${project.name}: ${parsed.error}`);
      }
    }
  } catch {
    project.status = 'building';
    state.errors.push({
      message: `Ship phase parse error for ${project.name}`,
      phase: 'ship',
      timestamp: new Date().toISOString(),
      resolved: false,
    });
  }

  saveState(state);
  return {
    state,
    summary: project.status === 'live'
      ? `Shipped "${project.name}" — live at ${project.liveUrl}`
      : `Ship failed for "${project.name}", rolling back to BUILD`,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/phases/ship.ts && git commit -m "feat: add SHIP phase — deploy and go live"
```

---

## Task 15: PROMOTE Phase

**Files:**
- Create: `autonomous-agent/agent/phases/promote.ts`

- [ ] **Step 1: Create promote.ts**

```ts
// agent/phases/promote.ts

import { State } from '../types.js';
import { runClaudeCode } from '../claude.js';
import { tweet, searchRecentTweets, replyToTweet, getFollowerCount } from '../integrations/twitter.js';
import { saveState } from '../state/state.js';

export async function runPromote(state: State): Promise<{ state: State; summary: string }> {
  const liveProjects = state.projects.filter(p => p.status === 'live');

  const prompt = `
You are managing a Twitter/X account for an autonomous AI builder.

Current followers: ${state.twitterFollowers}
Live products: ${JSON.stringify(liveProjects.map(p => ({ name: p.name, url: p.liveUrl, revenue: p.revenue, paymentLink: p.stripePaymentLink })))}
Total revenue: $${state.revenueTotal}
Cycle count: ${state.cycleCount}

Recent tweets/activity from PLAYBOOK.md are in your brain context.

Your job for this cycle — pick the highest-value action:

1. If you have a new product to announce, write a launch tweet (with link)
2. If no new product, share a build-in-public update (what you're working on, revenue milestones, lessons)
3. Search Twitter for relevant conversations about indie hacking, AI tools, or topics related to your products — find 2-3 tweets to reply to with genuine, useful takes
4. If followers < 50, focus more on engagement (replies, follows) than original content

Rules:
- Be authentic. If you're an AI, you can lean into that — it's interesting
- No generic motivational content
- No spam
- Keep tweets under 280 characters
- Be useful and specific, not vague

Respond with a JSON object:
{
  "tweets": ["<tweet text>", ...],
  "replies": [{"tweetId": "<id>", "text": "<reply text>"}, ...],
  "summary": "<what you did and why>"
}
`;

  const result = await runClaudeCode(prompt, {
    allowedTools: ['WebSearch'],
    maxBudgetUsd: 2,
    timeoutMinutes: 15,
  });

  let tweetsSent = 0;
  let repliesSent = 0;

  try {
    const jsonMatch = result.result.match(/\{[\s\S]*"tweets"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      // Post tweets
      for (const text of parsed.tweets ?? []) {
        try {
          await tweet(text);
          tweetsSent++;
        } catch (err) {
          state.errors.push({
            message: `Tweet failed: ${err}`,
            phase: 'promote',
            timestamp: new Date().toISOString(),
            resolved: false,
          });
        }
      }

      // Post replies
      for (const reply of parsed.replies ?? []) {
        try {
          await replyToTweet(reply.tweetId, reply.text);
          repliesSent++;
        } catch (err) {
          // Reply failures are non-critical, just log
        }
      }
    }
  } catch {
    // Parse failed — non-critical
  }

  saveState(state);
  return {
    state,
    summary: `Promoted: ${tweetsSent} tweets, ${repliesSent} replies. Followers: ${state.twitterFollowers}`,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/phases/promote.ts && git commit -m "feat: add PROMOTE phase — Twitter content and engagement"
```

---

## Task 16: MAINTAIN Phase

**Files:**
- Create: `autonomous-agent/agent/phases/maintain.ts`

- [ ] **Step 1: Create maintain.ts**

```ts
// agent/phases/maintain.ts

import { State } from '../types.js';
import { runClaudeCode } from '../claude.js';
import { sendTelegram } from '../integrations/telegram.js';
import { saveState } from '../state/state.js';
import { join } from 'path';

export async function runMaintain(state: State): Promise<{ state: State; summary: string }> {
  const unresolvedErrors = state.errors.filter(e => !e.resolved);
  if (unresolvedErrors.length === 0) {
    return { state, summary: 'No errors to fix.' };
  }

  const errorsDesc = unresolvedErrors.map(e => `[${e.phase}] ${e.message}`).join('\n');

  const prompt = `
You are debugging and fixing errors in deployed products.

Errors to fix:
${errorsDesc}

Projects:
${state.projects.map(p => `- ${p.name} (${p.status}) — dir: products/${p.id}`).join('\n')}

Your job:
1. Diagnose each error
2. Fix the code
3. Test the fix
4. Commit and push (to trigger redeploy if needed)
5. If an error requires owner intervention (e.g., account issue, billing), say so

Respond with a JSON object:
{
  "fixed": ["<error description>", ...],
  "needsOwner": ["<description of what needs human help>", ...],
  "summary": "<what you did>"
}
`;

  const result = await runClaudeCode(prompt, {
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch'],
    maxBudgetUsd: 3,
    timeoutMinutes: 30,
  });

  try {
    const jsonMatch = result.result.match(/\{[\s\S]*"fixed"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      // Mark fixed errors as resolved
      for (const fixedDesc of parsed.fixed ?? []) {
        const err = unresolvedErrors.find(e => e.message.includes(fixedDesc) || fixedDesc.includes(e.message.slice(0, 50)));
        if (err) err.resolved = true;
      }

      // Escalate to owner if needed
      for (const ownerIssue of parsed.needsOwner ?? []) {
        await sendTelegram(`I need your help: ${ownerIssue}`);
      }
    }
  } catch {
    // Best effort
  }

  saveState(state);
  return {
    state,
    summary: `Maintain: ${unresolvedErrors.filter(e => e.resolved).length}/${unresolvedErrors.length} errors fixed`,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/phases/maintain.ts && git commit -m "feat: add MAINTAIN phase — error diagnosis and fixing"
```

---

## Task 17: REFLECT Phase

**Files:**
- Create: `autonomous-agent/agent/phases/reflect.ts`

- [ ] **Step 1: Create reflect.ts**

```ts
// agent/phases/reflect.ts

import { State } from '../types.js';
import { runClaudeCode } from '../claude.js';
import { sendApprovalRequest } from '../integrations/telegram.js';
import { saveState } from '../state/state.js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export async function runReflect(state: State): Promise<{ state: State; summary: string }> {
  const playbookPath = join(process.cwd(), 'brain', 'PLAYBOOK.md');
  const playbook = readFileSync(playbookPath, 'utf-8');

  const prompt = `
You are analyzing the performance of your autonomous business.

Current state:
- Total revenue: $${state.revenueTotal}
- Cycle count: ${state.cycleCount}
- Twitter followers: ${state.twitterFollowers}
- Projects: ${JSON.stringify(state.projects.map(p => ({
    name: p.name, status: p.status, revenue: p.revenue,
    age: Math.round((Date.now() - new Date(p.createdAt).getTime()) / (1000 * 60 * 60)) + ' hours',
  })))}
- Recent cycles: ${state.recentCycles.slice(-20).map(c => `[${c.phase}] ${c.summary}`).join('\n')}
- Errors (last 10): ${state.errors.slice(-10).map(e => `[${e.phase}] ${e.message} (resolved: ${e.resolved})`).join('\n')}

Current playbook:
${playbook}

Analyze:
1. What's working? What's not?
2. Which products should I double down on? Kill?
3. Is my Twitter strategy working? What should I change?
4. Am I spending time on the right things?
5. Any patterns I should codify?

Respond with:
1. Updated PLAYBOOK.md content (full file, markdown format)
2. A JSON object with recommendations:
{
  "recommendations": ["<specific actionable recommendation>", ...],
  "killProjects": ["<project id to kill>", ...],
  "summary": "<key insight>"
}
`;

  const result = await runClaudeCode(prompt, {
    allowedTools: ['WebSearch'],
    maxBudgetUsd: 2,
    timeoutMinutes: 15,
  });

  // Try to extract and save updated playbook
  const playbookMatch = result.result.match(/```markdown\n([\s\S]*?)```/);
  if (playbookMatch) {
    writeFileSync(playbookPath, playbookMatch[1]);
  }

  // Handle kill recommendations — requires owner approval per BRAIN.md constraints
  try {
    const jsonMatch = result.result.match(/\{[\s\S]*"recommendations"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      for (const projectId of parsed.killProjects ?? []) {
        const project = state.projects.find(p => p.id === projectId);
        if (project && project.status === 'live') {
          // Request owner approval, don't kill directly
          state.pendingApprovals.push({
            type: 'delete_product',
            description: `Kill project "${project.name}" (revenue: $${project.revenue})`,
            createdAt: new Date().toISOString(),
            reminderSent: false,
          });
          await sendApprovalRequest(`Kill project "${project.name}"? Revenue: $${project.revenue}`);
        } else if (project && project.status !== 'live') {
          // Non-live projects can be killed without approval
          project.status = 'dead';
        }
      }
    }
  } catch {
    // Best effort
  }

  state.lastReflectCycle = state.cycleCount;
  saveState(state);

  return {
    state,
    summary: `Reflected on performance. Revenue: $${state.revenueTotal}, ${state.twitterFollowers} followers.`,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/phases/reflect.ts && git commit -m "feat: add REFLECT phase — performance analysis"
```

---

## Task 18: EVOLVE Phase

**Files:**
- Create: `autonomous-agent/agent/phases/evolve.ts`

- [ ] **Step 1: Create evolve.ts**

```ts
// agent/phases/evolve.ts

import { State } from '../types.js';
import { runClaudeCode } from '../claude.js';
import { sendTelegram } from '../integrations/telegram.js';
import { saveState } from '../state/state.js';
import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

export async function runEvolve(state: State): Promise<{ state: State; summary: string }> {
  const rootDir = process.cwd();
  const strategyPath = join(rootDir, 'brain', 'STRATEGY.md');
  const changelogPath = join(rootDir, 'brain', 'CHANGELOG.md');
  const strategy = readFileSync(strategyPath, 'utf-8');
  const playbookPath = join(rootDir, 'brain', 'PLAYBOOK.md');
  const playbook = readFileSync(playbookPath, 'utf-8');

  // Check for owner strategy directives
  const strategyDirectives = state.ownerDirectives
    .filter(d => !d.processed && d.type === 'strategy')
    .map(d => { d.processed = true; return d.content; });

  const prompt = `
You are evolving your own strategy and systems.

Current strategy:
${strategy}

Current playbook:
${playbook}

Performance:
- Revenue: $${state.revenueTotal}
- Followers: ${state.twitterFollowers}
- Cycles run: ${state.cycleCount}
- Projects: ${state.projects.map(p => `${p.name} (${p.status}, $${p.revenue})`).join(', ')}
- Recent phases: ${state.recentCycles.slice(-10).map(c => c.phase).join(', ')}

${strategyDirectives.length > 0 ? `Owner strategy directives to incorporate:\n${strategyDirectives.map(d => `- ${d}`).join('\n')}` : ''}

Your job:
1. Analyze what's working and what's not
2. Update STRATEGY.md with a new/refined strategy
3. Consider if any of your phase prompts or workflows need improvement
4. Consider if you should templatize any successful patterns

Respond with:
1. The full updated STRATEGY.md content in a markdown code block
2. A JSON object:
{
  "changes": ["<what you changed and why>", ...],
  "summary": "<one-line summary of evolution>"
}
`;

  const result = await runClaudeCode(prompt, {
    allowedTools: ['Read', 'WebSearch'],
    maxBudgetUsd: 2,
    timeoutMinutes: 20,
  });

  // Extract and save updated strategy
  const strategyMatch = result.result.match(/```markdown\n([\s\S]*?)```/);
  if (strategyMatch) {
    writeFileSync(strategyPath, strategyMatch[1]);
  }

  // Log changes
  try {
    const jsonMatch = result.result.match(/\{[\s\S]*"changes"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const date = new Date().toISOString().split('T')[0];
      for (const change of parsed.changes ?? []) {
        appendFileSync(changelogPath, `| ${state.cycleCount} | ${date} | ${change} | Self-evolution |\n`);
      }
      await sendTelegram(`EVOLVE: ${parsed.summary}\n\nChanges:\n${(parsed.changes ?? []).map((c: string) => `- ${c}`).join('\n')}`);
    }
  } catch {
    // Best effort
  }

  // Brain file changes are committed on main — the orchestrator's commitState()
  // handles git add/commit/push at the end of each cycle. EVOLVE only modifies
  // brain/ files (STRATEGY.md, PLAYBOOK.md, CHANGELOG.md), not orchestrator code.
  // If EVOLVE wants to modify orchestrator code in the future, it should be done
  // through a separate PR-based flow (not implemented in v1).

  state.lastEvolveCycle = state.cycleCount;
  saveState(state);

  return {
    state,
    summary: `Evolved strategy at cycle ${state.cycleCount}.`,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/phases/evolve.ts && git commit -m "feat: add EVOLVE phase — self-improvement"
```

---

## Task 19: Orchestrator — Main Loop

**Files:**
- Create: `autonomous-agent/agent/orchestrator.ts`

- [ ] **Step 1: Create orchestrator.ts**

This is the heart of the system. Simple loop: inbox → assess → decide → execute → report → sleep.

```ts
// agent/orchestrator.ts

import { loadState, saveState, commitState } from './state/state.js';
import { sendCycleUpdate, sendError } from './integrations/telegram.js';
import { runInbox } from './phases/inbox.js';
import { runAssess } from './phases/assess.js';
import { runDecide } from './phases/decide.js';
import { runIdeate } from './phases/ideate.js';
import { runBuild } from './phases/build.js';
import { runShip } from './phases/ship.js';
import { runPromote } from './phases/promote.js';
import { runMaintain } from './phases/maintain.js';
import { runReflect } from './phases/reflect.js';
import { runEvolve } from './phases/evolve.js';
import { Phase } from './types.js';

const COOLDOWN_MS = (parseInt(process.env.COOLDOWN_MINUTES ?? '30') || 30) * 60 * 1000;

async function executePhase(phase: Phase, state: ReturnType<typeof loadState>): Promise<{ state: typeof state; summary: string }> {
  switch (phase) {
    case 'ideate': return runIdeate(state);
    case 'build': return runBuild(state);
    case 'ship': return runShip(state);
    case 'promote': return runPromote(state);
    case 'maintain': return runMaintain(state);
    case 'reflect': return runReflect(state);
    case 'evolve': return runEvolve(state);
    default: return { state, summary: `Unknown phase: ${phase}` };
  }
}

async function runCycle(): Promise<void> {
  let state = loadState();
  state.cycleCount++;
  console.log(`\n=== Cycle ${state.cycleCount} starting ===`);

  // 1. INBOX — check owner messages
  try {
    state = await runInbox(state);
  } catch (err) {
    console.error('INBOX error:', err);
    // Non-fatal, continue
  }

  // 2. ASSESS — gather context
  try {
    state = await runAssess(state);
  } catch (err) {
    console.error('ASSESS error:', err);
    await sendError('ASSESS', String(err));
  }

  // 3. DECIDE — pick action
  let phase: Phase;
  try {
    phase = await runDecide(state);
  } catch (err) {
    console.error('DECIDE error:', err);
    phase = state.projects.length === 0 ? 'ideate' : 'promote';
  }

  state.currentPhase = phase;
  console.log(`Phase selected: ${phase}`);

  // 4. EXECUTE — run the chosen phase
  let summary: string;
  try {
    const result = await executePhase(phase, state);
    state = result.state;
    summary = result.summary;
  } catch (err) {
    summary = `Phase ${phase} crashed: ${err}`;
    state.errors.push({
      message: String(err),
      phase,
      timestamp: new Date().toISOString(),
      resolved: false,
    });
    await sendError(phase, String(err));
  }

  // 5. REPORT — log and notify
  state.recentCycles.push({
    cycle: state.cycleCount,
    phase,
    summary,
    timestamp: new Date().toISOString(),
  });

  // Keep only last 50 cycle logs
  if (state.recentCycles.length > 50) {
    state.recentCycles = state.recentCycles.slice(-50);
  }

  saveState(state);

  // Commit state to git for backup
  try {
    commitState(`cycle ${state.cycleCount} [${phase}]`);
  } catch {
    // Git commit failure is non-fatal
  }

  // Send Telegram update
  try {
    await sendCycleUpdate(state.cycleCount, phase, summary);
  } catch (err) {
    console.error('Telegram notification failed:', err);
  }

  console.log(`=== Cycle ${state.cycleCount} complete: [${phase}] ${summary} ===`);
}

async function main(): Promise<void> {
  console.log('Autonomous agent starting...');
  console.log(`Cooldown: ${COOLDOWN_MS / 1000 / 60} minutes`);

  // Send startup notification
  try {
    const { sendTelegram } = await import('./integrations/telegram.js');
    await sendTelegram('Agent is online and starting the first cycle.');
  } catch {
    console.log('Could not send startup Telegram notification');
  }

  while (true) {
    try {
      await runCycle();
    } catch (err) {
      console.error('Critical cycle error:', err);
      try {
        await sendError('CRITICAL', `Cycle crashed entirely: ${err}`);
      } catch {
        // If even Telegram fails, just log
      }
    }

    console.log(`Sleeping ${COOLDOWN_MS / 1000 / 60} minutes...`);
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS));
  }
}

main();
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/solal/Documents/GitHub/autonomous-agent && npx tsc --noEmit
```

Fix any type errors that come up.

- [ ] **Step 3: Commit**

```bash
git add agent/orchestrator.ts && git commit -m "feat: add orchestrator — main cycle loop"
```

---

## Task 20: Dockerfile & Railway Config

**Files:**
- Create: `autonomous-agent/Dockerfile`
- Create: `autonomous-agent/railway.toml`

- [ ] **Step 1: Create Dockerfile**

Claude Code CLI needs to be installed in the container along with Node.js.

```dockerfile
FROM node:22-slim

# Install dependencies for Claude Code CLI
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy package files and install (include devDeps for tsc build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Prune dev dependencies after build
RUN npm prune --production

# Configure git for the agent
RUN git config --global user.email "agent@autonomous.bot" && \
    git config --global user.name "Autonomous Agent"

CMD ["node", "dist/agent/orchestrator.js"]
```

- [ ] **Step 2: Create railway.toml**

The orchestrator is a long-running process, not an HTTP server, so we disable the healthcheck path and rely on Railway's process monitoring instead.

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

Note: The healthcheck path here is for the orchestrator process — Railway will check if the container is running. The agent's products will have their own health checks.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile railway.toml && git commit -m "feat: add Dockerfile and Railway config"
```

---

## Task 21: End-to-End Local Smoke Test

- [ ] **Step 1: Create .env from .env.example**

```bash
cp .env.example .env
# Fill in at minimum: TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID
# Others can be filled in as accounts are set up
```

- [ ] **Step 2: Run the orchestrator locally**

```bash
cd /Users/solal/Documents/GitHub/autonomous-agent && npx tsx agent/orchestrator.ts
```

Verify:
- It starts and prints "Autonomous agent starting..."
- It sends a Telegram startup message
- First cycle runs (INBOX → ASSESS → DECIDE → IDEATE since no projects exist)
- Telegram update received after cycle
- It sleeps and waits for next cycle

- [ ] **Step 3: Kill after first successful cycle and verify STATE.json was created**

```bash
cat agent/state/STATE.json
```

Should show cycleCount: 1, and potentially a project in the ideas/building state.

- [ ] **Step 4: Commit any fixes from smoke test**

```bash
git add -A && git commit -m "fix: smoke test fixes"
```

---

## Task 22: Deploy to Railway

- [ ] **Step 1: Create GitHub repo**

```bash
cd /Users/solal/Documents/GitHub/autonomous-agent
gh repo create autonomous-agent --private --source=. --remote=origin --push
```

- [ ] **Step 2: Deploy to Railway**

Connect the GitHub repo to Railway via the Railway dashboard or CLI. Set all environment variables from `.env` on the Railway service.

- [ ] **Step 3: Verify deployment**

Check Railway logs to confirm the orchestrator started and the first cycle is running. Check Telegram for the startup message.

- [ ] **Step 4: Monitor first few cycles**

Watch Telegram for the first 3-5 cycle updates. The agent should:
1. Cycle 1: IDEATE (come up with first product idea)
2. Cycle 2: BUILD (start building it)
3. Cycle 3+: Continue BUILD or SHIP
4. After shipping: PROMOTE

---

## Dependency Order

Tasks 1-8 can be done sequentially (they're foundational).

Tasks 9-18 (phases) are independent of each other — they can be done in parallel since they all depend only on types, state, claude, and integrations (Tasks 2-7).

Task 19 (orchestrator) depends on all phases being done.

Task 20 (Dockerfile) depends on Task 19.

Tasks 21-22 (testing & deploy) are sequential and last.

```
Task 1 (scaffold)
  → Task 2 (types + state)
    → Tasks 3-8 in parallel (claude, telegram, twitter, stripe, railway, brain files)
      → Tasks 9-18 in parallel (all phases)
        → Task 19 (orchestrator)
          → Task 20 (Dockerfile)
            → Task 21 (smoke test)
              → Task 22 (deploy)
```
