import { describe, expect, it } from "vitest";
import {
  extractTitleFamily,
  titleFamiliesCompatible,
  candidateTitleFitsRole,
} from "../title-family";

describe("extractTitleFamily — engineering archetypes", () => {
  it("classifies plain software engineering titles", () => {
    expect(extractTitleFamily("Software Engineer")).toBe("engineering");
    expect(extractTitleFamily("Senior Software Developer")).toBe("engineering");
    expect(extractTitleFamily("Full Stack Developer")).toBe("engineering");
    expect(extractTitleFamily("Backend Engineer at Xero")).toBe("engineering");
    expect(extractTitleFamily("Senior C++ Developer")).toBe("engineering");
    expect(extractTitleFamily(".NET Developer")).toBe("engineering");
    expect(extractTitleFamily("Staff Engineer")).toBe("engineering");
    expect(extractTitleFamily("Solutions Architect")).toBe("engineering");
  });

  it("classifies engineering management separately from IC engineering", () => {
    expect(extractTitleFamily("Engineering Manager")).toBe("engineering_management");
    expect(extractTitleFamily("Head of Engineering")).toBe("engineering_management");
    expect(extractTitleFamily("Tech Lead")).toBe("engineering_management");
    expect(extractTitleFamily("CTO")).toBe("engineering_management");
    expect(extractTitleFamily("VP of Engineering")).toBe("engineering_management");
  });

  it("classifies DevOps / SRE / infrastructure separately from engineering", () => {
    expect(extractTitleFamily("DevOps Engineer")).toBe("devops_infra");
    expect(extractTitleFamily("Site Reliability Engineer")).toBe("devops_infra");
    expect(extractTitleFamily("Platform Engineer at Spark")).toBe("devops_infra");
    expect(extractTitleFamily("Cloud Architect")).toBe("devops_infra");
    expect(extractTitleFamily("Systems Administrator")).toBe("devops_infra");
  });

  it("classifies QA separately from engineering", () => {
    expect(extractTitleFamily("QA Engineer")).toBe("qa");
    expect(extractTitleFamily("Test Automation Lead")).toBe("qa");
    expect(extractTitleFamily("Senior QA Automation Engineer")).toBe("qa");
    expect(extractTitleFamily("SDET")).toBe("qa");
  });

  it("classifies data engineering separately from engineering", () => {
    expect(extractTitleFamily("Data Engineer")).toBe("data");
    expect(extractTitleFamily("Senior Data Scientist")).toBe("data");
    expect(extractTitleFamily("ML Engineer at Datacom")).toBe("data");
  });

  it("classifies Business Analyst family (Soft-Skill JD Class Bug fix)", () => {
    expect(extractTitleFamily("Technical BA")).toBe("business_analyst");
    expect(extractTitleFamily("Business Analyst")).toBe("business_analyst");
    expect(extractTitleFamily("Senior Business Systems Analyst")).toBe("business_analyst");
    expect(extractTitleFamily("Systems Analyst")).toBe("business_analyst");
    expect(extractTitleFamily("Requirements Analyst")).toBe("business_analyst");
    expect(extractTitleFamily("Functional Analyst")).toBe("business_analyst");
    expect(extractTitleFamily("Oracle Fusion Business Analyst")).toBe("business_analyst");
    // Must NOT steal the analyst variants owned by other families:
    expect(extractTitleFamily("Data Analyst")).toBe("data");
    expect(extractTitleFamily("Security Analyst")).toBe("security_grc");
    expect(extractTitleFamily("QA Analyst")).toBe("qa");
    // Unrelated titles must NOT classify as BA — so the talent-pool gate
    // rejects them for a BA role instead of dumping the whole pool:
    expect(extractTitleFamily("Registered Nurse")).not.toBe("business_analyst");
    expect(extractTitleFamily("Warehouse Manager")).not.toBe("business_analyst");
  });
});

describe("extractTitleFamily — non-engineering archetypes", () => {
  it("classifies project / programme / delivery managers", () => {
    expect(extractTitleFamily("Project Manager")).toBe("project_management");
    expect(extractTitleFamily("Senior Programme Manager")).toBe("project_management");
    expect(extractTitleFamily("Delivery Manager")).toBe("project_management");
    expect(extractTitleFamily("Scrum Master")).toBe("project_management");
    expect(extractTitleFamily("Release Train Engineer (RTE)")).toBe("project_management");
  });

  it("classifies product roles", () => {
    expect(extractTitleFamily("Product Manager")).toBe("product");
    expect(extractTitleFamily("Senior Product Owner")).toBe("product");
    expect(extractTitleFamily("Head of Product")).toBe("product");
  });

  it("classifies sales (including technical sales engineer)", () => {
    expect(extractTitleFamily("Account Executive")).toBe("sales");
    expect(extractTitleFamily("Business Development Manager")).toBe("sales");
    expect(extractTitleFamily("Technical Sales Engineer - POWER")).toBe("sales");
    expect(extractTitleFamily("Senior Sales Manager")).toBe("sales");
    expect(extractTitleFamily("Pre-Sales Consultant")).toBe("sales");
  });

  it("classifies support / service desk", () => {
    expect(extractTitleFamily("IT Support Specialist")).toBe("support_ops");
    expect(extractTitleFamily("Service Desk Analyst")).toBe("support_ops");
    expect(extractTitleFamily("Senior Technical Support Engineer")).toBe("support_ops");
    expect(extractTitleFamily("Tier 2 Support")).toBe("support_ops");
  });

  it("classifies security / GRC", () => {
    expect(extractTitleFamily("ISMS Lead")).toBe("security_grc");
    expect(extractTitleFamily("Compliance Manager")).toBe("security_grc");
    expect(extractTitleFamily("Information Security Manager")).toBe("security_grc");
    expect(extractTitleFamily("Cyber Security Analyst")).toBe("security_grc");
    expect(extractTitleFamily("CISO")).toBe("security_grc");
  });

  it("classifies finance / accounting", () => {
    expect(extractTitleFamily("Senior Accountant")).toBe("finance_accounting");
    expect(extractTitleFamily("Finance Manager")).toBe("finance_accounting");
    expect(extractTitleFamily("Financial Controller")).toBe("finance_accounting");
  });
});

describe("extractTitleFamily — edge cases", () => {
  it("returns null for empty / null / undefined", () => {
    expect(extractTitleFamily("")).toBeNull();
    expect(extractTitleFamily(null)).toBeNull();
    expect(extractTitleFamily(undefined)).toBeNull();
  });

  it("returns null for ambiguous titles (deliberate — don't gate on ambiguity)", () => {
    // These are real LinkedIn headlines that don't fit cleanly. We want them
    // to pass the gate rather than risk false-negative on a useful candidate.
    expect(extractTitleFamily("Solutions Lead")).toBeNull();
    expect(extractTitleFamily("Studying Cyber Security")).toBeNull();
    expect(extractTitleFamily("Consultant")).toBeNull();
    expect(extractTitleFamily("Specialist")).toBeNull();
  });
});

describe("titleFamiliesCompatible — sourcing gate logic (DIRECTIONAL: candidate → role)", () => {
  it("same family is always compatible", () => {
    expect(titleFamiliesCompatible("engineering", "engineering")).toBe(true);
    expect(titleFamiliesCompatible("project_management", "project_management")).toBe(true);
    expect(titleFamiliesCompatible("sales", "sales")).toBe(true);
  });

  it("engineering and engineering_management are compatible BOTH directions (IC ↔ manager moves)", () => {
    expect(titleFamiliesCompatible("engineering", "engineering_management")).toBe(true);
    expect(titleFamiliesCompatible("engineering_management", "engineering")).toBe(true);
  });

  it("engineering can apply to DevOps/QA/Data (adjacent IC) — and vice versa where listed", () => {
    expect(titleFamiliesCompatible("engineering", "devops_infra")).toBe(true);
    expect(titleFamiliesCompatible("devops_infra", "engineering")).toBe(true);
    expect(titleFamiliesCompatible("engineering", "qa")).toBe(true);
    expect(titleFamiliesCompatible("engineering", "data")).toBe(true);
    expect(titleFamiliesCompatible("data", "engineering")).toBe(true);
  });

  // Regression: previously this pair was bidirectional and Service Desk
  // Analysts surfaced on Senior SWE searches. Now ONE-WAY only.
  it("engineering → support_ops is fine (downshift) but support_ops → engineering is BLOCKED", () => {
    expect(titleFamiliesCompatible("engineering", "support_ops")).toBe(true);
    expect(titleFamiliesCompatible("support_ops", "engineering")).toBe(false);
  });

  it("qa → engineering is BLOCKED (the rarely-legit reverse move)", () => {
    expect(titleFamiliesCompatible("qa", "engineering")).toBe(false);
  });

  it("engineering_management and project_management compatible both ways (tech-PM track)", () => {
    expect(titleFamiliesCompatible("engineering_management", "project_management")).toBe(true);
    expect(titleFamiliesCompatible("project_management", "engineering_management")).toBe(true);
  });

  it("engineering (IC) and project_management (PM) are NOT compatible — different role family", () => {
    expect(titleFamiliesCompatible("engineering", "project_management")).toBe(false);
  });

  it("sales / marketing / finance / HR are NOT compatible with engineering (the C++-on-PM bug class)", () => {
    expect(titleFamiliesCompatible("sales", "engineering")).toBe(false);
    expect(titleFamiliesCompatible("engineering", "sales")).toBe(false);
    expect(titleFamiliesCompatible("marketing", "engineering")).toBe(false);
    expect(titleFamiliesCompatible("finance_accounting", "engineering")).toBe(false);
    expect(titleFamiliesCompatible("hr_recruiting", "engineering")).toBe(false);
  });

  it("returns true when EITHER side is null (don't reject on ambiguous titles)", () => {
    expect(titleFamiliesCompatible(null, "engineering")).toBe(true);
    expect(titleFamiliesCompatible("project_management", null)).toBe(true);
    expect(titleFamiliesCompatible(undefined, "sales")).toBe(true);
  });
});

describe("candidateTitleFitsRole — composed check", () => {
  it("Senior C++ Developer applying to Project Manager role → REJECT", () => {
    expect(candidateTitleFitsRole("Project Manager", "Senior C++ Developer at Finalmouse")).toBe(false);
  });

  // Critic-flagged regression: previously the support_ops ↔ engineering pair
  // was bidirectional, surfacing Service Desk Analysts on Senior SWE searches.
  it("Service Desk Analyst applying to Senior Software Engineer role → REJECT", () => {
    expect(candidateTitleFitsRole("Senior Software Engineer", "Service Desk Analyst at Spark")).toBe(false);
  });

  // Inverse: engineering → support_ops is still allowed (downshift / restart)
  it("Senior Software Engineer applying to a Support Engineer role → ACCEPT (downshift)", () => {
    expect(candidateTitleFitsRole("Technical Support Engineer", "Senior Software Engineer at Xero")).toBe(true);
  });

  it("Senior Software Engineer applying to Software Engineer role → ACCEPT", () => {
    expect(candidateTitleFitsRole("Software Engineer", "Senior Software Engineer at Xero")).toBe(true);
  });

  it("Engineering Manager applying to Project Manager role → ACCEPT (compatible families)", () => {
    expect(candidateTitleFitsRole("Project Manager", "Engineering Manager at Datacom")).toBe(true);
  });

  it("Account Executive applying to Software Engineer role → REJECT", () => {
    expect(candidateTitleFitsRole("Software Engineer", "Account Executive — SaaS Enterprise")).toBe(false);
  });

  it("ambiguous candidate headline (Solutions Lead) → ACCEPT (don't filter on unknown)", () => {
    expect(candidateTitleFitsRole("Project Manager", "Solutions Lead at Vector")).toBe(true);
  });

  it("ambiguous role title → ACCEPT all (gate disabled when role can't be classified)", () => {
    expect(candidateTitleFitsRole("Specialist", "Senior Marketing Manager")).toBe(true);
  });
});
