// ─── Shared requirement signal matching ────────────────────────────────────────
// Single source of truth for all tech alias matching used across:
//   - search/route.ts  (snippet scoring, source gate, provisional scoring)
//   - fetch-priority.ts (fetch priority calculation)
//
// Add new tools/frameworks here ONCE and both consumers benefit automatically.

export type AliasEntry = [RegExp, string[]];

// ─── NZ Scarce Skill Table ─────────────────────────────────────────────────────
// Skills with a thin NZ talent pool that have genuinely transferable adjacent
// skills. The AI is told about this list explicitly so "scarce" notes are
// deterministic rather than guessed from training data.
// Each entry: { match (regex), label (display name), alternatives, note }
// Edit this table — not the prompt — to change what triggers a Talent Pool tip.

export interface ScarceSkillEntry {
  match: RegExp;
  label: string;
  alternatives: string[];
  note: string;
}

export const NZ_SCARCE_SKILLS: ScarceSkillEntry[] = [
  {
    match: /\bsybase\b/i,
    label: "Sybase",
    alternatives: ["SQL Server", "Oracle", "MySQL"],
    note: "Sybase practitioners are extremely rare in NZ — SQL Server DBAs and Oracle developers share the same relational fundamentals and can typically ramp up quickly on Sybase ASE.",
  },
  {
    match: /\bdb2\b/i,
    label: "DB2",
    alternatives: ["Oracle", "SQL Server", "PostgreSQL"],
    note: "DB2 expertise is scarce in NZ — Oracle and SQL Server professionals are the closest adjacent pool.",
  },
  {
    match: /\bc\+\+/i,
    label: "C++",
    alternatives: ["C", "Rust"],
    note: "C++ talent pools are thin in NZ — engineers with strong C or Rust backgrounds share the same systems-programming fundamentals and can typically ramp up quickly.",
  },
  {
    match: /\bembedded c\b|\bbare[- ]metal\b|\bfirmware\b/i,
    label: "Embedded C / Firmware",
    alternatives: ["C++", "Rust"],
    note: "Embedded / firmware engineers are scarce in NZ — C++ or Rust developers with low-level systems experience often transfer well.",
  },
  {
    match: /\bcuda\b|\bgpu programming\b|\bopencl\b/i,
    label: "CUDA / GPU Programming",
    alternatives: ["C++"],
    note: "GPU/CUDA specialists are rare in NZ — strong C++ engineers from HPC or graphics backgrounds are the closest transferable pool.",
  },
  {
    match: /\bhaskell\b/i,
    label: "Haskell",
    alternatives: ["Scala", "F#", "Clojure"],
    note: "Haskell developers are extremely rare in NZ — engineers from Scala, F#, or other typed-functional languages share the core paradigm.",
  },
  {
    match: /\berlang\b|\belixir\b/i,
    label: "Erlang / Elixir",
    alternatives: ["Elixir", "Erlang", "Go"],
    note: "Erlang/Elixir practitioners are scarce in NZ — concurrent-systems engineers from Go or adjacent functional backgrounds often adapt quickly.",
  },
  {
    match: /\bfortran\b/i,
    label: "Fortran",
    alternatives: ["C++", "Python"],
    note: "Fortran is nearly extinct in NZ — C++ or Python engineers from scientific computing or numerical analysis are the practical alternative.",
  },
  {
    match: /\bcobol\b/i,
    label: "COBOL",
    alternatives: ["Java", "PL/SQL"],
    note: "COBOL developers are extremely scarce in NZ — mainframe-literate Java developers or experienced PL/SQL engineers are the closest available pool.",
  },
  {
    match: /\bsap\b(?!.*hana)|\bsap abap\b|\babap\b/i,
    label: "SAP / ABAP",
    alternatives: ["SAP HANA", "Java"],
    note: "Certified SAP/ABAP developers are rare in NZ — consider SAP HANA specialists or Java enterprise engineers with ERP exposure.",
  },
  {
    match: /\bassembly\b|\basm\b|\bx86\b|\barm assembly\b/i,
    label: "Assembly",
    alternatives: ["C", "C++", "Rust"],
    note: "Assembly expertise is extremely rare in NZ — C or C++ engineers with low-level systems or embedded experience are the realistic adjacent pool.",
  },
];

// Serialise the table into a compact text block for prompt injection.
// The AI is instructed to match against this list rather than guess.
export function buildScarceSkillsPromptBlock(): string {
  return NZ_SCARCE_SKILLS.map((e) =>
    `- ${e.label} → ${e.alternatives.join(", ")}: "${e.note}"`
  ).join("\n");
}

// Maps a requirement pattern to the terms a matching candidate would have
// in their profile headline or snippet. Ordered broad → specific so that
// more specific patterns take precedence when both match.
export const TECH_REQUIREMENT_ALIASES: AliasEntry[] = [
  // ── Databases ──────────────────────────────────────────────────────────────
  [/\bsql\b|\brelational database\b|\brdbms\b|\bt-sql\b|\btsql\b|\bpl\/sql\b|\bplsql\b/i, ["sql", "database", "relational database", "rdbms"]],
  [/\bmysql\b/i,                                    ["mysql", "sql", "database"]],
  [/\bpostgresql\b|\bpostgres\b/i,                  ["postgresql", "postgres", "sql", "database"]],
  [/\bsybase\b/i,                                   ["sybase", "sql"]],
  [/\boracle\b/i,                                   ["oracle", "sql", "database"]],
  [/\bsql server\b|\bmssql\b/i,                     ["sql server", "mssql", "sql"]],
  [/\bmongodb\b|\bmongo\b/i,                        ["mongodb", "mongo", "nosql"]],
  [/\bredis\b/i,                                    ["redis"]],
  [/\belasticsearch\b|\belastic\b|\belk\b/i,        ["elasticsearch", "elk"]],
  [/\bdb2\b/i,                                      ["db2", "sql"]],
  [/\bsnowflake\b/i,                                ["snowflake", "data warehouse"]],
  [/\bdynamodb\b/i,                                 ["dynamodb", "aws"]],
  // ── Languages ──────────────────────────────────────────────────────────────
  [/\bc\+\+/i,                                      ["c++", "cpp"]],
  [/\.net\b|asp\.net/i,                             [".net", "asp.net", "dotnet"]],
  [/\bc#/i,                                         ["c#", ".net"]],
  [/\bjava\b/i,                                     ["java"]],
  [/\bpython\b/i,                                   ["python"]],
  [/\bruby\b|\brails\b|\bror\b/i,                   ["ruby", "rails", "ruby on rails"]],
  [/\bphp\b/i,                                      ["php"]],
  [/\btypescript\b/i,                               ["typescript"]],
  [/\bjavascript\b|\bjs\b/i,                        ["javascript", "js"]],
  [/\bswift\b/i,                                    ["swift", "ios"]],
  [/\bkotlin\b/i,                                   ["kotlin", "android"]],
  [/\bscala\b/i,                                    ["scala"]],
  [/\bgolang\b|\bgo\b/i,                            ["golang", "go"]],
  [/\brust\b/i,                                     ["rust"]],
  [/\bcobol\b/i,                                    ["cobol"]],
  [/\bperl\b/i,                                     ["perl"]],
  [/\bbash\b|\bshell script/i,                      ["bash", "shell", "scripting"]],
  [/\blinux\b|\bunix\b/i,                           ["linux", "unix"]],
  // ── Web frameworks ─────────────────────────────────────────────────────────
  [/\breact\b/i,                                    ["react", "react.js"]],
  [/\bangular\b/i,                                  ["angular"]],
  [/\bvue\b/i,                                      ["vue", "vue.js"]],
  [/\bnext\.?js\b/i,                                ["next.js", "nextjs", "react"]],
  [/\bnode\.?js\b/i,                                ["node.js", "nodejs", "node"]],
  [/\bdjango\b/i,                                   ["django", "python"]],
  [/\bflask\b/i,                                    ["flask", "python"]],
  [/\bspring\b/i,                                   ["spring", "spring boot", "java"]],
  [/\blaravel\b/i,                                  ["laravel", "php"]],
  [/front.?end/i,                                   ["front-end", "frontend", "html", "css", "javascript", "react"]],
  [/back.?end/i,                                    ["back-end", "backend", "php", "node", "python", "rails", ".net", "java"]],
  [/full.?stack/i,                                  ["full-stack", "full stack", "frontend", "backend"]],
  // ── Infrastructure / DevOps ────────────────────────────────────────────────
  [/\bkubernetes\b|\bk8s\b|\baks\b|\beks\b/i,       ["kubernetes", "k8s"]],
  [/\bdocker\b|\bcontaineris/i,                     ["docker", "container"]],
  [/\bazure\b/i,                                    ["azure", "cloud"]],
  [/\baws\b|amazon web services/i,                  ["aws", "amazon", "cloud"]],
  [/\bgcp\b|google cloud/i,                         ["gcp", "google cloud"]],
  [/\bgit\b|\bgithub\b|\bgitlab\b/i,                ["git", "github", "gitlab"]],
  [/\bterraform\b/i,                                ["terraform", "infrastructure as code"]],
  [/\bansible\b/i,                                  ["ansible"]],
  [/\bjenkins\b/i,                                  ["jenkins", "ci/cd"]],
  [/\bci\/cd\b|continuous integration|continuous deployment/i, ["ci/cd", "devops"]],
  [/\bmicroservices?\b/i,                           ["microservices"]],
  [/\brest\b|\brestful\b|\bapi\b/i,                 ["rest", "api", "restful"]],
  [/\bgraphql\b/i,                                  ["graphql", "api"]],
  // ── Cloud / data / analytics ───────────────────────────────────────────────
  [/\bpower bi\b/i,                                 ["power bi", "bi", "data visualisation"]],
  [/\btableau\b/i,                                  ["tableau", "bi", "data visualisation"]],
  [/\blooker\b/i,                                   ["looker", "bi"]],
  [/\bspark\b/i,                                    ["spark", "big data"]],
  [/\bairflow\b/i,                                  ["airflow", "data pipeline"]],
  [/\bdbt\b/i,                                      ["dbt", "data transformation"]],
  // ── Business / ERP / CRM ──────────────────────────────────────────────────
  [/\bsalesforce\b/i,                               ["salesforce", "crm"]],
  [/\bservicenow\b/i,                               ["servicenow", "itsm"]],
  [/\bsap\b/i,                                      ["sap", "erp"]],
  [/\bdynamics\b/i,                                 ["dynamics", "microsoft dynamics", "crm"]],
  [/\bxero\b/i,                                     ["xero", "accounting"]],
  [/\bmyob\b/i,                                     ["myob", "accounting"]],
  [/\bjira\b/i,                                     ["jira", "agile"]],
  [/\bconfluence\b/i,                               ["confluence"]],
  // ── Testing / QA ──────────────────────────────────────────────────────────
  [/\bperformance test|load test|jmeter|loadrunner|gatling|neoload\b/i, ["performance testing", "jmeter", "loadrunner"]],
  [/\bselenium\b/i,                                 ["selenium", "test automation"]],
  [/\bcypress\b/i,                                  ["cypress", "test automation"]],
  [/\bplaywright\b/i,                               ["playwright", "test automation"]],
  // ── Methodologies ─────────────────────────────────────────────────────────
  [/\bagile\b|\bscrum\b|\bkanban\b/i,               ["agile", "scrum"]],
  [/\bitil\b|\bitsm\b|service management/i,         ["itil", "itsm", "service management"]],
  [/\bdevops\b/i,                                   ["devops"]],
  // ── Security ──────────────────────────────────────────────────────────────
  [/security clearance|secret vetting|confidential vetting/i, ["security clearance"]],
  [/\biso 27001\b|\bsoc 2\b|\bpci\b/i,             ["iso 27001", "security compliance"]],
  // ── Design ────────────────────────────────────────────────────────────────
  [/\bfigma\b/i,                                    ["figma", "design"]],
  [/\bsketch\b/i,                                   ["sketch", "design"]],
  [/\badobe\b/i,                                    ["adobe", "creative"]],
  [/\bux\b|user experience/i,                       ["ux", "user experience", "ui/ux"]],
  [/web design|design principle|digital design/i,   ["web design", "designer", "ui/ux"]],
  // ── CMS / ecommerce ───────────────────────────────────────────────────────
  [/\bwordpress\b|content management system|\bcms\b/i, ["wordpress", "cms"]],
  [/\bshopify\b/i,                                  ["shopify", "ecommerce"]],
  [/\bsquarespace\b/i,                              ["squarespace"]],
  // ── Domain / industry ─────────────────────────────────────────────────────
  [/\bbanking\b|payments?|lending|core banking|financial services|fintech/i, ["banking", "payments", "financial services"]],
];

// Used by the source gate: terms distinctive enough that a candidate who
// doesn't mention them in a snippet is unlikely to match the role.
// Rules for inclusion:
//   ✓ Specific named technology or tool (React, JMeter, Salesforce)
//   ✓ Technical language/platform that narrows the candidate pool meaningfully
//   ✗ Generic business terms that appear on most profiles (banking, microservices)
//   ✗ Duplicate entries
//   ✗ Technology already covered by a more specific entry
// Skills used as a source-gate filter: if a role has ANY of these, only candidates
// whose searchable text contains at least one are imported. Keep this list to
// genuinely rare/distinctive requirements — common terms (SQL, Java, Python, Linux,
// Azure, React) are intentionally absent because they appear on too many unrelated
// profiles and would let completely wrong candidates pass the gate.
export const DISTINCTIVE_REQUIREMENT_ALIASES: AliasEntry[] = [
  // Legacy / rare databases — rare enough to be distinctive
  [/\bsybase\b/i,                                       ["Sybase"]],
  [/\bcobol\b/i,                                        ["COBOL"]],
  [/\bmainframe\b|\bas400\b/i,                          ["mainframe"]],
  [/\bdb2\b/i,                                          ["DB2"]],
  [/\bsnowflake\b/i,                                    ["Snowflake"]],
  // Specific database platforms (named, not generic "SQL")
  [/\boracle\b/i,                                       ["Oracle"]],
  [/\bsql server\b|\bmssql\b/i,                         ["SQL Server"]],
  [/\bpostgresql\b|\bpostgres\b/i,                      ["PostgreSQL"]],
  [/\bmysql\b/i,                                        ["MySQL"]],
  // Languages — only include those genuinely rare in NZ / strongly distinctive
  [/\bc\+\+/i,                                          ["C++"]],
  [/\bruby\b|\brails\b/i,                               ["Ruby"]],
  [/\bscala\b/i,                                        ["Scala"]],
  [/\bkotlin\b/i,                                       ["Kotlin"]],
  [/\bswift\b/i,                                        ["Swift"]],
  // Highly specific platforms / frameworks
  [/\bsalesforce\b/i,                                   ["Salesforce"]],
  [/\bservicenow\b/i,                                   ["ServiceNow"]],
  [/\bsap\b/i,                                          ["SAP"]],
  [/\bmicrosoft dynamics\b|\bdynamics 365\b|\bms dynamics\b/i, ["Dynamics 365"]], // tightened — avoids matching "team dynamics"
  [/\bworkday\b/i,                                      ["Workday"]],
  [/\bnetsuite\b|\boracle netsuite\b/i,                  ["NetSuite"]],
  [/\boracle e.?business\b|\boracle ebs\b/i,             ["Oracle EBS"]],
  // Analytics / BI
  [/\bpower bi\b/i,                                     ["Power BI"]],
  [/\btableau\b/i,                                      ["Tableau"]],
  [/\blooker\b/i,                                       ["Looker"]],
  // Testing
  [/\bperformance test|load test|jmeter|loadrunner|gatling|neoload\b/i, ["JMeter"]],
  [/\bselenium\b/i,                                     ["Selenium"]],
  // Compliance / clearance
  [/\bitil\b|\bitsm\b/i,                                ["ITIL"]],
  [/security clearance|secret vetting|confidential vetting/i, ["security clearance"]],
  // Agile roles — only as DISTINCTIVE when Agile/Scrum is the primary skill, not a nice-to-have.
  // Narrow patterns to avoid gating all candidates on "works in an Agile environment".
  [/\bscrum master\b|\bagile coach\b|\bsafe practitioner\b|\bsafe (agilist|coach|scrum master)\b/i, ["Scrum Master"]],
  // Design
  [/\bfigma\b/i,                                        ["Figma"]],
  [/\bux\b|user experience/i,                           ["UX"]],
];

// Words that appear in requirement text but provide no useful candidate signal.
// Kept here so both consumers share the same suppression list.
export const REQUIREMENT_STOP_WORDS = new Set([
  // Generic English
  "ability","across","and","any","based","build","building","candidate",
  "comfortable","commitment","development","driven","experience","good",
  "have","including","knowledge","mindset","must","new","principles",
  "professional","proficiency","required","role","solid","strong",
  "understanding","using","with","work","working","years",
  "for","its","their","that","this","are","the",
  // Generic qualifiers / parenthetical notes
  "critical","preferred","essential","desirable","mandatory","optional",
  "excellent","proven","demonstrated","relevant","ideally","exposure",
  "familiarity","passionate","highly","focused",
  // Broad tech/business nouns
  "enterprise","platforms","platform","solutions","solution","systems",
  "technology","technologies","stacks","modern","similar","grade",
  "server","ase","suite","environment","environments","framework",
  "frameworks","tools","tool","applications","application","services",
  "service","infrastructure","processes","process","pipeline","pipelines",
  "lifecycle","stack","codebase","architecture",
  "management","power","bus","querying","analysis","performance",
  "test","testing","automation","automated","unit",
  "data","cloud","digital","software","technical",
  "engineering","engineer","developer","developers",
  // Soft-skill / behavioral phrases
  "designing","delivering","supporting","optimising","optimizing",
  "maintaining","ensuring","implementing","managing","building",
  "developing","leading","driving","owning","collaborating",
  "communicating","stakeholder","stakeholders","communication","skills",
  "skill","team","player","proactive","collaborative","self",
  "motivated","attention","detail","problem","solving","analytical",
  "initiative","ownership","delivery","track","record",
  // Scale/complexity qualifiers
  "scale","scalable","large","complex","mission","cross",
  "functional","end","high","quality","best","practices",
  "practice","world","class","real","hands",
  // Temporal / quantitative
  "months","least","minimum","plus","graduate",
]);

/**
 * Extract the specific tech/skill signals from a single requirement string.
 * Returns up to 8 terms — these are what we look for in a candidate's snippet/profile.
 *
 * Alias matching handles known hard-skill phrases, while tokenisation keeps
 * genuinely specific future terms visible until we add first-class aliases.
 */
export function extractSignalsFromRequirement(requirement: string): string[] {
  const signals = new Set<string>();

  for (const [pattern, aliases] of TECH_REQUIREMENT_ALIASES) {
    if (pattern.test(requirement)) aliases.forEach((a) => signals.add(a));
  }

  const tokens = requirement.toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g) ?? [];
  for (const token of tokens) {
    if (!REQUIREMENT_STOP_WORDS.has(token)) signals.add(token);
  }

  return [...signals].slice(0, 8);
}

export function extractDistinctiveSignalsFromRequirement(requirement: string): string[] {
  const signals = new Set<string>();
  for (const [pattern, aliases] of DISTINCTIVE_REQUIREMENT_ALIASES) {
    if (pattern.test(requirement)) aliases.forEach((alias) => signals.add(alias));
  }
  return [...signals];
}

// Patterns for technologies rare enough to be used as hard search anchors in the
// legacy fallback path (roles parsed before anchor_terms was added).
// Deliberately narrow: common tech like Azure, .NET, SQL is NOT listed here because
// it appears on 30-50% of profiles and should not gate a specialist search.
const RARE_ANCHOR_PATTERNS: Array<[RegExp, string]> = [
  [/\bc\+\+/i,                                               "C++"],
  [/\bsybase\b/i,                                            "Sybase"],
  [/\bcobol\b/i,                                             "COBOL"],
  [/\bmainframe\b|\bas400\b|\bos\/400\b|\bibm i\b/i,         "mainframe"],
  [/\bdelphi\b|\bpascal\b/i,                                 "Delphi"],
  [/\bjmeter\b|\bloadrunner\b|\bgatling\b|\bneoload\b/i,     "JMeter"],
  [/\bsap\b/i,                                               "SAP"],
  [/\bservicenow\b/i,                                        "ServiceNow"],
  [/\bsalesforce\b/i,                                        "Salesforce"],
  [/security clearance|secret vetting|confidential vetting/i,"security clearance"],
  [/\bdb2\b/i,                                               "DB2"],
  [/\boracle forms\b|\bplsql\b|\bpl\/sql\b/i,                "PL/SQL"],
];

/**
 * For roles parsed before anchor_terms was added: extract the 2-5 rarest
 * technologies from must-haves to use as search anchors.
 * Only picks up genuinely niche tech — not common tools like Azure, SQL, .NET.
 */
export function extractLegacyAnchorTerms(requirements: string[]): string[] {
  const terms = new Set<string>();
  const combined = requirements.join("\n");
  for (const [pattern, term] of RARE_ANCHOR_PATTERNS) {
    if (pattern.test(combined)) terms.add(term);
  }
  return [...terms].slice(0, 5);
}

export function normalizeSignalText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * When a search returns 0 results, build substitute query strings by replacing
 * scarce/rare anchor terms with their adjacent-skill alternatives.
 *
 * Example: anchors ["C++", "Sybase", "AKS"]
 *   → Sybase matches NZ_SCARCE_SKILLS → substitutes: SQL Server, Oracle, MySQL
 *   → returns ["C++ SQL Server AKS", "C++ Oracle AKS", "C++ MySQL developer"]
 *
 * Only substitutes ONE scarce term at a time — replacing all scarce anchors
 * simultaneously would produce queries so generic they'd flood the list with noise.
 */
export function buildScarceSkillFallbackQueries(anchorTerms: string[]): string[] {
  if (anchorTerms.length === 0) return [];

  const queries: string[] = [];

  for (let i = 0; i < anchorTerms.length; i++) {
    const term = anchorTerms[i];
    const match = NZ_SCARCE_SKILLS.find((e) => e.match.test(term));
    if (!match) continue;

    const others = anchorTerms.filter((_, j) => j !== i);
    for (const alt of match.alternatives.slice(0, 3)) {
      const parts = others.length > 0 ? [...others, alt] : [alt, "developer"];
      queries.push(parts.join(" "));
    }
    // Only substitute the first matching scarce term — keeps queries specific
    break;
  }

  return queries.slice(0, 4);
}

/**
 * Word-boundary aware term presence check.
 * Short tokens (≤4 chars) use word boundaries to prevent false positives
 * e.g. "sql" must not match "nosql", "css" must not match "access".
 */
export function signalMatchesText(text: string, signal: string): boolean {
  const haystack = normalizeSignalText(text);
  const needle = normalizeSignalText(signal);
  if (!needle) return false;
  if (needle.length <= 4) {
    return new RegExp(
      `(?:^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`
    ).test(haystack);
  }
  return haystack.includes(needle);
}
