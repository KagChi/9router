// Merge the duplicate "codebuddy" provider into "codebuddy-intl".
// The bare "codebuddy" registry entry was removed (same codebuddy.ai backend,
// same alias "cbai"); repoint any stored connections to the surviving id.
export default {
  version: 2,
  name: "codebuddy-intl-merge",
  up(db) {
    db.exec(
      `UPDATE providerConnections SET provider = 'codebuddy-intl' WHERE provider = 'codebuddy'`,
    );
    // Model refs stored as JSON text ("codebuddy/model"). The quote-anchored
    // replace can't touch "codebuddy-cn/..." or "codebuddy-intl/...".
    db.exec(`UPDATE combos SET models = replace(models, '"codebuddy/', '"codebuddy-intl/') WHERE models LIKE '%"codebuddy/%'`);
    db.exec(`UPDATE kv SET value = replace(value, '"codebuddy/', '"codebuddy-intl/') WHERE value LIKE '%"codebuddy/%'`);
    db.exec(`UPDATE settings SET data = replace(data, '"codebuddy/', '"codebuddy-intl/') WHERE data LIKE '%"codebuddy/%'`);
  },
};
