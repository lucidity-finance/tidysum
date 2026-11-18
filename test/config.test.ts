import { describe, expect, it } from "vitest";
import { isLoopbackHost, loadServerConfig } from "../src/config.js";

describe("server config", () => {
  const admin = "a".repeat(32);

  it("treats empty optional values as unset, as .env.example leaves them", () => {
    const c = loadServerConfig({
      TIDYSUM_ADMIN_TOKEN: admin,
      TIDYSUM_PUBLIC_URL: "",
      TIDYSUM_MCP_TOKEN: "",
    });
    expect(c.TIDYSUM_PUBLIC_URL).toBeUndefined();
    expect(c.TIDYSUM_MCP_TOKEN).toBeUndefined();
  });

  it("still rejects a short MCP token and a non-https public URL", () => {
    expect(() =>
      loadServerConfig({ TIDYSUM_ADMIN_TOKEN: admin, TIDYSUM_MCP_TOKEN: "short" }),
    ).toThrow(/TIDYSUM_MCP_TOKEN/);
    expect(() =>
      loadServerConfig({ TIDYSUM_ADMIN_TOKEN: admin, TIDYSUM_PUBLIC_URL: "http://example.com" }),
    ).toThrow(/https/);
  });

  it("needs an admin token only when HOST is reachable from other machines", () => {
    expect(loadServerConfig({}).TIDYSUM_ADMIN_TOKEN).toBeUndefined();
    expect(loadServerConfig({ HOST: "localhost", TIDYSUM_ADMIN_TOKEN: "" }).HOST).toBe("localhost");
    expect(() => loadServerConfig({ HOST: "0.0.0.0" })).toThrow(/TIDYSUM_ADMIN_TOKEN/);
    expect(loadServerConfig({ HOST: "0.0.0.0", TIDYSUM_ADMIN_TOKEN: admin }).HOST).toBe("0.0.0.0");
  });
});

describe("isLoopbackHost", () => {
  it("accepts only loopback names and addresses", () => {
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "LOCALHOST"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ["0.0.0.0", "192.168.1.5", "evil.example", "localhost.evil.example", "::"]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});
