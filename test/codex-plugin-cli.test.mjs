import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCodexMarketplaceName,
  normalizeCodexMarketplaceRef,
  normalizeCodexMarketplaceSource,
  normalizeCodexMarketplaceSparse,
  normalizeCodexPluginId,
  normalizeOfficialCodexPluginId,
  publicCodexPluginCatalog,
  publicCodexPluginSnapshot,
} from "../lib/codex-plugin-cli.mjs";

test("official Codex plugin selectors reject third-party and malformed values", () => {
  assert.equal(normalizeOfficialCodexPluginId("Linear@openai-curated"), "linear@openai-curated");
  for (const value of ["linear", "linear@third-party", "../linear@openai-curated", "x@y@openai-curated"]) {
    assert.throws(() => normalizeOfficialCodexPluginId(value), /OpenAI 官方插件/);
  }
});

test("public plugin snapshots expose only bounded official metadata", () => {
  const snapshot = publicCodexPluginSnapshot({
    installed: [{
      pluginId: "linear@openai-curated",
      name: "linear",
      marketplaceName: "openai-curated",
      version: "1.0.0",
      installed: true,
      enabled: true,
      authPolicy: "ON_INSTALL",
      source: { path: "/root/private/plugin" },
      secret: "never-return",
    }],
    available: [
      {
        pluginId: "linear@openai-curated",
        name: "linear",
        marketplaceName: "openai-curated",
        version: "1.0.0",
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
      },
      {
        pluginId: "custom@third-party",
        name: "custom",
        marketplaceName: "third-party",
        version: "1.0.0",
      },
    ],
  });
  assert.equal(snapshot.marketplace, "openai-curated");
  assert.equal(snapshot.installed.length, 1);
  assert.equal(snapshot.available.length, 1);
  assert.equal(snapshot.available[0].installed, true);
  assert.equal("source" in snapshot.installed[0], false);
  assert.equal(JSON.stringify(snapshot).includes("never-return"), false);
});

test("configured marketplace catalogs preserve source identity without accepting hidden plugins", () => {
  const catalog = publicCodexPluginCatalog({
    installed: [
      plugin("github", "openai-curated", { installed: true }),
      plugin("team-tool", "team-market", { installed: true }),
      plugin("hidden", "not-configured", { installed: true }),
    ],
    available: [
      plugin("github", "openai-curated"),
      plugin("team-tool", "team-market"),
      plugin("hidden", "not-configured"),
    ],
  }, {
    marketplaces: [
      { name: "openai-curated", root: "/private/openai" },
      { name: "team-market", root: "/private/team" },
    ],
  });
  assert.deepEqual(catalog.marketplaces.map((entry) => ({
    name: entry.name,
    official: entry.official,
    root: entry.root,
  })), [
    { name: "openai-curated", official: true, root: null },
    { name: "team-market", official: false, root: null },
  ]);
  assert.deepEqual(catalog.installed.map((entry) => entry.pluginId), [
    "github@openai-curated",
    "team-tool@team-market",
  ]);
  assert.equal(catalog.available.some((entry) => entry.pluginId === "hidden@not-configured"), false);

  const adminCatalog = publicCodexPluginCatalog({ installed: [], available: [] }, {
    marketplaces: [{ name: "team-market", root: "/private/team" }],
  }, { includeRoots: true });
  assert.equal(adminCatalog.marketplaces[1].root, "/private/team");
});

test("plugin marketplace inputs are bounded to documented safe CLI arguments", () => {
  assert.equal(normalizeCodexPluginId("Tool@Team-Market"), "tool@team-market");
  assert.equal(normalizeCodexMarketplaceName("Team-Market"), "team-market");
  assert.deepEqual(normalizeCodexMarketplaceSource("owner/repo@main"), {
    source: "owner/repo@main",
    kind: "github",
  });
  assert.equal(normalizeCodexMarketplaceSource("https://github.com/example/plugins.git").kind, "https");
  assert.equal(normalizeCodexMarketplaceSource("git@github.com:example/plugins.git").kind, "ssh");
  assert.equal(normalizeCodexMarketplaceSource("./.agents/plugins").kind, "local");
  assert.equal(normalizeCodexMarketplaceRef("release/v1"), "release/v1");
  assert.deepEqual(normalizeCodexMarketplaceSparse([".agents/plugins", "plugins/team"]), [
    ".agents/plugins",
    "plugins/team",
  ]);
  assert.throws(() => normalizeCodexPluginId("missing-market"));
  assert.throws(() => normalizeCodexMarketplaceSource("http://plain.example/plugins.git"));
  assert.throws(() => normalizeCodexMarketplaceSource("https://user:secret@example.com/plugins.git"));
  assert.throws(() => normalizeCodexMarketplaceSource("--config=features.danger=true"));
  assert.throws(() => normalizeCodexMarketplaceRef("--help"));
  assert.throws(() => normalizeCodexMarketplaceSparse(["../outside"]));
});

function plugin(name, marketplaceName, extra = {}) {
  return {
    pluginId: `${name}@${marketplaceName}`,
    name,
    marketplaceName,
    version: "1.0.0",
    installPolicy: "AVAILABLE",
    authPolicy: "NONE",
    ...extra,
  };
}
