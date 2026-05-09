import { describe, expect, it } from "vitest";
import {
  extractDistinctiveSignalsFromRequirement,
  extractSignalsFromRequirement,
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

    expect(extractDistinctiveSignalsFromRequirement(
      "Process control / industrial automation background, with electrical engineering focus"
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

  it("PLC requirements do not create a bare PLC signal that matches company suffixes", () => {
    const signals = extractSignalsFromRequirement("PLC integration and configuration experience");
    expect(signals).toEqual(expect.arrayContaining(["plc integration", "plc configuration"]));
    expect(signals).not.toContain("plc");

    expect(signals.some((signal) => signalMatchesText("Senior engineer at Vodafone PLC", signal))).toBe(false);
    expect(signals.some((signal) => signalMatchesText("PLC configuration and HMI integration", signal))).toBe(true);
  });
});
