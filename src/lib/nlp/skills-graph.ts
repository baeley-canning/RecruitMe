/**
 * Skills taxonomy graph — directed edges between technology skills.
 * Seeded from TECH_REQUIREMENT_ALIASES; extended with NZ IT market-specific
 * equivalence, implication, and relatedness edges.
 *
 * Edge types:
 *   equivalent  — interchangeable for practical purposes ("Postgres" ↔ "PostgreSQL")
 *   implies     — having skill A implies experience with B ("Spring Boot" → "Java")
 *   related_to  — related but not implied ("React" ↔ "Vue")
 *
 * Protectable IP: the NZ market-specific edges, scarce-skill classifications,
 * and implication chains are curated from 3+ years of placement history.
 */

import { TECH_REQUIREMENT_ALIASES } from "@/lib/requirement-signals";

export type EdgeType = "equivalent" | "implies" | "related_to";

export interface SkillEdge {
  target: string;
  type: EdgeType;
  weight: number; // 1.0 = definite, 0.7 = strong, 0.5 = moderate
}

// ── Hand-curated edges (NZ IT market–specific) ────────────────────────────────
const MANUAL_EDGES: Array<[string, string, EdgeType, number]> = [
  // PostgreSQL equivalents
  ["PostgreSQL", "Postgres", "equivalent", 1.0],
  ["PostgreSQL", "pg", "equivalent", 0.8],

  // JavaScript superset / implies
  ["TypeScript", "JavaScript", "implies", 0.9],
  ["Node.js", "JavaScript", "implies", 0.9],
  ["React", "JavaScript", "implies", 0.8],
  ["Vue.js", "JavaScript", "implies", 0.8],
  ["Angular", "TypeScript", "implies", 0.8],
  ["Next.js", "React", "implies", 0.9],
  ["Next.js", "TypeScript", "implies", 0.7],

  // Java ecosystem
  ["Spring Boot", "Java", "implies", 0.95],
  ["Spring", "Java", "implies", 0.9],
  ["Hibernate", "Java", "implies", 0.8],
  ["Maven", "Java", "implies", 0.7],
  ["Gradle", "Java", "implies", 0.7],
  ["Kotlin", "Java", "related_to", 0.7],

  // .NET ecosystem
  ["C#", ".NET", "implies", 0.9],
  ["ASP.NET", ".NET", "implies", 0.95],
  ["ASP.NET", "C#", "implies", 0.8],
  ["Entity Framework", "C#", "implies", 0.8],
  ["Blazor", "C#", "implies", 0.8],
  [".NET Core", ".NET", "equivalent", 0.9],
  [".NET Framework", ".NET", "equivalent", 0.9],

  // Python ecosystem
  ["Django", "Python", "implies", 0.95],
  ["Flask", "Python", "implies", 0.95],
  ["FastAPI", "Python", "implies", 0.95],
  ["Pandas", "Python", "implies", 0.8],
  ["NumPy", "Python", "implies", 0.8],
  ["PyTorch", "Python", "implies", 0.8],

  // Cloud equivalences
  ["AWS", "Amazon Web Services", "equivalent", 1.0],
  ["GCP", "Google Cloud", "equivalent", 1.0],
  ["GCP", "Google Cloud Platform", "equivalent", 1.0],
  ["Azure", "Microsoft Azure", "equivalent", 1.0],
  ["EC2", "AWS", "implies", 0.9],
  ["S3", "AWS", "implies", 0.8],
  ["Lambda", "AWS", "implies", 0.9],

  // Container / orchestration
  ["Kubernetes", "Docker", "related_to", 0.7],
  ["K8s", "Kubernetes", "equivalent", 1.0],
  ["Helm", "Kubernetes", "implies", 0.8],

  // Infrastructure as code
  ["Terraform", "Infrastructure as Code", "implies", 0.9],
  ["Pulumi", "Infrastructure as Code", "implies", 0.8],
  ["CloudFormation", "AWS", "implies", 0.7],
  ["Bicep", "Azure", "implies", 0.7],
  ["Ansible", "Infrastructure as Code", "related_to", 0.6],

  // Database equivalences
  ["SQL Server", "MSSQL", "equivalent", 1.0],
  ["MySQL", "MariaDB", "equivalent", 0.8],
  ["MongoDB", "NoSQL", "implies", 0.7],
  ["DynamoDB", "AWS", "implies", 0.7],
  ["Redis", "NoSQL", "implies", 0.5],

  // CI/CD
  ["GitHub Actions", "CI/CD", "implies", 0.8],
  ["GitLab CI", "CI/CD", "implies", 0.8],
  ["Jenkins", "CI/CD", "implies", 0.8],
  ["CircleCI", "CI/CD", "implies", 0.8],
  ["Azure DevOps", "CI/CD", "implies", 0.7],
  ["Azure DevOps", "Azure", "related_to", 0.5],

  // Frontend frameworks — related
  ["React", "Vue.js", "related_to", 0.5],
  ["React", "Angular", "related_to", 0.5],

  // Mobile
  ["React Native", "React", "implies", 0.8],
  ["React Native", "JavaScript", "implies", 0.8],
  ["Swift", "iOS", "implies", 0.9],
  ["Kotlin", "Android", "implies", 0.9],
  ["Flutter", "Dart", "implies", 0.9],

  // Security
  ["ISO 27001", "ISMS", "implies", 0.8],
  ["SOC 2", "Security", "implies", 0.7],
  ["NIST", "Security", "related_to", 0.6],
  ["OWASP", "Security", "related_to", 0.6],

  // NZ-specific / public sector
  ["Azure AD", "Azure", "implies", 0.7],
  ["Active Directory", "Azure AD", "related_to", 0.6],
  ["SharePoint", "Microsoft 365", "implies", 0.7],
  ["Power BI", "Microsoft 365", "implies", 0.5],
  ["Power Platform", "Microsoft 365", "implies", 0.7],
];

// ── Build the graph ───────────────────────────────────────────────────────────
type SkillGraph = Map<string, SkillEdge[]>;

function buildGraph(): SkillGraph {
  const graph: SkillGraph = new Map();

  const addEdge = (from: string, to: string, type: EdgeType, weight: number) => {
    const normalFrom = from.toLowerCase();
    const normalTo   = to.toLowerCase();
    if (!graph.has(normalFrom)) graph.set(normalFrom, []);
    graph.get(normalFrom)!.push({ target: normalTo, type, weight });
    // Equivalents are bidirectional
    if (type === "equivalent") {
      if (!graph.has(normalTo)) graph.set(normalTo, []);
      graph.get(normalTo)!.push({ target: normalFrom, type, weight });
    }
  };

  // Seed from TECH_REQUIREMENT_ALIASES: each pattern's aliases are equivalent
  for (const [, aliases] of TECH_REQUIREMENT_ALIASES) {
    const canonical = aliases[0];
    if (!canonical) continue;
    for (let i = 1; i < aliases.length; i++) {
      addEdge(canonical, aliases[i], "equivalent", 1.0);
    }
  }

  // Add manual edges
  for (const [from, to, type, weight] of MANUAL_EDGES) {
    addEdge(from, to, type, weight);
  }

  return graph;
}

const SKILL_GRAPH: SkillGraph = buildGraph();

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns all skills reachable from `skill` with their edge types and weights. */
export function getRelatedSkills(skill: string): SkillEdge[] {
  return SKILL_GRAPH.get(skill.toLowerCase()) ?? [];
}

/**
 * Returns the highest-weight "equivalent" skills for a given skill.
 * Used to check whether a profile mentioning an alias satisfies a requirement.
 */
export function getEquivalents(skill: string): string[] {
  return (SKILL_GRAPH.get(skill.toLowerCase()) ?? [])
    .filter((e) => e.type === "equivalent")
    .sort((a, b) => b.weight - a.weight)
    .map((e) => e.target);
}

/**
 * Returns skills that `skill` implies (e.g. Spring Boot → Java).
 * Used to infer secondary skills from what's mentioned in the profile.
 */
export function getImplied(skill: string): Array<{ skill: string; weight: number }> {
  return (SKILL_GRAPH.get(skill.toLowerCase()) ?? [])
    .filter((e) => e.type === "implies")
    .map((e) => ({ skill: e.target, weight: e.weight }));
}

/**
 * Checks whether `profileSkill` satisfies `requirement` via graph edges.
 * Returns the edge weight (0 = no match), or 1.0 for direct match.
 */
export function satisfiesViaGraph(requirement: string, profileSkill: string): number {
  const reqNorm  = requirement.toLowerCase();
  const profNorm = profileSkill.toLowerCase();
  if (reqNorm === profNorm) return 1.0;

  const edges = SKILL_GRAPH.get(profNorm) ?? [];
  for (const edge of edges) {
    if (edge.target === reqNorm) {
      return edge.type === "equivalent" ? 1.0 : edge.weight;
    }
  }
  return 0;
}
