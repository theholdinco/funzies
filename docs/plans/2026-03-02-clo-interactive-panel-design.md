# CLO Interactive Panel — Character Profiles & Chat

## Problem

The CLO panel lacks the interactive character features available in the IC/Assembly flow. Users can't navigate to individual member profiles or chat directly with panel members outside of analysis follow-ups.

## Design

### 1. Member Profile Pages

**Route:** `/clo/panel/[num]`

Server component that renders a full profile page for each panel member.

**Layout:**
- Breadcrumb: Home / CLO / Panel / [Member Name]
- Profile header: Avatar + Name + Role + Risk personality badge
- Sections (CLO-native fields, rendered if present):
  - Background (markdown)
  - Investment Philosophy (markdown)
  - Specializations (tag list)
  - Decision Style (markdown)
  - Notable Positions (ordered list)
  - Blind Spots (list)
  - Full Profile (markdown)
- Analysis History: Collapsible list of analyses the member participated in, showing individual assessment excerpts and debate contributions from `clo_analyses.parsed_data`
- Prev/Next member navigation
- FollowUpModal chat widget at bottom

### 2. CLO FollowUpModal

**Component:** `web/components/clo/FollowUpModal.tsx`

Chat widget for member profile pages with:
- Optional analysis context picker (select dropdown: "No specific analysis" + completed analyses)
- Streaming responses with speaker block rendering and avatars
- Mode locked to `ask-member` on profile pages, full mode selector on panel overview
- Hits `/api/clo/panels/[panelId]/follow-ups`

**Props:**
```typescript
interface CloFollowUpModalProps {
  panelId: string;
  members: PanelMember[];
  defaultMember?: string;
  pageType: "member" | "panel";
  analyses?: { id: string; title: string; borrowerName: string }[];
}
```

### 3. Panel-Level Follow-Up API

**Route:** `/api/clo/panels/[id]/follow-ups/route.ts`

**Request:**
```typescript
{
  question: string;
  mode: "ask-member" | "ask-panel" | "debate";
  targetMember?: string;
  analysisId?: string;
  history: { role: string; content: string }[];
}
```

**Context always included:** Member profiles, fund profile (strategy, risk appetite, constraints, beliefs), market briefing, PPM documents.

**When `analysisId` provided:** Also includes memo, risk assessment, debate, recommendation from that analysis.

**Storage:** `clo_follow_ups` table with `panel_id` set, `analysis_id` nullable.

### 4. Schema Changes

```sql
ALTER TABLE clo_follow_ups ALTER COLUMN analysis_id DROP NOT NULL;
ALTER TABLE clo_follow_ups ADD COLUMN IF NOT EXISTS panel_id UUID REFERENCES clo_panels(id) ON DELETE CASCADE;
```

### 5. PanelMemberCard Update

- Member name/avatar click navigates to `/clo/panel/[num]`
- "View profile →" link in expanded state
- Card body click still expands/collapses

## Files to Create/Modify

**New files:**
- `web/app/clo/panel/[num]/page.tsx` — Member profile page
- `web/components/clo/FollowUpModal.tsx` — Chat widget for profile pages
- `web/app/api/clo/panels/[id]/follow-ups/route.ts` — Panel-level follow-up API

**Modified files:**
- `web/lib/schema.sql` — Schema migration for nullable analysis_id + panel_id
- `web/components/clo/PanelMemberCard.tsx` — Add profile page link
- `web/components/clo/PanelView.tsx` — Pass panel data needed for linking
