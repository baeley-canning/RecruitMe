import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    setting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { GET, PUT } from "./route";

describe("candidate profile settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
  });

  it("loads org-scoped candidate profile settings", async () => {
    dbMocks.prisma.setting.findUnique.mockResolvedValue({
      key: "candidate-profile-settings:org-1",
      value: JSON.stringify({
        consultant: { name: "Baeley", email: "baeley@placeme.nz", phone: "021" },
        manager: { name: "Client Manager", email: "client@example.com", phone: "022" },
      }),
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(dbMocks.prisma.setting.findUnique).toHaveBeenCalledWith({
      where: { key: "candidate-profile-settings:org-1" },
    });
    expect(body.settings.consultant.name).toBe("Baeley");
  });

  it("saves candidate profile settings server-side", async () => {
    const payload = {
      consultant: { name: "Baeley", email: "baeley@placeme.nz", phone: "021" },
      manager: { name: "Client Manager", email: "client@example.com", phone: "022" },
    };

    const res = await PUT(new Request("http://localhost/api/candidate-profiles/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }));

    expect(res.status).toBe(200);
    expect(dbMocks.prisma.setting.upsert).toHaveBeenCalledWith({
      where: { key: "candidate-profile-settings:org-1" },
      update: { value: JSON.stringify(payload) },
      create: { key: "candidate-profile-settings:org-1", value: JSON.stringify(payload) },
    });
  });
});
