// Run the app on this PC for development: node scripts/dev-server.js
// Uses a separate database in ./data-dev (ignored by Git), never the NAS data.
// Settings can still be overridden with real environment variables.
'use strict';

const path = require('node:path');

const defaults = {
  PORT: '3088',
  APP_ENV: 'local',
  DATA_DIR: path.join(__dirname, '..', 'data-dev'),
  ADMIN_PASSWORD: 'local-dev-only', // local test password, not used anywhere else
};
for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;

require('../app/app.js');
