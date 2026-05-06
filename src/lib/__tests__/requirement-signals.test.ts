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
});
