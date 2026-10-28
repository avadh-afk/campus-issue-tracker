// Load a local .env file when present. On Render, environment variables are provided by the host.
const fs = require('node:fs');
const path = require('node:path');
const { loadEnvFile } = require('node:process');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) loadEnvFile(envPath);
require('./server');
