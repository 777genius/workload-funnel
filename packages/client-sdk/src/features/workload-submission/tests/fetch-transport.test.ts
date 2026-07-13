import { describe, expect, it, vi } from "vitest";

import { createFetchSdkTransport } from "@workload-funnel/client-sdk/workload-submission";

describe("Phase 5 bounded SDK fetch transport", () => {
  it("keeps credentials on the configured origin and bounds streamed responses", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("12345", { status: 200 }));
    const transport = createFetchSdkTransport({
      baseUrl: "https://api.example.test",
      bearerToken: () => "sdk-token",
      fetchImplementation,
      maximumResponseBytes: 4,
    });

    await expect(
      transport.request({ method: "GET", path: "//attacker.example/v1" }),
    ).rejects.toThrow("invalid_api_path");
    expect(fetchImplementation).not.toHaveBeenCalled();
    await expect(
      transport.request({ method: "GET", path: "/v1/capacity" }),
    ).rejects.toMatchObject({ code: "response_too_large", status: 502 });
    const call = fetchImplementation.mock.calls[0];
    if (call === undefined) throw new Error("fetch_call_missing");
    expect(call[0]).toEqual(new URL("https://api.example.test/v1/capacity"));
    expect(call[1]?.redirect).toBe("error");
    expect(new Headers(call[1]?.headers).get("authorization")).toBe(
      "Bearer sdk-token",
    );
  });
});
