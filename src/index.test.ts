import { describe, expect, test } from "bun:test";
import app from "./index";

describe("demo route", () => {
  test("runs the security loop demo endpoint", async () => {
    const response = await app.request("/demo/security-loop/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scenario: "openclaw-secret-leak",
      }),
    });

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      loopStatus?: string;
      proposal?: unknown;
      before?: { audit?: { decision?: string } };
      after?: { audit?: { decision?: string } };
    };

    expect(payload.before?.audit?.decision).toBe("block");
    expect(payload.proposal).toBeDefined();
    expect(payload.after?.audit?.decision).toBe("allow");
    expect(payload.loopStatus).toBe("mitigated");
  });
});
