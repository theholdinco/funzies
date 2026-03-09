import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import {
  getDb,
  setPipelineStatus,
  getPendingEntities,
  upsertTribe,
  upsertFamily,
  upsertNotableFigure,
  upsertEthnicGroup,
  upsertRegion,
  upsertTribalAncestry,
  upsertTribalRelation,
  upsertMigration,
  upsertHistoricalEvent,
  upsertEventParticipant,
  upsertEntityRegion,
  type Tribe,
  type Family,
  type NotableFigure,
  type EthnicGroup,
  type Region,
  type HistoricalEvent,
} from "./db/client.js";

const MODEL = "claude-sonnet-4-20250514";

const SYSTEM_PROMPT = `You are a historian and anthropologist specializing in Arabian Gulf tribal lineages.
You are analyzing research text about a specific entity and extracting structured data.

IMPORTANT GUIDELINES:
- Extract ONLY what is supported by the source text. Do not fabricate.
- For Arabic names, provide accurate Arabic script.
- For dates/eras, be approximate if exact dates aren't available (e.g., "18th century", "circa 1700").
- Identify any NEW entities (tribes, families, people, events, places) mentioned in the text that should be researched separately.
- Focus on relationships, migrations, alliances, rivalries, and narrative context.
- For formation_type, determine if this is a real blood lineage, a political confederation, a geographic grouping, or a claimed/disputed lineage.`;

// ── Tool schemas per entity type ────────────────────────────────────

function getTribeToolSchema(): Anthropic.Tool {
  return {
    name: "extract_tribe_data",
    description: "Extract structured tribal data from research text",
    input_schema: {
      type: "object" as const,
      properties: {
        tribe: {
          type: "object",
          properties: {
            name_ar: { type: "string", description: "Arabic name" },
            formation_type: { type: "string", enum: ["blood_lineage", "confederation", "geographic_group", "political_alliance", "claimed_name"] },
            legitimacy_notes: { type: "string", description: "Explanation of how this group formed and whether the lineage claim is real or political" },
            ancestor_name: { type: "string" },
            ancestor_story: { type: "string", description: "Narrative about the claimed ancestor" },
            lineage_root: { type: "string", enum: ["adnani", "qahtani", "disputed", "non_arab", "unknown"] },
            founding_era: { type: "string" },
            status: { type: "string", enum: ["active", "historical", "absorbed", "extinct"] },
            peak_power_era: { type: "string" },
            traditional_economy: { type: "string" },
            alignment: { type: "string", enum: ["ghafiri", "hinawi", "neutral", "na"] },
            description: { type: "string", description: "Rich narrative paragraph about this tribe" },
          },
        },
        sub_tribes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              name_ar: { type: "string" },
              relationship: { type: "string", enum: ["sub_tribe", "offshoot", "claimed_descent", "absorbed_into", "split_from"] },
              split_year: { type: "integer" },
              split_story: { type: "string" },
              is_contested: { type: "boolean" },
            },
            required: ["id", "name"],
          },
        },
        relations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              other_tribe_id: { type: "string" },
              other_tribe_name: { type: "string" },
              relation_type: { type: "string", enum: ["alliance", "rivalry", "vassalage", "intermarriage", "trade_partnership", "shared_migration"] },
              strength: { type: "string", enum: ["strong", "moderate", "weak", "historical_only"] },
              is_current: { type: "boolean" },
              context: { type: "string" },
              turning_point: { type: "string" },
            },
            required: ["other_tribe_id", "other_tribe_name", "relation_type"],
          },
        },
        migrations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              origin: { type: "string" },
              destination: { type: "string" },
              start_year: { type: "integer" },
              end_year: { type: "integer" },
              reason: { type: "string" },
              narrative: { type: "string" },
            },
          },
        },
        notable_figures: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              name_ar: { type: "string" },
              title: { type: "string" },
              born_year: { type: "integer" },
              died_year: { type: "integer" },
              role_description: { type: "string" },
              significance: { type: "string" },
            },
            required: ["id", "name"],
          },
        },
        regions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              region_id: { type: "string" },
              region_name: { type: "string" },
              presence_type: { type: "string", enum: ["dominant", "significant", "minority", "historical_only", "ruling"] },
            },
            required: ["region_id", "region_name"],
          },
        },
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              year: { type: "integer" },
              event_type: { type: "string" },
              description: { type: "string" },
              significance: { type: "string" },
              role: { type: "string", description: "This tribe's role in the event" },
            },
            required: ["id", "title"],
          },
        },
        new_entities: {
          type: "array",
          description: "NEW entities discovered in the text that aren't already in the DB",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["tribe", "family", "notable_figure", "ethnic_group", "region", "event"] },
              id: { type: "string" },
              name: { type: "string" },
              brief: { type: "string" },
            },
            required: ["type", "id", "name"],
          },
        },
      },
      required: ["tribe"],
    },
  };
}

function getFamilyToolSchema(): Anthropic.Tool {
  return {
    name: "extract_family_data",
    description: "Extract structured family data from research text",
    input_schema: {
      type: "object" as const,
      properties: {
        family: {
          type: "object",
          properties: {
            name_ar: { type: "string" },
            family_type: { type: "string", enum: ["ruling", "merchant", "scholarly", "military", "religious"] },
            is_ruling: { type: "boolean" },
            rules_over: { type: "string" },
            current_head: { type: "string" },
            founded_year: { type: "integer" },
            origin_story: { type: "string" },
            legitimacy_basis: { type: "string" },
            description: { type: "string" },
            tribe_id: { type: "string", description: "ID of the tribe this family belongs to" },
          },
        },
        notable_members: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              name_ar: { type: "string" },
              title: { type: "string" },
              born_year: { type: "integer" },
              died_year: { type: "integer" },
              role_description: { type: "string" },
              significance: { type: "string" },
            },
            required: ["id", "name"],
          },
        },
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              year: { type: "integer" },
              event_type: { type: "string" },
              description: { type: "string" },
              significance: { type: "string" },
              role: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
        new_entities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["tribe", "family", "notable_figure", "ethnic_group", "region", "event"] },
              id: { type: "string" },
              name: { type: "string" },
              brief: { type: "string" },
            },
            required: ["type", "id", "name"],
          },
        },
      },
      required: ["family"],
    },
  };
}

function getEthnicGroupToolSchema(): Anthropic.Tool {
  return {
    name: "extract_ethnic_group_data",
    description: "Extract structured ethnic group data from research text",
    input_schema: {
      type: "object" as const,
      properties: {
        ethnic_group: {
          type: "object",
          properties: {
            name_ar: { type: "string" },
            identity_type: { type: "string" },
            pre_islamic_origins: { type: "string" },
            key_tension: { type: "string" },
            origin_narrative: { type: "string" },
            population_estimate: { type: "string" },
            traditional_economy: { type: "string" },
            description: { type: "string" },
          },
        },
        regions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              region_id: { type: "string" },
              region_name: { type: "string" },
              presence_type: { type: "string", enum: ["dominant", "significant", "minority", "historical_only", "ruling"] },
            },
            required: ["region_id", "region_name"],
          },
        },
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              year: { type: "integer" },
              event_type: { type: "string" },
              description: { type: "string" },
              significance: { type: "string" },
              role: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
        new_entities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["tribe", "family", "notable_figure", "ethnic_group", "region", "event"] },
              id: { type: "string" },
              name: { type: "string" },
              brief: { type: "string" },
            },
            required: ["type", "id", "name"],
          },
        },
      },
      required: ["ethnic_group"],
    },
  };
}

function getEventToolSchema(): Anthropic.Tool {
  return {
    name: "extract_event_data",
    description: "Extract structured historical event data from research text",
    input_schema: {
      type: "object" as const,
      properties: {
        event: {
          type: "object",
          properties: {
            title_ar: { type: "string" },
            year: { type: "integer" },
            end_year: { type: "integer" },
            event_type: { type: "string" },
            description: { type: "string" },
            significance: { type: "string" },
            outcome: { type: "string" },
            surprise_factor: { type: "string" },
            location_id: { type: "string" },
          },
        },
        participants: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entity_type: { type: "string", enum: ["tribe", "family", "notable_figure", "ethnic_group"] },
              entity_id: { type: "string" },
              entity_name: { type: "string" },
              role: { type: "string" },
              action: { type: "string" },
            },
            required: ["entity_type", "entity_id"],
          },
        },
        new_entities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["tribe", "family", "notable_figure", "ethnic_group", "region", "event"] },
              id: { type: "string" },
              name: { type: "string" },
              brief: { type: "string" },
            },
            required: ["type", "id", "name"],
          },
        },
      },
      required: ["event"],
    },
  };
}

function getRegionToolSchema(): Anthropic.Tool {
  return {
    name: "extract_region_data",
    description: "Extract structured region data from research text",
    input_schema: {
      type: "object" as const,
      properties: {
        region: {
          type: "object",
          properties: {
            name_ar: { type: "string" },
            strategic_importance: { type: "string" },
            lat: { type: "number" },
            lng: { type: "number" },
          },
        },
        entities_present: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entity_type: { type: "string", enum: ["tribe", "family", "ethnic_group"] },
              entity_id: { type: "string" },
              entity_name: { type: "string" },
              presence_type: { type: "string", enum: ["dominant", "significant", "minority", "historical_only", "ruling"] },
            },
            required: ["entity_type", "entity_id"],
          },
        },
        territory_control: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entity_type: { type: "string", enum: ["tribe", "family"] },
              entity_id: { type: "string" },
              control_type: { type: "string" },
              start_year: { type: "integer" },
              end_year: { type: "integer" },
              notes: { type: "string" },
            },
            required: ["entity_type", "entity_id"],
          },
        },
        new_entities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["tribe", "family", "notable_figure", "ethnic_group", "region", "event"] },
              id: { type: "string" },
              name: { type: "string" },
              brief: { type: "string" },
            },
            required: ["type", "id", "name"],
          },
        },
      },
      required: ["region"],
    },
  };
}

function getNotableFigureToolSchema(): Anthropic.Tool {
  return {
    name: "extract_notable_figure_data",
    description: "Extract structured notable figure data from research text",
    input_schema: {
      type: "object" as const,
      properties: {
        figure: {
          type: "object",
          properties: {
            name_ar: { type: "string" },
            title: { type: "string" },
            born_year: { type: "integer" },
            died_year: { type: "integer" },
            role_description: { type: "string" },
            era: { type: "string" },
            significance: { type: "string" },
            tribe_id: { type: "string" },
            family_id: { type: "string" },
          },
        },
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              year: { type: "integer" },
              event_type: { type: "string" },
              description: { type: "string" },
              significance: { type: "string" },
              role: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
        new_entities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["tribe", "family", "notable_figure", "ethnic_group", "region", "event"] },
              id: { type: "string" },
              name: { type: "string" },
              brief: { type: "string" },
            },
            required: ["type", "id", "name"],
          },
        },
      },
      required: ["figure"],
    },
  };
}

function getToolForEntityType(entityType: string): Anthropic.Tool {
  switch (entityType) {
    case "tribe": return getTribeToolSchema();
    case "family": return getFamilyToolSchema();
    case "ethnic_group": return getEthnicGroupToolSchema();
    case "event": return getEventToolSchema();
    case "region": return getRegionToolSchema();
    case "notable_figure": return getNotableFigureToolSchema();
    default: throw new Error(`Unknown entity type: ${entityType}`);
  }
}

// ── Entity name lookup ──────────────────────────────────────────────

const TABLE_MAP: Record<string, string> = {
  tribe: "tribes",
  family: "families",
  notable_figure: "notable_figures",
  ethnic_group: "ethnic_groups",
  event: "historical_events",
  region: "regions",
};

function getEntityName(db: Database.Database, entityType: string, entityId: string): string {
  const table = TABLE_MAP[entityType];
  if (!table) return entityId;
  const nameCol = entityType === "event" ? "title" : "name";
  const row = db.prepare(`SELECT ${nameCol} FROM ${table} WHERE id = ?`).get(entityId) as Record<string, string> | undefined;
  return row?.[nameCol] ?? entityId;
}

// ── Call Claude API ─────────────────────────────────────────────────

async function callClaude(
  anthropic: Anthropic,
  entityType: string,
  entityName: string,
  rawText: string,
): Promise<Record<string, unknown>> {
  const tool = getToolForEntityType(entityType);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [
      {
        role: "user",
        content: `Extract structured data about the ${entityType.replace("_", " ")} "${entityName}" from the following research text:\n\n${rawText}`,
      },
    ],
  });

  // Find the tool_use block
  for (const block of response.content) {
    if (block.type === "tool_use") {
      return block.input as Record<string, unknown>;
    }
  }

  // Fallback: try parsing text response as JSON
  for (const block of response.content) {
    if (block.type === "text") {
      return JSON.parse(block.text);
    }
  }

  throw new Error("Claude did not return tool_use or parseable JSON");
}

// ── Persist extracted data ──────────────────────────────────────────

function seedNewEntity(db: Database.Database, entity: { type: string; id: string; name: string; brief?: string }) {
  const table = TABLE_MAP[entity.type];
  if (!table) return;

  // Check if entity already exists
  const existing = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(entity.id);
  if (existing) return;

  const nameCol = entity.type === "event" ? "title" : "name";
  db.prepare(`INSERT OR IGNORE INTO ${table} (id, ${nameCol}) VALUES (?, ?)`).run(entity.id, entity.name);
  setPipelineStatus(db, entity.type, entity.id, "seeded");
}

function persistTribeData(db: Database.Database, entityId: string, data: Record<string, unknown>) {
  const tribe = data.tribe as Record<string, unknown> | undefined;
  if (!tribe) return;

  // Get existing tribe row to merge
  const existing = db.prepare("SELECT * FROM tribes WHERE id = ?").get(entityId) as Tribe | undefined;
  const merged: Tribe = {
    id: entityId,
    name: existing?.name ?? entityId,
    name_ar: (tribe.name_ar as string) ?? existing?.name_ar ?? null,
    formation_type: (tribe.formation_type as string) ?? existing?.formation_type ?? null,
    legitimacy_notes: (tribe.legitimacy_notes as string) ?? existing?.legitimacy_notes ?? null,
    ancestor_name: (tribe.ancestor_name as string) ?? existing?.ancestor_name ?? null,
    ancestor_story: (tribe.ancestor_story as string) ?? existing?.ancestor_story ?? null,
    lineage_root: (tribe.lineage_root as string) ?? existing?.lineage_root ?? null,
    founding_era: (tribe.founding_era as string) ?? existing?.founding_era ?? null,
    origin_region_id: existing?.origin_region_id ?? null,
    status: (tribe.status as string) ?? existing?.status ?? null,
    peak_power_era: (tribe.peak_power_era as string) ?? existing?.peak_power_era ?? null,
    traditional_economy: (tribe.traditional_economy as string) ?? existing?.traditional_economy ?? null,
    alignment: (tribe.alignment as string) ?? existing?.alignment ?? null,
    description: (tribe.description as string) ?? existing?.description ?? null,
    color: existing?.color ?? null,
  };
  upsertTribe(db, merged);

  // Sub-tribes
  const subTribes = data.sub_tribes as Array<Record<string, unknown>> | undefined;
  if (subTribes) {
    for (const st of subTribes) {
      // Ensure the sub-tribe exists in tribes table
      const stId = st.id as string;
      const existingSt = db.prepare("SELECT id FROM tribes WHERE id = ?").get(stId);
      if (!existingSt) {
        upsertTribe(db, {
          id: stId,
          name: st.name as string,
          name_ar: (st.name_ar as string) ?? null,
          formation_type: null, legitimacy_notes: null, ancestor_name: null, ancestor_story: null,
          lineage_root: null, founding_era: null, origin_region_id: null, status: null,
          peak_power_era: null, traditional_economy: null, alignment: null, description: null, color: null,
        });
        setPipelineStatus(db, "tribe", stId, "seeded");
      }
      upsertTribalAncestry(db, {
        parent_id: entityId,
        child_id: stId,
        relationship: (st.relationship as string) ?? "sub_tribe",
        split_year: (st.split_year as number) ?? null,
        split_story: (st.split_story as string) ?? null,
        is_contested: st.is_contested ? 1 : 0,
      });
    }
  }

  // Relations
  const relations = data.relations as Array<Record<string, unknown>> | undefined;
  if (relations) {
    for (const rel of relations) {
      const otherId = rel.other_tribe_id as string;
      // Ensure other tribe exists
      const existingOther = db.prepare("SELECT id FROM tribes WHERE id = ?").get(otherId);
      if (!existingOther) {
        upsertTribe(db, {
          id: otherId, name: rel.other_tribe_name as string,
          name_ar: null, formation_type: null, legitimacy_notes: null, ancestor_name: null, ancestor_story: null,
          lineage_root: null, founding_era: null, origin_region_id: null, status: null,
          peak_power_era: null, traditional_economy: null, alignment: null, description: null, color: null,
        });
        setPipelineStatus(db, "tribe", otherId, "seeded");
      }
      upsertTribalRelation(db, {
        tribe_a_id: entityId,
        tribe_b_id: otherId,
        relation_type: rel.relation_type as string,
        strength: (rel.strength as string) ?? null,
        start_era: null,
        end_era: null,
        is_current: rel.is_current ? 1 : 0,
        context: (rel.context as string) ?? null,
        turning_point: (rel.turning_point as string) ?? null,
      });
    }
  }

  // Migrations
  const migrations = data.migrations as Array<Record<string, unknown>> | undefined;
  if (migrations) {
    for (const mig of migrations) {
      const dest = (mig.destination as string) ?? "unknown";
      const migId = `mig_${entityId}_${dest.replace(/\s+/g, "_").toLowerCase()}`;
      upsertMigration(db, {
        id: migId,
        entity_type: "tribe",
        entity_id: entityId,
        origin_region_id: (mig.origin as string) ?? null,
        destination_region_id: (mig.destination as string) ?? null,
        waypoints: null,
        route_geojson: null,
        start_year: (mig.start_year as number) ?? null,
        end_year: (mig.end_year as number) ?? null,
        reason: (mig.reason as string) ?? null,
        narrative: (mig.narrative as string) ?? null,
        population_estimate: null,
      });
    }
  }

  // Notable figures
  persistFigures(db, entityId, "tribe", data.notable_figures as Array<Record<string, unknown>> | undefined);

  // Regions
  persistRegions(db, entityId, "tribe", data.regions as Array<Record<string, unknown>> | undefined);

  // Events
  persistEvents(db, entityId, "tribe", data.events as Array<Record<string, unknown>> | undefined);

  // New entities
  persistNewEntities(db, data.new_entities as Array<Record<string, unknown>> | undefined);
}

function persistFamilyData(db: Database.Database, entityId: string, data: Record<string, unknown>) {
  const family = data.family as Record<string, unknown> | undefined;
  if (!family) return;

  const existing = db.prepare("SELECT * FROM families WHERE id = ?").get(entityId) as Family | undefined;
  const merged: Family = {
    id: entityId,
    name: existing?.name ?? entityId,
    name_ar: (family.name_ar as string) ?? existing?.name_ar ?? null,
    tribe_id: (family.tribe_id as string) ?? existing?.tribe_id ?? null,
    family_type: (family.family_type as string) ?? existing?.family_type ?? null,
    is_ruling: family.is_ruling !== undefined ? (family.is_ruling ? 1 : 0) : (existing?.is_ruling ?? null),
    rules_over: (family.rules_over as string) ?? existing?.rules_over ?? null,
    current_head: (family.current_head as string) ?? existing?.current_head ?? null,
    founded_year: (family.founded_year as number) ?? existing?.founded_year ?? null,
    origin_story: (family.origin_story as string) ?? existing?.origin_story ?? null,
    legitimacy_basis: (family.legitimacy_basis as string) ?? existing?.legitimacy_basis ?? null,
    description: (family.description as string) ?? existing?.description ?? null,
  };
  upsertFamily(db, merged);

  // Notable members
  persistFigures(db, entityId, "family", data.notable_members as Array<Record<string, unknown>> | undefined);

  // Events
  persistEvents(db, entityId, "family", data.events as Array<Record<string, unknown>> | undefined);

  // New entities
  persistNewEntities(db, data.new_entities as Array<Record<string, unknown>> | undefined);
}

function persistEthnicGroupData(db: Database.Database, entityId: string, data: Record<string, unknown>) {
  const eg = data.ethnic_group as Record<string, unknown> | undefined;
  if (!eg) return;

  const existing = db.prepare("SELECT * FROM ethnic_groups WHERE id = ?").get(entityId) as EthnicGroup | undefined;
  const merged: EthnicGroup = {
    id: entityId,
    name: existing?.name ?? entityId,
    name_ar: (eg.name_ar as string) ?? existing?.name_ar ?? null,
    ethnicity: (eg.ethnicity as string) ?? existing?.ethnicity ?? null,
    religion: (eg.religion as string) ?? existing?.religion ?? null,
    identity_type: (eg.identity_type as string) ?? existing?.identity_type ?? null,
    pre_islamic_origins: (eg.pre_islamic_origins as string) ?? existing?.pre_islamic_origins ?? null,
    key_tension: (eg.key_tension as string) ?? existing?.key_tension ?? null,
    origin_narrative: (eg.origin_narrative as string) ?? existing?.origin_narrative ?? null,
    population_estimate: (eg.population_estimate as string) ?? existing?.population_estimate ?? null,
    traditional_economy: (eg.traditional_economy as string) ?? existing?.traditional_economy ?? null,
    description: (eg.description as string) ?? existing?.description ?? null,
  };
  upsertEthnicGroup(db, merged);

  persistRegions(db, entityId, "ethnic_group", data.regions as Array<Record<string, unknown>> | undefined);
  persistEvents(db, entityId, "ethnic_group", data.events as Array<Record<string, unknown>> | undefined);
  persistNewEntities(db, data.new_entities as Array<Record<string, unknown>> | undefined);
}

function persistEventData(db: Database.Database, entityId: string, data: Record<string, unknown>) {
  const evt = data.event as Record<string, unknown> | undefined;
  if (!evt) return;

  const existing = db.prepare("SELECT * FROM historical_events WHERE id = ?").get(entityId) as HistoricalEvent | undefined;
  const merged: HistoricalEvent = {
    id: entityId,
    title: existing?.title ?? entityId,
    title_ar: (evt.title_ar as string) ?? existing?.title_ar ?? null,
    year: (evt.year as number) ?? existing?.year ?? null,
    end_year: (evt.end_year as number) ?? existing?.end_year ?? null,
    event_type: (evt.event_type as string) ?? existing?.event_type ?? null,
    location_id: (evt.location_id as string) ?? existing?.location_id ?? null,
    description: (evt.description as string) ?? existing?.description ?? null,
    significance: (evt.significance as string) ?? existing?.significance ?? null,
    outcome: (evt.outcome as string) ?? existing?.outcome ?? null,
    surprise_factor: (evt.surprise_factor as string) ?? existing?.surprise_factor ?? null,
  };
  upsertHistoricalEvent(db, merged);

  const participants = data.participants as Array<Record<string, unknown>> | undefined;
  if (participants) {
    for (const p of participants) {
      upsertEventParticipant(db, {
        event_id: entityId,
        entity_type: p.entity_type as string,
        entity_id: p.entity_id as string,
        role: (p.role as string) ?? null,
        action: (p.action as string) ?? null,
      });
    }
  }

  persistNewEntities(db, data.new_entities as Array<Record<string, unknown>> | undefined);
}

function persistRegionData(db: Database.Database, entityId: string, data: Record<string, unknown>) {
  const region = data.region as Record<string, unknown> | undefined;
  if (!region) return;

  const existing = db.prepare("SELECT * FROM regions WHERE id = ?").get(entityId) as Region | undefined;
  const merged: Region = {
    id: entityId,
    name: existing?.name ?? entityId,
    name_ar: (region.name_ar as string) ?? existing?.name_ar ?? null,
    type: existing?.type ?? null,
    country: existing?.country ?? null,
    parent_region_id: existing?.parent_region_id ?? null,
    lat: (region.lat as number) ?? existing?.lat ?? null,
    lng: (region.lng as number) ?? existing?.lng ?? null,
    boundary_geojson: existing?.boundary_geojson ?? null,
    strategic_importance: (region.strategic_importance as string) ?? existing?.strategic_importance ?? null,
  };
  upsertRegion(db, merged);

  const entitiesPresent = data.entities_present as Array<Record<string, unknown>> | undefined;
  if (entitiesPresent) {
    for (const ep of entitiesPresent) {
      upsertEntityRegion(db, {
        entity_type: ep.entity_type as string,
        entity_id: ep.entity_id as string,
        region_id: entityId,
        presence_type: (ep.presence_type as string) ?? null,
        influence_level: null,
        start_era: null,
        end_era: null,
      });
    }
  }

  persistNewEntities(db, data.new_entities as Array<Record<string, unknown>> | undefined);
}

function persistNotableFigureData(db: Database.Database, entityId: string, data: Record<string, unknown>) {
  const fig = data.figure as Record<string, unknown> | undefined;
  if (!fig) return;

  const existing = db.prepare("SELECT * FROM notable_figures WHERE id = ?").get(entityId) as NotableFigure | undefined;
  const merged: NotableFigure = {
    id: entityId,
    name: existing?.name ?? entityId,
    name_ar: (fig.name_ar as string) ?? existing?.name_ar ?? null,
    family_id: (fig.family_id as string) ?? existing?.family_id ?? null,
    tribe_id: (fig.tribe_id as string) ?? existing?.tribe_id ?? null,
    born_year: (fig.born_year as number) ?? existing?.born_year ?? null,
    died_year: (fig.died_year as number) ?? existing?.died_year ?? null,
    title: (fig.title as string) ?? existing?.title ?? null,
    role_description: (fig.role_description as string) ?? existing?.role_description ?? null,
    era: (fig.era as string) ?? existing?.era ?? null,
    significance: (fig.significance as string) ?? existing?.significance ?? null,
  };
  upsertNotableFigure(db, merged);

  persistEvents(db, entityId, "notable_figure", data.events as Array<Record<string, unknown>> | undefined);
  persistNewEntities(db, data.new_entities as Array<Record<string, unknown>> | undefined);
}

// ── Shared persistence helpers ──────────────────────────────────────

function persistFigures(
  db: Database.Database,
  parentId: string,
  parentType: "tribe" | "family",
  figures: Array<Record<string, unknown>> | undefined,
) {
  if (!figures) return;
  for (const fig of figures) {
    const figData: NotableFigure = {
      id: fig.id as string,
      name: fig.name as string,
      name_ar: (fig.name_ar as string) ?? null,
      family_id: parentType === "family" ? parentId : null,
      tribe_id: parentType === "tribe" ? parentId : null,
      title: (fig.title as string) ?? null,
      born_year: (fig.born_year as number) ?? null,
      died_year: (fig.died_year as number) ?? null,
      role_description: (fig.role_description as string) ?? null,
      era: null,
      significance: (fig.significance as string) ?? null,
    };
    upsertNotableFigure(db, figData);
  }
}

function persistRegions(
  db: Database.Database,
  entityId: string,
  entityType: string,
  regions: Array<Record<string, unknown>> | undefined,
) {
  if (!regions) return;
  for (const reg of regions) {
    const regionId = reg.region_id as string;
    // Ensure region exists
    const existing = db.prepare("SELECT id FROM regions WHERE id = ?").get(regionId);
    if (!existing) {
      upsertRegion(db, {
        id: regionId, name: reg.region_name as string,
        name_ar: null, type: null, country: null, parent_region_id: null,
        lat: null, lng: null, boundary_geojson: null, strategic_importance: null,
      });
    }
    upsertEntityRegion(db, {
      entity_type: entityType,
      entity_id: entityId,
      region_id: regionId,
      presence_type: (reg.presence_type as string) ?? null,
      influence_level: null,
      start_era: null,
      end_era: null,
    });
  }
}

function persistEvents(
  db: Database.Database,
  entityId: string,
  entityType: string,
  events: Array<Record<string, unknown>> | undefined,
) {
  if (!events) return;
  for (const evt of events) {
    const eventId = evt.id as string;
    const existingEvent = db.prepare("SELECT id FROM historical_events WHERE id = ?").get(eventId);
    if (!existingEvent) {
      upsertHistoricalEvent(db, {
        id: eventId,
        title: evt.title as string,
        title_ar: null,
        year: (evt.year as number) ?? null,
        end_year: null,
        event_type: (evt.event_type as string) ?? null,
        location_id: null,
        description: (evt.description as string) ?? null,
        significance: (evt.significance as string) ?? null,
        outcome: null,
        surprise_factor: null,
      });
    }
    upsertEventParticipant(db, {
      event_id: eventId,
      entity_type: entityType,
      entity_id: entityId,
      role: (evt.role as string) ?? null,
      action: null,
    });
  }
}

function persistNewEntities(db: Database.Database, newEntities: Array<Record<string, unknown>> | undefined) {
  if (!newEntities) return;
  for (const ne of newEntities) {
    seedNewEntity(db, {
      type: ne.type as string,
      id: ne.id as string,
      name: ne.name as string,
      brief: ne.brief as string | undefined,
    });
  }
}

// ── Main extraction function ────────────────────────────────────────

export async function extractEntity(
  db: Database.Database,
  entityType: string,
  entityId: string,
  rawText: string,
): Promise<void> {
  const anthropic = new Anthropic();
  const entityName = getEntityName(db, entityType, entityId);

  console.log(`  Calling Claude API for ${entityType}/${entityId} ("${entityName}")...`);
  const data = await callClaude(anthropic, entityType, entityName, rawText);

  // Persist in a transaction
  const persistInTransaction = db.transaction(() => {
    switch (entityType) {
      case "tribe": persistTribeData(db, entityId, data); break;
      case "family": persistFamilyData(db, entityId, data); break;
      case "ethnic_group": persistEthnicGroupData(db, entityId, data); break;
      case "event": persistEventData(db, entityId, data); break;
      case "region": persistRegionData(db, entityId, data); break;
      case "notable_figure": persistNotableFigureData(db, entityId, data); break;
      default: throw new Error(`Unknown entity type: ${entityType}`);
    }
    setPipelineStatus(db, entityType, entityId, "extracted");
  });

  persistInTransaction();
  console.log(`  Extracted and persisted data for ${entityType}/${entityId}.`);
}

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(): {
  entityType?: string;
  id?: string;
  limit?: number;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let entityType: string | undefined;
  let id: string | undefined;
  let limit: number | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--entity-type": entityType = args[++i]; break;
      case "--id": id = args[++i]; break;
      case "--limit": limit = parseInt(args[++i], 10); break;
      case "--dry-run": dryRun = true; break;
    }
  }
  return { entityType, id, limit, dryRun };
}

async function main() {
  const { entityType, id, limit, dryRun } = parseArgs();
  const db = getDb();

  // Disable FK checks during extraction since we're building the graph incrementally
  db.pragma("foreign_keys = OFF");

  // Get entities with status 'researched'
  let entities = getPendingEntities(db, "researched");

  if (entityType) {
    entities = entities.filter((e) => e.entity_type === entityType);
  }
  if (id) {
    entities = entities.filter((e) => e.entity_id === id);
  }
  if (limit) {
    entities = entities.slice(0, limit);
  }

  if (entities.length === 0) {
    console.log("No researched entities to extract.");
    db.close();
    return;
  }

  console.log(`Found ${entities.length} entities to extract.`);

  if (dryRun) {
    for (const e of entities) {
      const name = getEntityName(db, e.entity_type, e.entity_id);
      console.log(`  [dry-run] ${e.entity_type}/${e.entity_id}: "${name}"`);
    }
    console.log(`\nDry run complete: ${entities.length} entities would be extracted.`);
    db.close();
    return;
  }

  let extracted = 0;
  let failed = 0;

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    const name = getEntityName(db, e.entity_type, e.entity_id);
    console.log(`Extracting [${i + 1}/${entities.length}]: ${name}...`);

    // Get raw text from research_cache
    const cache = db
      .prepare("SELECT raw_text FROM research_cache WHERE entity_type = ? AND entity_id = ?")
      .get(e.entity_type, e.entity_id) as { raw_text: string } | undefined;

    if (!cache?.raw_text) {
      console.error(`  No research text found for ${e.entity_type}/${e.entity_id}, skipping.`);
      failed++;
      continue;
    }

    try {
      await extractEntity(db, e.entity_type, e.entity_id, cache.raw_text);
      extracted++;
    } catch (err) {
      failed++;
      const msg = (err as Error).message;
      console.error(`  Failed to extract ${name}: ${msg}`);
      setPipelineStatus(db, e.entity_type, e.entity_id, "failed", msg);
    }
  }

  console.log(`\nExtraction complete: ${extracted} extracted, ${failed} failed.`);
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
