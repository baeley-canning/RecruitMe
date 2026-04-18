import { describe, expect, it } from "vitest";
import { getNearestCity } from "../nz-cities";

describe("getNearestCity", () => {
  it("returns Wellington for a point inside central Wellington", () => {
    const city = getNearestCity(-41.29, 174.78);
    expect(city?.name).toBe("Wellington");
  });

  it("returns Christchurch for a point inside Christchurch", () => {
    const city = getNearestCity(-43.53, 172.63);
    expect(city?.name).toBe("Christchurch");
  });
});
