'use strict';

const app = require('./app');
const connectDatabase = require('./config/db');
const config = require('./config/env');

async function start() {
  await connectDatabase();
  const server = app.listen(config.port, () => console.log(`Contracts ZAR API listening on port ${config.port}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((error) => {
  console.error('Unable to start Contracts ZAR API:', error);
  process.exitCode = 1;
});
