const express = require('express');
const { queryUser, runRaw } = require('./db');
const { verifyToken } = require('./auth');

const app = express();
app.use(express.json());

// ISSUE: hardcoded secret
const API_SECRET = 'supersecret-key-12345';

// ISSUE: SQL injection via string concatenation
app.get('/user', (req, res) => {
  const id = req.query.id;
  const sql = "SELECT * FROM users WHERE id = '" + id + "'";
  queryUser(sql, (err, rows) => {
    res.json(rows);
  });
});

// ISSUE: no input validation, eval of user input
app.post('/run', (req, res) => {
  const code = req.body.code;
  const result = eval(code);
  res.json({ result });
});

// ISSUE: error swallowed silently
app.get('/data', (req, res) => {
  try {
    const data = runRaw('SELECT * FROM data');
    res.json(data);
  } catch (e) {}
});

app.listen(3000);
module.exports = app;
