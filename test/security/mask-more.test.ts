import { describe, expect, test } from "bun:test";
import { maskSecrets } from "../../src/security/mask";
import { looksSecret } from "../../src/send/relay";

// Synthetic values, assembled at run time so secret scanners never see a token-shaped literal.
const rep = (c: string, n: number) => c.repeat(n);
const tg = `${"1234567"}89:${"AA"}${rep("x", 33)}`;
const stripe = `${"sk"}_${"live"}_${rep("a1", 12)}`;
const google = `${"AI"}za${rep("b", 35)}`;
const sendgrid = `${"SG"}.${rep("c", 22)}.${rep("d", 43)}`;
const npm = `${"npm"}_${rep("e", 36)}`;
const gitlab = `${"glpat"}-${rep("f", 20)}`;

describe("maskSecrets: more token formats (SEC-11)", () => {
  test("provider tokens on their own", () => {
    expect(maskSecrets(`bot ${tg} end`)).toBe("bot [masked:telegram] end");
    expect(maskSecrets(`key ${stripe} end`)).toBe("key [masked:stripe] end");
    expect(maskSecrets(`key ${google} end`)).toBe("key [masked:google] end");
    expect(maskSecrets(`key ${sendgrid} end`)).toBe("key [masked:sendgrid] end");
    expect(maskSecrets(`key ${npm} end`)).toBe("key [masked:npm] end");
    expect(maskSecrets(`key ${gitlab} end`)).toBe("key [masked:gitlab] end");
  });

  test("key names ending in secret/signing/hmac/private/encryption key", () => {
    const v = "Zq9wXy7Vt3Lm";
    expect(maskSecrets(`STRIPE_SECRET_KEY=${v}`)).toBe("STRIPE_SECRET_KEY=[masked:password-kv]");
    expect(maskSecrets(`HMAC_KEY=${v}`)).toBe("HMAC_KEY=[masked:password-kv]");
    expect(maskSecrets(`"SigningKey": "${v}"`)).toBe('"SigningKey": [masked:password-kv]');
    expect(maskSecrets(`private_key: ${v}`)).toBe("private_key: [masked:password-kv]");
    expect(maskSecrets(`jwtSigningKey=${v}`)).toBe("jwtSigningKey=[masked:password-kv]");
    expect(maskSecrets(`ENCRYPTION_KEY=${v}`)).toBe("ENCRYPTION_KEY=[masked:password-kv]");
  });

  test("bare Bearer tokens, webhook URLs, Hugging Face and Vault tokens", () => {
    const tok = "Ab3dEf5hIj7lMn9pQr1tUv3xYz";
    expect(maskSecrets(`curl -H Bearer ${tok}x end`)).toBe("curl -H Bearer [masked:bearer] end");
    const slack = `https://hooks.slack.com/services/T${"0".repeat(8)}/B${"1".repeat(8)}/${tok}`;
    expect(maskSecrets(`hook ${slack} end`)).toBe("hook [masked:webhook] end");
    const discord = `https://discord.com/api/webhooks/123456789012345678/${tok}${tok}`;
    expect(maskSecrets(`hook ${discord} end`)).toBe("hook [masked:webhook] end");
    expect(maskSecrets(`t ${"hf"}_${"a".repeat(34)} end`)).toBe("t [masked:huggingface] end");
    expect(maskSecrets(`t ${"hvs"}.${"b".repeat(90)} end`)).toBe("t [masked:vault] end");
    // Prose mentions stay readable.
    for (const s of ["use a Bearer token here", "the hf_ prefix", "Bearer auth"]) {
      expect(maskSecrets(s)).toBe(s);
    }
  });

  test("ordinary words with key stay visible", () => {
    for (const s of [
      "the primary key: id",
      "monkey=banana123",
      "keyboard: qwerty12",
      "max_tokens: 4096",
    ]) {
      expect(maskSecrets(s)).toBe(s);
    }
  });
});

describe("maskSecrets: personal data (PII-02)", () => {
  test("card numbers that pass the Luhn check, with or without separators", () => {
    // Standard published test card numbers, not real cards.
    expect(maskSecrets("card 4111111111111111 ok")).toBe("card [masked:card] ok");
    expect(maskSecrets("card 4111 1111 1111 1111 ok")).toBe("card [masked:card] ok");
    expect(maskSecrets("card 5555-5555-5555-4444 ok")).toBe("card [masked:card] ok");
    expect(maskSecrets("amex 378282246310005.")).toBe("amex [masked:card].");
  });

  test("a card followed by its expiry or CVV after a space is still masked", () => {
    expect(maskSecrets("card 4111 1111 1111 1111 12/27")).toBe("card [masked:card] 12/27");
    expect(maskSecrets("card 4111111111111111 123")).toBe("card [masked:card] 123");
    expect(maskSecrets("card 5555-5555-5555-4444 01 ok")).toBe("card [masked:card] 01 ok");
    expect(looksSecret("card 4111 1111 1111 1111 12/27")).toBe(true);
    expect(looksSecret("card 4111111111111111 123")).toBe(true);
  });

  test("a card after a CVV, an expiry or a short number is still masked", () => {
    expect(maskSecrets("cvv 123 4111111111111111")).toBe("cvv 123 [masked:card]");
    expect(maskSecrets("12/27 4111 1111 1111 1111")).toBe("12/27 [masked:card]");
    expect(maskSecrets("#1 4111 1111 1111 1111")).toBe("#1 [masked:card]");
    expect(maskSecrets("exp 12 4111111111111111 cvv 123")).toBe("exp 12 [masked:card] cvv 123");
    expect(looksSecret("cvv 123 4111111111111111")).toBe(true);
    expect(maskSecrets("ref 9 4111 1111 1111 1111 x")).toBe("ref 9 [masked:card] x");
    expect(maskSecrets("ref 9 3782 822463 10005 x")).toBe("ref 9 [masked:card] x");
  });

  test("a list of short numbers is not searched for a card inside it", () => {
    // 41 11 11 11 11 11 11 11 is a Luhn-valid Visa number, but nobody writes a card in pairs.
    const s = "scores 12 41 11 11 11 11 11 11 11";
    expect(maskSecrets(s)).toBe(s);
    expect(looksSecret(s)).toBe(false);
  });

  test("amounts and ids that pass Luhn but are not card-shaped stay visible", () => {
    // Luhn-valid, but no card network issues these lengths with these prefixes.
    const luhnValid = (body: string) => {
      for (let d = 0; d <= 9; d++) {
        const s = `${body}${d}`;
        let sum = 0;
        for (let i = 0; i < s.length; i++) {
          let n = s.charCodeAt(s.length - 1 - i) - 48;
          if (i % 2 === 1) {
            n *= 2;
            if (n > 9) n -= 9;
          }
          sum += n;
        }
        if (sum % 10 === 0) return s;
      }
      throw new Error("unreachable");
    };
    for (const s of [
      luhnValid("25000000000000000"), // 18 digits starting 25: Mastercard 2-series is 16 only
      luhnValid("2000000000000000"), // 17 digits starting 20: no network
      luhnValid("31234567890123"), // 15 digits starting 31: no network
      luhnValid("599999999999999"), // 16 digits starting 59: no network
      luhnValid("612345678901234"), // 16 digits starting 61: no network
    ]) {
      expect(maskSecrets(`id ${s} ok`)).toBe(`id ${s} ok`);
    }
  });

  test("digit runs that are not cards stay visible", () => {
    for (const s of [
      "epoch 1731500000000 ms", // 13 digits
      "id 4111111111111112", // fails Luhn
      "order 9111111111111111", // not a card prefix and fails Luhn
      "version 1.2.3.4",
      "1234 5678",
    ]) {
      expect(maskSecrets(s)).toBe(s);
    }
  });

  test("IBANs that pass the mod-97 check", () => {
    // The published example IBANs.
    expect(maskSecrets("pay GB82WEST12345698765432 now")).toBe("pay [masked:iban] now");
    expect(maskSecrets("pay GB82 WEST 1234 5698 7654 32 now")).toBe("pay [masked:iban] now");
    expect(maskSecrets("DE89370400440532013000")).toBe("[masked:iban]");
  });

  test("IBAN-shaped text that fails mod-97 stays visible", () => {
    expect(maskSecrets("GB82WEST12345698765433")).toBe("GB82WEST12345698765433");
    expect(maskSecrets("AB12CDEF")).toBe("AB12CDEF");
  });

  test("idempotent", () => {
    const s = `bot ${tg} card 4111111111111111 iban GB82WEST12345698765432 HMAC_KEY=${"Zq9wXy"}${"7Vt3Lm"}`;
    const once = maskSecrets(s);
    expect(maskSecrets(once)).toBe(once);
  });

  test("linear on long digit and letter runs", () => {
    const big = `${"4".repeat(500_000)} ${"GB82 ".repeat(100_000)}`;
    const t0 = performance.now();
    maskSecrets(big);
    expect(performance.now() - t0).toBeLessThan(
      process.env.SESSION_HUB_NO_ABS_TIMING === "1" ? 30_000 : 2_000,
    );
  });
});
