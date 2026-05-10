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
    match: /\bsnowflake\b/i,
    label: "Snowflake",
    alternatives: ["BigQuery", "Redshift", "Azure Synapse"],
    note: "Snowflake specialists are thin in NZ — engineers with BigQuery, Redshift, or Azure Synapse experience share the same cloud data warehouse fundamentals.",
  },
  {
    match: /\bdbt\b/i,
    label: "dbt",
    alternatives: ["Fivetran", "data pipeline", "ELT"],
    note: "dbt practitioners are a small but growing pool in NZ — data engineers with Fivetran, Airbyte, or ELT pipeline experience can typically adapt quickly.",
  },
  {
    match: /\bsplunk\b|\bqradar\b|\bsiem\b/i,
    label: "SIEM (Splunk/QRadar)",
    alternatives: ["Microsoft Sentinel", "Elastic SIEM", "security operations"],
    note: "Splunk/QRadar specialists are scarce in NZ — Microsoft Sentinel and Elastic SIEM engineers cover the same threat-detection fundamentals.",
  },
  {
    match: /\bpenetration test|\bpentest|\bethical hack/i,
    label: "Penetration Testing",
    alternatives: ["security consultant", "red team", "vulnerability assessment"],
    note: "Dedicated pen testers are rare in NZ — security consultants and red team practitioners cover adjacent offensive security skills.",
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
  {
    match: /\bscada\b|\brtu\b|programmable\s+logic\s+controller/i,
    label: "SCADA / PLC / RTU",
    alternatives: ["industrial automation", "control systems", "process control", "instrumentation"],
    note: "SCADA/PLC/RTU specialists are scarce in NZ — industrial-automation, process-control or control-systems engineers from utilities, manufacturing or oil-and-gas are the closest adjacent pool. Look for Transpower, Mercury, Genesis, Beca or similar.",
  },
  {
    match: /\bmetering\b|\bpower\s+distribution\b|\bhigh[- ]voltage\b|\belectrical\s+engineering\b/i,
    label: "Power / electrical engineering",
    alternatives: ["utilities", "field service engineer", "high voltage", "substation"],
    note: "Power-distribution and HV electrical engineers are a small pool in NZ — field-service engineers from utilities (Transpower, Vector, Powerco) or commissioning engineers are the realistic adjacent pool.",
  },
  {
    match: /\bisms\b|information\s+security\s+governance|iso\s*27001/i,
    label: "ISMS / ISO 27001 governance",
    alternatives: ["GRC", "compliance manager", "risk management", "information security governance"],
    note: "ISMS implementers / ISO 27001 leads are a niche in NZ — GRC, compliance-manager or information-security-governance leads with regulated-industry exposure are the realistic adjacent pool.",
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
  // Bare \bpci\b previously collided with PCI bus / PCIe driver work. Anchor
  // on PCI-DSS so only payment-compliance roles match; SOC 2 and ISO 27001
  // are unambiguous as bare tokens.
  [/\biso 27001\b/i,                                ["iso 27001", "security compliance"]],
  [/\bsoc[- ]?2\b/i,                                ["soc 2", "security compliance"]],
  [/\bpci[- ]?dss\b/i,                              ["pci dss", "security compliance"]],
  [/\bisms\b|information\s+security\s+management\s+system/i, ["isms", "information security governance", "iso 27001"]],
  [/\bgrc\b|governance[,\s]+risk[,\s]+compliance/i, ["grc", "compliance", "risk management"]],
  [/information\s+security\s+governance|security\s+governance/i, ["security governance", "isms"]],
  // ── Industrial / Power / Control systems ──────────────────────────────────
  // SCADA, RTU are rare enough as bare tokens. PLC is NOT — it collides with
  // company suffix "Vodafone PLC". Anchor PLC as a phrase only.
  [/\bscada\b/i,                                    ["scada", "industrial controls", "control systems"]],
  [/\brtu\b|remote\s+terminal\s+unit/i,             ["rtu", "remote terminal unit", "scada"]],
  [/programmable\s+logic\s+controller|\bplc\s+(?:programming|integration|configuration|config|ladder|hmi|scada)/i, ["plc integration", "plc configuration", "programmable logic controller", "industrial controls"]],
  // HMI: allow up to ~30 chars between HMI and a qualifier so "HMI integration
  // with SCADA" matches. Bare "HMI design" still doesn't fire — needs an
  // industrial qualifier nearby to avoid false-positives in UX/UI roles.
  [/\bhmi\b[\w\s]{0,30}?\b(?:scada|industrial|configuration|interface|plc|control)\b|human\s+machine\s+interface/i, ["hmi", "scada", "industrial controls"]],
  // Process control / industrial control: tightened to require an industrial
  // qualifier OR a downstream noun ("system","loop","valve","engineer").
  // The previous regex matched "automated CI/CD process control" in DevOps
  // JDs and "process automation" in RPA roles, which incorrectly flagged
  // those as specialist roles and capped all snippet candidates at 25.
  [/(?:industrial|plant|manufacturing|substation)\s+process\s+(?:control|automation|instrumentation)|process\s+(?:control|instrumentation)\s+(?:engineer|system|loop|valve|equipment)|industrial\s+(?:control\s+system|automation\s+(?:system|engineer|platform))/i, ["industrial controls", "process control"]],
  [/\bmetering\b|smart\s+metering|electricity\s+metering/i, ["metering", "smart metering"]],
  [/\bdata\s+acquisition\b|\bdata\s+logging\b/i,    ["data acquisition", "data logging"]],
  [/\bpower\s+distribution\b|\belectrical\s+distribution\b/i, ["power distribution", "electrical engineering"]],
  // HV: widened to include the canonical substation-engineer phrasings the
  // narrow original missed ("HV equipment", "HV switchgear", "HV substation",
  // "HV commissioning", "HV cable"). Still anchored on a power-context
  // qualifier to avoid generic "HV TV channel" false positives.
  [/high[- ]voltage|\bhv\s+(?:electrical|power|systems?|equipment|switchgear|substation|commissioning|cable|installation|transmission|distribution)\b/i, ["high voltage", "power", "electrical engineering"]],
  [/\belectrical\s+engineering\b|\bpower\s+engineering\b/i, ["electrical engineering", "power systems"]],
  [/\bcommissioning\b|field\s+(?:install|commission|maintenance)/i, ["commissioning", "field installation"]],
  // ── Customer-facing technical sales ────────────────────────────────────────
  [/\btechnical\s+sales\b|\bsales\s+engineer(?:ing)?\b/i, ["technical sales", "sales engineer"]],
  [/\bpre[- ]sales\b|\bpresales\b/i,                ["pre-sales", "presales"]],
  [/\brfp\b|\brfq\b|request\s+for\s+(?:proposal|quote)/i, ["rfp", "rfq", "tendering"]],
  // ── IoT / SaaS / leadership phrases ────────────────────────────────────────
  [/\biot\b|internet\s+of\s+things/i,               ["iot", "connected devices"]],
  [/\bsaas\b\s+(?:platform|solution|product)|software\s+as\s+a\s+service/i, ["saas", "platform"]],
  [/it\s+operations?\s+(?:lead|manager|head|leadership)|head\s+of\s+it\s+operations?/i, ["it operations leadership", "it operations"]],
  [/(?:technical|customer)\s+support\s+(?:manager|lead|head|leadership)|head\s+of\s+(?:technical\s+)?support/i, ["support leadership", "technical support leadership"]],
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
  [/\bcypress\b/i,                                      ["Cypress"]],
  // DevOps / infrastructure — specific enough to gate meaningfully
  [/\bkubernetes\b|\bk8s\b|\baks\b|\beks\b|\bgke\b/i,  ["Kubernetes"]],
  [/\bterraform\b/i,                                    ["Terraform"]],
  [/\bansible\b/i,                                      ["Ansible"]],
  // Data engineering platforms
  [/\bdbt\b/i,                                          ["dbt"]],
  [/\bairflow\b/i,                                      ["Airflow"]],
  // Security specialisations — specific enough to appear in profiles
  [/\bpenetration test|\bpen test|\bpentest|\bethical hack/i, ["penetration testing"]],
  [/\bsiem\b|\bsplunk\b|\bqradar\b/i,                   ["SIEM"]],
  [/\biso 27001\b/i,                                    ["ISO 27001"]],
  [/\bisms\b|information\s+security\s+management\s+system/i, ["ISMS"]],
  // Compliance / methodology
  [/\bitil\b|\bitsm\b/i,                                ["ITIL"]],
  // NOTE: "security clearance" intentionally NOT in DISTINCTIVE — cleared candidates
  // don't put clearance status in their LinkedIn profiles (it's sensitive/restricted),
  // so any role with a clearance requirement would return 0 candidates if this gated
  // the source check. Clearance is assessed during scoring, not at search import.
  // ── Industrial / power / control systems specialists ──────────────────────
  // SCADA, RTU are rare enough as bare tokens to anchor on. PLC and PCI-DSS
  // require phrase forms because the bare abbreviations collide ("Vodafone PLC",
  // "PCIe driver"). ISMS is exact enough to be useful; SOC 2 is still kept out
  // because it is often absent from LinkedIn snippets even for adjacent GRC leads.
  [/\bscada\b/i,                                        ["SCADA"]],
  [/\brtu\b|remote\s+terminal\s+unit/i,                 ["RTU"]],
  [/programmable\s+logic\s+controller|\bplc\s+(?:programming|integration|configuration|config|ladder|hmi|scada)/i, ["PLC integration", "PLC configuration", "PLC programming", "programmable logic controller"]],
  // Same tightening as TECH alias — see the comment there. Bare "process
  // control" / "industrial control" without an industrial qualifier or a
  // downstream noun would trigger specialist gating on DevOps / RPA JDs.
  [/(?:industrial|plant|manufacturing|substation)\s+process\s+(?:control|automation|instrumentation)|process\s+(?:control|instrumentation)\s+(?:engineer|system|loop|valve|equipment)|industrial\s+(?:control\s+system|automation\s+(?:system|engineer|platform))/i, ["industrial controls"]],
  [/\bmetering\b|smart\s+metering/i,                    ["metering"]],
  // Power-distribution anchor: include canonical adjacent phrasings so a
  // substation / HV-switchgear / protection-relay candidate registers the
  // same anchor a SCADA-and-HV role JD would emit. "power systems engineer"
  // is anchored on the role-noun to avoid drifting into generic uses like
  // "operating systems power management".
  [/\bpower\s+distribution\b|\bhigh[- ]voltage|\bhv\s+(?:equipment|switchgear|substation|commissioning|cable|transmission|distribution|installation)\b|\bsubstation\b|\bpower\s+systems?\s+(?:engineer|technician|specialist)\b|\bprotection\s+relays?\b/i, ["power distribution"]],
  [/\belectrical\s+engineering\b|\bpower\s+engineering\b/i, ["electrical engineering"]],
  // Agile/delivery roles — match both canonical title and common practitioner synonyms
  // so a Scrum Master search doesn't block Agile Coach profiles and vice versa.
  [/\bscrum master\b|\bscrum coach\b/i,                 ["Scrum Master", "Scrum Coach"]],
  [/\bagile coach\b|\bagile practitioner\b/i,            ["Agile Coach", "agile"]],
  [/\bsafe practitioner\b|\bsafe agilist\b|\brelease train engineer\b|\brte\b/i, ["SAFe", "Release Train Engineer"]],
  [/\bproduct owner\b/i,                                ["Product Owner"]],
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
  "field","roles","sales","plc",
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

// ─── Role archetype detection ────────────────────────────────────────────────
// Used to decide whether ISMS / ISO 27001 should act as a HARD source-gate
// anchor (yes for pure-compliance roles, no for hybrid IT-ops roles).
//
// The split exists because:
//   - "ISMS Lead", "Information Security Manager" → real candidates for these
//     roles WILL surface ISMS/ISO 27001 in their LinkedIn snippet. Gating is
//     accurate.
//   - "Technology Support Manager", "IT Operations Manager", "Head of IT" →
//     candidates for these roles often have ISMS/ISO 27001 EXPERIENCE without
//     surfacing the acronym in a LinkedIn snippet. Gating silently drops them.
//
// We default to "hybrid" (no ISMS/ISO gating) on ambiguous titles. The cost of
// over-gating a real compliance role is much worse than the cost of letting a
// few non-ISMS profiles into a compliance search — recruiters can dismiss
// false positives, but silently rejected candidates are never surfaced.
const PURE_COMPLIANCE_TITLE_RE = /\b(?:isms\s+lead|information\s+security\s+(?:lead|manager|officer|director|head)|head\s+of\s+(?:information\s+)?security|chief\s+information\s+security\s+officer|ciso|compliance\s+(?:lead|manager|officer|director|head|specialist|analyst)|grc\s+(?:lead|manager|analyst)|risk\s+(?:and\s+)?compliance\s+(?:lead|manager|director)|security\s+governance\s+(?:lead|manager)|iso\s*27001\s+(?:lead\s+)?(?:auditor|implementer|consultant)|pci\s+dss\s+(?:auditor|consultant|qsa)|soc\s*2\s+(?:auditor|consultant)|infosec\s+(?:lead|manager)|cyber\s*security\s+(?:lead|manager|director|officer))\b/i;

// Compliance terms whose source-gating is suppressed for hybrid roles.
const COMPLIANCE_GATE_TERMS = new Set(["ISO 27001", "ISMS"]);

export function isPureComplianceRole(title: string | null | undefined): boolean {
  if (!title) return false;
  return PURE_COMPLIANCE_TITLE_RE.test(title);
}

// Domain groups: anchors that all describe the same NZ-scarce candidate
// pool. If a role requires ANY anchor in the group, candidates surfacing
// ANY OTHER anchor in the same group should pass the gate — they're
// fishing in the same pool. The alternative (per-anchor strict matching)
// rejects "Substation commissioning engineer" for a "SCADA engineer" role
// even though those candidates are clearly adjacent in the NZ market.
//
// Keep groups TIGHT — only true domain peers. Expanding a group too far
// (e.g. adding "Salesforce" to power) would defeat the gate's purpose.
const ANCHOR_DOMAIN_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set([
    "SCADA",
    "RTU",
    "PLC integration",
    "PLC programming",
    "PLC configuration",
    "programmable logic controller",
    "industrial controls",
    "metering",
    "power distribution",
  ]),
];

function expandDomainAnchors(anchors: Set<string>): Set<string> {
  const result = new Set(anchors);
  for (const group of ANCHOR_DOMAIN_GROUPS) {
    let touched = false;
    for (const anchor of anchors) {
      if (group.has(anchor)) { touched = true; break; }
    }
    if (touched) for (const t of group) result.add(t);
  }
  return result;
}

/**
 * Role-aware distinctive anchors. Two adjustments on top of the raw
 * DISTINCTIVE alias output:
 *
 *  1. **Compliance carve-out**: HYBRID IT-ops/leadership roles strip
 *     ISMS / ISO 27001 from the gate so they don't reject good IT-ops
 *     candidates whose snippets lack those acronyms. PURE compliance
 *     roles (ISMS Lead, CISO, Compliance Manager) keep the full set.
 *
 *  2. **Domain-group expansion**: when a role requires ANY anchor in a
 *     domain group (e.g. SCADA), accept any OTHER anchor from the same
 *     group (RTU, PLC, substation/HV → power distribution, metering,
 *     industrial controls) as adjacency evidence. Stops a SCADA-only
 *     role JD from rejecting plainly-adjacent substation engineers.
 *
 * Use this — not extractDistinctiveSignalsFromRequirement directly —
 * wherever the result is consumed as a SOURCE GATE or SPECIALIST ANCHOR
 * CAP. Pure scoring/coverage paths (where ISMS still informs the score
 * but doesn't gate) can keep using the underlying extractor.
 */
export function extractRoleAwareDistinctiveAnchors(args: {
  title: string | null | undefined;
  requirements: string[];
}): string[] {
  const isPure = isPureComplianceRole(args.title);
  const all = new Set<string>();
  for (const r of args.requirements) {
    extractDistinctiveSignalsFromRequirement(r).forEach((t) => all.add(t));
  }
  const filtered = isPure
    ? all
    : new Set([...all].filter((term) => !COMPLIANCE_GATE_TERMS.has(term)));
  return [...expandDomainAnchors(filtered)];
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
  // Industrial / power. SCADA / RTU are bare-token-safe; PLC requires phrase
  // form because "PLC" alone matches "Vodafone PLC" / "Spark NZ PLC".
  [/\bscada\b/i,                                             "SCADA"],
  [/\brtu\b/i,                                               "RTU"],
  [/programmable\s+logic\s+controller|\bplc\s+(?:programming|ladder|hmi|scada)/i, "PLC"],
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
  if (needle === "c++") return /\bc\+\+/i.test(text);
  if (needle === "c#") return /\bc#/i.test(text);
  if (needle.length <= 4) {
    return new RegExp(
      `(?:^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`
    ).test(haystack);
  }
  return haystack.includes(needle);
}
