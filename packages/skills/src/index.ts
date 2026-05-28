/**
 * @recruitme/skills — NZ IT Skills Taxonomy Graph
 *
 * A directed graph of technology skill relationships curated for the
 * New Zealand IT recruitment market. Edges represent:
 *   - equivalent: skills that satisfy the same requirement
 *   - implies: having skill A implies you also have skill B
 *   - related_to: skills in the same domain / often used together
 *
 * Copyright (c) RecruitMe Ltd. All rights reserved.
 * This taxonomy represents 3+ years of NZ IT market knowledge.
 */

export type EdgeType = "equivalent" | "implies" | "related_to";

export interface SkillEdge {
  from: string;
  to: string;
  type: EdgeType;
  weight?: number; // 0-1, defaults to 1.0 for equivalent, 0.8 for implies, 0.5 for related_to
}

export interface ScarceSkill {
  skill: string;
  label: string;
  alternatives: string[];
  note: string;
  market: "NZ" | "AU" | "global";
}

// ── Skill edges ────────────────────────────────────────────────────────────────
export const SKILL_EDGES: SkillEdge[] = [
  // Equivalents (bidirectional by convention)
  { from: "kubernetes",             to: "k8s",                    type: "equivalent" },
  { from: "k8s",                    to: "kubernetes",              type: "equivalent" },
  { from: "amazon web services",    to: "aws",                    type: "equivalent" },
  { from: "aws",                    to: "amazon web services",    type: "equivalent" },
  { from: "azure",                  to: "microsoft azure",        type: "equivalent" },
  { from: "microsoft azure",        to: "azure",                  type: "equivalent" },
  { from: "google cloud platform",  to: "gcp",                    type: "equivalent" },
  { from: "gcp",                    to: "google cloud platform",  type: "equivalent" },
  { from: ".net",                   to: "dotnet",                 type: "equivalent" },
  { from: "dotnet",                 to: ".net",                   type: "equivalent" },
  { from: "node.js",                to: "nodejs",                 type: "equivalent" },
  { from: "nodejs",                 to: "node.js",                type: "equivalent" },
  { from: "postgresql",             to: "postgres",               type: "equivalent" },
  { from: "postgres",               to: "postgresql",             type: "equivalent" },
  { from: "mongo",                  to: "mongodb",                type: "equivalent" },
  { from: "mongodb",                to: "mongo",                  type: "equivalent" },
  { from: "js",                     to: "javascript",             type: "equivalent" },
  { from: "javascript",             to: "js",                     type: "equivalent" },
  { from: "ts",                     to: "typescript",             type: "equivalent" },
  { from: "typescript",             to: "ts",                     type: "equivalent" },
  { from: "py",                     to: "python",                 type: "equivalent" },
  { from: "python",                 to: "py",                     type: "equivalent" },

  // TypeScript implies JavaScript
  { from: "typescript",             to: "javascript",             type: "implies",    weight: 1.0 },

  // Spring Boot implies Java
  { from: "spring boot",            to: "java",                   type: "implies",    weight: 1.0 },
  { from: "spring",                 to: "java",                   type: "implies",    weight: 0.9 },

  // .NET implies C#
  { from: ".net",                   to: "c#",                     type: "implies",    weight: 0.9 },
  { from: "asp.net",                to: "c#",                     type: "implies",    weight: 1.0 },

  // React implies JavaScript/TypeScript
  { from: "react",                  to: "javascript",             type: "implies",    weight: 1.0 },
  { from: "next.js",                to: "react",                  type: "implies",    weight: 1.0 },
  { from: "nextjs",                 to: "react",                  type: "implies",    weight: 1.0 },

  // Vue/Angular imply JavaScript
  { from: "vue",                    to: "javascript",             type: "implies",    weight: 1.0 },
  { from: "vue.js",                 to: "javascript",             type: "implies",    weight: 1.0 },
  { from: "angular",                to: "typescript",             type: "implies",    weight: 0.9 },

  // Terraform/Pulumi imply IaC
  { from: "terraform",              to: "infrastructure as code", type: "implies",    weight: 1.0 },
  { from: "pulumi",                 to: "infrastructure as code", type: "implies",    weight: 1.0 },

  // Docker implies containers
  { from: "docker",                 to: "containers",             type: "implies",    weight: 1.0 },
  { from: "kubernetes",             to: "docker",                 type: "implies",    weight: 0.9 },

  // GitLab CI / GitHub Actions imply CI/CD
  { from: "github actions",         to: "ci/cd",                  type: "implies",    weight: 1.0 },
  { from: "gitlab ci",              to: "ci/cd",                  type: "implies",    weight: 1.0 },
  { from: "jenkins",                to: "ci/cd",                  type: "implies",    weight: 1.0 },

  // Related (same domain)
  { from: "aws",                    to: "azure",                  type: "related_to", weight: 0.5 },
  { from: "aws",                    to: "gcp",                    type: "related_to", weight: 0.5 },
  { from: "react",                  to: "vue",                    type: "related_to", weight: 0.5 },
  { from: "react",                  to: "angular",                type: "related_to", weight: 0.4 },
  { from: "postgresql",             to: "mysql",                  type: "related_to", weight: 0.6 },
  { from: "postgresql",             to: "sql server",             type: "related_to", weight: 0.5 },
  { from: "redis",                  to: "memcached",              type: "related_to", weight: 0.5 },
  { from: "kafka",                  to: "rabbitmq",               type: "related_to", weight: 0.5 },
  { from: "elasticsearch",          to: "opensearch",             type: "related_to", weight: 0.7 },
  { from: "pandas",                 to: "numpy",                  type: "related_to", weight: 0.6 },
  { from: "pytorch",                to: "tensorflow",             type: "related_to", weight: 0.5 },

  // NZ market specifics: Xero/MYOB as accounting platform equivalents
  { from: "xero",                   to: "myob",                   type: "related_to", weight: 0.6 },
  { from: "myob",                   to: "xero",                   type: "related_to", weight: 0.6 },
];

// ── NZ scarce skills ──────────────────────────────────────────────────────────
export const NZ_SCARCE_SKILLS: ScarceSkill[] = [
  {
    skill: "sybase",
    label: "Sybase",
    alternatives: ["SQL Server", "Oracle", "PostgreSQL"],
    note: "Sybase practitioners are extremely rare in NZ. SQL Server DBAs and Oracle developers share relational fundamentals.",
    market: "NZ",
  },
  {
    skill: "db2",
    label: "IBM DB2",
    alternatives: ["Oracle", "SQL Server", "PostgreSQL"],
    note: "DB2 expertise is scarce in NZ. Oracle and SQL Server professionals are the closest adjacent pool.",
    market: "NZ",
  },
  {
    skill: "snowflake",
    label: "Snowflake",
    alternatives: ["BigQuery", "Redshift", "Azure Synapse"],
    note: "Snowflake specialists are thin in NZ. Engineers with BigQuery, Redshift, or Azure Synapse experience share cloud data warehouse fundamentals.",
    market: "NZ",
  },
  {
    skill: "dbt",
    label: "dbt (data build tool)",
    alternatives: ["Fivetran", "ELT pipelines", "data engineering"],
    note: "dbt practitioners are a small but growing pool in NZ.",
    market: "NZ",
  },
  {
    skill: "splunk",
    label: "Splunk / SIEM",
    alternatives: ["Microsoft Sentinel", "Elastic SIEM", "QRadar"],
    note: "Splunk/QRadar specialists are scarce in NZ. Microsoft Sentinel engineers cover the same threat-detection fundamentals.",
    market: "NZ",
  },
  {
    skill: "cobol",
    label: "COBOL",
    alternatives: ["mainframe development", "PL/I"],
    note: "COBOL is effectively sunset-pool in NZ — fewer than 50 active practitioners estimated.",
    market: "NZ",
  },
];

// ── Graph query helpers ────────────────────────────────────────────────────────

const _edgesByFrom = new Map<string, SkillEdge[]>();
for (const edge of SKILL_EDGES) {
  const k = edge.from.toLowerCase();
  if (!_edgesByFrom.has(k)) _edgesByFrom.set(k, []);
  _edgesByFrom.get(k)!.push(edge);
}

/** Return all skills that are equivalent to the given skill. */
export function getEquivalents(skill: string): string[] {
  const key = skill.toLowerCase();
  return (_edgesByFrom.get(key) ?? [])
    .filter((e) => e.type === "equivalent")
    .map((e) => e.to);
}

/** Return all skills implied by the given skill (i.e. skill → requires these). */
export function getImplied(skill: string): string[] {
  const key = skill.toLowerCase();
  return (_edgesByFrom.get(key) ?? [])
    .filter((e) => e.type === "implies")
    .map((e) => e.to);
}

/** Return related skills (same domain cluster). */
export function getRelated(skill: string): string[] {
  const key = skill.toLowerCase();
  return (_edgesByFrom.get(key) ?? [])
    .filter((e) => e.type === "related_to")
    .map((e) => e.to);
}

/**
 * Check whether a candidate skill satisfies a required skill via the graph.
 * Returns { satisfied, via, weight } where weight reflects match confidence.
 */
export function satisfies(
  candidateSkill: string,
  requiredSkill: string,
): { satisfied: boolean; via: EdgeType | "direct"; weight: number } {
  const c = candidateSkill.toLowerCase();
  const r = requiredSkill.toLowerCase();

  if (c === r) return { satisfied: true, via: "direct", weight: 1.0 };

  const edges = _edgesByFrom.get(c) ?? [];
  for (const edge of edges) {
    if (edge.to.toLowerCase() === r) {
      return {
        satisfied: true,
        via: edge.type,
        weight: edge.weight ?? (edge.type === "equivalent" ? 1.0 : edge.type === "implies" ? 0.8 : 0.5),
      };
    }
  }

  return { satisfied: false, via: "direct", weight: 0 };
}

/** Look up NZ scarce skill info for a given skill name. */
export function getNzScarceSkill(skill: string): ScarceSkill | undefined {
  const key = skill.toLowerCase();
  return NZ_SCARCE_SKILLS.find((s) => s.skill.toLowerCase() === key);
}
