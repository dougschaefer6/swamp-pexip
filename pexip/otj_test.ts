import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  isLegacyRegexRule,
  LEGACY_REGEX_MEETING_TYPE,
  meetingRuleWarnings,
  model,
  RE2_REGEX_MEETING_TYPE,
} from "./otj.ts";

interface Captured {
  url: string;
  init?: RequestInit;
}

/** Swap `globalThis.fetch` for a stub that records calls; returns a restore function. */
function mockFetch(calls: Captured[], body: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** A fake method context that records warnings and `writeResource` calls. */
function fakeContext() {
  const warnings: string[] = [];
  const writes: Array<{ spec: string; name: string }> = [];
  const ctx = {
    globalArgs: {
      host: "pexip.example.com",
      username: "admin",
      password: "test-pass",
      verifySsl: true,
    },
    logger: {
      info: () => {},
      warning: (msg: string) => warnings.push(msg),
    },
    writeResource: (spec: string, name: string) => {
      writes.push({ spec, name });
      return Promise.resolve({ name, specName: spec });
    },
  };
  return { ctx, warnings, writes };
}

// deno-lint-ignore no-explicit-any
const methods = model.methods as Record<string, any>;

Deno.test("model version ends its upgrade chain at the current version", () => {
  assertEquals(model.version, "2026.10.07.1");
  const last = model.upgrades[model.upgrades.length - 1];
  assertEquals(last.toVersion, model.version);
  const old = { host: "pexip.example.com" };
  assertEquals(last.upgradeAttributes(old), old);
});

Deno.test("createMeetingRule accepts Regex RE2 and legacy Regex", () => {
  const schema = methods.createMeetingRule.arguments;
  for (const t of [RE2_REGEX_MEETING_TYPE, LEGACY_REGEX_MEETING_TYPE]) {
    const parsed = schema.parse({
      name: "r",
      matchString: ".*",
      meetingType: t,
    });
    assertEquals(parsed.meetingType, t);
  }
  assertThrows(() =>
    schema.parse({ name: "r", matchString: ".*", meetingType: "bogus" })
  );
});

Deno.test("meetingRuleWarnings flags legacy Regex and old Teams host", () => {
  assertEquals(meetingRuleWarnings(RE2_REGEX_MEETING_TYPE, ".*"), []);
  assertEquals(
    meetingRuleWarnings(LEGACY_REGEX_MEETING_TYPE, ".*").length,
    1,
  );
  const teams = meetingRuleWarnings("teams", "https://teams.microsoft.com/.*");
  assertEquals(teams.length, 1);
  assert(teams[0].includes("teams.cloud.microsoft"));
});

Deno.test("createMeetingRule posts the RE2 type without warnings", async () => {
  const calls: Captured[] = [];
  const restore = mockFetch(calls, { id: 1 });
  try {
    const { ctx, warnings } = fakeContext();
    const args = methods.createMeetingRule.arguments.parse({
      name: "custom",
      matchString: "^sip:(.*)@example\\.com$",
      meetingType: RE2_REGEX_MEETING_TYPE,
    });
    await methods.createMeetingRule.execute(args, ctx);
    assertEquals(calls.length, 1);
    assert(calls[0].url.endsWith("/mjx_meeting_processing_rule/"));
    assertEquals(calls[0].init?.method, "POST");
    const body = JSON.parse(calls[0].init?.body as string);
    assertEquals(body.meeting_type, RE2_REGEX_MEETING_TYPE);
    assertEquals(warnings, []);
  } finally {
    restore();
  }
});

Deno.test("createMeetingRule warns when legacy Regex is chosen", async () => {
  const calls: Captured[] = [];
  const restore = mockFetch(calls, { id: 1 });
  try {
    const { ctx, warnings } = fakeContext();
    const args = methods.createMeetingRule.arguments.parse({
      name: "custom",
      matchString: ".*",
      meetingType: LEGACY_REGEX_MEETING_TYPE,
    });
    await methods.createMeetingRule.execute(args, ctx);
    assertEquals(warnings.length, 1);
    assert(warnings[0].includes("deprecated"));
    const body = JSON.parse(calls[0].init?.body as string);
    assertEquals(body.meeting_type, LEGACY_REGEX_MEETING_TYPE);
  } finally {
    restore();
  }
});

Deno.test("listMeetingRules reports and filters legacy Regex rules", async () => {
  const rules = [
    { name: "old", meeting_type: LEGACY_REGEX_MEETING_TYPE },
    { name: "new", meeting_type: RE2_REGEX_MEETING_TYPE },
    { name: "teams", meeting_type: "teams" },
  ];
  assertEquals(rules.filter(isLegacyRegexRule).map((r) => r.name), ["old"]);

  const calls: Captured[] = [];
  const restore = mockFetch(calls, {
    meta: { total_count: rules.length },
    objects: rules,
  });
  try {
    const all = fakeContext();
    await methods.listMeetingRules.execute(
      methods.listMeetingRules.arguments.parse({}),
      all.ctx,
    );
    assertEquals(all.writes.length, 3);
    assertEquals(all.warnings.length, 1);

    const legacy = fakeContext();
    await methods.listMeetingRules.execute(
      methods.listMeetingRules.arguments.parse({ legacyRegexOnly: true }),
      legacy.ctx,
    );
    assertEquals(legacy.writes.map((w) => w.name), ["old"]);
  } finally {
    restore();
  }
});
