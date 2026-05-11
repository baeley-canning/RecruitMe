/**
 * Title-family classifier — used to gate sourcing when a role has no
 * distinctive technical anchors.
 *
 * Background: for specialist roles (SCADA, C++, ISMS) the source gate filters
 * candidates by anchor terms. For generalist / non-technical roles
 * (Project Manager, Account Executive, Head of Engineering) there are no
 * distinctive anchors so the gate was returning true for everyone — pulling
 * C++ Developers onto PM lists and Account Execs onto Software Engineer
 * lists. This module gives the gate a second axis: a coarse role-family
 * classifier that rejects clearly-incompatible candidate titles.
 *
 * Design constraints:
 *   - Cheap (regex only — runs in the search hot path).
 *   - Conservative — null result means "could be anything, allow through".
 *     We only return a family when the title is unambiguous; ambiguous
 *     titles (e.g. "Solutions Lead") get null and pass the gate.
 *   - Crossover-aware — a Senior Engineer applying to an Engineering Manager
 *     role is a legitimate move; sales applying to engineering isn't.
 */

export type TitleFamily =
  | "engineering"            // IC software / hardware / firmware engineers
  | "engineering_management" // Engineering managers, tech leads, heads of engineering
  | "project_management"     // PMs, programme / delivery managers, scrum masters, RTE
  | "product"                // Product managers, product owners
  | "design"                 // UI / UX / Product designers
  | "data"                   // Data scientists / analysts / ML engineers
  | "qa"                     // QA / test / automation engineers
  | "devops_infra"           // DevOps, SRE, Platform, Infrastructure, Sysadmin, Cloud Engineer
  | "support_ops"            // IT support, service desk, help desk, support engineer
  | "security_grc"           // Security analysts, ISMS leads, CISO, GRC, Compliance Manager
  | "sales"                  // Account exec, BDM, sales manager, technical sales engineer
  | "marketing"              // Marketing, growth, content, brand
  | "finance_accounting"     // Accountants, finance managers, controllers, treasurers
  | "operations"             // Ops managers, supply chain, logistics, business ops
  | "executive_leadership"   // CEO, COO, VP (general management above engineering_management)
  | "hr_recruiting"          // HR, talent acquisition, people ops
  | "customer_success";      // CSM, account manager (post-sale, NOT sales)

interface FamilyPattern {
  family: TitleFamily;
  /** Word-boundary patterns. ORDER MATTERS — first match wins, so more
   *  specific patterns (engineering_management) must precede less-specific
   *  ones (engineering). */
  patterns: RegExp[];
}

// Ordered list: more specific role families first.
// Hyphens and slashes are common in titles ("project/programme manager",
// "qa/automation lead") so patterns use `[\s/.-]+` for separators.
const FAMILY_PATTERNS: FamilyPattern[] = [
  // ── Sales (must precede engineering — "Sales Engineer" should be sales)
  {
    family: "sales",
    patterns: [
      /\b(?:account\s+executive|account\s+manager(?!\s+post[- ]?sale)|business\s+development\s+manager|\bbdm\b|sales\s+(?:manager|director|executive|representative|lead|engineer|consultant|specialist|associate|coordinator)|sales\s+&?\s+development|technical\s+sales|pre[- ]?sales|inside\s+sales|outside\s+sales|territory\s+manager|new\s+business)\b/i,
    ],
  },

  // ── Customer success (separate from sales — post-sale relationship)
  {
    family: "customer_success",
    patterns: [
      /\b(?:customer\s+success(?:\s+manager|\s+lead|\s+specialist)?|\bcsm\b|customer\s+experience\s+(?:manager|lead)|client\s+success)\b/i,
    ],
  },

  // ── Engineering management (must precede plain engineering)
  {
    family: "engineering_management",
    patterns: [
      /\b(?:engineering\s+manager|head\s+of\s+engineering|director\s+of\s+engineering|vp\s+(?:of\s+)?engineering|engineering\s+(?:lead|director)|tech\s+lead|technical\s+lead|engineering\s+team\s+lead|chief\s+technology\s+officer|\bcto\b)\b/i,
    ],
  },

  // ── DevOps / infrastructure (precede engineering — "DevOps Engineer" is infra not generic eng)
  {
    family: "devops_infra",
    patterns: [
      /\b(?:devops|\bsre\b|site\s+reliability|platform\s+engineer|infrastructure\s+(?:engineer|architect|manager)|cloud\s+(?:engineer|architect|infrastructure)|systems?\s+(?:administrator|admin)|sysadmin|network\s+engineer|kubernetes\s+(?:engineer|administrator))\b/i,
    ],
  },

  // ── QA (precede engineering — "QA Engineer" is testing not generic eng)
  {
    family: "qa",
    patterns: [
      /\b(?:\bqa\b\s+(?:engineer|lead|manager|analyst|automation|tester)|quality\s+(?:engineer|assurance|lead)|test\s+(?:engineer|lead|manager|automation|analyst|architect)|automation\s+(?:engineer|tester)|sdet)\b/i,
    ],
  },

  // ── Data (precede engineering — "Data Engineer" is data not generic eng)
  {
    family: "data",
    patterns: [
      /\b(?:data\s+(?:scientist|engineer|analyst|architect)|machine\s+learning\s+(?:engineer|specialist)|\bml\s+(?:engineer|ops)|analytics\s+engineer|business\s+intelligence|\bbi\s+(?:developer|analyst))\b/i,
    ],
  },

  // ── Security / GRC
  {
    family: "security_grc",
    patterns: [
      /\b(?:security\s+(?:engineer|analyst|architect|manager|consultant|specialist|lead|operations)|cyber[- ]?security\s+(?:engineer|analyst|specialist|consultant|manager)|isms\s+(?:lead|manager|specialist)|information\s+security\s+(?:manager|lead|officer|director|analyst)|grc\s+(?:lead|manager|analyst|specialist)|risk\s+(?:and|&)?\s*compliance|compliance\s+(?:manager|officer|analyst|specialist|lead)|chief\s+information\s+security\s+officer|\bciso\b|penetration\s+tester|\bsoc\s+analyst)\b/i,
    ],
  },

  // ── Engineering IC (after all the more-specific eng-derivative families)
  {
    family: "engineering",
    patterns: [
      /\b(?:software\s+(?:developer|engineer)|full[- ]?stack\s+(?:developer|engineer)|front[- ]?end\s+(?:developer|engineer)|back[- ]?end\s+(?:developer|engineer)|web\s+(?:developer|engineer)|mobile\s+(?:developer|engineer)|ios\s+developer|android\s+developer|game\s+(?:developer|engineer|programmer)|firmware\s+engineer|embedded\s+(?:engineer|software)|hardware\s+engineer|electronics?\s+engineer|systems?\s+engineer|applications?\s+(?:developer|engineer)|programmer|software\s+architect|solutions?\s+architect|principal\s+engineer|staff\s+engineer)\b/i,
      // Language-prefixed dev titles. `.net` and `c#` don't have a word boundary
      // because `.` and `#` are non-word characters, so we use a non-capturing
      // sentinel matching start-of-string OR space/punct.
      /(?:^|[\s,/(])(?:\.net|c\+\+|c#)\s+(?:developer|engineer)\b/i,
      /\b(?:java\s+(?:developer|engineer)|python\s+(?:developer|engineer)|node(?:\.js)?\s+(?:developer|engineer)|react\s+(?:developer|engineer)|angular\s+(?:developer|engineer)|ruby\s+(?:developer|engineer)|golang\s+(?:developer|engineer)|rust\s+(?:developer|engineer))\b/i,
    ],
  },

  // ── Project management
  {
    family: "project_management",
    patterns: [
      /\b(?:project\s+manager|programme\s+manager|program\s+manager|delivery\s+(?:manager|lead)|scrum\s+master|release\s+train\s+engineer|\brte\b|agile\s+coach|project\s+(?:lead|director|coordinator)|change\s+(?:manager|lead)|portfolio\s+(?:manager|lead)|pmo\s+(?:manager|lead|analyst))\b/i,
    ],
  },

  // ── Product
  {
    family: "product",
    patterns: [
      /\b(?:product\s+(?:manager|owner|director|lead|specialist|analyst|marketing\s+manager)|chief\s+product\s+officer|\bcpo\b|head\s+of\s+product)\b/i,
    ],
  },

  // ── Design
  {
    family: "design",
    patterns: [
      /\b(?:(?:ux|ui|product|interaction|service|visual)\s+designer|design\s+(?:lead|director|manager)|head\s+of\s+design|chief\s+design\s+officer|graphic\s+designer)\b/i,
    ],
  },

  // ── Support / ops
  {
    family: "support_ops",
    patterns: [
      /\b(?:it\s+support|service\s+desk|help\s+?desk|support\s+(?:engineer|technician|analyst|specialist|lead|manager)|tier\s+[123]\s+support|technical\s+support|application\s+support|systems?\s+support)\b/i,
    ],
  },

  // ── Marketing
  {
    family: "marketing",
    patterns: [
      /\b(?:marketing\s+(?:manager|director|lead|specialist|analyst|coordinator)|growth\s+(?:manager|lead|marketer)|brand\s+(?:manager|director|lead)|content\s+(?:manager|marketer|strategist|lead)|seo\s+(?:specialist|manager|lead)|chief\s+marketing\s+officer|\bcmo\b)\b/i,
    ],
  },

  // ── Finance / accounting
  {
    family: "finance_accounting",
    patterns: [
      /\b(?:accountant|finance\s+(?:manager|director|analyst|lead|business\s+partner)|controller|treasurer|chief\s+financial\s+officer|\bcfo\b|tax\s+(?:manager|specialist|analyst)|audit\s+(?:manager|senior|lead)|bookkeeper|payroll)\b/i,
    ],
  },

  // ── HR / recruiting
  {
    family: "hr_recruiting",
    patterns: [
      /\b(?:human\s+resources|people\s+(?:partner|operations|lead|manager)|talent\s+(?:acquisition|partner|manager)|recruiter|recruitment\s+(?:consultant|manager|lead)|chief\s+people\s+officer|\bchro\b|\bhr\s+(?:manager|director|lead|business\s+partner|generalist))\b/i,
    ],
  },

  // ── Operations
  {
    family: "operations",
    patterns: [
      /\b(?:operations\s+(?:manager|director|lead|analyst|specialist)|supply\s+chain|logistics\s+(?:manager|lead|coordinator)|business\s+operations|\bbizops|chief\s+operating\s+officer|\bcoo\b)\b/i,
    ],
  },

  // ── Executive / generic leadership (last — anything not caught above)
  {
    family: "executive_leadership",
    patterns: [
      /\b(?:chief\s+executive\s+officer|\bceo\b|managing\s+director|general\s+manager|country\s+manager|regional\s+manager|vice\s+president|\bvp\b)\b/i,
    ],
  },
];

// Directional crossover compatibility — read as "candidate-family CAN apply
// to role-family". The direction matters: a Senior Software Engineer
// applying to an Engineering Manager role is a legit step-up move, but a
// Service Desk Analyst applying to a Senior Software Engineer role is
// rarely the right fit even though both touch "tech". Bidirectional pairs
// are listed twice; asymmetric ones only once. Initial reviewer found a
// false-positive on the previous symmetric `support_ops ↔ engineering`
// pair, so support → engineering is now removed while engineering →
// support_ops (downshift / sabbatical move) remains allowed.
const COMPATIBLE_DIRECTIONAL: ReadonlyArray<readonly [TitleFamily, TitleFamily]> = [
  // Engineering ↔ Engineering management (both legit at NZ org sizes)
  ["engineering", "engineering_management"],
  ["engineering_management", "engineering"],

  // Engineering ↔ adjacent IC roles
  ["engineering", "devops_infra"],
  ["devops_infra", "engineering"],
  ["engineering", "data"],
  ["data", "engineering"],

  // Engineering → QA is a fine downshift (eng-with-QA-experience).
  // QA → engineering is rarer and lower-fit; not listed.
  ["engineering", "qa"],

  // Engineering → support_ops is a legit downshift / career-restart.
  // support_ops → engineering is the false-positive pair the critic
  // flagged (Service Desk Lead surfacing on Senior SWE searches) and is
  // intentionally NOT listed.
  ["engineering", "support_ops"],
  // Support → DevOps adjacency is real (sysadmin-shaped service desk).
  ["support_ops", "devops_infra"],

  // Engineering management ↔ project management (tech-PM track, common)
  ["engineering_management", "project_management"],
  ["project_management", "engineering_management"],

  // Engineering management → executive (growth move). Reverse is rarer.
  ["engineering_management", "executive_leadership"],

  // DevOps ↔ security (platform engineers often move to security and back)
  ["devops_infra", "security_grc"],
  ["security_grc", "devops_infra"],

  // Security engineers ARE engineers — and many engineers go to security.
  ["security_grc", "engineering"],
  ["engineering", "security_grc"],

  // Product ↔ project management crossover at smaller orgs
  ["product", "project_management"],
  ["project_management", "product"],

  // Sales ↔ customer success (similar relationship-heavy work)
  ["sales", "customer_success"],
  ["customer_success", "sales"],

  // Operations → project management is common (delivery / ops overlap).
  ["operations", "project_management"],
];

const COMPATIBLE_SET = new Set<string>(
  COMPATIBLE_DIRECTIONAL.map(([candidate, role]) => `${candidate}|${role}`),
);

/**
 * Classify a title string into a coarse family. Returns null when the title
 * is too generic / ambiguous to classify — those titles pass any title-family
 * gate (we don't reject on ambiguity).
 *
 * Examples (verified by tests):
 *   "Senior C++ Developer at Microsoft"  → "engineering"
 *   "Engineering Manager"                → "engineering_management"
 *   "Project Manager (Government)"       → "project_management"
 *   "Sales Engineer - POWER"             → "sales"
 *   "Solutions Lead"                     → null (ambiguous)
 *   ""                                   → null
 */
export function extractTitleFamily(title: string | null | undefined): TitleFamily | null {
  if (!title) return null;
  const lower = title.toLowerCase();
  for (const { family, patterns } of FAMILY_PATTERNS) {
    for (const re of patterns) {
      if (re.test(lower)) return family;
    }
  }
  return null;
}

/**
 * Are these two title families compatible for sourcing purposes?
 * Direction matters: the first arg is the CANDIDATE's family, the second is
 * the ROLE's. Rule: same family → yes. Different families → only if the
 * directional pair (candidate → role) is in COMPATIBLE_DIRECTIONAL. When
 * EITHER side is null (couldn't classify), we return true — we don't gate
 * on ambiguous titles.
 */
export function titleFamiliesCompatible(
  candidateFamily: TitleFamily | null | undefined,
  roleFamily: TitleFamily | null | undefined,
): boolean {
  if (!candidateFamily || !roleFamily) return true; // unclassified: allow through
  if (candidateFamily === roleFamily) return true;
  return COMPATIBLE_SET.has(`${candidateFamily}|${roleFamily}`);
}

/**
 * Composed check used by the search source gate and talent-pool import: does
 * this candidate's title plausibly fit this role's title?
 *
 * Use this ONLY when the role has no distinctive technical anchors — when
 * anchors exist, the anchor gate is more reliable than title matching.
 */
export function candidateTitleFitsRole(
  roleTitle: string | null | undefined,
  candidateTitle: string | null | undefined,
): boolean {
  // Directional: candidate first, role second. (The arg order on
  // candidateTitleFitsRole is role first, candidate second — that's the
  // recruiter mental model "for role X, does candidate Y fit?". The
  // underlying titleFamiliesCompatible takes candidate-then-role because
  // that's the direction the COMPATIBLE_DIRECTIONAL set is keyed by.)
  return titleFamiliesCompatible(
    extractTitleFamily(candidateTitle),
    extractTitleFamily(roleTitle),
  );
}
