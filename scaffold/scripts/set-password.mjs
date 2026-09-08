#!/usr/bin/env node
/**
 * set-password.mjs - set (or reset) one user's password on a LOCAL or DEMO environment.
 *
 * The seed layer creates every login with password_hash = '!', which no password can ever match
 * (docs/14 section 3); this is the only sanctioned way to make one of those accounts usable.
 * The hash is computed BY POSTGRES with pgcrypto's crypt() + gen_salt('bf', cost), exactly as the
 * login route verifies it, so no crypto dependency exists in Node. The password is read from a
 * hidden prompt - never from argv (shell history) and never from a file.
 *
 * Usage:
 *   npm run password -- demo.training_manager
 *   npm run password -- demo.training_manager --keep-must-change   (default clears the flag)
 */

import { createInterface } from 'node:readline';
import { connect } from './lib/kit-seed.mjs';

const username = process.argv[2];
if (!username || username.startsWith('--')) {
  console.error('usage: npm run password -- <username> [--keep-must-change]');
  process.exit(2);
}
const keepMustChange = process.argv.includes('--keep-must-change');

function hiddenPrompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput;
    rl.question(question, (answer) => { rl._writeToOutput = write; process.stdout.write('\n'); rl.close(); resolve(answer); });
    rl._writeToOutput = () => {}; // mute echo after the question is printed
  });
}

const pw1 = await hiddenPrompt(`New password for ${username}: `);
const pw2 = await hiddenPrompt('Repeat: ');
if (pw1 !== pw2) { console.error('Passwords do not match.'); process.exit(1); }
if (pw1.length < 12) { console.error('Use at least 12 characters.'); process.exit(1); }

const client = await connect();
try {
  const { rows } = await client.query(
    `UPDATE users
        SET password_hash = crypt($2, gen_salt('bf', 12)),
            must_change_password = $3,
            locked_until = NULL,
            failed_login_count = 0
      WHERE username = $1 AND deleted_at IS NULL
      RETURNING id, username, is_active, must_change_password`,
    [username, pw1, keepMustChange],
  );
  if (rows.length === 0) { console.error(`No active user named ${username}.`); process.exit(1); }
  const u = rows[0];
  console.log(`password set for ${u.username} (active: ${u.is_active}, must change on login: ${u.must_change_password})`);
} finally {
  await client.end();
}
