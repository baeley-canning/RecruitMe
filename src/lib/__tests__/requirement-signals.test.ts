import { describe, expect, it } from "vitest";
import {
  extractDistinctiveSignalsFromRequirement,
  extractRoleAwareDistinctiveAnchors,
  extractSignalsFromRequirement,
  extractStrippedComplianceAnchors,
  isPureComplianceRole,
  signalMatchesText,
} from "../requirement-signals";

describe("requirement signal extraction", () => {
  it("extracts hard technical signals without generic role noise", () => {
    expect(extractSignalsFromRequirement("Strong C++ engineering experience")).toEqual(
      expect.arrayContaining(["c++", "cpp"])
    );
    expect(extractSignalsFromRequirement("Strong C++ engineering experience")).not.toContain("engineering");

    const sqlSignals = extractSignalsFromRequirement("SQL and relational database experience (critical)");
    expect(sqlSignals).toEqual(expect.arrayContaining(["sql", "database", "relational database", "rdbms"]));
    expect(sqlSignals).not.toContain("critical");
  });

  it("keeps broad behavioural requirements from inflating snippet scores", () => {
    expect(extractSignalsFromRequirement("Strong analytical and problem-solving skills")).toEqual([]);
    expect(extractSignalsFromRequirement("Excellent stakeholder management and communication skills")).toEqual([]);
    expect(extractSignalsFromRequirement("Proven track record of delivering large-scale solutions")).toEqual([]);
    expect(extractSignalsFromRequirement("Experience designing and delivering production-grade solutions")).toEqual(["production"]);
  });

  it("covers common future role families from one shared alias table", () => {
    expect(extractSignalsFromRequirement("Experience with data visualisation tools (Power BI, Tableau)")).toEqual(
      expect.arrayContaining(["power bi", "tableau", "bi"])
    );
    expect(extractSignalsFromRequirement("Experience with Selenium or similar test automation frameworks")).toEqual(
      expect.arrayContaining(["selenium", "test automation"])
    );
    expect(extractSignalsFromRequirement("Strong C# and .NET development experience")).toEqual(
      expect.arrayContaining(["c#", ".net"])
    );
  });

  it("uses word boundaries for short signals", () => {
    expect(signalMatchesText("Senior SQL Server developer", "sql")).toBe(true);
    expect(signalMatchesText("NoSQL MongoDB engineer", "sql")).toBe(false);
    expect(signalMatchesText("Access management specialist", "css")).toBe(false);
    expect(signalMatchesText("C++ Linux engineer", "c++")).toBe(true);
    expect(signalMatchesText("Solaris C++Developer for CusMod", "c++")).toBe(true);
  });

  it("extracts distinctive anchors for source gating and query intent", () => {
    const terms = extractDistinctiveSignalsFromRequirement(
      "Experience with enterprise RDBMS platforms (Sybase/ASE, SQL Server, Oracle, or similar)"
    );
    expect(terms).toEqual(expect.arrayContaining(["Sybase", "SQL Server", "Oracle"]));
    expect(terms).not.toEqual(expect.arrayContaining(["enterprise", "platforms", "similar"]));
  });

  it("extracts POWER role anchors (SCADA / RTU / industrial controls / metering)", () => {
    expect(extractDistinctiveSignalsFromRequirement(
      "Experience with SCADA systems, RTU configuration, and metering infrastructure"
    )).toEqual(expect.arrayContaining(["SCADA", "RTU", "metering"]));

    // Tightened regex requires an industrial qualifier or downstream noun.
    // Using realistic substation phrasing to anchor industrial-controls.
    expect(extractDistinctiveSignalsFromRequirement(
      "Industrial control system background with electrical engineering focus"
    )).toEqual(expect.arrayContaining(["industrial controls", "electrical engineering"]));

    expect(extractDistinctiveSignalsFromRequirement(
      "Power distribution / high-voltage substation experience"
    )).toEqual(expect.arrayContaining(["power distribution"]));
  });

  it("PLC anchor requires phrase form — bare 'PLC' (company suffix) does NOT trigger", () => {
    // Critical false-positive guard: "Vodafone PLC" / "Spark NZ PLC" are
    // company suffixes and must NOT pass the source gate for SCADA roles.
    expect(extractDistinctiveSignalsFromRequirement(
      "Senior engineer at Vodafone PLC working on cloud infrastructure"
    )).not.toEqual(expect.arrayContaining(["PLC"]));

    // Legitimate PLC phrase form does fire.
    expect(extractDistinctiveSignalsFromRequirement(
      "PLC programming experience with ladder logic and HMI integration"
    )).toEqual(expect.arrayContaining(["PLC programming"]));

    expect(extractDistinctiveSignalsFromRequirement(
      "Programmable logic controller configuration and ladder logic"
    )).toEqual(expect.arrayContaining(["programmable logic controller"]));
  });

  it("PCI anchor requires PCI-DSS phrase — bare 'PCI' (PCIe / PCI bus) does NOT trigger", () => {
    // Embedded engineer's "PCIe driver" must not pass a PCI-DSS gate.
    expect(extractSignalsFromRequirement(
      "Embedded firmware engineer with PCIe driver development experience"
    )).not.toEqual(expect.arrayContaining(["pci dss", "security compliance"]));

    expect(extractSignalsFromRequirement(
      "PCI-DSS compliance experience for payment processing"
    )).toEqual(expect.arrayContaining(["pci dss", "security compliance"]));
  });

  it("compliance signals: ISMS / GRC / information security governance", () => {
    expect(extractSignalsFromRequirement(
      "ISMS lead experience implementing ISO 27001 controls"
    )).toEqual(expect.arrayContaining(["isms", "iso 27001"]));

    expect(extractSignalsFromRequirement(
      "GRC framework experience and audit governance"
    )).toEqual(expect.arrayContaining(["grc", "compliance"]));

    expect(extractSignalsFromRequirement(
      "Lead information security governance for SaaS platform"
    )).toEqual(expect.arrayContaining(["security governance", "isms"]));
  });

  it("hybrid leadership phrases: IT operations leadership + technical support leadership", () => {
    // Phrase requires the leadership noun/verb ("lead", "manager", "head",
    // "leadership") as part of the phrase — bare "Lead a team of IT
    // operations engineers" doesn't qualify because the leadership word
    // isn't fused with the function. Anchor on the phrase form.
    expect(extractSignalsFromRequirement(
      "Head of IT Operations for the platform team"
    )).toEqual(expect.arrayContaining(["it operations leadership"]));

    expect(extractSignalsFromRequirement(
      "IT Operations Manager with 5 years in enterprise"
    )).toEqual(expect.arrayContaining(["it operations leadership"]));

    expect(extractSignalsFromRequirement(
      "Head of Technical Support, leading the customer support function"
    )).toEqual(expect.arrayContaining(["support leadership"]));
  });

  it("technical sales / pre-sales / RFP signals — but ONLY when the phrase is present", () => {
    expect(extractSignalsFromRequirement(
      "Technical sales engineer covering enterprise accounts"
    )).toEqual(expect.arrayContaining(["technical sales", "sales engineer"]));

    expect(extractSignalsFromRequirement(
      "Pre-sales engineering for SaaS platforms; RFP/RFQ response experience"
    )).toEqual(expect.arrayContaining(["pre-sales", "rfp"]));

    // Bare "sales" alone should not over-match — only with the qualifying word.
    expect(extractSignalsFromRequirement(
      "Sales focus with strong communication"
    )).not.toEqual(expect.arrayContaining(["technical sales"]));
  });

  it("REGRESSION: 'process control' / 'process automation' must NOT distinctive-flag DevOps or RPA JDs", () => {
    // Critique: the original regex matched "automated CI/CD process control"
    // (DevOps) and "process automation across deployment workflows" (RPA),
    // which incorrectly flipped specialistRole=true on those roles. Tightened
    // regex requires an industrial qualifier OR a downstream noun.
    expect(extractDistinctiveSignalsFromRequirement(
      "Automated CI/CD process control for build pipelines"
    )).not.toEqual(expect.arrayContaining(["industrial controls"]));

    expect(extractDistinctiveSignalsFromRequirement(
      "Process automation across deployment workflows for an RPA platform"
    )).not.toEqual(expect.arrayContaining(["industrial controls"]));

    expect(extractDistinctiveSignalsFromRequirement(
      "Lead source-control and version-control systems migration"
    )).not.toEqual(expect.arrayContaining(["industrial controls"]));

    // Legitimate industrial-context phrasings still fire.
    expect(extractDistinctiveSignalsFromRequirement(
      "Industrial process control and instrumentation experience in a substation environment"
    )).toEqual(expect.arrayContaining(["industrial controls"]));

    expect(extractDistinctiveSignalsFromRequirement(
      "Process control engineer for plant SCADA stack"
    )).toEqual(expect.arrayContaining(["industrial controls"]));
  });

  it("HV regex covers canonical substation phrasings ('HV equipment', 'HV switchgear', 'HV substation')", () => {
    // Narrow original regex missed common substation phrasings. Locked here.
    expect(extractSignalsFromRequirement(
      "HV equipment commissioning experience"
    )).toEqual(expect.arrayContaining(["high voltage"]));

    expect(extractSignalsFromRequirement(
      "HV switchgear and substation installation"
    )).toEqual(expect.arrayContaining(["high voltage"]));

    expect(extractSignalsFromRequirement(
      "HV cable transmission projects across the upper North Island"
    )).toEqual(expect.arrayContaining(["high voltage"]));

    // Bare "HV broadcasting" without electrical context must NOT match.
    expect(extractSignalsFromRequirement(
      "HV broadcasting channel format"
    )).not.toEqual(expect.arrayContaining(["high voltage"]));
  });

  it("HMI regex matches when an industrial qualifier is a few words after HMI", () => {
    // Original `\bhmi\b\s+(?:scada|...)` required the qualifier as the very
    // next token; "HMI integration with SCADA" missed. Widened here.
    expect(extractSignalsFromRequirement(
      "HMI integration with SCADA stack"
    )).toEqual(expect.arrayContaining(["hmi", "scada"]));

    expect(extractSignalsFromRequirement(
      "Human Machine Interface design for industrial controls"
    )).toEqual(expect.arrayContaining(["hmi"]));

    // UX/UI roles that say "HMI design" with no industrial qualifier nearby
    // still get no industrial-controls signal.
    expect(extractSignalsFromRequirement(
      "HMI design for mobile checkout flow"
    )).not.toEqual(expect.arrayContaining(["industrial controls"]));
  });

  it("realistic Transpower-style multi-clause requirement extracts the right anchors and nothing else", () => {
    const realisticReq =
      "Demonstrated experience with SCADA, RTU and metering platforms in a regulated NZ utility " +
      "(Transpower, Mercury, Genesis) — exposure to IEC 61850 and substation automation preferred.";
    const distinctive = extractDistinctiveSignalsFromRequirement(realisticReq);
    expect(distinctive).toEqual(expect.arrayContaining(["SCADA", "RTU", "metering"]));
    // Must NOT pollute distinctive set with company names or generic words.
    expect(distinctive).not.toEqual(expect.arrayContaining(["Transpower", "Mercury", "Genesis", "regulated", "utility", "platforms"]));
  });

  it("ISMS is distinctive, while SOC 2 stays out of DISTINCTIVE", () => {
    // ISMS is exact enough to gate on. SOC 2 is intentionally not distinctive:
    // many relevant GRC / compliance profiles won't list it in snippets.
    const ismsTerms = extractDistinctiveSignalsFromRequirement(
      "ISMS lead with ISO 27001 implementation"
    );
    expect(ismsTerms).toEqual(expect.arrayContaining(["ISO 27001", "ISMS"]));

    const soc2Terms = extractDistinctiveSignalsFromRequirement(
      "SOC 2 Type 2 audit experience"
    );
    expect(soc2Terms).not.toEqual(expect.arrayContaining(["SOC 2"]));
  });

  it("DISTINCTIVE power-distribution regex covers HV-equipment / power-systems / protection-relay candidate phrasings", () => {
    // Re-audit fix: the DISTINCTIVE power-distribution pattern previously
    // accepted only "power distribution" / "high voltage" (long form) /
    // "substation". A candidate writing "HV equipment" / "Power systems
    // engineer" / "protection relays" had ZERO distinctive overlap with a
    // POWER role and was wrongly capped. These phrasings now anchor.
    expect(extractDistinctiveSignalsFromRequirement(
      "HV switchgear and power distribution field service"
    )).toEqual(expect.arrayContaining(["power distribution"]));

    expect(extractDistinctiveSignalsFromRequirement(
      "HV equipment commissioning and substation work"
    )).toEqual(expect.arrayContaining(["power distribution"]));

    expect(extractDistinctiveSignalsFromRequirement(
      "Power systems engineer with grid experience"
    )).toEqual(expect.arrayContaining(["power distribution"]));

    expect(extractDistinctiveSignalsFromRequirement(
      "Protection relay configuration and substation automation"
    )).toEqual(expect.arrayContaining(["power distribution"]));

    // False-positive guards: generic uses of "power" / "systems" must NOT
    // distinctive-flag random roles.
    expect(extractDistinctiveSignalsFromRequirement(
      "Operating systems power management for laptop firmware"
    )).not.toEqual(expect.arrayContaining(["power distribution"]));

    expect(extractDistinctiveSignalsFromRequirement(
      "Senior systems engineer for cloud platform"
    )).not.toEqual(expect.arrayContaining(["power distribution"]));
  });

  // ── Role-aware distinctive anchors (Option C) ─────────────────────────────
  describe("isPureComplianceRole — title classification", () => {
    it("flags genuinely pure compliance / security titles as PURE", () => {
      expect(isPureComplianceRole("ISMS Lead")).toBe(true);
      expect(isPureComplianceRole("Information Security Manager")).toBe(true);
      expect(isPureComplianceRole("Head of Information Security")).toBe(true);
      expect(isPureComplianceRole("Chief Information Security Officer")).toBe(true);
      expect(isPureComplianceRole("CISO")).toBe(true);
      expect(isPureComplianceRole("Compliance Manager")).toBe(true);
      expect(isPureComplianceRole("GRC Lead")).toBe(true);
      expect(isPureComplianceRole("Risk and Compliance Manager")).toBe(true);
      expect(isPureComplianceRole("ISO 27001 Lead Implementer")).toBe(true);
      expect(isPureComplianceRole("PCI DSS QSA")).toBe(true);
      expect(isPureComplianceRole("SOC 2 Auditor")).toBe(true);
      expect(isPureComplianceRole("InfoSec Lead")).toBe(true);
      expect(isPureComplianceRole("Cybersecurity Director")).toBe(true);
    });

    it("flags hybrid IT-ops titles as NOT pure (so ISMS/ISO 27001 don't gate)", () => {
      expect(isPureComplianceRole("Technology and Solution Support Manager")).toBe(false);
      expect(isPureComplianceRole("IT Operations Manager")).toBe(false);
      expect(isPureComplianceRole("Head of IT Operations")).toBe(false);
      expect(isPureComplianceRole("Senior IT Manager")).toBe(false);
      expect(isPureComplianceRole("Technical Support Manager")).toBe(false);
      expect(isPureComplianceRole("Infrastructure Engineer")).toBe(false);
      expect(isPureComplianceRole("Software Engineer")).toBe(false);
      expect(isPureComplianceRole("Senior Software Engineer")).toBe(false);
      expect(isPureComplianceRole("DevOps Engineer")).toBe(false);
    });

    it("handles null / empty titles safely (no false PURE)", () => {
      expect(isPureComplianceRole(null)).toBe(false);
      expect(isPureComplianceRole(undefined)).toBe(false);
      expect(isPureComplianceRole("")).toBe(false);
    });
  });

  describe("extractRoleAwareDistinctiveAnchors — strips ISMS/ISO 27001 for hybrid only", () => {
    const ismsRequirements = [
      "ISO 27001 ISMS implementation experience",
      "Information security governance",
    ];

    it("KEEPS ISMS / ISO 27001 in anchors for a PURE compliance role", () => {
      const anchors = extractRoleAwareDistinctiveAnchors({
        title: "ISMS Lead",
        requirements: ismsRequirements,
      });
      expect(anchors).toEqual(expect.arrayContaining(["ISMS", "ISO 27001"]));
    });

    it("STRIPS ISMS / ISO 27001 from anchors for a HYBRID IT-ops role", () => {
      const anchors = extractRoleAwareDistinctiveAnchors({
        title: "Technology and Solution Support Manager",
        requirements: ismsRequirements,
      });
      expect(anchors).not.toEqual(expect.arrayContaining(["ISMS"]));
      expect(anchors).not.toEqual(expect.arrayContaining(["ISO 27001"]));
    });

    it("KEEPS non-compliance distinctive anchors regardless of role type", () => {
      // POWER role anchors are unaffected by the role-archetype filter —
      // SCADA / RTU still gate even on a (hypothetical) hybrid title.
      const anchors = extractRoleAwareDistinctiveAnchors({
        title: "Industrial Operations Manager",
        requirements: [
          "SCADA systems experience",
          "RTU configuration",
          "Smart metering rollout",
        ],
      });
      expect(anchors).toEqual(expect.arrayContaining(["SCADA", "RTU", "metering"]));
    });

    it("hybrid IT role with MIXED anchors — keeps non-compliance, strips compliance", () => {
      const anchors = extractRoleAwareDistinctiveAnchors({
        title: "IT Operations Manager",
        requirements: [
          "Kubernetes orchestration",
          "ISO 27001 ISMS oversight",
          "Salesforce administration",
        ],
      });
      expect(anchors).toEqual(expect.arrayContaining(["Kubernetes", "Salesforce"]));
      expect(anchors).not.toEqual(expect.arrayContaining(["ISMS"]));
      expect(anchors).not.toEqual(expect.arrayContaining(["ISO 27001"]));
    });

    it("domain-group expansion: SCADA-only role accepts substation/HV/metering as adjacent", () => {
      // A role that only mentions SCADA/RTU should still treat substation /
      // HV / metering / industrial-controls candidates as in-pool. They're
      // all the same NZ-scarce industrial-utility pool. Without this, the
      // gate is unforgivingly narrow on real recruiting data.
      const anchors = extractRoleAwareDistinctiveAnchors({
        title: "SCADA Engineer",
        requirements: ["SCADA systems experience", "RTU configuration"],
      });
      // Group expansion brings in the rest of the power-domain pool.
      expect(anchors).toEqual(expect.arrayContaining([
        "SCADA", "RTU", "metering", "industrial controls", "power distribution",
        "PLC integration", "PLC programming", "PLC configuration",
      ]));
    });

    it("domain-group expansion does NOT leak into unrelated roles", () => {
      // A Salesforce role doesn't suddenly accept SCADA candidates — the
      // domain group only expands when the role actually has a power-domain
      // anchor.
      const anchors = extractRoleAwareDistinctiveAnchors({
        title: "Salesforce Developer",
        requirements: ["Salesforce administration", "Apex programming"],
      });
      expect(anchors).toEqual(expect.arrayContaining(["Salesforce"]));
      expect(anchors).not.toEqual(expect.arrayContaining(["SCADA", "RTU", "metering"]));
    });

    it("null title falls through to hybrid (safer default — strips compliance)", () => {
      const anchors = extractRoleAwareDistinctiveAnchors({
        title: null,
        requirements: ["ISO 27001 ISMS"],
      });
      // Better to UNDER-gate than over-gate when title is missing.
      expect(anchors).not.toEqual(expect.arrayContaining(["ISMS"]));
    });
  });

  it("PLC requirements do not create a bare PLC signal that matches company suffixes", () => {
    const signals = extractSignalsFromRequirement("PLC integration and configuration experience");
    expect(signals).toEqual(expect.arrayContaining(["plc integration", "plc configuration"]));
    expect(signals).not.toContain("plc");

    expect(signals.some((signal) => signalMatchesText("Senior engineer at Vodafone PLC", signal))).toBe(false);
    expect(signals.some((signal) => signalMatchesText("PLC configuration and HMI integration", signal))).toBe(true);
  });

  // ── Hybrid-role compliance fallback ────────────────────────────────────
  // extractRoleAwareDistinctiveAnchors strips ISMS/ISO 27001 for non-pure-
  // compliance titles to avoid under-firing on IT-ops roles. But that
  // leaves NO way for a candidate with strong ISMS evidence to pass the
  // source gate on a hybrid role like "Technology and Solution Support
  // Manager". extractStrippedComplianceAnchors returns the anchors that
  // WERE stripped so the search gate can admit them as a second pass.
  describe("extractStrippedComplianceAnchors — hybrid-role fallback", () => {
    const hybridReqs = [
      "ISO 27001 ISMS implementation",
      "SOC 2 audit readiness",
      "Linux infrastructure management",
      "Active Directory and networking",
    ];

    it("returns ISMS + ISO 27001 for a hybrid title (NOT pure compliance)", () => {
      const stripped = extractStrippedComplianceAnchors({
        title: "Technology and Solution Support Manager",
        requirements: hybridReqs,
      });
      expect(stripped).toEqual(expect.arrayContaining(["ISMS", "ISO 27001"]));
    });

    it("returns EMPTY for a PURE compliance title (anchors already in main set)", () => {
      const stripped = extractStrippedComplianceAnchors({
        title: "ISMS Lead",
        requirements: hybridReqs,
      });
      expect(stripped).toEqual([]);
    });

    it("returns EMPTY when role has no compliance requirements", () => {
      const stripped = extractStrippedComplianceAnchors({
        title: "Senior Software Engineer",
        requirements: ["C++ development", "Sybase database experience"],
      });
      expect(stripped).toEqual([]);
    });
  });
});

describe("extractSignalsFromRequirement — soft-skill / generic English words are dropped", () => {
  it("drops generic verbs and adjectives that surfaced in the Quoting Specialist regression", () => {
    // These are all common English words that appeared in soft-skill JD
    // must-haves like 'Strong written and verbal communication skills' or
    // 'Ability to manage repetitive, high-volume work'. None of them carry
    // role-specific signal — they appear in every CV. Letting them through
    // would re-open the bug where any dev/PM profile matches any soft-skill JD.
    const genericWords = [
      "written", "verbal", "manage", "managing", "time", "volume",
      "under", "able", "business", "approach", "competing", "priorities",
      "accuracy", "organised", "organized", "calm", "pressure", "reliable",
      "consistent", "repetitive", "designed", "delivered", "defined",
      "within", "while", "repeatable",
    ];
    for (const word of genericWords) {
      const signals = extractSignalsFromRequirement(word);
      expect(signals, `expected stop-word "${word}" to be dropped`).not.toContain(word);
    }
  });

  it("Quoting Specialist must-haves produce only the role-distinctive signal 'quoting' (and aliases)", () => {
    // The 8 soft-skill must-haves below, after stop-word filtering, should
    // leave essentially nothing except 'quoting' / 'quoter' from must-have #5.
    // This is the desired behaviour — non-distinctive prose contributes no
    // false-positive signal, so only candidates whose profiles mention
    // 'quoting' or 'quoter' get admitted to a Quoting Specialist role.
    const mustHaves = [
      "Strong written and verbal communication skills",
      "High attention to detail and accuracy",
      "Ability to manage repetitive, high-volume work while maintaining quality",
      "Comfortable working within defined processes and systems",
      "Highly organised with strong time-management skills",
      "Reliable, consistent, and process-driven approach",
      "Calm under pressure and able to manage competing priorities",
    ];
    const all = new Set<string>();
    for (const req of mustHaves) {
      for (const s of extractSignalsFromRequirement(req)) all.add(s);
    }
    // No remaining signal should be a generic English word.
    const genericLeak = ["manage", "time", "able", "under", "business", "written", "verbal", "organised", "calm", "pressure", "competing", "priorities"];
    for (const word of genericLeak) {
      expect(all, `generic word "${word}" should not appear in signals`).not.toContain(word);
    }
  });
});
