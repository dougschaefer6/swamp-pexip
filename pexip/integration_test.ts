import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { model, SYSLOG_PROTO_FORMATS } from "./integration.ts";

interface Captured {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

/**
 * Swap `globalThis.fetch` for a stub that records calls and answers 201
 * with no body, as Infinity does for a successful POST. Returns a restore
 * function.
 */
function mockFetch(
  calls: Captured[],
  existing: Array<Record<string, unknown>> = [],
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            meta: { total_count: existing.length },
            objects: existing,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return Promise.resolve(new Response(null, { status: 201 }));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function fakeContext() {
  return {
    globalArgs: {
      host: "pexip.example.com",
      username: "admin",
      password: "test-pass",
      verifySsl: true,
    },
    logger: { info: () => {}, warning: () => {} },
    writeResource: () => Promise.resolve({}),
  };
}

// deno-lint-ignore no-explicit-any
const methods = model.methods as Record<string, any>;

async function runSyslog(
  input: Record<string, unknown>,
  existing: Array<Record<string, unknown>> = [],
): Promise<Captured> {
  const calls: Captured[] = [];
  const restore = mockFetch(calls, existing);
  try {
    const args = methods.configureSyslog.arguments.parse({
      serverAddress: "syslog.example.com",
      ...input,
    });
    await methods.configureSyslog.execute(args, fakeContext());
  } finally {
    restore();
  }
  assertEquals(calls.length, 1);
  return calls[0];
}

Deno.test("model version ends its upgrade chain at the current version", () => {
  assertEquals(model.version, "2026.10.08.1");
  const last = model.upgrades[model.upgrades.length - 1];
  assertEquals(last.toVersion, model.version);
  const old = { host: "pexip.example.com" };
  assertEquals(last.upgradeAttributes(old), old);
});

Deno.test("configureSyslog omits v41 fields when not provided", async () => {
  const call = await runSyslog({});
  assertEquals(call.method, "POST");
  assertEquals(
    new URL(call.url).pathname,
    "/api/admin/configuration/v1/syslog_server/",
  );
  assertEquals(call.body, {
    address: "syslog.example.com",
    port: 514,
    transport: "udp",
  });
});

Deno.test("configureSyslog PATCHes an existing server with the same address and port", async () => {
  const uri = "/api/admin/configuration/v1/syslog_server/7/";
  const call = await runSyslog({ protocol: "tls", port: 6514 }, [
    { address: "syslog.example.com", port: 514, resource_uri: "/x/1/" },
    { address: "syslog.example.com", port: 6514, resource_uri: uri },
  ]);
  assertEquals(call.method, "PATCH");
  assertEquals(new URL(call.url).pathname, uri);
  assertEquals(call.body?.transport, "tls");
});

Deno.test("configureSyslog sends description only when set", async () => {
  const call = await runSyslog({ description: "SIEM" });
  assertEquals(call.body?.description, "SIEM");
  assertEquals("enabled" in (call.body ?? {}), false);
});

Deno.test("configureSyslog sends proto_format and log toggles when set", async () => {
  const call = await runSyslog({
    protoFormat: "rfc5424",
    auditLog: true,
    supportLog: false,
    webLog: true,
  });
  assertEquals(call.body?.proto_format, "rfc5424");
  assertEquals(call.body?.audit_log, true);
  assertEquals(call.body?.support_log, false);
  assertEquals(call.body?.web_log, true);
});

Deno.test("configureSyslog sends only the toggles that are set", async () => {
  const call = await runSyslog({ supportLog: true });
  assertEquals(call.body?.support_log, true);
  assertEquals("audit_log" in (call.body ?? {}), false);
  assertEquals("web_log" in (call.body ?? {}), false);
  assertEquals("proto_format" in (call.body ?? {}), false);
});

Deno.test("configureSyslog protoFormat accepts only the schema choices", () => {
  assertEquals([...SYSLOG_PROTO_FORMATS], ["pexip", "rfc3164", "rfc5424"]);
  for (const f of SYSLOG_PROTO_FORMATS) {
    methods.configureSyslog.arguments.parse({
      serverAddress: "syslog.example.com",
      protoFormat: f,
    });
  }
  assertThrows(() =>
    methods.configureSyslog.arguments.parse({
      serverAddress: "syslog.example.com",
      protoFormat: "RFC3164",
    })
  );
});
