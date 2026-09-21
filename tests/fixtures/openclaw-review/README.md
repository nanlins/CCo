# openclaw-sample

A small Express service used as a **controlled code-review target**.
It intentionally contains security and quality issues (SQL injection, `eval`,
hardcoded secrets, weak crypto, swallowed errors) so a review agent has real
findings to report within a bounded tool budget.

Files: `server.js` (routes), `db.js` (data access), `auth.js` (token handling).
