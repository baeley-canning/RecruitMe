import { describe, expect, it } from "vitest";
import {
  extractIdentityFromLinkedInProfileText,
  sanitizeCapturedLinkedInText,
} from "../linkedin-capture";

describe("sanitizeCapturedLinkedInText", () => {
  it("removes LinkedIn page chrome and unrelated sidebar profiles", () => {
    const dirtyCapture = `
Owen Bannister
Artificial Intelligence Practice Lead
Wellington, New Zealand
Datacom
Victoria University of Wellington
About
I have worked across the full software lifecycle with Python, ROR, React, and Cloud services.
Top skills
Ruby on Rails • JavaScript • React.js • AWS • Python (Programming Language)
Activity
285 followers
Owen has no recent posts
More profiles for you
Sam Haines
General Manager at Datacom Systems Ltd
People you may know
Oliver Persson
Personal Assistant to Chief Executive Officer at Apple
Pages for you
Kiwibank
LinkedIn Corporation © 2026
Select language
English
`;

    const cleaned = sanitizeCapturedLinkedInText(dirtyCapture);

    expect(cleaned).toContain("Owen Bannister");
    expect(cleaned).toContain("About");
    expect(cleaned).toContain("Top skills");
    expect(cleaned).not.toContain("More profiles for you");
    expect(cleaned).not.toContain("People you may know");
    expect(cleaned).not.toContain("Kiwibank");
    expect(cleaned).not.toContain("LinkedIn Corporation");
    expect(cleaned).not.toContain("Select language");
  });

  it("keeps real section content while dropping show-all placeholders", () => {
    const structuredCapture = `
Jane Doe
Senior Software Engineer
Auckland, New Zealand
Experience
Principal Engineer
Example Labs
Jan 2022 - Present
Leading AI platform delivery across product and platform teams.
Show all 5 experiences
Education
Victoria University of Wellington
Bachelor of Engineering
2015 - 2018
See all 2 education entries
Top skills
TypeScript • React • Node.js
`;

    const cleaned = sanitizeCapturedLinkedInText(structuredCapture);

    expect(cleaned).toContain("Experience");
    expect(cleaned).toContain("Principal Engineer");
    expect(cleaned).toContain("Education");
    expect(cleaned).toContain("Victoria University of Wellington");
    expect(cleaned).toContain("Top skills");
    expect(cleaned).not.toContain("Show all 5 experiences");
    expect(cleaned).not.toContain("See all 2 education entries");
  });
});

describe("extractIdentityFromLinkedInProfileText", () => {
  it("pulls name, headline, and location from the intro lines of a captured profile", () => {
    const capture = `Owen Bannister
Artificial Intelligence Practice Lead
Wellington, New Zealand
Datacom
Victoria University of Wellington
About
I have worked across the full software lifecycle with Python, Rails, React, and cloud services.`;

    expect(extractIdentityFromLinkedInProfileText(capture)).toEqual({
      name: "Owen Bannister",
      headline: "Artificial Intelligence Practice Lead",
      location: "Wellington, New Zealand",
    });
  });

  it("does not mistake org lines for the headline or location", () => {
    const capture = `Priya Sodhi
She/Her
Engineer at Xero | RubyOnRails | React
Wellington, Wellington, New Zealand
Xero
Whitireia Community Polytechnic
About
Software developer based in Wellington.`;

    expect(extractIdentityFromLinkedInProfileText(capture)).toEqual({
      name: "Priya Sodhi",
      headline: "Engineer at Xero | RubyOnRails | React",
      location: "Wellington, Wellington, New Zealand",
    });
  });

  it("does not treat comma-separated headline text as location", () => {
    const capture = `Owen Nicholson
Specialist in Training Design, Development and Delivery at Multiple Clients
About
I design and deliver training programmes for clients.`;

    expect(extractIdentityFromLinkedInProfileText(capture)).toEqual({
      name: "Owen Nicholson",
      headline: "Specialist in Training Design, Development and Delivery at Multiple Clients",
      location: "",
    });
  });
});
