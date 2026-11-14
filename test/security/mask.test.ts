import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { maskSecrets } from "../../src/security/mask";

function fx(name: string): string {
  return readFileSync(join(import.meta.dir, "..", "fixtures", "secrets", name), "utf8");
}

/** Time for `calls` back-to-back calls, in ms. A full GC first keeps earlier tests' garbage out. */
function timeCalls(input: string, calls: number): number {
  Bun.gc(true);
  const t0 = performance.now();
  for (let i = 0; i < calls; i++) maskSecrets(input);
  return performance.now() - t0;
}

/** The timing tests run up to 10 rounds over 1 MB inputs: well past bun's 5 s default on a busy box. */
const LINEAR_TIMEOUT_MS = 30_000;
/** SESSION_HUB_NO_ABS_TIMING=1 drops the absolute 1 s cap (slow or shared runners); the ratio gate stays. */
const ABS_TIMING = process.env.SESSION_HUB_NO_ABS_TIMING !== "1";

/**
 * Linear-time gate that does not depend on machine load: 8x the input must cost less than 24x the
 * time (linear is about 8x, quadratic about 64x), with a loose 1 s cap for 1 MB.
 * - One warm-up call each, then the best of at least 3 rounds. Large and small runs alternate, so a
 *   burst of load hits both alike.
 * - The 125 KB time is 8 back-to-back calls divided by 8: on a busy machine a short run can fit in
 *   one scheduler slice and dodge the contention a long run cannot, which would bias the ratio.
 * - Load only adds time, so while the ratio is still 24 or more, up to 7 more rounds may lower the
 *   minimums; a quadratic scan stays near 64x however many rounds run.
 * - The 125 KB time is floored at 1 ms so timer noise on a very fast run cannot fail it.
 */
function expectLinear(make: (bytes: number) => string): void {
  const big = make(1_000_000);
  const little = make(125_000);
  maskSecrets(big);
  maskSecrets(little);
  let large = Number.POSITIVE_INFINITY;
  let small = Number.POSITIVE_INFINITY;
  const ratio = () => large / Math.max(small, 1);
  for (let i = 0; i < 10 && (i < 3 || ratio() >= 24); i++) {
    large = Math.min(large, timeCalls(big, 1));
    small = Math.min(small, timeCalls(little, 8) / 8);
  }
  if (ABS_TIMING) expect(large).toBeLessThan(1_000);
  expect(ratio()).toBeLessThan(24);
}

const repeatTo = (unit: string) => (bytes: number) => unit.repeat(Math.ceil(bytes / unit.length));

describe("maskSecrets", () => {
  test("github", () => {
    expect(maskSecrets(fx("github.txt"))).toBe("token here: [masked:github] end\n");
  });
  test("jwt", () => {
    expect(maskSecrets(fx("jwt.txt"))).toBe("jwt [masked:jwt] end\n");
  });
  test("anthropic labelled before openai", () => {
    expect(maskSecrets(fx("anthropic.txt"))).toBe("key [masked:anthropic] end\n");
  });
  test("openai", () => {
    expect(maskSecrets(fx("openai.txt"))).toBe("key [masked:openai] end\n");
  });
  test("aws", () => {
    expect(maskSecrets(fx("aws.txt"))).toBe("id [masked:aws] end\n");
  });
  test("azure-conn keeps key name", () => {
    expect(maskSecrets(fx("azure-conn.txt"))).toBe(
      "DefaultEndpointsProtocol=https;AccountName=fake;AccountKey=[masked:azure-conn];EndpointSuffix=x\nsas SharedAccessSignature=[masked:azure-conn] end\n",
    );
  });
  test("password-kv keeps key name", () => {
    expect(maskSecrets(fx("password-kv.txt"))).toBe(
      "login password=[masked:password-kv] ok\nconfig Secret: [masked:password-kv]\n",
    );
  });
  test("private-key whole block", () => {
    expect(maskSecrets(fx("private-key.txt"))).toBe("a\n[masked:private-key]\nb\n");
  });
  test("conn-string masks only password", () => {
    expect(maskSecrets(fx("conn-string.txt"))).toBe(
      "cs Server=db1;Database=app;User Id=u;Password=[masked:conn-string];Encrypt=true\n",
    );
  });
  test("safe text untouched", () => {
    const s = fx("safe.txt");
    expect(maskSecrets(s)).toBe(s);
  });
  test("idempotent over every fixture", () => {
    for (const n of [
      "github",
      "jwt",
      "anthropic",
      "openai",
      "aws",
      "azure-conn",
      "password-kv",
      "private-key",
      "conn-string",
    ]) {
      const once = maskSecrets(fx(`${n}.txt`));
      expect(maskSecrets(once)).toBe(once);
    }
  });
  test("kv forms: json, quoted, env, pwd path stays", () => {
    expect(maskSecrets(fx("kv-forms.txt"))).toBe(
      [
        '{"password": [masked:password-kv]}',
        '"client_secret":[masked:password-kv]',
        "password=[masked:password-kv]",
        "password = [masked:password-kv]",
        "AWS_SECRET_ACCESS_KEY=[masked:password-kv]",
        "API_KEY=[masked:password-kv]",
        "pwd: /home/user/project/src",
        "pwd: C:\\Users\\x\\proj",
        "",
      ].join("\n"),
    );
  });
  test("headers keep name, mask value", () => {
    expect(maskSecrets(fx("headers.txt"))).toBe(
      [
        "Authorization: Bearer [masked:auth-header]",
        "authorization: Basic [masked:auth-header]",
        "X-Api-Key: [masked:api-key-header]",
        "Ocp-Apim-Subscription-Key: [masked:api-key-header]",
        "Authorization: token [masked:github]",
        "",
      ].join("\n"),
    );
  });
  test("url credentials, sas sig, SharedAccessKey", () => {
    expect(maskSecrets(fx("urls.txt"))).toBe(
      [
        "postgres://app:[masked:url-cred]@db:5432/x",
        "mongodb+srv://u:[masked:url-cred]@c.example/db",
        "redis://:[masked:url-cred]@h:6379",
        "amqp://g:[masked:url-cred]@h",
        "https://x.example/blob?sv=1&sig=[masked:sas-sig]&se=2",
        "Endpoint=sb://x;SharedAccessKey=[masked:azure-conn]",
        "",
      ].join("\n"),
    );
  });
  test("new provider forms and aws right boundary", () => {
    expect(maskSecrets(fx("providers2.txt"))).toBe(
      ["[masked:openai]", "[masked:github]", "[masked:slack]", "AKIAXXXXXXXXXXXXXXXXY", ""].join(
        "\n",
      ),
    );
  });
  test("repros are stable and keep inner labels; conn-string is case-insensitive", () => {
    const once = maskSecrets(fx("repros.txt"));
    expect(once).toBe(
      [
        "Server=a;Password=[masked:conn-string];Server=b;Password=[masked:conn-string]",
        'token: "[masked:jwt]"',
        "server=db1;pwd=[masked:conn-string];x=y",
        "",
      ].join("\n"),
    );
    expect(maskSecrets(once)).toBe(once);
  });
  test("private key with CRLF and truncated key", () => {
    const crlf = fx("private-key-crlf.txt").replace(/\r?\n/g, "\r\n");
    expect(maskSecrets(crlf)).toBe("[masked:private-key]\r\nafter\r\n");
    expect(maskSecrets(fx("private-key-truncated.txt"))).toBe("before\n[masked:private-key]");
  });
  test("idempotent over the new fixtures", () => {
    for (const n of [
      "kv-forms",
      "headers",
      "urls",
      "providers2",
      "private-key-crlf",
      "private-key-truncated",
    ]) {
      const once = maskSecrets(fx(`${n}.txt`));
      expect(maskSecrets(once)).toBe(once);
    }
  });
  test("conn-string with whitespace after = is idempotent", () => {
    const once = maskSecrets(fx("ws-conn.txt"));
    expect(once).toBe(
      [
        "Server=x;Password = [masked:conn-string];",
        "Server=x;Password= [masked:conn-string]",
        "Server=x;Pwd=\t[masked:conn-string]",
        "",
      ].join("\n"),
    );
    expect(maskSecrets(once)).toBe(once);
  });
  test("json-form headers", () => {
    const once = maskSecrets(fx("json-headers.txt"));
    expect(once).toBe(
      [
        '{"Authorization": "Bearer [masked:auth-header]"}',
        '"Ocp-Apim-Subscription-Key": "[masked:api-key-header]"',
        '{"x-api-key":"[masked:api-key-header]"}',
        "",
      ].join("\n"),
    );
    expect(maskSecrets(once)).toBe(once);
  });
  test("keyword must end the key: token counts stay visible", () => {
    const s = fx("safe-keys.txt");
    expect(maskSecrets(s)).toBe(s);
  });
  test("keys ending in a keyword are masked", () => {
    expect(maskSecrets(fx("name-end.txt"))).toBe(
      "access_token: [masked:password-kv]\ndb.password=[masked:password-kv]\n",
    );
  });
  test("camelCase keys ending in a keyword are masked", () => {
    const once = maskSecrets(fx("camel-keys.txt"));
    expect(once).toBe(
      [
        "accessToken=[masked:password-kv]",
        '"apiKey": [masked:password-kv]',
        "clientSecret: [masked:password-kv]",
        "refreshToken: [masked:password-kv]",
        "authToken=[masked:password-kv]",
        "dbPassword=[masked:password-kv]",
        "openaiApiKey: [masked:password-kv]",
        "awsAccessKey=[masked:password-kv]",
        "smtpPasswd: [masked:password-kv]",
        "db2Pwd=[masked:password-kv]",
        '{"refreshToken":[masked:password-kv]}',
        "cfg.clientSecret = [masked:password-kv]",
        "MyToken: [masked:password-kv]",
        "",
      ].join("\n"),
    );
    expect(maskSecrets(once)).toBe(once);
  });
  test("camelCase plural and longer keys, and camelCase pwd paths, stay visible", () => {
    const s = fx("camel-safe.txt");
    expect(maskSecrets(s)).toBe(s);
  });
  test.each([
    ["aToken=", "aToken="],
    ["aToken", "aToken"],
    ["aAb", "aAb"],
    ["dbPassword ", "dbPassword "],
  ])(
    "adversarial camelCase input of %p runs in linear time",
    (_n, unit) => {
      expectLinear(repeatTo(unit));
    },
    LINEAR_TIMEOUT_MS,
  );
  test("a value stops before an existing label, and scanning goes on after it", () => {
    const once = maskSecrets(fx("label-stop.txt"));
    expect(once).toBe(
      "token=[masked:password-kv][masked:jwt],password=[masked:password-kv] apiKey=ab[masked:jwt]\n",
    );
    expect(maskSecrets(once)).toBe(once);
  });
  test.each([
    ["password=", "password="],
    ["password=[b", "password=[b"],
    ["password=ab[masked:", "password=ab[masked:"],
    ['token="', 'token="'],
    ["aToken='x", "aToken='x"],
    ["[b", "[b"],
  ])(
    "adversarial value scan of %p runs in linear time",
    (_n, unit) => {
      expectLinear(repeatTo(unit));
    },
    LINEAR_TIMEOUT_MS,
  );
  test(
    "adversarial long camelCase identifier ending in Token runs in linear time",
    () => {
      for (const tail of ["Token", "Token=", "Token: x", "Tokens=abcdefgh"]) {
        const make = (bytes: number) => `${"aAb".repeat(Math.ceil(bytes / 3))}${tail}`;
        expectLinear(make);
        expect(maskSecrets(make(1_000_000)).length).toBeGreaterThan(1_000_000);
      }
    },
    LINEAR_TIMEOUT_MS,
  );
  test.each([
    ["eyJ", "eyJ"],
    ["Server=a;", "Server=a;"],
    ["-----BEGIN PRIVATE KEY-----\n", "-----BEGIN PRIVATE KEY-----\n"],
    ["password_", "password_"],
    ["a_", "a_"],
    ["token ", "token "],
    ["a.", "a."],
    ["x://a:", "x://a:"],
  ])(
    "adversarial input of %p runs in linear time",
    (_n, unit) => {
      expectLinear(repeatTo(unit));
    },
    LINEAR_TIMEOUT_MS,
  );
  test(
    "mixed text runs in linear time",
    () => {
      const chunk = `${fx("github.txt")}${fx("password-kv.txt")}${fx("safe.txt")}${fx("conn-string.txt")}prose line here `;
      expectLinear(repeatTo(chunk));
    },
    LINEAR_TIMEOUT_MS,
  );
});
