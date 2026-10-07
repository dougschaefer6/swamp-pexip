import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  DEFAULT_MEETING_TYPE,
  isLegacyRegexRule,
  LEGACY_REGEX_MEETING_TYPE,
  MEETING_TYPE_ALIASES,
  MEETING_TYPES,
  meetingRuleWarnings,
  model,
  normalizeMeetingType,
  RE2_REGEX_MEETING_TYPE,
} from "./otj.ts";

interface Captured {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

interface Reply {
  status?: number;
  body?: unknown;
}

const PROFILE_URI = "/api/admin/configuration/v1/mjx_integration/7/";
const PROFILE = { name: "OTJ-Main", resource_uri: PROFILE_URI };

/**
 * Swap `globalThis.fetch` for a stub that records calls and answers through
 * `route` (default: 200 with `{}`). Returns a restore function.
 */
function mockFetch(
  calls: Captured[],
  route: (c: Captured) => Reply | undefined = () => undefined,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const c: Captured = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(c);
    const reply = route(c) ?? {};
    const status = reply.status ?? 200;
    return Promise.resolve(
      status === 201 || status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(reply.body ?? {}), {
          status,
          headers: { "content-type": "application/json" },
        }),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Standard OTJ routes: profile lookup by name, rule POST answers 201. */
function otjRoutes(
  rules: Array<Record<string, unknown>> = [],
): (c: Captured) => Reply | undefined {
  return (c) => {
    const u = new URL(c.url);
    if (u.pathname.endsWith("/mjx_integration/")) {
      const objects = [PROFILE].filter((p) =>
        p.name === u.searchParams.get("name")
      );
      return { body: { meta: { total_count: objects.length }, objects } };
    }
    if (u.pathname.endsWith("/mjx_meeting_processing_rule/")) {
      if (c.method === "POST") return { status: 201 };
      const name = u.searchParams.get("name");
      const objects = name ? rules.filter((r) => r.name === name) : rules;
      return { body: { meta: { total_count: objects.length }, objects } };
    }
    if (c.method === "PATCH" || c.method === "DELETE") return { status: 204 };
    const byId = rules.find((r) => r.resource_uri === u.pathname);
    if (byId) return { body: byId };
    return { status: 404, body: {} };
  };
}

/** A fake method context that records log lines and `writeResource` calls. */
function fakeContext() {
  const infos: string[] = [];
  const warnings: string[] = [];
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const ctx = {
    globalArgs: {
      host: "pexip.example.com",
      username: "admin",
      password: "test-pass",
      verifySsl: true,
    },
    logger: {
      info: (msg: string) => infos.push(msg),
      warning: (msg: string) => warnings.push(msg),
    },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name, specName: spec });
    },
  };
  return { ctx, infos, warnings, writes };
}

// deno-lint-ignore no-explicit-any
const methods = model.methods as Record<string, any>;

function parseCreate(extra: Record<string, unknown>) {
  return methods.createMeetingRule.arguments.parse({
    name: "custom",
    profile: "OTJ-Main",
    matchString: "^sip:(.*)@example\\.com$",
    ...extra,
  });
}

Deno.test("model version ends its upgrade chain at the current version", () => {
  assertEquals(model.version, "2026.10.07.1");
  const last = model.upgrades[model.upgrades.length - 1];
  assertEquals(last.toVersion, model.version);
  const old = { host: "pexip.example.com" };
  assertEquals(last.upgradeAttributes(old), old);
});

Deno.test("meeting types match the Pexip provider and aliases map to them", () => {
  assertEquals(MEETING_TYPES.length, 19);
  assert((MEETING_TYPES as readonly string[]).includes(DEFAULT_MEETING_TYPE));
  assertEquals(DEFAULT_MEETING_TYPE, "pexipinfinity");
  for (const [alias, real] of Object.entries(MEETING_TYPE_ALIASES)) {
    assert((MEETING_TYPES as readonly string[]).includes(real));
    assertEquals(normalizeMeetingType(alias), real);
  }
  assertEquals(normalizeMeetingType("teams"), "teams");
  assertThrows(() => normalizeMeetingType("bogus"));
});

Deno.test("createMeetingRule arguments accept real types, aliases and regex", () => {
  const schema = methods.createMeetingRule.arguments;
  for (
    const t of [
      RE2_REGEX_MEETING_TYPE,
      LEGACY_REGEX_MEETING_TYPE,
      "polyteamsbody",
      "googlemeetsipguestjoin",
      "google_meet",
    ]
  ) {
    assertEquals(parseCreate({ meetingType: t }).meetingType, t);
  }
  assertEquals(parseCreate({}).meetingType, "pexipinfinity");
  assertThrows(() => parseCreate({ meetingType: "bogus" }));
  assertThrows(() => schema.parse({ name: "r", matchString: ".*" })); // no profile
});

Deno.test("meetingRuleWarnings flags legacy Regex and single-host Teams patterns", () => {
  assertEquals(meetingRuleWarnings(RE2_REGEX_MEETING_TYPE, ".*"), []);
  assertEquals(meetingRuleWarnings(LEGACY_REGEX_MEETING_TYPE, ".*").length, 1);
  const plain = meetingRuleWarnings("teams", "https://teams.microsoft.com/.*");
  assertEquals(plain.length, 1);
  assert(plain[0].includes("teams.cloud.microsoft"));
  const escaped = meetingRuleWarnings(
    RE2_REGEX_MEETING_TYPE,
    "https://teams\\.microsoft\\.com/l/meetup-join/(.*)",
  );
  assertEquals(escaped.length, 1);
  assertEquals(
    meetingRuleWarnings(
      RE2_REGEX_MEETING_TYPE,
      "https://teams\\.(microsoft\\.com|cloud\\.microsoft)/.*",
    ).length,
    0, // alternation spells neither host literally, so nothing to compare
  );
  assertEquals(
    meetingRuleWarnings(
      RE2_REGEX_MEETING_TYPE,
      "teams\\.microsoft\\.com|teams\\.cloud\\.microsoft",
    ),
    [],
  );
});

Deno.test("createMeetingRule resolves the profile and posts the real field names", async () => {
  const calls: Captured[] = [];
  const restore = mockFetch(calls, otjRoutes());
  try {
    const { ctx, infos, warnings, writes } = fakeContext();
    await methods.createMeetingRule.execute(
      parseCreate({
        meetingType: RE2_REGEX_MEETING_TYPE,
        replaceString: "\\1",
      }),
      ctx,
    );
    assertEquals(calls.length, 2);
    assert(calls[0].url.includes("/mjx_integration/"));
    const post = calls[1];
    assert(post.url.endsWith("/mjx_meeting_processing_rule/"));
    assertEquals(post.method, "POST");
    assertEquals(post.body?.mjx_integration, PROFILE_URI);
    assertEquals(post.body?.enabled, true);
    assert(!("enable" in (post.body ?? {})));
    assertEquals(post.body?.meeting_type, RE2_REGEX_MEETING_TYPE);
    assertEquals(post.body?.default_processing_enabled, true);
    assertEquals(post.body?.replace_string, "\\1");
    assertEquals(warnings, []);
    assert(!infos.some((m) => m.includes("deprecated")));
    assertEquals(writes[0].data.legacyRegex, false);
  } finally {
    restore();
  }
});

Deno.test("createMeetingRule sends the real value for an alias and passes a profile URI through", async () => {
  const calls: Captured[] = [];
  const restore = mockFetch(calls, otjRoutes());
  try {
    const { ctx } = fakeContext();
    await methods.createMeetingRule.execute(
      parseCreate({
        meetingType: "skype_for_business",
        profile: "/api/admin/configuration/v1/mjx_integration/12",
        defaultProcessingEnabled: false,
        enabled: false,
      }),
      ctx,
    );
    assertEquals(calls.length, 1); // no profile lookup for a URI
    assertEquals(calls[0].body?.meeting_type, "s4b");
    assertEquals(
      calls[0].body?.mjx_integration,
      "/api/admin/configuration/v1/mjx_integration/12/",
    );
    assertEquals(calls[0].body?.enabled, false);
    assertEquals(calls[0].body?.default_processing_enabled, false);
  } finally {
    restore();
  }
});

Deno.test("createMeetingRule fails clearly when the profile name does not resolve", async () => {
  const calls: Captured[] = [];
  const restore = mockFetch(calls, otjRoutes());
  try {
    const { ctx } = fakeContext();
    await assertRejects(
      () =>
        methods.createMeetingRule.execute(
          parseCreate({ profile: "No-Such-Profile" }),
          ctx,
        ),
      Error,
      "OTJ profile not found: 'No-Such-Profile'",
    );
    assert(!calls.some((c) => c.method === "POST"));
  } finally {
    restore();
  }
});

Deno.test("createMeetingRule surfaces a 400 from the API", async () => {
  const calls: Captured[] = [];
  const base = otjRoutes();
  const restore = mockFetch(
    calls,
    (c) =>
      c.method === "POST"
        ? { status: 400, body: { meeting_type: ["invalid choice"] } }
        : base(c),
  );
  try {
    const { ctx, writes } = fakeContext();
    await assertRejects(
      () => methods.createMeetingRule.execute(parseCreate({}), ctx),
      Error,
      "Pexip API 400",
    );
    assertEquals(writes, []);
  } finally {
    restore();
  }
});

Deno.test("createMeetingRule logs legacy Regex at info level and records it", async () => {
  const calls: Captured[] = [];
  const restore = mockFetch(calls, otjRoutes());
  try {
    const { ctx, infos, warnings, writes } = fakeContext();
    await methods.createMeetingRule.execute(
      parseCreate({ meetingType: LEGACY_REGEX_MEETING_TYPE }),
      ctx,
    );
    assertEquals(warnings, []);
    assert(infos.some((m) => m.includes("deprecated")));
    assertEquals(calls[1].body?.meeting_type, LEGACY_REGEX_MEETING_TYPE);
    assertEquals(writes[0].data.legacyRegex, true);
    assertEquals((writes[0].data.deprecationWarnings as string[]).length, 1);
  } finally {
    restore();
  }
});

Deno.test("listMeetingRules reports, flags and filters legacy Regex rules", async () => {
  const rules = [
    { name: "old", meeting_type: LEGACY_REGEX_MEETING_TYPE },
    { name: "new", meeting_type: RE2_REGEX_MEETING_TYPE },
    { name: "teams", meeting_type: "teams" },
  ];
  assertEquals(rules.filter(isLegacyRegexRule).map((r) => r.name), ["old"]);

  const calls: Captured[] = [];
  const restore = mockFetch(calls, otjRoutes(rules));
  try {
    const all = fakeContext();
    await methods.listMeetingRules.execute(
      methods.listMeetingRules.arguments.parse({}),
      all.ctx,
    );
    const ruleWrites = all.writes.filter((w) => w.spec === "meetingRule");
    assertEquals(ruleWrites.length, 3);
    assertEquals(ruleWrites[0].data.legacyRegex, true);
    assertEquals(ruleWrites[1].data.legacyRegex, false);
    const audit = all.writes.find((w) => w.spec === "meetingRuleAudit");
    assertEquals(audit?.data.legacyRegexCount, 1);
    assertEquals(audit?.data.legacyRegexRules, ["old"]);
    assertEquals(all.warnings, []);
    assert(all.infos.some((m) => m.includes("deprecated Regex")));

    const legacy = fakeContext();
    await methods.listMeetingRules.execute(
      methods.listMeetingRules.arguments.parse({ legacyRegexOnly: true }),
      legacy.ctx,
    );
    assertEquals(
      legacy.writes.filter((w) => w.spec === "meetingRule").map((w) => w.name),
      ["old"],
    );
  } finally {
    restore();
  }
});

const RULE_URI = "/api/admin/configuration/v1/mjx_meeting_processing_rule/5/";

Deno.test("updateMeetingRule PATCHes only the given fields with real values", async () => {
  const rules = [{
    name: "old",
    meeting_type: LEGACY_REGEX_MEETING_TYPE,
    match_string: ".*",
    resource_uri: RULE_URI,
  }];
  const calls: Captured[] = [];
  const restore = mockFetch(calls, otjRoutes(rules));
  try {
    const { ctx, writes } = fakeContext();
    await methods.updateMeetingRule.execute(
      methods.updateMeetingRule.arguments.parse({
        name: "old",
        meetingType: RE2_REGEX_MEETING_TYPE,
        enabled: false,
        replaceString: "\\1",
      }),
      ctx,
    );
    const patch = calls.find((c) => c.method === "PATCH");
    assert(patch?.url.endsWith("/mjx_meeting_processing_rule/5/"));
    assertEquals(patch?.body, {
      meeting_type: RE2_REGEX_MEETING_TYPE,
      enabled: false,
      replace_string: "\\1",
    });
    assertEquals(writes[0].data.legacyRegex, false);
  } finally {
    restore();
  }
});

Deno.test("deleteMeetingRule refuses ambiguity, honours dryRun, then deletes", async () => {
  const dupes = [
    { name: "dup", resource_uri: RULE_URI },
    {
      name: "dup",
      resource_uri:
        "/api/admin/configuration/v1/mjx_meeting_processing_rule/6/",
    },
  ];
  const calls: Captured[] = [];
  const restore = mockFetch(calls, otjRoutes(dupes));
  try {
    const { ctx } = fakeContext();
    const schema = methods.deleteMeetingRule.arguments;
    await assertRejects(
      () =>
        methods.deleteMeetingRule.execute(schema.parse({ name: "dup" }), ctx),
      Error,
      "pass id",
    );
    await assertRejects(
      () =>
        methods.deleteMeetingRule.execute(schema.parse({ name: "nope" }), ctx),
      Error,
      "not found",
    );
    await methods.deleteMeetingRule.execute(
      schema.parse({ name: "dup", id: 5, dryRun: true }),
      ctx,
    );
    assert(!calls.some((c) => c.method === "DELETE"));
  } finally {
    restore();
  }

  const calls2: Captured[] = [];
  const restore2 = mockFetch(
    calls2,
    (c) => c.method === "GET" ? { body: dupes[0] } : { status: 204 },
  );
  try {
    const { ctx } = fakeContext();
    await methods.deleteMeetingRule.execute(
      methods.deleteMeetingRule.arguments.parse({ name: "dup", id: 5 }),
      ctx,
    );
    const del = calls2.find((c) => c.method === "DELETE");
    assert(del?.url.endsWith("/mjx_meeting_processing_rule/5/"));
  } finally {
    restore2();
  }
});
