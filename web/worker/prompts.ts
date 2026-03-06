export function domainAnalysisPrompt(topic: string, codeContext?: string): string {
  const codeSection = codeContext
    ? `\n\n## Codebase Reference\n\nA codebase has been provided for reference. Use it to ground your analysis in the actual implementation, architecture patterns, and technical decisions present in the code. Reference specific files and patterns when relevant.\n\n${codeContext}`
    : "";

  return `You are an expert domain analyst preparing the groundwork for a multi-perspective intellectual assembly on a given topic.

Analyze the following topic and produce a structured domain analysis in markdown. If source documents or files are attached, analyze them thoroughly and incorporate their content into your domain analysis.${codeSection}

## Your task

1. **Domain Mapping**: Identify the core domain(s) this topic touches (e.g., economics, ethics, technology, governance, culture). List 3-5 relevant domains.

2. **Fundamental Tensions**: Map 3-5 tensions as a table of PREMISE-level disagreements. These are not just trade-offs but fundamental differences in starting assumptions.

   Format as a table:

   | Tension | Pole A | Pole B |
   |---------|--------|--------|
   | [short name] | [position/premise] | [opposing position/premise] |

   For each tension, add one sentence below the table explaining why this is a premise-level disagreement (not just a preference difference).

3. **Key Stakeholders**: Identify 5-8 distinct stakeholder perspectives that would have meaningfully different views on this topic. Think across disciplines, ideologies, and lived experiences.

4. **Register & Tone**: Classify the topic's natural register:
   - **Academic** — theoretical, philosophical, policy-oriented (e.g., "ethics of AI surveillance")
   - **Professional** — business strategy, career, technical architecture (e.g., "microservices vs monolith")
   - **Practical** — how-to, everyday advice, skill-building (e.g., "how to negotiate a raise")
   - **Casual/Social** — dating, lifestyle, social dynamics, humor (e.g., "how to flirt at a bar")
   - **Creative** — art, writing, music, design aesthetics (e.g., "how to develop a personal style")

   Pick ONE. This determines the character types, debate tone, and deliverable style for the entire assembly. If in doubt, lean toward the less academic option.

5. **Output Type Determination**: Based on the topic, recommend the most appropriate deliverable format. State your choice as: "Recommended output type: **[Type]**"

   Options:
   - **Code** — for specific coding/implementation tasks
   - **Architecture/Design** — for system design, technical architecture (NOT actual code — design decisions and implementation roadmap)
   - **Essay/Writing** — for exploratory, philosophical, or narrative topics
   - **Decision Brief** — for binary or multi-option decisions that need a clear recommendation
   - **Analysis** — for deep examination of a phenomenon, trend, or system
   - **Plan** — for actionable "how to" or strategy topics

6. **Scope Boundaries**: Define what is in scope and out of scope for a productive discussion. Identify 2-3 aspects that might seem related but should be excluded to maintain focus.

7. **Complexity Assessment**: Analyze the complexity of this topic and recommend assembly parameters.

   Consider:
   - How many tensions did you identify? (1-2 = simpler, 3-4 = moderate, 5+ = complex)
   - What are the decision stakes? (low = preference/style, medium = significant consequences, high = irreversible/high-impact)
   - Stakes override: even with few tensions, high stakes → Standard or Deep mode

   Output exactly:

   ## Complexity Assessment
   - Tension count: [N]
   - Stakes: [low/medium/high]
   - Recommended mode: [Light/Standard/Deep]
   - Recommended character count: [N]
   - Recommended debate structure: [Duels/Grande Table/Tribunal/Socratique]
   - Reasoning: [1-2 sentences explaining your choices]

   Mode rules:
   - **Light** (1-2 tensions, low stakes): 3-4 characters + Socrate. Fast, focused.
   - **Standard** (3-4 tensions, or medium stakes): 5-7 characters + Socrate. Full assembly.
   - **Deep** (5+ tensions, or high stakes): 7-10 characters + Socrate. Comprehensive.

   Debate structure rules:
   - **Duels**: Best for binary decisions — paired opponents go 1v1 on specific tensions
   - **Grande Table**: Best for multi-factor analysis — open discussion with rotating focus
   - **Tribunal**: Best for stress-testing a specific proposal — prosecutors attack, jury evaluates
   - **Socratique**: Best for values/philosophical questions — Socrate leads through questions only

Format your output as clean markdown with ## headings for each section.

Topic: ${topic}`;
}

export function characterGenerationPrompt(
  topic: string,
  domainAnalysis: string,
  characterCount: number,
  codeContext?: string
): string {
  const codeSection = codeContext
    ? `\n\n## Codebase Reference\n\nA codebase has been linked to this assembly. Characters should be aware of and reference the actual codebase when forming their positions. The code context is available in the domain analysis.\n`
    : "";

  return `You are a character architect creating a diverse intellectual assembly of ${characterCount} domain experts plus a moderator (Socrate) to debate a topic.${codeSection}

## Rules for Character Generation

1. **Diversity of Perspective**: Characters must span the ideological spectrum on this topic. Include at minimum:
   - One character who would be considered "establishment" or mainstream
   - One character who challenges conventional wisdom from the left/progressive side
   - One character who challenges from the right/conservative or traditionalist side
   - One character with deep practitioner/field experience (not just theory)
   - One character representing an underrepresented or non-Western perspective
   - One character who bridges disciplines or takes a heterodox position

2. **Biographical Depth**: Each biography must be 80-100 words focused on TURNING POINTS that CREATED their framework — not a CV summary.
   - NOT: "Dr. Chen studied economics at MIT and published widely on market theory." (describes credentials)
   - YES: "When Chen's model predicted the 2008 crash and her department chair told her to bury it, she learned that institutions protect consensus, not truth. She quit academia." (shows how the framework was forged)

3. **No Strawmen**: Every character must be the strongest possible version of their perspective. If you can reconcile two characters' positions easily, they're not different enough.

4. **Maverick Requirement**: At least 2 characters must hold extreme, high-conviction positions. A timid character is a useless character. Characters should be the boldest defensible version of their perspective — not the moderate, hedge-everything version. Think: the person at the dinner party who says the thing everyone's thinking but nobody will say.

5. **Tag System**: Each character gets a single-word TAG in caps that captures their core archetype (e.g., PRAGMATIST, RADICAL, GUARDIAN, BRIDGE, DISSENTER, EMPIRICIST, MAVERICK). MAVERICK means they hold an extreme position with deep conviction and refuse to back down without overwhelming evidence.

5. **Process Roles**: Distribute these roles across characters (${characterCount >= 5 ? "all 4 required" : "at least 3 required"}):
   - SKEPTIC — challenges assumptions, asks "what could go wrong?"
   - CRAFT — insists on quality, precision, and getting details right
   - ACCESS — advocates for clarity, accessibility, underrepresented perspectives
   - PRAGMATIST — grounds discussion in practical constraints and implementation

6. **Character Voice Rules**: Characters EMBODY their framework — they don't ANNOUNCE it.
   - NOT: "As a utilitarian thinker, I believe we should maximize outcomes..."
   - YES: "The question isn't whether it feels right — it's whether more people are better off."

## Register Adaptation

Read the "Register & Tone" section from the domain analysis. Adapt characters accordingly:

**If Academic**: Use the standard diversity requirements above (establishment, progressive, conservative, practitioner, non-Western, heterodox). Characters have ideological frameworks, intellectual heroes, and formal rhetorical styles.

**If Professional**: Characters are industry practitioners, not academics. Replace "Intellectual Heroes" with "Key Influences" (mentors, companies, experiences). Replace "Ideological Framework" with "Operating Philosophy." Frameworks should be practical mental models, not academic theories.

**If Practical**: Characters are people with real-world experience, not theorists. A mix of: someone who's done it successfully, someone who learned the hard way, a coach/mentor type, a contrarian who challenges conventional advice, someone from a different cultural context, and someone who brings relevant adjacent expertise. Replace "Intellectual Heroes" with "People They Learned From" (can be personal, not famous). Replace "Ideological Framework" with "Core Belief" (one sentence). Biographies should emphasize lived experience over credentials.

**If Casual/Social**: Characters are real people you'd actually ask for this kind of advice — the friend who's naturally good at it, someone who figured it out after being bad at it, someone with the opposite perspective (e.g., what the other side thinks), a brutally honest person, someone from a different scene/culture, and a wildcard. NO academic frameworks. Replace "Intellectual Heroes" with "Who They Learned From" (real people in their life, not authors). Replace "Ideological Framework" with "Their Take" (1-2 sentences, conversational). Biographies should be short and relatable, not CV-like. Rhetorical style should match how they'd actually talk (casual, blunt, funny, etc.).

**If Creative**: Characters are practitioners and tastemakers, not critics. Include working artists/creators, someone commercial, someone experimental, a different cultural tradition, someone who bridges disciplines, and a provocateur. Replace "Intellectual Heroes" with "Influences" (artists, movements, works). Frameworks should be aesthetic philosophies, not academic theories.

## Required Format (follow exactly)

For each character, output:

## Character N: Full Name [TAG: ROLE]

### Biography
80-100 words focused on turning points that created the framework. What happened to them that made them think this way?

### Ideological Framework
Name and describe their core analytical framework in 1-2 paragraphs. Bold the framework name like **"Framework Name"**.

### Specific Positions on ${topic}
Numbered list of 3-5 concrete positions they hold on the specific topic.

### Blind Spot
1 paragraph describing what this character systematically fails to see or underweights.

### Intellectual Heroes
2 real thinkers/practitioners with specific works cited (year + title). These should be real, verifiable works.

### Voice Example
50-80 words modeling incisiveness, not eloquence. A brilliant person's most memorable statements are short. The goal: could you quote this person at a dinner party?

### Debate Style
1-2 sentences on how they argue, what rhetorical moves they favor, and what makes them concede a point.

---

After all characters, output:

## Tension Map

A table showing framework incompatibilities and unexpected alliances:

| Character A | Character B | Relationship | Core Disagreement |
|-------------|-------------|-------------|-------------------|
| [name] | [name] | [allies/opponents/tension] | [one sentence] |

Include at least ${Math.max(3, characterCount - 1)} pairings. Focus on non-obvious relationships — where do expected allies actually disagree? Where do expected opponents secretly share premises?

---

## Character ${characterCount + 1}: Socrate [TAG: MODERATOR]

Socrate is the assembly moderator. Give Socrate a brief biography as a veteran facilitator of intellectual discourse. Socrate's role is STRICTLY:
- Ask questions ONLY — never state positions, never offer opinions
- Expose hidden assumptions by asking characters to justify premises they take for granted
- Force characters to engage with their blind spots
- Identify when characters are talking past each other
- Challenge emerging consensus: "Which framework SHOULD disagree here? Why aren't they?"
- NEVER smuggle positions as questions. "Don't you think X?" is advocacy, not inquiry. Instead: "What would have to be true for X to be wrong?"

## Context

Topic: ${topic}

Domain Analysis:
${domainAnalysis}`;
}

export function referenceLibraryPrompt(
  topic: string,
  characters: string
): string {
  return `You are a research librarian building a 2-layer reference library for an intellectual assembly on a topic. The library must provide the evidential foundation for a rigorous debate.

**IMPORTANT — Register Adaptation**: Read the domain analysis register.
- For **Academic** topics: use the standard format (intellectual traditions + empirical evidence).
- For **Professional** topics: replace "Intellectual Traditions" with "Professional Knowledge Base" — industry reports, case studies, frameworks from practitioners (not just academics).
- For **Practical/Casual/Creative** topics: replace "Intellectual Traditions" with "Experience & Sources" — books, podcasts, Reddit threads, personal blogs, YouTube channels, cultural references, whatever a real person with this perspective would actually learn from. Skip Layer 2 (empirical evidence) entirely — it's not useful here. Instead add a "Common Myths vs Reality" section.

## Layer 1: Intellectual Traditions

For each character (not Socrate), identify their intellectual tradition and list 4-6 key references that inform their worldview. These should be real works by real authors that a person with this character's perspective would draw upon.

Format each tradition as:

### Character Name — Tradition Name (TAG)

- **Author Name** — *Work Title* (Year). One-sentence description of relevance.
- **Author Name** — *Work Title* (Year). One-sentence description of relevance.

## Layer 2: Empirical Evidence Base

Provide 3-4 categories of empirical evidence relevant to the topic. For each category, list 4-6 real data sources, studies, or reports. **Prioritize sources with hard numbers** — specific statistics, percentages, dollar figures, sample sizes. The debate will only be as rigorous as the data you provide here.

Format as:

### Category Name

- **Author/Organization** — *Study/Report Title* (Year). Key finding WITH specific number (e.g., "found that X increased by 34%" or "surveyed 2,400 firms and found..." — not just "explored the relationship between X and Y").

## Cross-Reading Assignments

For each character, assign one work from a DIFFERENT character's tradition that would challenge their assumptions.

Format as:

### Cross-Reading Assignments

- **Character Name** must engage: *Work Title* by Author — why this challenges their framework.

## Important Rules
- Use REAL, VERIFIABLE works only. If you are uncertain whether a specific work exists, use a well-known representative work from that tradition instead. Do not invent plausible-sounding titles.
- For the Empirical Evidence Base, prefer well-known landmark studies and reports from major organizations (WHO, World Bank, NBER, McKinsey, etc.) over obscure or specific papers you might confuse.
- When exact works are uncertain, use representative real authors from the relevant tradition
- Every reference must include a year (or approximate decade)
- Layer 2 should prioritize recent empirical evidence (last 10-20 years)

Topic: ${topic}

Characters:
${characters}`;
}

export function referenceAuditPrompt(referenceLibrary: string): string {
  return `You are a rigorous reference auditor. Your job is to review a generated reference library and verify whether each cited work is real and accurately attributed.

## Your Task

Review the following reference library. For each cited work (author + title + year):

1. Rate your confidence that this is a real, published work:
   - **HIGH** — You are confident this is a real work with correct author and approximate year
   - **MEDIUM** — The author is real and works in this area, but the specific title may be slightly off
   - **LOW** — The author exists but you're unsure about this specific work
   - **UNCERTAIN** — This author-title-year combination seems fabricated or confused

2. For entries rated UNCERTAIN:
   - Suggest a real, well-known alternative work from the same intellectual tradition, OR
   - Mark for removal if no suitable replacement exists

3. For entries rated LOW:
   - Note your concern but keep the entry

## Output Format

Return the audited library in the SAME markdown format as the input, but:
- After each entry, add a confidence tag: [HIGH], [MEDIUM], [LOW], or [UNCERTAIN]
- For UNCERTAIN entries, wrap the entry in [UNVERIFIED] tags and add a correction note on the next line
- At the end, add a ## Audit Summary section listing:
  - Total entries reviewed
  - Count by confidence level
  - Any patterns of concern

## Reference Library to Audit

${referenceLibrary}`;
}

export function debatePrompt(
  topic: string,
  characters: string,
  referenceLibrary: string,
  structure: string
): string {
  const structureInstructions = getDebateStructureInstructions(structure);

  return `You are orchestrating a ${structure} debate — a structured intellectual assembly where expert characters and a moderator (Socrate) engage in rigorous debate on a topic.

${structureInstructions}

## Format Rules

Use ## headings for each round/phase:

Use bold for speaker names followed by colon:

**Character Name:** Their speech text here spanning one or more paragraphs.

**Socrate:** Moderator intervention text.

For Socrate interventions mid-round:

**[SOCRATE intervenes]**

**Socrate:** Intervention text.

## Quality Rules

1. Characters must speak IN CHARACTER — using their debate style, referencing their intellectual heroes, drawing on evidence from the reference library
2. Characters must ENGAGE with each other's arguments, not just restate their own
3. Include specific references to works from the reference library
4. Show genuine intellectual tension — not polite disagreement but substantive conflict
5. At least 2 characters should visibly update their positions during the debate, AND at least 1 character should explicitly refuse to update, explaining exactly why the counterarguments failed to persuade them
6. Socrate should ask at least 3 genuinely difficult questions that make characters uncomfortable
12. **Depth Rule**: Every claim must be backed by specifics — real data, named examples, concrete mechanisms, not abstract labels. "Geopolitical concentration risk" is not an argument. "China manufactures 80% of global rare earths and has restricted exports twice in the last decade" is an argument. If a character can't provide specifics, they must say "I believe this but can't cite evidence" rather than presenting vague abstractions as analysis.
13. **Conviction Hold Rule**: Characters should NOT concede unless genuinely persuaded by a specific argument. Holding firm on a position despite group pressure is explicitly valued and expected. A character who caves to social pressure rather than evidence has failed. After the debate, at least 1 character should hold their original position with STRONGER conviction than when they started.
7. The debate should surface at least 1 idea that no single character held at the start
8. When characters cite evidence, they must reference works from the Reference Library provided. Characters must NOT invent new citations, studies, or statistics that aren't grounded in the library or clearly labeled as their professional judgment.
14. **Hard Numbers Rule**: Characters must cite specific numbers, dates, percentages, dollar amounts, or named sources whenever possible. "The market is growing" is empty. "The market grew 23% YoY to $4.7B in 2024 according to [Source]" is an argument. Every round should contain at least 3 concrete data points drawn from the Reference Library. When exact numbers aren't available, characters must explicitly say "I don't have the exact figure" rather than using vague quantifiers like "significant" or "substantial."
9. Characters speak only when their framework genuinely informs the question. Not every character needs to respond to every point. If a character's framework doesn't add specific, substantive insight, they stay silent.
10. Framework restatement is not insight. A character who takes a practical question and "reframes" it through their theoretical lens without answering it has failed. Engage the actual question first.
11. Brevity signals understanding. If you can't say it in under 50 words, you don't understand it yet. The best debate contributions are 2-4 sentences that change how everyone else thinks.

## Convergence Detection

After every 3rd speaker, Socrate performs a framework audit:
- Which frameworks are converging? Is the convergence genuine or are they just using different words for the same position?
- Which framework SHOULD disagree here but isn't? Surface that disagreement.
- Every convergence point must be tested: "We seem to agree on X — but [Character] should object based on their framework. Why haven't they?"

## Tone Adaptation

Read the register from the domain analysis:
- **Academic**: Use the formal debate structure above as-is.
- **Professional**: Characters speak like they're at an industry panel, not an academic conference. Less citation, more war stories and pattern recognition.
- **Practical**: Characters speak like they're giving advice to a friend. Direct, actionable, specific examples from experience. Less "I would argue that..." more "Here's what I did..." and "The thing nobody tells you is..."
- **Casual/Social**: Characters speak like real people having this conversation at a bar or group chat. Slang is fine. Humor is encouraged. Hot takes welcome. They can disagree bluntly. Socrate's role shifts from "moderator" to "the friend who asks the awkward follow-up question everyone's thinking."
- **Creative**: Characters speak like they're at a studio visit or workshop crit. Show don't tell. Reference specific works. Aesthetic disagreements are personal — lean into that.

Topic: ${topic}

Characters:
${characters}

Reference Library:
${referenceLibrary}`;
}

function getDebateStructureInstructions(structure: string): string {
  switch (structure) {
    case "Duels":
      return `## Debate Structure: Duels

Paired framework opponents go 1v1 on specific tensions. This structure is best for binary decisions.

### Setup
Identify the key tensions from the domain analysis. Pair characters with opposing frameworks on each tension.

### For each Duel:
1. **Framing**: Socrate states the specific tension being debated in one sentence
2. **Opening**: Each duelist states their position in 2-3 sentences
3. **Exchange**: Characters go back and forth (3-5 exchanges each) until they locate the EXACT DIVERGING PREMISE — the specific assumption where they part ways — or one concedes
4. **Resolution**: State clearly: did they find the diverging premise? Did either concede? What remains unresolved?
5. **Observers**: 1-2 non-dueling characters state which argument they found more compelling and why

Run 3 duels (or match the number of key tensions from the domain analysis). After all duels, Socrate synthesizes what the pattern of wins/losses reveals.`;

    case "Tribunal":
      return `## Debate Structure: Tribunal

One member presents a thesis. Prosecutors attack. Jury evaluates survival. Best for stress-testing a specific proposal.

### Run 2-3 Tribunals:

For each Tribunal:
1. **Thesis**: One character presents their core thesis on the topic in 3-4 sentences
2. **Prosecution**: 3 characters attack the thesis from different angles. Each prosecutor gets 2-3 exchanges. They must attack PREMISES, not just conclusions.
3. **Defense**: The thesis-holder responds to each attack
4. **Jury Verdict**: Remaining characters evaluate: what survived? What was fatally damaged? What was modified?
5. **Socrate's Summary**: What did this tribunal reveal about the strength of this position?

Choose thesis-holders whose positions are strong enough to survive serious attack. The goal is not to destroy but to reveal which parts are load-bearing.`;

    case "Socratique":
      return `## Debate Structure: Socratique

Socrate leads the entire assembly through questions only. Best for values-laden or philosophical questions.

### Process:
1. **Opening Question**: Socrate poses a foundational question about the topic to a specific character
2. **Directed Inquiry**: Socrate asks follow-up questions to specific characters based on their answers, probing deeper into premises and assumptions
3. **Cross-Examination**: Socrate asks one character to respond to another's answer: "Character A said X. Character B, does that hold from your perspective?"
4. **Premise Surfacing**: Through continued questioning, Socrate reveals the fundamental premises each character holds — the bedrock assumptions they cannot give up
5. **Closing**: Socrate summarizes the fundamental premises surfaced and where they are genuinely incompatible

CRITICAL: Socrate asks questions ONLY throughout this entire structure. Never states positions. Never summarizes until the very end. Never says "Don't you think...?" (that's advocacy). Every question must be genuinely open: "What would have to be true for your position to be wrong?"

Characters answer Socrate's questions. They may also address each other, but Socrate directs the flow.`;

    default: // Grande Table
      return `## Debate Structure: Grande Table

Open multi-perspective discussion with rotating focus. Best for multi-factor analysis.

The debate consists of 4 rounds:

### Round 1: Opening Positions
Each character states their core position on the topic in 2-3 sentences (NOT paragraphs — concise positions only). No monologues. Socrate introduces the topic.

### Round 2: Direct Confrontations
Characters directly challenge each other's positions. Create 3 focused exchanges where characters explain specifically why the other is wrong — not framework-vs-framework, but "this actually works differently because..." Socrate intervenes to sharpen disagreements.

### Round 3: Unexpected Alliances & Deep Dives
Characters find surprising common ground across ideological lines. Socrate pushes: "Why do you agree? Is this genuine convergence or are you using different words for different things?" At least one character updates their position based on evidence.

### Round 4: Final Positions
Each character states in 2-3 sentences: what they still believe, what they've updated on, what remains unresolved. Socrate delivers closing synthesis.`;
  }
}

export function synthesisPrompt(
  topic: string,
  debateTranscript: string,
  maverickRound?: string
): string {
  return `You are an expert synthesizer analyzing the transcript of a multi-perspective intellectual debate on a topic. Your job is to produce a rigorous synthesis that captures the full intellectual landscape revealed by the debate.

**CRITICAL: The user asked a question or posed a topic. Your synthesis MUST directly answer or address it.** Do not just describe the debate abstractly — give the reader a clear, actionable answer informed by the debate. If the topic is a question, state the answer (or best answers) upfront, noting which characters support which position and why. If reasonable people disagree, say so explicitly — but still tell the reader what the weight of argument favors. State insights in plain language first. If an idea needs jargon to express, it hasn't been understood yet.

## Required Sections

### 1. Title
A descriptive title for the synthesis (use # heading).

### 2. Direct Answer
Answer the user's question or address their topic head-on in 2-4 paragraphs. State the strongest position(s) that emerged — lead with conviction, not caution. If one position is clearly stronger, say so bluntly. Don't soften strong conclusions to appear balanced. If there's no consensus, explain the key fault lines and what factors should guide the reader's own decision. Do not hedge everything equally — if the debate leaned one way, say so.

## Convergence Points

List points where multiple characters converged. For each:
- **Bold the claim**
- State which characters agreed AND explain why this convergence is meaningful — which incompatible frameworks agreed despite their differences?
- Rate confidence: high / medium-high / medium / low
- Provide the evidence basis

Format:
- **Bold the claim in one plain-language sentence, no jargon** — Characters A, B, and C converged on this (meaningful because A and B hold incompatible frameworks on X). Confidence: **high**. Evidence: cite the specific numbers, studies, or data points that support this — not just "evidence from the debate" but the actual figures and their sources.

## Irreducible Divergences

List fundamental disagreements that the debate could not resolve. For each:
- **Bold the issue**
- Explain the opposing positions and why reconciliation failed

Format:
- **Bold the issue in one plain-language sentence, no jargon** — Character A argues X because of Y, while Character B maintains Z because of W. This divergence is irreducible because...

## Emergent Ideas

List ideas that emerged FROM the debate interaction — insights no single character held at the start but that arose from the exchange. State each in under 20 words FIRST, then explain.

Format:
- **Bold the idea in under 20 words** — Brief description of how this emerged from the interaction between characters.

## Conviction Holds

List positions that a character held with deep conviction DESPITE opposition from the group. These are the takes that survived the debate's pressure. For each:
- **Bold the position in one sentence**
- Name the character who held it and WHY they refused to concede
- What was the strongest argument against it, and why it failed to persuade them
- Rate conviction strength: unwavering / strengthened / firm-but-tested

## Boldest Defensible Takes

List the most extreme but intellectually defensible positions that emerged. These are the "hot takes" — the positions that would make a room uncomfortable but that have genuine intellectual backing. For each:
- **Bold the take in one provocative sentence**
- Who holds it and the core argument
- Why most people would instinctively disagree
- Why they might be wrong to disagree

## Knowledge Gaps & Honest Failures

Combine two things: (1) questions the debate revealed that current evidence cannot answer, and (2) what this assembly genuinely CANNOT answer — where the debate hit the limits of its expertise. "We don't know" is valid output.

Format:
- **Gap or failure statement** — Why this matters, whether it's answerable with more information, and what would be needed to resolve it.

## Recommendations

List 4-6 concrete, actionable recommendations that follow from the synthesis. These should reflect the full debate, not just one character's view.

Format numbered list:
1. **Recommendation title** — Description incorporating multiple perspectives.

## Unexpected Alliances

Note any surprising agreements between characters who were expected to disagree.

Format:
- **Alliance description** — Characters and what they unexpectedly agreed on.

## Quality Gates (apply before finalizing)

For every claim or recommendation:
1. **Plaintext test**: Rewrite it in one sentence using no jargon. If the plain version sounds obvious or empty, the original was disguising a lack of substance — delete it.
2. **Falsifiability test**: What evidence would disprove this claim? If nothing could disprove it, it's not saying anything.
3. **Slop test**: Does this contain any of: "in today's rapidly evolving landscape", "it's important to note", "furthermore/moreover/additionally", "nuanced" as a substitute for a position, "multifaceted/holistic/synergy/stakeholders", sentences that could appear in any synthesis about any topic? Delete them.
4. **Numbers test**: Does each major claim include at least one concrete number, date, percentage, or named source? Vague quantifiers ("significant growth", "substantial risk", "many experts") must be replaced with specifics or flagged as unquantified. If the debate didn't surface a number, say so explicitly rather than hiding behind vague language.

Topic: ${topic}

Debate Transcript:
${debateTranscript}${maverickRound ? `\n\n## Maverick Round (Independent Post-Debate Takes)\n\n${maverickRound}` : ""}`;
}

export function deliverablePrompt(
  topic: string,
  synthesis: string,
  outputType: string
): string {
  const formatInstructions = getOutputTypeFormat(outputType);

  return `You are producing the final deliverable document based on the synthesis of a multi-perspective intellectual assembly debate on a topic.

## Instructions

Based on the synthesis, produce a polished, actionable deliverable document. The deliverable should:

1. **Stand alone** — A reader who hasn't seen the debate should understand it fully
2. **Be evidence-based** — Reference specific findings from the assembly with hard numbers and named sources. Every major claim should include a concrete data point (percentage, dollar amount, date, named study). "Industry experts agree" is not evidence. "McKinsey's 2024 report found X" or "revenue grew 34% from $2.1M to $2.8M" is evidence. If a claim lacks quantitative backing, flag it explicitly as "based on qualitative assessment" rather than dressing it up.
3. **Acknowledge complexity** — Don't flatten the nuance revealed by the debate
4. **Be actionable** — Include concrete recommendations or frameworks
5. **Credit multiple perspectives** — Show how different viewpoints informed the conclusions
6. **Pass the Plaintext Test** — Every key claim must be expressible in one plain sentence with no jargon. If stripping the jargon makes the idea disappear, there was no idea.
7. **Pass the Falsifiability Test** — For every major claim: what evidence would disprove it? If nothing could, the claim is empty.
8. **Include Minority Reports** — If a strong dissenting view emerged that wasn't adopted by the majority, include it as a clearly labeled 'Dissenting View' section. Present it at full strength — not as a token counterpoint but as a genuinely compelling alternative perspective. The reader should feel the pull of the dissent.

## Slop Test — BANNED PHRASES

The following are BANNED. If you catch yourself writing any of these, delete and rewrite:
- "in today's rapidly evolving landscape"
- "it's important to note"
- "furthermore" / "moreover" / "additionally" as transitions
- "nuanced" as a substitute for stating a position
- "multifaceted" / "holistic" / "synergy" / "stakeholders"
- "it bears mentioning" / "it's worth noting"
- "at the end of the day"
- "navigate" (as metaphor for "deal with")
- "leverage" (as verb meaning "use")
- "robust" / "comprehensive" / "cutting-edge"
- Any sentence that could appear in ANY document about ANY topic
- Five sentences where one would do
- Restating a simple idea in academic language to make it sound substantial

${formatInstructions}

## Format

Use clean markdown with:
- A clear # title
- ## section headings
- Numbered or bulleted lists where appropriate
- Bold for key terms and recommendations
- No more than 3000 words

**Register Adaptation:**
- **Academic/Professional**: Use the professional document format described above.
- **Practical**: Write it as a practical guide. Use "you" language. Include specific do's and don'ts. Structure as: situation → what to do → why it works → common mistakes. Skip the executive summary — start with the most actionable advice.
- **Casual/Social**: Write it like a really good blog post or group chat summary. Conversational tone. Include specific lines, moves, or tactics — not just principles. Organize by scenario, not by theme. It should feel like advice from a smart friend, not a textbook.
- **Creative**: Write it as a creative brief or manifesto. Bold aesthetic positions. Specific references to works that embody each principle. Visual/sensory language.

Topic: ${topic}

Synthesis:
${synthesis}`;
}

function getOutputTypeFormat(outputType: string): string {
  switch (outputType) {
    case "Decision Brief":
      return `## Output Type: Decision Brief

Structure as:
1. **Decision Statement**: What exactly is being decided, in one sentence
2. **Recommendation**: State the recommended option upfront with confidence level
3. **Options Evaluated**: For each option, state: what it is, who advocated for it, strongest argument for, strongest argument against, conditions where it wins
4. **Key Trade-offs**: The 2-3 trade-offs that actually matter (not a comprehensive list — just the ones that change the decision)
5. **Decision Criteria**: What factors should tip the decision one way or another? Under what conditions would you change the recommendation?
6. **What We Don't Know**: Uncertainties that could change the answer`;

    case "Architecture/Design":
      return `## Output Type: Architecture/Design

Structure as:
1. **Executive Summary**: 3-5 bullet points
2. **Design Decision**: For each major architectural choice, state: the decision, alternatives considered, why this option wins, conditions where you'd reconsider
3. **Component Design**: System components, their responsibilities, and interfaces (text diagrams, not code)
4. **Trade-offs Accepted**: What you're giving up and why it's worth it
5. **Implementation Roadmap**: Ordered steps with dependencies
6. **Key Recommendations**: Concrete next steps

Do NOT write actual code. Focus on the WHY behind architectural decisions.`;

    case "Plan":
      return `## Output Type: Plan

Structure as:
1. **Goal**: What success looks like, in one sentence
2. **Key Moves**: The 3-5 actions that actually matter (not a 20-step checklist)
3. **For Each Move**: What to do, why it works, common mistakes, how to know it's working
4. **Sequence**: What order, what depends on what
5. **Risks**: What could go wrong and contingencies
6. **Key Recommendations**: Prioritized action items`;

    case "Analysis":
      return `## Output Type: Analysis

Structure as:
1. **Executive Summary**: 3-5 bullet points
2. **Core Finding**: The main insight, stated plainly
3. **Evidence**: What supports this finding, organized by strength
4. **Counter-Evidence**: What challenges this finding
5. **Implications**: What follows if this finding is correct
6. **Limitations**: What this analysis can't tell you
7. **Key Recommendations**: What to do with this information`;

    default: // Essay/Writing, Code, or fallback
      return `## Output Type: ${outputType || "Analysis"}

Include an "Executive Summary" section at the top (3-5 bullet points) and a "Key Recommendations" section near the end.

**IMPORTANT: For software, coding, or engineering topics, the deliverable must be an architecture plan — covering system design, technology choices, trade-offs, component diagrams (in text), API contracts, and an implementation roadmap. Do NOT write actual code. Focus on the WHY behind architectural decisions, informed by the debate's multiple perspectives.**`;
  }
}

export function deliverableEvolutionPrompt(
  topic: string,
  previousDeliverable: string,
  insightSummaries: string[],
  synthesis: string
): string {
  return `You are evolving an existing deliverable document based on new insights that emerged from follow-up conversations with the intellectual assembly.

## CRITICAL RULE: This is EVOLUTION, not replacement.

You must preserve the structure, voice, and content of the previous deliverable. Only modify sections where the new insights genuinely change the conclusions. Most of the deliverable should remain intact.

## Previous Deliverable
${previousDeliverable}

## Original Synthesis
${synthesis}

## New Insights from Follow-Up Conversations
${insightSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Instructions

1. Read the previous deliverable carefully
2. For each new insight, determine which section(s) it affects
3. Integrate the insight naturally — update conclusions, add caveats, strengthen or weaken arguments as warranted
4. If an insight reveals a position shift, update the relevant recommendation or analysis
5. If an insight exposes a gap, add a brief acknowledgment in the appropriate section
6. Preserve all content that is NOT affected by the new insights
7. End with a "## What Changed in This Version" section listing each modification and which insight prompted it

## Format
- Same format as the original deliverable (markdown, ## headings, etc.)
- No more than 3000 words
- The "What Changed" section should be concise — one bullet per change

Topic: ${topic}`;
}

export function avatarMappingPrompt(characters: string): string {
  return `You are a visual character designer. Given a list of fictional character biographies, map each character to DiceBear Adventurer avatar options that visually match their described profile — age, gender, ethnicity, personality, and appearance implied by their biography.

## Available Options

Pick ONE value for each field from these exact options:

- **skinColor**: "9e5622", "763900", "ecad80", "f2d3b1"
- **hair**: one of: "long01", "long02", "long03", "long04", "long05", "long06", "long07", "long08", "long09", "long10", "long11", "long12", "long13", "long14", "long15", "long16", "long17", "long18", "long19", "long20", "long21", "long22", "long23", "long24", "long25", "long26", "short01", "short02", "short03", "short04", "short05", "short06", "short07", "short08", "short09", "short10", "short11", "short12", "short13", "short14", "short15", "short16", "short17", "short18", "short19"
- **hairColor**: one of: "0e0e0e", "3eac2c", "6a4e35", "85c2c6", "796a45", "562306", "592454", "ab2a18", "ac6511", "afafaf", "b7a259", "cb6820", "dba3be", "e5d7a3"
- **eyes**: one of: "variant01", "variant02", "variant03", "variant04", "variant05", "variant06", "variant07", "variant08", "variant09", "variant10", "variant11", "variant12", "variant13", "variant14", "variant15", "variant16", "variant17", "variant18", "variant19", "variant20", "variant21", "variant22", "variant23", "variant24", "variant25", "variant26"
- **eyebrows**: one of: "variant01", "variant02", "variant03", "variant04", "variant05", "variant06", "variant07", "variant08", "variant09", "variant10", "variant11", "variant12", "variant13", "variant14", "variant15"
- **mouth**: one of: "variant01", "variant02", "variant03", "variant04", "variant05", "variant06", "variant07", "variant08", "variant09", "variant10", "variant11", "variant12", "variant13", "variant14", "variant15", "variant16", "variant17", "variant18", "variant19", "variant20", "variant21", "variant22", "variant23", "variant24", "variant25", "variant26", "variant27", "variant28", "variant29", "variant30"
- **glasses**: one of: "variant01", "variant02", "variant03", "variant04", "variant05", or "none"
- **features**: one of: "birthmark", "blush", "freckles", "mustache", or "none"

## Rules
- Match skin color to the character's implied ethnicity/background
- Match hair style and color to gender and age cues in the biography
- Use glasses for academic/intellectual characters when it fits
- Use "mustache" feature for older male characters when appropriate
- Make each character visually distinct from the others

## Output Format

Return ONLY a valid JSON array with no markdown formatting, no code fences, no explanation. Each element:

[
  {
    "name": "Character Full Name",
    "skinColor": "...",
    "hair": "...",
    "hairColor": "...",
    "eyes": "...",
    "eyebrows": "...",
    "mouth": "...",
    "glasses": "...",
    "features": "..."
  }
]

Characters:
${characters}`;
}

export function verificationPrompt(
  topic: string,
  deliverable: string,
  synthesis: string
): string {
  return `You are a verification agent. Your job is to audit the deliverable from a multi-perspective intellectual assembly and FIX problems inline — not write a separate report.

## Process

1. **Audit every factual claim, source, and statistic** in the deliverable:
   - Is this real? (Does this source/statistic actually exist?)
   - Is this accurate? (Is the claim correctly stated?)
   - Is this current? (Is this outdated information presented as current?)
   - Is the reasoning valid? Check for: causation vs correlation errors, overgeneralization, false precision (fake percentages), confidence laundering ("studies show" without citing which studies)

2. **Fix problems inline**: Rewrite the deliverable with corrections applied directly. Do NOT just flag issues — fix them in the text.
   - Replace fabricated citations with real ones or remove them
   - Correct inaccurate statistics or remove false precision
   - Flag genuinely unverifiable claims with [unverified] inline
   - Fix reasoning errors (e.g., replace "X causes Y" with "X correlates with Y" where appropriate)

3. **Run slop test** on the deliverable and fix violations:
   - Remove: "in today's rapidly evolving landscape", "it's important to note", "furthermore/moreover/additionally" transitions, "nuanced" without a position, "multifaceted/holistic/synergy/stakeholders", "it bears mentioning", "navigate" (metaphor), "leverage" (verb), "robust/comprehensive/cutting-edge"
   - Remove any sentence that could appear in any document about any topic
   - Condense five sentences into one where possible

4. **Run plaintext test**: For every key claim, strip jargon. If the plain version sounds obvious or empty, either rewrite with substance or delete.

5. **Run numbers test**: Flag every major claim that lacks a concrete number, date, percentage, or named source. For each:
   - If the debate surfaced a specific figure, add it inline with source attribution
   - If no figure exists, add [no hard data] inline so the reader knows this is qualitative judgment, not evidence
   - Replace vague quantifiers ("significant", "substantial", "many") with specifics or explicit uncertainty

6. **Re-audit** the corrected version. Max 2 revision cycles. If something can't be verified, mark it [unverified] and move on.

## Output Format

Return the CORRECTED deliverable text — the full deliverable with all fixes applied inline. Then add at the end:

## Verification Notes

Brief list of what was changed:
- [what was changed and why]
- [what was changed and why]
- Number of corrections applied: N
- Unverifiable claims flagged: N

Topic: ${topic}

Deliverable to verify and fix:
${deliverable}

Synthesis (for context):
${synthesis}`;
}

export function maverickRoundPrompt(
  topic: string,
  characters: string,
  debateTranscript: string
): string {
  return `You are orchestrating the Maverick Round — a post-debate phase where each character independently writes their strongest, most conviction-driven take on the topic WITHOUT group pressure.

## Rules

1. Each character writes independently — they've seen the debate but are now alone with their thoughts
2. Characters should write their BOLDEST defensible position — the thing they believe most strongly that the group didn't fully appreciate
3. This is NOT a summary of their debate position. This is their "if I could only say one thing" take — sharper, more extreme, more specific than anything they said in the debate
4. Characters who updated positions during debate should explain whether they ACTUALLY changed their mind or just conceded for social reasons
5. Each take should be 100-200 words, specific, and provocative
6. Characters must provide concrete evidence or reasoning — no vague abstractions
7. Socrate does NOT participate in this round

## Format

For each character (except Socrate):

### [Character Name] — Maverick Take

**The Take:** [One bold sentence]

[100-200 word argument with specifics]

**Conviction Level:** [Unwavering / Strengthened by debate / Firm despite opposition / Actually changed my mind]

**What the group got wrong:** [1-2 sentences on where the consensus failed]

## Context

Topic: ${topic}

Characters:
${characters}

Debate Transcript:
${debateTranscript}`;
}
