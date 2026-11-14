import { describe, expect, test } from "bun:test";
import { blockingPrincipals, parsePrincipals } from "../../src/platform/windows/acl";

const me = { name: "box\\alice", sid: "s-1-5-21-1-2-3-1001" };
const DIR = "C:\\Users\\alice\\My Data";

describe("parsePrincipals", () => {
  test("strips a path-with-spaces prefix and reads continuation lines", () => {
    const out = [
      `${DIR} BOX\\alice:(OI)(CI)(F)`,
      "                  NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
      "",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");
    expect(parsePrincipals(out, DIR)).toEqual(["BOX\\alice", "NT AUTHORITY\\SYSTEM"]);
  });

  test("reads inherited (I) lines", () => {
    const out = [
      `${DIR} BUILTIN\\Administrators:(I)(OI)(CI)(F)`,
      "       BUILTIN\\Users:(I)(OI)(CI)(RX)",
      "",
    ].join("\n");
    expect(parsePrincipals(out, DIR)).toEqual(["BUILTIN\\Administrators", "BUILTIN\\Users"]);
  });

  test("reads unresolved SIDs and CREATOR OWNER", () => {
    const out = [`${DIR} S-1-5-21-9-9-9-500:(F)`, "       CREATOR OWNER:(OI)(CI)(IO)(F)", ""].join(
      "\n",
    );
    expect(parsePrincipals(out, DIR)).toEqual(["S-1-5-21-9-9-9-500", "CREATOR OWNER"]);
  });

  test("ignores the trailing summary", () => {
    expect(parsePrincipals("\nSuccessfully processed 1 files\n", DIR)).toEqual([]);
  });
});

describe("blockingPrincipals", () => {
  test("current user by name or SID and SYSTEM by name or SID are allowed", () => {
    expect(
      blockingPrincipals(
        ["BOX\\Alice", "S-1-5-21-1-2-3-1001", "NT AUTHORITY\\SYSTEM", "S-1-5-18"],
        me,
      ),
    ).toEqual([]);
  });

  test("Administrators, Users, Everyone, CREATOR OWNER and unknown SIDs block", () => {
    const blockers = blockingPrincipals(
      [
        "BUILTIN\\Administrators",
        "BUILTIN\\Users",
        "Everyone",
        "CREATOR OWNER",
        "S-1-5-21-9-9-9-500",
      ],
      me,
    );
    expect(blockers).toHaveLength(5);
  });

  test("localized SYSTEM name blocks (only the SID form is trusted)", () => {
    expect(blockingPrincipals(["NT-AUTORITÄT\\SYSTEM"], me)).toEqual(["NT-AUTORITÄT\\SYSTEM"]);
    expect(blockingPrincipals(["S-1-5-18"], me)).toEqual([]);
  });
});
