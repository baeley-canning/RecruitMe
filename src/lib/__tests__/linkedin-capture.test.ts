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

  it("strips connection-prompt chrome and activity lines while keeping the real profile", () => {
    // Mirrors the real post-first-fix sample: LinkedIn renders the
    // Highlights / "Get introduced" / mutual-connection / "Message top
    // connections" block ABOVE the About + Experience, plus follower counts
    // and an activity post line. All of that must go; About/Experience stays.
    const dirtyCapture = `
Sachin Mohanan
Senior Software Engineer at Datacom
Wellington, New Zealand
Highlights
Han, Teresa and 1 other mutual connection
Get introduced to Sachin
Ask your mutual connections to help you start a conversation.
Message top connections
Now is a great time to start a conversation.
Introduce myself
Rebecca Livingston and Ritu Gupta are mutual connections
1,056 followers
342 connections
1mo • We are hiring across our platform engineering teams
About
Highlights of my career include leading the platform team and connecting teams across 3 offices.
Experience
Senior Software Engineer
Datacom
Jan 2020 - Present
`;

    const cleaned = sanitizeCapturedLinkedInText(dirtyCapture);

    // Real profile content survives.
    expect(cleaned).toContain("Sachin Mohanan");
    expect(cleaned).toContain("Senior Software Engineer at Datacom");
    expect(cleaned).toContain("Wellington, New Zealand");
    expect(cleaned).toContain("About");
    expect(cleaned).toContain("Experience");
    expect(cleaned).toContain("Datacom");
    // An About sentence that merely *contains* "Highlights"/"connecting" is kept.
    expect(cleaned).toContain("Highlights of my career include leading the platform team");

    // Connection-prompt chrome + counts + activity line are all gone.
    expect(cleaned).not.toMatch(/^Highlights$/m);
    expect(cleaned).not.toContain("Han, Teresa and 1 other mutual connection");
    expect(cleaned).not.toContain("Get introduced to Sachin");
    expect(cleaned).not.toContain("Ask your mutual connections to help you start a conversation.");
    expect(cleaned).not.toContain("Message top connections");
    expect(cleaned).not.toContain("Now is a great time to start a conversation.");
    expect(cleaned).not.toMatch(/^Introduce myself$/m);
    expect(cleaned).not.toContain("are mutual connections");
    expect(cleaned).not.toContain("1,056 followers");
    expect(cleaned).not.toContain("342 connections");
    expect(cleaned).not.toContain("We are hiring across our platform engineering teams");
    // None of the prompt-chrome regexes the owner flagged should survive.
    expect(cleaned).not.toMatch(
      /(Now is a great time to start a conversation|are mutual connections|Introduce myself)/
    );
  });

  it("stops at the 'People also viewed' / 'Others named' sidebar block", () => {
    // D3: the right-rail recommendation block (People also viewed / Others
    // named / Promoted) was NOT in the stop-list, so unrelated sidebar people
    // bled into the captured profileText.
    const dirtyCapture = `
Owen Bannister
Artificial Intelligence Practice Lead
Wellington, New Zealand
About
I have worked across the full software lifecycle with Python and cloud services.
People also viewed
Sam Haines
General Manager at Datacom Systems Ltd
Others named Owen Bannister
Owen Bannister
Sales Director at SomewhereElse
Promoted
Acme is hiring senior engineers
Suggested for you
`;

    const cleaned = sanitizeCapturedLinkedInText(dirtyCapture);

    expect(cleaned).toContain("Owen Bannister");
    expect(cleaned).toContain("About");
    expect(cleaned).not.toContain("People also viewed");
    expect(cleaned).not.toContain("Sam Haines");
    expect(cleaned).not.toContain("Others named");
    expect(cleaned).not.toContain("Sales Director at SomewhereElse");
    expect(cleaned).not.toContain("Promoted");
    expect(cleaned).not.toContain("Suggested for you");
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

  it("leaves the headline empty when the first line after the name is a bare company/nav word", () => {
    // D5: previously the headline was just "the first non-meta line after the
    // name", so a bare company name ("Datacom") or stray token got stored as
    // the candidate's headline. The positive heuristic now rejects single
    // bare tokens that don't look like a role/headline.
    const capture = `Owen Bannister
Datacom
Wellington, New Zealand
About
I have shipped reliable software for over ten years and love mentoring.`;

    const result = extractIdentityFromLinkedInProfileText(capture);
    expect(result.name).toBe("Owen Bannister");
    expect(result.headline).toBe(""); // bare "Datacom" rejected, not stored as headline
    expect(result.location).toBe("Wellington, New Zealand");
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
