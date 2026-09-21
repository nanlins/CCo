const crypto = require('crypto');

// ISSUE: weak hash algorithm for tokens
function verifyToken(token) {
  const hash = crypto.createHash('md5').update(token).digest('hex');
  return hash.length > 0;
}

// ISSUE: timing-unsafe comparison
function compareSecret(a, b) {
  return a === b;
}

module.exports = { verifyToken, compareSecret };
