// ISSUE: hardcoded DB credentials
const DB_PASSWORD = 'admin123';
const DB_USER = 'root';

function queryUser(sql, cb) {
  // ISSUE: executes raw SQL passed in (no parameterization)
  console.log('executing', sql, DB_USER, DB_PASSWORD);
  cb(null, []);
}

function runRaw(sql) {
  // ISSUE: synchronous blocking call, no error handling
  return [];
}

module.exports = { queryUser, runRaw };
