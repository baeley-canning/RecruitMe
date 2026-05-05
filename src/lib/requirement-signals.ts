// ─── Shared requirement signal matching ────────────────────────────────────────
// Single source of truth for all tech alias matching used across:
//   - search/route.ts  (snippet scoring, source gate, provisional scoring)
//   - fetch-priority.ts (fetch priority calculation)
//
// Add new tools/frameworks here ONCE and both consumers benefit automatically.

export type AliasEntry = [RegExp, string[]];

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

export const DISTINCTIVE_REQUIREMENT_ALIASES: AliasEntry[] = [
  [/\bpsybase\b/i, ["Sybase"]],
  [/\bsybase\b/i, ["Sybase"]],
  [/\bsql\b|\brelational database\b|\brdbms\b|\bt-sql\b|\btsql\b/i, ["SQL", "database"]],
  [/\bmysql\b/i, ["MySQL"]],
  [/\bpostgresql\b|\bpostgres\b/i, ["PostgreSQL"]],
  [/\bc\+\+/i, ["C++"]],
  [/\.net|asp\.net|c#/i, [".NET", "C#"]],
  [/\bjava\b/i, ["Java"]],
  [/\bpython\b/i, ["Python"]],
  [/\bangular\b/i, ["Angular"]],
  [/\breact\b/i, ["React"]],
  [/\bnode\.?js\b/i, ["Node.js"]],
  [/\bperformance test|load test|jmeter|loadrunner|gatling|neoload\b/i, ["performance testing", "JMeter", "LoadRunner"]],
  [/\bitil\b|\bitsm\b|service management|incident management|change management|problem management/i, ["ITIL", "ITSM"]],
  [/security clearance|secret vetting|confidential vetting|\bsv\b|\bcv\b|nzsis|defence|defense/i, ["security clearance", "Secret Vetting"]],
  [/\bbanking\b|payments?|lending|core banking|financial services|fintech/i, ["banking", "payments", "financial services"]],
  [/\blinux\b/i, ["Linux"]],
  [/\bazure\b/i, ["Azure"]],
  [/\baws\b|amazon web services/i, ["AWS"]],
  [/\bgcp\b|google cloud/i, ["GCP"]],
  [/\bmicroservices?\b|\bminiservices?\b/i, ["microservices"]],
  [/\bdb2\b/i, ["DB2"]],
  [/\boracle\b/i, ["Oracle"]],
  [/\bsql server\b/i, ["SQL Server"]],
  [/\bsnowflake\b/i, ["Snowflake"]],
  [/\bpower bi\b/i, ["Power BI"]],
  [/\btableau\b/i, ["Tableau"]],
  [/\bmainframe\b/i, ["mainframe"]],
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

export function normalizeSignalText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").replace(/\s+/g, " ").trim();
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
